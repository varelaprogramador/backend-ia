import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import axios from "axios";

import { db } from "@/lib/db";
import { sendSuccess, sendError } from "@/utils/response-formatter";
import { authMiddleware } from "@/middlewares/auth";

interface CreateCredentialBody {
  name: string;
  type: "GOOGLE_CALENDAR" | "CHATGPT" | "N8N" | "CUSTOM";
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

export default async function (fastify: FastifyInstance) {
  // Apply authentication middleware to all routes
  fastify.addHook("preHandler", authMiddleware());

  // GET /credentials - List all credentials for the user
  fastify.get("/", async (req, reply) => {
    try {
      const userId = req.user!.id;

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
      const userId = req.user!.id;

      const credential = await db.credential.findFirst({
        where: { id, userId },
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
      const userId = req.user!.id;
      const {
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
      } = req.body as CreateCredentialBody;

      // Basic validation
      if (!name || !type || !url) {
        return sendError(reply, {
          status: StatusCodes.BAD_REQUEST,
          error: "Nome, tipo e URL são obrigatórios",
        });
      }

      const credential = await db.credential.create({
        data: {
          userId,
          name,
          type,
          url,
          method,
          authHeaderKey,
          authHeaderValue,
          customHeaders: customHeaders || {},
          awaitResponse,
          successModel: successModel || {},
          data: data || {},
        },
      });

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
      const userId = req.user!.id;

      // Check if credential belongs to user
      const existing = await db.credential.findFirst({
        where: { id, userId },
      });

      if (!existing) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      const credential = await db.credential.update({
        where: { id },
        data: {
          ...(req.body as UpdateCredentialBody),
          customHeaders: (req.body as UpdateCredentialBody).customHeaders || {},
          successModel: (req.body as UpdateCredentialBody).successModel || {},
          data: (req.body as UpdateCredentialBody).data || {},
        },
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
      const userId = req.user!.id;

      // Check if credential belongs to user
      const existing = await db.credential.findFirst({
        where: { id, userId },
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

  // POST /credentials/:id/test - Test credential
  fastify.post("/:id/test", async (req, reply) => {
    try {
      const { id } = req.params as { id: string };
      const userId = req.user!.id;

      // Fetch the credential
      const credential = await db.credential.findFirst({
        where: { id, userId },
      });

      if (!credential) {
        return sendError(reply, {
          status: StatusCodes.NOT_FOUND,
          error: "Credencial não encontrada",
        });
      }

      // Prepare headers
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };

      // Add authentication header if configured
      if (credential.authHeaderKey && credential.authHeaderValue) {
        headers[credential.authHeaderKey] = credential.authHeaderValue;
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
          url: credential.url,
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
            data: axiosError.response?.data || { message: axiosError.message },
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
