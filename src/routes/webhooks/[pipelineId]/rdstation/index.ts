import { FastifyInstance } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { formatResponse } from "@/utils/response-formatter";

// ========================================
// SCHEMAS DE VALIDACAO
// ========================================

const dealStageSchema = z.object({
  id: z.string(),
  name: z.string(),
  nickname: z.string().optional().nullable(),
  order: z.number().optional(),
});

const dealPipelineSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const contactSchema = z.object({
  id: z.string(),
  name: z.string().optional().nullable(),
  emails: z.array(z.object({ email: z.string() })).optional().default([]),
  phones: z.array(z.object({ phone: z.string() })).optional().default([]),
});

const dealDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
  amount_monthly: z.number().optional().nullable(),
  amount_unique: z.number().optional().nullable(),
  amount_total: z.number().optional().nullable(),
  prediction_date: z.string().optional().nullable(),
  created_at: z.string().optional(),
  updated_at: z.string().optional(),
  rating: z.number().optional().nullable(),
  status: z.enum(["ongoing", "won", "lost", "paused"]).optional().nullable(),
  closed_at: z.string().optional().nullable(),
  user: z.object({
    id: z.string(),
    name: z.string().optional(),
    email: z.string().optional(),
    avatar_url: z.string().optional().nullable(),
  }).optional().nullable(),
  deal_stage: dealStageSchema.optional().nullable(),
  deal_pipeline: dealPipelineSchema.optional().nullable(),
  deal_source: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional().nullable(),
  campaign: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional().nullable(),
  deal_lost_reason: z.object({
    id: z.string().optional(),
    name: z.string().optional(),
  }).optional().nullable(),
  deal_custom_fields: z.array(z.object({
    value: z.any(),
    custom_field: z.object({
      id: z.string(),
      label: z.string(),
      name: z.string(),
    }),
  })).optional().default([]),
  deal_products: z.array(z.any()).optional().default([]),
  contacts: z.array(contactSchema).optional().default([]),
});

const deletedDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const lostReasonDocumentSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const webhookPayloadSchema = z.object({
  event_name: z.string(),
  document: z.any(), // Validaremos de acordo com o evento
  event_timestamp: z.string(),
  transaction_uuid: z.string(),
});

// ========================================
// HELPERS
// ========================================

/**
 * Converte rating do RD Station (1-5) para priority local
 */
function ratingToPriority(rating: number | null | undefined): "low" | "medium" | "high" {
  if (!rating) return "medium";
  if (rating >= 4) return "high";
  if (rating >= 2) return "medium";
  return "low";
}

/**
 * Mapeia stage do RD Station para stage local do funil
 * Usa a ordem do stage para encontrar correspondencia
 */
async function mapRdStageToLocalStage(
  funnelId: string,
  rdStageId: string,
  rdStageOrder?: number
): Promise<string | null> {
  // Buscar todos os stages do funil local (exceto fixos)
  const localStages = await db.funnelStage.findMany({
    where: { funnelId, isFixed: false },
    orderBy: { order: "asc" },
  });

  if (localStages.length === 0) return null;

  // Se temos a ordem, usar ela para mapear
  if (rdStageOrder !== undefined && rdStageOrder < localStages.length) {
    return localStages[rdStageOrder].id;
  }

  // Fallback: retornar primeiro stage
  return localStages[0].id;
}

/**
 * Busca o stage fixo (won ou lost) de um funil
 */
async function getFixedStage(funnelId: string, type: "won" | "lost"): Promise<string | null> {
  const stage = await db.funnelStage.findFirst({
    where: { funnelId, fixedType: type },
  });
  return stage?.id || null;
}

// ========================================
// HANDLERS DE EVENTOS
// ========================================

