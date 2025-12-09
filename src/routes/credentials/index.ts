import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import axios from "axios";

import { db } from "@/lib/db";
import { sendSuccess, sendError } from "@/utils/response-formatter";
import { ENV } from "@/config/env";

type CredentialType = "GOOGLE_CALENDAR" | "CHATGPT" | "N8N" | "CUSTOM";

interface CreateCredentialBody {
  name: string;
  type: CredentialType;
  url: string;
  method?: string;
  authHeaderKey?: string;
  authHeaderValue?: string;
  customHeaders?: Record<string, string>;
  awaitResponse?: boolean;
  successModel?: Record<string, any>;
  data?: Record<string, any>;
}

interface UpdateCredentialBody extends Partial<CreateCredentialBody> {
  isActive?: boolean;
}

/**
 * Resolve a URL da credencial baseado no tipo
 * Se a URL estiver vazia e for um tipo pré-configurado, usa a URL padrão do ambiente
 */
function resolveCredentialUrl(
  type: CredentialType,
  url: string | null | undefined
): string {
  // Se a URL foi fornecida, usa ela
  if (url && url.trim()) {
    return url;
  }

  // Se não foi fornecida, usa a URL padrão baseada no tipo
  switch (type) {
    case "CHATGPT":
      return ENV.DEFAULT_CHATGPT_URL || "https://api.openai.com/v1";

    case "GOOGLE_CALENDAR":
      return (
        ENV.DEFAULT_GOOGLE_CALENDAR_URL ||
        "https://www.googleapis.com/calendar/v3"
      );

    case "N8N":
      return ENV.DEFAULT_N8N_URL || "https://localhost:5678";

    case "CUSTOM":
      return "";

    default:
      return "";
  }
}

/**
 * Resolve a API Key da credencial baseado no tipo
 * Se o authHeaderValue estiver vazio e for N8N, usa a API Key padrão do ambiente
 */
function resolveAuthHeaderValue(
  type: CredentialType,
  authHeaderValue: string | null | undefined
): string | undefined {
  // Se foi fornecido, usa
  if (authHeaderValue && authHeaderValue.trim()) {
    return authHeaderValue;
  }

  // Se não foi fornecido e é N8N, usa o padrão
  if (type === "N8N") {
    return ENV.DEFAULT_N8N_API_KEY || undefined;
  }

  return undefined;
}

/**
 * Envia dados para o webhook N8N
 * Retorna { success: boolean, data?: any }
 */
async function sendToN8NWebhook(data: any, logger: any): Promise<{ success: boolean; data?: any }> {
  const webhookUrl = ENV.WEBHOOK_N8N_CREDENTIALS_URL;
  const n8nApiKey = ENV.DEFAULT_N8N_API_KEY;

  if (!webhookUrl) {
    logger?.warn(
      "WEBHOOK_N8N_CREDENTIALS_URL não configurado, pulando envio ao N8N"
    );
    return { success: true };
  }

  try {
    const response = await axios.post(webhookUrl, data, {
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": n8nApiKey || "", // Adicionar API Key do N8N
      },
      timeout: 10000, // 10 segundos
    });

    logger?.info(
      {
        status: response.status,
        data: response.data,
      },
      "Dados enviados ao N8N com sucesso"
    );

    return { success: true, data: response.data };
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      },
      "Erro ao enviar dados ao N8N"
    );

    return { success: false };
  }
}

/**
 * Criar credencial no N8N via API e retornar o ID
 * Retorna o ID do N8N ou null em caso de erro
 */
