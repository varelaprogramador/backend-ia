import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const configIASchema = z.object({
  userId: z.string(),
  nome: z.string().min(1),
  prompt: z.string().min(1),
  status: z.string().optional(),
  webhookUrlProd: z.string().url().optional().or(z.literal("")),
  webhookUrlDev: z.string().url().optional().or(z.literal("")),
});

const updateConfigIASchema = configIASchema.partial().omit({ userId: true });

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
  status: z.string().optional(),
  search: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET /config-ia - List all AI configurations with pagination and filters
  fastify.get(
    "/",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "List AI configurations with pagination and filters",
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            userId: { type: "string" },
            status: { type: "string" },
            search: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { page, limit, userId, status, search } = querySchema.parse(
          request.query
        );
        const offset = (page - 1) * limit;

        const where: any = {};

        if (userId) where.userId = userId;
        if (status) where.status = status;

        if (search) {
          where.OR = [
            { nome: { contains: search, mode: "insensitive" } },
            { prompt: { contains: search, mode: "insensitive" } },
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

        const [configs, total] = await Promise.all([
          db.configIA.findMany({
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
              evolutionInstances: {
                select: {
                  id: true,
                  instanceName: true,
                  displayName: true,
                  connectionState: true,
                  status: true,
                },
              },
            },
          }),
          db.configIA.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: configs,
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
        logError("Error listing AI configurations", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /config-ia/:id - Get AI configuration by ID
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Get AI configuration by ID",
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

        const config = await db.configIA.findUnique({
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
            evolutionInstances: {
              select: {
                id: true,
                instanceName: true,
                displayName: true,
                connectionState: true,
                status: true,
              },
            },
          },
        });

        if (!config) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        return formatResponse({ data: config });
      } catch (error) {
        logError("Error getting AI configuration", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /config-ia/user/:userId - Get AI configurations by user ID
  fastify.get(
    "/user/:userId",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Get AI configurations by user ID",
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
            status: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { userId } = request.params as { userId: string };

        const configs = await db.configIA.findMany({
          where: { userId: userId },
          orderBy: { createdAt: "desc" },
        });

        return formatResponse({
          data: configs,
          metadata: { userId, count: configs.length },
        });
      } catch (error) {
        logError("Error getting AI configurations by user", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /config-ia - Create AI configuration
  fastify.post(
    "/",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Create new AI configuration",
        body: {
          type: "object",
          properties: {
            userId: { type: "string" },
            nome: { type: "string", minLength: 1 },
            prompt: { type: "string", minLength: 1 },
            status: { type: "string" },
            webhookUrlProd: { type: "string" },
            webhookUrlDev: { type: "string" },
          },
          required: ["userId", "nome", "prompt"],
        },
      },
    },
    async (request, reply) => {
      try {
        const body = request.body as any;
        const validatedData = configIASchema.parse(body);

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

        // Convert empty strings to null for URL fields
        const dataToCreate = {
          ...validatedData,
          webhookUrlProd: validatedData.webhookUrlProd || null,
          webhookUrlDev: validatedData.webhookUrlDev || null,
        };

        const config = await db.configIA.create({
          data: dataToCreate,
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

        logInfo("AI configuration created", {
          id: config.id,
          userId: config.userId,
          nome: config.nome,
        });

        return reply.code(201).send(
          formatResponse({
            data: config,
            message: "Configuração de IA criada com sucesso",
          })
        );
      } catch (error: any) {
        logError("Error creating AI configuration", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PUT /config-ia/:id - Update AI configuration
  fastify.put(
    "/:id",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Update AI configuration",
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
            nome: { type: "string", minLength: 1 },
            prompt: { type: "string", minLength: 1 },
            status: { type: "string" },
            webhookUrlProd: { type: "string" },
            webhookUrlDev: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateConfigIASchema.parse(request.body);

        // Convert empty strings to null for URL fields
        const dataToUpdate: any = { ...validatedData };
        if ("webhookUrlProd" in dataToUpdate) {
          dataToUpdate.webhookUrlProd = dataToUpdate.webhookUrlProd || null;
        }
        if ("webhookUrlDev" in dataToUpdate) {
          dataToUpdate.webhookUrlDev = dataToUpdate.webhookUrlDev || null;
        }

        const config = await db.configIA.update({
          where: { id },
          data: dataToUpdate,
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

        logInfo("AI configuration updated", {
          id: config.id,
          nome: config.nome,
        });

        return formatResponse({
          data: config,
          message: "Configuração de IA atualizada com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        logError("Error updating AI configuration", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /config-ia/:id - Delete AI configuration
  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Delete AI configuration",
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

        const config = await db.configIA.findUnique({
          where: { id },
          select: { nome: true, userId: true },
        });

        if (!config) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        await db.configIA.delete({
          where: { id },
        });

        logInfo("AI configuration deleted", {
          id,
          userId: config.userId,
          nome: config.nome,
        });

        return formatResponse({
          message: "Configuração de IA excluída com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        logError("Error deleting AI configuration", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PATCH /config-ia/:id/status - Update AI configuration status
  fastify.patch(
    "/:id/status",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Update AI configuration status",
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
            status: { type: "string" },
          },
          required: ["status"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { status } = request.body as { status: string };

        const config = await db.configIA.update({
          where: { id },
          data: { status },
          select: {
            id: true,
            nome: true,
            status: true,
            userId: true,
          },
        });

        logInfo("AI configuration status updated", {
          id: config.id,
          nome: config.nome,
          status: config.status,
        });

        return formatResponse({
          data: config,
          message: "Status da configuração de IA atualizado com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        logError("Error updating AI configuration status", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /config-ia/active/user/:userId - Get active AI configurations by user ID
  fastify.get(
    "/active/user/:userId",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Get active AI configurations by user ID",
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

        const configs = await db.configIA.findMany({
          where: {
            userId,
            status: "ativo", // Assuming "ativo" is the active status
          },
          orderBy: { createdAt: "desc" },
        });

        return formatResponse({
          data: configs,
          metadata: { userId, count: configs.length },
        });
      } catch (error) {
        logError(
          "Error getting active AI configurations by user",
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

  // POST /config-ia/:id/clone - Clone AI configuration
  fastify.post(
    "/:id/clone",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Clone AI configuration",
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
            nome: { type: "string", minLength: 1 },
          },
          required: ["nome"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { nome } = request.body as { nome: string };

        const originalConfig = await db.configIA.findUnique({
          where: { id },
        });

        if (!originalConfig) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        const clonedConfig = await db.configIA.create({
          data: {
            userId: originalConfig.userId,
            nome,
            prompt: originalConfig.prompt,
            status: "inativo", // Clone starts as inactive
            webhookUrlProd: originalConfig.webhookUrlProd,
            webhookUrlDev: originalConfig.webhookUrlDev,
          },
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

        logInfo("AI configuration cloned", {
          originalId: id,
          clonedId: clonedConfig.id,
          nome: clonedConfig.nome,
        });

        return reply.code(201).send(
          formatResponse({
            data: clonedConfig,
            message: "Configuração de IA clonada com sucesso",
          })
        );
      } catch (error) {
        logError("Error cloning AI configuration", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /config-ia/:id/available-instances - Get available instances for assignment
  fastify.get(
    "/:id/available-instances",
    {
      schema: {
        tags: ["Configurações IA"],
        description:
          "Get available Evolution instances for assignment to ConfigIA",
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

        // Verificar se a ConfigIA existe
        const configIA = await db.configIA.findUnique({
          where: { id },
          select: { userId: true },
        });

        if (!configIA) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        // Buscar instâncias do mesmo usuário que não estão atribuídas a nenhuma ConfigIA
        const availableInstances = await db.evolutionInstance.findMany({
          where: {
            userId: configIA.userId,
            configIAId: null, // Instâncias não atribuídas
            status: "active", // Apenas instâncias ativas
          },
          select: {
            id: true,
            instanceName: true,
            displayName: true,
            connectionState: true,
            status: true,
          },
          orderBy: { instanceName: "asc" },
        });

        return formatResponse({
          data: availableInstances,
          metadata: { configIAId: id, count: availableInstances.length },
        });
      } catch (error) {
        logError("Error getting available instances", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /config-ia/:id/assign-instances - Assign instances to ConfigIA
  fastify.post(
    "/:id/assign-instances",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Assign Evolution instances to ConfigIA",
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
            instanceIds: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["instanceIds"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { instanceIds } = request.body as { instanceIds: string[] };

        // Logs para debug
        console.log("🔍 [ASSIGN-INSTANCES] Request data:", {
          configIAId: id,
          instanceIds,
          bodyType: typeof request.body,
          bodyContent: JSON.stringify(request.body)
        });

        // Validar dados de entrada
        if (!id || typeof id !== 'string') {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "ID da configuração de IA é obrigatório",
            })
          );
        }

        if (!instanceIds || !Array.isArray(instanceIds) || instanceIds.length === 0) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "Lista de IDs de instâncias é obrigatória e não pode estar vazia",
            })
          );
        }

        // Verificar se a ConfigIA existe
        const configIA = await db.configIA.findUnique({
          where: { id },
          select: { userId: true, nome: true },
        });

        if (!configIA) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        // Verificar se todas as instâncias pertencem ao mesmo usuário e estão disponíveis
        const instances = await db.evolutionInstance.findMany({
          where: {
            id: { in: instanceIds },
            userId: configIA.userId,
            status: "active",
          },
          select: {
            id: true,
            instanceName: true,
            configIAId: true,
          },
        });

        // Verificar se todas as instâncias foram encontradas
        if (instances.length !== instanceIds.length) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message:
                "Algumas instâncias não foram encontradas ou não pertencem ao usuário",
            })
          );
        }

        // Verificar se alguma instância já está atribuída
        const alreadyAssigned = instances.filter(
          (instance) => instance.configIAId !== null
        );
        if (alreadyAssigned.length > 0) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: `Instâncias já atribuídas: ${alreadyAssigned.map((i) => i.instanceName).join(", ")}`,
            })
          );
        }

        // Atribuir instâncias à ConfigIA
        await db.evolutionInstance.updateMany({
          where: {
            id: { in: instanceIds },
          },
          data: {
            configIAId: id,
          },
        });

        // Buscar as instâncias atualizadas
        const updatedInstances = await db.evolutionInstance.findMany({
          where: {
            id: { in: instanceIds },
          },
          select: {
            id: true,
            instanceName: true,
            displayName: true,
            connectionState: true,
            status: true,
          },
        });

        logInfo("Instances assigned to ConfigIA", {
          configIAId: id,
          configIAName: configIA.nome,
          instanceIds,
          instanceNames: updatedInstances.map((i) => i.instanceName),
        });

        return formatResponse({
          data: updatedInstances,
          message: `${instanceIds.length} instâncias atribuídas com sucesso`,
        });
      } catch (error) {
        console.error("💥 [ASSIGN-INSTANCES] Error details:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          configIAId: request.params,
          requestBody: request.body
        });

        logError("Error assigning instances to ConfigIA", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
            error: error instanceof Error ? error.message : "Erro desconhecido",
          })
        );
      }
    }
  );

  // DELETE /config-ia/:id/unassign-instance/:instanceId - Unassign instance from ConfigIA
  fastify.delete(
    "/:id/unassign-instance/:instanceId",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Unassign Evolution instance from ConfigIA",
        params: {
          type: "object",
          properties: {
            id: { type: "string" },
            instanceId: { type: "string" },
          },
          required: ["id", "instanceId"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id, instanceId } = request.params as {
          id: string;
          instanceId: string;
        };

        // Verificar se a ConfigIA existe
        const configIA = await db.configIA.findUnique({
          where: { id },
          select: { userId: true, nome: true },
        });

        if (!configIA) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        // Verificar se a instância pertence à ConfigIA
        const instance = await db.evolutionInstance.findFirst({
          where: {
            id: instanceId,
            configIAId: id,
            userId: configIA.userId,
          },
          select: {
            id: true,
            instanceName: true,
          },
        });

        if (!instance) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message:
                "Instância não encontrada ou não pertence a esta configuração",
            })
          );
        }

        // Desatribuir instância
        await db.evolutionInstance.update({
          where: { id: instanceId },
          data: { configIAId: null },
        });

        logInfo("Instance unassigned from ConfigIA", {
          configIAId: id,
          configIAName: configIA.nome,
          instanceId,
          instanceName: instance.instanceName,
        });

        return formatResponse({
          message: `Instância ${instance.instanceName} desatribuída com sucesso`,
        });
      } catch (error) {
        logError("Error unassigning instance from ConfigIA", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /config-ia/:id/unassign-instances - Unassign multiple instances from ConfigIA
  fastify.post(
    "/:id/unassign-instances",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Unassign multiple Evolution instances from ConfigIA",
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
            instanceIds: {
              type: "array",
              items: { type: "string" },
            },
          },
          required: ["instanceIds"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const { instanceIds } = request.body as { instanceIds: string[] };

        // Logs para debug
        console.log("🔍 [UNASSIGN-INSTANCES] Request data:", {
          configIAId: id,
          instanceIds,
          bodyType: typeof request.body,
          bodyContent: JSON.stringify(request.body)
        });

        // Validar dados de entrada
        if (!id || typeof id !== 'string') {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "ID da configuração de IA é obrigatório",
            })
          );
        }

        if (!instanceIds || !Array.isArray(instanceIds) || instanceIds.length === 0) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "Lista de IDs de instâncias é obrigatória e não pode estar vazia",
            })
          );
        }

        // Verificar se a ConfigIA existe
        const configIA = await db.configIA.findUnique({
          where: { id },
          select: { userId: true, nome: true },
        });

        if (!configIA) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        // Verificar se as instâncias pertencem à ConfigIA
        const instances = await db.evolutionInstance.findMany({
          where: {
            id: { in: instanceIds },
            configIAId: id,
            userId: configIA.userId,
          },
          select: {
            id: true,
            instanceName: true,
          },
        });

        if (instances.length === 0) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Nenhuma instância encontrada para desatribuir",
            })
          );
        }

        // Desatribuir instâncias
        await db.evolutionInstance.updateMany({
          where: {
            id: { in: instances.map((i) => i.id) },
          },
          data: {
            configIAId: null,
          },
        });

        logInfo("Multiple instances unassigned from ConfigIA", {
          configIAId: id,
          configIAName: configIA.nome,
          instanceCount: instances.length,
          instanceNames: instances.map((i) => i.instanceName),
        });

        return formatResponse({
          message: `${instances.length} instâncias desatribuídas com sucesso`,
          data: instances,
        });
      } catch (error) {
        console.error("💥 [UNASSIGN-INSTANCES] Error details:", {
          error: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
          configIAId: request.params,
          requestBody: request.body
        });

        logError(
          "Error unassigning multiple instances from ConfigIA",
          error as Error
        );
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
            error: error instanceof Error ? error.message : "Erro desconhecido",
          })
        );
      }
    }
  );
}
