import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { StatusCodes } from "http-status-codes";
import { logError, logInfo } from "@/utils/logger";
import { db } from "@/lib/db";
import { ENV } from "@/config/env";
import axios from "axios";

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
    jpegThumbnail?: string; // Base64 thumbnail
  };
  videoMessage?: {
    url?: string;
    mimetype?: string;
    caption?: string;
    fileLength?: number;
    jpegThumbnail?: string; // Base64 thumbnail for videos
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

  // AI Chat Memory fields (optional)
  action?: string;
  input?: string;
  system_message?: string;
  sessionId?: string;
  id?: string;
  direction?: string;

  // Instance identification configs
  configs?: {
    evolutionInstance: string;
    serverUrl: string;
    apikey: string;
    instanceId?: string;
    configIAId?: string;
    userId?: string;
    aiPrompt?: string;
  };
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
              messageId: result?.sessionId,
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

  // Endpoint to receive AI responses
  app.post<{
    Body: { sessionId: string; aiResponse: string; chatId?: string };
  }>("/ai-response", async (req, reply) => {
    try {
      const { sessionId, aiResponse, chatId } = req.body;

      if (!sessionId || !aiResponse) {
        return reply.code(StatusCodes.BAD_REQUEST).send({
          status: "error",
          message: "sessionId and aiResponse are required",
        });
      }

      const aiMessage = await db.myMessages.create({
        data: {
          sessionId: sessionId,
          message: aiResponse,
          direction: "received",
          aiResponse: aiResponse,
          isAiResponse: true,
          chatId: chatId || null,
          createdAt: new Date(),
        },
      });

      logInfo("AI response saved to MyMessages table", {
        sessionId,
        aiResponse: aiResponse.substring(0, 100),
        chatId,
      });

      return reply.code(StatusCodes.OK).send({
        status: "success",
        message: "AI response saved",
        id: aiMessage.id,
      });
    } catch (error) {
      logError("Error saving AI response", error as Error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to save AI response",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  // Endpoint to get your messages (conversation history)
  app.get<{
    Querystring: { sessionId?: string; chatId?: string; limit?: string };
  }>("/my-messages", async (req, reply) => {
    try {
      const { sessionId, chatId, limit = "50" } = req.query;

      const where: any = {};
      if (sessionId) where.sessionId = sessionId;
      if (chatId) where.chatId = chatId;

      const messages = await db.myMessages.findMany({
        where,
        orderBy: { createdAt: "desc" },
        take: parseInt(limit),
        select: {
          id: true,
          sessionId: true,
          message: true,
          direction: true,
          createdAt: true,
          chatId: true,
          messageType: true,
          isAiResponse: true,
          aiResponse: true,
          mediaType: true,
          fileName: true,
        },
      });

      return reply.code(StatusCodes.OK).send({
        status: "success",
        count: messages.length,
        messages: messages.reverse(), // Show oldest first
      });
    } catch (error) {
      logError("Error retrieving my messages", error as Error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        status: "error",
        message: "Failed to retrieve messages",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });
}

async function processWebhook(webhook: EvolutionWebhookBody) {
  const { event, instance, data, date_time, sender, server_url, apikey } =
    webhook;

  // Create configs object to identify webhook source
  const configs = await createConfigsObject(instance, server_url, apikey);
  webhook.configs = configs;

  // Only process messages.upsert events
  if (event !== "messages.upsert") {
    logInfo("Ignoring non-message event", { event, configs });
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

  // Check if the contact is blocked
  const phoneNumber = extractPhoneNumber(key.remoteJid);

  // TESTING MODE: Only allow these specific numbers
  const allowedNumbers = [
    "554391120940", // +55 43 9112-0940
    "554391885778", // +55 43 9188-5778
    "554384778544", // +55 43 8477-8544
    "553484443047",
  ];

  const normalizedPhoneNumber = phoneNumber.replace(/[^\d]/g, "");
  const isAllowedNumber = allowedNumbers.includes(normalizedPhoneNumber);

  
  // Check for exact match or pattern match (numbers starting with 12)
  const blockedContact = await db.blockedContact.findFirst({
    where: {
      OR: [{ remoteJid: key.remoteJid }],
    },
  });

  // Also check if phone number starts with 12
  const isBlockedPattern = key.remoteJid.startsWith("12");

  if (blockedContact || isBlockedPattern) {
    logInfo("Skipping message from blocked contact", {
      remoteJid: key.remoteJid,
      phoneNumber: phoneNumber,
      messageId: key.id,
      reason:
        blockedContact?.reason || "Number starts with 12 (blocked pattern)",
      patternMatch: isBlockedPattern,
    });
    return null;
  }

  // Check if the number is deactivated for a specific agent
  if (configs.configIAId) {
    const normalizedPhoneNumber = phoneNumber.replace(/[^\d]/g, "");

    // Generate both possible formats for Brazilian mobile numbers
    // Original: 553484443047 (10 digits after country code)
    // With 9: 5534984443047 (11 digits after country code - newer format)
    const possibleNumbers = [normalizedPhoneNumber];

    // If it's a Brazilian number (55) and has 10 digits after country code, try adding 9
    if (
      normalizedPhoneNumber.startsWith("55") &&
      normalizedPhoneNumber.length === 12
    ) {
      const areaCode = normalizedPhoneNumber.substring(2, 4);
      const number = normalizedPhoneNumber.substring(4);
      const withNine = `55${areaCode}9${number}`;
      possibleNumbers.push(withNine);
    }

    // If it's a Brazilian number with 11 digits after country code, try removing 9
    if (
      normalizedPhoneNumber.startsWith("55") &&
      normalizedPhoneNumber.length === 13
    ) {
      const areaCode = normalizedPhoneNumber.substring(2, 4);
      const possibleNine = normalizedPhoneNumber.substring(4, 5);
      const number = normalizedPhoneNumber.substring(5);
      if (possibleNine === "9") {
        const withoutNine = `55${areaCode}${number}`;
        possibleNumbers.push(withoutNine);
      }
    }

    logInfo("Checking if number is deactivated for agent", {
      originalRemoteJid: key.remoteJid,
      extractedPhoneNumber: phoneNumber,
      normalizedPhoneNumber: normalizedPhoneNumber,
      possibleNumbers: possibleNumbers,
      configIAId: configs.configIAId,
      messageId: key.id,
      transformation: `${key.remoteJid} → ${phoneNumber} → ${normalizedPhoneNumber}`,
    });

    // Check all possible number variations
    const deactivatedAgent = await db.deactivatedAgent.findFirst({
      where: {
        configIAId: configs.configIAId,
        phoneNumber: {
          in: possibleNumbers,
        },
      },
    });

    if (deactivatedAgent && deactivatedAgent.isActive) {
      logInfo("Skipping message from number deactivated for this agent", {
        remoteJid: key.remoteJid,
        phoneNumber: normalizedPhoneNumber,
        matchedNumber: deactivatedAgent.phoneNumber,
        configIAId: configs.configIAId,
        messageId: key.id,
        reason: deactivatedAgent.reason || "Number deactivated for this agent",
        deactivatedBy: deactivatedAgent.blockedBy,
        deactivatedAt: deactivatedAgent.createdAt.toISOString(),
      });
      return null;
    } else {
      logInfo("Number is not deactivated, processing message", {
        normalizedPhoneNumber: normalizedPhoneNumber,
        possibleNumbers: possibleNumbers,
        configIAId: configs.configIAId,
        messageId: key.id,
        deactivatedAgentFound: !!deactivatedAgent,
        isActive: deactivatedAgent?.isActive || false,
      });
    }
  }

  try {
    // Get media as base64 if it's a media message
    let mediaBase64: string | null = null;
    const hasMedia = [
      "imageMessage",
      "videoMessage",
      "documentMessage",
      "audioMessage",
      "stickerMessage",
    ].includes(messageType);

    if (hasMedia) {
      mediaBase64 = await getMediaBase64(message, messageType);
    }

    // Generate sessionId if not provided
    const sessionId =
      webhook.sessionId ||
      `${chatId}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Check if this message is from you (my phone number)
    const isMyMessage =
      ENV.MY_PHONE_NUMBER && phoneNumber === ENV.MY_PHONE_NUMBER;

    if (isMyMessage) {
      // Save your message to MyMessages table
      const myMessage = await db.myMessages.create({
        data: {
          sessionId: sessionId,
          message: messageContent.text || "Mensagem sem texto",
          direction: "sent",

          // Evolution API fields
          messageId: key?.id || null,
          instanceName: instance || null,
          chatId: chatId || null,
          senderId: senderId || null,
          senderName: senderName || null,
          messageType: messageType || null,
          content: messageContent.text || undefined,
          mediaUrl: messageContent.mediaUrl || undefined,
          mediaType: messageContent.mediaType || undefined,
          mediaBase64: mediaBase64 || undefined,
          caption: messageContent.caption || undefined,
          fileName: messageContent.fileName || undefined,
          timestamp: messageTimestamp
            ? new Date(messageTimestamp * 1000)
            : undefined,
          isGroup: isGroup !== undefined ? isGroup : undefined,
          status: data?.status || undefined,
          serverUrl: server_url || undefined,
          apikey: apikey || undefined,
          webhookData: webhook
            ? JSON.parse(JSON.stringify(webhook))
            : undefined,
          createdAt: date_time ? new Date(date_time) : undefined,
          isAiResponse: false,
        },
      });

      logInfo("Your message saved to MyMessages table", {
        messageId: key.id,
        messageType,
        phoneNumber,
        content: messageContent.text?.substring(0, 100),
      });

      return myMessage;
    }

    // Save message to database (for other users)
    const savedMessage = await db.n8nChatMemory.create({
      data: {
        sessionId: sessionId,
        message: messageContent.text || "Mensagem sem texto",
        direction: webhook.direction || "input",

        // Evolution API fields
        messageId: key?.id || null,
        instanceName: instance || null,
        chatId: chatId || null,
        senderId: senderId || null,
        senderName: senderName || null,
        messageType: messageType || null,
        content: messageContent.text || undefined,
        mediaUrl: messageContent.mediaUrl || undefined,
        mediaType: messageContent.mediaType || undefined,
        mediaBase64: mediaBase64 || undefined, // Store base64 content
        caption: messageContent.caption || undefined,
        fileName: messageContent.fileName || undefined,
        timestamp: messageTimestamp
          ? new Date(messageTimestamp * 1000)
          : undefined,
        isGroup: isGroup !== undefined ? isGroup : undefined,
        status: data?.status || undefined,
        serverUrl: server_url || undefined,
        apikey: apikey || undefined, // Cuidado ao armazenar chaves de API
        webhookData: webhook ? JSON.parse(JSON.stringify(webhook)) : undefined, // Garante compatibilidade com InputJsonValue
        createdAt: date_time ? new Date(date_time) : undefined,

        // AI Chat Memory fields - use values from webhook if available
        action: webhook.action || "insertSystem",
        input: webhook.input || messageContent.text || undefined,
        system_message: webhook.system_message || undefined,
      },
    });

    logInfo("Message saved to database", {
      messageId: key.id,
      messageType,
      senderId,
      chatId,
      isGroup,
      hasBase64: !!mediaBase64,
      base64Size: mediaBase64
        ? `${Math.round(mediaBase64.length / 1024)}KB`
        : null,
      content: messageContent.text
        ? messageContent.text.substring(0, 100)
        : "media",
    });

    // Send to N8N webhook if configured and not from me and ConfigIA is active
    // Note: Messages from deactivated numbers are already filtered out earlier in the processWebhook function
    if (ENV.N8N_WEBHOOK_URL && !key.fromMe) {
      // Check if ConfigIA is active before sending to N8N
      const isConfigIAActive =
        configs.configIAId &&
        (await isConfigIAActiveStatus(configs.configIAId));

      if (isConfigIAActive) {
        try {
          await sendToN8N(savedMessage, webhook);
        } catch (error) {
          logError("Failed to send message to N8N webhook", error as Error);
        }
      } else {
        logInfo("ConfigIA is inactive, skipping N8N webhook", {
          configIAId: configs.configIAId,
          configIAStatus: isConfigIAActive ? "ativo" : "inativo",
          messageId: key.id,
        });
      }
    }

    return savedMessage;
  } catch (error) {
    logError("Failed to save message to database", error as Error);
    throw error;
  }
}

// Function to check if ConfigIA is active
async function isConfigIAActiveStatus(configIAId: string): Promise<boolean> {
  try {
    const configIA = await db.configIA.findUnique({
      where: { id: configIAId },
      select: { status: true },
    });

    return configIA?.status === "ativo";
  } catch (error) {
    logError("Error checking ConfigIA status", error as Error);
    return false; // Default to inactive if error
  }
}

// Function to create configs object for webhook identification
async function createConfigsObject(
  instanceName: string,
  serverUrl: string,
  apikey: string
): Promise<{
  evolutionInstance: string;
  serverUrl: string;
  apikey: string;
  instanceId?: string;
  configIAId?: string;
  userId?: string;
  aiPrompt?: string;
}> {
  try {
    logInfo("Creating configs object for webhook identification", {
      instanceName,
      serverUrl: serverUrl?.substring(0, 50) + "...",
    });

    // Look up evolution instance in database
    const evolutionInstance = await db.evolutionInstance.findFirst({
      where: {
        instanceName: instanceName,
        serverUrl: serverUrl,
      },
      include: {
        configIA: true,
        user: true,
      },
    });

    const configs = {
      evolutionInstance: instanceName,
      serverUrl: serverUrl,
      apikey: apikey,
    };

    if (evolutionInstance) {
      logInfo("Evolution instance found in database", {
        instanceId: evolutionInstance.id,
        userId: evolutionInstance.userId,
        configIAId: evolutionInstance.configIAId,
        configIAName: evolutionInstance.configIA?.nome,
        aiPrompt: evolutionInstance.configIA?.prompt
          ? "Present"
          : "Not present",
      });

      return {
        ...configs,
        instanceId: evolutionInstance.id,
        configIAId: evolutionInstance.configIAId || undefined,
        userId: evolutionInstance.userId,
        aiPrompt: evolutionInstance.configIA?.prompt || undefined,
      };
    } else {
      logInfo("Evolution instance not found in database", {
        instanceName,
        serverUrl: serverUrl?.substring(0, 50) + "...",
      });

      return configs;
    }
  } catch (error) {
    logError("Error creating configs object", error as Error);
    return {
      evolutionInstance: instanceName,
      serverUrl: serverUrl,
      apikey: apikey,
    };
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
  // Examples:
  // - "5534984443047@s.whatsapp.net" → "5534984443047"
  // - "553484443047@s.whatsapp.net" → "553484443047"
  // - "5534984443047" → "5534984443047"
  const phoneOnly = jid.split("@")[0] || jid;

  // Remove any non-digit characters and normalize
  return phoneOnly.replace(/[^\d]/g, "");
}

// Function to download media and convert to base64
async function downloadMediaAsBase64(
  url: string,
  maxSizeMB: number = 5
): Promise<string | null> {
  try {
    logInfo("Downloading media from URL", { url: url.substring(0, 100) });

    const response = await axios.get(url, {
      responseType: "arraybuffer",
      timeout: 30000, // 30 seconds timeout
      maxContentLength: maxSizeMB * 1024 * 1024, // Max size limit
    });

    if (response.data) {
      const base64 = Buffer.from(response.data).toString("base64");
      logInfo("Media downloaded and converted to base64", {
        size: `${Math.round(base64.length / 1024)}KB`,
        originalUrl: url.substring(0, 50) + "...",
      });
      return base64;
    }

    return null;
  } catch (error) {
    logError("Failed to download media", error as Error);
    return null;
  }
}

// Function to get base64 from thumbnail or download full media
async function getMediaBase64(
  message: any,
  messageType: string
): Promise<string | null> {
  try {
    // For images, try to use jpegThumbnail first (already base64)
    if (messageType === "imageMessage" && message.imageMessage?.jpegThumbnail) {
      logInfo("Using jpegThumbnail for image base64");
      return message.imageMessage.jpegThumbnail;
    }

    // For videos, try to use jpegThumbnail first (already base64)
    if (messageType === "videoMessage" && message.videoMessage?.jpegThumbnail) {
      logInfo("Using jpegThumbnail for video base64");
      return message.videoMessage.jpegThumbnail;
    }

    // If no thumbnail or other media types, download from URL
    let mediaUrl = null;

    switch (messageType) {
      case "imageMessage":
        mediaUrl = message.imageMessage?.url;
        break;
      case "videoMessage":
        mediaUrl = message.videoMessage?.url;
        break;
      case "documentMessage":
        mediaUrl = message.documentMessage?.url;
        break;
      case "audioMessage":
        mediaUrl = message.audioMessage?.url;
        break;
      case "stickerMessage":
        mediaUrl = message.stickerMessage?.url;
        break;
    }

    if (mediaUrl) {
      return await downloadMediaAsBase64(mediaUrl);
    }

    return null;
  } catch (error) {
    logError("Failed to get media base64", error as Error);
    return null;
  }
}

// Function to send message data to N8N webhook
async function sendToN8N(
  savedMessage: any,
  originalWebhook: EvolutionWebhookBody
): Promise<void> {
  try {
    const n8nPayload = {
      // Original webhook data
      originalWebhook,

      // Processed message data
      processedMessage: {
        id: savedMessage.id,
        sessionId: savedMessage.sessionId,
        message: savedMessage.message,
        direction: savedMessage.direction,
        createdAt: savedMessage.createdAt,

        // Evolution API fields
        messageId: savedMessage.messageId,
        instanceName: savedMessage.instanceName,
        chatId: savedMessage.chatId,
        senderId: savedMessage.senderId,
        senderName: savedMessage.senderName,
        messageType: savedMessage.messageType,
        content: savedMessage.content,
        mediaUrl: savedMessage.mediaUrl,
        mediaType: savedMessage.mediaType,
        mediaBase64: savedMessage.mediaBase64,
        caption: savedMessage.caption,
        fileName: savedMessage.fileName,
        timestamp: savedMessage.timestamp,
        isGroup: savedMessage.isGroup,
        status: savedMessage.status,
        processed: savedMessage.processed,

        // AI Chat Memory fields
        action: savedMessage.action,
        input: savedMessage.input,
        system_message: savedMessage.system_message,
      },

      // Processing metadata
      processingInfo: {
        processedAt: new Date().toISOString(),
        hasMedia: !!savedMessage.mediaBase64,
        mediaSize: savedMessage.mediaBase64
          ? `${Math.round(savedMessage.mediaBase64.length / 1024)}KB`
          : null,
      },
    };

    logInfo("Sending message to N8N webhook", {
      n8nUrl: ENV.N8N_WEBHOOK_URL?.substring(0, 50) + "...",
      messageId: savedMessage.messageId,
      messageType: savedMessage.messageType,
      hasMedia: !!savedMessage.mediaBase64,
    });

    const response = await axios.post(ENV.N8N_WEBHOOK_URL!, n8nPayload, {
      timeout: 10000, // 10 seconds timeout
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Evolution-Webhook-Forwarder/1.0",
      },
    });

    logInfo("Message successfully sent to N8N", {
      messageId: savedMessage.messageId,
      responseStatus: response.status,
      responseData: response.data,
    });
  } catch (error) {
    logError("Failed to send message to N8N webhook", {
      error: error instanceof Error ? error.message : "Unknown error",
      messageId: savedMessage.messageId,
      n8nUrl: ENV.N8N_WEBHOOK_URL?.substring(0, 50) + "...",
    });
    throw error;
  }
}