async function createCredentialInN8N(
  credentialData: {
    name: string;
    type: string;
    data?: any;
  },
  logger: any
): Promise<string | null> {
  const n8nApiUrl = ENV.N8N_API_CREDENTIALS_URL;
  const n8nApiKey = ENV.DEFAULT_N8N_API_KEY;

  if (!n8nApiUrl || !n8nApiKey) {
    logger?.warn("N8N API não configurado, pulando criação de credencial no N8N");
    return null;
  }

  try {
    // Mapear tipo da nossa API para tipo do N8N
    const n8nType = mapCredentialTypeToN8N(credentialData.type);

    const payload = {
      name: credentialData.name,
      type: n8nType,
      nodesAccess: [], // Sem restrição de nós
      data: credentialData.data || {},
    };

    logger?.info({ payload }, "Criando credencial no N8N");

    const response = await axios.post(n8nApiUrl, payload, {
      headers: {
        "Content-Type": "application/json",
        "X-N8N-API-KEY": n8nApiKey,
      },
      timeout: 15000, // 15 segundos
    });

    // Resposta esperada: Array com 1 objeto [{ id, name, type, createdAt, ... }]
    const responseData = response.data;

    // N8N retorna um array, pegar o primeiro item
    const n8nCredential = Array.isArray(responseData) ? responseData[0] : responseData;

    if (!n8nCredential || !n8nCredential.id) {
      logger?.error(
        { responseData },
        "Resposta do N8N não contém ID da credencial"
      );
      return null;
    }

    logger?.info(
      {
        id_n8n: n8nCredential.id,
        name: n8nCredential.name,
        type: n8nCredential.type,
      },
      "Credencial criada no N8N com sucesso"
    );

    return n8nCredential.id;
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      },
      "Erro ao criar credencial no N8N"
    );

    return null;
  }
}

/**
 * Mapear nosso tipo de credencial para o tipo do N8N
 */
function mapCredentialTypeToN8N(type: string): string {
  const typeMap: Record<string, string> = {
    GOOGLE_CALENDAR: "googleCalendarOAuth2Api",
    CHATGPT: "openAiApi",
    N8N: "n8nApi",
    CUSTOM: "httpHeaderAuth", // Tipo genérico para custom
  };

  return typeMap[type] || "httpHeaderAuth";
}

/**
 * Validar credencial antes de criar
 * Testa se a API Key do ChatGPT é válida, por exemplo
 */
async function validateCredentialBeforeCreate(
  type: string,
  data: any,
  logger: any
): Promise<{ valid: boolean; error?: string }> {
  try {
    if (type === "CHATGPT") {
      // Validar API Key do OpenAI
      const apiKey = data?.data?.apiKey || data?.apiKey;

      if (!apiKey) {
        return { valid: false, error: "API Key é obrigatória para ChatGPT" };
      }

      // Testar a API Key fazendo uma chamada simples para listar modelos
      const response = await axios.get("https://api.openai.com/v1/models", {
        headers: {
          "Authorization": `Bearer ${apiKey}`,
        },
        timeout: 10000,
      });

      if (response.status === 200) {
        logger?.info("API Key do OpenAI validada com sucesso");
        return { valid: true };
      }

      return { valid: false, error: "API Key do OpenAI inválida" };
    }

    if (type === "GOOGLE_CALENDAR") {
      // Para Google Calendar, validar se Client ID e Secret foram fornecidos
      const clientId = data?.clientId;
      const clientSecret = data?.clientSecret;

      if (!clientId) {
        return { valid: false, error: "Client ID é obrigatório para Google Calendar" };
      }

      if (!clientSecret) {
        return { valid: false, error: "Client Secret é obrigatório para Google Calendar" };
      }

      // Não é possível validar OAuth2 sem o fluxo completo
      // Apenas verificamos se os campos foram preenchidos
      logger?.info("Credenciais do Google Calendar validadas (formato)");
      return { valid: true };
    }

    // Para outros tipos, não há validação específica
    return { valid: true };
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      },
      "Erro ao validar credencial"
    );

    // Tratar erros específicos da OpenAI
    if (error.response?.status === 401) {
      return { valid: false, error: "API Key do OpenAI inválida ou expirada" };
    }

    if (error.response?.status === 429) {
      return { valid: false, error: "Limite de requisições da OpenAI excedido. Tente novamente mais tarde." };
    }

    if (error.code === "ECONNABORTED" || error.code === "ETIMEDOUT") {
      return { valid: false, error: "Timeout ao validar credencial. Verifique sua conexão." };
    }

    return { valid: false, error: error.response?.data?.error?.message || "Erro ao validar credencial" };
  }
}

