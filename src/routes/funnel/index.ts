import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

// ========================================
// SCHEMAS
// ========================================

const funnelSchema = z.object({
  userId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
});

const updateFunnelSchema = funnelSchema.partial().omit({ userId: true });

const stageSchema = z.object({
  name: z.string().min(1),
  color: z.string().default("#6366f1"),
  order: z.number(),
  isFixed: z.boolean().optional().default(false),
  fixedType: z.enum(["won", "lost"]).optional(),
});

const updateStageSchema = stageSchema.partial();

const leadSchema = z.object({
  stageId: z.string(),
  name: z.string().min(1),
  email: z.string().email().optional().or(z.literal("")),
  phone: z.string().optional(),
  value: z.number().optional().default(0),
  notes: z.string().optional(),
  tags: z.array(z.string()).optional().default([]),
  source: z.string().optional(),
  assignedTo: z.string().optional(),
  priority: z.enum(["low", "medium", "high"]).optional().default("medium"),
  expectedCloseDate: z.string().datetime().optional(),
  order: z.number().optional().default(0),
});

const updateLeadSchema = leadSchema.partial();

const moveLeadSchema = z.object({
  stageId: z.string(),
  order: z.number(),
});

const followUpAgentSchema = z.object({
  name: z.string().optional().default("Agente de Follow-up"),
  isActive: z.boolean().optional().default(false),
  model: z.string().optional().default("gpt-4o-mini"),
  temperature: z.number().min(0).max(2).optional().default(0.7),
  maxTokens: z.number().min(50).max(4000).optional().default(500),
  systemPrompt: z.string().min(1),
  followUpPrompt: z.string().optional(),
  autoFollowUp: z.boolean().optional().default(false),
  followUpDelayHours: z.number().min(1).max(168).optional().default(24),
  maxFollowUps: z.number().min(1).max(10).optional().default(3),
  workingHoursStart: z.string().optional().default("09:00"),
  workingHoursEnd: z.string().optional().default("18:00"),
  workingDays: z.array(z.number().min(0).max(6)).optional().default([1, 2, 3, 4, 5]),
  timezone: z.string().optional().default("America/Sao_Paulo"),
  evolutionInstanceId: z.string().optional(),
  openaiApiKey: z.string().optional(),
  credentialId: z.string().optional(),
});

const updateFollowUpAgentSchema = followUpAgentSchema.partial();

const querySchema = z.object({
  page: z.string().transform((val) => parseInt(val)).default("1"),
  limit: z.string().transform((val) => parseInt(val)).default("10"),
  userId: z.string().optional(),
  search: z.string().optional(),
  isActive: z.string().transform((val) => val === "true").optional(),
});

// ========================================
// HELPER: Create default stages
// ========================================

async function createDefaultStages(funnelId: string) {
  const defaultStages = [
    { name: "Novo Lead", color: "#3b82f6", order: 0, isFixed: false },
    { name: "Contato Inicial", color: "#8b5cf6", order: 1, isFixed: false },
    { name: "Proposta Enviada", color: "#f59e0b", order: 2, isFixed: false },
    { name: "Negociação", color: "#ec4899", order: 3, isFixed: false },
    { name: "Ganho", color: "#22c55e", order: 100, isFixed: true, fixedType: "won" },
    { name: "Perdido", color: "#ef4444", order: 101, isFixed: true, fixedType: "lost" },
  ];

  await db.funnelStage.createMany({
    data: defaultStages.map((stage) => ({
      funnelId,
      ...stage,
    })),
  });
}

