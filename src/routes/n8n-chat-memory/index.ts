import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const n8nChatMemorySchema = z.object({
  sessionId: z.string(),
  message: z.string(),
  direction: z.enum(["input", "output"]),
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
  processed: z.boolean().optional(),
  action: z.string().optional(),
  input: z.string().optional(),
  system_message: z.string().optional(),
});

const updateN8nChatMemorySchema = n8nChatMemorySchema.partial();

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
  direction: z.enum(["input", "output"]).optional(),
  chatId: z.string().optional(),
  senderId: z.string().optional(),
  instanceName: z.string().optional(),
  messageType: z.string().optional(),
  processed: z
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
  // GET /n8n-chat-memory - List all chat memory with pagination and filters
  fastify.get(
    "/",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "List chat memory with pagination and filters",
        querystring: {
          type: "object",
          properties: {
            page: { type: "string", default: "1" },
            limit: { type: "string", default: "10" },
            sessionId: { type: "string" },
            direction: { type: "string", enum: ["input", "output"] },
            chatId: { type: "string" },
            senderId: { type: "string" },
            instanceName: { type: "string" },
            messageType: { type: "string" },
            processed: { type: "string" },
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
          processed,
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
        if (processed !== undefined) where.processed = processed;
        if (isGroup !== undefined) where.isGroup = isGroup;

        if (dateFrom || dateTo) {
          where.timestamp = {};
          if (dateFrom) where.timestamp.gte = new Date(dateFrom);
          if (dateTo) where.timestamp.lte = new Date(dateTo);
        }

        const [chatMemories, total] = await Promise.all([
          db.n8nChatMemory.findMany({
            where,
            skip: offset,
            take: limit,
            orderBy: { createdAt: "desc" },
          }),
          db.n8nChatMemory.count({ where }),
        ]);

        const totalPages = Math.ceil(total / limit);

        return formatResponse({
          data: chatMemories,
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
        logError("Error listing n8n chat memory", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /n8n-chat-memory/:id - Get chat memory by ID
  fastify.get(
    "/:id",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Get chat memory by ID",
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

        const chatMemory = await db.n8nChatMemory.findUnique({
          where: { id },
        });

        if (!chatMemory) {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Registro de chat memory não encontrado",
            })
          );
        }

        return formatResponse({ data: chatMemory });
      } catch (error) {
        logError("Error getting n8n chat memory", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // GET /n8n-chat-memory/session/:sessionId - Get chat memory by session ID
  fastify.get(
    "/session/:sessionId",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Get chat memory by session ID",
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
            direction: { type: "string", enum: ["input", "output"] },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { sessionId } = request.params as { sessionId: string };
        const { limit: limitStr, direction } = request.query as any;
        const limit = parseInt(limitStr) || 100;

        const where: any = { sessionId };
        if (direction) where.direction = direction;

        const chatMemories = await db.n8nChatMemory.findMany({
          where,
          take: limit,
          orderBy: { createdAt: "asc" },
        });

        return formatResponse({
          data: chatMemories,
          metadata: { sessionId, count: chatMemories.length },
        });
      } catch (error) {
        logError("Error getting n8n chat memory by session", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // POST /n8n-chat-memory - Create chat memory
  fastify.post(
    "/",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Create a new chat memory entry",
        body: {
          type: "object",
          properties: {
            sessionId: { type: "string" },
            message: { type: "string" },
            direction: { type: "string", enum: ["input", "output"] },
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
            processed: { type: "boolean" },
            action: { type: "string" },
            input: { type: "string" },
            system_message: { type: "string" },
          },
          required: ["sessionId", "message", "direction"],
        },
      },
    },
    async (request, reply) => {
      try {
        const validatedData = n8nChatMemorySchema.parse(request.body);

        const chatMemory = await db.n8nChatMemory.create({
          data: {
            ...validatedData,
            timestamp: validatedData.timestamp
              ? new Date(validatedData.timestamp)
              : null,
          },
        });

        logInfo("N8N Chat memory created", {
          id: chatMemory.id,
          sessionId: chatMemory.sessionId,
        });

        return reply.code(201).send(
          formatResponse({
            data: chatMemory,
            message: "Registro de chat memory criado com sucesso",
          })
        );
      } catch (error) {
        logError("Error creating n8n chat memory", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // PUT /n8n-chat-memory/:id - Update chat memory
  fastify.put(
    "/:id",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Update chat memory",
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
            direction: { type: "string", enum: ["input", "output"] },
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
            processed: { type: "boolean" },
            action: { type: "string" },
            input: { type: "string" },
            system_message: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const validatedData = updateN8nChatMemorySchema.parse(request.body);

        const updateData: any = { ...validatedData };
        if (validatedData.timestamp) {
          updateData.timestamp = new Date(validatedData.timestamp);
        }

        const chatMemory = await db.n8nChatMemory.update({
          where: { id },
          data: updateData,
        });

        logInfo("N8N Chat memory updated", { id: chatMemory.id });

        return formatResponse({
          data: chatMemory,
          message: "Registro de chat memory atualizado com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Registro de chat memory não encontrado",
            })
          );
        }

        logError("Error updating n8n chat memory", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /n8n-chat-memory/:id - Delete chat memory
  fastify.delete(
    "/:id",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Delete chat memory",
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

        await db.n8nChatMemory.delete({
          where: { id },
        });

        logInfo("N8N Chat memory deleted", { id });

        return formatResponse({
          message: "Registro de chat memory excluído com sucesso",
        });
      } catch (error: any) {
        if (error.code === "P2025") {
          return reply.code(404).send(
            formatResponse({
              success: false,
              message: "Registro de chat memory não encontrado",
            })
          );
        }

        logError("Error deleting n8n chat memory", error as Error);
        return reply.code(500).send(
          formatResponse({
            success: false,
            message: "Erro interno do servidor",
          })
        );
      }
    }
  );

  // DELETE /n8n-chat-memory/session/:sessionId - Delete all chat memory for a session
  fastify.delete(
    "/session/:sessionId",
    {
      schema: {
        tags: ["N8N Chat Memory"],
        description: "Delete all chat memory for a session",
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

        const result = await db.n8nChatMemory.deleteMany({
          where: { sessionId },
        });

        logInfo("N8N Chat memory session cleared", {
          sessionId,
          count: result.count,
        });

        return formatResponse({
          message: `${result.count} registros de chat memory excluídos com sucesso`,
          metadata: { deletedCount: result.count },
        });
      } catch (error) {
        logError("Error deleting n8n chat memory session", error as Error);
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
