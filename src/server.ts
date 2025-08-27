import '@/config/env'

import { clerkPlugin } from '@clerk/fastify'
import autoload from '@fastify/autoload'
import compress from '@fastify/compress'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import fastifyStatic from '@fastify/static'
import underPressure from '@fastify/under-pressure'
import { createAdapter } from '@socket.io/redis-adapter'
import Fastify from 'fastify'
import * as cron from 'node-cron'
import path from 'path'
import { Server as SocketServer } from 'socket.io'

import { allowedOrigins } from '@/config/allowed-origins'
import { ENV } from '@/config/env'
import { redis } from '@/lib/redis'
import { UserSyncService } from '@/services/user-sync'
import type { BatchManager, RealtimePayload } from '@/types/IO'
import { fastifyLogger, logError, logInfo, logWarn } from '@/utils/logger'

// Estende o tipo FastifyInstance para incluir io
declare module 'fastify' {
  interface FastifyInstance {
    io: SocketServer
    emitBatched: (channel: string, payload: RealtimePayload) => void
  }
}

const app = Fastify({
  logger: fastifyLogger,
  disableRequestLogging: true, // Always disabled for performance
  connectionTimeout: 30000, // 30 seconds (optimized from 60s)
  keepAliveTimeout: 30000, // 30 seconds (optimized from 60s)
  requestTimeout: 15000, // 15 seconds (optimized from 30s)
  onProtoPoisoning: 'remove',
  onConstructorPoisoning: 'remove',
  bodyLimit: 10 * 1024 * 1024, // 10MB limit
  maxParamLength: 500, // Prevent long URL parameters
  caseSensitive: true,
  ignoreTrailingSlash: true,
  trustProxy: ENV.IS_PRODUCTION ? 1 : false, // Trust proxy in production
  genReqId: () => {
    // Generate unique request ID for tracking
    return `req_${Date.now()}_${Math.random().toString(36).slice(2, 11)}`
  },
})

// Clerk Plugin
app.register(clerkPlugin)

// Configuração do Under Pressure para monitoramento de pressão
app.register(underPressure, {
  // Limites de pressão
  maxEventLoopDelay: ENV.IS_PRODUCTION ? 1000 : 2000, // 1s produção, 2s desenvolvimento
  maxHeapUsedBytes: ENV.IS_PRODUCTION ? 500 * 1024 * 1024 : 1000 * 1024 * 1024, // 500MB produção, 1GB desenvolvimento
  maxRssBytes: ENV.IS_PRODUCTION ? 750 * 1024 * 1024 : 1500 * 1024 * 1024, // 750MB produção, 1.5GB desenvolvimento
  maxEventLoopUtilization: 0.98, // 98% de utilização máxima do event loop

  // Configurações de saúde
  healthCheck: async fastify => {
    try {
      // Verifica conexão com o banco (se necessário)
      // await fastify.db.raw('SELECT 1')

      // Verifica Socket.IO
      const socketConnections = fastify.io.engine.clientsCount

      // Retorna informações de saúde
      return {
        status: 'healthy',
        timestamp: new Date().toISOString(),
        socketConnections,
        uptime: process.uptime(),
      }
    } catch (error) {
      throw new Error('Health check failed')
    }
  },

  // Intervalo de verificação de saúde
  healthCheckInterval: ENV.IS_PRODUCTION ? 5000 : 10000, // 5s produção, 10s desenvolvimento

  // Configuração de resposta personalizada quando sob pressão
  pressureHandler: (request, reply, type, value) => {
    logWarn('Server under pressure', {
      type,
      value,
      url: request.url,
      method: request.method,
      userAgent: request.headers['user-agent'],
      ip: request.ip,
    })

    reply.code(503).send({
      error: 'Service Unavailable',
      message:
        'O servidor está temporariamente sobrecarregado. Tente novamente em alguns segundos.',
      type,
      retryAfter: 30, // segundos
      timestamp: new Date().toISOString(),
    })
  },

  // Expor métricas no endpoint /pressure-metrics
  exposeStatusRoute: {
    routeOpts: {
      logLevel: ENV.IS_DEVELOPMENT ? 'info' : 'warn',
    },
    routeSchemaOpts: {
      tags: ['monitoring'],
      description: 'Métricas de pressão do servidor',
    },
    url: '/pressure-metrics', // URL customizada para o endpoint
  },
})

