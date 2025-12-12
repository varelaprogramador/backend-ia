import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { ENV } from "@/config/env";

// ========================================
// RD STATION CRM WEBHOOK SERVICE
// ========================================

/**
 * Servico para gerenciar webhooks do RD Station CRM v2
 * Documentacao: https://developers.rdstation.com/reference/crm-v2-create-webhook
 */

const RDSTATION_CRM_API_URL = "https://api.rd.services/crm/v2";

// Tipos de eventos suportados para deals
const DEAL_EVENTS = [
  "crm_deal_created",
  "crm_deal_updated",
  "crm_deal_deleted",
] as const;

interface CreateWebhookParams {
  configIaId: string;
  webhookUrl: string;
  agentName?: string;
  funnelId?: string;
  pipelineId?: string; // ID do pipeline do RD Station para URL dinâmica
}

interface WebhookData {
  id: string;
  name?: string;
  url: string;
  http_method: string;
  event_name?: string;
  entity_type?: string;
  event_type?: string;
  status?: string;
  created_at?: string;
  updated_at?: string;
}

// Resposta da API do RD Station para criação de webhook
// A API retorna { data: { id, name, ... } }
interface WebhookResponse {
  data?: WebhookData;
  // Fallback para caso a API retorne diretamente os dados
  id?: string;
  url?: string;
  http_method?: string;
  event_type?: string;
}

// Estrutura de webhook retornada na listagem
interface ListedWebhook {
  id: string;
  url: string;
  http_method: string;
  event_type: string;
  entity_type?: string;
  created_at?: string;
}

interface ListWebhooksResponse {
  webhooks: ListedWebhook[];
}

export class RDStationWebhookService {
  private static instance: RDStationWebhookService;

  private constructor() {}

  public static getInstance(): RDStationWebhookService {
    if (!RDStationWebhookService.instance) {
      RDStationWebhookService.instance = new RDStationWebhookService();
    }
    return RDStationWebhookService.instance;
  }

  /**
   * Obtem o access token do RD Station para um agente
   */
  private async getAccessToken(configIaId: string): Promise<string | null> {
    const configIA = await db.configIA.findUnique({
      where: { id: configIaId },
      select: {
        rdstationAccessToken: true,
        rdstationRefreshToken: true,
        rdstationClientId: true,
        rdstationClientSecret: true,
      },
    });

    if (!configIA?.rdstationAccessToken) {
      logWarn("RD Station access token not found", { configIaId });
      return null;
    }

    return configIA.rdstationAccessToken;
  }

  /**
   * Gera a URL do webhook baseado no ambiente
   * @param pipelineId - ID do pipeline do RD Station (opcional, usa formato antigo se não fornecido)
   */
  private getWebhookUrl(pipelineId?: string): string {
    // Em producao, usar a URL configurada
    // Em desenvolvimento, pode usar ngrok ou similar
    const baseUrl = ENV.APP_URL || "http://localhost:3333";

    // Se temos pipelineId, usar novo formato com rota dinâmica
    // Formato: /webhooks/[pipelineId]/rdstation
    if (pipelineId) {
      return `${baseUrl}/webhooks/${pipelineId}/rdstation`;
    }

    // Fallback para formato antigo (compatibilidade)
    return `${baseUrl}/webhooks/rdstation-crm`;
  }

