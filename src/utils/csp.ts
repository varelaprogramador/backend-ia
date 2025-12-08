import { randomBytes } from 'crypto'
import type { FastifyRequest, FastifyReply } from 'fastify'

/**
 * Generate a cryptographically secure nonce for CSP
 */
export function generateNonce(): string {
  return randomBytes(16).toString('base64')
}

/**
 * Add CSP nonce to request for use in templates/responses
 */
export function addCSPNonce(req: FastifyRequest, reply: FastifyReply): string {
  const nonce = generateNonce()
  
  // Store nonce in request for template use
  ;(req as any).cspNonce = nonce
  
  // Add nonce to CSP header if not in production (where helmet handles it)
  if (!process.env.NODE_ENV || process.env.NODE_ENV !== 'production') {
    reply.header(
      'Content-Security-Policy',
      `script-src 'self' 'nonce-${nonce}'; style-src 'self' 'nonce-${nonce}';`
    )
  }
  
  return nonce
}

/**
 * Generate SHA-256 hash for inline content (for CSP hash-based allowlist)
 */
export function generateCSPHash(content: string, algorithm: 'sha256' | 'sha384' | 'sha512' = 'sha256'): string {
  const crypto = require('crypto')
  const hash = crypto.createHash(algorithm).update(content, 'utf8').digest('base64')
  return `'${algorithm}-${hash}'`
}

/**
 * CSP directive builder utility
 */
export class CSPBuilder {
  private directives: Record<string, string[]> = {}

  constructor() {
    // Initialize with safe defaults
    this.directives = {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'"],
      'img-src': ["'self'", 'data:', 'https:'],
      'font-src': ["'self'", 'https:', 'data:'],
      'connect-src': ["'self'"],
      'frame-src': ["'none'"],
      'object-src': ["'none'"],
      'base-uri': ["'self'"],
      'form-action': ["'self'"],
    }
  }

  /**
   * Add source to a directive
   */
  addSource(directive: string, source: string): this {
    if (!this.directives[directive]) {
      this.directives[directive] = []
    }
    if (!this.directives[directive].includes(source)) {
      this.directives[directive].push(source)
    }
    return this
  }

  /**
   * Add nonce to script and style directives
   */
  addNonce(nonce: string): this {
    this.addSource('script-src', `'nonce-${nonce}'`)
    this.addSource('style-src', `'nonce-${nonce}'`)
    return this
  }

  /**
   * Add hash to script or style directive
   */
  addHash(directive: 'script-src' | 'style-src', hash: string): this {
    this.addSource(directive, hash)
    return this
  }

  /**
   * Build CSP policy string
   */
  build(): string {
    return Object.entries(this.directives)
      .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
      .join('; ')
  }

  /**
   * Get directive sources
   */
  getDirective(directive: string): string[] {
    return this.directives[directive] || []
  }
}

/**
 * Common CSP configurations
 */
export const CSPPresets = {
  /**
   * Strict CSP for API endpoints
   */
  api: () => new CSPBuilder()
    .addSource('default-src', "'none'")
    .addSource('script-src', "'none'")
    .addSource('style-src', "'none'")
    .addSource('img-src', "'none'")
    .addSource('font-src', "'none'")
    .addSource('connect-src', "'none'")
    .addSource('frame-src', "'none'")
    .build(),

  /**
   * Basic web app CSP
   */
  webapp: (nonce?: string) => {
    const builder = new CSPBuilder()
      .addSource('script-src', "'strict-dynamic'")
      .addSource('style-src', "'unsafe-inline'") // Can be removed when using nonce/hash
      .addSource('img-src', 'blob:')
      .addSource('connect-src', 'wss:')
      .addSource('worker-src', 'blob:')

    if (nonce) {
      builder.addNonce(nonce)
    }

    return builder.build()
  },

  /**
   * Development CSP (less restrictive)
   */
  development: () => new CSPBuilder()
    .addSource('default-src', "'unsafe-inline'")
    .addSource('default-src', "'unsafe-eval'")
    .addSource('script-src', "'unsafe-inline'")
    .addSource('script-src', "'unsafe-eval'")
    .addSource('style-src', "'unsafe-inline'")
    .addSource('connect-src', 'ws:')
    .addSource('connect-src', 'wss:')
    .build(),
}