// Rate limiting removed for performance optimization

// Performance optimizations
const VALID_CONTENT_TYPES = new Set(['application/json', 'multipart/form-data'])
const SKIP_VALIDATION_PATHS = new Set([
  '/health',
  '/ready',
  '/metrics',
  '/favicon.ico',
  '/favicon-16x16.png',
  '/favicon-32x32.png',
  '/apple-touch-icon.png',
  '/android-chrome-192x192.png',
  '/android-chrome-512x512.png',
  '/site.webmanifest',
])
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH'])

// Lightweight performance tracking (only for slow requests)
app.addHook('onRequest', async request => {
  ;(request as any).startTime = Date.now()
})

app.addHook('onResponse', async (request, reply) => {
  // Only track slow requests (>2s) to reduce overhead
  const responseTime = Date.now() - ((request as any).startTime || 0)
  if (responseTime > 2000) {
    logWarn('Slow request detected', {
      method: request.method,
      url: request.url,
      responseTime: `${responseTime}ms`,
      statusCode: reply.statusCode,
    })
  }
})

// Configuração do Socket.IO
const io = new SocketServer(app.server, {
  cors: {
    credentials: true,
    methods: ['GET'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Range', 'X-Content-Range'],
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204,
    origin: allowedOrigins,
  },
  transports: ['websocket'], // Removed polling for better performance
  pingTimeout: 60000,
  pingInterval: 30000, // Increased from 25000 for efficiency
  upgradeTimeout: 10000,
  maxHttpBufferSize: 5e5, // 500KB (reduced from 1MB)
  allowEIO3: false, // Disable legacy Engine.IO v3
  // Enable sticky sessions for load balancing
  connectionStateRecovery: ENV.SOCKET_IO.CONNECTION_STATE_RECOVERY
    ? {
        // the backup duration of the sessions and the packets
        maxDisconnectionDuration: ENV.SOCKET_IO.MAX_DISCONNECTION_DURATION,
        // whether to skip middlewares upon successful recovery
        skipMiddlewares: true,
      }
    : undefined,
})

// Configure adapter based on environment
let pubClient: any = null
let subClient: any = null

if (ENV.SOCKET_IO.ADAPTER_TYPE === 'redis') {
  // Configure Redis adapter for cluster support
  pubClient = redis.duplicate()
  subClient = redis.duplicate()

  io.adapter(createAdapter(pubClient, subClient))
  logInfo('✅ Socket.IO configured with Redis adapter for cluster support')
} else {
  logInfo('✅ Socket.IO configured with local adapter (single instance)')
}

const BATCH_INTERVAL = ENV.SOCKET_IO.BATCH_INTERVAL // Configurable batch interval
const BATCH_KEY_PREFIX = 'socket:batch:'
const BATCH_LOCK_PREFIX = 'socket:lock:'

// Local batching system (fallback for single instance)
const localEventBatches = new Map<
  string,
  BatchManager & { lastActivity: number }
>()

const createLocalBatchedEmit = (io: SocketServer) => {
  return (channel: string, payload: RealtimePayload) => {
    let batch = localEventBatches.get(channel)

    if (!batch) {
      batch = {
        events: [],
        timeout: null,
        lastActivity: Date.now(),
      }
      localEventBatches.set(channel, batch)
    }

    batch.lastActivity = Date.now()
    batch.events.push(payload)

    if (batch.timeout) {
      clearTimeout(batch.timeout)
    }

    batch.timeout = setTimeout(() => {
      const currentBatch = localEventBatches.get(channel)
      if (currentBatch && currentBatch.events.length > 0) {
        const eventsToSend =
          currentBatch.events.length === 1
            ? currentBatch.events[0]
            : currentBatch.events

        io.emit(channel, eventsToSend)

        // Reduced logging for better performance
        if (ENV.IS_DEVELOPMENT && currentBatch.events.length > 5) {
          logInfo(`📦 Local batch: ${currentBatch.events.length} events to ${channel}`)
        }

        localEventBatches.delete(channel)
      }
    }, BATCH_INTERVAL)
  }
}

// Redis-based batching system for cluster support
const createRedisBatchedEmit = (io: SocketServer) => {
  return async (channel: string, payload: RealtimePayload) => {
    const batchKey = `${BATCH_KEY_PREFIX}${channel}`
    const lockKey = `${BATCH_LOCK_PREFIX}${channel}`

    try {
      // Try to acquire lock for this channel
      const lockAcquired = await redis.set(
        lockKey,
        '1',
        'PX',
        BATCH_INTERVAL + 100,
        'NX',
      )

      // Add event to batch using pipeline for better performance
      const pipeline = redis.pipeline()
      pipeline.lpush(batchKey, JSON.stringify(payload))
      pipeline.expire(batchKey, 60) // Expire batch after 60 seconds
      await pipeline.exec()

      // If we acquired the lock, process the batch
      if (lockAcquired) {
        setTimeout(async () => {
          try {
            // Get all events from batch
            const events = await redis.lrange(batchKey, 0, -1)

            if (events.length > 0) {
              // Parse events
              const parsedEvents = events
                .map(event => JSON.parse(event))
                .reverse()

              // Send events
              const eventsToSend =
                parsedEvents.length === 1 ? parsedEvents[0] : parsedEvents
              io.emit(channel, eventsToSend)

              // Reduced logging for better performance
              if (ENV.IS_DEVELOPMENT && parsedEvents.length > 5) {
                logInfo(`📦 Redis batch: ${parsedEvents.length} events to ${channel}`)
              }

              // Clear batch
              await redis.del(batchKey)
            }

            // Release lock
            await redis.del(lockKey)
          } catch (error) {
            logError('Error processing Redis batch', error as Error)
            await redis.del(lockKey)
          }
        }, BATCH_INTERVAL)
      }
    } catch (error) {
      logError('Error in Redis batched emit', error as Error)
      // Fallback to direct emit if Redis fails
      io.emit(channel, payload)
    }
  }
}

// Create the appropriate batched emit function based on adapter type
const createBatchedEmit = (io: SocketServer) => {
  return ENV.SOCKET_IO.ADAPTER_TYPE === 'redis'
    ? createRedisBatchedEmit(io)
    : createLocalBatchedEmit(io)
}

// Cleanup function for stale batches
const cleanupStaleBatches = async () => {
  if (ENV.SOCKET_IO.ADAPTER_TYPE === 'redis') {
    // Redis-based cleanup
    try {
      const pattern = `${BATCH_KEY_PREFIX}*`
      const keys = await redis.keys(pattern)

      for (const key of keys) {
        const ttl = await redis.ttl(key)
        if (ttl === -1) {
          // Key exists but has no expiration
          await redis.expire(key, 60) // Set 60 seconds expiration
        }
      }

      // Also cleanup lock keys
      const lockKeys = await redis.keys(`${BATCH_LOCK_PREFIX}*`)
      for (const lockKey of lockKeys) {
        const ttl = await redis.ttl(lockKey)
        if (ttl === -1) {
          await redis.del(lockKey)
        }
      }

      if (ENV.IS_DEVELOPMENT && (keys.length > 0 || lockKeys.length > 0)) {
        logInfo(
          `🧹 Redis cleanup: ${keys.length} batch keys, ${lockKeys.length} lock keys`,
        )
      }
    } catch (error) {
      logError('Error in Redis batch cleanup', error as Error)
    }
  } else {
    // Local cleanup
    const now = Date.now()
    const cutoff = now - 30000 // 30 seconds

    for (const [channel, batch] of localEventBatches.entries()) {
      if (batch.lastActivity < cutoff) {
        if (batch.timeout) {
          clearTimeout(batch.timeout)
        }
        localEventBatches.delete(channel)

        if (ENV.IS_DEVELOPMENT) {
          logInfo(`🧹 Local cleanup: stale batch for channel ${channel}`)
        }
      }
    }
  }
}

// Run cleanup every 30 seconds
setInterval(cleanupStaleBatches, 30000)

// Adiciona io à instância do Fastify para uso nas rotas
app.decorate('io', io)
app.decorate('emitBatched', createBatchedEmit(io))

// Eventos do Socket.IO com error handling
io.on('connection', socket => {
  if (ENV.IS_DEVELOPMENT) {
    logInfo('🧠 Cliente conectado', { socketId: socket.id })
  }

  // Handle socket errors
  socket.on('error', error => {
    logError('Socket error', error as Error)
  })

  socket.on('disconnect', reason => {
    if (ENV.IS_DEVELOPMENT) {
      logInfo('👋 Cliente desconectado', { socketId: socket.id, reason })
    }
  })
})

// Socket.IO error handling
io.engine.on('connection_error', error => {
  logError('Socket.IO connection error', error as Error)
})

// Compressão de respostas
app.register(compress, {
  encodings: ['gzip', 'deflate', 'br'],
  threshold: 1024, // Only compress responses larger than 1KB
  global: true,
})

// Configuração do CORS mais restritiva
app.register(cors, {
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  exposedHeaders: ['Content-Range', 'X-Content-Range'],
  maxAge: 86400,
  preflightContinue: false,
  optionsSuccessStatus: 204,
  origin: allowedOrigins,
})

// Configuração de CORS específica para webhooks (permite qualquer origem)
app.addHook('onRequest', async (request, reply) => {
  // Verificar se a requisição é para webhook
  if (request.url.startsWith('/webhooks/automations')) {
    // Remover headers CORS existentes
    reply.removeHeader('Access-Control-Allow-Origin')
    reply.removeHeader('Access-Control-Allow-Credentials')
    reply.removeHeader('Access-Control-Allow-Methods')
    reply.removeHeader('Access-Control-Allow-Headers')
    reply.removeHeader('Access-Control-Expose-Headers')
    reply.removeHeader('Access-Control-Max-Age')

    // Definir headers CORS liberados para webhooks
    reply.header('Access-Control-Allow-Origin', '*')
    reply.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    reply.header(
      'Access-Control-Allow-Headers',
      'Content-Type, X-Webhook-Secret',
    )
    reply.header(
      'Access-Control-Expose-Headers',
      'Content-Range, X-Content-Range',
    )
    reply.header('Access-Control-Max-Age', '86400')
    reply.header('Content-Type', 'application/json')

    // Responder às requisições OPTIONS (preflight)
    if (request.method === 'OPTIONS') {
      return reply.code(204).send()
    }
  }
})

// Adiciona headers de segurança com helmet
app.register(helmet, {
  global: true,
  crossOriginEmbedderPolicy: ENV.IS_PRODUCTION,
  crossOriginOpenerPolicy: ENV.IS_PRODUCTION
    ? { policy: 'same-origin' }
    : false,
  crossOriginResourcePolicy: ENV.IS_PRODUCTION
    ? { policy: 'cross-origin' }
    : false,
  hidePoweredBy: true,
  hsts: ENV.IS_PRODUCTION
    ? {
        maxAge: 31536000, // 1 year
        includeSubDomains: true,
        preload: true,
      }
    : false,
  noSniff: true,
  xssFilter: true,
  referrerPolicy: { policy: 'same-origin' },
  permittedCrossDomainPolicies: false,
  originAgentCluster: true,
  contentSecurityPolicy: ENV.IS_PRODUCTION
    ? {
        useDefaults: false,
        directives: {
          // Core directives
          defaultSrc: ["'self'"],
          baseUri: ["'self'"],
          blockAllMixedContent: [],
          
          // Script security - strict execution
          scriptSrc: ["'self'", "'strict-dynamic'"],
          scriptSrcElem: ["'self'"],
          scriptSrcAttr: ["'none'"],
          
          // Style security - remove unsafe-inline for better security
          styleSrc: ["'self'", "'sha256-47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU='"], // Empty stylesheet hash
          styleSrcElem: ["'self'"],
          styleSrcAttr: ["'none'"],
          
          // Image and media sources
          imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
          mediaSrc: ["'self'", 'blob:'],
          
          // Font sources
          fontSrc: ["'self'", 'https:', 'data:'],
          
          // Connection sources - API endpoints
          connectSrc: [
            "'self'",
            'https://clerk.matra.com.br',
            'https://api.clerk.com',
            'wss://api.clerk.com',
            'https://clerk.matra.com.br/v1',
          ],
          
          // Frame and embedding restrictions
          frameSrc: ["'none'"],
          frameAncestors: ["'none'"],
          embedSrc: ["'none'"],
          
          // Object and plugin restrictions
          objectSrc: ["'none'"],
          pluginTypes: [],
          
          // Worker and manifest
          workerSrc: ["'self'", 'blob:'],
          manifestSrc: ["'self'"],
          childSrc: ["'none'"],
          
          // Form and navigation security
          formAction: ["'self'"],
          navigateTo: ["'self'"],
          
          // Upgrade insecure requests
          upgradeInsecureRequests: [],
          
          // Require trusted types (modern browsers)
          requireTrustedTypesFor: ["'script'"],
          trustedTypes: ['default'],
          
          // Report violations for monitoring and debugging
          reportUri: ['/api/csp-report'],
        },
        // Enable CSP reporting in development for debugging
        reportOnly: false,
      }
    : {
        // Development CSP - less restrictive for easier debugging
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:', 'https:', 'blob:'],
          connectSrc: [
            "'self'",
            'https://clerk.matra.com.br',
            'https://api.clerk.com',
            'ws://localhost:*',
            'wss://localhost:*',
          ],
          fontSrc: ["'self'", 'https:', 'data:'],
          frameSrc: ["'self'"],
          objectSrc: ["'none'"],
        },
        reportOnly: true, // Report only in development
      },
})