export default async function (fastify: FastifyInstance) {
  // ========================================
  // FUNNEL ROUTES
  // ========================================

  // GET /funnel - List all funnels
  fastify.get("/", async (request, reply) => {
    try {
      const { page, limit, userId, search, isActive } = querySchema.parse(request.query);
      const offset = (page - 1) * limit;

      const where: any = {};
      if (userId) where.userId = userId;
      if (typeof isActive === "boolean") where.isActive = isActive;
      if (search) {
        where.OR = [
          { name: { contains: search, mode: "insensitive" } },
          { description: { contains: search, mode: "insensitive" } },
        ];
      }

      const [funnels, total] = await Promise.all([
        db.funnel.findMany({
          where,
          skip: offset,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: {
            stages: { orderBy: { order: "asc" } },
            _count: { select: { leads: true } },
            followUpAgent: { select: { id: true, isActive: true, name: true } },
          },
        }),
        db.funnel.count({ where }),
      ]);

      return formatResponse({
        data: {
          funnels,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
            hasNext: page * limit < total,
            hasPrev: page > 1,
          },
        },
        message: "Funis listados com sucesso",
      });
    } catch (error: any) {
      logError("Error listing funnels", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao listar funis",
        })
      );
    }
  });

  // GET /funnel/user/:userId - List funnels by user
  fastify.get("/user/:userId", async (request, reply) => {
    try {
      const { userId } = request.params as { userId: string };

      const funnels = await db.funnel.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        include: {
          stages: { orderBy: { order: "asc" } },
          _count: { select: { leads: true } },
          followUpAgent: { select: { id: true, isActive: true, name: true } },
        },
      });

      return formatResponse({
        data: funnels,
        message: "Funis do usuário listados com sucesso",
      });
    } catch (error: any) {
      logError("Error listing user funnels", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao listar funis do usuário",
        })
      );
    }
  });

  // GET /funnel/:id - Get single funnel with all data
  fastify.get("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const funnel = await db.funnel.findUnique({
        where: { id },
        include: {
          stages: {
            orderBy: { order: "asc" },
            include: {
              leads: {
                orderBy: { order: "asc" },
                include: {
                  _count: { select: { followUps: true } },
                },
              },
            },
          },
          followUpAgent: true,
          _count: { select: { leads: true } },
        },
      });

      if (!funnel) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Funil não encontrado",
          })
        );
      }

      // Calculate stats
      const stats = {
        totalLeads: funnel._count.leads,
        totalValue: funnel.stages.reduce(
          (acc, stage) => acc + stage.leads.reduce((sum, lead) => sum + (lead.value || 0), 0),
          0
        ),
        wonLeads: funnel.stages.find((s) => s.fixedType === "won")?.leads.length || 0,
        lostLeads: funnel.stages.find((s) => s.fixedType === "lost")?.leads.length || 0,
      };

      return formatResponse({
        data: { ...funnel, stats },
        message: "Funil encontrado",
      });
    } catch (error: any) {
      logError("Error getting funnel", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar funil",
        })
      );
    }
  });

  // POST /funnel - Create new funnel with default stages
  fastify.post("/", async (request, reply) => {
    try {
      const data = funnelSchema.parse(request.body);

      const funnel = await db.funnel.create({
        data,
        include: { stages: true },
      });

      // Create default stages
      await createDefaultStages(funnel.id);

      // Fetch updated funnel with stages
      const updatedFunnel = await db.funnel.findUnique({
        where: { id: funnel.id },
        include: { stages: { orderBy: { order: "asc" } } },
      });

      logInfo("Funnel created", { funnelId: funnel.id, userId: data.userId });
      return reply.code(201).send(
        formatResponse({
          data: updatedFunnel,
          message: "Funil criado com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error creating funnel", error);
      if (error instanceof z.ZodError) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Dados inválidos",
            data: error.errors,
          })
        );
      }
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao criar funil",
        })
      );
    }
  });

  // PUT /funnel/:id - Update funnel
  fastify.put("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const data = updateFunnelSchema.parse(request.body);

      const funnel = await db.funnel.update({
        where: { id },
        data,
        include: { stages: { orderBy: { order: "asc" } } },
      });

      logInfo("Funnel updated", { funnelId: id });
      return formatResponse({
        data: funnel,
        message: "Funil atualizado com sucesso",
      });
    } catch (error: any) {
      logError("Error updating funnel", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao atualizar funil",
        })
      );
    }
  });

  // DELETE /funnel/:id - Delete funnel
  fastify.delete("/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      await db.funnel.delete({ where: { id } });

      logInfo("Funnel deleted", { funnelId: id });
      return formatResponse({
        message: "Funil excluído com sucesso",
      });
    } catch (error: any) {
      logError("Error deleting funnel", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao excluir funil",
        })
      );
    }
  });

  // ========================================
  // STAGE ROUTES
  // ========================================

  // POST /funnel/:funnelId/stage - Create new stage
  fastify.post("/:funnelId/stage", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const data = stageSchema.parse(request.body);

      // Don't allow creating fixed stages manually
      if (data.isFixed) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Não é permitido criar estágios fixos manualmente",
          })
        );
      }

      const stage = await db.funnelStage.create({
        data: { funnelId, ...data },
      });

      logInfo("Stage created", { stageId: stage.id, funnelId });
      return reply.code(201).send(
        formatResponse({
          data: stage,
          message: "Estágio criado com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error creating stage", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao criar estágio",
        })
      );
    }
  });

  // PUT /funnel/stage/:id - Update stage
  fastify.put("/stage/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const data = updateStageSchema.parse(request.body);

      // Check if trying to update a fixed stage
      const existing = await db.funnelStage.findUnique({ where: { id } });
      if (existing?.isFixed && (data.isFixed !== undefined || data.fixedType !== undefined)) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Não é permitido alterar configurações de estágios fixos",
          })
        );
      }

      const stage = await db.funnelStage.update({
        where: { id },
        data: {
          name: data.name,
          color: data.color,
          order: data.order,
        },
      });

      logInfo("Stage updated", { stageId: id });
      return formatResponse({
        data: stage,
        message: "Estágio atualizado com sucesso",
      });
    } catch (error: any) {
      logError("Error updating stage", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao atualizar estágio",
        })
      );
    }
  });

  // DELETE /funnel/stage/:id - Delete stage (not fixed)
  fastify.delete("/stage/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      const stage = await db.funnelStage.findUnique({ where: { id } });
      if (stage?.isFixed) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Não é permitido excluir estágios fixos",
          })
        );
      }

      // Move leads to first non-fixed stage before deleting
      const firstStage = await db.funnelStage.findFirst({
        where: { funnelId: stage?.funnelId, isFixed: false, id: { not: id } },
        orderBy: { order: "asc" },
      });

      if (firstStage) {
        await db.funnelLead.updateMany({
          where: { stageId: id },
          data: { stageId: firstStage.id },
        });
      }

      await db.funnelStage.delete({ where: { id } });

      logInfo("Stage deleted", { stageId: id });
      return formatResponse({
        message: "Estágio excluído com sucesso",
      });
    } catch (error: any) {
      logError("Error deleting stage", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao excluir estágio",
        })
      );
    }
  });

  // PUT /funnel/:funnelId/stages/reorder - Reorder stages
  fastify.put("/:funnelId/stages/reorder", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const { stages } = request.body as { stages: { id: string; order: number }[] };

      // Update each stage order (except fixed stages)
      await Promise.all(
        stages.map(async ({ id, order }) => {
          const stage = await db.funnelStage.findUnique({ where: { id } });
          if (!stage?.isFixed) {
            await db.funnelStage.update({ where: { id }, data: { order } });
          }
        })
      );

      const updatedStages = await db.funnelStage.findMany({
        where: { funnelId },
        orderBy: { order: "asc" },
      });

      return formatResponse({
        data: updatedStages,
        message: "Ordem dos estágios atualizada",
      });
    } catch (error: any) {
      logError("Error reordering stages", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao reordenar estágios",
        })
      );
    }
  });

  // ========================================
  // LEAD ROUTES
  // ========================================

  // POST /funnel/:funnelId/lead - Create new lead
  fastify.post("/:funnelId/lead", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const data = leadSchema.parse(request.body);

      const lead = await db.funnelLead.create({
        data: {
          funnelId,
          ...data,
          expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
        },
        include: { stage: true },
      });

      logInfo("Lead created", { leadId: lead.id, funnelId });
      return reply.code(201).send(
        formatResponse({
          data: lead,
          message: "Lead criado com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error creating lead", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao criar lead",
        })
      );
    }
  });

  // PUT /funnel/lead/:id - Update lead
  fastify.put("/lead/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const data = updateLeadSchema.parse(request.body);

      const lead = await db.funnelLead.update({
        where: { id },
        data: {
          ...data,
          expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : undefined,
        },
        include: { stage: true },
      });

      logInfo("Lead updated", { leadId: id });
      return formatResponse({
        data: lead,
        message: "Lead atualizado com sucesso",
      });
    } catch (error: any) {
      logError("Error updating lead", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao atualizar lead",
        })
      );
    }
  });

  // PUT /funnel/lead/:id/move - Move lead to different stage
  fastify.put("/lead/:id/move", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };
      const { stageId, order } = moveLeadSchema.parse(request.body);

      const lead = await db.funnelLead.update({
        where: { id },
        data: { stageId, order },
        include: { stage: true },
      });

      // Update lastContactAt when moved
      await db.funnelLead.update({
        where: { id },
        data: { lastContactAt: new Date() },
      });

      logInfo("Lead moved", { leadId: id, newStageId: stageId });
      return formatResponse({
        data: lead,
        message: "Lead movido com sucesso",
      });
    } catch (error: any) {
      logError("Error moving lead", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao mover lead",
        })
      );
    }
  });

  // DELETE /funnel/lead/:id - Delete lead
  fastify.delete("/lead/:id", async (request, reply) => {
    try {
      const { id } = request.params as { id: string };

      await db.funnelLead.delete({ where: { id } });

      logInfo("Lead deleted", { leadId: id });
      return formatResponse({
        message: "Lead excluído com sucesso",
      });
    } catch (error: any) {
      logError("Error deleting lead", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao excluir lead",
        })
      );
    }
  });

  // ========================================
  // FOLLOW-UP AGENT ROUTES
  // ========================================

  // GET /funnel/:funnelId/follow-up-agent - Get follow-up agent
  fastify.get("/:funnelId/follow-up-agent", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };

      const agent = await db.followUpAgent.findUnique({
        where: { funnelId },
        include: {
          followUpHistory: {
            orderBy: { createdAt: "desc" },
            take: 50,
            include: { lead: { select: { name: true, phone: true } } },
          },
        },
      });

      return formatResponse({
        data: agent,
        message: "Agente de follow-up encontrado",
      });
    } catch (error: any) {
      logError("Error getting follow-up agent", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar agente",
        })
      );
    }
  });

  // POST /funnel/:funnelId/follow-up-agent - Create or update follow-up agent
  fastify.post("/:funnelId/follow-up-agent", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const data = followUpAgentSchema.parse(request.body);

      const agent = await db.followUpAgent.upsert({
        where: { funnelId },
        create: { funnelId, ...data },
        update: data,
      });

      logInfo("Follow-up agent created/updated", { agentId: agent.id, funnelId });
      return formatResponse({
        data: agent,
        message: "Agente de follow-up salvo com sucesso",
      });
    } catch (error: any) {
      logError("Error creating/updating follow-up agent", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao salvar agente",
        })
      );
    }
  });

  // PATCH /funnel/:funnelId/follow-up-agent/toggle - Toggle agent active status
  fastify.patch("/:funnelId/follow-up-agent/toggle", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };

      const current = await db.followUpAgent.findUnique({ where: { funnelId } });
      if (!current) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Agente de follow-up não encontrado",
          })
        );
      }

      const agent = await db.followUpAgent.update({
        where: { funnelId },
        data: { isActive: !current.isActive },
      });

      logInfo("Follow-up agent toggled", { agentId: agent.id, isActive: agent.isActive });
      return formatResponse({
        data: agent,
        message: `Agente ${agent.isActive ? "ativado" : "desativado"}`,
      });
    } catch (error: any) {
      logError("Error toggling follow-up agent", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao alternar agente",
        })
      );
    }
  });

  // POST /funnel/lead/:leadId/send-follow-up - Manually trigger follow-up for a lead
  fastify.post("/lead/:leadId/send-follow-up", async (request, reply) => {
    try {
      const { leadId } = request.params as { leadId: string };
      const { message } = request.body as { message?: string };

      const lead = await db.funnelLead.findUnique({
        where: { id: leadId },
        include: {
          funnel: { include: { followUpAgent: true } },
          stage: true,
        },
      });

      if (!lead) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado",
          })
        );
      }

      const agent = lead.funnel.followUpAgent;
      if (!agent) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Funil não possui agente de follow-up configurado",
          })
        );
      }

      // Create follow-up history entry
      const followUp = await db.followUpHistory.create({
        data: {
          leadId,
          agentId: agent.id,
          message: message || "Follow-up manual",
          status: "pending",
        },
      });

      // TODO: Integrate with OpenAI and Evolution API to send actual message
      // This is a placeholder for the actual implementation

      logInfo("Follow-up triggered", { leadId, agentId: agent.id });
      return formatResponse({
        data: followUp,
        message: "Follow-up enviado para processamento",
      });
    } catch (error: any) {
      logError("Error sending follow-up", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao enviar follow-up",
        })
      );
    }
  });

  // GET /funnel/:funnelId/follow-up-history - Get follow-up history
  fastify.get("/:funnelId/follow-up-history", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const { page, limit } = querySchema.parse(request.query);
      const offset = (page - 1) * limit;

      const agent = await db.followUpAgent.findUnique({ where: { funnelId } });
      if (!agent) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Agente de follow-up não encontrado",
          })
        );
      }

      const [history, total] = await Promise.all([
        db.followUpHistory.findMany({
          where: { agentId: agent.id },
          skip: offset,
          take: limit,
          orderBy: { createdAt: "desc" },
          include: { lead: { select: { name: true, phone: true, email: true } } },
        }),
        db.followUpHistory.count({ where: { agentId: agent.id } }),
      ]);

      return formatResponse({
        data: {
          history,
          pagination: {
            page,
            limit,
            total,
            totalPages: Math.ceil(total / limit),
          },
        },
        message: "Histórico de follow-ups",
      });
    } catch (error: any) {
      logError("Error getting follow-up history", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar histórico",
        })
      );
    }
  });
}
