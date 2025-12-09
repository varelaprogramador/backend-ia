import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo } from "@/utils/logger";
// RD Station CRM API Configuration (plugcrm.net)
// Documentação: https://ajuda.rdstation.com/s/article/Integrar-o-RD-Station-CRM-com-outras-plataformas-via-API
const RDSTATION_CRM_BASE_URL = "https://plugcrm.net/api/v1";
const RDSTATION_CRM_TOKEN_CHECK_URL = `${RDSTATION_CRM_BASE_URL}/token/check`;

export default async function (fastify: FastifyInstance) {
  /**
   * Validar e salvar token do RD Station CRM
   * O RD Station CRM usa autenticação por Token (não OAuth)
   * O token é obtido diretamente no painel do RD Station CRM
   */
  fastify.post<{
    Body: {
      configIAId: string;
      token: string;
    };
  }>("/rdstation-crm/connect", async (req, reply) => {
    const { configIAId, token } = req.body;

    if (!configIAId) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "configIAId é obrigatório",
      });
    }

    if (!token) {
      return reply.code(StatusCodes.BAD_REQUEST).send({
        success: false,
        error: "Token é obrigatório",
      });
    }

    try {
      // Verificar se o token é válido
      logInfo("Validating RD Station CRM token", { configIAId });

      const tokenCheckResponse = await axios.get(RDSTATION_CRM_TOKEN_CHECK_URL, {
        params: { token },
        timeout: 15000,
      });

      // Se chegou aqui, o token é válido
      logInfo("RD Station CRM token validated successfully", {
        configIAId,
        response: tokenCheckResponse.data,
      });

      // Salvar o token no ConfigIA
      await db.configIA.update({
        where: { id: configIAId },
        data: {
          rdstationAccessToken: token,
          // Limpar campos de OAuth que não são usados no CRM
          rdstationRefreshToken: null,
          rdstationCode: null,
        },
      });

      logInfo("RD Station CRM token saved to ConfigIA", { configIAId });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "RD Station CRM conectado com sucesso!",
        data: {
          isConnected: true,
          tokenInfo: tokenCheckResponse.data,
        },
      });
    } catch (error: any) {
      logError("Error validating RD Station CRM token", {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      });

      // Verificar se é erro de token inválido
      if (error.response?.status === 401 || error.response?.status === 403) {
        return reply.code(StatusCodes.UNAUTHORIZED).send({
          success: false,
          error: "Token inválido. Verifique o token no painel do RD Station CRM.",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao validar token do RD Station CRM",
        details: error.response?.data || error.message,
      });
    }
  });

  /**
   * Verificar status da conexão com RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
  }>("/rdstation-crm/status/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;

    try {
      const configIA = await db.configIA.findUnique({
        where: { id: configIAId },
        select: {
          rdstationClientId: true,
          rdstationClientSecret: true,
          rdstationAccessToken: true,
        },
      });

      if (!configIA) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          success: false,
          error: "Configuração não encontrada",
        });
      }

      const hasToken = !!configIA.rdstationAccessToken;

      // Se tem token, verificar se ainda é válido
      let isTokenValid = false;
      let tokenInfo = null;

      if (hasToken) {
        try {
          const checkResponse = await axios.get(RDSTATION_CRM_TOKEN_CHECK_URL, {
            params: { token: configIA.rdstationAccessToken },
            timeout: 10000,
          });
          isTokenValid = true;
          tokenInfo = checkResponse.data;
        } catch (error: any) {
          // Token expirado ou inválido
          isTokenValid = false;
          logInfo("RD Station CRM token is invalid or expired", { configIAId });
        }
      }

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          isConnected: hasToken && isTokenValid,
          hasToken,
          isTokenValid,
          tokenInfo,
        },
      });
    } catch (error: any) {
      logError("Error checking RD Station CRM status", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao verificar status do RD Station CRM",
      });
    }
  });

  /**
   * Desconectar RD Station CRM (limpar token)
   */
  fastify.delete<{
    Params: { configIAId: string };
  }>("/rdstation-crm/disconnect/:configIAId", async (req, reply) => {
    const { configIAId } = req.params;

    try {
      await db.configIA.update({
        where: { id: configIAId },
        data: {
          rdstationAccessToken: null,
          rdstationRefreshToken: null,
          rdstationCode: null,
          rdstationClientId: null,
          rdstationClientSecret: null,
        },
      });

      logInfo("RD Station CRM disconnected", { configIAId });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "RD Station CRM desconectado com sucesso",
      });
    } catch (error: any) {
      logError("Error disconnecting RD Station CRM", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao desconectar RD Station CRM",
      });
    }
  });

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
  }>("/rdstation-crm/deals/:configIAId", async (req, reply) => {
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

      const params: any = {
        token: configIA.rdstationAccessToken,
        page,
        limit,
      };

      if (deal_stage_id) {
        params.deal_stage_id = deal_stage_id;
      }

      const response = await axios.get(`${RDSTATION_CRM_BASE_URL}/deals`, {
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
          error: "Token inválido ou expirado",
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
  }>("/rdstation-crm/deals/:configIAId", async (req, reply) => {
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
        `${RDSTATION_CRM_BASE_URL}/deals`,
        {
          ...dealData,
          token: configIA.rdstationAccessToken,
        },
        {
          headers: {
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
  }>("/rdstation-crm/contacts/:configIAId", async (req, reply) => {
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

      const params: any = {
        token: configIA.rdstationAccessToken,
        page,
        limit,
      };

      if (q) {
        params.q = q;
      }

      const response = await axios.get(`${RDSTATION_CRM_BASE_URL}/contacts`, {
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
  }>("/rdstation-crm/contacts/:configIAId", async (req, reply) => {
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
        `${RDSTATION_CRM_BASE_URL}/contacts`,
        {
          ...contactData,
          token: configIA.rdstationAccessToken,
        },
        {
          headers: {
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
   * Listar etapas do funil (deal stages) do RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
  }>("/rdstation-crm/deal-stages/:configIAId", async (req, reply) => {
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

      const response = await axios.get(`${RDSTATION_CRM_BASE_URL}/deal_stages`, {
        params: {
          token: configIA.rdstationAccessToken,
        },
        timeout: 15000,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: response.data,
      });
    } catch (error: any) {
      logError("Error fetching RD Station CRM deal stages", {
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
        error: "Erro ao buscar etapas do funil do RD Station CRM",
      });
    }
  });

  /**
   * Listar pipelines/funis do RD Station CRM
   */
  fastify.get<{
    Params: { configIAId: string };
  }>("/rdstation-crm/pipelines/:configIAId", async (req, reply) => {
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

      const response = await axios.get(`${RDSTATION_CRM_BASE_URL}/deal_pipelines`, {
        params: {
          token: configIA.rdstationAccessToken,
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
          error: "Token inválido ou expirado",
        });
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao buscar funis do RD Station CRM",
      });
    }
  });
}