// Configuração de arquivos estáticos
app.register(fastifyStatic, {
  root: path.join(__dirname, 'public'),
  prefix: '/public/',
  // Security headers for static files
  setHeaders: (res, path) => {
    // Cache static assets for 1 year in production
    if (ENV.IS_PRODUCTION) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }

    // Security headers
    res.setHeader('X-Content-Type-Options', 'nosniff')

    // Set appropriate content type for favicon
    if (path.endsWith('.ico')) {
      res.setHeader('Content-Type', 'image/x-icon')
    }
  },
  // Don't list directory contents
  list: false,
  // Send index.html for directory requests
  index: false,
})

// Rotas específicas para favicon e ícones
app.get('/favicon.ico', async (_req, reply) => {
  return reply.sendFile('favicon.ico', path.join(__dirname, 'public'))
})

app.get('/favicon-16x16.png', async (_req, reply) => {
  return reply.sendFile('favicon-16x16.png', path.join(__dirname, 'public'))
})

app.get('/favicon-32x32.png', async (_req, reply) => {
  return reply.sendFile('favicon-32x32.png', path.join(__dirname, 'public'))
})

app.get('/apple-touch-icon.png', async (_req, reply) => {
  return reply.sendFile('apple-touch-icon.png', path.join(__dirname, 'public'))
})

