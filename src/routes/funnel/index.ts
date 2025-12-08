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
// FOLLOW-UP FLOW SCHEMAS
// ========================================

const followUpFlowStepSchema = z.object({
  name: z.string().min(1),
  order: z.number(),
  delayDays: z.number().min(0).default(0),
  delayHours: z.number().min(0).max(23).default(0),
  messageTemplate: z.string().optional(),
  isAutomatic: z.boolean().optional().default(false),
  color: z.string().default("#6366f1"),
  type: z.enum(["followup", "won", "lost"]).default("followup"),
});

const updateFollowUpFlowStepSchema = followUpFlowStepSchema.partial();

const addLeadToFlowSchema = z.object({
  leadId: z.string(),
  stepId: z.string().optional(), // Se não fornecido, adiciona ao primeiro passo
});

const moveLeadInFlowSchema = z.object({
  stepId: z.string(),
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

  // ========================================
  // FOLLOW-UP FLOW ROUTES
  // ========================================

  // GET /funnel/:funnelId/follow-up-flow/steps - Get flow steps
  fastify.get("/:funnelId/follow-up-flow/steps", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };

      const steps = await db.followUpFlowStep.findMany({
        where: { funnelId },
        orderBy: { order: "asc" },
      });

      return formatResponse({
        data: steps,
        message: "Etapas do fluxo listadas",
      });
    } catch (error: any) {
      logError("Error getting flow steps", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar etapas do fluxo",
        })
      );
    }
  });

  // POST /funnel/:funnelId/follow-up-flow/steps - Create flow step
  fastify.post("/:funnelId/follow-up-flow/steps", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const data = followUpFlowStepSchema.parse(request.body);

      const step = await db.followUpFlowStep.create({
        data: { funnelId, ...data },
      });

      logInfo("Flow step created", { stepId: step.id, funnelId });
      return reply.code(201).send(
        formatResponse({
          data: step,
          message: "Etapa criada com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error creating flow step", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao criar etapa",
        })
      );
    }
  });

  // PUT /funnel/follow-up-flow/steps/:stepId - Update flow step
  fastify.put("/follow-up-flow/steps/:stepId", async (request, reply) => {
    try {
      const { stepId } = request.params as { stepId: string };
      const data = updateFollowUpFlowStepSchema.parse(request.body);

      const step = await db.followUpFlowStep.update({
        where: { id: stepId },
        data,
      });

      logInfo("Flow step updated", { stepId });
      return formatResponse({
        data: step,
        message: "Etapa atualizada com sucesso",
      });
    } catch (error: any) {
      logError("Error updating flow step", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao atualizar etapa",
        })
      );
    }
  });

  // DELETE /funnel/follow-up-flow/steps/:stepId - Delete flow step
  fastify.delete("/follow-up-flow/steps/:stepId", async (request, reply) => {
    try {
      const { stepId } = request.params as { stepId: string };

      // Get step to check type
      const step = await db.followUpFlowStep.findUnique({ where: { id: stepId } });
      if (!step) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Etapa não encontrada",
          })
        );
      }

      // Don't allow deleting won/lost steps
      if (step.type === "won" || step.type === "lost") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Não é permitido excluir etapas de ganho ou perdido",
          })
        );
      }

      // Move leads to first follow-up step before deleting
      const firstStep = await db.followUpFlowStep.findFirst({
        where: { funnelId: step.funnelId, type: "followup", id: { not: stepId } },
        orderBy: { order: "asc" },
      });

      if (firstStep) {
        await db.leadInFollowUpFlow.updateMany({
          where: { currentStepId: stepId },
          data: { currentStepId: firstStep.id },
        });
      }

      await db.followUpFlowStep.delete({ where: { id: stepId } });

      logInfo("Flow step deleted", { stepId });
      return formatResponse({
        message: "Etapa excluída com sucesso",
      });
    } catch (error: any) {
      logError("Error deleting flow step", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao excluir etapa",
        })
      );
    }
  });

  // POST /funnel/:funnelId/follow-up-flow/initialize - Initialize default flow steps
  fastify.post("/:funnelId/follow-up-flow/initialize", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };

      // Check if steps already exist
      const existingSteps = await db.followUpFlowStep.count({ where: { funnelId } });
      if (existingSteps > 0) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Fluxo já foi inicializado",
          })
        );
      }

      // Create default steps
      const defaultSteps = [
        { name: "1º Contato", order: 0, delayDays: 0, delayHours: 0, isAutomatic: false, color: "#3b82f6", type: "followup" },
        { name: "Follow-up 3 dias", order: 1, delayDays: 3, delayHours: 0, isAutomatic: true, color: "#8b5cf6", type: "followup" },
        { name: "Follow-up 7 dias", order: 2, delayDays: 7, delayHours: 0, isAutomatic: true, color: "#f59e0b", type: "followup" },
        { name: "Último contato", order: 3, delayDays: 1, delayHours: 0, isAutomatic: true, color: "#ef4444", type: "followup" },
        { name: "Ganho", order: 100, delayDays: 0, delayHours: 0, isAutomatic: false, color: "#22c55e", type: "won" },
        { name: "Perdido", order: 101, delayDays: 0, delayHours: 0, isAutomatic: false, color: "#dc2626", type: "lost" },
      ];

      await db.followUpFlowStep.createMany({
        data: defaultSteps.map((step) => ({ funnelId, ...step })),
      });

      const steps = await db.followUpFlowStep.findMany({
        where: { funnelId },
        orderBy: { order: "asc" },
      });

      logInfo("Flow initialized", { funnelId, stepsCount: steps.length });
      return reply.code(201).send(
        formatResponse({
          data: steps,
          message: "Fluxo inicializado com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error initializing flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao inicializar fluxo",
        })
      );
    }
  });

  // GET /funnel/:funnelId/follow-up-flow/leads - Get leads in flow
  fastify.get("/:funnelId/follow-up-flow/leads", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };

      const leadsInFlow = await db.leadInFollowUpFlow.findMany({
        where: { funnelId },
        include: {
          lead: true,
          currentStep: true,
        },
        orderBy: { createdAt: "desc" },
      });

      return formatResponse({
        data: leadsInFlow,
        message: "Leads no fluxo listados",
      });
    } catch (error: any) {
      logError("Error getting leads in flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar leads no fluxo",
        })
      );
    }
  });

  // POST /funnel/:funnelId/follow-up-flow/leads - Add lead to flow
  fastify.post("/:funnelId/follow-up-flow/leads", async (request, reply) => {
    try {
      const { funnelId } = request.params as { funnelId: string };
      const { leadId, stepId } = addLeadToFlowSchema.parse(request.body);

      // Check if lead exists
      const lead = await db.funnelLead.findUnique({ where: { id: leadId } });
      if (!lead) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado",
          })
        );
      }

      // Check if lead is already in flow
      const existingEntry = await db.leadInFollowUpFlow.findUnique({
        where: { leadId_funnelId: { leadId, funnelId } },
      });
      if (existingEntry) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Lead já está no fluxo de follow-up",
          })
        );
      }

      // Get target step (first step if not provided)
      let targetStepId = stepId;
      if (!targetStepId) {
        const firstStep = await db.followUpFlowStep.findFirst({
          where: { funnelId, type: "followup" },
          orderBy: { order: "asc" },
        });
        if (!firstStep) {
          return reply.code(400).send(
            formatResponse({
              success: false,
              error: "Fluxo não possui etapas. Inicialize o fluxo primeiro.",
            })
          );
        }
        targetStepId = firstStep.id;
      }

      // Get step to calculate next follow-up date
      const step = await db.followUpFlowStep.findUnique({ where: { id: targetStepId } });
      if (!step) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Etapa não encontrada",
          })
        );
      }

      // Calculate next follow-up date
      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + step.delayDays);
      nextFollowUpAt.setHours(nextFollowUpAt.getHours() + step.delayHours);

      const leadInFlow = await db.leadInFollowUpFlow.create({
        data: {
          leadId,
          funnelId,
          currentStepId: targetStepId,
          nextFollowUpAt: step.delayDays > 0 || step.delayHours > 0 ? nextFollowUpAt : null,
        },
        include: {
          lead: true,
          currentStep: true,
        },
      });

      logInfo("Lead added to flow", { leadId, funnelId, stepId: targetStepId });
      return reply.code(201).send(
        formatResponse({
          data: leadInFlow,
          message: "Lead adicionado ao fluxo com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error adding lead to flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao adicionar lead ao fluxo",
        })
      );
    }
  });

  // PUT /funnel/follow-up-flow/leads/:leadFlowId/move - Move lead to different step
  fastify.put("/follow-up-flow/leads/:leadFlowId/move", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };
      const { stepId } = moveLeadInFlowSchema.parse(request.body);

      // Get step to calculate next follow-up date
      const step = await db.followUpFlowStep.findUnique({ where: { id: stepId } });
      if (!step) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Etapa não encontrada",
          })
        );
      }

      // Calculate next follow-up date
      const nextFollowUpAt = new Date();
      nextFollowUpAt.setDate(nextFollowUpAt.getDate() + step.delayDays);
      nextFollowUpAt.setHours(nextFollowUpAt.getHours() + step.delayHours);

      // Determine status based on step type
      let status = "active";
      let completedAt = null;
      if (step.type === "won") {
        status = "completed";
        completedAt = new Date();
      } else if (step.type === "lost") {
        status = "lost";
        completedAt = new Date();
      }

      const leadInFlow = await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: {
          currentStepId: stepId,
          nextFollowUpAt: step.type === "followup" && (step.delayDays > 0 || step.delayHours > 0) ? nextFollowUpAt : null,
          status,
          completedAt,
        },
        include: {
          lead: true,
          currentStep: true,
        },
      });

      logInfo("Lead moved in flow", { leadFlowId, newStepId: stepId });
      return formatResponse({
        data: leadInFlow,
        message: "Lead movido com sucesso",
      });
    } catch (error: any) {
      logError("Error moving lead in flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao mover lead no fluxo",
        })
      );
    }
  });

  // PATCH /funnel/follow-up-flow/leads/:leadFlowId/toggle-pause - Pause/resume lead in flow
  fastify.patch("/follow-up-flow/leads/:leadFlowId/toggle-pause", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      const current = await db.leadInFollowUpFlow.findUnique({ where: { id: leadFlowId } });
      if (!current) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      // Can only pause/resume active or paused leads
      if (current.status !== "active" && current.status !== "paused") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Não é possível pausar/retomar um lead que já foi concluído",
          })
        );
      }

      const newStatus = current.status === "active" ? "paused" : "active";
      const leadInFlow = await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: { status: newStatus },
        include: {
          lead: true,
          currentStep: true,
        },
      });

      logInfo("Lead pause toggled", { leadFlowId, newStatus });
      return formatResponse({
        data: leadInFlow,
        message: `Lead ${newStatus === "paused" ? "pausado" : "retomado"} com sucesso`,
      });
    } catch (error: any) {
      logError("Error toggling lead pause", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao pausar/retomar lead",
        })
      );
    }
  });

  // DELETE /funnel/follow-up-flow/leads/:leadFlowId - Remove lead from flow
  fastify.delete("/follow-up-flow/leads/:leadFlowId", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      await db.leadInFollowUpFlow.delete({ where: { id: leadFlowId } });

      logInfo("Lead removed from flow", { leadFlowId });
      return formatResponse({
        message: "Lead removido do fluxo com sucesso",
      });
    } catch (error: any) {
      logError("Error removing lead from flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao remover lead do fluxo",
        })
      );
    }
  });

  // POST /funnel/follow-up-flow/leads/:leadFlowId/send - Send follow-up message
  fastify.post("/follow-up-flow/leads/:leadFlowId/send", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      const leadInFlow = await db.leadInFollowUpFlow.findUnique({
        where: { id: leadFlowId },
        include: {
          lead: true,
          currentStep: true,
          funnel: { include: { followUpAgent: true } },
        },
      });

      if (!leadInFlow) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      const agent = leadInFlow.funnel.followUpAgent;
      if (!agent) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Funil não possui agente de follow-up configurado",
          })
        );
      }

      // Create follow-up history entry
      const message = leadInFlow.currentStep.messageTemplate || "Follow-up manual";
      const followUp = await db.followUpHistory.create({
        data: {
          leadId: leadInFlow.leadId,
          agentId: agent.id,
          message,
          status: "pending",
        },
        include: {
          lead: { select: { name: true, phone: true, email: true } },
        },
      });

      // Update lead in flow
      await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: {
          followUpCount: { increment: 1 },
          lastFollowUpAt: new Date(),
        },
      });

      // TODO: Integrate with OpenAI and Evolution API to send actual message

      logInfo("Follow-up sent from flow", { leadFlowId, agentId: agent.id });
      return formatResponse({
        data: followUp,
        message: "Follow-up enviado para processamento",
      });
    } catch (error: any) {
      logError("Error sending follow-up from flow", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao enviar follow-up",
        })
      );
    }
  });

  // PATCH /funnel/follow-up-flow/leads/:leadFlowId/won - Mark lead as won
  fastify.patch("/follow-up-flow/leads/:leadFlowId/won", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      const current = await db.leadInFollowUpFlow.findUnique({
        where: { id: leadFlowId },
        include: { funnel: true },
      });

      if (!current) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      // Find won step
      const wonStep = await db.followUpFlowStep.findFirst({
        where: { funnelId: current.funnelId, type: "won" },
      });

      if (!wonStep) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Etapa de ganho não encontrada no fluxo",
          })
        );
      }

      const leadInFlow = await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: {
          currentStepId: wonStep.id,
          status: "completed",
          completedAt: new Date(),
          nextFollowUpAt: null,
        },
        include: {
          lead: true,
          currentStep: true,
        },
      });

      logInfo("Lead marked as won in flow", { leadFlowId });
      return formatResponse({
        data: leadInFlow,
        message: "Lead marcado como ganho",
      });
    } catch (error: any) {
      logError("Error marking lead as won", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao marcar lead como ganho",
        })
      );
    }
  });

  // PATCH /funnel/follow-up-flow/leads/:leadFlowId/lost - Mark lead as lost
  fastify.patch("/follow-up-flow/leads/:leadFlowId/lost", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      const current = await db.leadInFollowUpFlow.findUnique({
        where: { id: leadFlowId },
        include: { funnel: true },
      });

      if (!current) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      // Find lost step
      const lostStep = await db.followUpFlowStep.findFirst({
        where: { funnelId: current.funnelId, type: "lost" },
      });

      if (!lostStep) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Etapa de perdido não encontrada no fluxo",
          })
        );
      }

      const leadInFlow = await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: {
          currentStepId: lostStep.id,
          status: "lost",
          completedAt: new Date(),
          nextFollowUpAt: null,
        },
        include: {
          lead: true,
          currentStep: true,
        },
      });

      logInfo("Lead marked as lost in flow", { leadFlowId });
      return formatResponse({
        data: leadInFlow,
        message: "Lead marcado como perdido",
      });
    } catch (error: any) {
      logError("Error marking lead as lost", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao marcar lead como perdido",
        })
      );
    }
  });
}
