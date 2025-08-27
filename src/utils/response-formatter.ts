import { FastifyReply } from 'fastify'
import { StatusCodes } from 'http-status-codes'

type ApiResponse = {
  success: boolean
  error?: string
  message?: string
  data?: any
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