app.get('/android-chrome-192x192.png', async (_req, reply) => {
  return reply.sendFile(
    'android-chrome-192x192.png',
    path.join(__dirname, 'public'),
  )
})

app.get('/android-chrome-512x512.png', async (_req, reply) => {
  return reply.sendFile(
    'android-chrome-512x512.png',
    path.join(__dirname, 'public'),
  )
})

app.get('/site.webmanifest', async (_req, reply) => {
  reply.type('application/manifest+json')
  return reply.sendFile('site.webmanifest', path.join(__dirname, 'public'))
})

// Carrega rotas automaticamente da pasta routes
app.register(autoload, {
  dir: path.join(__dirname, 'routes'),
  routeParams: true,
  options: {
    prefix: '/',
  },
  // ignorePattern: /^(?!.*(post|get|delete|put|patch)\.ts$).*/,
})

import {
  requestSanitizationMiddleware,
  responseSecurityMiddleware,
  securityMiddleware,
} from '@/middlewares/security'

// Apply security middlewares
app.addHook(
  'preHandler',
  securityMiddleware({
    enableRequestId: true,
    enableSecurityHeaders: true,
    maxRequestSize: 10 * 1024 * 1024, // 10MB
  }),
)

app.addHook('preHandler', requestSanitizationMiddleware())
app.addHook('onSend', responseSecurityMiddleware())

