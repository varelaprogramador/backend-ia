import { WebhookEvent } from '@clerk/fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Webhook } from 'svix'

import { redis } from '@/lib/redis'
import { logError, logInfo } from '@/utils/logger'

const USERS_CACHE_KEY = 'users:list'
const EMAIL_INDEX_KEY = 'users:email_index'

enum UserEventType {
  Created = 'user.created',
  Updated = 'user.updated',
  Deleted = 'user.deleted',
}

export default async function (app: FastifyInstance) {
  app.post('/users', async (req, reply) => {
    try {
      const event = await verifyWebhook(req)

      switch (event.type) {
        case UserEventType.Created:
          await handleUserCreated(event.data, reply)
          break

        case UserEventType.Updated:
          await handleUserUpdated(event.data, reply)
          break

        case UserEventType.Deleted:
          if (event.data.id) {
            await handleUserDeleted(event.data.id, reply)
          } else {
            return reply
              .status(StatusCodes.BAD_REQUEST)
              .send({ error: 'User ID is missing' })
          }
          break

        default:
          return reply
            .status(StatusCodes.BAD_REQUEST)
            .send({ error: 'Invalid event type' })
      }

      return reply.send({ message: 'Webhook processed successfully' })
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : 'Internal Server Error'

      return reply
        .status(StatusCodes.INTERNAL_SERVER_ERROR)
        .send({ message: errorMessage })
    }
  })
}

const verifyWebhook = async (req: FastifyRequest): Promise<WebhookEvent> => {
  const wh = new Webhook(process.env.CLERK_WEBHOOK_USER_SECRET)
  const { headers, body } = req

  const svix_id = headers['svix-id'] as string
  const svix_timestamp = headers['svix-timestamp'] as string
  const svix_signature = headers['svix-signature'] as string

  if (!svix_id || !svix_timestamp || !svix_signature) {
    throw new Error('Missing svix headers')
  }

  return wh.verify(JSON.stringify(body), {
    'svix-id': svix_id,
    'svix-timestamp': svix_timestamp,
    'svix-signature': svix_signature,
  }) as WebhookEvent
}

const handleUserCreated = async (data: any, _reply: FastifyReply) => {
  try {
    if (data.id) {
      // OTIMIZAÇÃO: Usa pipeline para operações batch
      const pipeline = redis.pipeline()
      pipeline.hset(USERS_CACHE_KEY, data.id, JSON.stringify(data))
      
      // Adiciona ao índice de emails
      if (data.emailAddresses) {
        for (const emailAddr of data.emailAddresses) {
          pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), data.id)
        }
      }
      
      await pipeline.exec()
      logInfo(`User ${data.id} added to cache with email index`)
    }
  } catch (error) {
    logError('Failed to add user to cache:', error)
  }
}

const handleUserUpdated = async (data: any, _reply: FastifyReply) => {
  try {
    if (data.id) {
      // OTIMIZAÇÃO: Atualiza cache e índice de email
      const pipeline = redis.pipeline()
      pipeline.hset(USERS_CACHE_KEY, data.id, JSON.stringify(data))
      
      // Para updates, precisamos limpar emails antigos primeiro
      // Busca dados antigos para remover do índice
      const oldUserData = await redis.hget(USERS_CACHE_KEY, data.id)
      if (oldUserData) {
        const oldUser = JSON.parse(oldUserData)
        if (oldUser.emailAddresses) {
          for (const emailAddr of oldUser.emailAddresses) {
            pipeline.hdel(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase())
          }
        }
      }
      
      // Adiciona novos emails ao índice
      if (data.emailAddresses) {
        for (const emailAddr of data.emailAddresses) {
          pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), data.id)
        }
      }
      
      await pipeline.exec()
      logInfo(`User ${data.id} updated in cache with email index`)
    }
  } catch (error) {
    logError('Failed to update user in cache:', error)
  }
}

const handleUserDeleted = async (id: string, _reply: FastifyReply) => {
  try {
    // OTIMIZAÇÃO: Remove do cache e índice de email
    const pipeline = redis.pipeline()
    
    // Busca dados do usuário antes de deletar para remover do índice
    const userData = await redis.hget(USERS_CACHE_KEY, id)
    if (userData) {
      const user = JSON.parse(userData)
      if (user.emailAddresses) {
        for (const emailAddr of user.emailAddresses) {
          pipeline.hdel(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase())
        }
      }
    }
    
    pipeline.hdel(USERS_CACHE_KEY, id)
    await pipeline.exec()
    
    logInfo(`User ${id} removed from cache and email index`)
  } catch (error) {
    logError('Failed to remove user from cache:', error)
  }
}
