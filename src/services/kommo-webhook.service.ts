import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { ENV } from "@/config/env";

// ========================================
// KOMMO CRM WEBHOOK SERVICE
// ========================================

/**
 * Serviço para gerenciar webhooks do Kommo CRM
 * Documentação: https://developers.kommo.com/reference/add-webhooks
 */

// Eventos que queremos receber do Kommo
// Documentação: https://developers.kommo.com/reference/webhook-events
const KOMMO_WEBHOOK_SETTINGS = [
  "add_lead",      // Lead adicionado
  "update_lead",   // Lead atualizado
  "delete_lead",   // Lead deletado
  "status_lead",   // Status do lead alterado (mudança de etapa)
  "restore_lead",  // Lead restaurado
];

interface CreateWebhookParams {
  configIaId: string;
  funnelId: string;
  pipelineId: string;
}

interface KommoWebhook {
  id: number;
  destination: string;
  settings?: string[];
  created_at?: number;
  updated_at?: number;
}

interface KommoWebhooksResponse {
  _embedded?: {
    webhooks?: KommoWebhook[];
  };
}

export class KommoWebhookService {
  private static instance: KommoWebhookService;

  private constructor() {}

  public static getInstance(): KommoWebhookService {
    if (!KommoWebhookService.instance) {
      KommoWebhookService.instance = new KommoWebhookService();
    }
    return KommoWebhookService.instance;
  }

  /**
   * Obtém as credenciais do Kommo para um agente
   */
  private async getKommoCredentials(configIaId: string): Promise<{
    subdomain: string;
    accessToken: string;
  } | null> {
    const configIA = await db.configIA.findUnique({
      where: { id: configIaId },
      select: {
        kommoSubdomain: true,
        kommoAccessToken: true,
      },
    });

    if (!configIA?.kommoSubdomain || !configIA?.kommoAccessToken) {
      logWarn("Kommo credentials not found", { configIaId });
      return null;
    }

    return {
      subdomain: configIA.kommoSubdomain,
      accessToken: configIA.kommoAccessToken,
    };
  }

  /**
   * Gera a URL do webhook baseado no ambiente
   * @param funnelId - ID do funil do sistema (não o pipelineId do CRM!)
   */
  private getWebhookUrl(funnelId: string): string {
    const baseUrl = ENV.APP_URL || "http://localhost:3333";
    // Formato: /webhooks/[funnelId]/kommo
    // IMPORTANTE: Usamos funnelId do nosso sistema, não o pipelineId do Kommo
    // Isso evita URLs duplicadas quando múltiplos funis usam o mesmo pipeline
    return `${baseUrl}/webhooks/${funnelId}/kommo`;
  }

