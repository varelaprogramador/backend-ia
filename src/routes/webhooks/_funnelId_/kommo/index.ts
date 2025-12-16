import { FastifyInstance } from "fastify";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { formatResponse } from "@/utils/response-formatter";

// ========================================
// TIPOS PARA WEBSOCKET
// ========================================

type FunnelWebSocketEvent =
  | "funnel:lead:created"
  | "funnel:lead:updated"
  | "funnel:lead:deleted"
  | "funnel:lead:stage_changed";

interface FunnelWebSocketPayload {
  event: FunnelWebSocketEvent;
  funnelId: string;
  leadId: string;
  data: {
    lead?: any;
    previousStageId?: string;
    newStageId?: string;
    kommoLeadId?: number;
  };
}

// ========================================
// TIPOS DO KOMMO WEBHOOK
// ========================================

// Formato do webhook do Kommo (x-www-form-urlencoded)
// O Kommo envia: {"leads":{"add":[{...}]}} ou {"leads":{"update":[{...}]}} ou {"leads":{"status":[{...}]}}
interface KommoWebhookLead {
  id: number;
  name: string;
  responsible_user_id?: number;
  status_id?: number;
  pipeline_id?: number;
  old_status_id?: number;
  old_pipeline_id?: number;
  price?: number;
  created_at?: number;
  updated_at?: number;
  account_id?: number;
  created_by?: number;
  updated_by?: number;
  custom_fields_values?: Array<{
    field_id: number;
    field_name: string;
    values: Array<{ value: any; enum_id?: number }>;
  }>;
  _embedded?: {
    contacts?: Array<{
      id: number;
      name?: string;
      is_main?: boolean;
    }>;
  };
}

interface KommoWebhookPayload {
  leads?: {
    add?: KommoWebhookLead[];
    update?: KommoWebhookLead[];
    delete?: KommoWebhookLead[];
    status?: KommoWebhookLead[];
  };
  contacts?: {
    add?: any[];
    update?: any[];
    delete?: any[];
  };
  account?: {
    id: number;
    subdomain: string;
  };
}

// ========================================
// HELPERS
// ========================================

/**
 * Mapeia stage do Kommo (status_id) para stage local do funil
 */
