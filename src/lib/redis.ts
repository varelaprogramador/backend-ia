import Redis from 'ioredis'

import { logError, logInfo } from '@/utils/logger'

interface RedisConfig {
  maxRetriesPerRequest: number
  retryDelayOnFailover: number
  enableReadyCheck: boolean
  maxmemoryPolicy: string
  lazyConnect: boolean
}

const redisConfig: RedisConfig = {
  maxRetriesPerRequest: 3,
  retryDelayOnFailover: 100,
  enableReadyCheck: false,
  maxmemoryPolicy: 'allkeys-lru',
  lazyConnect: true,
}

export const redis = new Redis(process.env.REDIS_URL!, redisConfig)

// Eventos de conexão para monitoramento
redis.on('connect', () => {
  logInfo('✅ Redis connected')
})

redis.on('error', error => {
  logError('❌ Redis connection error:', error)
})

redis.on('ready', () => {
  logInfo('🚀 Redis ready to accept commands')
})

redis.on('close', () => {
  logInfo('🔴 Redis connection closed')
})

// Função helper para verificar se o Redis está disponível
export const isRedisAvailable = async (): Promise<boolean> => {
  try {
    await redis.ping()
    return true
  } catch {
    return false
  }
}

// Função para obter valor de chave baseado no tipo
async function getKeyValue(key: string, type: string): Promise<any> {
  try {
    switch (type) {
      case 'string':
        return await redis.get(key)
      case 'hash':
        return await redis.hgetall(key)
      case 'list':
        return await redis.lrange(key, 0, -1)
      case 'set':
        return await redis.smembers(key)
      case 'zset':
        return await redis.zrange(key, 0, -1, 'WITHSCORES')
      case 'stream':
        return await redis.xrange(key, '-', '+')
      default:
        return null
    }
  } catch (error) {
    logError(`Erro ao obter valor da chave ${key}:`, error)
    return null
  }
}

// Função para obter informações de TTL
async function getKeyTTL(key: string): Promise<number | null> {
  try {
    const ttl = await redis.ttl(key)
    return ttl === -1 ? null : ttl
  } catch {
    return null
  }
}

// Função para deletar uma chave específica
export const deleteRedisKey = async (key: string): Promise<boolean> => {
  try {
    if (!(await isRedisAvailable())) {
      throw new Error('Redis não está disponível')
    }

    const result = await redis.del(key)
    logInfo(`Chave ${key} deletada do Redis`)
    return result > 0
  } catch (error) {
    logError(`Erro ao deletar chave ${key}:`, error)
    throw error
  }
}

// Função para limpar todo o cache
export const flushAllRedisCache = async (): Promise<void> => {
  try {
    if (!(await isRedisAvailable())) {
      throw new Error('Redis não está disponível')
    }

    await redis.flushall()
    logInfo('Todo o cache Redis foi limpo')
  } catch (error) {
    logError('Erro ao limpar cache do Redis:', error)
    throw error
  }
}

// Função para obter estatísticas detalhadas do Redis
export const getRedisStats = async (): Promise<{
  server: Record<string, any>
  clients: Record<string, any>
  memory: Record<string, any>
  persistence: Record<string, any>
  stats: Record<string, any>
  replication: Record<string, any>
  cpu: Record<string, any>
  keyspace: Record<string, any>
}> => {
  try {
    if (!(await isRedisAvailable())) {
      throw new Error('Redis não está disponível')
    }

    const info = await redis.info()
    const sections = info.split('\r\n\r\n')

    const stats: any = {
      server: {},
      clients: {},
      memory: {},
      persistence: {},
      stats: {},
      replication: {},
      cpu: {},
      keyspace: {},
    }

    sections.forEach(section => {
      if (!section.trim()) return

      const lines = section.split('\r\n')
      const sectionHeader = lines[0].replace('# ', '').toLowerCase()

      if (stats[sectionHeader]) {
        lines.slice(1).forEach(line => {
          if (line && line.includes(':')) {
            const [key, value] = line.split(':')
            stats[sectionHeader][key] = value
          }
        })
      }
    })

    return stats
  } catch (error) {
    logError('Erro ao obter estatísticas do Redis:', error)
    throw error
  }
}

// Função principal para obter todo o cache do Redis
export const getAllRedisCache = async (): Promise<{
  keys: string[]
  cache: Record<string, any>
  info: {
    totalKeys: number
    keysByType: Record<string, number>
    memory: string | null
    timestamp: string
  }
}> => {
  try {
    if (!(await isRedisAvailable())) {
      throw new Error('Redis não está disponível')
    }

    // Obtém todas as chaves
    const keys = await redis.keys('*')
    const cache: Record<string, any> = {}
    const keysByType: Record<string, number> = {}

    // Para cada chave, obtém o tipo, valor e TTL
    for (const key of keys) {
      try {
        const type = await redis.type(key)
        const value = await getKeyValue(key, type)
        const ttl = await getKeyTTL(key)

        cache[key] = {
          type,
          value,
          ttl: ttl === null ? 'persistent' : `${ttl}s`,
        }

        // Conta tipos
        keysByType[type] = (keysByType[type] || 0) + 1
      } catch (error) {
        logError(`Erro ao processar chave ${key}:`, error)
        cache[key] = {
          type: 'error',
          value: null,
          ttl: null,
          error: error instanceof Error ? error.message : 'Erro desconhecido',
        }
      }
    }

    // Obtém informações de memória do Redis
    let memoryInfo = null
    try {
      const info = await redis.info('memory')
      const memoryMatch = info.match(/used_memory_human:(.+)\r?\n/)
      memoryInfo = memoryMatch ? memoryMatch[1] : null
    } catch (error) {
      logError('Erro ao obter informações de memória:', error)
    }

    return {
      keys,
      cache,
      info: {
        totalKeys: keys.length,
        keysByType,
        memory: memoryInfo,
        timestamp: new Date().toISOString(),
      },
    }
  } catch (error) {
    logError('Erro ao obter cache do Redis:', error)
    throw error
  }
}
