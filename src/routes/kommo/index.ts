import { FastifyInstance, FastifyPluginOptions } from "fastify";
import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import { ENV } from "@/config/env";

// Kommo Webhook Settings - eventos que queremos receber
// Documentação: https://developers.kommo.com/reference/webhook-events
const KOMMO_WEBHOOK_SETTINGS = [
  "add_lead",      // Lead adicionado
  "update_lead",   // Lead atualizado
  "delete_lead",   // Lead deletado
  "status_lead",   // Status do lead alterado (mudança de etapa)
  "restore_lead",  // Lead restaurado
];

export default async function (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions
) {
  // Verificar credenciais e buscar pipelines do Kommo
  fastify.post("/verify", async (request, reply) => {
    try {
      const { subdomain, accessToken } = request.body as {
        subdomain: string;
        accessToken: string;
      };

      if (!subdomain || !accessToken) {
        return reply.code(400).send({
          success: false,
          message: "Subdomínio e access token são obrigatórios",
        });
      }

      const url = `https://${subdomain}.kommo.com/api/v4/leads/pipelines`;
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return reply.code(200).send({
        success: true,
        data: response.data,
      });
    } catch (error) {
      console.error("Error verifying Kommo credentials:", error);

      if (axios.isAxiosError(error)) {
        if (error.response) {
          const status = error.response.status;
          return reply.code(status).send({
            success: false,
            message:
              status === 401
                ? "Access token inválido ou expirado"
                : `Erro ${status}: Verifique o subdomínio e tente novamente`,
            error: error.response.data,
          });
        } else if (error.request) {
          return reply.code(503).send({
            success: false,
            message:
              "Não foi possível conectar à API do Kommo. Verifique sua conexão.",
          });
        }
      }

      return reply.code(500).send({
        success: false,
        message: "Erro ao verificar credenciais do Kommo",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  /**
   * Registrar webhook no Kommo CRM
   * POST /kommo/webhooks/register
   *
   * Documentação: https://developers.kommo.com/reference/add-webhooks
   *
   * Requer:
   * - funnelId: ID do funil local
   * - pipelineId: ID do pipeline no Kommo (para construir a URL do webhook)
   *
   * O endpoint busca as credenciais do Kommo via ConfigIA vinculado ao funil
   */
  fastify.post<{
    Body: {
      funnelId: string;
      pipelineId: string;
    };
  }>("/webhooks/register", async (request, reply) => {
    try {
      const { funnelId, pipelineId } = request.body;

      if (!funnelId || !pipelineId) {
        return reply.code(400).send({
          success: false,
          message: "funnelId e pipelineId são obrigatórios",
        });
      }

      // Buscar funil com ConfigIA vinculado
      const funnel = await db.funnel.findUnique({
        where: { id: funnelId },
        include: {
          configIa: {
            select: {
              kommoSubdomain: true,
              kommoAccessToken: true,
            },
          },
        },
      });

      if (!funnel) {
        return reply.code(404).send({
          success: false,
          message: "Funil não encontrado",
        });
      }

      if (!funnel.configIa?.kommoSubdomain || !funnel.configIa?.kommoAccessToken) {
        return reply.code(400).send({
          success: false,
          message: "Funil não possui configuração Kommo válida (verifique o agente vinculado)",
        });
      }

      const { kommoSubdomain, kommoAccessToken } = funnel.configIa;

      // Construir URL do webhook
      // IMPORTANTE: Usamos funnelId na URL, não pipelineId do CRM
      // Formato: {APP_URL}/webhooks/{funnelId}/kommo
      // Isso evita URLs duplicadas quando múltiplos funis usam o mesmo pipeline
      const backendUrl = ENV.APP_URL || process.env.APP_URL || "http://localhost:3333";
      const webhookUrl = `${backendUrl}/webhooks/${funnelId}/kommo`;

      logInfo("Registering Kommo webhook", {
        funnelId,
        pipelineId,
        webhookUrl,
        subdomain: kommoSubdomain,
      });

      // Verificar se já existe webhook para essa URL
      try {
        const existingWebhooks = await axios.get(
          `https://${kommoSubdomain}.kommo.com/api/v4/webhooks`,
          {
            headers: { Authorization: `Bearer ${kommoAccessToken}` },
            timeout: 15000,
          }
        );

        const webhooks = existingWebhooks.data?._embedded?.webhooks || [];
        const existingWebhook = webhooks.find((w: any) => w.destination === webhookUrl);

        if (existingWebhook) {
          logInfo("Webhook already exists for this URL", {
            webhookId: existingWebhook.id,
            webhookUrl,
          });

          // Atualizar funil com o ID do webhook existente
          await db.funnel.update({
            where: { id: funnelId },
            data: {
              kommoWebhookId: String(existingWebhook.id),
              kommoPipelineId: pipelineId,
            },
          });

          return reply.code(200).send({
            success: true,
            message: "Webhook já existia e foi vinculado ao funil",
            data: {
              webhookId: existingWebhook.id,
              webhookUrl,
              isNew: false,
            },
          });
        }
      } catch (listError) {
        logWarn("Error listing existing webhooks, proceeding with creation", {
          error: listError instanceof Error ? listError.message : "Unknown error",
        });
      }

      // Criar novo webhook no Kommo
      const createResponse = await axios.post(
        `https://${kommoSubdomain}.kommo.com/api/v4/webhooks`,
        {
          destination: webhookUrl,
          settings: KOMMO_WEBHOOK_SETTINGS,
        },
        {
          headers: {
            Authorization: `Bearer ${kommoAccessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      const webhookId = createResponse.data?.id;

      if (!webhookId) {
        logError("Webhook created but no ID returned", { response: createResponse.data });
        return reply.code(500).send({
          success: false,
          message: "Webhook criado mas ID não foi retornado",
        });
      }

      // Atualizar funil com o ID do webhook
      await db.funnel.update({
        where: { id: funnelId },
        data: {
          kommoWebhookId: String(webhookId),
          kommoPipelineId: pipelineId,
        },
      });

      logInfo("Kommo webhook created successfully", {
        webhookId,
        webhookUrl,
        funnelId,
        pipelineId,
      });

      return reply.code(201).send({
        success: true,
        message: "Webhook Kommo criado com sucesso",
        data: {
          webhookId,
          webhookUrl,
          settings: KOMMO_WEBHOOK_SETTINGS,
          isNew: true,
        },
      });
    } catch (error) {
      logError("Error registering Kommo webhook", error as Error);

      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        const errorData = error.response?.data;

        if (status === 401) {
          return reply.code(401).send({
            success: false,
            message: "Access token inválido ou expirado",
          });
        }

        if (status === 403) {
          return reply.code(403).send({
            success: false,
            message: "Sem permissão para criar webhooks. Necessário ser administrador da conta Kommo.",
          });
        }

        return reply.code(status || 500).send({
          success: false,
          message: `Erro ao criar webhook no Kommo: ${errorData?.detail || errorData?.title || "Erro desconhecido"}`,
          error: errorData,
        });
      }

      return reply.code(500).send({
        success: false,
        message: "Erro interno ao criar webhook",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  /**
   * Remover webhook do Kommo CRM
   * DELETE /kommo/webhooks/:webhookId
   */
  fastify.delete<{
    Params: { webhookId: string };
    Body: {
      funnelId: string;
    };
  }>("/webhooks/:webhookId", async (request, reply) => {
    try {
      const { webhookId } = request.params;
      const { funnelId } = request.body;

      if (!funnelId) {
        return reply.code(400).send({
          success: false,
          message: "funnelId é obrigatório",
        });
      }

      // Buscar funil com ConfigIA vinculado
      const funnel = await db.funnel.findUnique({
        where: { id: funnelId },
        include: {
          configIa: {
            select: {
              kommoSubdomain: true,
              kommoAccessToken: true,
            },
          },
        },
      });

      if (!funnel) {
        return reply.code(404).send({
          success: false,
          message: "Funil não encontrado",
        });
      }

      if (!funnel.configIa?.kommoSubdomain || !funnel.configIa?.kommoAccessToken) {
        return reply.code(400).send({
          success: false,
          message: "Funil não possui configuração Kommo válida",
        });
      }

      const { kommoSubdomain, kommoAccessToken } = funnel.configIa;

      logInfo("Deleting Kommo webhook", {
        webhookId,
        funnelId,
        subdomain: kommoSubdomain,
      });

      // Deletar webhook no Kommo
      await axios.delete(
        `https://${kommoSubdomain}.kommo.com/api/v4/webhooks/${webhookId}`,
        {
          headers: { Authorization: `Bearer ${kommoAccessToken}` },
          timeout: 15000,
        }
      );

      // Limpar ID do webhook no funil
      await db.funnel.update({
        where: { id: funnelId },
        data: { kommoWebhookId: null },
      });

      logInfo("Kommo webhook deleted successfully", {
        webhookId,
        funnelId,
      });

      return reply.code(200).send({
        success: true,
        message: "Webhook removido com sucesso",
      });
    } catch (error) {
      logError("Error deleting Kommo webhook", error as Error);

      if (axios.isAxiosError(error)) {
        // Se o webhook não existe mais no Kommo, apenas limpar localmente
        if (error.response?.status === 404) {
          const { funnelId } = request.body;
          if (funnelId) {
            await db.funnel.update({
              where: { id: funnelId },
              data: { kommoWebhookId: null },
            });
          }

          return reply.code(200).send({
            success: true,
            message: "Webhook não existia no Kommo, registro local removido",
          });
        }

        return reply.code(error.response?.status || 500).send({
          success: false,
          message: "Erro ao remover webhook do Kommo",
          error: error.response?.data,
        });
      }

      return reply.code(500).send({
        success: false,
        message: "Erro interno ao remover webhook",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  /**
   * Listar webhooks existentes no Kommo
   * GET /kommo/webhooks/list
   */
  fastify.post<{
    Body: {
      subdomain: string;
      accessToken: string;
    };
  }>("/webhooks/list", async (request, reply) => {
    try {
      const { subdomain, accessToken } = request.body;

      if (!subdomain || !accessToken) {
        return reply.code(400).send({
          success: false,
          message: "subdomain e accessToken são obrigatórios",
        });
      }

      const response = await axios.get(
        `https://${subdomain}.kommo.com/api/v4/webhooks`,
        {
          headers: { Authorization: `Bearer ${accessToken}` },
          timeout: 15000,
        }
      );

      return reply.code(200).send({
        success: true,
        data: response.data?._embedded?.webhooks || [],
      });
    } catch (error) {
      logError("Error listing Kommo webhooks", error as Error);

      if (axios.isAxiosError(error)) {
        return reply.code(error.response?.status || 500).send({
          success: false,
          message: "Erro ao listar webhooks do Kommo",
          error: error.response?.data,
        });
      }

      return reply.code(500).send({
        success: false,
        message: "Erro interno ao listar webhooks",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });
}