  /**
   * Cria webhooks no RD Station para todos os eventos de deal
   * Retorna os IDs dos webhooks criados
   * Formato API v2: { "data": { "event_name": "crm_deal_created" }, "name": "..." }
   */
  async createWebhooksForFunnel(params: CreateWebhookParams): Promise<string[]> {
    const { configIaId, webhookUrl, agentName, funnelId, pipelineId } = params;

    const accessToken = await this.getAccessToken(configIaId);
    if (!accessToken) {
      throw new Error("RD Station não está conectado. Autorize primeiro nas configurações do agente.");
    }

    // Usar URL customizada, ou gerar com pipelineId, ou fallback para URL antiga
    const url = webhookUrl || this.getWebhookUrl(pipelineId);
    const createdWebhookIds: string[] = [];

    // Gera o nome do webhook: "agentName + funnelId"
    const webhookBaseName = agentName && funnelId
      ? `${agentName} - ${funnelId}`
      : agentName || funnelId || "EAD10 Webhook";

    logInfo("Creating RD Station webhooks", {
      configIaId,
      webhookUrl: url,
      webhookBaseName,
      pipelineId,
      events: DEAL_EVENTS,
    });

    for (const eventType of DEAL_EVENTS) {
      try {
        // Nome do webhook inclui o tipo de evento para identificação
        const eventNameShort = eventType.replace("crm_deal_", "");
        const webhookName = `${webhookBaseName} - ${eventNameShort}`;

        // Formato correto da API v2 do RD Station
        // Todos os campos ficam dentro do objeto "data"
        const response = await axios.post<WebhookResponse>(
          `${RDSTATION_CRM_API_URL}/webhooks`,
          {
            data: {
              url,
              name: webhookName,
              event_name: eventType,
              http_method: "POST",
            },
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          }
        );

        // A resposta do RD Station vem em { data: { id, name, ... } }
        // O axios já unwrappa o primeiro 'data', então acessamos response.data.data
        const webhookData = response.data?.data || response.data;
        if (webhookData?.id) {
          createdWebhookIds.push(webhookData.id);
          logInfo("RD Station webhook created", {
            webhookId: webhookData.id,
            webhookName,
            eventType,
            url,
          });
        }
      } catch (error: any) {
        // Se o webhook ja existe, tentar buscar o ID existente
        if (error.response?.status === 422 || error.response?.data?.error?.includes("already exists")) {
          logInfo("Webhook may already exist, trying to find existing", { eventType });
          const existingId = await this.findExistingWebhook(accessToken, url, eventType);
          if (existingId) {
            createdWebhookIds.push(existingId);
          }
        } else {
          logError("Error creating RD Station webhook", {
            eventType,
            error: error.message,
            response: error.response?.data,
          });
        }
      }
    }

    return createdWebhookIds;
  }

