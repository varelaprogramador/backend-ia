import { FastifyReply } from 'fastify'
import { StatusCodes } from 'http-status-codes'

type ApiResponse = {
  success: boolean
  error?: string
  message?: string
  data?: any
  metadata?: any
}

type FormatResponseOptions = {
  success?: boolean
  message?: string
  error?: string
  data?: any
  metadata?: any
}

/**
 * Envia uma resposta padronizada de sucesso
 */
export const sendSuccess = (
  reply: FastifyReply,
  options: {
    status?: number
    message?: string
    data?: any
  } = {},
) => {
  const { status = StatusCodes.OK, message, data } = options

  const response: ApiResponse = {
    success: true,
    message,
    data,
  }

  return reply.status(status).send(response)
}

/**
 * Envia uma resposta padronizada de erro
 */
export const sendError = (
  reply: FastifyReply,
  options: {
    status?: number
    error: string
    data?: any
  },
) => {
  const { status = StatusCodes.BAD_REQUEST, error, data } = options

  const response: ApiResponse = {
    success: false,
    error,
    data,
  }

  return reply.status(status).send(response)
}

/**
 * Formata uma resposta padronizada (para uso com return)
 */
export const formatResponse = (options: FormatResponseOptions = {}): ApiResponse => {
  const { 
    success = true, 
    message, 
    error, 
    data, 
    metadata 
  } = options

  const response: ApiResponse = {
    success: success && !error,
    ...(message && { message }),
    ...(error && { error }),
    ...(data !== undefined && { data }),
    ...(metadata && { metadata }),
  }

  return response
}
