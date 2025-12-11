import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/utils/logger";

// RD Station CRM v2 OAuth Configuration
// Documentação: https://developers.rdstation.com/reference/crm-v2-authentication-step-2
const RDSTATION_TOKEN_URL = "https://api.rd.services/oauth2/token";
const RDSTATION_CRM_API_URL = "https://api.rd.services/crm/v2";


export default async function (fastify: FastifyInstance) {
  /**
   * RD Station CRM v2 OAuth Callback
   * Recebe o código de autorização e envia via postMessage para o frontend (popup)
   *
   * URL de callback para configurar no RD Station:
   * - A mesma URL usada no frontend: ${NEXT_PUBLIC_API_URL}/oauth/rdstation/callback
   * - Ex: https://seu-ngrok.ngrok-free.app/oauth/rdstation/callback
   */
  fastify.get<{
    Querystring: {
      code?: string;
      state?: string;
      error?: string;
      error_description?: string;
    };
  }>("/rdstation/callback", async (req, reply) => {
    const { code, error, error_description } = req.query;

    logInfo("RD Station OAuth callback received", {
      hasCode: !!code,
      error,
      error_description,
    });

    // Retornar página HTML que envia o código via postMessage e fecha o popup
    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>RD Station - Autorização</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      display: flex;
      justify-content: center;
      align-items: center;
      height: 100vh;
      margin: 0;
      background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
      color: white;
    }
    .container {
      text-align: center;
      padding: 40px;
      background: rgba(255,255,255,0.1);
      border-radius: 16px;
      backdrop-filter: blur(10px);
    }
    .spinner {
      width: 50px;
      height: 50px;
      border: 4px solid rgba(255,255,255,0.3);
      border-top-color: white;
      border-radius: 50%;
      animation: spin 1s linear infinite;
      margin: 0 auto 20px;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .success { color: #4ade80; }
    .error { color: #f87171; }
    h2 { margin: 0 0 10px; }
    p { margin: 0; opacity: 0.9; }
  </style>
</head>
<body>
  <div class="container">
    <div class="spinner" id="spinner"></div>
    <h2 id="title">Processando...</h2>
    <p id="message">Aguarde enquanto finalizamos a autorização</p>
  </div>
  <script>
    (function() {
      const code = ${code ? `"${code}"` : "null"};
      const error = ${error ? `"${error}"` : "null"};
      const errorDescription = ${error_description ? `"${error_description.replace(/"/g, '\\"')}"` : "null"};

      const spinner = document.getElementById('spinner');
      const title = document.getElementById('title');
      const message = document.getElementById('message');

      if (error) {
        spinner.style.display = 'none';
        title.textContent = 'Erro na Autorização';
        title.className = 'error';
        message.textContent = errorDescription || error || 'Ocorreu um erro durante a autorização';

        // Enviar erro via postMessage
        if (window.opener) {
          window.opener.postMessage({
            type: 'RDSTATION_AUTH_ERROR',
            error: error,
            error_description: errorDescription
          }, '*');
        }

        // Fechar popup após 3 segundos
        setTimeout(() => window.close(), 3000);
      } else if (code) {
        spinner.style.display = 'none';
        title.textContent = 'Autorização Concluída!';
        title.className = 'success';
        message.textContent = 'Você pode fechar esta janela';

        // Enviar código via postMessage
        if (window.opener) {
          window.opener.postMessage({
            type: 'RDSTATION_AUTH_CODE',
            code: code
          }, '*');
        }

        // Fechar popup após 1 segundo
        setTimeout(() => window.close(), 1000);
      } else {
        spinner.style.display = 'none';
        title.textContent = 'Erro';
        title.className = 'error';
        message.textContent = 'Código de autorização não recebido';

        setTimeout(() => window.close(), 3000);
      }
    })();
  </script>
</body>
</html>
    `.trim();

    return reply.type("text/html").send(html);
  });

  /**
   * Trocar código de autorização por access_token
   * Chamado pelo frontend após receber o código via postMessage
   */
  fastify.post<{
    Body: {
      configIAId: string;
      code: string;
      redirectUri: string; // A mesma redirect_uri usada na autorização
    };
  }>("/rdstation/exchange-token", async (req, reply) => {
    const { configIAId, code, redirectUri } = req.body;

    if (!configIAId || !code || !redirectUri) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "configIAId, code e redirectUri são obrigatórios",
      });
    }

    try {
      // Buscar ConfigIA para obter Client ID e Secret
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          id: true,
          nome: true,
          rdstationClientId: true,
          rdstationClientSecret: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração de agente não encontrada",
        });
      }

      if (!configIA.rdstationClientId || !configIA.rdstationClientSecret) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          success: false,
          error: "Client ID ou Client Secret não configurados",
        });
      }

      logInfo("Exchanging RD Station code for access_token", {
        configIAId,
        redirectUri,
      });

      // Trocar código por access_token
      // RD Station CRM v2 usa application/x-www-form-urlencoded
      const tokenResponse = await axios.post(
        RDSTATION_TOKEN_URL,
        new URLSearchParams({
          client_id: configIA.rdstationClientId,
          client_secret: configIA.rdstationClientSecret,
          code: code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 15000,
        }
      );

      const { access_token, refresh_token, expires_in } = tokenResponse.data;

      if (!access_token) {
        throw new Error("Access token não recebido do RD Station");
      }

      logInfo("RD Station access_token received", {
        configIAId,
        hasRefreshToken: !!refresh_token,
        expiresIn: expires_in,
      });

      // Atualizar ConfigIA com os tokens
      await db.configIA.update({
        where: { id: configIAId },
        data: {
          rdstationAccessToken: access_token,
          rdstationRefreshToken: refresh_token || null,
          rdstationCode: code,
        },
      });

      logInfo("RD Station tokens saved to ConfigIA", {
        configIAId,
        agentName: configIA.nome,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "RD Station CRM conectado com sucesso!",
        data: {
          hasRefreshToken: !!refresh_token,
          expiresIn: expires_in,
        },
      });
    } catch (error: any) {
      logError("Error exchanging RD Station code for token", {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      const errorMessage =
        error.response?.data?.error_description ||
        error.response?.data?.error ||
        error.message ||
        "Erro ao conectar com RD Station";

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: errorMessage,
        details: error.response?.data,
      });
    }
  });

  /**
   * Verificar status da conexão com RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
  }>("/rdstation/status/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationClientId: true,
          rdstationClientSecret: true,
          rdstationAccessToken: true,
          rdstationRefreshToken: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração não encontrada",
        });
      }

      const hasCredentials =
        !!configIA.rdstationClientId && !!configIA.rdstationClientSecret;
      const isConnected = !!configIA.rdstationAccessToken;

      // Se conectado, verificar se o token ainda é válido fazendo uma requisição de teste
      let isTokenValid = false;
      if (isConnected) {
        try {
          // Testar token com endpoint de usuários (leve)
          await axios.get(`${RDSTATION_CRM_API_URL}/users`, {
            headers: {
              Authorization: `Bearer ${configIA.rdstationAccessToken}`,
            },
            timeout: 10000,
          });
          isTokenValid = true;
        } catch (error: any) {
          // Token expirado ou inválido
          isTokenValid = false;
          logInfo("RD Station token is invalid or expired", { configIAId });
        }
      }

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          hasCredentials,
          isConnected,
          isTokenValid,
          hasRefreshToken: !!configIA.rdstationRefreshToken,
        },
      });
    } catch (error: any) {
      logError("Error checking RD Station status", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao verificar status do RD Station",
      });
    }
  });

  /**
   * Renovar access_token usando refresh_token
   */
  fastify.post<{
    Body: { configIAId: string };
  }>("/rdstation/refresh", async (req, reply) => {
    const { configIAId } = req.body;

    if (!configIAId) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "configIAId é obrigatório",
      });
    }

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationClientId: true,
          rdstationClientSecret: true,
          rdstationRefreshToken: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração não encontrada",
        });
      }

      if (!configIA.rdstationRefreshToken) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          success: false,
          error: "Refresh token não disponível. Reconecte com o RD Station.",
        });
      }

      // Renovar token usando refresh_token
      const tokenResponse = await axios.post(
        RDSTATION_TOKEN_URL,
        new URLSearchParams({
          client_id: configIA.rdstationClientId!,
          client_secret: configIA.rdstationClientSecret!,
          refresh_token: configIA.rdstationRefreshToken,
          grant_type: "refresh_token",
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 15000,
        }
      );

      const { access_token, refresh_token } = tokenResponse.data;

      // Atualizar tokens
      await db.configIA.update({
        where: { id: configIAId },
        data: {
          rdstationAccessToken: access_token,
          rdstationRefreshToken: refresh_token || configIA.rdstationRefreshToken,
        },
      });

      logInfo("RD Station token refreshed", { configIAId });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "Token renovado com sucesso",
      });
    } catch (error: any) {
      logError("Error refreshing RD Station token", {
        error: error.message,
        response: error.response?.data,
      });

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao renovar token do RD Station",
      });
    }
  });

  /**
   * Desconectar RD Station (limpar tokens)
   */
  fastify.delete<{
    Params: { configIAId: string };
  }>("/rdstation/disconnect/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;

    try {
      await db.configIA.update({
        where: { id: configIAId },
        data: {
          rdstationAccessToken: null,
          rdstationRefreshToken: null,
          rdstationCode: null,
        },
      });

      logInfo("RD Station disconnected", { configIAId });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "RD Station desconectado com sucesso",
      });
    } catch (error: any) {
      logError("Error disconnecting RD Station", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao desconectar RD Station",
      });
    }
  });

  // ========================================
  // RD Station CRM v2 API Endpoints
  // ========================================

  /**
   * Listar deals/oportunidades do RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
    Querystring: {
      page?: number;
      limit?: number;
      deal_stage_id?: string;
    };
  }>("/rdstation/deals/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;
    const { page = 1, limit = 20, deal_stage_id } = req.query;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      const params: any = { page, limit };
      if (deal_stage_id) params.deal_stage_id = deal_stage_id;

      const response = await axios.get(`${RDSTATION_CRM_API_URL}/deals`, {
        headers: {
          Authorization: `Bearer ${configIA.rdstationAccessToken}`,
        },
        params,
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM deals", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado. Tente renovar ou reconectar.",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar oportunidades do RD Station CRM",
      });
    }
  });

  /**
   * Criar deal/oportunidade no RD Station CRM
   */
  fastify.post<{
    Params: { configIAId: string };
    Body: {
      name: string;
      deal_stage_id?: string;
      organization_id?: string;
      contact_id?: string;
      user_id?: string;
      deal_value?: number;
      deal_source_id?: string;
      rating?: number;
      win?: boolean;
      prediction_date?: string;
      custom_fields?: Record<string, any>;
    };
  }>("/rdstation/deals/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;
    const dealData = req.body;

    if (!dealData.name) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "Nome da oportunidade é obrigatório",
      });
    }

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      const response = await axios.post(
        `${RDSTATION_CRM_API_URL}/deals`,
        dealData,
        {
          headers: {
            Authorization: `Bearer ${configIA.rdstationAccessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      logInfo("Deal created in RD Station CRM", {
        configIAId,
        dealId: response.data?.id,
      });

      return reply.code(StatusCodes.CREATED).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error creating RD Station CRM deal", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao criar oportunidade no RD Station CRM",
        details: error.response?.data,
      });
    }
  });

  /**
   * Listar contatos do RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
    Querystring: {
      page?: number;
      limit?: number;
      q?: string;
    };
  }>("/rdstation/contacts/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;
    const { page = 1, limit = 20, q } = req.query;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      const params: any = { page, limit };
      if (q) params.q = q;

      const response = await axios.get(`${RDSTATION_CRM_API_URL}/contacts`, {
        headers: {
          Authorization: `Bearer ${configIA.rdstationAccessToken}`,
        },
        params,
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM contacts", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar contatos do RD Station CRM",
      });
    }
  });

  /**
   * Criar contato no RD Station CRM
   */
  fastify.post<{
    Params: { configIAId: string };
    Body: {
      name: string;
      title?: string;
      emails?: Array<{ email: string }>;
      phones?: Array<{ phone: string; type?: string }>;
      organization_id?: string;
      custom_fields?: Record<string, any>;
    };
  }>("/rdstation/contacts/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;
    const contactData = req.body;

    if (!contactData.name) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "Nome do contato é obrigatório",
      });
    }

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      const response = await axios.post(
        `${RDSTATION_CRM_API_URL}/contacts`,
        contactData,
        {
          headers: {
            Authorization: `Bearer ${configIA.rdstationAccessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      logInfo("Contact created in RD Station CRM", {
        configIAId,
        contactId: response.data?.id,
      });

      return reply.code(StatusCodes.CREATED).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error creating RD Station CRM contact", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao criar contato no RD Station CRM",
        details: error.response?.data,
      });
    }
  });

  /**
   * Listar etapas de um pipeline específico do RD Station CRM
   * Endpoint: GET /pipelines/{pipeline_id}/stages
   * Documentação: https://developers.rdstation.com/reference/crm-v2-list-stages
   */
  fastify.get<{
    Params: { configIAId: string; pipelineId: string };
  }>("/rdstation/pipelines/:pipelineId/stages/:configIAId", async (req, reply) => {
    const { configIAId, pipelineId } = req.params;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      // RD Station CRM v2 API - listar stages de um pipeline específico
      // Documentação: https://developers.rdstation.com/reference/crm-v2-list-stages
      const response = await axios.get(
        `${RDSTATION_CRM_API_URL}/pipelines/${pipelineId}/stages`,
        {
          headers: {
            Authorization: `Bearer ${configIA.rdstationAccessToken}`,
          },
          params: {
            "page[number]": 1,
            "page[size]": 100, // Buscar até 100 estágios
          },
          timeout: 15000,
        }
      );

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM pipeline stages", {
        error: error.message,
        pipelineId,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar etapas do funil do RD Station CRM",
      });
    }
  });

  /**
   * Listar negociações (deals) de um pipeline específico do RD Station CRM
   * Endpoint: GET /deals?pipeline_id={pipeline_id}
   * Documentação: https://developers.rdstation.com/reference/crm-v2-list-deals
   */
  fastify.get<{
    Params: { configIAId: string; pipelineId: string };
    Querystring: { page?: string; limit?: string };
  }>("/rdstation/pipelines/:pipelineId/deals/:configIAId", async (req, reply) => {
    const { configIAId, pipelineId } = req.params;
    const { page = "1", limit = "100" } = req.query;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      // RD Station CRM v2 API - listar deals de um pipeline específico
      // Documentação: https://developers.rdstation.com/reference/crm-v2-list-deals
      const response = await axios.get(`${RDSTATION_CRM_API_URL}/deals`, {
        headers: {
          Authorization: `Bearer ${configIA.rdstationAccessToken}`,
        },
        params: {
          "page[number]": parseInt(page),
          "page[size]": parseInt(limit),
          "pipeline_id": pipelineId,
        },
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM deals", {
        error: error.message,
        pipelineId,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar negociações do RD Station CRM",
      });
    }
  });

  /**
   * Listar pipelines/funis do RD Station CRM
   * Se tiver code mas não tiver accessToken, tenta fazer o token exchange automaticamente
   */
  fastify.get<{
    Params: { configIAId: string };
    Querystring: { redirectUri?: string };
  }>("/rdstation/pipelines/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;
    const { redirectUri } = req.query;

    try {
      let configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          id: true,
          nome: true,
          rdstationClientId: true,
          rdstationClientSecret: true,
          rdstationAccessToken: true,
          rdstationRefreshToken: true,
          rdstationCode: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração não encontrada",
        });
      }

      // Se tem code mas não tem accessToken, tentar fazer o token exchange
      if (!configIA.rdstationAccessToken && configIA.rdstationCode && configIA.rdstationClientId && configIA.rdstationClientSecret) {
        logInfo("Attempting automatic token exchange for RD Station", { configIAId });

        // Determinar o redirectUri para o token exchange
        const exchangeRedirectUri = redirectUri || `${process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'}/api/rdstation/callback`;

        try {
          const tokenResponse = await axios.post(
            RDSTATION_TOKEN_URL,
            new URLSearchParams({
              client_id: configIA.rdstationClientId,
              client_secret: configIA.rdstationClientSecret,
              code: configIA.rdstationCode,
              redirect_uri: exchangeRedirectUri,
              grant_type: "authorization_code",
            }).toString(),
            {
              headers: {
                "Content-Type": "application/x-www-form-urlencoded",
              },
              timeout: 15000,
            }
          );

          const { access_token, refresh_token } = tokenResponse.data;

          if (access_token) {
            // Atualizar ConfigIA com os tokens
            await db.configIA.update({
              where: { id: configIAId },
              data: {
                rdstationAccessToken: access_token,
                rdstationRefreshToken: refresh_token || null,
              },
            });

            logInfo("RD Station automatic token exchange successful", { configIAId });

            // Atualizar o objeto local para continuar com a busca de pipelines
            configIA = { ...configIA, rdstationAccessToken: access_token };
          }
        } catch (tokenError: any) {
          logError("Automatic token exchange failed", {
            error: tokenError.message,
            response: tokenError.response?.data,
          });
          // Se falhou o token exchange, continuar e retornar erro de não conectado
        }
      }

      if (!configIA.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado. Autorize novamente através das configurações do agente.",
          needsAuthorization: true,
        });
      }

      // RD Station CRM v2 API - endpoint correto é /pipelines
      // Documentação: https://developers.rdstation.com/reference/crm-v2-list-pipelines
      const response = await axios.get(`${RDSTATION_CRM_API_URL}/pipelines`, {
        headers: {
          Authorization: `Bearer ${configIA.rdstationAccessToken}`,
        },
        params: {
          "page[number]": 1,
          "page[size]": 100, // Buscar até 100 pipelines
        },
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM pipelines", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado. Reconecte com o RD Station.",
          needsReauthorization: true,
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar funis do RD Station CRM",
      });
    }
  });

  /**
   * Listar usuários do RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
  }>("/rdstation/users/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationAccessToken: true,
        },
      });

      if (!configIA?.rdstationAccessToken) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "RD Station CRM não conectado",
        });
      }

      const response = await axios.get(`${RDSTATION_CRM_API_URL}/users`, {
        headers: {
          Authorization: `Bearer ${configIA.rdstationAccessToken}`,
        },
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM users", {
        error: error.message,
        response: error.response?.data,
      });

      if (error.response?.status === 401) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar usuários do RD Station CRM",
      });
    }
  });
}
