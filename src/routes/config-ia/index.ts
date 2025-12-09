import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";
import {
  loadN8NWorkflowTemplate,
  replaceN8NCredentialIds,
  validateN8NCredentials,
} from "@/utils/replace-n8n-credential-ids";

const configIASchema = z.object({
  userId: z.string(),
  nome: z.string().min(1),
  prompt: z.string().min(1),
  status: z.string().optional(),
  webhookUrlProd: z.string().url().optional().or(z.literal("")),
  webhookUrlDev: z.string().url().optional().or(z.literal("")),
  // Campos de integração com Kommo
  kommoSubdomain: z.string().optional().or(z.literal("")),
  kommoAccessToken: z.string().optional().or(z.literal("")),
  kommodPipelineId: z.string().optional().or(z.literal("")),
  // Campos de integração com RD Station
  rdstationClientId: z.string().optional().or(z.literal("")),
  rdstationClientSecret: z.string().optional().or(z.literal("")),
  rdstationAccessToken: z.string().optional().or(z.literal("")),
  rdstationRefreshToken: z.string().optional().or(z.literal("")),
  rdstationCode: z.string().optional().or(z.literal("")),
  // Credenciais vinculadas
  credentialIds: z.array(z.string()).optional().default([]),
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
          include: {
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
          orderBy: { createdAt: "desc" },
        });

        // Calcular métricas para cada config
        const configsWithMetrics = await Promise.all(
          configs.map(async (config) => {
            // Pegar instanceNames vinculados a este config
            const instanceNames = config.evolutionInstances.map(
              (i) => i.instanceName
            );

            // Contar mensagens do n8nChatMemory
            const n8nMessageCount =
              instanceNames.length > 0
                ? await db.n8nChatMemory.count({
                    where: {
                      instanceName: { in: instanceNames },
                    },
                  })
                : 0;

            // Contar mensagens do MyMessages
            const myMessageCount =
              instanceNames.length > 0
                ? await db.myMessages.count({
                    where: {
                      instanceName: { in: instanceNames },
                    },
                  })
                : 0;

            // Total de mensagens
            const totalMessages = n8nMessageCount + myMessageCount;

            return {
              ...config,
              totalMessages,
              confirmedAppointments: 0, // Será implementado posteriormente
            };
          })
        );

        return formatResponse({
          data: configsWithMetrics,
          metadata: { userId, count: configsWithMetrics.length },
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

  // POST /config-ia/create-with-n8n - Create AI configuration with N8N integration first
  fastify.post(
    "/create-with-n8n",
    {
      schema: {
        tags: ["Configurações IA"],
        description:
          "Create workspace in N8N first, then create in database if successful",
        body: {
          type: "object",
          properties: {
            userId: { type: "string" },
            nome: { type: "string", minLength: 1 },
            prompt: { type: "string", minLength: 1 },
            status: { type: "string" },
            webhookUrlProd: { type: "string" },
            webhookUrlDev: { type: "string" },
            kommoSubdomain: { type: "string" },
            kommoAccessToken: { type: "string" },
            kommodPipelineId: { type: "string" },
            credentialIds: { type: "array", items: { type: "string" } },
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
          select: {
            id: true,
            firstName: true,
            lastName: true,
            username: true,
          },
        });

        if (!user) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Usuário não encontrado",
            })
          );
        }

        // Buscar as credenciais vinculadas
        const credentials =
          validatedData.credentialIds && validatedData.credentialIds.length > 0
            ? await db.credential.findMany({
                where: {
                  id: { in: validatedData.credentialIds },
                },
                select: {
                  id: true,
                  id_n8n: true,
                  name: true,
                  type: true,
                  url: true,
                  method: true,
                  authHeaderKey: true,
                  authHeaderValue: true,
                  customHeaders: true,
                  data: true,
                },
              })
            : [];

        // Carregar template do workflow N8N
        const workflowTemplate = loadN8NWorkflowTemplate(request.log);

        // Validar se todas as credenciais necessárias possuem id_n8n
        const validation = validateN8NCredentials(
          workflowTemplate,
          credentials,
          request.log
        );

        if (!validation.valid) {
          logError(
            "Missing N8N credential IDs",
            new Error(
              `Credenciais sem id_n8n: ${validation.missing.join(", ")}`
            )
          );
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "Algumas credenciais não possuem ID do N8N",
              error: `Tipos faltando: ${validation.missing.join(", ")}`,
            })
          );
        }

        // Substituir os IDs das credenciais no template e gerar URLs de webhook
        // Usar o ID do Clerk para garantir unicidade nos webhooks
        const clerkId = user.id;
        const { workflow, webhookUrlDev, webhookUrlProd, webhookPath } = replaceN8NCredentialIds(
          workflowTemplate,
          credentials,
          validatedData.nome,
          clerkId,
          request.log
        );

        // Log das URLs de webhook geradas
        console.log("=== WEBHOOK URLs GERADAS ===");
        console.log("Webhook Dev:", webhookUrlDev);
        console.log("Webhook Prod:", webhookUrlProd);
        console.log("Webhook Path:", webhookPath);
        console.log("============================");

        // Preparar dados para enviar ao N8N
        const workspaceDataForN8N = {
          workspaceName: validatedData.nome,
          workflow, // Template do workflow com IDs substituídos
          prompt: validatedData.prompt,
          status: validatedData.status || "development",
          webhookUrlDev, // URL gerada automaticamente
          webhookUrlProd, // URL gerada automaticamente
          webhookPath, // Path do webhook para referência
          user: {
            id: user.id,
            name:
              `${user.firstName || ""} ${user.lastName || ""}`.trim() ||
              user.username ||
              "Usuário",
            clerkId,
          },
          credentials: credentials.map((cred) => ({
            id: cred.id,
            id_n8n: cred.id_n8n, // ID da credencial no N8N
            name: cred.name,
            type: cred.type,
            url: cred.url,
            method: cred.method,
            authHeaderKey: cred.authHeaderKey,
            authHeaderValue: cred.authHeaderValue,
            customHeaders: cred.customHeaders,
            data: cred.data,
          })),
          kommo:
            validatedData.kommoSubdomain && validatedData.kommoAccessToken
              ? {
                  enabled: true,
                  subdomain: validatedData.kommoSubdomain,
                  accessToken: validatedData.kommoAccessToken,
                  pipelineId: validatedData.kommodPipelineId,
                }
              : { enabled: false },
          rdstation:
            validatedData.rdstationClientId && validatedData.rdstationClientSecret
              ? {
                  enabled: true,
                  clientId: validatedData.rdstationClientId,
                  clientSecret: validatedData.rdstationClientSecret,
                  accessToken: validatedData.rdstationAccessToken,
                  refreshToken: validatedData.rdstationRefreshToken,
                  code: validatedData.rdstationCode,
                }
              : { enabled: false },
        };

        // Enviar para o N8N
        const n8nWebhookUrl = process.env.N8N_CREATE_WORKSPACE_URL;
        if (!n8nWebhookUrl) {
          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "URL do webhook N8N não configurada",
            })
          );
        }

        logInfo("Sending workspace data to N8N", {
          workspaceName: validatedData.nome,
          webhookUrl: n8nWebhookUrl,
        });

        let n8nResponse;
        let n8nData;

        try {
          n8nResponse = await fetch(n8nWebhookUrl, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
            },
            body: JSON.stringify(workspaceDataForN8N),
          });
        } catch (fetchError: any) {
          // Erro de rede ou timeout
          logError("N8N webhook connection failed", fetchError);
          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "Não foi possível conectar ao N8N",
              error:
                "O webhook do N8N pode estar desligado ou inacessível. Verifique se o fluxo está ativo no N8N.",
            })
          );
        }

        // HTTP Error (404, 500, etc)
        if (!n8nResponse.ok) {
          const errorText = await n8nResponse.text();
          logError(
            "N8N webhook HTTP error",
            new Error(`Status: ${n8nResponse.status}, Response: ${errorText}`)
          );

          let errorMessage = "Erro ao comunicar com o N8N";
          let errorDetail = errorText;

          if (n8nResponse.status === 404) {
            errorMessage = "Webhook do N8N não encontrado";
            errorDetail =
              "O fluxo pode estar desligado ou o webhook foi removido. Ative o fluxo no N8N e tente novamente.";
          } else if (n8nResponse.status >= 500) {
            errorMessage = "Erro interno no N8N";
            errorDetail =
              "O N8N está com problemas. Tente novamente em alguns instantes.";
          }

          return reply.code(500).send(
            formatResponse({
              success: false,
              message: errorMessage,
              error: errorDetail,
            })
          );
        }

        // Parse JSON response
        try {
          n8nData = await n8nResponse.json();
          logInfo("N8N response received", { n8nData });
        } catch (parseError) {
          logError("N8N response parse error", parseError as Error);
          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "Resposta inválida do N8N",
              error: "O N8N retornou uma resposta que não pôde ser processada.",
            })
          );
        }

        // Validar se o N8N retornou success: true
        // Nota: Aceita tanto "success" quanto "sucess" (typo comum no N8N)
        const isSuccess = n8nData?.success === true || n8nData?.sucess === true;
        if (!n8nData || !isSuccess) {
          logError(
            "N8N did not return success",
            new Error(`N8N response: ${JSON.stringify(n8nData)}`)
          );

          // N8N retornou explicitamente success: false
          const errorMessage =
            n8nData?.message ||
            n8nData?.error ||
            "O N8N não confirmou a criação do workspace";

          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "Falha ao criar workspace no N8N",
              error: errorMessage,
            })
          );
        }

        logInfo("N8N workspace created successfully", { n8nData });

        // Se o N8N retornou sucesso, criar no banco de dados
        // Usar as URLs de webhook geradas automaticamente (não do validatedData)
        const dataToCreate = {
          ...validatedData,
          webhookUrlProd: webhookUrlProd,
          webhookUrlDev: webhookUrlDev,
          kommoSubdomain: validatedData.kommoSubdomain || null,
          kommoAccessToken: validatedData.kommoAccessToken || null,
          kommodPipelineId: validatedData.kommodPipelineId || null,
          rdstationClientId: validatedData.rdstationClientId || null,
          rdstationClientSecret: validatedData.rdstationClientSecret || null,
          rdstationAccessToken: validatedData.rdstationAccessToken || null,
          rdstationRefreshToken: validatedData.rdstationRefreshToken || null,
          rdstationCode: validatedData.rdstationCode || null,
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

        logInfo("AI configuration created after N8N success", {
          id: config.id,
          userId: config.userId,
          nome: config.nome,
        });

        const response = formatResponse({
          data: {
            workspace: config,
            n8nResponse: n8nData,
          },
          message: "Workspace criado com sucesso no N8N e no sistema",
        });

        return reply.code(201).send(response);
      } catch (error: any) {
        logError("Error creating workspace with N8N", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
            error: error.message,
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
            kommoSubdomain: { type: "string" },
            kommoAccessToken: { type: "string" },
            kommodPipelineId: { type: "string" },
            credentialIds: { type: "array", items: { type: "string" } },
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

        // Convert empty strings to null for URL fields, Kommo and RD Station fields
        const dataToCreate = {
          ...validatedData,
          webhookUrlProd: validatedData.webhookUrlProd || null,
          webhookUrlDev: validatedData.webhookUrlDev || null,
          kommoSubdomain: validatedData.kommoSubdomain || null,
          kommoAccessToken: validatedData.kommoAccessToken || null,
          kommodPipelineId: validatedData.kommodPipelineId || null,
          rdstationClientId: validatedData.rdstationClientId || null,
          rdstationClientSecret: validatedData.rdstationClientSecret || null,
          rdstationAccessToken: validatedData.rdstationAccessToken || null,
          rdstationRefreshToken: validatedData.rdstationRefreshToken || null,
          rdstationCode: validatedData.rdstationCode || null,
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

        const response = formatResponse({
          data: config,
          message: "Configuração de IA criada com sucesso",
        });

        console.log(
          "📤 [CREATE CONFIG] Response data:",
          JSON.stringify(response, null, 2)
        );

        return reply.code(201).send(response);
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
            kommoSubdomain: { type: "string" },
            kommoAccessToken: { type: "string" },
            kommodPipelineId: { type: "string" },
            credentialIds: { type: "array", items: { type: "string" } },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateConfigIASchema.parse(request.body);

        // Convert empty strings to null for URL fields, Kommo and RD Station fields
        const dataToUpdate: any = { ...validatedData };
        if ("webhookUrlProd" in dataToUpdate) {
          dataToUpdate.webhookUrlProd = dataToUpdate.webhookUrlProd || null;
        }
        if ("webhookUrlDev" in dataToUpdate) {
          dataToUpdate.webhookUrlDev = dataToUpdate.webhookUrlDev || null;
        }
        if ("kommoSubdomain" in dataToUpdate) {
          dataToUpdate.kommoSubdomain = dataToUpdate.kommoSubdomain || null;
        }
        if ("kommoAccessToken" in dataToUpdate) {
          dataToUpdate.kommoAccessToken = dataToUpdate.kommoAccessToken || null;
        }
        if ("kommodPipelineId" in dataToUpdate) {
          dataToUpdate.kommodPipelineId = dataToUpdate.kommodPipelineId || null;
        }
        if ("rdstationClientId" in dataToUpdate) {
          dataToUpdate.rdstationClientId = dataToUpdate.rdstationClientId || null;
        }
        if ("rdstationClientSecret" in dataToUpdate) {
          dataToUpdate.rdstationClientSecret = dataToUpdate.rdstationClientSecret || null;
        }
        if ("rdstationAccessToken" in dataToUpdate) {
          dataToUpdate.rdstationAccessToken = dataToUpdate.rdstationAccessToken || null;
        }
        if ("rdstationRefreshToken" in dataToUpdate) {
          dataToUpdate.rdstationRefreshToken = dataToUpdate.rdstationRefreshToken || null;
        }
        if ("rdstationCode" in dataToUpdate) {
          dataToUpdate.rdstationCode = dataToUpdate.rdstationCode || null;
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
            kommoSubdomain: originalConfig.kommoSubdomain,
            kommoAccessToken: originalConfig.kommoAccessToken,
            kommodPipelineId: originalConfig.kommodPipelineId,
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
          bodyContent: JSON.stringify(request.body),
        });

        // Validar dados de entrada
        if (!id || typeof id !== "string") {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "ID da configuração de IA é obrigatório",
            })
          );
        }

        if (
          !instanceIds ||
          !Array.isArray(instanceIds) ||
          instanceIds.length === 0
        ) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message:
                "Lista de IDs de instâncias é obrigatória e não pode estar vazia",
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
          requestBody: request.body,
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
          bodyContent: JSON.stringify(request.body),
        });

        // Validar dados de entrada
        if (!id || typeof id !== "string") {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "ID da configuração de IA é obrigatório",
            })
          );
        }

        if (
          !instanceIds ||
          !Array.isArray(instanceIds) ||
          instanceIds.length === 0
        ) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              message:
                "Lista de IDs de instâncias é obrigatória e não pode estar vazia",
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
          requestBody: request.body,
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

  // POST /config-ia/:id/create-n8n-workspace - Create workspace in N8N
  fastify.post(
    "/:id/create-n8n-workspace",
    {
      schema: {
        tags: ["Configurações IA"],
        description: "Create workspace in N8N for this configuration",
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

        // Buscar o ConfigIA com as credenciais vinculadas
        const configIA = await db.configIA.findUnique({
          where: { id },
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

        if (!configIA) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Configuração de IA não encontrada",
            })
          );
        }

        // Buscar as credenciais vinculadas
        const credentials =
          configIA.credentialIds.length > 0
            ? await db.credential.findMany({
                where: {
                  id: { in: configIA.credentialIds },
                },
                select: {
                  id: true,
                  id_n8n: true,
                  name: true,
                  type: true,
                  url: true,
                  method: true,
                  authHeaderKey: true,
                  authHeaderValue: true,
                  customHeaders: true,
                  data: true,
                },
              })
            : [];

        // Carregar template do workflow N8N
        const workflowTemplate = loadN8NWorkflowTemplate(request.log);

        // Validar se todas as credenciais necessárias possuem id_n8n
        const validation = validateN8NCredentials(
          workflowTemplate,
          credentials,
          request.log
        );

        if (!validation.valid) {
          logError(
            "Missing N8N credential IDs",
            new Error(
              `Credenciais sem id_n8n: ${validation.missing.join(", ")}`
            )
          );
          return reply.code(400).send(
            formatResponse({
              success: false,
              message: "Algumas credenciais não possuem ID do N8N",
              error: `Tipos faltando: ${validation.missing.join(", ")}`,
            })
          );
        }

        // Substituir os IDs das credenciais no template e gerar URLs de webhook
        // Usar o ID do Clerk para garantir unicidade nos webhooks
        const clerkId = configIA.user.id;
        const { workflow, webhookUrlDev, webhookUrlProd, webhookPath } = replaceN8NCredentialIds(
          workflowTemplate,
          credentials,
          configIA.nome,
          clerkId,
          request.log
        );

        // Preparar dados para enviar ao N8N
        const workspaceData = {
          workspaceId: configIA.id,
          workspaceName: configIA.nome,
          workflow, // Template do workflow com IDs substituídos
          prompt: configIA.prompt,
          status: configIA.status,
          webhookUrlDev, // URL gerada automaticamente
          webhookUrlProd, // URL gerada automaticamente
          webhookPath, // Path do webhook para referência
          user: {
            id: configIA.user.id,
            name:
              `${configIA.user.firstName || ""} ${configIA.user.lastName || ""}`.trim() ||
              configIA.user.username ||
              "Usuário",
            clerkId,
          },
          credentials: credentials.map((cred) => ({
            id: cred.id,
            id_n8n: cred.id_n8n, // ID da credencial no N8N
            name: cred.name,
            type: cred.type,
            url: cred.url,
            method: cred.method,
            authHeaderKey: cred.authHeaderKey,
            authHeaderValue: cred.authHeaderValue,
            customHeaders: cred.customHeaders,
            data: cred.data,
          })),
          kommo:
            configIA.kommoSubdomain && configIA.kommoAccessToken
              ? {
                  enabled: true,
                  subdomain: configIA.kommoSubdomain,
                  accessToken: configIA.kommoAccessToken,
                  pipelineId: configIA.kommodPipelineId,
                }
              : { enabled: false },
          rdstation:
            configIA.rdstationClientId && configIA.rdstationClientSecret
              ? {
                  enabled: true,
                  clientId: configIA.rdstationClientId,
                  clientSecret: configIA.rdstationClientSecret,
                  accessToken: configIA.rdstationAccessToken,
                  refreshToken: configIA.rdstationRefreshToken,
                  code: configIA.rdstationCode,
                }
              : { enabled: false },
          createdAt: configIA.createdAt,
        };

        // Enviar para o N8N
        const n8nWebhookUrl = process.env.N8N_CREATE_WORKSPACE_URL;

        if (!n8nWebhookUrl) {
          logError(
            "N8N_CREATE_WORKSPACE_URL not configured",
            new Error("Missing environment variable")
          );
          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "URL do N8N não configurada no servidor",
            })
          );
        }

        logInfo("Sending workspace data to N8N", {
          configIAId: configIA.id,
          configIAName: configIA.nome,
          credentialsCount: credentials.length,
          webhookUrl: n8nWebhookUrl,
        });

        const response = await fetch(n8nWebhookUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(workspaceData),
        });

        if (!response.ok) {
          const errorText = await response.text();
          logError(
            "N8N webhook request failed",
            new Error(`Status: ${response.status}, Response: ${errorText}`)
          );
          return reply.code(500).send(
            formatResponse({
              success: false,
              message: "Erro ao criar workspace no N8N",
              error: errorText,
            })
          );
        }

        const n8nResponse = await response.json();

        logInfo("Workspace created in N8N", {
          configIAId: configIA.id,
          configIAName: configIA.nome,
          n8nResponse,
        });

        return formatResponse({
          data: {
            workspace: configIA,
            n8nResponse,
            credentialsCount: credentials.length,
          },
          message: "Workspace criado no N8N com sucesso",
        });
      } catch (error) {
        logError("Error creating workspace in N8N", error as Error);
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
