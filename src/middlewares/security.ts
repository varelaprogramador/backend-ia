import { FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'

interface SecurityMiddlewareOptions {
  enableRequestId?: boolean
  enableSecurityHeaders?: boolean
  maxRequestSize?: number
}

/**
 * Enhanced security middleware with additional validations
 */
export const securityMiddleware = (options: SecurityMiddlewareOptions = {}) => {
  const {
    enableRequestId = true,
    enableSecurityHeaders = true,
    maxRequestSize = 40 * 1024 * 1024, // 40MB default
  } = options

  return async (req: FastifyRequest, reply: FastifyReply) => {
    // Add request ID for tracing
    if (enableRequestId && !req.headers['x-request-id']) {
      const requestId = `req_${Date.now()}_${Math.random()
        .toString(36)
        .substring(2, 11)}`
      req.headers['x-request-id'] = requestId
    }

    // Additional security headers
    if (enableSecurityHeaders) {
      reply.headers({
        'X-Request-ID': req.headers['x-request-id'] as string,
        'X-Response-Time': Date.now().toString(),
        'Strict-Transport-Security':
          'max-age=31536000; includeSubDomains; preload',
        'X-Permitted-Cross-Domain-Policies': 'none',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Cross-Origin-Embedder-Policy': 'require-corp',
        'Cross-Origin-Resource-Policy': 'cross-origin',
      })
    }

    // Validate request size (additional check)
    const contentLength = req.headers['content-length']
    if (contentLength && parseInt(contentLength) > maxRequestSize) {
      return reply.status(StatusCodes.REQUEST_TOO_LONG).send({
        error: 'Request entity too large',
        message: `Request size exceeds maximum allowed size of ${maxRequestSize} bytes`,
        status: StatusCodes.REQUEST_TOO_LONG,
      })
    }

    // Validate Content-Type for POST/PUT/PATCH requests
    if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
      const contentType = req.headers['content-type']
      if (!contentType) {
        return reply.status(StatusCodes.BAD_REQUEST).send({
          error: 'Missing Content-Type header',
          message: 'Content-Type header is required for write operations',
          status: StatusCodes.BAD_REQUEST,
        })
      }

      // Only allow specific content types
      const allowedTypes = [
        'application/json',
        'application/x-www-form-urlencoded',
        'multipart/form-data',
      ]

      const isAllowed = allowedTypes.some(type =>
        contentType.toLowerCase().startsWith(type),
      )

      if (!isAllowed) {
        return reply.status(StatusCodes.UNSUPPORTED_MEDIA_TYPE).send({
          error: 'Unsupported Content-Type',
          message: `Content-Type must be one of: ${allowedTypes.join(', ')}`,
          status: StatusCodes.UNSUPPORTED_MEDIA_TYPE,
        })
      }
    }
  }
}

/**
 * Request sanitization middleware
 */
export const requestSanitizationMiddleware = () => {
  return async (req: FastifyRequest) => {
    // Sanitize query parameters
    if (req.query && typeof req.query === 'object') {
      for (const [key, value] of Object.entries(req.query)) {
        if (typeof value === 'string') {
          // Remove potentially dangerous characters
          const sanitized = value
            .replace(/[<>\"']/g, '') // Remove HTML/script injection chars
            .replace(/javascript:/gi, '') // Remove javascript: protocol
            .replace(/data:/gi, '') // Remove data: protocol
            .trim()

          if (sanitized !== value) {
            req.log.warn(`Sanitized query parameter: ${key}`)
            ;(req.query as any)[key] = sanitized
          }
        }
      }
    }

    // Sanitize path parameters
    if (req.params && typeof req.params === 'object') {
      for (const [key, value] of Object.entries(req.params)) {
        if (typeof value === 'string') {
          // Basic path traversal protection
          const sanitized = value
            .replace(/\.\./g, '') // Remove path traversal
            .replace(/[<>\"']/g, '') // Remove HTML/script injection chars
            .trim()

          if (sanitized !== value) {
            req.log.warn(`Sanitized path parameter: ${key}`)
            ;(req.params as any)[key] = sanitized
          }
        }
      }
    }
  }
}

/**
 * Response security headers middleware
 */
export const responseSecurityMiddleware = () => {
  return async (_req: FastifyRequest, reply: FastifyReply) => {
    reply.header('X-Content-Type-Options', 'nosniff')
    reply.header('X-Frame-Options', 'DENY')
    reply.header('X-XSS-Protection', '1; mode=block')
    reply.header('Referrer-Policy', 'strict-origin-when-cross-origin')
    reply.header(
      'Permissions-Policy',
      'camera=(), microphone=(), geolocation=()',
    )
  }
}