  /**
   * Cria webhook no Kommo para receber eventos de lead
   * Retorna o ID do webhook criado
   */
  async createWebhookForFunnel(params: CreateWebhookParams): Promise<string | null> {
    const { configIaId, funnelId, pipelineId } = params;

    const credentials = await this.getKommoCredentials(configIaId);
    if (!credentials) {
      throw new Error(
        "Kommo não está conectado. Configure as credenciais nas configurações do agente."
      );
    }

    const { subdomain, accessToken } = credentials;
    // IMPORTANTE: Usamos funnelId na URL, não pipelineId
    const webhookUrl = this.getWebhookUrl(funnelId);

    logInfo("Creating Kommo webhook for funnel", {
      configIaId,
      funnelId,
      pipelineId,
      webhookUrl,
      subdomain,
    });

    // Verificar se já existe webhook para essa URL
    try {
      const existingWebhooks = await this.listWebhooks(configIaId);
      const existingWebhook = existingWebhooks.find(
        (w) => w.destination === webhookUrl
      );

      if (existingWebhook) {
        logInfo("Webhook already exists for this URL", {
          webhookId: existingWebhook.id,
          webhookUrl,
        });
        return String(existingWebhook.id);
      }
    } catch (listError) {
      logWarn("Error listing existing webhooks, proceeding with creation", {
        error: listError instanceof Error ? listError.message : "Unknown error",
      });
    }

    // Criar novo webhook no Kommo
    try {
      const response = await axios.post(
        `https://${subdomain}.kommo.com/api/v4/webhooks`,
        {
          destination: webhookUrl,
          settings: KOMMO_WEBHOOK_SETTINGS,
        },
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      const webhookId = response.data?.id;

      if (!webhookId) {
        logError("Webhook created but no ID returned", { response: response.data });
        return null;
      }

      logInfo("Kommo webhook created successfully", {
        webhookId,
        webhookUrl,
        funnelId,
        pipelineId,
      });

      return String(webhookId);
    } catch (error: any) {
      // Se o erro indica que o webhook já existe, tentar encontrar o existente
      if (error.response?.status === 400 || error.response?.status === 422) {
        logInfo("Webhook may already exist, trying to find existing", {
          error: error.response?.data,
        });

        const existingWebhooks = await this.listWebhooks(configIaId);
        const existingWebhook = existingWebhooks.find(
          (w) => w.destination === webhookUrl
        );

        if (existingWebhook) {
          return String(existingWebhook.id);
        }
      }

      logError("Error creating Kommo webhook", {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      throw new Error(
        `Erro ao criar webhook no Kommo: ${error.response?.data?.detail || error.message}`
      );
    }
  }

  /**
   * Lista todos os webhooks configurados no Kommo
   */
  async listWebhooks(configIaId: string): Promise<KommoWebhook[]> {
    const credentials = await this.getKommoCredentials(configIaId);
    if (!credentials) {
      return [];
    }

    const { subdomain, accessToken } = credentials;

    try {
      const response = await axios.get<KommoWebhooksResponse>(
        `https://${subdomain}.kommo.com/api/v4/webhooks`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 15000,
        }
      );

      return response.data?._embedded?.webhooks || [];
    } catch (error: any) {
      logError("Error listing Kommo webhooks", {
        error: error.message,
        response: error.response?.data,
      });
      return [];
    }
  }

  /**
   * Deleta um webhook específico
   */
  async deleteWebhook(configIaId: string, webhookId: string): Promise<boolean> {
    const credentials = await this.getKommoCredentials(configIaId);
    if (!credentials) {
      return false;
    }

    const { subdomain, accessToken } = credentials;

    try {
      await axios.delete(
        `https://${subdomain}.kommo.com/api/v4/webhooks/${webhookId}`,
        {
          headers: {
            Authorization: `Bearer ${accessToken}`,
          },
          timeout: 15000,
        }
      );

      logInfo("Kommo webhook deleted", { webhookId });
      return true;
    } catch (error: any) {
      // Se retornar 404, o webhook já foi deletado
      if (error.response?.status === 404) {
        logInfo("Webhook already deleted or not found", { webhookId });
        return true;
      }

      logError("Error deleting Kommo webhook", {
        webhookId,
        error: error.message,
        response: error.response?.data,
      });
      return false;
    }
  }

  /**
   * Deleta todos os webhooks associados a uma URL específica
   */
  async deleteWebhooksByUrl(configIaId: string, funnelId: string): Promise<void> {
    const webhookUrl = this.getWebhookUrl(funnelId);

    try {
      const webhooks = await this.listWebhooks(configIaId);
      const toDelete = webhooks.filter((w) => w.destination === webhookUrl);

      logInfo("Deleting Kommo webhooks by URL", {
        url: webhookUrl,
        count: toDelete.length,
      });

      for (const webhook of toDelete) {
        await this.deleteWebhook(configIaId, String(webhook.id));
      }
    } catch (error: any) {
      logError("Error deleting webhooks by URL", { error: error.message });
    }
  }

  /**
   * Verifica se o webhook está configurado corretamente
   */
  async verifyWebhook(
    configIaId: string,
    funnelId: string
  ): Promise<{
    isConfigured: boolean;
    webhookId: string | null;
  }> {
    const webhooks = await this.listWebhooks(configIaId);
    const webhookUrl = this.getWebhookUrl(funnelId);

    const existingWebhook = webhooks.find((w) => w.destination === webhookUrl);

    return {
      isConfigured: !!existingWebhook,
      webhookId: existingWebhook ? String(existingWebhook.id) : null,
    };
  }

  /**
   * Configura ou reconfigura webhook para um funil
   * Se já existir, retorna o ID existente
   */
  async ensureWebhookConfigured(
    configIaId: string,
    funnelId: string,
    pipelineId: string
  ): Promise<string | null> {
    const verification = await this.verifyWebhook(configIaId, funnelId);

    if (verification.isConfigured && verification.webhookId) {
      logInfo("Kommo webhook already configured", {
        configIaId,
        pipelineId,
        webhookId: verification.webhookId,
      });
      return verification.webhookId;
    }

    logInfo("Configuring Kommo webhook", {
      configIaId,
      funnelId,
      pipelineId,
    });

    return this.createWebhookForFunnel({
      configIaId,
      funnelId,
      pipelineId,
    });
  }
}

// Exportar instância singleton
export const kommoWebhookService = KommoWebhookService.getInstance();
