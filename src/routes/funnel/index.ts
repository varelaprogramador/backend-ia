import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse } from "@/utils/response-formatter";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { rdstationWebhookService } from "@/services/rdstation-webhook.service";
import { rdstationDealsService } from "@/services/rdstation-deals.service";

// ========================================
// SCHEMAS
// ========================================

// Schema para stages do Kommo
const kommoStageSchema = z.object({
  id: z.number(),
  name: z.string(),
  sort: z.number(),
  color: z.string(),
});

// Schema para stages do RD Station
const rdstationStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  nickname: z.string().optional(),
  order: z.number().optional(),
});

// Schema para deals do RD Station
// Status do RD Station: won (ganho), lost (perdido), ongoing (em andamento)
const rdstationDealSchema = z.object({
  id: z.string(),
  name: z.string(),
  recurrence_price: z.number().optional(),
  one_time_price: z.number().optional(),
  total_price: z.number().optional(),
  expected_close_date: z.string().optional().nullable(),
  rating: z.number().optional(),
  status: z.enum(["won", "lost", "pending", "ongoing"]).optional(),
  pipeline_id: z.string(),
  stage_id: z.string(),
  owner_id: z.string().optional().nullable(),
  source_id: z.string().optional().nullable(),
  organization_id: z.string().optional().nullable(),
  contact_ids: z.array(z.string()).optional().default([]),
  custom_fields: z.record(z.any()).optional(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
});

const funnelSchema = z.object({
  userId: z.string(),
  name: z.string().min(1),
  description: z.string().optional(),
  isActive: z.boolean().optional().default(true),
  configIaId: z.string().optional().nullable(), // Vinculacao com Agente/Workspace
  // Vinculacao com Pipeline do Kommo
  kommoPipelineId: z.string().optional().nullable(),
  kommoPipelineName: z.string().optional().nullable(),
  kommoStages: z.array(kommoStageSchema).optional().default([]),
  // Vinculacao com Pipeline do RD Station CRM
  rdstationPipelineId: z.string().optional().nullable(),
  rdstationPipelineName: z.string().optional().nullable(),
  rdstationOwnerId: z.string().optional().nullable(), // ID do usuario responsavel pelos deals
  rdstationOwnerName: z.string().optional().nullable(), // Nome do usuario (para exibicao)
  rdstationStages: z.array(rdstationStageSchema).optional().default([]),
  rdstationDeals: z.array(rdstationDealSchema).optional().default([]), // Deals para importar como leads
  rdstationWebhookIds: z.array(z.string()).optional().default([]), // IDs dos webhooks criados no RD Station
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

const leadSchemaWithWhatsApp = leadSchema.extend({
  whatsappJid: z.string().optional(),
  whatsappProfileName: z.string().optional(),
  whatsappProfilePic: z.string().optional(),
  evolutionInstanceId: z.string().optional(),
});

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

const createContactSchema = z.object({
  contactType: z.enum(["message", "call", "email", "whatsapp", "manual"]).default("message"),
  message: z.string().optional(),
  response: z.string().optional(),
  status: z.enum(["sent", "delivered", "read", "replied", "failed"]).default("sent"),
  isAutomatic: z.boolean().default(false),
  outcome: z.enum(["positive", "negative", "neutral", "no_response"]).optional(),
  notes: z.string().optional(),
  moveToNextStep: z.boolean().default(false), // Se deve mover para próxima etapa automaticamente
});

// ========================================
// HELPER: Create stages
// ========================================

// Tipo para stages do Kommo
interface KommoStage {
  id: number;
  name: string;
  sort: number;
  color: string;
}

// Tipo para stages do RD Station
interface RDStationStage {
  id: string;
  name: string;
  nickname?: string;
  order?: number;
}

// Tipo para deals do RD Station
// Status do RD Station: won (ganho), lost (perdido), ongoing (em andamento)
interface RDStationDeal {
  id: string;
  name: string;
  recurrence_price?: number;
  one_time_price?: number;
  total_price?: number;
  expected_close_date?: string | null;
  rating?: number;
  status?: "won" | "lost" | "pending" | "ongoing";
  pipeline_id: string;
  stage_id: string;
  owner_id?: string | null;
  source_id?: string | null;
  organization_id?: string | null;
  contact_ids?: string[];
  custom_fields?: Record<string, any>;
  created_at?: string;
  updated_at?: string;
}

// Cores padrão para stages quando não fornecidas
const stageColors = [
  "#3b82f6", // blue
  "#8b5cf6", // violet
  "#f59e0b", // amber
  "#ec4899", // pink
  "#14b8a6", // teal
  "#f97316", // orange
  "#6366f1", // indigo
  "#84cc16", // lime
];

async function createStagesFromCRM(
  funnelId: string,
  kommoStages: KommoStage[],
  rdstationStages: RDStationStage[]
) {
  let stages: { name: string; color: string; order: number; isFixed: boolean; fixedType?: string; rdstationStageId?: string }[] = [];

  // Se tiver stages do Kommo, usar eles
  if (kommoStages && kommoStages.length > 0) {
    stages = kommoStages
      .sort((a, b) => a.sort - b.sort)
      .map((stage, index) => ({
        name: stage.name,
        color: stage.color || stageColors[index % stageColors.length],
        order: index,
        isFixed: false,
      }));
  }
  // Se tiver stages do RD Station, usar eles
  else if (rdstationStages && rdstationStages.length > 0) {
    stages = rdstationStages
      .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
      .map((stage, index) => ({
        name: stage.nickname || stage.name,
        color: stageColors[index % stageColors.length],
        order: index,
        isFixed: false,
        rdstationStageId: stage.id, // Salvar o ID do stage do RD Station
      }));
  }
  // Caso contrário, usar stages padrão
  else {
    stages = [
      { name: "Novo Lead", color: "#3b82f6", order: 0, isFixed: false },
      { name: "Contato Inicial", color: "#8b5cf6", order: 1, isFixed: false },
      { name: "Proposta Enviada", color: "#f59e0b", order: 2, isFixed: false },
      { name: "Negociação", color: "#ec4899", order: 3, isFixed: false },
    ];
  }

  // Sempre adicionar estágios fixos de Ganho e Perdido no final
  const fixedStages = [
    { name: "Ganho", color: "#22c55e", order: 100, isFixed: true, fixedType: "won" },
    { name: "Perdido", color: "#ef4444", order: 101, isFixed: true, fixedType: "lost" },
  ];

  const allStages = [...stages, ...fixedStages];

  await db.funnelStage.createMany({
    data: allStages.map((stage) => ({
      funnelId,
      ...stage,
    })),
  });
}

/**
 * Cria leads a partir dos deals do RD Station
 * Mapeia o stage_id do RD Station para o stage do funil criado
 */
async function createLeadsFromRDStationDeals(
  funnelId: string,
  rdstationDeals: RDStationDeal[],
  rdstationStages: RDStationStage[]
) {
  if (!rdstationDeals || rdstationDeals.length === 0) {
    return;
  }

  // Buscar os stages criados no funil
  const funnelStages = await db.funnelStage.findMany({
    where: { funnelId },
    orderBy: { order: "asc" },
  });

  // Criar mapa de stage_id do RD Station para stage_id do funil
  // O índice do stage no RD Station corresponde ao índice do stage no funil
  const stageMap = new Map<string, string>();

  // Ordenar os stages do RD Station pela ordem
  const sortedRdStages = [...rdstationStages].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  // Mapear cada stage_id do RD Station para o stage correspondente no funil
  sortedRdStages.forEach((rdStage, index) => {
    const funnelStage = funnelStages[index];
    if (funnelStage && !funnelStage.isFixed) {
      stageMap.set(rdStage.id, funnelStage.id);
    }
  });

  // Encontrar o primeiro stage do funil como fallback
  const firstStage = funnelStages.find((s) => !s.isFixed);
  const wonStage = funnelStages.find((s) => s.fixedType === "won");
  const lostStage = funnelStages.find((s) => s.fixedType === "lost");

  // Criar leads a partir dos deals
  const leadsToCreate = rdstationDeals.map((deal, index) => {
    // Determinar o stage baseado no status do deal ou no stage_id
    let stageId: string;

    if (deal.status === "won" && wonStage) {
      stageId = wonStage.id;
    } else if (deal.status === "lost" && lostStage) {
      stageId = lostStage.id;
    } else {
      // Usar o mapeamento de stages ou o primeiro stage como fallback
      stageId = stageMap.get(deal.stage_id) || firstStage?.id || funnelStages[0]?.id;
    }

    return {
      funnelId,
      stageId,
      name: deal.name,
      value: deal.total_price ?? 0,
      source: "RD Station CRM",
      priority: deal.rating && deal.rating >= 4 ? "high" : deal.rating && deal.rating >= 2 ? "medium" : "low",
      expectedCloseDate: deal.expected_close_date ? new Date(deal.expected_close_date) : null,
      order: index,
      notes: `Importado do RD Station - Deal ID: ${deal.id}`,
      rdstationDealId: deal.id, // Salvar o ID do deal do RD Station para sincronização bidirecional
    };
  });

  if (leadsToCreate.length > 0) {
    await db.funnelLead.createMany({
      data: leadsToCreate.filter((lead) => lead.stageId), // Só criar se tiver stageId válido
    });
  }

  logInfo("Leads created from RD Station deals", {
    funnelId,
    dealsCount: rdstationDeals.length,
    leadsCreated: leadsToCreate.length,
  });
}

export default async function (fastify: FastifyInstance) {
  // ========================================
  // FUNNEL STATS ROUTES
  // ========================================

  // GET /funnel/stats/agent/:agentId - Estatísticas dos funis vinculados a um agente
  fastify.get("/stats/agent/:agentId", async (request, reply) => {
    try {
      const { agentId } = request.params as { agentId: string };

      // Buscar todos os funis vinculados a este agente (configIaId)
      const funnels = await db.funnel.findMany({
        where: { configIaId: agentId },
        include: {
          stages: {
            orderBy: { order: "asc" },
          },
          leads: {
            include: {
              stage: true,
            },
          },
          _count: {
            select: { leads: true },
          },
        },
      });

      if (funnels.length === 0) {
        return reply.send(
          formatResponse({
            data: {
              totalFunnels: 0,
              totalLeads: 0,
              totalValue: 0,
              wonLeads: 0,
              wonValue: 0,
              lostLeads: 0,
              conversionRate: 0,
              avgDealValue: 0,
              leadsThisMonth: 0,
              leadsToday: 0,
              funnels: [],
              stageDistribution: [],
              monthlyTrend: [],
              topFunnels: [],
            },
          })
        );
      }

      // Calcular estatísticas gerais
      let totalLeads = 0;
      let totalValue = 0;
      let wonLeads = 0;
      let wonValue = 0;
      let lostLeads = 0;
      let leadsThisMonth = 0;
      let leadsToday = 0;

      const now = new Date();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
      const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

      // Distribuição por estágio (agregado de todos os funis)
      const stageDistributionMap: Record<string, { name: string; count: number; value: number; color: string }> = {};

      // Dados por funil
      const funnelStats = funnels.map((funnel) => {
        const funnelLeads = funnel.leads || [];
        const funnelTotalLeads = funnelLeads.length;
        const funnelTotalValue = funnelLeads.reduce((sum, lead) => sum + (lead.value || 0), 0);

        // Contar leads ganhos/perdidos
        const funnelWonLeads = funnelLeads.filter((lead) => lead.stage?.fixedType === "won").length;
        const funnelWonValue = funnelLeads
          .filter((lead) => lead.stage?.fixedType === "won")
          .reduce((sum, lead) => sum + (lead.value || 0), 0);
        const funnelLostLeads = funnelLeads.filter((lead) => lead.stage?.fixedType === "lost").length;

        // Leads deste mês e hoje
        const funnelLeadsThisMonth = funnelLeads.filter(
          (lead) => new Date(lead.createdAt) >= startOfMonth
        ).length;
        const funnelLeadsToday = funnelLeads.filter(
          (lead) => new Date(lead.createdAt) >= startOfToday
        ).length;

        // Agregar totais
        totalLeads += funnelTotalLeads;
        totalValue += funnelTotalValue;
        wonLeads += funnelWonLeads;
        wonValue += funnelWonValue;
        lostLeads += funnelLostLeads;
        leadsThisMonth += funnelLeadsThisMonth;
        leadsToday += funnelLeadsToday;

        // Distribuição por estágio deste funil
        funnel.stages.forEach((stage) => {
          const stageLeads = funnelLeads.filter((lead) => lead.stageId === stage.id);
          const stageKey = stage.name;

          if (!stageDistributionMap[stageKey]) {
            stageDistributionMap[stageKey] = {
              name: stage.name,
              count: 0,
              value: 0,
              color: stage.color,
            };
          }
          stageDistributionMap[stageKey].count += stageLeads.length;
          stageDistributionMap[stageKey].value += stageLeads.reduce((sum, lead) => sum + (lead.value || 0), 0);
        });

        return {
          id: funnel.id,
          name: funnel.name,
          isActive: funnel.isActive,
          totalLeads: funnelTotalLeads,
          totalValue: funnelTotalValue,
          wonLeads: funnelWonLeads,
          wonValue: funnelWonValue,
          lostLeads: funnelLostLeads,
          conversionRate: funnelTotalLeads > 0 ? (funnelWonLeads / funnelTotalLeads) * 100 : 0,
          rdstationPipelineId: funnel.rdstationPipelineId,
          rdstationPipelineName: funnel.rdstationPipelineName,
          kommoPipelineId: funnel.kommoPipelineId,
          kommoPipelineName: funnel.kommoPipelineName,
        };
      });

      // Calcular tendência mensal (últimos 6 meses)
      const monthlyTrend: { month: string; leads: number; value: number; won: number }[] = [];
      for (let i = 5; i >= 0; i--) {
        const monthDate = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const monthEnd = new Date(now.getFullYear(), now.getMonth() - i + 1, 0, 23, 59, 59);
        const monthName = monthDate.toLocaleDateString("pt-BR", { month: "short", year: "2-digit" });

        let monthLeads = 0;
        let monthValue = 0;
        let monthWon = 0;

        funnels.forEach((funnel) => {
          funnel.leads.forEach((lead) => {
            const leadDate = new Date(lead.createdAt);
            if (leadDate >= monthDate && leadDate <= monthEnd) {
              monthLeads++;
              monthValue += lead.value || 0;
              if (lead.stage?.fixedType === "won") {
                monthWon++;
              }
            }
          });
        });

        monthlyTrend.push({
          month: monthName,
          leads: monthLeads,
          value: monthValue,
          won: monthWon,
        });
      }

      // Converter stageDistribution para array
      const stageDistribution = Object.values(stageDistributionMap);

      // Top funis por valor
      const topFunnels = [...funnelStats]
        .sort((a, b) => b.totalValue - a.totalValue)
        .slice(0, 5);

      const conversionRate = totalLeads > 0 ? (wonLeads / totalLeads) * 100 : 0;
      const avgDealValue = wonLeads > 0 ? wonValue / wonLeads : 0;

      logInfo("Funnel stats for agent retrieved", {
        agentId,
        totalFunnels: funnels.length,
        totalLeads,
      });

      return reply.send(
        formatResponse({
          data: {
            totalFunnels: funnels.length,
            totalLeads,
            totalValue,
            wonLeads,
            wonValue,
            lostLeads,
            conversionRate: Math.round(conversionRate * 100) / 100,
            avgDealValue: Math.round(avgDealValue * 100) / 100,
            leadsThisMonth,
            leadsToday,
            funnels: funnelStats,
            stageDistribution,
            monthlyTrend,
            topFunnels,
          },
        })
      );
    } catch (error: any) {
      logError("Error fetching funnel stats for agent", { error: error.message });
      return reply.code(500).send(
        formatResponse({
          error: "Erro ao buscar estatísticas dos funis",
          message: error.message,
        })
      );
    }
  });

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
            configIa: { select: { id: true, nome: true, status: true } }, // Incluir agente vinculado
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
          configIa: { select: { id: true, nome: true, status: true } }, // Incluir agente vinculado
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
          configIa: { select: { id: true, nome: true, status: true } }, // Incluir agente vinculado
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

  // POST /funnel - Create new funnel with stages from CRM or default stages
  fastify.post("/", async (request, reply) => {
    try {
      const data = funnelSchema.parse(request.body);

      // Extrair stages, deals e webhookIds do CRM antes de criar o funil (não são campos do modelo Funnel na criação)
      const { kommoStages, rdstationStages, rdstationDeals, rdstationWebhookIds: _, ...funnelData } = data;

      const funnel = await db.funnel.create({
        data: funnelData,
        include: { stages: true },
      });

      // Create stages from CRM or default stages
      await createStagesFromCRM(funnel.id, kommoStages || [], rdstationStages || []);

      // Se tiver deals do RD Station, criar leads a partir deles
      if (rdstationDeals && rdstationDeals.length > 0) {
        await createLeadsFromRDStationDeals(funnel.id, rdstationDeals, rdstationStages || []);
      }

      // Se funil vinculado ao RD Station e tem configIaId, criar webhooks automaticamente
      let rdstationWebhookIds: string[] = [];
      if (funnelData.rdstationPipelineId && funnelData.configIaId) {
        try {
          logInfo("Creating RD Station webhooks for funnel", {
            funnelId: funnel.id,
            configIaId: funnelData.configIaId,
            pipelineId: funnelData.rdstationPipelineId,
          });

          rdstationWebhookIds = await rdstationWebhookService.createWebhooksForFunnel({
            configIaId: funnelData.configIaId,
            webhookUrl: "", // Usa URL padrão do serviço
          });

          // Atualizar funil com IDs dos webhooks
          if (rdstationWebhookIds.length > 0) {
            await db.funnel.update({
              where: { id: funnel.id },
              data: { rdstationWebhookIds },
            });
          }

          logInfo("RD Station webhooks created for funnel", {
            funnelId: funnel.id,
            webhookIds: rdstationWebhookIds,
          });
        } catch (webhookError: any) {
          // Não falhar a criação do funil se o webhook falhar
          logWarn("Failed to create RD Station webhooks, funnel created without webhooks", {
            funnelId: funnel.id,
            error: webhookError.message,
          });
        }
      }

      // Fetch updated funnel with stages and leads
      const updatedFunnel = await db.funnel.findUnique({
        where: { id: funnel.id },
        include: {
          stages: { orderBy: { order: "asc" } },
          leads: { orderBy: { order: "asc" } },
          configIa: { select: { id: true, nome: true, status: true } },
          _count: { select: { leads: true } },
        },
      });

      logInfo("Funnel created", {
        funnelId: funnel.id,
        userId: data.userId,
        kommoStagesCount: kommoStages?.length || 0,
        rdstationStagesCount: rdstationStages?.length || 0,
        rdstationDealsCount: rdstationDeals?.length || 0,
        rdstationWebhooksCount: rdstationWebhookIds.length,
      });
      return reply.code(201).send(
        formatResponse({
          data: updatedFunnel,
          message: rdstationWebhookIds.length > 0
            ? "Funil criado com sucesso e webhooks RD Station configurados"
            : "Funil criado com sucesso",
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

      // Buscar funil atual para verificar mudanças no RD Station
      const currentFunnel = await db.funnel.findUnique({
        where: { id },
        select: {
          rdstationPipelineId: true,
          rdstationWebhookIds: true,
          configIaId: true,
        },
      });

      let webhookMessage = "";

      // Verificar se o pipeline do RD Station está sendo desvinculado ou alterado
      const isUnlinkingRdStation = currentFunnel?.rdstationPipelineId &&
        (data.rdstationPipelineId === null || data.rdstationPipelineId === "");
      const isChangingPipeline = currentFunnel?.rdstationPipelineId &&
        data.rdstationPipelineId &&
        data.rdstationPipelineId !== currentFunnel.rdstationPipelineId;

      // Deletar webhooks antigos se desvinculando ou trocando pipeline
      if ((isUnlinkingRdStation || isChangingPipeline) &&
          currentFunnel?.rdstationWebhookIds &&
          currentFunnel.rdstationWebhookIds.length > 0 &&
          currentFunnel.configIaId) {
        try {
          logInfo("Deleting RD Station webhooks due to pipeline change", {
            funnelId: id,
            oldPipelineId: currentFunnel.rdstationPipelineId,
            newPipelineId: data.rdstationPipelineId,
            webhookIds: currentFunnel.rdstationWebhookIds,
          });

          await rdstationWebhookService.deleteWebhooks(currentFunnel.configIaId, currentFunnel.rdstationWebhookIds);

          // Limpar IDs dos webhooks se desvinculando
          if (isUnlinkingRdStation) {
            data.rdstationWebhookIds = [];
          }

          webhookMessage = " e webhooks RD Station removidos";
          logInfo("RD Station webhooks deleted due to pipeline change", { funnelId: id });
        } catch (webhookError: any) {
          logWarn("Failed to delete old RD Station webhooks", {
            funnelId: id,
            error: webhookError.message,
          });
        }
      }

      // Criar novos webhooks se vinculando a um novo pipeline
      const isLinkingNewPipeline = data.rdstationPipelineId &&
        (!currentFunnel?.rdstationPipelineId || isChangingPipeline);
      const configIaId = data.configIaId || currentFunnel?.configIaId;

      if (isLinkingNewPipeline && configIaId) {
        try {
          logInfo("Creating RD Station webhooks for new pipeline link", {
            funnelId: id,
            pipelineId: data.rdstationPipelineId,
            configIaId,
          });

          const newWebhookIds = await rdstationWebhookService.createWebhooksForFunnel({
            configIaId,
            webhookUrl: "",
          });

          if (newWebhookIds.length > 0) {
            data.rdstationWebhookIds = newWebhookIds;
            webhookMessage = " e webhooks RD Station configurados";
          }

          logInfo("RD Station webhooks created for updated funnel", {
            funnelId: id,
            webhookIds: newWebhookIds,
          });
        } catch (webhookError: any) {
          logWarn("Failed to create RD Station webhooks for updated funnel", {
            funnelId: id,
            error: webhookError.message,
          });
        }
      }

      const funnel = await db.funnel.update({
        where: { id },
        data,
        include: {
          stages: { orderBy: { order: "asc" } },
          configIa: { select: { id: true, nome: true, status: true } },
        },
      });

      logInfo("Funnel updated", { funnelId: id });
      return formatResponse({
        data: funnel,
        message: `Funil atualizado com sucesso${webhookMessage}`,
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

      // Buscar funil para verificar se tem webhooks do RD Station
      const funnel = await db.funnel.findUnique({
        where: { id },
        select: {
          rdstationWebhookIds: true,
          configIaId: true,
        },
      });

      // Deletar webhooks do RD Station antes de excluir o funil
      if (funnel?.rdstationWebhookIds && funnel.rdstationWebhookIds.length > 0 && funnel.configIaId) {
        try {
          logInfo("Deleting RD Station webhooks before funnel deletion", {
            funnelId: id,
            webhookIds: funnel.rdstationWebhookIds,
          });

          await rdstationWebhookService.deleteWebhooks(funnel.configIaId, funnel.rdstationWebhookIds);

          logInfo("RD Station webhooks deleted for funnel", {
            funnelId: id,
            deletedCount: funnel.rdstationWebhookIds.length,
          });
        } catch (webhookError: any) {
          // Não impedir a exclusão do funil se falhar a deleção dos webhooks
          logWarn("Failed to delete RD Station webhooks, proceeding with funnel deletion", {
            funnelId: id,
            error: webhookError.message,
          });
        }
      }

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
      const data = leadSchemaWithWhatsApp.parse(request.body);

      const lead = await db.funnelLead.create({
        data: {
          funnelId,
          stageId: data.stageId,
          name: data.name,
          email: data.email || null,
          phone: data.phone || null,
          value: data.value,
          notes: data.notes || null,
          tags: data.tags,
          source: data.source || null,
          assignedTo: data.assignedTo || null,
          priority: data.priority,
          expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
          order: data.order,
          whatsappJid: data.whatsappJid || null,
          whatsappProfileName: data.whatsappProfileName || null,
          whatsappProfilePic: data.whatsappProfilePic || null,
          evolutionInstanceId: data.evolutionInstanceId || null,
        },
        include: { stage: true },
      });

      // Sincronizar com RD Station CRM (criar deal)
      try {
        await rdstationDealsService.createDeal(
          funnelId,
          lead.id,
          {
            name: data.name,
            value: data.value,
            expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : null,
            email: data.email,
            phone: data.phone,
          },
          data.stageId
        );
      } catch (rdError: any) {
        // Não falhar a criação do lead se a sincronização com RD Station falhar
        logWarn("Failed to sync lead to RD Station", {
          leadId: lead.id,
          error: rdError.message,
        });
      }

      logInfo("Lead created", { leadId: lead.id, funnelId, whatsappJid: data.whatsappJid });
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

      // Sincronizar com RD Station CRM (atualizar deal)
      try {
        await rdstationDealsService.updateDeal(
          lead.funnelId,
          id,
          {
            name: data.name,
            value: data.value,
            expectedCloseDate: data.expectedCloseDate ? new Date(data.expectedCloseDate) : undefined,
          }
        );
      } catch (rdError: any) {
        logWarn("Failed to sync lead update to RD Station", {
          leadId: id,
          error: rdError.message,
        });
      }

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

      // Sincronizar com RD Station CRM (mover deal para novo stage)
      try {
        await rdstationDealsService.moveDeal(lead.funnelId, id, stageId);
      } catch (rdError: any) {
        logWarn("Failed to sync lead move to RD Station", {
          leadId: id,
          newStageId: stageId,
          error: rdError.message,
        });
      }

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

      // Buscar lead para pegar funnelId antes de deletar
      const lead = await db.funnelLead.findUnique({
        where: { id },
        select: { funnelId: true, rdstationDealId: true },
      });

      if (!lead) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado",
          })
        );
      }

      // Sincronizar com RD Station CRM (deletar deal) antes de deletar o lead
      if (lead.rdstationDealId) {
        try {
          await rdstationDealsService.deleteDeal(lead.funnelId, id);
        } catch (rdError: any) {
          logWarn("Failed to sync lead deletion to RD Station", {
            leadId: id,
            dealId: lead.rdstationDealId,
            error: rdError.message,
          });
        }
      }

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

      // Use transaction to add to flow and mark as in follow-up flow
      const leadInFlow = await db.$transaction(async (tx) => {
        // Mark lead as in follow-up flow (removes from main Kanban)
        await tx.funnelLead.update({
          where: { id: leadId },
          data: { isInFollowUpFlow: true },
        });

        // Add to flow
        return tx.leadInFollowUpFlow.create({
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

      // Get lead info before deleting
      const leadInFlow = await db.leadInFollowUpFlow.findUnique({
        where: { id: leadFlowId },
        select: { leadId: true },
      });

      if (!leadInFlow) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      // Use transaction to remove from flow and mark as back in main Kanban
      await db.$transaction(async (tx) => {
        // Remove from flow
        await tx.leadInFollowUpFlow.delete({ where: { id: leadFlowId } });

        // Mark lead as back in main Kanban
        await tx.funnelLead.update({
          where: { id: leadInFlow.leadId },
          data: { isInFollowUpFlow: false },
        });
      });

      logInfo("Lead removed from flow", { leadFlowId });
      return formatResponse({
        message: "Lead removido do fluxo e retornado ao Kanban principal",
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

  // ========================================
  // FOLLOW-UP FLOW CONTACTS ROUTES
  // ========================================

  // GET /funnel/follow-up-flow/leads/:leadFlowId/contacts - Get contacts history
  fastify.get("/follow-up-flow/leads/:leadFlowId/contacts", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };

      const contacts = await db.followUpFlowContact.findMany({
        where: { leadFlowId },
        include: {
          step: { select: { name: true, color: true } },
        },
        orderBy: { contactedAt: "desc" },
      });

      return formatResponse({
        data: contacts,
        message: "Histórico de contatos listado",
      });
    } catch (error: any) {
      logError("Error getting contacts", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar histórico de contatos",
        })
      );
    }
  });

  // POST /funnel/follow-up-flow/leads/:leadFlowId/contacts - Register a contact
  fastify.post("/follow-up-flow/leads/:leadFlowId/contacts", async (request, reply) => {
    try {
      const { leadFlowId } = request.params as { leadFlowId: string };
      const data = createContactSchema.parse(request.body);

      // Get lead in flow info
      const leadInFlow = await db.leadInFollowUpFlow.findUnique({
        where: { id: leadFlowId },
        include: { currentStep: true },
      });

      if (!leadInFlow) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Lead não encontrado no fluxo",
          })
        );
      }

      // Create contact record
      const contact = await db.followUpFlowContact.create({
        data: {
          leadId: leadInFlow.leadId,
          leadFlowId,
          stepId: leadInFlow.currentStepId,
          contactType: data.contactType,
          message: data.message,
          response: data.response,
          status: data.status,
          isAutomatic: data.isAutomatic,
          outcome: data.outcome,
          notes: data.notes,
        },
        include: {
          step: { select: { name: true, color: true } },
        },
      });

      // Update lead in flow with last contact date and increment count
      await db.leadInFollowUpFlow.update({
        where: { id: leadFlowId },
        data: {
          lastFollowUpAt: new Date(),
          followUpCount: { increment: 1 },
        },
      });

      // Update lead's last contact date
      await db.funnelLead.update({
        where: { id: leadInFlow.leadId },
        data: { lastContactAt: new Date() },
      });

      // If moveToNextStep is true, move to next step automatically
      if (data.moveToNextStep) {
        const nextStep = await db.followUpFlowStep.findFirst({
          where: {
            funnelId: leadInFlow.funnelId,
            order: { gt: leadInFlow.currentStep.order },
            type: "followup",
          },
          orderBy: { order: "asc" },
        });

        if (nextStep) {
          // Calculate next follow-up date
          const nextFollowUpAt = new Date();
          nextFollowUpAt.setDate(nextFollowUpAt.getDate() + nextStep.delayDays);
          nextFollowUpAt.setHours(nextFollowUpAt.getHours() + nextStep.delayHours);

          await db.leadInFollowUpFlow.update({
            where: { id: leadFlowId },
            data: {
              currentStepId: nextStep.id,
              nextFollowUpAt: nextStep.delayDays > 0 || nextStep.delayHours > 0 ? nextFollowUpAt : null,
            },
          });
        }
      }

      logInfo("Contact registered", { leadFlowId, contactType: data.contactType });
      return reply.code(201).send(
        formatResponse({
          data: contact,
          message: "Contato registrado com sucesso",
        })
      );
    } catch (error: any) {
      logError("Error creating contact", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao registrar contato",
        })
      );
    }
  });

  // PATCH /funnel/follow-up-flow/contacts/:contactId - Update contact (add response, etc)
  fastify.patch("/follow-up-flow/contacts/:contactId", async (request, reply) => {
    try {
      const { contactId } = request.params as { contactId: string };
      const data = request.body as {
        response?: string;
        status?: string;
        outcome?: string;
        notes?: string;
      };

      const contact = await db.followUpFlowContact.update({
        where: { id: contactId },
        data: {
          ...data,
          respondedAt: data.response ? new Date() : undefined,
        },
        include: {
          step: { select: { name: true, color: true } },
        },
      });

      logInfo("Contact updated", { contactId });
      return formatResponse({
        data: contact,
        message: "Contato atualizado com sucesso",
      });
    } catch (error: any) {
      logError("Error updating contact", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao atualizar contato",
        })
      );
    }
  });

  // ========================================
  // EVOLUTION API INTEGRATION ROUTES
  // ========================================

  // GET /funnel/evolution/:instanceId/contacts - Search contacts from Evolution API
  fastify.get("/evolution/:instanceId/contacts", async (request, reply) => {
    try {
      const { instanceId } = request.params as { instanceId: string };
      const { search } = request.query as { search?: string };

      // Get instance info
      const instance = await db.evolutionInstance.findUnique({
        where: { id: instanceId },
      });

      if (!instance) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Instância não encontrada",
          })
        );
      }

      if (instance.connectionState !== "CONNECTED") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Instância não está conectada",
          })
        );
      }

      const serverUrl = instance.serverUrl || process.env.DEFAULT_EVOLUTION_URL || "";
      const apiKey = instance.apiKey || process.env.DEFAULT_EVOLUTION_API_KEY || "";

      if (!serverUrl || !apiKey) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Credenciais da Evolution API não configuradas",
          })
        );
      }

      // Fetch contacts from Evolution API
      const evolutionUrl = `${serverUrl.replace(/\/$/, "")}/chat/findContacts/${instance.instanceName}`;

      logInfo("Fetching Evolution contacts", { evolutionUrl, search });

      const response = await fetch(evolutionUrl, {
        method: "POST",
        headers: {
          "apikey": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          where: {}, // Get all contacts, filter locally
        }),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Evolution API findContacts error", { status: response.status, error: errorText });
        return reply.code(500).send(
          formatResponse({
            success: false,
            error: `Erro na Evolution API: ${response.status} - ${errorText}`,
          })
        );
      }

      const contacts = await response.json();
      logInfo("Evolution API raw response", { contactsCount: Array.isArray(contacts) ? contacts.length : 0 });

      // Format contacts for frontend
      let formattedContacts = Array.isArray(contacts) ? contacts.map((contact: any) => ({
        id: contact.id,
        remoteJid: contact.remoteJid || contact.id,
        pushName: contact.pushName || contact.name || "Sem nome",
        profilePictureUrl: contact.profilePictureUrl || null,
        phoneNumber: (contact.remoteJid || contact.id || "").replace("@s.whatsapp.net", "").replace("@c.us", ""),
      })) : [];

      // Filter locally by search term (name or phone)
      if (search) {
        const searchLower = search.toLowerCase().replace(/\D/g, ""); // Remove non-digits for phone search
        formattedContacts = formattedContacts.filter((contact: any) => {
          const nameMatch = contact.pushName?.toLowerCase().includes(search.toLowerCase());
          const phoneMatch = contact.phoneNumber?.includes(searchLower);
          return nameMatch || phoneMatch;
        });
      }

      logInfo("Contacts fetched", { instanceId, count: formattedContacts.length });
      return formatResponse({
        data: formattedContacts,
        message: "Contatos buscados com sucesso",
      });
    } catch (error: any) {
      logError("Error fetching Evolution contacts", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar contatos da Evolution API",
        })
      );
    }
  });

  // GET /funnel/evolution/:instanceId/chats - List all chats from Evolution API
  fastify.get("/evolution/:instanceId/chats", async (request, reply) => {
    try {
      const { instanceId } = request.params as { instanceId: string };

      // Get instance info
      const instance = await db.evolutionInstance.findUnique({
        where: { id: instanceId },
      });

      if (!instance) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Instância não encontrada",
          })
        );
      }

      if (instance.connectionState !== "CONNECTED") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Instância não está conectada",
          })
        );
      }

      const serverUrl = instance.serverUrl || process.env.DEFAULT_EVOLUTION_URL || "";
      const apiKey = instance.apiKey || process.env.DEFAULT_EVOLUTION_API_KEY || "";

      if (!serverUrl || !apiKey) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Credenciais da Evolution API não configuradas",
          })
        );
      }

      // Fetch chats from Evolution API
      const evolutionUrl = `${serverUrl.replace(/\/$/, "")}/chat/findChats/${instance.instanceName}`;

      const response = await fetch(evolutionUrl, {
        method: "POST",
        headers: {
          "apikey": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Evolution API findChats error", { status: response.status, error: errorText });
        return reply.code(response.status).send(
          formatResponse({
            success: false,
            error: `Erro na Evolution API: ${response.status}`,
          })
        );
      }

      const chats = await response.json();

      // Format chats for frontend (filter only individual chats, not groups)
      const formattedChats = Array.isArray(chats) ? chats
        .filter((chat: any) => !chat.isGroup && (chat.id || chat.remoteJid)?.includes("@s.whatsapp.net"))
        .map((chat: any) => ({
          id: chat.id || chat.remoteJid,
          remoteJid: chat.remoteJid || chat.id,
          pushName: chat.pushName || chat.name || "Sem nome",
          profilePictureUrl: chat.profilePictureUrl || null,
          phoneNumber: (chat.remoteJid || chat.id || "").replace("@s.whatsapp.net", "").replace("@c.us", ""),
          lastMessageAt: chat.lastMessageAt || chat.updatedAt,
          unreadCount: chat.unreadCount || 0,
        })) : [];

      logInfo("Chats fetched", { instanceId, count: formattedChats.length });
      return formatResponse({
        data: formattedChats,
        message: "Conversas buscadas com sucesso",
      });
    } catch (error: any) {
      logError("Error fetching Evolution chats", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar conversas da Evolution API",
        })
      );
    }
  });

  // GET /funnel/evolution/:instanceId/messages/:remoteJid - Get messages history from Evolution API
  fastify.get("/evolution/:instanceId/messages/:remoteJid", async (request, reply) => {
    try {
      const { instanceId, remoteJid } = request.params as { instanceId: string; remoteJid: string };
      const { limit = "50" } = request.query as { limit?: string };

      // Get instance info
      const instance = await db.evolutionInstance.findUnique({
        where: { id: instanceId },
      });

      if (!instance) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Instância não encontrada",
          })
        );
      }

      if (instance.connectionState !== "CONNECTED") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Instância não está conectada",
          })
        );
      }

      const serverUrl = instance.serverUrl || process.env.DEFAULT_EVOLUTION_URL || "";
      const apiKey = instance.apiKey || process.env.DEFAULT_EVOLUTION_API_KEY || "";

      if (!serverUrl || !apiKey) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Credenciais da Evolution API não configuradas",
          })
        );
      }

      // Decode remoteJid (may be URL encoded)
      const decodedJid = decodeURIComponent(remoteJid);

      // Fetch messages from Evolution API
      const evolutionUrl = `${serverUrl.replace(/\/$/, "")}/chat/findMessages/${instance.instanceName}`;

      const response = await fetch(evolutionUrl, {
        method: "POST",
        headers: {
          "apikey": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          where: {
            key: {
              remoteJid: decodedJid,
            },
          },
          limit: parseInt(limit),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Evolution API findMessages error", { status: response.status, error: errorText });
        return reply.code(response.status).send(
          formatResponse({
            success: false,
            error: `Erro na Evolution API: ${response.status}`,
          })
        );
      }

      const messagesData = await response.json();
      const messages = messagesData.messages?.records || messagesData.messages || messagesData || [];

      // Format messages for frontend
      const formattedMessages = Array.isArray(messages) ? messages.map((msg: any) => ({
        id: msg.key?.id || msg.id,
        remoteJid: msg.key?.remoteJid || decodedJid,
        fromMe: msg.key?.fromMe || false,
        pushName: msg.pushName || null,
        message: msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption ||
                 msg.message?.videoMessage?.caption ||
                 msg.message?.documentMessage?.caption ||
                 (msg.message?.imageMessage ? "[Imagem]" : null) ||
                 (msg.message?.videoMessage ? "[Vídeo]" : null) ||
                 (msg.message?.audioMessage ? "[Áudio]" : null) ||
                 (msg.message?.documentMessage ? "[Documento]" : null) ||
                 (msg.message?.stickerMessage ? "[Sticker]" : null) ||
                 msg.content ||
                 "[Mensagem não suportada]",
        messageType: msg.messageType ||
                     (msg.message?.conversation ? "text" : null) ||
                     (msg.message?.extendedTextMessage ? "text" : null) ||
                     (msg.message?.imageMessage ? "image" : null) ||
                     (msg.message?.videoMessage ? "video" : null) ||
                     (msg.message?.audioMessage ? "audio" : null) ||
                     (msg.message?.documentMessage ? "document" : null) ||
                     "unknown",
        timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : msg.createdAt,
        status: msg.status || "sent",
      })).sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) : [];

      logInfo("Messages fetched", { instanceId, remoteJid: decodedJid, count: formattedMessages.length });
      return formatResponse({
        data: {
          messages: formattedMessages,
          remoteJid: decodedJid,
          total: formattedMessages.length,
        },
        message: "Mensagens buscadas com sucesso",
      });
    } catch (error: any) {
      logError("Error fetching Evolution messages", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar mensagens da Evolution API",
        })
      );
    }
  });

  // GET /funnel/lead/:leadId/whatsapp-history - Get WhatsApp history for a lead
  fastify.get("/lead/:leadId/whatsapp-history", async (request, reply) => {
    try {
      const { leadId } = request.params as { leadId: string };
      const { limit = "50" } = request.query as { limit?: string };

      // Get lead with WhatsApp info
      const lead = await db.funnelLead.findUnique({
        where: { id: leadId },
        select: {
          id: true,
          name: true,
          whatsappJid: true,
          evolutionInstanceId: true,
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

      if (!lead.whatsappJid || !lead.evolutionInstanceId) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Lead não possui WhatsApp vinculado",
          })
        );
      }

      // Get instance info
      const instance = await db.evolutionInstance.findUnique({
        where: { id: lead.evolutionInstanceId },
      });

      if (!instance) {
        return reply.code(404).send(
          formatResponse({
            success: false,
            error: "Instância Evolution não encontrada",
          })
        );
      }

      if (instance.connectionState !== "CONNECTED") {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Instância não está conectada",
          })
        );
      }

      const serverUrl = instance.serverUrl || process.env.DEFAULT_EVOLUTION_URL || "";
      const apiKey = instance.apiKey || process.env.DEFAULT_EVOLUTION_API_KEY || "";

      if (!serverUrl || !apiKey) {
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Credenciais da Evolution API não configuradas",
          })
        );
      }

      // Fetch messages from Evolution API
      const evolutionUrl = `${serverUrl.replace(/\/$/, "")}/chat/findMessages/${instance.instanceName}`;

      const response = await fetch(evolutionUrl, {
        method: "POST",
        headers: {
          "apikey": apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          where: {
            key: {
              remoteJid: lead.whatsappJid,
            },
          },
          limit: parseInt(limit),
        }),
        signal: AbortSignal.timeout(30000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logError("Evolution API findMessages error", { status: response.status, error: errorText });
        return reply.code(response.status).send(
          formatResponse({
            success: false,
            error: `Erro na Evolution API: ${response.status}`,
          })
        );
      }

      const messagesData = await response.json();
      const messages = messagesData.messages?.records || messagesData.messages || messagesData || [];

      // Format messages for AI context
      const formattedMessages = Array.isArray(messages) ? messages.map((msg: any) => ({
        id: msg.key?.id || msg.id,
        fromMe: msg.key?.fromMe || false,
        sender: msg.key?.fromMe ? "Agente" : lead.name,
        message: msg.message?.conversation ||
                 msg.message?.extendedTextMessage?.text ||
                 msg.message?.imageMessage?.caption ||
                 msg.content ||
                 "[Mensagem não suportada]",
        messageType: msg.messageType || "text",
        timestamp: msg.messageTimestamp ? new Date(msg.messageTimestamp * 1000).toISOString() : msg.createdAt,
      })).sort((a: any, b: any) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()) : [];

      // Generate context for AI
      const conversationContext = formattedMessages
        .map((msg: any) => `[${new Date(msg.timestamp).toLocaleString("pt-BR")}] ${msg.sender}: ${msg.message}`)
        .join("\n");

      logInfo("WhatsApp history fetched for lead", { leadId, messagesCount: formattedMessages.length });
      return formatResponse({
        data: {
          lead: {
            id: lead.id,
            name: lead.name,
            whatsappJid: lead.whatsappJid,
          },
          messages: formattedMessages,
          total: formattedMessages.length,
          conversationContext, // Ready for AI consumption
        },
        message: "Histórico de WhatsApp buscado com sucesso",
      });
    } catch (error: any) {
      logError("Error fetching lead WhatsApp history", error);
      return reply.code(500).send(
        formatResponse({
          success: false,
          error: "Erro ao buscar histórico de WhatsApp do lead",
        })
      );
    }
  });
}
