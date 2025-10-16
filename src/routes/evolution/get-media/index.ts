import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import { logError, logInfo } from "@/utils/logger";
import { db } from "@/lib/db";
import axios from "axios";

export default async function (app: FastifyInstance) {
  // Get base64 from media message via Evolution API
  app.post<{
    Body: {
      instanceName: string;
      messageKey: {
        id: string;
        remoteJid?: string;
        fromMe?: boolean;
      };
      convertToMp4?: boolean;
    };
  }>("/", async (req, reply) => {
    try {
      const { instanceName, messageKey, convertToMp4 } = req.body;

      if (!instanceName || !messageKey?.id) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          status: "error",
          message: "instanceName and messageKey.id are required",
        });
      }

      logInfo("Getting base64 from media message via Evolution API", {
        instanceName,
        messageId: messageKey.id,
        convertToMp4,
      });

      // Get instance configuration from database
      const evolutionInstance = await db.evolutionInstance.findFirst({
        where: {
          instanceName: instanceName,
        },
      });

      if (!evolutionInstance) {
        return reply.code(StatusCodes.NOT_FOUND).send({
          status: "error",
          message: "Evolution instance not found",
        });
      }

      // Get media base64 via Evolution API
      const evolutionUrl = `${evolutionInstance.serverUrl}/chat/getBase64FromMediaMessage/${instanceName}`;

      logInfo("Calling Evolution API to get media base64", {
        url: evolutionUrl,
        messageId: messageKey.id,
      });

      const response = await axios.post(
        evolutionUrl,
        {
          message: {
            key: messageKey,
          },
          convertToMp4: convertToMp4 || false,
        },
        {
          headers: {
            "Content-Type": "application/json",
            apikey: evolutionInstance.apiKey,
          },
          timeout: 30000,
        }
      );

      logInfo("Media base64 retrieved successfully from Evolution API", {
        instanceName,
        messageId: messageKey.id,
        hasBase64: !!response.data?.base64,
        base64Length: response.data?.base64?.length || 0,
        base64Preview: response.data?.base64?.substring(0, 100),
        responseKeys: Object.keys(response.data || {}),
        mimetype: response.data?.mimetype || 'unknown',
      });

      return reply.code(StatusCodes.OK).send({
        status: "success",
        message: "Media retrieved successfully",
        data: response.data,
      });
    } catch (error) {
      logError("Error getting media base64 from Evolution API", error as Error);

      // Log detailed error information
      if (axios.isAxiosError(error)) {
        logError("Axios error details", {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
        } as any);
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to get media base64",
        error: error instanceof Error ? error.message : "Unknown error",
        details: axios.isAxiosError(error) ? error.response?.data : undefined,
      });
    }
  });
}
