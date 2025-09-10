import { WebhookEvent } from '@clerk/fastify'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { StatusCodes } from 'http-status-codes'
import { Webhook } from 'svix'

import { db } from '@/lib/db'
import { logError, logInfo } from '@/utils/logger'

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
      // Create user in database using Prisma
      await db.user.create({
        data: {
          id: data.id,
          firstName: data.first_name || null,
          lastName: data.last_name || null,
          imageUrl: data.image_url || null,
          hasImage: data.has_image || false,
          primaryEmailId: data.primary_email_address_id || null,
          emailAddresses: data.email_addresses || null,
          phoneNumbers: data.phone_numbers || null,
          externalAccounts: data.external_accounts || null,
          publicMetadata: data.public_metadata || null,
          privateMetadata: data.private_metadata || null,
          unsafeMetadata: data.unsafe_metadata || null,
          username: data.username || null,
          passwordEnabled: data.password_enabled || false,
          totpEnabled: data.totp_enabled || false,
          backupCodeEnabled: data.backup_code_enabled || false,
          twoFactorEnabled: data.two_factor_enabled || false,
          banned: data.banned || false,
          locked: data.locked || false,
          lastSignInAt: data.last_sign_in_at ? new Date(data.last_sign_in_at) : null,
          lastActiveAt: data.last_active_at ? new Date(data.last_active_at) : null,
        },
      })
      logInfo(`User ${data.id} created in database`)
    }
  } catch (error) {
    logError('Failed to create user in database:', error)
  }
}

const handleUserUpdated = async (data: any, _reply: FastifyReply) => {
  try {
    if (data.id) {
      // Update user in database using Prisma
      await db.user.update({
        where: { id: data.id },
        data: {
          firstName: data.first_name || null,
          lastName: data.last_name || null,
          imageUrl: data.image_url || null,
          hasImage: data.has_image || false,
          primaryEmailId: data.primary_email_address_id || null,
          emailAddresses: data.email_addresses || null,
          phoneNumbers: data.phone_numbers || null,
          externalAccounts: data.external_accounts || null,
          publicMetadata: data.public_metadata || null,
          privateMetadata: data.private_metadata || null,
          unsafeMetadata: data.unsafe_metadata || null,
          username: data.username || null,
          passwordEnabled: data.password_enabled || false,
          totpEnabled: data.totp_enabled || false,
          backupCodeEnabled: data.backup_code_enabled || false,
          twoFactorEnabled: data.two_factor_enabled || false,
          banned: data.banned || false,
          locked: data.locked || false,
          lastSignInAt: data.last_sign_in_at ? new Date(data.last_sign_in_at) : null,
          lastActiveAt: data.last_active_at ? new Date(data.last_active_at) : null,
        },
      })
      logInfo(`User ${data.id} updated in database`)
    }
  } catch (error) {
    logError('Failed to update user in database:', error)
  }
}

const handleUserDeleted = async (id: string, _reply: FastifyReply) => {
  try {
    // Delete user from database using Prisma
    await db.user.delete({
      where: { id },
    })
    
    logInfo(`User ${id} deleted from database`)
  } catch (error) {
    logError('Failed to delete user from database:', error)
  }
}
