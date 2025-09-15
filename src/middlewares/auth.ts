import { getAuth } from '@clerk/fastify'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'

import { sendError } from '@/utils/response-formatter.js'
import { getUser } from '@/utils/user'

// Definir um tipo para o resultado de getUser
type UserType = NonNullable<Awaited<ReturnType<typeof getUser>>>

// Estender a interface do FastifyRequest para incluir o usuário (pode ser undefined para usuários anônimos)
declare module 'fastify' {
  interface FastifyRequest {
    user?: UserType
    workspaceId?: string
  }
}

declare global {
  interface UserPublicMetadata {
    role: string;
  }
}

type AuthOptions = {}

/**
 * Middleware de autenticação que verifica o usuário e opcionalmente as compras
 */
export const authMiddleware =
  (options?: AuthOptions) =>
  async (req: FastifyRequest, reply: FastifyReply) => {
    const { userId } = getAuth(req)

    if (!userId) {
      return sendError(reply, {
        error: 'Unauthorized',
        status: StatusCodes.UNAUTHORIZED,
      })
    }

    const user = await getUser(userId)

    if (!user) {
      return sendError(reply, {
        error: 'Unauthorized',
        status: StatusCodes.UNAUTHORIZED,
      })
    }

    req.user = user
    return
  }
