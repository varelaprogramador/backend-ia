import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/utils/logger";
import { ENV } from "@/config/env";

// RD Station OAuth Configuration
const RDSTATION_TOKEN_URL = "https://api.rd.services/auth/token";
const RDSTATION_USERINFO_URL = "https://api.rd.services/marketing/account_info";

// URLs de redirecionamento
const getFrontendUrl = () => {
  return ENV.NODE_ENV === "production"
    ? process.env.FRONTEND_URL || "https://app.seudominio.com"
    : "http://localhost:3000";
};

export default async function (fastify: FastifyInstance) {
  /**
   * RD Station OAuth Callback
   * Recebe o código de autorização e troca por access_token
   *
   * URL de callback para configurar no RD Station:
   * - Produção: https://api.seudominio.com/oauth/rdstation/callback
   * - Desenvolvimento: http://localhost:3333/oauth/rdstation/callback
   */
  fastify.get<{
    Querystring: {
      code?: string;
      state?: string; // configIAId codificado
      error?: string;
      error_description?: string;
    };
  }>("/rdstation/callback", async (req, reply) => {
    const { code, state, error, error_description } = req.query;
    const frontendUrl = getFrontendUrl();

    logInfo("RD Station OAuth callback received", {
      hasCode: !!code,
      hasState: !!state,
      error,
    });

    // Se houve erro no OAuth
    if (error) {
      logError("RD Station OAuth error", {
        error,
        error_description,
      });
      return reply.redirect(
        `${frontendUrl}/agents?error=rdstation_oauth_error&message=${encodeURIComponent(
          error_description || error
        )}`
      );
    }

    // Validar parâmetros obrigatórios
    if (!code) {
      return reply.redirect(
        `${frontendUrl}/agents?error=rdstation_missing_code&message=${encodeURIComponent(
          "Código de autorização não recebido"
        )}`
      );
    }

    if (!state) {
      return reply.redirect(
        `${frontendUrl}/agents?error=rdstation_missing_state&message=${encodeURIComponent(
          "Estado de configuração não recebido"
        )}`
      );
    }

    try {
      // Decodificar state para obter configIAId
      const configIAId = Buffer.from(state, "base64").toString("utf-8");

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
        logError("ConfigIA not found for RD Station OAuth", { configIAId });
        return reply.redirect(
          `${frontendUrl}/agents?error=rdstation_config_not_found&message=${encodeURIComponent(
            "Configuração de agente não encontrada"
          )}`
        );
      }

      if (!configIA.rdstationClientId || !configIA.rdstationClientSecret) {
        logError("RD Station credentials not configured", { configIAId });
        return reply.redirect(
          `${frontendUrl}/agents/${configIAId}?error=rdstation_credentials_missing&message=${encodeURIComponent(
            "Client ID ou Client Secret não configurados"
          )}`
        );
      }

      // Trocar código por access_token
      logInfo("Exchanging code for access_token", { configIAId });

      const tokenResponse = await axios.post(
        RDSTATION_TOKEN_URL,
        {
          client_id: configIA.rdstationClientId,
          client_secret: configIA.rdstationClientSecret,
          code: code,
        },
        {
          headers: {
            "Content-Type": "application/json",
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

      // Redirecionar para o frontend com sucesso
      return reply.redirect(
        `${frontendUrl}/agents/${configIAId}?success=rdstation_connected&message=${encodeURIComponent(
          "RD Station conectado com sucesso!"
        )}`
      );
    } catch (error: any) {
      logError("Error in RD Station OAuth callback", {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      const errorMessage =
        error.response?.data?.error_description ||
        error.response?.data?.error ||
        error.message ||
        "Erro ao conectar com RD Station";

      return reply.redirect(
        `${frontendUrl}/agents?error=rdstation_token_error&message=${encodeURIComponent(
          errorMessage
        )}`
      );
    }
  });

  /**
   * Iniciar fluxo OAuth do RD Station
   * Gera a URL de autorização e redireciona o usuário
   */
  fastify.get<{
    Querystring: {
      configIAId: string;
    };
  }>("/rdstation/authorize", async (req, reply) => {
    const { configIAId } = req.query;

    if (!configIAId) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "configIAId é obrigatório",
      });
    }

    try {
      // Buscar ConfigIA para obter Client ID
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          id: true,
          rdstationClientId: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração de agente não encontrada",
        });
      }

      if (!configIA.rdstationClientId) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          success: false,
          error: "Client ID do RD Station não configurado",
        });
      }

      // Gerar state codificado em base64
      const state = Buffer.from(configIAId).toString("base64");

      // Construir URL de callback
      const backendUrl =
        ENV.NODE_ENV === "production"
          ? process.env.BACKEND_URL || "https://api.seudominio.com"
          : `http://localhost:${ENV.PORT || 3333}`;

      const redirectUri = `${backendUrl}/oauth/rdstation/callback`;

      // Construir URL de autorização do RD Station
      const authUrl = new URL("https://api.rd.services/auth/dialog");
      authUrl.searchParams.set("client_id", configIA.rdstationClientId);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("state", state);

      logInfo("Redirecting to RD Station OAuth", {
        configIAId,
        redirectUri,
        authUrl: authUrl.toString(),
      });

      return reply.redirect(authUrl.toString());
    } catch (error: any) {
      logError("Error initiating RD Station OAuth", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao iniciar autenticação com RD Station",
      });
    }
  });

  /**
   * Verificar status da conexão com RD Station
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

      // Se conectado, verificar se o token ainda é válido
      let isTokenValid = false;
      if (isConnected) {
        try {
          await axios.get(RDSTATION_USERINFO_URL, {
            headers: {
              Authorization: `Bearer ${configIA.rdstationAccessToken}`,
            },
            timeout: 10000,
          });
          isTokenValid = true;
        } catch (error: any) {
          // Token expirado ou inválido
          isTokenValid = false;
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

      // Renovar token
      const tokenResponse = await axios.post(
        RDSTATION_TOKEN_URL,
        {
          client_id: configIA.rdstationClientId,
          client_secret: configIA.rdstationClientSecret,
          refresh_token: configIA.rdstationRefreshToken,
        },
        {
          headers: {
            "Content-Type": "application/json",
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
}
