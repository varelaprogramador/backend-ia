import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const credenciaisEvoSchema = z.object({
  userId: z.string(),
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
});

const updateCredenciaisEvoSchema = credenciaisEvoSchema
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
  search: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET /credenciais-evo - List all Evolution API credentials with pagination and filters
  fastify.get(
    "/",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description:
          "List Evolution API credentials with pagination and filters",
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            userId: { type: "string" },
            search: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { page, limit, userId, search } = querySchema.parse(
          request.query
        );
        const offset = (page - 1) * limit;

        const where: any = {};

        if (userId) where.userId = userId;

        if (search) {
          where.OR = [
            { baseUrl: { contains: search, mode: "insensitive" } },
            {
              user: {
                OR: [
                  { firstName: { contains: search, mode: "insensitive" } },
                  { lastName: { contains: search, mode: "insensitive" } },
                  { username: { contains: search, mode: "insensitive" } },
                  { primaryEmailId: { contains: search, mode: "insensitive" } },
                ],
              },
            },
          ];
        }

        const [credentials, total] = await Promise.all([
          db.credenciaisEvo.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { createdAt: "desc" },
            select: {
              id: true,
              userId: true,
              baseUrl: true,
              apiKey: false, // Não expor a chave da API na listagem
              createdAt: true,
              updatedAt: true,
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
          db.credenciaisEvo.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: credentials,
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
        logError("Error listing Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /credenciais-evo/:id - Get Evolution API credentials by ID
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Get Evolution API credentials by ID",
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

        const credential = await db.credenciaisEvo.findUnique({
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

        if (!credential) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        // Mask API key for security - show only first and last 4 characters
        const maskedCredential = {
          ...credential,
          apiKey:
            credential.apiKey.length > 8
              ? `${credential.apiKey.slice(0, 4)}****${credential.apiKey.slice(-4)}`
              : "****",
        };

        return formatResponse({ data: maskedCredential });
      } catch (error) {
        logError("Error getting Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /credenciais-evo/user/:userId - Get Evolution API credentials by user ID
  fastify.get(
    "/user/:userId",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Get Evolution API credentials by user ID",
        params: {
          type: "object",
          properties: {
            userId: { type: "string" },
          },
          required: ["userId"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { userId } = request.params as { userId: string };

        const credentials = await db.credenciaisEvo.findMany({
          where: { userId },
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            userId: true,
            baseUrl: true,
            apiKey: false, // Don't expose API key
            createdAt: true,
            updatedAt: true,
          },
        });

        return formatResponse({
          data: credentials,
          metadata: { userId, count: credentials.length },
        });
      } catch (error) {
        logError(
          "Error getting Evolution API credentials by user",
          error as Error
        );
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /credenciais-evo - Create Evolution API credentials
  fastify.post(
    "/",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Create new Evolution API credentials",
        body: {
          type: "object",
          properties: {
            userId: { type: "string" },
            baseUrl: { type: "string", format: "uri" },
            apiKey: { type: "string", minLength: 1 },
          },
          required: ["userId", "baseUrl", "apiKey"],
        },
      },
    },
    async (request, reply) => {
      try {
        const validatedData = credenciaisEvoSchema.parse(request.body);

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

        const credential = await db.credenciaisEvo.create({
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

        // Mask API key in response
        const responseData = {
          ...credential,
          apiKey:
            credential.apiKey.length > 8
              ? `${credential.apiKey.slice(0, 4)}****${credential.apiKey.slice(-4)}`
              : "****",
        };

        logInfo("Evolution API credentials created", {
          id: credential.id,
          userId: credential.userId,
          baseUrl: credential.baseUrl,
        });

        return reply.code(201).send(
          formatResponse({
            data: responseData,
            message: "Credenciais da Evolution API criadas com sucesso",
          })
        );
      } catch (error: any) {
        if (error.code === "P2002") {
          return reply.code(409).send(
            formatResponse({
              success: false,
              message: "Já existem credenciais para este usuário e URL base",
            })
          );
        }

        logError("Error creating Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PUT /credenciais-evo/:id - Update Evolution API credentials
  fastify.put(
    "/:id",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Update Evolution API credentials",
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
            baseUrl: { type: "string", format: "uri" },
            apiKey: { type: "string", minLength: 1 },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateCredenciaisEvoSchema.parse(request.body);

        const credential = await db.credenciaisEvo.update({
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

        // Mask API key in response
        const responseData = {
          ...credential,
          apiKey:
            credential.apiKey.length > 8
              ? `${credential.apiKey.slice(0, 4)}****${credential.apiKey.slice(-4)}`
              : "****",
        };

        logInfo("Evolution API credentials updated", { id: credential.id });

        return formatResponse({
          data: responseData,
          message: "Credenciais da Evolution API atualizadas com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        logError("Error updating Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /credenciais-evo/:id - Delete Evolution API credentials
  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Delete Evolution API credentials",
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

        const credential = await db.credenciaisEvo.findUnique({
          where: { id },
          select: { baseUrl: true, userId: true },
        });

        if (!credential) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        await db.credenciaisEvo.delete({
          where: { id },
        });

        logInfo("Evolution API credentials deleted", {
          id,
          userId: credential.userId,
          baseUrl: credential.baseUrl,
        });

        return formatResponse({
          message: "Credenciais da Evolution API excluídas com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        logError("Error deleting Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /credenciais-evo/:id/raw - Get raw API key (for internal use only)
  fastify.get(
    "/:id/raw",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Get raw Evolution API credentials (internal use only)",
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

        const credential = await db.credenciaisEvo.findUnique({
          where: { id },
          select: {
            id: true,
            userId: true,
            baseUrl: true,
            apiKey: true,
            createdAt: true,
            updatedAt: true,
          },
        });

        if (!credential) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        logInfo("Evolution API raw credentials accessed", {
          id: credential.id,
          userId: credential.userId,
          baseUrl: credential.baseUrl,
          requestIp: request.ip,
        });

        return formatResponse({ data: credential });
      } catch (error) {
        logError("Error getting raw Evolution API credentials", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /credenciais-evo/:id/test - Test Evolution API credentials
  fastify.post(
    "/:id/test",
    {
      schema: {
        tags: ["Credenciais Evolution API"],
        description: "Test Evolution API credentials connectivity",
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

        const credential = await db.credenciaisEvo.findUnique({
          where: { id },
          select: {
            id: true,
            baseUrl: true,
            apiKey: true,
          },
        });

        if (!credential) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Credenciais não encontradas",
            })
          );
        }

        // Here you would implement the actual API test
        // For now, we'll just return a success response
        // TODO: Implement actual Evolution API connectivity test

        logInfo("Evolution API credentials test requested", {
          id: credential.id,
          baseUrl: credential.baseUrl,
        });

        return formatResponse({
          data: {
            tested: true,
            baseUrl: credential.baseUrl,
            status: "pending", // Would be "success" or "error" after actual test
            message: "Teste de conectividade não implementado ainda",
          },
          message: "Teste de credenciais solicitado",
        });
      } catch (error) {
        logError("Error testing Evolution API credentials", error as Error);
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