export default async function (fastify: FastifyInstance) {
  // GET /credentials - List all credentials for the user
  fastify.get("/", async (req, reply) => {
    try {
      const { userId } = req.query as { userId?: string };

      if (!userId) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "userId é obrigatório",
        });
      }

      const credentials = await db.credential.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
      });

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        data: credentials,
      });
    } catch (error) {
      req.log.error(error, "Error fetching credentials");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao buscar credenciais",
      });
    }
  });

  // GET /credentials/:id - Get specific credential
  fastify.get("/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId } = req.query as { userId?: string };

      const credential = await db.credential.findFirst({
        where: userId ? { id, userId } : { id },
      });

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        data: credential,
      });
    } catch (error) {
      req.log.error(error, "Error fetching credential");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao buscar credencial",
      });
    }
  });

  // POST /credentials - Create new credential
  fastify.post("/", async (req, reply) => {
    try {
      const {
        userId,
        name,
        type,
        url,
        method = "POST",
        authHeaderKey,
        authHeaderValue,
        customHeaders,
        awaitResponse = false,
        successModel,
        data,
      } = req.body as CreateCredentialBody & { userId: string };

      // Validações básicas
      if (!userId) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "userId é obrigatório",
        });
      }

      if (!name || !type) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "Nome e tipo são obrigatórios",
        });
      }

      // Se o tipo for CUSTOM e URL estiver vazia, é inválido
      if (type === "CUSTOM" && !url) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "URL é obrigatória para credenciais personalizadas",
        });
      }

      // 0. VALIDAR CREDENCIAL ANTES DE CRIAR
      req.log.info({ type, name }, "Validando credencial antes de criar...");
      const validation = await validateCredentialBeforeCreate(type, data, req.log);

      if (!validation.valid) {
        req.log.warn({ type, name, error: validation.error }, "Credencial inválida");
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: validation.error || "Credencial inválida",
        });
      }

      req.log.info({ type, name }, "Credencial validada com sucesso");

      // Resolver URL e API Key baseado no tipo
      const finalUrl = resolveCredentialUrl(type, url);
      const finalAuthHeaderValue = resolveAuthHeaderValue(
        type,
        authHeaderValue
      );
      const finalAuthHeaderKey =
        authHeaderKey || (type === "N8N" ? "X-N8N-API-KEY" : undefined);

      // 1. Criar credencial no N8N primeiro (se API configurada)
      let id_n8n = await createCredentialInN8N(
        {
          name,
          type,
          data: data || {},
        },
        req.log
      );

      // 2. Criar credencial no banco de dados com o ID do N8N (se obtido)
      let credential = await db.credential.create({
        data: {
          userId,
          name,
          type,
          url: url || "", // Salva vazio se não fornecido
          method,
          authHeaderKey: finalAuthHeaderKey,
          authHeaderValue: finalAuthHeaderValue,
          customHeaders: customHeaders || undefined,
          awaitResponse,
          successModel: successModel || undefined,
          data: data || undefined,
          id_n8n: id_n8n, // Salvar ID retornado pelo N8N
        },
      });

      req.log.info(
        {
          id: credential.id,
          id_n8n: credential.id_n8n,
          name: credential.name,
        },
        "Credencial criada com sucesso"
      );

      // 3. Enviar dados ao webhook N8N (síncrono se awaitResponse for true)
      if (awaitResponse) {
        // Aguardar resposta do webhook para obter id_n8n
        const webhookResult = await sendToN8NWebhook(
          {
            action: "create",
            credential: {
              id: credential.id,
              id_n8n: credential.id_n8n,
              userId: credential.userId,
              name: credential.name,
              type: credential.type,
              url: finalUrl,
              method: credential.method,
              authHeaderKey: finalAuthHeaderKey,
              isActive: credential.isActive,
              createdAt: credential.createdAt,
              data: credential.data,
            },
          },
          req.log
        );

        // Se recebeu resposta com ID do N8N e ainda não temos, atualizar
        if (webhookResult.success && webhookResult.data && !credential.id_n8n) {
          const responseData = webhookResult.data;
          const n8nCredential = Array.isArray(responseData) ? responseData[0] : responseData;

          if (n8nCredential?.id) {
            credential = await db.credential.update({
              where: { id: credential.id },
              data: { id_n8n: n8nCredential.id },
            });

            req.log.info(
              {
                id: credential.id,
                id_n8n: n8nCredential.id,
              },
              "ID do N8N atualizado via webhook"
            );
          }
        }
      } else {
        // Envio assíncrono (não bloqueia resposta)
        sendToN8NWebhook(
          {
            action: "create",
            credential: {
              id: credential.id,
              id_n8n: credential.id_n8n,
              userId: credential.userId,
              name: credential.name,
              type: credential.type,
              url: finalUrl,
              method: credential.method,
              authHeaderKey: finalAuthHeaderKey,
              isActive: credential.isActive,
              createdAt: credential.createdAt,
              data: credential.data,
            },
          },
          req.log
        ).then((result) => {
          // Se recebeu ID do N8N na resposta, atualizar credencial
          if (result.success && result.data) {
            const responseData = result.data;
            const n8nCredential = Array.isArray(responseData) ? responseData[0] : responseData;

            if (n8nCredential?.id && !credential.id_n8n) {
              db.credential.update({
                where: { id: credential.id },
                data: { id_n8n: n8nCredential.id },
              }).then(() => {
                req.log.info({ id: credential.id, id_n8n: n8nCredential.id }, "ID do N8N atualizado via webhook (assíncrono)");
              }).catch((err) => {
                req.log.error(err, "Erro ao atualizar id_n8n");
              });
            }
          }
        }).catch((error) => {
          req.log.error(error, "Erro ao enviar credencial ao webhook N8N (não crítico)");
        });
      }

      return sendSuccess(reply, {
        status: StatusCodes.CREATED,
        message: "Credencial criada com sucesso",
        data: credential,
      });
    } catch (error) {
      req.log.error(error, "Error creating credential");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao criar credencial",
      });
    }
  });

  // PUT /credentials/:id - Update credential
  fastify.put("/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId, ...body } = req.body as UpdateCredentialBody & { userId?: string };

      // Check if credential exists (optionally filter by userId)
      const existing = await db.credential.findFirst({
        where: userId ? { id, userId } : { id },
      });

      if (!existing) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      // Resolver URL e API Key se foram atualizados
      const finalUrl =
        body.url !== undefined
          ? resolveCredentialUrl(body.type || existing.type, body.url)
          : undefined;

      const finalAuthHeaderValue =
        body.authHeaderValue !== undefined
          ? resolveAuthHeaderValue(
              body.type || existing.type,
              body.authHeaderValue
            )
          : undefined;

      const credential = await db.credential.update({
        where: { id },
        data: {
          ...body,
          authHeaderValue:
            finalAuthHeaderValue !== undefined
              ? finalAuthHeaderValue
              : body.authHeaderValue,
          customHeaders: body.customHeaders || undefined,
          successModel: body.successModel || undefined,
          data: body.data || undefined,
        },
      });

      // Enviar dados atualizados ao N8N (assíncrono, não bloqueia resposta)
      const resolvedUrl = resolveCredentialUrl(credential.type, credential.url);

      sendToN8NWebhook(
        {
          action: "update",
          credential: {
            id: credential.id,
            userId: credential.userId,
            name: credential.name,
            type: credential.type,
            url: resolvedUrl, // URL resolvida
            method: credential.method,
            isActive: credential.isActive,
            updatedAt: credential.updatedAt,
            data: credential.data,
          },
        },
        req.log
      ).then((result) => {
        if (!result.success) {
          req.log.error("Falha ao enviar atualização de credencial ao N8N (não crítico)");
        }
      }).catch((error) => {
        req.log.error(
          error,
          "Erro ao enviar atualização de credencial ao N8N (não crítico)"
        );
      });

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: "Credencial atualizada com sucesso",
        data: credential,
      });
    } catch (error) {
      req.log.error(error, "Error updating credential");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao atualizar credencial",
      });
    }
  });

  // DELETE /credentials/:id - Delete credential
  fastify.delete("/:id", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId } = req.query as { userId?: string };

      // Check if credential exists (optionally filter by userId)
      const existing = await db.credential.findFirst({
        where: userId ? { id, userId } : { id },
      });

      if (!existing) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      await db.credential.delete({
        where: { id },
      });

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: "Credencial deletada com sucesso",
      });
    } catch (error) {
      req.log.error(error, "Error deleting credential");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao deletar credencial",
      });
    }
  });

  // POST /credentials/:id/resend - Resend credential to N8N webhook
  fastify.post("/:id/resend", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId } = req.body as { userId?: string };

      // Fetch the credential
      const credential = await db.credential.findFirst({
        where: userId ? { id, userId } : { id },
      });

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      // Resolver URL para envio
      const resolvedUrl = resolveCredentialUrl(credential.type, credential.url);
      const resolvedAuthHeaderValue = resolveAuthHeaderValue(
        credential.type,
        credential.authHeaderValue
      );
      const resolvedAuthHeaderKey =
        credential.authHeaderKey || (credential.type === "N8N" ? "X-N8N-API-KEY" : undefined);

      // Enviar dados ao N8N e aguardar resposta
      const result = await sendToN8NWebhook(
        {
          action: "resend",
          credential: {
            id: credential.id,
            id_n8n: credential.id_n8n, // Incluir ID do N8N
            userId: credential.userId,
            name: credential.name,
            type: credential.type,
            url: resolvedUrl,
            method: credential.method,
            authHeaderKey: resolvedAuthHeaderKey,
            authHeaderValue: resolvedAuthHeaderValue,
            isActive: credential.isActive,
            createdAt: credential.createdAt,
            updatedAt: credential.updatedAt,
            data: credential.data,
          },
        },
        req.log
      );

      if (!result.success) {
        return sendError(reply, {
          status: StatusCodes.BAD_GATEWAY,
          error: "Falha ao enviar credencial para o N8N. Verifique os logs do servidor.",
        });
      }

      // Processar resposta do N8N e atualizar id_n8n
      let updatedCredential = credential;
      if (result.data && Array.isArray(result.data) && result.data.length > 0) {
        const n8nResponse = result.data[0];
        const newIdN8n = n8nResponse.id;

        if (newIdN8n && newIdN8n !== credential.id_n8n) {
          // Atualizar credencial no banco com o novo id_n8n
          updatedCredential = await db.credential.update({
            where: { id },
            data: { id_n8n: newIdN8n },
          });

          req.log.info(
            {
              id: credential.id,
              old_id_n8n: credential.id_n8n,
              new_id_n8n: newIdN8n,
            },
            "ID do N8N atualizado após reenvio"
          );
        }
      }

      return sendSuccess(reply, {
        status: StatusCodes.OK,
        message: "Credencial reenviada com sucesso para o N8N",
        data: {
          success: true,
          credential: updatedCredential,
          n8nResponse: result.data,
        },
      });
    } catch (error) {
      req.log.error(error, "Error resending credential to N8N");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao reenviar credencial",
      });
    }
  });

  // POST /credentials/:id/test - Test credential
  fastify.post("/:id/test", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const { userId } = req.body as { userId?: string };

      // Fetch the credential
      const credential = await db.credential.findFirst({
        where: userId ? { id, userId } : { id },
      });

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      // Resolver URL para teste
      const testUrl = resolveCredentialUrl(credential.type, credential.url);

      if (!testUrl) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "URL não configurada para esta credencial",
        });
      }

      // Prepare headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add authentication header if configured
      const authHeaderValue = resolveAuthHeaderValue(
        credential.type,
        credential.authHeaderValue
      );

      if (credential.authHeaderKey && authHeaderValue) {
        headers[credential.authHeaderKey] = authHeaderValue;
      }

      // Add custom headers
      if (credential.customHeaders) {
        Object.assign(
          headers,
          credential.customHeaders as Record<string, string>
        );
      }

      // Make the request
      try {
        const response = await axios({
          method: credential.method.toLowerCase() as any,
          url: testUrl,
          headers,
          data: credential.data,
          timeout: 30000, // 30 seconds
        });

        return sendSuccess(reply, {
          status: StatusCodes.OK,
          data: {
            success: true,
            status: response.status,
            statusText: response.statusText,
            data: response.data,
            headers: response.headers,
          },
        });
      } catch (axiosError: any) {
        return sendSuccess(reply, {
          status: StatusCodes.OK,
          data: {
            success: false,
            status: axiosError.response?.status || 500,
            statusText: axiosError.response?.statusText || "Request Failed",
            data: axiosError.response?.data || { error: axiosError.message },
            error: axiosError.message,
          },
        });
      }
    } catch (error) {
      req.log.error(error, "Error testing credential");
      return sendError(reply, {
        status: StatusCodes.INTERNAL_SERVER_ERROR,
        error: "Erro ao testar credencial",
      });
    }
  });
}