// Optimized consolidated validation middleware
app.addHook('preHandler', async (request, reply) => {
  // Fast path: skip validation for static/health endpoints
  if (
    SKIP_VALIDATION_PATHS.has(request.url) ||
    request.url.startsWith('/public/')
  ) {
    return
  }

  // Validate request size early (fast check)
  const contentLength = request.headers['content-length']
  if (contentLength && parseInt(contentLength) > 10485760) { // 10MB in bytes
    return reply.code(413).send({
      error: 'Payload Too Large',
      message: 'Request body excede o limite de 10MB',
    })
  }

  // Content-Type validation for write operations (optimized)
  if (WRITE_METHODS.has(request.method)) {
    const contentType = request.headers['content-type']

    if (!contentType) {
      return reply.code(400).send({
        error: 'Bad Request',
        message: 'Content-Type header é obrigatório',
      })
    }

    // Fast Set-based validation instead of string.includes()
    let validContentType = false
    for (const validType of VALID_CONTENT_TYPES) {
      if (contentType.includes(validType)) {
        validContentType = true
        break
      }
    }

    if (!validContentType) {
      return reply.code(415).send({
        error: 'Unsupported Media Type',
        message:
          'Content-Type deve ser application/json ou multipart/form-data',
      })
    }
  }
})

