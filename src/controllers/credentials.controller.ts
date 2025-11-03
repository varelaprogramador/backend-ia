import type { FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import axios from 'axios'

import { db } from '@/lib/db'
import { sendSuccess, sendError } from '@/utils/response-formatter'

interface CreateCredentialBody {
  name: string
  type: 'GOOGLE_CALENDAR' | 'CHATGPT' | 'N8N' | 'CUSTOM'
  url: string
  method?: string
  authHeaderKey?: string
  authHeaderValue?: string
  customHeaders?: Record<string, string>
  awaitResponse?: boolean
  successModel?: Record<string, any>
  data?: Record<string, any>
}

interface UpdateCredentialBody extends Partial<CreateCredentialBody> {
  isActive?: boolean
}

export class CredentialsController {
  // GET /credentials - Listar todas as credenciais do usuário
  static async list(req: FastifyRequest, reply: FastifyReply) {
    try {
      const userId = req.user!.id

      const credentials = await db.credential.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
      })

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        data: credentials,
      })
    } catch (error) {
      req.log.error(error, 'Error fetching credentials')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao buscar credenciais',
      })
    }
  }

  // GET /credentials/:id - Buscar credencial específica
  static async getOne(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { id } = req.params
      const userId = req.user!.id

      const credential = await db.credential.findFirst({
        where: { id, userId },
      })

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          message: 'Credencial não encontrada',
        })
      }

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        data: credential,
      })
    } catch (error) {
      req.log.error(error, 'Error fetching credential')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao buscar credencial',
      })
    }
  }

  // POST /credentials - Criar nova credencial
  static async create(
    req: FastifyRequest<{ Body: CreateCredentialBody }>,
    reply: FastifyReply,
  ) {
    try {
      const userId = req.user!.id
      const {
        name,
        type,
        url,
        method = 'POST',
        authHeaderKey,
        authHeaderValue,
        customHeaders,
        awaitResponse = false,
        successModel,
        data,
      } = req.body

      // Validações básicas
      if (!name || !type || !url) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          message: 'Nome, tipo e URL são obrigatórios',
        })
      }

      const credential = await db.credential.create({
        data: {
          userId,
          name,
          type,
          url,
          method,
          authHeaderKey,
          authHeaderValue,
          customHeaders: customHeaders || null,
          awaitResponse,
          successModel: successModel || null,
          data: data || null,
        },
      })

      return sendSuccess(reply, {
        status: StatusCodes.CREATED,
        message: 'Credencial criada com sucesso',
        data: credential,
      })
    } catch (error) {
      req.log.error(error, 'Error creating credential')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao criar credencial',
      })
    }
  }

  // PUT /credentials/:id - Atualizar credencial
  static async update(
    req: FastifyRequest<{
      Params: { id: string }
      Body: UpdateCredentialBody
    }>,
    reply: FastifyReply,
  ) {
    try {
      const { id } = req.params
      const userId = req.user!.id

      // Verificar se a credencial pertence ao usuário
      const existing = await db.credential.findFirst({
        where: { id, userId },
      })

      if (!existing) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          message: 'Credencial não encontrada',
        })
      }

      const credential = await db.credential.update({
        where: { id },
        data: {
          ...req.body,
          customHeaders: req.body.customHeaders || null,
          successModel: req.body.successModel || null,
          data: req.body.data || null,
        },
      })

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: 'Credencial atualizada com sucesso',
        data: credential,
      })
    } catch (error) {
      req.log.error(error, 'Error updating credential')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao atualizar credencial',
      })
    }
  }

  // DELETE /credentials/:id - Deletar credencial
  static async delete(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { id } = req.params
      const userId = req.user!.id

      // Verificar se a credencial pertence ao usuário
      const existing = await db.credential.findFirst({
        where: { id, userId },
      })

      if (!existing) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          message: 'Credencial não encontrada',
        })
      }

      await db.credential.delete({
        where: { id },
      })

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: 'Credencial deletada com sucesso',
      })
    } catch (error) {
      req.log.error(error, 'Error deleting credential')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao deletar credencial',
      })
    }
  }

  // POST /credentials/:id/test - Testar credencial
  static async test(
    req: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
  ) {
    try {
      const { id } = req.params
      const userId = req.user!.id

      // Buscar a credencial
      const credential = await db.credential.findFirst({
        where: { id, userId },
      })

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          message: 'Credencial não encontrada',
        })
      }

      // Preparar headers
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      }

      // Adicionar header de autenticação se configurado
      if (credential.authHeaderKey && credential.authHeaderValue) {
        headers[credential.authHeaderKey] = credential.authHeaderValue
      }

      // Adicionar headers customizados
      if (credential.customHeaders) {
        Object.assign(headers, credential.customHeaders as Record<string, string>)
      }

      // Fazer a requisição
      try {
        const response = await axios({
          method: credential.method.toLowerCase() as any,
          url: credential.url,
          headers,
          data: credential.data,
          timeout: 30000, // 30 segundos
        })

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          data: {
            success: true,
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: response.headers,
          },
        })
      } catch (axiosError: any) {
        return sendSuccess(reply, {
          status: StatusCodes.OK,
          data: {
            success: false,
            status: axiosError.response?.status || 500,
            statusText: axiosError.response?.statusText || 'Request Failed',
            data: axiosError.response?.data || { message: axiosError.message },
            error: axiosError.message,
          },
        })
      }
    } catch (error) {
      req.log.error(error, 'Error testing credential')
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        message: 'Erro ao testar credencial',
      })
    }
  }
}
