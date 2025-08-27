import type { FastifyInstance } from 'fastify'
import { StatusCodes } from 'http-status-codes'

import { ENV } from '@/config/env'
import { authMiddleware } from '@/middlewares/auth'
import { getAllRedisCache, isRedisAvailable, deleteRedisKey, flushAllRedisCache, getRedisStats } from '@/lib/redis'
import { UserSyncService } from '@/services/user-sync'
import { sendSuccess } from '@/utils/response-formatter'

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

  // Rota para obter todo o cache do Redis
  app.get(
    '/cache',
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
            message: 'Apenas administradores podem acessar o gerenciamento de cache',
          })
        }

        // Verifica se o Redis está disponível
        if (!(await isRedisAvailable())) {
          return reply.status(503).send({
            error: 'Serviço indisponível',
            message: 'Redis não está disponível no momento',
          })
        }

        // Obtém todo o cache do Redis
        const cacheData = await getAllRedisCache()

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Cache do Redis obtido com sucesso',
          data: cacheData,
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para obter estatísticas do Redis
  app.get(
    '/cache/stats',
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
            message: 'Apenas administradores podem acessar o gerenciamento de cache',
          })
        }

        // Verifica se o Redis está disponível
        if (!(await isRedisAvailable())) {
          return reply.status(503).send({
            error: 'Serviço indisponível',
            message: 'Redis não está disponível no momento',
          })
        }

        // Obtém estatísticas do Redis
        const stats = await getRedisStats()

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Estatísticas do Redis obtidas com sucesso',
          data: stats,
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para deletar uma chave específica do cache
  app.delete(
    '/cache/:key',
    {
      preHandler: authMiddleware(),
    },
    async (req, reply) => {
      try {
        const user = req.user!
        const { key } = req.params as { key: string }

        // Verifica se é admin
        if (user.publicMetadata?.role !== 'ADMIN') {
          return reply.status(403).send({
            error: 'Acesso negado',
            message: 'Apenas administradores podem gerenciar o cache',
          })
        }

        // Verifica se o Redis está disponível
        if (!(await isRedisAvailable())) {
          return reply.status(503).send({
            error: 'Serviço indisponível',
            message: 'Redis não está disponível no momento',
          })
        }

        // Deleta a chave
        const deleted = await deleteRedisKey(key)

        if (!deleted) {
          return reply.status(404).send({
            error: 'Chave não encontrada',
            message: `A chave '${key}' não foi encontrada no cache`,
          })
        }

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: `Chave '${key}' deletada com sucesso`,
          data: { key, deleted: true },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para limpar todo o cache
  app.delete(
    '/cache',
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
            message: 'Apenas administradores podem gerenciar o cache',
          })
        }

        // Verifica se o Redis está disponível
        if (!(await isRedisAvailable())) {
          return reply.status(503).send({
            error: 'Serviço indisponível',
            message: 'Redis não está disponível no momento',
          })
        }

        // Limpa todo o cache
        await flushAllRedisCache()

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Todo o cache foi limpo com sucesso',
          data: { flushed: true },
        })
      } catch (error) {
        return reply.status(500).send({
          error: 'Erro interno do servidor',
          message: error instanceof Error ? error.message : 'Erro desconhecido',
        })
      }
    }
  )

  // Rota para forçar sincronização do cache de usuários
  app.post(
    '/cache/users/sync',
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
            message: 'Apenas administradores podem sincronizar o cache de usuários',
          })
        }

        // Verifica se o Redis está disponível
        if (!(await isRedisAvailable())) {
          return reply.status(503).send({
            error: 'Serviço indisponível',
            message: 'Redis não está disponível no momento',
          })
        }

        // Força sincronização dos usuários
        const userSyncService = UserSyncService.getInstance()
        await userSyncService.syncUsersWithCache()

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          message: 'Cache de usuários sincronizado com sucesso',
          data: { synced: true },
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