// Enhanced error handler
app.setErrorHandler((error, request, reply) => {
  // Log error with context (sanitization will be done automatically by logError)
  const errorData = {
    message: error.message,
    stack: ENV.IS_DEVELOPMENT ? error.stack : undefined,
    statusCode: error.statusCode,
    url: request.url,
    method: request.method,
    requestId: request.id,
    // Include request body if present (will be sanitized automatically)
    body: request.body || undefined,
  }

  logError('Request error', errorData)

  // Handle specific error types
  if (error.validation) {
    return reply.code(400).send({
      error: 'Validation Error',
      message: 'Dados de entrada inválidos',
      details: ENV.IS_DEVELOPMENT ? error.validation : undefined,
    })
  }

  if (error.statusCode === 401) {
    return reply.code(401).send({
      error: 'Unauthorized',
      message: 'Token de autenticação inválido ou ausente',
    })
  }

  if (error.statusCode === 403) {
    return reply.code(403).send({
      error: 'Forbidden',
      message: 'Acesso negado',
    })
  }

  if (error.statusCode === 404) {
    return reply.code(404).send({
      error: 'Not Found',
      message: 'Recurso não encontrado',
    })
  }

  // Generic error response
  const statusCode = error.statusCode || 500
  const message = ENV.IS_PRODUCTION ? 'Erro interno do servidor' : error.message

  return reply.code(statusCode).send({
    error: error.name || 'InternalServerError',
    message,
    statusCode,
    requestId: request.id,
  })
})

// Not found handler
app.setNotFoundHandler((request, reply) => {
  reply.code(404).send({
    error: 'Not Found',
    message: `Rota ${request.method} ${request.url} não encontrada`,
    statusCode: 404,
  })
})

// Process error handlers
process.on('uncaughtException', error => {
  logError('Uncaught Exception', error)
  // Don't exit immediately, let graceful shutdown handle it
})

process.on('unhandledRejection', (reason, _promise) => {
  logError('Unhandled Rejection', reason as Error)
})

// User synchronization cron job
const userSyncService = UserSyncService.getInstance()
let userSyncTask: cron.ScheduledTask | null = null

// Initialize user sync cron job
const initUserSyncCron = () => {
  const cronSchedule = ENV.USER_SYNC_CRON_SCHEDULE || '0 */15 * * * *' // Every 15 minutes by default (optimized)
  const enableSync = ENV.ENABLE_USER_SYNC !== 'false' // Enabled by default

  if (!enableSync) {
    logInfo('User sync cron job is disabled')
    return
  }

  userSyncTask = cron.schedule(
    cronSchedule,
    async () => {
      try {
        await userSyncService.syncUsersWithCache()
      } catch (error) {
        logError('User sync cron job failed', error as Error)
      }
    },
    {
      timezone: 'America/Sao_Paulo',
    },
  )

  logInfo(`User sync cron job scheduled: ${cronSchedule}`)
}