async function handleDealCreated(payload: z.infer<typeof webhookPayloadSchema>, pipelineId: string) {
  const document = dealDocumentSchema.parse(payload.document);

  // Buscar funil vinculado ao pipeline do RD Station usando o pipelineId da URL
  const funnel = await db.funnel.findFirst({
    where: { rdstationPipelineId: pipelineId },
    include: { stages: { orderBy: { order: "asc" } } },
  });

  if (!funnel) {
    logInfo("No funnel linked to RD Station pipeline", {
      pipelineId,
      documentPipelineId: document.deal_pipeline?.id,
      pipelineName: document.deal_pipeline?.name,
    });
    return;
  }

  // Verificar se ja existe lead com esse rdstationDealId
  const existingLead = await db.funnelLead.findFirst({
    where: { rdstationDealId: document.id },
  });

  if (existingLead) {
    logInfo("Lead already exists for this deal, skipping creation", {
      dealId: document.id,
      leadId: existingLead.id,
    });
    return;
  }

  // Mapear stage
  let stageId: string | null = null;

  if (document.status === "won") {
    stageId = await getFixedStage(funnel.id, "won");
  } else if (document.status === "lost") {
    stageId = await getFixedStage(funnel.id, "lost");
  } else if (document.deal_stage) {
    stageId = await mapRdStageToLocalStage(funnel.id, document.deal_stage.id, document.deal_stage.order);
  }

  // Fallback para primeiro stage
  if (!stageId) {
    const firstStage = funnel.stages.find(s => !s.isFixed);
    stageId = firstStage?.id || funnel.stages[0]?.id;
  }

  if (!stageId) {
    logError("No stage found for funnel", { funnelId: funnel.id });
    return;
  }

  // Extrair dados do contato principal
  const primaryContact = document.contacts?.[0];
  const email = primaryContact?.emails?.[0]?.email || null;
  const phone = primaryContact?.phones?.[0]?.phone || null;

  // Criar lead
  const lead = await db.funnelLead.create({
    data: {
      funnelId: funnel.id,
      stageId,
      name: document.name,
      email,
      phone,
      value: document.amount_total || 0,
      priority: ratingToPriority(document.rating),
      expectedCloseDate: document.prediction_date ? new Date(document.prediction_date) : null,
      source: "RD Station CRM",
      notes: `Sincronizado via webhook - Deal ID: ${document.id}`,
      rdstationDealId: document.id,
    },
  });

  logInfo("Lead created from RD Station webhook", {
    leadId: lead.id,
    dealId: document.id,
    funnelId: funnel.id,
    pipelineId,
    stageName: document.deal_stage?.name,
  });
}

async function handleDealUpdated(payload: z.infer<typeof webhookPayloadSchema>, pipelineId: string) {
  const document = dealDocumentSchema.parse(payload.document);

  // Buscar lead pelo rdstationDealId
  const lead = await db.funnelLead.findFirst({
    where: { rdstationDealId: document.id },
    include: { funnel: true, stage: true },
  });

  if (!lead) {
    logInfo("No lead found for deal update, attempting to create", { dealId: document.id, pipelineId });
    // Tentar criar o lead se nao existir
    await handleDealCreated(payload, pipelineId);
    return;
  }

  // Preparar dados de atualizacao
  const updateData: any = {
    name: document.name,
    value: document.amount_total || lead.value,
    priority: ratingToPriority(document.rating),
    expectedCloseDate: document.prediction_date ? new Date(document.prediction_date) : lead.expectedCloseDate,
  };

  // Atualizar contato se disponivel
  const primaryContact = document.contacts?.[0];
  if (primaryContact?.emails?.[0]?.email) {
    updateData.email = primaryContact.emails[0].email;
  }
  if (primaryContact?.phones?.[0]?.phone) {
    updateData.phone = primaryContact.phones[0].phone;
  }

  // Verificar mudanca de status para won/lost
  if (document.status === "won") {
    const wonStageId = await getFixedStage(lead.funnelId, "won");
    if (wonStageId) {
      updateData.stageId = wonStageId;
    }
  } else if (document.status === "lost") {
    const lostStageId = await getFixedStage(lead.funnelId, "lost");
    if (lostStageId) {
      updateData.stageId = lostStageId;
    }
  } else if (document.deal_stage && document.status === "ongoing") {
    // Mapear novo stage
    const newStageId = await mapRdStageToLocalStage(
      lead.funnelId,
      document.deal_stage.id,
      document.deal_stage.order
    );
    if (newStageId && newStageId !== lead.stageId) {
      updateData.stageId = newStageId;
    }
  }

  // Atualizar lead
  await db.funnelLead.update({
    where: { id: lead.id },
    data: updateData,
  });

  logInfo("Lead updated from RD Station webhook", {
    leadId: lead.id,
    dealId: document.id,
    pipelineId,
    status: document.status,
    newStageId: updateData.stageId,
  });
}

