import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StatusCodes } from "http-status-codes";
import { logError, logInfo } from "@/utils/logger";
import { db } from "@/lib/db";

// Types for Evolution API webhook
interface EvolutionWebhookKey {
  remoteJid: string;
  fromMe: boolean;
  id: string;
  participant?: string;
  participantLid?: string;
}

interface EvolutionMessage {
  conversation?: string;
  imageMessage?: {
    url?: string;
    mimetype?: string;
    caption?: string;
    fileLength?: number;
  };
  videoMessage?: {
    url?: string;
    mimetype?: string;
    caption?: string;
    fileLength?: number;
  };
  documentMessage?: {
    url?: string;
    mimetype?: string;
    title?: string;
    fileName?: string;
    fileLength?: number;
  };
  audioMessage?: {
    url?: string;
    mimetype?: string;
    fileLength?: number;
  };
  stickerMessage?: {
    url?: string;
    mimetype?: string;
  };
}

interface EvolutionWebhookData {
  key: EvolutionWebhookKey;
  pushName?: string;
  status: string;
  message: EvolutionMessage;
  messageType: string;
  messageTimestamp: number;
  instanceId: string;
}

interface EvolutionWebhookBody {
  event: string;
  instance: string;
  data: EvolutionWebhookData;
  date_time: string;
  sender: string;
  server_url: string;
  apikey: string;
}

interface WebhookRequest extends FastifyRequest {
  body: EvolutionWebhookBody | EvolutionWebhookBody[];
}

export default async function (app: FastifyInstance) {
  // Evolution API webhook receiver
  app.post<{ Body: EvolutionWebhookBody | EvolutionWebhookBody[] }>(
    "/",
    async (req, reply) => {
      try {
        logInfo("Received Evolution API webhook", {
          headers: req.headers,
          body:
            typeof req.body === "object"
              ? `webhook_data ${JSON.stringify(req.body)}`
              : req.body,
        });

        // Handle both single webhook and array of webhooks
        const webhooks = Array.isArray(req.body) ? req.body : [req.body];

        const results = [];

        for (const webhook of webhooks) {
          try {
            const result = await processWebhook(webhook);
            results.push({
              success: true,
              messageId: result?.id,
              event: webhook.event,
            });
          } catch (error) {
            logError("Error processing individual webhook", error as Error);
            results.push({
              success: false,
              error: error instanceof Error ? error.message : "Unknown error",
              event: webhook?.event || "unknown",
            });
          }
        }

        return reply.code(StatusCodes.OK).send({
          status: "success",
          message: "Webhooks processed",
          processed: results.length,
          results,
        });
      } catch (error) {
        logError("Error processing Evolution API webhook", error as Error);

        return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
          status: "error",
          message: "Failed to process webhook",
          error: error instanceof Error ? error.message : "Unknown error",
        });
      }
    }
  );

  // Health check endpoint
  app.get("/health", async (_req, reply) => {
    return reply.code(StatusCodes.OK).send({
      status: "healthy",
      service: "evolution-webhook-receiver",
      timestamp: new Date().toISOString(),
    });
  });
}

async function processWebhook(webhook: EvolutionWebhookBody) {
  const { event, instance, data, date_time, sender, server_url, apikey } =
    webhook;

  // Only process messages.upsert events
  if (event !== "messages.upsert") {
    logInfo("Ignoring non-message event", { event });
    return null;
  }

  const { key, pushName, message, messageType, messageTimestamp } = data;

  // Extract message content based on type
  const messageContent = extractMessageContent(message, messageType);

  // Determine if it's a group message
  const isGroup = key.remoteJid.includes("@g.us");
  const chatId = key.remoteJid;
  const senderId = isGroup ? key.participant : key.remoteJid;
  const senderName = pushName || extractPhoneNumber(senderId || "");

  // Skip messages sent by the bot itself
  if (key.fromMe) {
    logInfo("Skipping message sent by bot", { messageId: key.id });
    return null;
  }

  try {
    // Save message to database
    const savedMessage = await db.evolutionMessage.create({
      data: {
        messageId: key.id,
        instanceName: instance,
        chatId,
        senderId: senderId || "",
        senderName,
        messageType,
        content: messageContent.text,
        mediaUrl: messageContent.mediaUrl,
        mediaType: messageContent.mediaType,
        caption: messageContent.caption,
        fileName: messageContent.fileName,
        timestamp: new Date(messageTimestamp * 1000),
        isGroup,
        status: data.status,
        serverUrl: server_url,
        apikey: apikey, // Be careful with storing API keys
        webhookData: webhook as any, // Store full webhook for reference
        createdAt: new Date(date_time),
      },
    });

    logInfo("Message saved to database", {
      messageId: key.id,
      messageType,
      senderId,
      chatId,
      isGroup,
      content: messageContent.text
        ? messageContent.text.substring(0, 100)
        : "media",
    });

    // Here you can add additional processing:
    // - Send to AI processing queue
    // - Trigger automated responses
    // - Forward to other services
    // - Apply business logic rules

    return savedMessage;
  } catch (error) {
    logError("Failed to save message to database", error as Error);
    throw error;
  }
}

function extractMessageContent(message: EvolutionMessage, messageType: string) {
  const result = {
    text: "",
    mediaUrl: "",
    mediaType: "",
    caption: "",
    fileName: "",
  };

  switch (messageType) {
    case "conversation":
      result.text = message.conversation || "";
      break;

    case "imageMessage":
      if (message.imageMessage) {
        result.mediaUrl = message.imageMessage.url || "";
        result.mediaType = message.imageMessage.mimetype || "image";
        result.caption = message.imageMessage.caption || "";
        result.text = result.caption;
      }
      break;

    case "videoMessage":
      if (message.videoMessage) {
        result.mediaUrl = message.videoMessage.url || "";
        result.mediaType = message.videoMessage.mimetype || "video";
        result.caption = message.videoMessage.caption || "";
        result.text = result.caption;
      }
      break;

    case "documentMessage":
      if (message.documentMessage) {
        result.mediaUrl = message.documentMessage.url || "";
        result.mediaType = message.documentMessage.mimetype || "document";
        result.fileName =
          message.documentMessage.fileName ||
          message.documentMessage.title ||
          "";
        result.text = `Document: ${result.fileName}`;
      }
      break;

    case "audioMessage":
      if (message.audioMessage) {
        result.mediaUrl = message.audioMessage.url || "";
        result.mediaType = message.audioMessage.mimetype || "audio";
        result.text = "Audio message";
      }
      break;

    case "stickerMessage":
      if (message.stickerMessage) {
        result.mediaUrl = message.stickerMessage.url || "";
        result.mediaType = message.stickerMessage.mimetype || "sticker";
        result.text = "Sticker";
      }
      break;

    default:
      result.text = `Unsupported message type: ${messageType}`;
      logInfo("Unsupported message type received", { messageType, message });
  }

  return result;
}

function extractPhoneNumber(jid: string): string {
  // Extract phone number from WhatsApp JID format
  return jid.split("@")[0] || jid;
}