// Enhanced graceful shutdown
const signals = ['SIGINT', 'SIGTERM']
let shuttingDown = false

signals.forEach(signal => {
  process.on(signal, async () => {
    if (shuttingDown) {
      logWarn('Graceful shutdown already in progress, forcing exit...')
      process.exit(1)
    }

    shuttingDown = true
    logInfo(`⏳ Iniciando graceful shutdown (${signal})...`)

    try {
      // Stop cron jobs
      if (userSyncTask) {
        userSyncTask.stop()
        logInfo('⏱️ User sync cron job stopped')
      }

      // Stop accepting new connections
      await new Promise<void>((resolve, reject) => {
        app.server.close(err => {
          if (err) reject(err)
          else resolve()
        })
      })

      // Close Socket.IO and Redis connections
      await new Promise<void>(resolve => {
        io.close(async () => {
          logInfo('🔌 Socket.IO fechado com sucesso')

          // Close Redis adapter connections if using Redis adapter
          if (
            ENV.SOCKET_IO.ADAPTER_TYPE === 'redis' &&
            pubClient &&
            subClient
          ) {
            try {
              await pubClient.quit()
              await subClient.quit()
              logInfo('🔌 Redis adapter connections closed')
            } catch (error) {
              logError(
                'Error closing Redis adapter connections',
                error as Error,
              )
            }
          }

          resolve()
        })
      })

      // Close Fastify
      await app.close()
      logInfo('🛑 Fastify fechado com sucesso')

      logInfo('✅ Graceful shutdown concluído')
      process.exit(0)
    } catch (err) {
      logError('Erro durante o graceful shutdown', err as Error)
      process.exit(1)
    }
  })
})

// Start the server
app.listen(
  {
    port: ENV.PORT,
    backlog: 511,
    host: '0.0.0.0',
  },
  err => {
    if (err) {
      logError('Erro ao iniciar o servidor', err)
      process.exit(1)
    }

    logInfo(`🚀 Server running on port ${ENV.PORT}`)
    logInfo(`🔌 Socket.IO server is ready`)
    logInfo(`🌍 Ambiente: ${ENV.NODE_ENV}`)
    logInfo(`📊 Under Pressure monitoring ativo`)

    // Initialize user sync cron job
    initUserSyncCron()

    // Log cron job status and run initial sync if enabled
    if (userSyncTask) {
      logInfo('⏱️ User sync cron job started')

      // Run initial sync after server starts (with delay)
      setTimeout(async () => {
        try {
          logInfo('Running initial user sync...')
          await userSyncService.syncUsersWithCache()
        } catch (error) {
          logError('Initial user sync failed', error as Error)
        }
      }, 5000) // 5 seconds delay
    }

    // Log server configuration
    if (ENV.IS_DEVELOPMENT) {
      logInfo('Server configuration', {
        bodyLimit: '10MB',
        requestTimeout: '15s',
        connectionTimeout: '30s',
        rateLimitEnabled: false,
        compressionEnabled: true,
        securityHeadersEnabled: true,
        underPressureEnabled: true,
        userSyncEnabled: ENV.ENABLE_USER_SYNC !== 'false',
        userSyncSchedule: ENV.USER_SYNC_CRON_SCHEDULE || '0 */15 * * * *',
        socketIO: {
          adapterType: ENV.SOCKET_IO.ADAPTER_TYPE,
          batchInterval: `${ENV.SOCKET_IO.BATCH_INTERVAL}ms`,
          connectionStateRecovery: ENV.SOCKET_IO.CONNECTION_STATE_RECOVERY,
          maxDisconnectionDuration: `${ENV.SOCKET_IO.MAX_DISCONNECTION_DURATION}ms`,
        },
        pressureThresholds: {
          maxEventLoopDelay: ENV.IS_PRODUCTION ? '1000ms' : '2000ms',
          maxHeapUsed: ENV.IS_PRODUCTION ? '500MB' : '1000MB',
          maxRss: ENV.IS_PRODUCTION ? '750MB' : '1500MB',
          maxEventLoopUtilization: '98%',
        },
      })
    }
  },
)