async function handleDealDeleted(payload: z.infer<typeof webhookPayloadSchema>, pipelineId: string) {
  const document = deletedDocumentSchema.parse(payload.document);

  // Buscar lead pelo rdstationDealId
  const lead = await db.funnelLead.findFirst({
    where: { rdstationDealId: document.id },
  });

  if (!lead) {
    logInfo("No lead found for deleted deal", { dealId: document.id, pipelineId });
    return;
  }

  // Deletar lead e registros relacionados
  await db.funnelLead.delete({
    where: { id: lead.id },
  });

  logInfo("Lead deleted from RD Station webhook", {
    leadId: lead.id,
    dealId: document.id,
    dealName: document.name,
    pipelineId,
  });
}

async function handleLostReasonEvent(payload: z.infer<typeof webhookPayloadSchema>, pipelineId: string) {
  const document = lostReasonDocumentSchema.parse(payload.document);

  // Apenas logar para auditoria - lost_reasons nao afetam dados locais diretamente
  logInfo("Lost reason event received", {
    event: payload.event_name,
    reasonId: document.id,
    reasonName: document.name,
    pipelineId,
    timestamp: payload.event_timestamp,
  });
}

// ========================================
// ROTA PRINCIPAL
// ========================================

export default async function (fastify: FastifyInstance) {
  /**
   * Webhook RD Station CRM v2 com pipelineId dinâmico
   * Recebe eventos de deals e lost_reasons
   *
   * URL: /webhooks/:pipelineId/rdstation
   *
   * Eventos suportados:
   * - crm_deal_created: Cria FunnelLead no funil vinculado
   * - crm_deal_updated: Atualiza FunnelLead existente
   * - crm_deal_deleted: Remove FunnelLead
   * - crm_lost_reason_*: Log para auditoria
   */
  fastify.post("/", async (request, reply) => {
    try {
      // Extrair pipelineId da URL
      const { pipelineId } = request.params as { pipelineId: string };

      if (!pipelineId) {
        logWarn("Webhook received without pipelineId");
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Missing pipelineId parameter",
          })
        );
      }

      const payload = webhookPayloadSchema.parse(request.body);

      logInfo("RD Station CRM webhook received", {
        event: payload.event_name,
        pipelineId,
        transactionId: payload.transaction_uuid,
        timestamp: payload.event_timestamp,
      });

      switch (payload.event_name) {
        case "crm_deal_created":
          await handleDealCreated(payload, pipelineId);
          break;

        case "crm_deal_updated":
          await handleDealUpdated(payload, pipelineId);
          break;

        case "crm_deal_deleted":
          await handleDealDeleted(payload, pipelineId);
          break;

        case "crm_lost_reason_created":
        case "crm_lost_reason_updated":
        case "crm_lost_reason_deleted":
          await handleLostReasonEvent(payload, pipelineId);
          break;

        default:
          logWarn("Unknown RD Station webhook event", { event: payload.event_name, pipelineId });
      }

      return formatResponse({
        message: "Webhook processed successfully",
        data: {
          transactionId: payload.transaction_uuid,
          pipelineId,
        },
      });
    } catch (error: any) {
      const { pipelineId } = request.params as { pipelineId?: string };

      logError("Error processing RD Station webhook", {
        error: error.message,
        pipelineId,
        body: request.body,
      });

      // Retornar 200 para evitar retries desnecessarios do RD Station
      // mas indicar que houve erro no processamento
      return reply.code(200).send(
        formatResponse({
          success: false,
          error: "Webhook processing failed",
          message: error.message,
        })
      );
    }
  });

  /**
   * Health check para o webhook com pipelineId
   * Util para verificar se o endpoint esta ativo
   */
  fastify.get("/health", async (request) => {
    const { pipelineId } = request.params as { pipelineId: string };

    // Verificar se existe funil vinculado a esse pipeline
    const funnel = await db.funnel.findFirst({
      where: { rdstationPipelineId: pipelineId },
      select: { id: true, name: true },
    });

    return formatResponse({
      message: "RD Station CRM webhook is active",
      data: {
        pipelineId,
        funnelLinked: !!funnel,
        funnelId: funnel?.id,
        funnelName: funnel?.name,
        supportedEvents: [
          "crm_deal_created",
          "crm_deal_updated",
          "crm_deal_deleted",
          "crm_lost_reason_created",
          "crm_lost_reason_updated",
          "crm_lost_reason_deleted",
        ],
      },
    });
  });
}
