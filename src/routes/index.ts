import type { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'

import { ENV } from '@/config/env'
import { authMiddleware } from '@/middlewares/auth'
import { UserSyncService } from '@/services/user-sync'
import { sendSuccess } from '@/utils/response-formatter'
import { db } from '@/lib/db'

export default async function (app: FastifyInstance) {
  app.get('/', async (_req, reply) => {
    return sendSuccess(reply, {
      status: StatusCodes.OK,
      message: 'Hello, world!',
    })
  })

  app.get(
    '/verify-auth',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      const user = req.user!

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: 'User authenticated',
        data: {
          user,
        },
      })
    },
  )

  app.get('/ready', async (_req, reply) => {
    return reply.code(200).send({ status: 'ready' })
  })

  app.get('/metrics', async (req, reply) => {
    const memUsage = process.memoryUsage()
    const cpuUsage = process.cpuUsage()

    // Obtém métricas do under-pressure se estiver disponível
    let pressureMetrics = {}
    try {
      // @ts-ignore - under-pressure adiciona essas propriedades
      pressureMetrics = {
        isUnderPressure: req.server.isUnderPressure || false,
        // Outras métricas serão expostas no endpoint /pressure-metrics
      }
    } catch (error) {
      // Se não conseguir obter métricas do under-pressure, continua sem elas
      pressureMetrics = { isUnderPressure: false }
    }

    // Informações do Socket.IO
    const socketMetrics = {
      connections: req.server.io.engine.clientsCount,
      connectionsCount: req.server.io.sockets.sockets.size,
    }

    return reply.code(200).send({
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      memory: {
        rss: memUsage.rss,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        // Formatado para facilitar leitura
        formatted: {
          rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`,
        },
      },
      cpu: {
        user: cpuUsage.user,
        system: cpuUsage.system,
      },
      pressure: pressureMetrics,
      socket: socketMetrics,
      system: {
        pid: process.pid,
        version: process.version,
        platform: process.platform,
        arch: process.arch,
        nodeEnv: ENV.NODE_ENV,
      },
    })
  })

  app.get('/health', async (_req, reply) => {
    const memUsage = process.memoryUsage()

    return reply.code(200).send({
      status: 'healthy',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
      environment: ENV.NODE_ENV,
      version: process.env.npm_package_version || '1.0.0',
      memory: {
        rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
        heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
        heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
      },
    })
  })

  // Endpoint adicional /status para compatibilidade com padrões de health check
  app.get('/status', async (_req, reply) => {
    return reply.code(200).send({
      status: 'ok',
      timestamp: new Date().toISOString(),
      uptime: process.uptime(),
    })
  })

  // Rota para obter dados dos usuários da base de dados
  app.get(
    '/users',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem acessar o gerenciamento de usuários',
          })
        }

        // Obtém todos os usuários da base de dados
        const users = await db.user.findMany({
          orderBy: { createdAt: 'desc' },
          take: 100, // Limit to first 100 for performance
        })

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Usuários obtidos com sucesso',
          data: {
            users,
            total: users.length,
          },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para obter estatísticas da base de dados
  app.get(
    '/users/stats',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem acessar as estatísticas',
          })
        }

        // Obtém estatísticas da base de dados
        const [totalUsers, recentUsers] = await Promise.all([
          db.user.count(),
          db.user.count({
            where: {
              createdAt: {
                gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
              },
            },
          }),
        ])

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Estatísticas obtidas com sucesso',
          data: {
            totalUsers,
            recentUsers,
            timestamp: new Date().toISOString(),
          },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para deletar um usuário específico
  app.delete(
    '/users/:id',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!
        const { id } = req.params as { id: string }

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem gerenciar usuários',
          })
        }

        // Verifica se o usuário existe
        const existingUser = await db.user.findUnique({
          where: { id },
        })

        if (!existingUser) {
          return reply.status(404).send({
            error: 'Usuário não encontrado',
            message: `O usuário '${id}' não foi encontrado`,
          })
        }

        // Deleta o usuário
        await db.user.delete({
          where: { id },
        })

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: `Usuário '${id}' deletado com sucesso`,
          data: { id, deleted: true },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para limpar todos os usuários (CUIDADO: Operação perigosa)
  app.delete(
    '/users',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem realizar esta operação',
          })
        }

        // Verifica confirmação adicional para operação perigosa
        const { confirm } = req.query as { confirm?: string }
        if (confirm !== 'DELETE_ALL_USERS') {
          return reply.status(400).send({
            error: 'Confirmação necessária',
            message: 'Para deletar todos os usuários, inclua ?confirm=DELETE_ALL_USERS',
          })
        }

        // Conta quantos usuários serão deletados
        const userCount = await db.user.count()

        // Deleta todos os usuários
        await db.user.deleteMany({})

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: `${userCount} usuários foram deletados com sucesso`,
          data: { deleted: userCount },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para forçar sincronização dos usuários com Clerk
  app.post(
    '/users/sync',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem sincronizar os usuários',
          })
        }

        // Força sincronização dos usuários
        const userSyncService = UserSyncService.getInstance()
        const result = await userSyncService.syncUsersWithDatabase()

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Sincronização de usuários concluída com sucesso',
          data: result,
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )
}