async function mapKommoStageToLocalStage(
  funnelId: string,
  kommoStatusId: number
): Promise<string | null> {
  // Buscar stage pelo kommoStageId
  const stageByKommoId = await db.funnelStage.findFirst({
    where: {
      funnelId,
      kommoStageId: String(kommoStatusId),
      isFixed: false,
    },
  });

  if (stageByKommoId) {
    logInfo("Stage found by kommoStageId", {
      funnelId,
      kommoStatusId,
      localStageId: stageByKommoId.id,
      localStageName: stageByKommoId.name,
    });
    return stageByKommoId.id;
  }

  // Fallback: buscar primeiro stage disponível
  logWarn("Stage not found by kommoStageId, falling back to first stage", {
    funnelId,
    kommoStatusId,
  });

  const firstStage = await db.funnelStage.findFirst({
    where: { funnelId, isFixed: false },
    orderBy: { order: "asc" },
  });

  return firstStage?.id || null;
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

/**
 * Busca dados do contato principal no Kommo
 */
async function getContactDetails(
  contactId: number,
  subdomain: string,
  accessToken: string
): Promise<{ name?: string; phone?: string; email?: string } | null> {
  try {
    const axios = (await import("axios")).default;
    const response = await axios.get(
      `https://${subdomain}.kommo.com/api/v4/contacts/${contactId}`,
      {
        headers: { Authorization: `Bearer ${accessToken}` },
        timeout: 10000,
      }
    );

    const contact = response.data;
    let phone: string | undefined;
    let email: string | undefined;

    // Extrair telefone e email dos custom_fields
    if (contact.custom_fields_values) {
      for (const field of contact.custom_fields_values) {
        if (field.field_code === "PHONE" && field.values?.[0]?.value) {
          phone = field.values[0].value;
        }
        if (field.field_code === "EMAIL" && field.values?.[0]?.value) {
          email = field.values[0].value;
        }
      }
    }

    return {
      name: contact.name,
      phone,
      email,
    };
  } catch (error) {
    logError("Error fetching Kommo contact details", error as Error);
    return null;
  }
}

// ========================================
// HANDLERS DE EVENTOS
// ========================================

async function handleLeadAdded(
  lead: KommoWebhookLead,
  funnelId: string,
  subdomain: string | undefined,
  fastify: FastifyInstance
) {
  // Buscar funil diretamente pelo ID (não pelo kommoPipelineId)
  const funnel = await db.funnel.findUnique({
    where: { id: funnelId },
    include: {
      stages: { orderBy: { order: "asc" } },
      configIa: {
        select: {
          kommoSubdomain: true,
          kommoAccessToken: true,
        },
      },
    },
  });

  if (!funnel) {
    logInfo("No funnel found with this ID", {
      funnelId,
      leadPipelineId: lead.pipeline_id,
    });
    return;
  }

  // Verificar se já existe lead com esse kommoLeadId
  const existingLead = await db.funnelLead.findFirst({
    where: { kommoLeadId: lead.id },
  });

  if (existingLead) {
    logInfo("Lead already exists for this Kommo lead, skipping creation", {
      kommoLeadId: lead.id,
      leadId: existingLead.id,
    });
    return;
  }

  // Mapear stage
  let stageId: string | null = null;

  if (lead.status_id) {
    // Verificar se é status de ganho (142 é padrão Kommo para Ganho)
    // Os status IDs 142 e 143 são reservados para Ganho e Perdido no Kommo
    if (lead.status_id === 142) {
      stageId = await getFixedStage(funnel.id, "won");
    } else if (lead.status_id === 143) {
      stageId = await getFixedStage(funnel.id, "lost");
    } else {
      stageId = await mapKommoStageToLocalStage(funnel.id, lead.status_id);
    }
  }

  // Fallback para primeiro stage
  if (!stageId) {
    const firstStage = funnel.stages.find((s) => !s.isFixed);
    stageId = firstStage?.id || funnel.stages[0]?.id;
  }

  if (!stageId) {
    logError("No stage found for funnel", { funnelId: funnel.id });
    return;
  }

  // Tentar buscar dados do contato principal
  let contactName: string | undefined;
  let contactPhone: string | undefined;
  let contactEmail: string | undefined;

  const mainContact = lead._embedded?.contacts?.find((c) => c.is_main);
  if (mainContact && funnel.configIa?.kommoSubdomain && funnel.configIa?.kommoAccessToken) {
    const contactDetails = await getContactDetails(
      mainContact.id,
      funnel.configIa.kommoSubdomain,
      funnel.configIa.kommoAccessToken
    );
    if (contactDetails) {
      contactName = contactDetails.name;
      contactPhone = contactDetails.phone;
      contactEmail = contactDetails.email;
    }
  }

  // Criar lead
  const newLead = await db.funnelLead.create({
    data: {
      funnelId: funnel.id,
      stageId,
      name: lead.name || contactName || `Lead ${lead.id}`,
      email: contactEmail || null,
      phone: contactPhone || null,
      value: lead.price || 0,
      priority: "medium",
      source: "Kommo CRM",
      notes: `Sincronizado via webhook - Kommo Lead ID: ${lead.id}`,
      kommoLeadId: lead.id,
    },
    include: {
      stage: true,
    },
  });

  // Emitir evento WebSocket
  const wsPayload: FunnelWebSocketPayload = {
    event: "funnel:lead:created",
    funnelId: funnel.id,
    leadId: newLead.id,
    data: {
      lead: newLead,
      newStageId: stageId,
      kommoLeadId: lead.id,
    },
  };
  fastify.io.to(`funnel:${funnel.id}`).emit("funnel:update", wsPayload);

  logInfo("Lead created from Kommo webhook", {
    leadId: newLead.id,
    kommoLeadId: lead.id,
    funnelId: funnel.id,
    websocketEmitted: true,
  });
}

async function handleLeadUpdated(
  lead: KommoWebhookLead,
  funnelId: string,
  fastify: FastifyInstance
) {
  // Buscar lead pelo kommoLeadId
  const existingLead = await db.funnelLead.findFirst({
    where: { kommoLeadId: lead.id },
    include: { funnel: true, stage: true },
  });

  if (!existingLead) {
    logInfo("No lead found for Kommo lead update, attempting to create", {
      kommoLeadId: lead.id,
      funnelId,
    });
    // Tentar criar o lead se não existir
    await handleLeadAdded(lead, funnelId, undefined, fastify);
    return;
  }

  // Preparar dados de atualização
  const updateData: any = {
    name: lead.name || existingLead.name,
    value: lead.price !== undefined ? lead.price : existingLead.value,
  };

  // Atualizar lead
  const updatedLead = await db.funnelLead.update({
    where: { id: existingLead.id },
    data: updateData,
    include: {
      stage: true,
    },
  });

  // Emitir evento WebSocket
  const wsPayload: FunnelWebSocketPayload = {
    event: "funnel:lead:updated",
    funnelId: existingLead.funnelId,
    leadId: existingLead.id,
    data: {
      lead: updatedLead,
      kommoLeadId: lead.id,
    },
  };
  fastify.io.to(`funnel:${existingLead.funnelId}`).emit("funnel:update", wsPayload);

  logInfo("Lead updated from Kommo webhook", {
    leadId: existingLead.id,
    kommoLeadId: lead.id,
    funnelId,
    websocketEmitted: true,
  });
}

async function handleLeadStatusChanged(
  lead: KommoWebhookLead,
  funnelId: string,
  fastify: FastifyInstance
) {
  // Buscar lead pelo kommoLeadId
  const existingLead = await db.funnelLead.findFirst({
    where: { kommoLeadId: lead.id },
    include: { funnel: true, stage: true },
  });

  if (!existingLead) {
    logInfo("No lead found for Kommo status change, attempting to create", {
      kommoLeadId: lead.id,
      funnelId,
    });
    await handleLeadAdded(lead, funnelId, undefined, fastify);
    return;
  }

  // Mapear novo stage
  let newStageId: string | null = null;

  if (lead.status_id) {
    // Verificar status fixos do Kommo
    if (lead.status_id === 142) {
      newStageId = await getFixedStage(existingLead.funnelId, "won");
    } else if (lead.status_id === 143) {
      newStageId = await getFixedStage(existingLead.funnelId, "lost");
    } else {
      newStageId = await mapKommoStageToLocalStage(existingLead.funnelId, lead.status_id);
    }
  }

  if (!newStageId || newStageId === existingLead.stageId) {
    logInfo("Stage not changed or not found", {
      kommoLeadId: lead.id,
      kommoStatusId: lead.status_id,
      currentStageId: existingLead.stageId,
    });
    return;
  }

  const previousStageId = existingLead.stageId;

  // Atualizar lead com novo stage
  const updatedLead = await db.funnelLead.update({
    where: { id: existingLead.id },
    data: { stageId: newStageId },
    include: {
      stage: true,
    },
  });

  // Emitir evento WebSocket
  const wsPayload: FunnelWebSocketPayload = {
    event: "funnel:lead:stage_changed",
    funnelId: existingLead.funnelId,
    leadId: existingLead.id,
    data: {
      lead: updatedLead,
      previousStageId,
      newStageId,
      kommoLeadId: lead.id,
    },
  };
  fastify.io.to(`funnel:${existingLead.funnelId}`).emit("funnel:update", wsPayload);

  logInfo("Lead stage changed from Kommo webhook", {
    leadId: existingLead.id,
    kommoLeadId: lead.id,
    previousStageId,
    newStageId,
    kommoStatusId: lead.status_id,
    oldKommoStatusId: lead.old_status_id,
    websocketEmitted: true,
  });
}

async function handleLeadDeleted(
  lead: KommoWebhookLead,
  funnelId: string,
  fastify: FastifyInstance
) {
  // Buscar lead pelo kommoLeadId
  const existingLead = await db.funnelLead.findFirst({
    where: { kommoLeadId: lead.id },
  });

  if (!existingLead) {
    logInfo("No lead found for deleted Kommo lead", {
      kommoLeadId: lead.id,
      funnelId,
    });
    return;
  }

  const existingFunnelId = existingLead.funnelId;
  const leadId = existingLead.id;

  // Deletar lead
  await db.funnelLead.delete({
    where: { id: existingLead.id },
  });

  // Emitir evento WebSocket
  const wsPayload: FunnelWebSocketPayload = {
    event: "funnel:lead:deleted",
    funnelId: existingFunnelId,
    leadId,
    data: {
      kommoLeadId: lead.id,
    },
  };
  fastify.io.to(`funnel:${existingFunnelId}`).emit("funnel:update", wsPayload);

  logInfo("Lead deleted from Kommo webhook", {
    leadId,
    kommoLeadId: lead.id,
    funnelId,
    websocketEmitted: true,
  });
}

// ========================================
// ROTA PRINCIPAL
// ========================================

export default async function (fastify: FastifyInstance) {
  /**
   * Webhook Kommo CRM com funnelId dinâmico
   * Recebe eventos de leads
   *
   * URL: /webhooks/:funnelId/kommo
   * IMPORTANTE: A URL usa o funnelId do sistema, não o pipelineId do Kommo
   * Isso evita URLs duplicadas quando múltiplos funis usam o mesmo pipeline
   *
   * Eventos suportados:
   * - leads.add: Cria FunnelLead no funil vinculado
   * - leads.update: Atualiza FunnelLead existente
   * - leads.delete: Remove FunnelLead
   * - leads.status: Atualiza estágio do FunnelLead
   */
  fastify.post("/", async (request, reply) => {
    try {
      // Log inicial para debug
      logInfo("Kommo Webhook POST received on dynamic route", {
        url: request.url,
        params: request.params,
        contentType: request.headers["content-type"],
      });

      // Extrair funnelId da URL (parâmetro vem como funnelId_ pelo Fastify autoload)
      const params = request.params as { funnelId_?: string; funnelId?: string };
      const funnelId = params.funnelId_ || params.funnelId;

      if (!funnelId) {
        logWarn("Kommo Webhook received without funnelId", {
          params: request.params,
          url: request.url,
        });
        return reply.code(400).send(
          formatResponse({
            success: false,
            error: "Missing funnelId parameter",
          })
        );
      }

      // O Kommo envia dados em x-www-form-urlencoded ou JSON
      // O payload pode vir como string JSON ou objeto direto
      let payload: KommoWebhookPayload;

      if (typeof request.body === "string") {
        try {
          payload = JSON.parse(request.body);
        } catch {
          // Tentar parsear como query string
          const urlParams = new URLSearchParams(request.body);
          const leadsData = urlParams.get("leads");
          if (leadsData) {
            payload = { leads: JSON.parse(leadsData) };
          } else {
            payload = {};
          }
        }
      } else {
        payload = request.body as KommoWebhookPayload;
      }

      logInfo("Kommo CRM webhook received", {
        funnelId,
        hasLeadsAdd: !!payload.leads?.add?.length,
        hasLeadsUpdate: !!payload.leads?.update?.length,
        hasLeadsDelete: !!payload.leads?.delete?.length,
        hasLeadsStatus: !!payload.leads?.status?.length,
        subdomain: payload.account?.subdomain,
      });

      const subdomain = payload.account?.subdomain;

      // Processar eventos de leads
      if (payload.leads) {
        // Lead adicionado
        if (payload.leads.add && payload.leads.add.length > 0) {
          for (const lead of payload.leads.add) {
            await handleLeadAdded(lead, funnelId, subdomain, fastify);
          }
        }

        // Lead atualizado
        if (payload.leads.update && payload.leads.update.length > 0) {
          for (const lead of payload.leads.update) {
            await handleLeadUpdated(lead, funnelId, fastify);
          }
        }

        // Lead deletado
        if (payload.leads.delete && payload.leads.delete.length > 0) {
          for (const lead of payload.leads.delete) {
            await handleLeadDeleted(lead, funnelId, fastify);
          }
        }

        // Status do lead alterado (mudança de etapa)
        if (payload.leads.status && payload.leads.status.length > 0) {
          for (const lead of payload.leads.status) {
            await handleLeadStatusChanged(lead, funnelId, fastify);
          }
        }
      }

      return formatResponse({
        message: "Kommo webhook processed successfully",
        data: {
          funnelId,
        },
      });
    } catch (error: any) {
      const params = request.params as { funnelId_?: string; funnelId?: string };
      const funnelId = params.funnelId_ || params.funnelId;

      logError("Error processing Kommo webhook", {
        error: error.message,
        funnelId,
        body: request.body,
      });

      // Retornar 200 para evitar retries desnecessários do Kommo
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
   * Rota de teste para verificar se o webhook está funcionando
   * POST /webhooks/:funnelId/kommo/teste
   */
  fastify.post("/teste", async (request) => {
    const params = request.params as { funnelId_?: string; funnelId?: string };
    const funnelId = params.funnelId_ || params.funnelId;

    logInfo("Kommo Webhook test received", {
      funnelId,
      body: request.body,
      headers: request.headers,
    });

    return formatResponse({
      message: "Kommo Webhook test received successfully",
      data: {
        funnelId,
        receivedAt: new Date().toISOString(),
        body: request.body,
      },
    });
  });

  /**
   * Health check para o webhook com funnelId
   * Util para verificar se o endpoint esta ativo
   */
  fastify.get("/health", async (request) => {
    const params = request.params as { funnelId_?: string; funnelId?: string };
    const funnelId = params.funnelId_ || params.funnelId;

    // Verificar se existe funil com esse ID
    const funnel = await db.funnel.findUnique({
      where: { id: funnelId },
      select: { id: true, name: true, kommoPipelineId: true },
    });

    return formatResponse({
      message: "Kommo CRM webhook is active",
      data: {
        funnelId,
        funnelFound: !!funnel,
        funnelName: funnel?.name,
        kommoPipelineId: funnel?.kommoPipelineId,
        supportedEvents: [
          "leads.add",
          "leads.update",
          "leads.delete",
          "leads.status",
        ],
      },
    });
  });
}
