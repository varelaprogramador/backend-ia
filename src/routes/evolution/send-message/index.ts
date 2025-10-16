import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import { logError, logInfo } from "@/utils/logger";
import { db } from "@/lib/db";
import axios from "axios";
import { ENV } from "@/config/env";

export default async function (app: FastifyInstance) {
  // Send text message via Evolution API
  app.post<{
    Body: {
      instanceName: string;
      remoteJid: string;
      message: string;
      agentId?: string;
    };
  }>("/text", async (req, reply) => {
    try {
      const { instanceName, remoteJid, message, agentId } = req.body;

      if (!instanceName || !remoteJid || !message) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          status: "error",
          message: "instanceName, remoteJid, and message are required",
        });
      }

      logInfo("Sending text message via Evolution API", {
        instanceName,
        remoteJid,
        messageLength: message.length,
        agentId,
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

      // Send message via Evolution API
      const evolutionUrl = `${evolutionInstance.serverUrl}/message/sendText/${instanceName}`;

      logInfo("Calling Evolution API", {
        url: evolutionUrl,
        remoteJid,
      });

      const response = await axios.post(
        evolutionUrl,
        {
          number: remoteJid.replace("@s.whatsapp.net", ""),
          text: message,
        },
        {
          headers: {
            "Content-Type": "application/json",
            apikey: evolutionInstance.apiKey,
          },
          timeout: 30000,
        }
      );

      logInfo("Message sent successfully via Evolution API", {
        instanceName,
        remoteJid,
        responseStatus: response.status,
      });

      // Save sent message to MyMessages table
      try {
        const messageId = response.data?.key?.id || `sent-${Date.now()}`;
        const senderId = ENV.MY_PHONE_NUMBER || remoteJid;

        await db.myMessages.create({
          data: {
            sessionId: agentId || "manual-send",
            message: message,
            direction: "sent",
            messageId: messageId,
            instanceName: instanceName,
            chatId: remoteJid,
            senderId: senderId,
            timestamp: new Date(),
          },
        });

        logInfo("Message saved to MyMessages table", {
          messageId,
          chatId: remoteJid,
          senderId,
        });
      } catch (dbError) {
        logError("Error saving message to MyMessages table", dbError as Error);
        // Don't fail the request if DB save fails
      }

      return reply.code(StatusCodes.OK).send({
        status: "success",
        message: "Message sent successfully",
        data: response.data,
      });
    } catch (error) {
      logError("Error sending text message via Evolution API", error as Error);

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to send message",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Send audio message via Evolution API
  app.post<{
    Body: {
      instanceName: string;
      remoteJid: string;
      audioBase64: string;
      agentId?: string;
    };
  }>("/audio", async (req, reply) => {
    try {
      const { instanceName, remoteJid, audioBase64, agentId } = req.body;

      if (!instanceName || !remoteJid || !audioBase64) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          status: "error",
          message: "instanceName, remoteJid, and audioBase64 are required",
        });
      }

      logInfo("Sending audio message via Evolution API", {
        instanceName,
        remoteJid,
        audioSize: `${Math.round(audioBase64.length / 1024)}KB`,
        agentId,
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

      // Send audio via Evolution API
      const evolutionUrl = `${evolutionInstance.serverUrl}/message/sendWhatsAppAudio/${instanceName}`;
      const phoneNumber = remoteJid.replace("@s.whatsapp.net", "");

      // Remove data URI prefix if present - Evolution API expects pure base64 or URL
      let audioData = audioBase64;
      if (audioBase64.startsWith('data:')) {
        // Extract pure base64 from data URI
        audioData = audioBase64.split(',')[1] || audioBase64;
      }

      const payload = {
        number: phoneNumber,
        audio: audioData,
        delay: 1200,
      };

      logInfo("Calling Evolution API for audio", {
        url: evolutionUrl,
        phoneNumber,
        audioSize: `${Math.round(audioData.length / 1024)}KB`,
        hasDataPrefix: audioBase64.startsWith('data:'),
        isPureBase64: !audioData.startsWith('data:'),
        payloadKeys: Object.keys(payload),
      });

      const response = await axios.post(
        evolutionUrl,
        payload,
        {
          headers: {
            "Content-Type": "application/json",
            apikey: evolutionInstance.apiKey,
          },
          timeout: 60000, // 60 seconds for audio upload
        }
      );

      logInfo("Audio message sent successfully via Evolution API", {
        instanceName,
        remoteJid,
        responseStatus: response.status,
      });

      // Save sent audio message to MyMessages table
      try {
        const messageId = response.data?.key?.id || `sent-audio-${Date.now()}`;
        const senderId = ENV.MY_PHONE_NUMBER || remoteJid;

        await db.myMessages.create({
          data: {
            sessionId: agentId || "manual-send",
            message: "🎤 Áudio enviado",
            direction: "sent",
            messageId: messageId,
            instanceName: instanceName,
            chatId: remoteJid,
            senderId: senderId,
            timestamp: new Date(),
            mediaType: "audio",
          },
        });

        logInfo("Audio message saved to MyMessages table", {
          messageId,
          chatId: remoteJid,
          senderId,
        });
      } catch (dbError) {
        logError("Error saving audio message to MyMessages table", dbError as Error);
        // Don't fail the request if DB save fails
      }

      return reply.code(StatusCodes.OK).send({
        status: "success",
        message: "Audio message sent successfully",
        data: response.data,
      });
    } catch (error) {
      logError("Error sending audio message via Evolution API", error as Error);

      // Log detailed error information
      if (axios.isAxiosError(error)) {
        logError("Axios error details", {
          status: error.response?.status,
          statusText: error.response?.statusText,
          data: error.response?.data,
          headers: error.response?.headers,
        } as any);
      }

      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to send audio message",
        error: error instanceof Error ? error.message : "Unknown error",
        details: axios.isAxiosError(error) ? error.response?.data : undefined,
      });
    }
  });
}
