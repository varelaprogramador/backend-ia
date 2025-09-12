import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const blockedContactSchema = z.object({
  userId: z.string(),
  remoteJid: z.string(),
  reason: z.string().optional(),
  blockedBy: z.string().optional(),
});

const updateBlockedContactSchema = blockedContactSchema
  .partial()
  .omit({ userId: true });

const querySchema = z.object({
  page: z
    .string()
    .transform((val) => parseInt(val))
    .default("1"),
  limit: z
    .string()
    .transform((val) => parseInt(val))
    .default("10"),
  userId: z.string().optional(),
  remoteJid: z.string().optional(),
  blockedBy: z.string().optional(),
  search: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET /blocked-contacts - List all blocked contacts with pagination and filters
  fastify.get(
    "/",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "List blocked contacts with pagination and filters",
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            userId: { type: "string" },
            remoteJid: { type: "string" },
            blockedBy: { type: "string" },
            search: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { page, limit, userId, remoteJid, blockedBy, search } =
          querySchema.parse(request.query);
        const offset = (page - 1) * limit;

        const where: any = {};

        if (userId) where.userId = userId;
        if (remoteJid)
          where.remoteJid = { contains: remoteJid, mode: "insensitive" };
        if (blockedBy)
          where.blockedBy = { contains: blockedBy, mode: "insensitive" };

        if (search) {
          where.OR = [
            { remoteJid: { contains: search, mode: "insensitive" } },
            { reason: { contains: search, mode: "insensitive" } },
            { blockedBy: { contains: search, mode: "insensitive" } },
          ];
        }

        const [blockedContacts, total] = await Promise.all([
          db.blockedContact.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { createdAt: "desc" },
            include: {
              user: {
                select: {
                  id: true,
                  firstName: true,
                  lastName: true,
                  username: true,
                  primaryEmailId: true,
                },
              },
            },
          }),
          db.blockedContact.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: blockedContacts,
          metadata: {
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
          },
        });
      } catch (error) {
        logError("Error listing blocked contacts", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /blocked-contacts/:id - Get blocked contact by ID
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Get blocked contact by ID",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };

        const blockedContact = await db.blockedContact.findUnique({
          where: { id },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                primaryEmailId: true,
              },
            },
          },
        });

        if (!blockedContact) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Contato bloqueado não encontrado",
            })
          );
        }

        return formatResponse({ data: blockedContact });
      } catch (error) {
        logError("Error getting blocked contact", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /blocked-contacts/user/:userId - Get blocked contacts by user ID
  fastify.get(
    "/user/:userId",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Get blocked contacts by user ID",
        params: {
          type: "object",
          properties: {
            userId: { type: "string" },
          },
          required: ["userId"],
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { userId } = request.params as { userId: string };
        const { page: pageStr, limit: limitStr } = request.query as any;
        const page = parseInt(pageStr) || 1;
        const limit = parseInt(limitStr) || 10;
        const offset = (page - 1) * limit;

        const [blockedContacts, total] = await Promise.all([
          db.blockedContact.findMany({
            where: { userId },
            skip: offset,
            take: limit,
            orderBy: { createdAt: "desc" },
          }),
          db.blockedContact.count({ where: { userId } }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: blockedContacts,
          metadata: {
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
            userId,
          },
        });
      } catch (error) {
        logError("Error getting blocked contacts by user", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /blocked-contacts - Create blocked contact
  fastify.post(
    "/",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Create a new blocked contact",
        body: {
          type: "object",
          properties: {
            userId: { type: "string" },
            remoteJid: { type: "string" },
            reason: { type: "string" },
            blockedBy: { type: "string" },
          },
          required: ["userId", "remoteJid"],
        },
      },
    },
    async (request, reply) => {
      try {
        const validatedData = blockedContactSchema.parse(request.body);

        // Check if user exists
        const user = await db.user.findUnique({
          where: { id: validatedData.userId },
        });

        if (!user) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Usuário não encontrado",
            })
          );
        }

        const blockedContact = await db.blockedContact.create({
          data: validatedData,
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                primaryEmailId: true,
              },
            },
          },
        });

        logInfo("Blocked contact created", {
          id: blockedContact.id,
          userId: blockedContact.userId,
          remoteJid: blockedContact.remoteJid,
        });

        return reply.code(201).send(
          formatResponse({
            data: blockedContact,
            message: "Contato bloqueado com sucesso",
          })
        );
      } catch (error: any) {
        if (error.code === "P2002") {
          return reply.code(409).send(
            formatResponse({
              success: false,
              message: "Este WhatsApp JID já está bloqueado",
            })
          );
        }

        logError("Error creating blocked contact", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PUT /blocked-contacts/:id - Update blocked contact
  fastify.put(
    "/:id",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Update blocked contact",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
        body: {
          type: "object",
          properties: {
            remoteJid: { type: "string" },
            reason: { type: "string" },
            blockedBy: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateBlockedContactSchema.parse(request.body);

        const blockedContact = await db.blockedContact.update({
          where: { id },
          data: validatedData,
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
                primaryEmailId: true,
              },
            },
          },
        });

        logInfo("Blocked contact updated", { id: blockedContact.id });

        return formatResponse({
          data: blockedContact,
          message: "Contato bloqueado atualizado com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Contato bloqueado não encontrado",
            })
          );
        }

        if (error.code === "P2002") {
          return reply.code(409).send(
            formatResponse({
              success: false,
              message: "Este WhatsApp JID já está bloqueado",
            })
          );
        }

        logError("Error updating blocked contact", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /blocked-contacts/:id - Delete blocked contact
  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Delete blocked contact",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
          },
          required: ["id"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };

        const blockedContact = await db.blockedContact.findUnique({
          where: { id },
          select: { remoteJid: true },
        });

        if (!blockedContact) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Contato bloqueado não encontrado",
            })
          );
        }

        await db.blockedContact.delete({
          where: { id },
        });

        logInfo("Blocked contact deleted", {
          id,
          remoteJid: blockedContact.remoteJid,
        });

        return formatResponse({
          message: "Contato desbloqueado com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Contato bloqueado não encontrado",
            })
          );
        }

        logError("Error deleting blocked contact", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /blocked-contacts/jid/:remoteJid - Delete blocked contact by JID
  fastify.delete(
    "/jid/:remoteJid",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Delete blocked contact by WhatsApp JID",
        params: {
          type: "object",
          properties: {
            remoteJid: { type: "string" },
          },
          required: ["remoteJid"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { remoteJid } = request.params as { remoteJid: string };

        const blockedContact = await db.blockedContact.findUnique({
          where: { remoteJid },
        });

        if (!blockedContact) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Contato bloqueado não encontrado",
            })
          );
        }

        await db.blockedContact.delete({
          where: { remoteJid },
        });

        logInfo("Blocked contact deleted by JID", { remoteJid });

        return formatResponse({
          message: "Contato desbloqueado com sucesso",
        });
      } catch (error) {
        logError("Error deleting blocked contact by JID", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /blocked-contacts/check/:remoteJid - Check if a JID is blocked
  fastify.get(
    "/check/:remoteJid",
    {
      schema: {
        tags: ["Blocked Contacts"],
        description: "Check if a WhatsApp JID is blocked",
        params: {
          type: "object",
          properties: {
            remoteJid: { type: "string" },
          },
          required: ["remoteJid"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { remoteJid } = request.params as { remoteJid: string };

        const blockedContact = await db.blockedContact.findUnique({
          where: { remoteJid },
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                username: true,
              },
            },
          },
        });

        return formatResponse({
          data: {
            blocked: !!blockedContact,
            contact: blockedContact || null,
          },
        });
      } catch (error) {
        logError("Error checking blocked contact", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );
}
