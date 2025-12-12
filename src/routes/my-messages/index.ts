import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const myMessagesSchema = z.object({
  sessionId: z.string(),
  message: z.string(),
  direction: z.enum(["sent", "received"]),
  messageId: z.string().optional(),
  instanceName: z.string().optional(),
  chatId: z.string().optional(),
  senderId: z.string().optional(),
  senderName: z.string().optional(),
  messageType: z.string().optional(),
  content: z.string().optional(),
  mediaUrl: z.string().optional(),
  mediaType: z.string().optional(),
  mediaBase64: z.string().optional(),
  caption: z.string().optional(),
  fileName: z.string().optional(),
  timestamp: z.string().datetime().optional(),
  isGroup: z.boolean().optional(),
  status: z.string().optional(),
  serverUrl: z.string().optional(),
  apikey: z.string().optional(),
  webhookData: z.any().optional(),
  aiResponse: z.string().optional(),
  isAiResponse: z.boolean().optional(),
});

const updateMyMessagesSchema = myMessagesSchema.partial();

const querySchema = z.object({
  page: z
    .string()
    .transform((val) => parseInt(val))
    .default("1"),
  limit: z
    .string()
    .transform((val) => parseInt(val))
    .default("10"),
  sessionId: z.string().optional(),
  direction: z.enum(["sent", "received"]).optional(),
  chatId: z.string().optional(),
  senderId: z.string().optional(),
  instanceName: z.string().optional(),
  messageType: z.string().optional(),
  isAiResponse: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  isGroup: z
    .string()
    .transform((val) => val === "true")
    .optional(),
  dateFrom: z.string().datetime().optional(),
  dateTo: z.string().datetime().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET /my-messages - List all messages with pagination and filters
  fastify.get(
    "/",
    {
      schema: {
        tags: ["My Messages"],
        description: "List messages with pagination and filters",
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            sessionId: { type: "string" },
            direction: { type: "string", enum: ["sent", "received"] },
            chatId: { type: "string" },
            senderId: { type: "string" },
            instanceName: { type: "string" },
            messageType: { type: "string" },
            isAiResponse: { type: "string" },
            isGroup: { type: "string" },
            dateFrom: { type: "string", format: "date-time" },
            dateTo: { type: "string", format: "date-time" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const {
          page,
          limit,
          sessionId,
          direction,
          chatId,
          senderId,
          instanceName,
          messageType,
          isAiResponse,
          isGroup,
          dateFrom,
          dateTo,
        } = querySchema.parse(request.query);
        const offset = (page - 1) * limit;

        const where: any = {};

        if (sessionId) where.sessionId = sessionId;
        if (direction) where.direction = direction;
        if (chatId) where.chatId = chatId;
        if (senderId) where.senderId = senderId;
        if (instanceName) where.instanceName = instanceName;
        if (messageType) where.messageType = messageType;
        if (isAiResponse !== undefined) where.isAiResponse = isAiResponse;
        if (isGroup !== undefined) where.isGroup = isGroup;

        if (dateFrom || dateTo) {
          where.timestamp = {};
          if (dateFrom) where.timestamp.gte = new Date(dateFrom);
          if (dateTo) where.timestamp.lte = new Date(dateTo);
        }

        const [messages, total] = await Promise.all([
          db.myMessages.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { createdAt: "desc" },
          }),
          db.myMessages.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: messages,
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
        logError("Error listing my messages", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/:id - Get message by ID
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get message by ID",
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

        const message = await db.myMessages.findUnique({
          where: { id },
        });

        if (!message) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Mensagem não encontrada",
            })
          );
        }

        return formatResponse({ data: message });
      } catch (error) {
        logError("Error getting my message", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/session/:sessionId - Get messages by session ID
  fastify.get(
    "/session/:sessionId",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get messages by session ID",
        params: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
        querystring: {
          type: "object",
          properties: {
            limit: { type: "string", default: "100" },
            direction: { type: "string", enum: ["sent", "received"] },
            isAiResponse: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { sessionId } = request.params as { sessionId: string };
        const {
          limit: limitStr,
          direction,
          isAiResponse: isAiResponseStr,
        } = request.query as any;
        const limit = parseInt(limitStr) || 100;

        const where: any = { sessionId };
        if (direction) where.direction = direction;
        if (isAiResponseStr !== undefined)
          where.isAiResponse = isAiResponseStr === "true";

        const messages = await db.myMessages.findMany({
          where,
          take: limit,
          orderBy: { createdAt: "asc" },
        });

        return formatResponse({
          data: messages,
          metadata: { sessionId, count: messages.length },
        });
      } catch (error) {
        logError("Error getting my messages by session", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/chat/:chatId - Get messages by chat ID
  fastify.get(
    "/chat/:chatId",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get messages by chat ID",
        params: {
          type: "object",
          properties: {
            chatId: { type: "string" },
          },
          required: ["chatId"],
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "50" },
            direction: { type: "string", enum: ["sent", "received"] },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { chatId } = request.params as { chatId: string };
        const {
          page: pageStr,
          limit: limitStr,
          direction,
        } = request.query as any;
        const page = parseInt(pageStr) || 1;
        const limit = parseInt(limitStr) || 50;
        const offset = (page - 1) * limit;

        const where: any = { chatId };
        if (direction) where.direction = direction;

        const [messages, total] = await Promise.all([
          db.myMessages.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { timestamp: "desc" },
          }),
          db.myMessages.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: messages,
          metadata: {
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
            chatId,
          },
        });
      } catch (error) {
        logError("Error getting my messages by chat", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /my-messages - Create message
  fastify.post(
    "/",
    {
      schema: {
        tags: ["My Messages"],
        description: "Create a new message entry",
        body: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            message: { type: "string" },
            direction: { type: "string", enum: ["sent", "received"] },
            messageId: { type: "string" },
            instanceName: { type: "string" },
            chatId: { type: "string" },
            senderId: { type: "string" },
            senderName: { type: "string" },
            messageType: { type: "string" },
            content: { type: "string" },
            mediaUrl: { type: "string" },
            mediaType: { type: "string" },
            mediaBase64: { type: "string" },
            caption: { type: "string" },
            fileName: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
            isGroup: { type: "boolean" },
            status: { type: "string" },
            serverUrl: { type: "string" },
            apikey: { type: "string" },
            webhookData: { type: "object" },
            aiResponse: { type: "string" },
            isAiResponse: { type: "boolean" },
          },
          required: ["sessionId", "message", "direction"],
        },
      },
    },
    async (request, reply) => {
      try {
        const validatedData = myMessagesSchema.parse(request.body);

        const message = await db.myMessages.create({
          data: {
            ...validatedData,
            timestamp: validatedData.timestamp
              ? new Date(validatedData.timestamp)
              : null,
          },
        });

        logInfo("My message created", {
          id: message.id,
          sessionId: message.sessionId,
        });

        return reply.code(201).send(
          formatResponse({
            data: message,
            message: "Mensagem criada com sucesso",
          })
        );
      } catch (error) {
        logError("Error creating my message", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PUT /my-messages/:id - Update message
  fastify.put(
    "/:id",
    {
      schema: {
        tags: ["My Messages"],
        description: "Update message",
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
            sessionId: { type: "string" },
            message: { type: "string" },
            direction: { type: "string", enum: ["sent", "received"] },
            messageId: { type: "string" },
            instanceName: { type: "string" },
            chatId: { type: "string" },
            senderId: { type: "string" },
            senderName: { type: "string" },
            messageType: { type: "string" },
            content: { type: "string" },
            mediaUrl: { type: "string" },
            mediaType: { type: "string" },
            mediaBase64: { type: "string" },
            caption: { type: "string" },
            fileName: { type: "string" },
            timestamp: { type: "string", format: "date-time" },
            isGroup: { type: "boolean" },
            status: { type: "string" },
            serverUrl: { type: "string" },
            apikey: { type: "string" },
            webhookData: { type: "object" },
            aiResponse: { type: "string" },
            isAiResponse: { type: "boolean" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateMyMessagesSchema.parse(request.body);

        const updateData: any = { ...validatedData };
        if (validatedData.timestamp) {
          updateData.timestamp = new Date(validatedData.timestamp);
        }

        const message = await db.myMessages.update({
          where: { id },
          data: updateData,
        });

        logInfo("My message updated", { id: message.id });

        return formatResponse({
          data: message,
          message: "Mensagem atualizada com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Mensagem não encontrada",
            })
          );
        }

        logError("Error updating my message", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /my-messages/:id - Delete message
  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["My Messages"],
        description: "Delete message",
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

        await db.myMessages.delete({
          where: { id },
        });

        logInfo("My message deleted", { id });

        return formatResponse({
          message: "Mensagem excluída com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Mensagem não encontrada",
            })
          );
        }

        logError("Error deleting my message", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /my-messages/session/:sessionId - Delete all messages for a session
  fastify.delete(
    "/session/:sessionId",
    {
      schema: {
        tags: ["My Messages"],
        description: "Delete all messages for a session",
        params: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { sessionId } = request.params as { sessionId: string };

        const result = await db.myMessages.deleteMany({
          where: { sessionId },
        });

        logInfo("My messages session cleared", {
          sessionId,
          count: result.count,
        });

        return formatResponse({
          message: `${result.count} mensagens excluídas com sucesso`,
          metadata: { deletedCount: result.count },
        });
      } catch (error) {
        logError("Error deleting my messages session", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/agent/:agentId - Get messages by agent/ConfigIA ID
  fastify.get(
    "/agent/:agentId",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get messages by agent/ConfigIA ID with contact grouping",
        params: {
          type: "object",
          properties: {
            agentId: { type: "string" },
          },
          required: ["agentId"],
        },
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "50" },
            contactId: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentId } = request.params as { agentId: string };
        const {
          page: pageStr,
          limit: limitStr,
          contactId,
        } = request.query as any;
        const page = parseInt(pageStr) || 1;
        const limit = parseInt(limitStr) || 50;
        const offset = (page - 1) * limit;

        // Primeiro, verificar se o ConfigIA existe e logar informações de debug
        console.log(`🔍 [DEBUG] Buscando agente ID: ${agentId}`);

        const configIA = await db.configIA.findUnique({
          where: { id: agentId },
          include: { evolutionInstances: true },
        });

        if (!configIA) {
          console.log(`❌ [DEBUG] Agente não encontrado: ${agentId}`);
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Agente não encontrado",
            })
          );
        }

        console.log(`✅ [DEBUG] Agente encontrado: ${configIA.nome}`);
        console.log(
          `📋 [DEBUG] Instâncias vinculadas:`,
          configIA.evolutionInstances.map((i) => ({
            id: i.id,
            instanceName: i.instanceName,
            connectionState: i.connectionState,
          }))
        );

        // Buscar mensagens das instâncias do agente
        const instanceNames = configIA.evolutionInstances.map(
          (instance) => instance.instanceName
        );

        console.log(
          `🔍 [DEBUG] Buscando mensagens pelos instanceNames:`,
          instanceNames
        );

        // Verificar se temos instâncias para buscar
        if (instanceNames.length === 0) {
          console.log(
            `⚠️ [DEBUG] Nenhuma instância Evolution vinculada ao agente ${configIA.nome}`
          );
          return formatResponse({
            data: [],
            metadata: {
              pagination: {
                page,
                limit,
                total: 0,
                totalPages: 0,
                hasNext: false,
                hasPrev: false,
              },
              agentId,
              agentName: configIA.nome,
              instanceNames: [],
              contactId,
            },
          });
        }

        const where: any = {
          instanceName: { in: instanceNames },
        };

        // Se contactId especificado, filtrar por ele
        // Para grupos (@g.us), filtrar pelo chatId
        // Para privados, filtrar por senderId ou chatId
        if (contactId) {
          const isGroupContact = contactId.includes('@g.us');
          if (isGroupContact) {
            // Para grupos, buscar todas as mensagens desse chatId
            where.chatId = contactId;
            console.log(
              `🎯 [DEBUG] Filtrando mensagens para GRUPO: ${contactId}`
            );
          } else {
            // Para conversas privadas, buscar por senderId ou chatId
            where.OR = [{ senderId: contactId }, { chatId: contactId }];
            console.log(
              `🎯 [DEBUG] Filtrando mensagens para contato privado: ${contactId}`
            );
          }
        }

        console.log(`🔍 [DEBUG] Query WHERE:`, JSON.stringify(where, null, 2));

        // Buscar mensagens em ambas as tabelas: myMessages e n8nChatMemory
        const [myMessages, n8nMessages, myMessagesTotal, n8nTotal] = await Promise.all([
          db.myMessages.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { timestamp: "desc" },
          }),
          db.n8nChatMemory.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { timestamp: "desc" },
          }),
          db.myMessages.count({ where }),
          db.n8nChatMemory.count({ where }),
        ]);

        // Combinar e ordenar mensagens por timestamp
        const allMessages = [...myMessages, ...n8nMessages].sort((a, b) => {
          const timestampA = a.timestamp ? new Date(a.timestamp).getTime() : 0;
          const timestampB = b.timestamp ? new Date(b.timestamp).getTime() : 0;
          return timestampB - timestampA; // Mais recente primeiro
        });

        // Aplicar paginação aos resultados combinados
        const messages = allMessages.slice(0, limit);
        const total = myMessagesTotal + n8nTotal;

        console.log(`📊 [DEBUG] MyMessages: ${myMessagesTotal}, N8nChatMemory: ${n8nTotal}, Total: ${total}`);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: messages,
          metadata: {
            pagination: {
              page,
              limit,
              total,
              totalPages,
              hasNext: page < totalPages,
              hasPrev: page > 1,
            },
            agentId,
            agentName: configIA.nome,
            instanceNames,
            contactId,
          },
        });
      } catch (error) {
        logError("Error getting my messages by agent", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/agent/:agentId/contacts - Get unique contacts for an agent
  fastify.get(
    "/agent/:agentId/contacts",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get unique contacts for an agent",
        params: {
          type: "object",
          properties: {
            agentId: { type: "string" },
          },
          required: ["agentId"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { agentId } = request.params as { agentId: string };

        console.log(
          `👥 [CONTACTS-DEBUG] Buscando contatos para agente ID: ${agentId}`
        );

        // Verificar se o ConfigIA existe
        const configIA = await db.configIA.findUnique({
          where: { id: agentId },
          include: { evolutionInstances: true },
        });

        if (!configIA) {
          console.log(`❌ [CONTACTS-DEBUG] Agente não encontrado: ${agentId}`);
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Agente não encontrado",
            })
          );
        }

        console.log(`✅ [CONTACTS-DEBUG] Agente encontrado: ${configIA.nome}`);
        console.log(
          `📋 [CONTACTS-DEBUG] Instâncias:`,
          configIA.evolutionInstances.map((i) => i.instanceName)
        );

        // Buscar contatos únicos das instâncias do agente
        const instanceNames = configIA.evolutionInstances.map(
          (instance) => instance.instanceName
        );

        if (instanceNames.length === 0) {
          console.log(
            `⚠️ [CONTACTS-DEBUG] Nenhuma instância vinculada ao agente`
          );
          return formatResponse({
            data: [],
            metadata: {
              agentId,
              agentName: configIA.nome,
              contactCount: 0,
            },
          });
        }

        console.log(
          `🔍 [CONTACTS-DEBUG] Buscando mensagens pelos instanceNames:`,
          instanceNames
        );

        // Buscar contatos em ambas as tabelas: myMessages e n8nChatMemory
        // Para grupos, usamos chatId como identificador; para privados, usamos senderId
        const [myMessagesContacts, n8nContacts] = await Promise.all([
          // Buscar em MyMessages - agrupando por chatId para incluir grupos
          db.myMessages.findMany({
            where: {
              instanceName: { in: instanceNames },
              chatId: { not: null },
            },
            select: {
              senderId: true,
              senderName: true,
              chatId: true,
              isGroup: true,
              timestamp: true,
            },
            orderBy: { timestamp: "desc" },
            distinct: ["chatId"],
          }),

          // Buscar em N8nChatMemory - agrupando por chatId para incluir grupos
          db.n8nChatMemory.findMany({
            where: {
              instanceName: { in: instanceNames },
              chatId: { not: null },
            },
            select: {
              senderId: true,
              senderName: true,
              chatId: true,
              isGroup: true,
              timestamp: true,
            },
            orderBy: { timestamp: "desc" },
            distinct: ["chatId"],
          })
        ]);

        console.log(
          `📊 [CONTACTS-DEBUG] MyMessages encontradas:`,
          myMessagesContacts.length
        );
        console.log(
          `📊 [CONTACTS-DEBUG] N8nChatMemory encontradas:`,
          n8nContacts.length
        );

        // Combinar resultados das duas tabelas
        const allContacts = [...myMessagesContacts, ...n8nContacts];

        // Agrupar contatos únicos com última mensagem (removendo duplicatas entre as tabelas)
        // Para grupos: usar chatId como identificador único
        // Para privados: usar chatId (que é igual ao senderId)
        const uniqueContacts = allContacts.reduce((acc: any[], contact) => {
          // Usar chatId como identificador único (funciona tanto para grupos quanto privados)
          const contactKey = contact.chatId;
          const existing = acc.find((c) => c.contactId === contactKey);

          if (!existing) {
            // Para grupos, o nome do contato deve ser o nome do grupo (chatId contém @g.us)
            const isGroup = contact.isGroup || (contact.chatId && contact.chatId.includes('@g.us'));

            acc.push({
              contactId: contactKey, // Usar chatId como contactId
              contactName: isGroup
                ? (contact.senderName || contact.chatId?.split('@')[0] || 'Grupo')
                : (contact.senderName || contact.senderId || 'Desconhecido'),
              chatId: contact.chatId,
              isGroup: isGroup,
              lastMessageTime: contact.timestamp,
            });
          } else {
            // Se já existe, manter a mensagem mais recente
            if (contact.timestamp && (!existing.lastMessageTime || contact.timestamp > existing.lastMessageTime)) {
              existing.lastMessageTime = contact.timestamp;
              // Não atualizar o nome para grupos já identificados
              if (!existing.isGroup) {
                existing.contactName = contact.senderName;
              }
            }
          }
          return acc;
        }, []);

        console.log(
          `📊 [CONTACTS-DEBUG] Contatos únicos após merge:`,
          uniqueContacts.length
        );

        return formatResponse({
          data: uniqueContacts,
          metadata: {
            agentId,
            agentName: configIA.nome,
            contactCount: uniqueContacts.length,
          },
        });
      } catch (error) {
        logError("Error getting contacts by agent", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /my-messages/stats/session/:sessionId - Get message statistics for a session
  fastify.get(
    "/stats/session/:sessionId",
    {
      schema: {
        tags: ["My Messages"],
        description: "Get message statistics for a session",
        params: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
          },
          required: ["sessionId"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { sessionId } = request.params as { sessionId: string };

        const [
          totalMessages,
          sentMessages,
          receivedMessages,
          aiResponses,
          groupMessages,
          mediaMessages,
        ] = await Promise.all([
          db.myMessages.count({ where: { sessionId } }),
          db.myMessages.count({ where: { sessionId, direction: "sent" } }),
          db.myMessages.count({ where: { sessionId, direction: "received" } }),
          db.myMessages.count({ where: { sessionId, isAiResponse: true } }),
          db.myMessages.count({ where: { sessionId, isGroup: true } }),
          db.myMessages.count({
            where: {
              sessionId,
              OR: [{ mediaUrl: { not: null } }, { mediaBase64: { not: null } }],
            },
          }),
        ]);

        const stats = {
          sessionId,
          totalMessages,
          sentMessages,
          receivedMessages,
          aiResponses,
          groupMessages,
          mediaMessages,
          privateMessages: totalMessages - groupMessages,
          textMessages: totalMessages - mediaMessages,
        };

        return formatResponse({ data: stats });
      } catch (error) {
        logError("Error getting my messages stats", error as Error);
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