  /**
   * Busca webhook existente por URL e tipo de evento
   * Se não encontrar com URL exata, busca apenas pelo event_type (para reuso)
   */
  private async findExistingWebhook(
    accessToken: string,
    url: string,
    eventType: string
  ): Promise<string | null> {
    try {
      const response = await axios.get<ListWebhooksResponse>(
        `${RDSTATION_CRM_API_URL}/webhooks`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 15000,
        }
      );

      const webhooks = response.data?.webhooks || [];

      logInfo("Searching for existing webhook", {
        targetUrl: url,
        targetEventType: eventType,
        existingWebhooks: webhooks.map(w => ({ id: w.id, url: w.url, event_type: w.event_type })),
      });

      // Primeiro tenta encontrar com URL exata
      let existing = webhooks.find(
        (w) => w.url === url && w.event_type === eventType
      );

      // Se não encontrar, busca apenas pelo event_type (webhook já existe com outra URL)
      if (!existing) {
        existing = webhooks.find((w) => w.event_type === eventType);
        if (existing) {
          logInfo("Found existing webhook with different URL", {
            webhookId: existing.id,
            existingUrl: existing.url,
            targetUrl: url,
            eventType,
          });
        }
      }

      return existing?.id || null;
    } catch (error: any) {
      logError("Error finding existing webhook", { error: error.message });
      return null;
    }
  }

  /**
   * Lista todos os webhooks configurados
   */
  async listWebhooks(configIaId: string): Promise<ListedWebhook[]> {
    const accessToken = await this.getAccessToken(configIaId);
    if (!accessToken) {
      return [];
    }

    try {
      const response = await axios.get<ListWebhooksResponse>(
        `${RDSTATION_CRM_API_URL}/webhooks`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 15000,
        }
      );

      return response.data?.webhooks || [];
    } catch (error: any) {
      logError("Error listing RD Station webhooks", {
        error: error.message,
        response: error.response?.data,
      });
      return [];
    }
  }

  /**
   * Deleta um webhook especifico
   */
  async deleteWebhook(configIaId: string, webhookId: string): Promise<boolean> {
    const accessToken = await this.getAccessToken(configIaId);
    if (!accessToken) {
      return false;
    }

    try {
      await axios.delete(`${RDSTATION_CRM_API_URL}/webhooks/${webhookId}`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 15000,
      });

      logInfo("RD Station webhook deleted", { webhookId });
      return true;
    } catch (error: any) {
      // Se retornar 404, o webhook ja foi deletado
      if (error.response?.status === 404) {
        logInfo("Webhook already deleted or not found", { webhookId });
        return true;
      }

      logError("Error deleting RD Station webhook", {
        webhookId,
        error: error.message,
        response: error.response?.data,
      });
      return false;
    }
  }

  /**
   * Deleta multiplos webhooks
   */
  async deleteWebhooks(configIaId: string, webhookIds: string[]): Promise<void> {
    for (const webhookId of webhookIds) {
      await this.deleteWebhook(configIaId, webhookId);
    }
  }

  /**
   * Deleta todos os webhooks associados a uma URL especifica
   */
  async deleteWebhooksByUrl(configIaId: string, url?: string): Promise<void> {
    const accessToken = await this.getAccessToken(configIaId);
    if (!accessToken) {
      return;
    }

    const targetUrl = url || this.getWebhookUrl();

    try {
      const webhooks = await this.listWebhooks(configIaId);
      const toDelete = webhooks.filter((w) => w.url === targetUrl);

      logInfo("Deleting RD Station webhooks by URL", {
        url: targetUrl,
        count: toDelete.length,
      });

      for (const webhook of toDelete) {
        await this.deleteWebhook(configIaId, webhook.id);
      }
    } catch (error: any) {
      logError("Error deleting webhooks by URL", { error: error.message });
    }
  }

  /**
   * Verifica se os webhooks estao configurados corretamente
   */
  async verifyWebhooks(configIaId: string, pipelineId?: string): Promise<{
    isConfigured: boolean;
    missingEvents: string[];
    configuredEvents: string[];
  }> {
    const webhooks = await this.listWebhooks(configIaId);
    const webhookUrl = this.getWebhookUrl(pipelineId);

    const configuredEvents = webhooks
      .filter((w) => w.url === webhookUrl)
      .map((w) => w.event_type);

    const missingEvents = DEAL_EVENTS.filter(
      (e) => !configuredEvents.includes(e)
    );

    return {
      isConfigured: missingEvents.length === 0,
      missingEvents,
      configuredEvents,
    };
  }

  /**
   * Configura ou reconfigura webhooks para um funil
   * Se ja existirem, verifica e cria apenas os faltantes
   */
  async ensureWebhooksConfigured(
    configIaId: string,
    agentName?: string,
    funnelId?: string,
    pipelineId?: string
  ): Promise<string[]> {
    const verification = await this.verifyWebhooks(configIaId, pipelineId);

    if (verification.isConfigured) {
      logInfo("RD Station webhooks already configured", {
        configIaId,
        events: verification.configuredEvents,
      });
      return [];
    }

    logInfo("Configuring missing RD Station webhooks", {
      configIaId,
      missingEvents: verification.missingEvents,
    });

    // Criar apenas os webhooks faltantes
    const accessToken = await this.getAccessToken(configIaId);
    if (!accessToken) {
      throw new Error("RD Station não está conectado");
    }

    const webhookUrl = this.getWebhookUrl(pipelineId);
    const createdIds: string[] = [];

    // Gera o nome do webhook: "agentName + funnelId"
    const webhookBaseName = agentName && funnelId
      ? `${agentName} - ${funnelId}`
      : agentName || funnelId || "EAD10 Webhook";

    for (const eventType of verification.missingEvents) {
      try {
        // Nome do webhook inclui o tipo de evento para identificação
        const eventNameShort = eventType.replace("crm_deal_", "");
        const webhookName = `${webhookBaseName} - ${eventNameShort}`;

        // Formato correto da API v2 do RD Station
        // Todos os campos ficam dentro do objeto "data"
        const response = await axios.post<WebhookResponse>(
          `${RDSTATION_CRM_API_URL}/webhooks`,
          {
            data: {
              url: webhookUrl,
              name: webhookName,
              event_name: eventType,
              http_method: "POST",
            },
          },
          {
            headers: {
              Authorization: `Bearer ${accessToken}`,
              "Content-Type": "application/json",
            },
            timeout: 15000,
          }
        );

        if (response.data?.id) {
          createdIds.push(response.data.id);
          logInfo("Missing webhook created", {
            webhookId: response.data.id,
            webhookName,
            eventType,
          });
        }
      } catch (error: any) {
        logError("Error creating missing webhook", {
          eventType,
          error: error.message,
        });
      }
    }

    return createdIds;
  }
}

// Exportar instancia singleton
export const rdstationWebhookService = RDStationWebhookService.getInstance();
