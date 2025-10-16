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
    webhookUrlProd?: string;
    webhookUrlDev?: string;
    configIAStatus?: string;
    // Campos de integração com Kommo
    kommoSubdomain?: string;
    kommoAccessToken?: string;
    kommodPipelineId?: string;
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

  // Determine senderId based on message direction
  // If fromMe=true, senderId should be MY number, not the recipient's
  let senderId: string;
  if (key.fromMe) {
    // Message sent by me - use my phone number or the instance number
    senderId = ENV.MY_PHONE_NUMBER || key.remoteJid; // Fallback to remoteJid if MY_PHONE_NUMBER not set
  } else {
    // Message received from someone else
    senderId = isGroup ? key.participant || key.remoteJid : key.remoteJid;
  }

  const senderName = pushName || extractPhoneNumber(senderId || "");

  // Check if the contact is blocked
  const phoneNumber = extractPhoneNumber(key.remoteJid);

  // Log message routing information for debugging
  logInfo("Message routing information", {
    fromMe: key.fromMe,
    chatId: chatId,
    senderId: senderId,
    phoneNumber: phoneNumber,
    isGroup: isGroup,
    messageId: key.id,
    willSaveTo: key.fromMe || (ENV.MY_PHONE_NUMBER && phoneNumber === ENV.MY_PHONE_NUMBER) ? "MyMessages" : "n8nChatMemory",
  });

  // TESTING MODE: Only allow these specific numbers
  const allowedNumbers = [
    "554391120940", // +55 43 9112-0940
    "554391885778", // +55 43 9188-5778
    "554384778544", // +55 43 8477-8544
    "553484443047",
    "554399140409",
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

  // Log configs for debugging webhook URL issues
  logInfo("Webhook configs loaded", {
    configIAId: configs.configIAId,
    hasWebhookUrlProd: !!configs.webhookUrlProd,
    hasWebhookUrlDev: !!configs.webhookUrlDev,
    webhookUrlProdPreview: configs.webhookUrlProd
      ? configs.webhookUrlProd.substring(0, 50) + "..."
      : "NOT_SET",
    webhookUrlDevPreview: configs.webhookUrlDev
      ? configs.webhookUrlDev.substring(0, 50) + "..."
      : "NOT_SET",
    nodeEnv: ENV.NODE_ENV,
  });

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

    // Check if this message is from you (my phone number OR fromMe flag from Evolution API)
    const isMyMessage =
      (ENV.MY_PHONE_NUMBER && phoneNumber === ENV.MY_PHONE_NUMBER) ||
      key.fromMe === true;

    if (isMyMessage) {
      // Save your message to MyMessages table
      // IMPORTANT: chatId is the recipient's number (person you're talking to)
      //            senderId is YOUR number (ENV.MY_PHONE_NUMBER)
      //            This ensures your messages are grouped with the same chat as the recipient's messages
      const myMessage = await db.myMessages.create({
        data: {
          sessionId: sessionId,
          message: messageContent.text || "Mensagem sem texto",
          direction: "sent",

          // Evolution API fields
          messageId: key?.id || null,
          instanceName: instance || null,
          chatId: chatId || null, // Recipient's number (person A)
          senderId: senderId || null, // Your number (from ENV.MY_PHONE_NUMBER)
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

      logInfo("Your message saved to MyMessages table (not sent to N8N)", {
        messageId: key.id,
        messageType,
        phoneNumber,
        fromMe: key.fromMe,
        matchedBy: key.fromMe ? "fromMe flag" : "phone number",
        content: messageContent.text?.substring(0, 100),
      });

      return myMessage; // Early return - skip N8N and n8nChatMemory
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
    // Note: Messages with key.fromMe === true are already filtered out earlier (line 438-483)
    const webhookUrl = getWebhookUrl(configs);

    if (webhookUrl && !key.fromMe) {
      // Check if ConfigIA is active before sending to N8N
      const isConfigIAActive =
        configs.configIAId &&
        (await isConfigIAActiveStatus(configs.configIAId));

      if (isConfigIAActive) {
        try {
          await sendToN8N(savedMessage, webhook, webhookUrl);
        } catch (error) {
          logError("Failed to send message to N8N webhook", {
            error: error instanceof Error ? error.message : "Unknown error",
            stack: error instanceof Error ? error.stack : undefined,
            webhookUrl: webhookUrl.substring(0, 50) + "...",
            messageId: key.id,
            configIAId: configs.configIAId,
            configIAStatus: configs.configIAStatus,
            messageType: messageType,
            chatId: chatId,
            senderId: senderId,
            httpStatus: error instanceof Error && 'response' in error
              ? (error as any).response?.status
              : undefined,
            httpStatusText: error instanceof Error && 'response' in error
              ? (error as any).response?.statusText
              : undefined,
          });
        }
      } else {
        logInfo("ConfigIA is inactive, skipping N8N webhook", {
          configIAId: configs.configIAId,
          configIAStatus: configs.configIAStatus || "unknown",
          messageId: key.id,
        });
      }
    } else if (!webhookUrl) {
      logInfo("No webhook URL configured, skipping N8N webhook", {
        configIAId: configs.configIAId,
        messageId: key.id,
        hasEnvUrl: !!ENV.N8N_WEBHOOK_URL,
        hasProdUrl: !!configs.webhookUrlProd,
        hasDevUrl: !!configs.webhookUrlDev,
        configIAStatus: configs.configIAStatus,
        reason: !webhookUrl ? "no_webhook_url" : "message_from_me",
      });
    }

    return savedMessage;
  } catch (error) {
    logError("Failed to save message to database", error as Error);
    throw error;
  }
}

// Function to check if ConfigIA should process webhooks (not inactive)
async function isConfigIAActiveStatus(configIAId: string): Promise<boolean> {
  try {
    const configIA = await db.configIA.findUnique({
      where: { id: configIAId },
      select: { status: true },
    });

    // Only inactive status should block webhook processing
    return configIA?.status !== "inativo";
  } catch (error) {
    logError("Error checking ConfigIA status", error as Error);
    return false; // Default to inactive if error
  }
}

// Function to determine which webhook URL to use based on ConfigIA status
function getWebhookUrl(configs: any): string | null {
  // Priority based on ConfigIA status:
  // 1. "ativo" -> use webhookUrlProd
  // 2. "em desenvolvimento" -> use webhookUrlDev
  // 3. "inativo" -> return null (no webhook processing)
  // 4. Fall back to ENV.N8N_WEBHOOK_URL if no ConfigIA-specific URL

  const configIAStatus = configs.configIAStatus;

  logInfo("Determining webhook URL based on ConfigIA status", {
    configIAStatus,
    configIAId: configs.configIAId,
    hasWebhookUrlProd: !!configs.webhookUrlProd,
    hasWebhookUrlDev: !!configs.webhookUrlDev,
    hasEnvWebhookUrl: !!ENV.N8N_WEBHOOK_URL,
  });

  // If ConfigIA is inactive, don't process webhook
  if (configIAStatus === "inativo") {
    logInfo("ConfigIA is inactive, skipping webhook processing", {
      configIAId: configs.configIAId,
      status: configIAStatus,
    });
    return null;
  }

  // If ConfigIA is active, use production webhook URL
  if (configIAStatus === "ativo" && configs.webhookUrlProd) {
    logInfo("Using production webhook URL (ConfigIA status: ativo)", {
      url: configs.webhookUrlProd.substring(0, 50) + "...",
      configIAId: configs.configIAId,
    });
    return configs.webhookUrlProd;
  }

  // If ConfigIA is in development, use development webhook URL
  if (configIAStatus === "em desenvolvimento" && configs.webhookUrlDev) {
    logInfo("Using development webhook URL (ConfigIA status: em desenvolvimento)", {
      url: configs.webhookUrlDev.substring(0, 50) + "...",
      configIAId: configs.configIAId,
    });
    return configs.webhookUrlDev;
  }

  // Fallback: if active but no prod URL, try dev URL
  if (configIAStatus === "ativo" && configs.webhookUrlDev) {
    logInfo("Using development webhook URL as fallback for active ConfigIA", {
      url: configs.webhookUrlDev.substring(0, 50) + "...",
      configIAId: configs.configIAId,
    });
    return configs.webhookUrlDev;
  }

  // Fallback: if in development but no dev URL, try prod URL
  if (configIAStatus === "em desenvolvimento" && configs.webhookUrlProd) {
    logInfo("Using production webhook URL as fallback for development ConfigIA", {
      url: configs.webhookUrlProd.substring(0, 50) + "...",
      configIAId: configs.configIAId,
    });
    return configs.webhookUrlProd;
  }

  // Ultimate fallback to environment variable (only if ConfigIA is not inactive)
  if (configIAStatus !== "inativo" && ENV.N8N_WEBHOOK_URL) {
    logInfo("Using fallback webhook URL from environment", {
      url: ENV.N8N_WEBHOOK_URL.substring(0, 50) + "...",
      status: configIAStatus,
    });
    return ENV.N8N_WEBHOOK_URL;
  }

  logInfo("No suitable webhook URL found", {
    configIAStatus,
    configIAId: configs.configIAId,
  });
  return null;
}

// Function to create configs object for webhook identification
async function createConfigsObject(
  instanceName: string,
  serverUrl: string,
  webhookApikey: string
): Promise<{
  evolutionInstance: string;
  serverUrl: string;
  apikey: string;
  instanceId?: string;
  configIAId?: string;
  userId?: string;
  aiPrompt?: string;
  webhookUrlProd?: string;
  webhookUrlDev?: string;
  configIAStatus?: string;
  // Campos de integração com Kommo
  kommoSubdomain?: string;
  kommoAccessToken?: string;
  kommodPipelineId?: string;
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
        configIA: {
          select: {
            id: true,
            nome: true,
            prompt: true,
            status: true,
            webhookUrlProd: true,
            webhookUrlDev: true,
            // Campos de integração com Kommo
            kommoSubdomain: true,
            kommoAccessToken: true,
            kommodPipelineId: true,
          },
        },
        user: true,
      },
    });

    // Use apiKey from database if available, fallback to webhook apikey
    const apikey = evolutionInstance?.apiKey || webhookApikey;

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
        webhookUrlProd:
          evolutionInstance.configIA?.webhookUrlProd || "NULL/EMPTY",
        webhookUrlDev:
          evolutionInstance.configIA?.webhookUrlDev || "NULL/EMPTY",
        kommoIntegration: evolutionInstance.configIA?.kommoSubdomain
          ? {
              subdomain: evolutionInstance.configIA.kommoSubdomain,
              hasAccessToken: !!evolutionInstance.configIA.kommoAccessToken,
              pipelineId: evolutionInstance.configIA.kommodPipelineId || "NULL/EMPTY",
            }
          : "NOT_CONFIGURED",
        configIAData: evolutionInstance.configIA
          ? {
              id: evolutionInstance.configIA.id,
              webhookUrlProd: evolutionInstance.configIA.webhookUrlProd,
              webhookUrlDev: evolutionInstance.configIA.webhookUrlDev,
            }
          : "NO_CONFIG_IA",
        apiKeySource: evolutionInstance.apiKey ? "database" : "webhook",
      });

      return {
        ...configs,
        instanceId: evolutionInstance.id,
        configIAId: evolutionInstance.configIAId || undefined,
        userId: evolutionInstance.userId,
        aiPrompt: evolutionInstance.configIA?.prompt || undefined,
        webhookUrlProd: evolutionInstance.configIA?.webhookUrlProd || undefined,
        webhookUrlDev: evolutionInstance.configIA?.webhookUrlDev || undefined,
        configIAStatus: evolutionInstance.configIA?.status || undefined,
        // Campos de integração com Kommo
        kommoSubdomain: evolutionInstance.configIA?.kommoSubdomain || undefined,
        kommoAccessToken: evolutionInstance.configIA?.kommoAccessToken || undefined,
        kommodPipelineId: evolutionInstance.configIA?.kommodPipelineId || undefined,
      };
    } else {
      logInfo("Evolution instance not found in database", {
        instanceName,
        serverUrl: serverUrl?.substring(0, 50) + "...",
        apiKeySource: "webhook_fallback",
      });

      return configs;
    }
  } catch (error) {
    logError("Error creating configs object", error as Error);
    return {
      evolutionInstance: instanceName,
      serverUrl: serverUrl,
      apikey: webhookApikey,
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
  originalWebhook: EvolutionWebhookBody,
  webhookUrl: string
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

      // Kommo integration data (when available)
      kommoIntegration: originalWebhook.configs?.kommoSubdomain ? {
        subdomain: originalWebhook.configs.kommoSubdomain,
        accessToken: originalWebhook.configs.kommoAccessToken,
        pipelineId: originalWebhook.configs.kommodPipelineId,
      } : null,

      // Processing metadata
      processingInfo: {
        processedAt: new Date().toISOString(),
        hasMedia: !!savedMessage.mediaBase64,
        mediaSize: savedMessage.mediaBase64
          ? `${Math.round(savedMessage.mediaBase64.length / 1024)}KB`
          : null,
        hasKommoIntegration: !!originalWebhook.configs?.kommoSubdomain,
      },
    };

    logInfo("Sending message to N8N webhook", {
      n8nUrl: webhookUrl.substring(0, 50) + "...",
      messageId: savedMessage.messageId,
      messageType: savedMessage.messageType,
      hasMedia: !!savedMessage.mediaBase64,
      payloadSize: `${Math.round(JSON.stringify(n8nPayload).length / 1024)}KB`,
      hasKommoIntegration: !!originalWebhook.configs?.kommoSubdomain,
      kommoSubdomain: originalWebhook.configs?.kommoSubdomain || "not_configured",
    });

    const response = await axios.post(webhookUrl, n8nPayload, {
      timeout: 15000, // 15 seconds timeout (increased)
      headers: {
        "Content-Type": "application/json",
        "User-Agent": "Evolution-Webhook-Forwarder/1.0",
      },
      validateStatus: (status) => {
        // Accept any status code less than 500 as valid
        return status < 500;
      },
    });

    if (response.status >= 200 && response.status < 300) {
      logInfo("Message successfully sent to N8N", {
        messageId: savedMessage.messageId,
        responseStatus: response.status,
        responseData: typeof response.data === 'object'
          ? JSON.stringify(response.data).substring(0, 200) + "..."
          : response.data?.toString().substring(0, 200) + "...",
      });
    } else {
      logError("N8N webhook returned non-success status", {
        messageId: savedMessage.messageId,
        responseStatus: response.status,
        responseStatusText: response.statusText,
        responseData: typeof response.data === 'object'
          ? JSON.stringify(response.data)
          : response.data,
        webhookUrl: webhookUrl.substring(0, 50) + "...",
      });
      throw new Error(`N8N webhook returned status ${response.status}: ${response.statusText}`);
    }
  } catch (error) {
    const isAxiosError = error && typeof error === 'object' && 'isAxiosError' in error;

    logError("Failed to send message to N8N webhook", {
      error: error instanceof Error ? error.message : "Unknown error",
      stack: error instanceof Error ? error.stack?.split('\n').slice(0, 5).join('\n') : undefined,
      messageId: savedMessage.messageId,
      webhookUrl: webhookUrl.substring(0, 50) + "...",
      isAxiosError,
      httpStatus: isAxiosError ? (error as any).response?.status : undefined,
      httpStatusText: isAxiosError ? (error as any).response?.statusText : undefined,
      httpResponseData: isAxiosError && (error as any).response?.data
        ? typeof (error as any).response.data === 'object'
          ? JSON.stringify((error as any).response.data)
          : (error as any).response.data
        : undefined,
      requestConfig: isAxiosError ? {
        url: (error as any).config?.url?.substring(0, 50) + "...",
        method: (error as any).config?.method,
        timeout: (error as any).config?.timeout,
      } : undefined,
      errorCode: isAxiosError ? (error as any).code : undefined,
    });
    throw error;
  }
}
