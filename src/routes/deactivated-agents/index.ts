import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "../../lib/db";
import { sendError, sendSuccess } from "../../utils/response-formatter";

// Esquemas de validação
const createDeactivatedAgentSchema = z.object({
  configIAId: z.string().cuid(),
  phoneNumber: z.string().min(10).max(20), // Ex: +5511999999999
  reason: z.string().optional(),
  blockedBy: z.string().optional(),
});

const updateDeactivatedAgentSchema = z.object({
  reason: z.string().optional(),
  isActive: z.boolean().optional(),
});

const querySchema = z.object({
  configIAId: z.string().cuid().optional(),
  phoneNumber: z.string().optional(),
  isActive: z.boolean().optional(),
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(10),
});

export default async function (fastify: FastifyInstance) {
  // GET /deactivated-agents - Listar números desativados
  fastify.get(
    "/",

    async (request, reply) => {
      try {
        const { configIAId, phoneNumber, isActive, page, limit } =
          request.query as z.infer<typeof querySchema>;

        // Construir filtros
        const where: any = {};
        if (configIAId) where.configIAId = configIAId;
        if (phoneNumber) where.phoneNumber = { contains: phoneNumber };
        if (isActive !== undefined) where.isActive = isActive;

        // Contar total de registros
        const total = await db.deactivatedAgent.count({ where });

        // Buscar registros paginados
        const deactivatedAgents = await db.deactivatedAgent.findMany({
          where,
          include: {
            configIA: {
              select: {
                id: true,
                nome: true,
              },
            },
          },
          orderBy: { createdAt: "desc" },
          skip: (page - 1) * limit,
          take: limit,
        });

        const totalPages = Math.ceil(total / limit);

        return sendSuccess(reply, {
          data: deactivatedAgents.map((agent) => ({
            ...agent,
            createdAt: agent.createdAt.toISOString(),
            updatedAt: agent.updatedAt.toISOString(),
          })),
        });
      } catch (error) {
        fastify.log.error("Error fetching deactivated agents:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // GET /deactivated-agents/config/:configIAId - Listar números desativados por agente
  fastify.get(
    "/config/:configIAId",

    async (request, reply) => {
      try {
        const { configIAId } = request.params as { configIAId: string };
        const query = request.query as { isActive?: string };

        const where: any = { configIAId };

        // Parse isActive query parameter properly
        if (query.isActive !== undefined) {
          const isActiveValue = query.isActive.toLowerCase();
          if (isActiveValue === "true") {
            where.isActive = true;
          } else if (isActiveValue === "false") {
            where.isActive = false;
          }
        }

        const deactivatedAgents = await db.deactivatedAgent.findMany({
          where,
          orderBy: { createdAt: "desc" },
        });

        return sendSuccess(reply, {
          data: deactivatedAgents.map((agent) => ({
            ...agent,
            createdAt: agent.createdAt.toISOString(),
            updatedAt: agent.updatedAt.toISOString(),
          })),
        });
      } catch (error) {
        fastify.log.error("Error fetching deactivated agents by config:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // POST /deactivated-agents - Criar novo número desativado
  fastify.post(
    "/",

    async (request, reply) => {
      try {
        const { configIAId, phoneNumber, reason, blockedBy } =
          request.body as z.infer<typeof createDeactivatedAgentSchema>;

        // Verificar se o ConfigIA existe e obter o userId
        const configIA = await db.configIA.findUnique({
          where: { id: configIAId },
          select: { userId: true },
        });

        if (!configIA) {
          return sendError(reply, {
            status: 404,
            error: "Agente IA não encontrado",
          });
        }

        // Normalizar número de telefone (remover caracteres especiais, incluindo +)
        const normalizedPhone = phoneNumber.replace(/[^\d]/g, "");

        // Verificar se já existe um bloqueio ativo para este número e agente
        const existingBlock = await db.deactivatedAgent.findUnique({
          where: {
            configIAId_phoneNumber: {
              configIAId,
              phoneNumber: normalizedPhone,
            },
          },
        });

        if (existingBlock) {
          return sendError(reply, {
            status: 409,
            error:
              "Este número já está na lista de bloqueados para este agente",
          });
        }

        // Criar o novo registro
        const deactivatedAgent = await db.deactivatedAgent.create({
          data: {
            userId: configIA.userId,
            configIAId,
            phoneNumber: normalizedPhone,
            reason,
            blockedBy,
            isActive: true,
          },
        });

        return sendSuccess(reply, {
          status: 201,
          data: {
            ...deactivatedAgent,
            createdAt: deactivatedAgent.createdAt.toISOString(),
            updatedAt: deactivatedAgent.updatedAt.toISOString(),
          },
        });
      } catch (error) {
        fastify.log.error("Error creating deactivated agent:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // PUT /deactivated-agents/:id - Atualizar número desativado
  fastify.put(
    "/:id",

    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };
        const updateData = request.body as z.infer<
          typeof updateDeactivatedAgentSchema
        >;

        const deactivatedAgent = await db.deactivatedAgent.update({
          where: { id },
          data: updateData,
        });

        return sendSuccess(reply, {
          data: {
            ...deactivatedAgent,
            createdAt: deactivatedAgent.createdAt.toISOString(),
            updatedAt: deactivatedAgent.updatedAt.toISOString(),
          },
        });
      } catch (error) {
        fastify.log.error("Error updating deactivated agent:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // DELETE /deactivated-agents/:id - Remover número desativado
  fastify.delete(
    "/:id",

    async (request, reply) => {
      try {
        const { id } = request.params as { id: string };

        await db.deactivatedAgent.delete({
          where: { id },
        });

        return sendSuccess(reply, {
          message: "Número removido da lista de bloqueados com sucesso",
        });
      } catch (error) {
        fastify.log.error("Error deleting deactivated agent:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // POST /deactivated-agents/check - Verificar se um número está bloqueado para um agente
  fastify.post(
    "/check",

    async (request, reply) => {
      try {
        const { configIAId, phoneNumber } = request.body as {
          configIAId: string;
          phoneNumber: string;
        };

        // Normalizar número de telefone
        const normalizedPhone = phoneNumber.replace(/[^\d+]/g, "");

        // Verificar se existe bloqueio ativo
        const blockedAgent = await db.deactivatedAgent.findUnique({
          where: {
            configIAId_phoneNumber: {
              configIAId,
              phoneNumber: normalizedPhone,
            },
          },
        });

        const isBlocked = blockedAgent && blockedAgent.isActive;

        return sendSuccess(reply, {
          data: {
            isBlocked: !!isBlocked,
            reason: isBlocked ? blockedAgent.reason : null,
            blockedBy: isBlocked ? blockedAgent.blockedBy : null,
            blockedAt: isBlocked ? blockedAgent.createdAt.toISOString() : null,
          },
        });
      } catch (error) {
        fastify.log.error("Error checking blocked number:");
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );
}
