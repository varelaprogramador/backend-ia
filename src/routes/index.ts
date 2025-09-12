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


}
