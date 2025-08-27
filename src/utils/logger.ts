import dayjs from 'dayjs'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import pino from 'pino'

dayjs.extend(utc)
dayjs.extend(timezone)

const timeZone = 'America/Sao_Paulo'

// Utility function to sanitize sensitive data from logs with circular reference protection
const sanitizeLogData = (
  data: any,
  visited = new WeakSet(),
  depth = 0,
): any => {
  // Prevent infinite recursion with depth limit
  if (depth > 10) {
    return '[MAX_DEPTH_REACHED]'
  }

  // Handle null, undefined, and primitive types
  if (data === null || data === undefined) {
    return data
  }

  if (typeof data === 'string') {
    // Detect data URLs with base64 (e.g., data:audio/webm;base64,...)
    if (data.length > 100 && /^data:[^;]+;base64,/.test(data)) {
      const mimeType = data.split(';')[0]
      const size = Math.round((data.length * 3) / 4 / 1024) // Approximate KB size
      return `${mimeType};base64,[REDACTED_${size}KB]`
    }

    // Detect plain base64 strings (longer than 100 chars and valid base64)
    if (data.length > 100 && /^[A-Za-z0-9+/]+=*$/.test(data)) {
      const size = Math.round((data.length * 3) / 4 / 1024) // Approximate KB size
      return `[BASE64_REDACTED_${size}KB]`
    }

    // // Truncate very long strings that might be binary data
    // if (data.length > 500) {
    //   return `[LONG_STRING_${data.length}_CHARS]${data.substring(0, 100)}...`
    // }

    return data
  }

  // Handle non-string primitives
  if (typeof data !== 'object') {
    return data
  }

  // Prevent circular references
  if (visited.has(data)) {
    return '[CIRCULAR_REFERENCE]'
  }

  // Special handling for Error objects
  if (data instanceof Error) {
    return {
      name: data.name,
      message: data.message,
      // stack: data.stack ? data.stack.substring(0, 500) + '...' : undefined,
      stack: data.stack || undefined,
    }
  }

  // Special handling for Date objects
  if (data instanceof Date) {
    return data.toISOString()
  }

  // Mark this object as visited
  visited.add(data)

  try {
    if (Array.isArray(data)) {
      // Limit array processing to prevent huge arrays from crashing
      const maxItems = 50
      const result = data
        .slice(0, maxItems)
        .map(item => sanitizeLogData(item, visited, depth + 1))

      if (data.length > maxItems) {
        result.push(`[TRUNCATED_${data.length - maxItems}_MORE_ITEMS]`)
      }

      return result
    }

    // Handle plain objects
    const sanitized: any = {}
    const sensitiveFields = [
      'audio',
      'media',
      'image',
      'video',
      'document',
      'sticker',
      'file',
      'attachment',
    ]

    // Get object entries safely
    let entries: [string, any][] = []
    try {
      entries = Object.entries(data)
    } catch (error) {
      return '[OBJECT_ENUMERATION_ERROR]'
    }

    // Limit number of properties to prevent huge objects
    const maxProps = 20
    let processedProps = 0

    for (const [key, value] of entries) {
      if (processedProps >= maxProps) {
        sanitized['[TRUNCATED]'] =
          `[${entries.length - maxProps}_MORE_PROPERTIES]`
        break
      }

      try {
        if (sensitiveFields.includes(key.toLowerCase())) {
          if (typeof value === 'string' && value.length > 50) {
            sanitized[key] = `[${key.toUpperCase()}_DATA_REDACTED]`
          } else {
            sanitized[key] = sanitizeLogData(value, visited, depth + 1)
          }
        } else {
          sanitized[key] = sanitizeLogData(value, visited, depth + 1)
        }
        processedProps++
      } catch (error) {
        sanitized[key] = '[PROPERTY_ACCESS_ERROR]'
        processedProps++
      }
    }

    return sanitized
  } catch (error) {
    return '[SANITIZATION_ERROR]'
  } finally {
    // Remove from visited set when done with this branch
    visited.delete(data)
  }
}

// Export the sanitization function for use in other modules
export { sanitizeLogData }

export const logger = pino({
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  timestamp: () =>
    `,"time":"${dayjs().tz(timeZone).format('DD/MM/YYYY HH:mm:ss A')}"`,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      levelFirst: true,
      messageFormat: '{msg}',
    },
  },
})

export const fastifyLogger = {
  level: process.env.NODE_ENV === 'development' ? 'debug' : 'info',
  timestamp: () =>
    `,"time":"${dayjs().tz(timeZone).format('DD/MM/YYYY HH:mm:ss A')}"`,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      ignore: 'pid,hostname',
      levelFirst: true,
      messageFormat: '{msg}',
    },
  },
}
/**
 * Loga uma mensagem de informação.
 * @param msg Mensagem principal do log
 * @param meta (Opcional) Objeto com dados adicionais estruturados - será sanitizado automaticamente
 */
export const logInfo = (msg: string, meta?: unknown) => {
  if (meta) {
    const sanitizedMeta = sanitizeLogData(meta)
    logger.info(sanitizedMeta, msg)
  } else {
    logger.info(msg)
  }
}

/**
 * Loga um aviso.
 * @param msg Mensagem principal do log
 * @param meta (Opcional) Objeto com dados adicionais estruturados - será sanitizado automaticamente
 */
export const logWarn = (msg: string, meta?: unknown) => {
  if (meta) {
    const sanitizedMeta = sanitizeLogData(meta)
    logger.warn(sanitizedMeta, msg)
  } else {
    logger.warn(msg)
  }
}

/**
 * Loga um erro.
 * @param msg Mensagem principal do log
 * @param meta (Opcional) Objeto com dados adicionais estruturados ou erro - será sanitizado automaticamente
 */
export const logError = (msg: string, meta?: unknown) => {
  if (meta) {
    const sanitizedMeta = sanitizeLogData(meta)
    logger.error(sanitizedMeta, msg)
  } else {
    logger.error(msg)
  }
}

/**
 * Loga uma mensagem de debug.
 * @param msg Mensagem principal do log
 * @param meta (Opcional) Objeto com dados adicionais estruturados - será sanitizado automaticamente
 */
export const logDebug = (msg: string, meta?: unknown) => {
  if (meta) {
    const sanitizedMeta = sanitizeLogData(meta)
    logger.debug(sanitizedMeta, msg)
  } else {
    logger.debug(msg)
  }
}
