import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";
import axios from "axios";
import OpenAI from "openai";
import { notificationService } from "./notification-service";

/**
 * Serviço de automação do fluxo de follow-up com IA
 *
 * Este serviço é responsável por:
 * 1. Verificar leads que precisam de follow-up (baseado em nextFollowUpAt)
 * 2. Gerar mensagem personalizada com OpenAI usando o prompt do FollowUpAgent
 * 3. Enviar mensagem via Evolution API (WhatsApp)
 * 4. Marcar o follow-up como cumprido
 * 5. Mover lead para próxima etapa se configurado
 */
export class FollowUpFlowCronService {
  private static instance: FollowUpFlowCronService;
  private isRunning = false;

  private constructor() {}

  static getInstance(): FollowUpFlowCronService {
    if (!FollowUpFlowCronService.instance) {
      FollowUpFlowCronService.instance = new FollowUpFlowCronService();
    }
    return FollowUpFlowCronService.instance;
  }

  /**
   * Busca histórico de mensagens do lead para contexto da IA
   * Usa o whatsappJid para buscar nas tabelas MyMessages e n8nChatMemory
   */
  private async getMessageHistory(
    whatsappJid: string | null,
    phone: string | null,
    instanceName: string | null,
    limit: number = 20
  ): Promise<{ role: "user" | "assistant"; content: string; timestamp: Date }[]> {
    try {
      if (!whatsappJid && !phone) {
        return [];
      }

      // Normalizar o identificador para busca
      const phoneNormalized = (whatsappJid || phone || "").replace(/\D/g, "").replace(/@.*$/, "");
      if (!phoneNormalized) {
        return [];
      }

      // Buscar mensagens de MyMessages
      const myMessages = await db.myMessages.findMany({
        where: {
          OR: [
            { chatId: { contains: phoneNormalized } },
            { senderId: { contains: phoneNormalized } },
          ],
          ...(instanceName ? { instanceName } : {}),
        },
        orderBy: { timestamp: "desc" },
        take: limit,
        select: {
          message: true,
          direction: true,
          timestamp: true,
        },
      });

      // Buscar também do n8nChatMemory (se existir histórico de chat com IA)
      const chatMemory = await db.n8nChatMemory.findMany({
        where: {
          sessionId: { contains: phoneNormalized },
        },
        orderBy: { id: "desc" },
        take: limit,
        select: {
          message: true,
          direction: true,
          timestamp: true,
        },
      });

      // Combinar e formatar mensagens
      const messages: { role: "user" | "assistant"; content: string; timestamp: Date }[] = [];

      // Adicionar mensagens do MyMessages
      for (const msg of myMessages) {
        if (msg.message && msg.message.trim() && msg.timestamp) {
          messages.push({
            role: msg.direction === "received" ? "user" : "assistant",
            content: msg.message,
            timestamp: msg.timestamp,
          });
        }
      }

      // Adicionar mensagens do n8nChatMemory
      for (const msg of chatMemory) {
        if (msg.message && msg.message.trim()) {
          messages.push({
            role: msg.direction === "input" ? "user" : "assistant",
            content: msg.message,
            timestamp: msg.timestamp || new Date(),
          });
        }
      }

      // Ordenar por timestamp (mais antigo primeiro para contexto cronológico)
      messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

      // Limitar ao número desejado de mensagens
      const limitedMessages = messages.slice(-limit);

      logInfo("Message history retrieved for lead", {
        phone: phoneNormalized,
        totalMessages: limitedMessages.length,
        fromMyMessages: myMessages.length,
        fromChatMemory: chatMemory.length,
      });

      return limitedMessages;
    } catch (error: any) {
      logError("Error getting message history for follow-up context", error);
      return [];
    }
  }

  /**
   * Gera mensagem de follow-up usando OpenAI
   * Inclui histórico de conversas para contexto mais relevante
   * Evita repetição de mensagens anteriores
   */
  private async generateAIMessage(
    agent: {
      systemPrompt: string;
      followUpPrompt: string | null;
      model: string;
      temperature: number;
      maxTokens: number;
      openaiApiKey: string | null;
      credentialId: string | null;
    },
    lead: {
      name: string;
      phone: string | null;
      email: string | null;
      notes: string | null;
      contexto: string | null;
    },
    stepName: string,
    followUpCount: number,
    messageHistory: { role: "user" | "assistant"; content: string; timestamp: Date }[] = [],
    previousFollowUps: string[] = [],
    daysSinceLastContact: number = 0,
    currentStepOrder: number = 0,
    totalSteps: number = 0
  ): Promise<string | null> {
    try {
      // Buscar API Key (do agente ou da credencial)
      let apiKey = agent.openaiApiKey;

      if (!apiKey && agent.credentialId) {
        const credential = await db.credential.findUnique({
          where: { id: agent.credentialId },
          select: { data: true },
        });
        if (credential?.data) {
          const credData = typeof credential.data === "string"
            ? JSON.parse(credential.data)
            : credential.data;
          apiKey = credData.apiKey || credData.openaiApiKey;
        }
      }

      if (!apiKey) {
        logWarn("No OpenAI API key found for follow-up agent");
        return null;
      }

      const openai = new OpenAI({ apiKey });

      // Construir prompt para gerar a mensagem
      const systemMessage = agent.systemPrompt ||
        "Você é um assistente de vendas profissional. Gere mensagens de follow-up personalizadas, amigáveis e que incentivem o cliente a responder.";

      const followUpInstructions = agent.followUpPrompt ||
        "Gere uma mensagem de follow-up curta e direta para o WhatsApp.";

      // Formatar histórico de conversas para contexto
      let conversationContext = "";
      if (messageHistory.length > 0) {
        conversationContext = "\n\n📝 HISTÓRICO DE CONVERSAS ANTERIORES:\n";
        for (const msg of messageHistory) {
          const sender = msg.role === "user" ? "Cliente" : "Atendente";
          conversationContext += `[${sender}]: ${msg.content}\n`;
        }
        conversationContext += "\n---\n";
      }

      // Formatar mensagens de follow-up anteriores para evitar repetição
      let previousFollowUpsContext = "";
      if (previousFollowUps.length > 0) {
        previousFollowUpsContext = "\n\n🚫 MENSAGENS DE FOLLOW-UP JÁ ENVIADAS (NÃO REPITA ESTAS):\n";
        previousFollowUps.forEach((msg, index) => {
          previousFollowUpsContext += `${index + 1}. "${msg}"\n`;
        });
        previousFollowUpsContext += "\n---\n";
      }

      // Determinar tom baseado nos dias sem contato
      let urgencyTone = "";
      if (daysSinceLastContact <= 1) {
        urgencyTone = "Tom: Leve e casual, como uma lembrança amigável.";
      } else if (daysSinceLastContact <= 3) {
        urgencyTone = "Tom: Interessado e prestativo, mostrando que você está disponível.";
      } else if (daysSinceLastContact <= 7) {
        urgencyTone = "Tom: Gentil mas demonstrando interesse genuíno em ajudar.";
      } else {
        urgencyTone = "Tom: Respeitoso e compreensivo, reconhecendo que a pessoa pode estar ocupada.";
      }

      // Determinar abordagem baseada na etapa
      let stepApproach = "";
      if (currentStepOrder === 1) {
        stepApproach = "Abordagem: Primeiro follow-up - seja amigável e relembre brevemente o contexto inicial.";
      } else if (currentStepOrder === 2) {
        stepApproach = "Abordagem: Segundo follow-up - traga um novo ângulo ou benefício que não foi mencionado antes.";
      } else if (currentStepOrder >= 3 && currentStepOrder < totalSteps - 1) {
        stepApproach = "Abordagem: Follow-up intermediário - seja criativo, use uma pergunta diferente ou compartilhe algo de valor.";
      } else {
        stepApproach = "Abordagem: Último follow-up - seja direto mas respeitoso, deixe a porta aberta para contato futuro.";
      }

      const userPrompt = `
Gere uma mensagem de follow-up ÚNICA e PERSONALIZADA para WhatsApp.

📊 CONTEXTO DO LEAD:
- Nome: ${lead.name}
- Etapa atual: ${stepName} (etapa ${currentStepOrder + 1} de ${totalSteps})
- Número de follow-ups anteriores: ${followUpCount}
- Dias desde último contato: ${daysSinceLastContact} dia(s)
${lead.notes ? `- Notas sobre o cliente: ${lead.notes}` : ""}
${lead.contexto ? `\n📌 CONTEXTO IMPORTANTE DO LEAD:\n${lead.contexto}\n` : ""}

🎯 DIRETRIZES DE TOM E ABORDAGEM:
- ${urgencyTone}
- ${stepApproach}
${conversationContext}
${previousFollowUpsContext}

📝 INSTRUÇÕES ESPECÍFICAS DO AGENTE:
${followUpInstructions}

⚠️ REGRAS OBRIGATÓRIAS:
1. A mensagem DEVE ser completamente diferente das anteriores listadas acima
2. Máximo 2-3 frases curtas e diretas
3. NÃO use saudações genéricas como "Olá!", "Oi!", "Bom dia!"
4. Personalize com o nome "${lead.name}" de forma natural
5. ${lead.contexto ? "USE O CONTEXTO DO LEAD para personalizar com base nos interesses específicos" : "Seja relevante e interessante"}
6. ${messageHistory.length > 0 ? "CONSIDERE O HISTÓRICO para dar continuidade sem repetir" : "Crie uma abertura interessante"}
7. Inclua uma pergunta ou call-to-action para incentivar resposta
8. NÃO mencione que é um follow-up automático ou que "não obteve resposta"
9. Seja criativo - use diferentes abordagens: pergunta, curiosidade, benefício, exclusividade
10. ${daysSinceLastContact > 7 ? "Reconheça sutilmente que faz tempo, sem ser invasivo" : "Mantenha a conversa fluindo naturalmente"}

💡 IDEIAS PARA VARIAR (escolha uma abordagem diferente das mensagens anteriores):
- Fazer uma pergunta sobre a necessidade/dor do cliente
- Mencionar um benefício específico não citado antes
- Criar senso de oportunidade ou exclusividade
- Oferecer ajuda de forma genuína
- Compartilhar uma dica ou informação útil relacionada
- Usar curiosidade para engajar

Responda APENAS com a mensagem final, sem explicações ou formatação extra.
`;

      const completion = await openai.chat.completions.create({
        model: agent.model || "gpt-4o-mini",
        messages: [
          { role: "system", content: systemMessage },
          { role: "user", content: userPrompt },
        ],
        temperature: Math.min((agent.temperature || 0.7) + 0.1, 1.0), // Aumenta levemente a criatividade
        max_tokens: agent.maxTokens || 200,
      });

      const message = completion.choices[0]?.message?.content?.trim();

      if (!message) {
        logWarn("OpenAI returned empty message");
        return null;
      }

      logInfo("AI message generated for follow-up", {
        leadName: lead.name,
        messageLength: message.length,
        tokensUsed: completion.usage?.total_tokens,
        hasConversationContext: messageHistory.length > 0,
        contextMessagesCount: messageHistory.length,
        previousFollowUpsCount: previousFollowUps.length,
        daysSinceLastContact,
        currentStepOrder,
        totalSteps,
      });

      return message;
    } catch (error: any) {
      logError("Error generating AI message for follow-up", error);
      return null;
    }
  }

  /**
   * Envia mensagem via Evolution API
   * @param instanceId - ID ou nome da instância Evolution
   * @param phone - Telefone do lead
   * @param message - Mensagem a enviar
   * @param whatsappJid - JID do WhatsApp do lead (se já tem chat aberto)
   */
  private async sendWhatsAppMessage(
    instanceId: string,
    phone: string,
    message: string,
    whatsappJid?: string | null
  ): Promise<{ success: boolean; messageId?: string; error?: string }> {
    try {
      // Buscar instância do Evolution
      const instance = await db.evolutionInstance.findFirst({
        where: {
          OR: [
            { id: instanceId },
            { instanceName: instanceId },
          ],
        },
      });

      if (!instance) {
        return { success: false, error: "Evolution instance not found" };
      }

      // Usar o whatsappJid do lead se disponível (chat já aberto)
      // Senão, formatar o número para WhatsApp
      const formattedPhone = phone.replace(/\D/g, "");
      const remoteJid = whatsappJid
        ? (whatsappJid.includes("@s.whatsapp.net") ? whatsappJid : `${whatsappJid.replace(/\D/g, "")}@s.whatsapp.net`)
        : (formattedPhone.includes("@s.whatsapp.net") ? formattedPhone : `${formattedPhone}@s.whatsapp.net`);

      // Buscar sessionId existente do chat para manter continuidade
      // PRIORIDADE: Busca pelo whatsappJid do lead (chat já aberto)
      let existingSessionId: string | null = null;

      const existingMyMessage = await db.myMessages.findFirst({
        where: {
          OR: [
            { chatId: remoteJid },
            ...(whatsappJid ? [{ chatId: whatsappJid }] : []),
            { chatId: { contains: formattedPhone } },
          ],
          instanceName: instance.instanceName,
        },
        orderBy: { timestamp: "desc" },
        select: { sessionId: true, chatId: true },
      });

      if (existingMyMessage?.sessionId) {
        existingSessionId = existingMyMessage.sessionId;
      } else {
        // Tentar buscar em n8nChatMemory
        const existingChatMemory = await db.n8nChatMemory.findFirst({
          where: {
            OR: [
              { chatId: remoteJid },
              ...(whatsappJid ? [{ chatId: whatsappJid }] : []),
              { chatId: { contains: formattedPhone } },
            ],
            instanceName: instance.instanceName,
          },
          orderBy: { timestamp: "desc" },
          select: { sessionId: true, chatId: true },
        });

        if (existingChatMemory?.sessionId) {
          existingSessionId = existingChatMemory.sessionId;
        }
      }

      // Usar sessionId existente ou criar um novo baseado no chatId
      const sessionId = existingSessionId || `followup-${remoteJid}-${Date.now()}`;

      logInfo("Preparing to send WhatsApp message", {
        hasWhatsappJid: !!whatsappJid,
        whatsappJid,
        remoteJid,
        formattedPhone,
        usedExistingSession: !!existingSessionId,
        sessionId,
      });

      // Enviar via Evolution API
      const evolutionUrl = `${instance.serverUrl}/message/sendText/${instance.instanceName}`;

      const response = await axios.post(
        evolutionUrl,
        {
          number: formattedPhone,
          text: message,
        },
        {
          headers: {
            "Content-Type": "application/json",
            apikey: instance.apiKey,
          },
          timeout: 30000,
        }
      );

      const messageId = response.data?.key?.id || `followup-${Date.now()}`;

      // Salvar mensagem enviada no MyMessages usando o sessionId existente
      await db.myMessages.create({
        data: {
          sessionId: sessionId,
          message: message,
          direction: "sent",
          messageId: messageId,
          instanceName: instance.instanceName,
          chatId: remoteJid,
          senderId: instance.instanceName,
          timestamp: new Date(),
          isAiResponse: true,
        },
      });

      logInfo("WhatsApp message sent via Evolution API", {
        instanceName: instance.instanceName,
        phone: formattedPhone,
        messageId,
        sessionId,
        usedExistingSession: !!existingSessionId,
      });

      return { success: true, messageId };
    } catch (error: any) {
      logError("Error sending WhatsApp message", error);
      return {
        success: false,
        error: error.response?.data?.message || error.message
      };
    }
  }

  /**
   * Verifica se está dentro do horário de trabalho configurado
   */
  private isWithinWorkingHours(agent: {
    workingHoursStart: string | null;
    workingHoursEnd: string | null;
    workingDays: number[];
    timezone: string;
  }): boolean {
    try {
      const now = new Date();

      // Converter para timezone do agente
      const formatter = new Intl.DateTimeFormat("en-US", {
        timeZone: agent.timezone || "America/Sao_Paulo",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        weekday: "short",
      });

      const parts = formatter.formatToParts(now);
      const hourStr = parts.find(p => p.type === "hour")?.value || "00";
      const minuteStr = parts.find(p => p.type === "minute")?.value || "00";
      const currentTime = `${hourStr}:${minuteStr}`;

      // Verificar dia da semana (0=Dom, 1=Seg, ..., 6=Sab)
      const dayOfWeek = now.getDay();
      // Converter para formato do agente (1=Seg, 2=Ter, ..., 7=Dom)
      const agentDayFormat = dayOfWeek === 0 ? 7 : dayOfWeek;

      if (!agent.workingDays.includes(agentDayFormat)) {
        logInfo("Outside working days", { dayOfWeek: agentDayFormat, workingDays: agent.workingDays });
        return false;
      }

      // Verificar horário
      const start = agent.workingHoursStart || "09:00";
      const end = agent.workingHoursEnd || "18:00";

      if (currentTime < start || currentTime > end) {
        logInfo("Outside working hours", { currentTime, start, end });
        return false;
      }

      return true;
    } catch (error) {
      logError("Error checking working hours", error as Error);
      return true; // Em caso de erro, permite o envio
    }
  }

  /**
   * Processa os leads que precisam de follow-up
   */
  async processFollowUpFlow(): Promise<{
    processed: number;
    sent: number;
    moved: number;
    errors: number;
    skipped: number;
  }> {
    if (this.isRunning) {
      logWarn("Follow-up flow cron is already running, skipping...");
      return { processed: 0, sent: 0, moved: 0, errors: 0, skipped: 0 };
    }

    this.isRunning = true;
    const stats = { processed: 0, sent: 0, moved: 0, errors: 0, skipped: 0 };

    try {
      logInfo("Starting follow-up flow processing with AI...");

      // Buscar leads ativos que precisam de follow-up (nextFollowUpAt <= now)
      const leadsToProcess = await db.leadInFollowUpFlow.findMany({
        where: {
          status: "active",
          nextFollowUpAt: {
            lte: new Date(),
          },
        },
        include: {
          lead: true,
          currentStep: true,
          funnel: {
            include: {
              followUpAgent: true,
              configIa: {
                select: {
                  id: true,
                  nome: true,
                },
              },
            },
          },
        },
        take: 50, // Processar em lotes menores para não sobrecarregar
      });

      logInfo(`Found ${leadsToProcess.length} leads to process`);

      for (const leadInFlow of leadsToProcess) {
        stats.processed++;

        try {
          const agent = leadInFlow.funnel.followUpAgent;

          // Verificar se tem agente de follow-up configurado e ativo
          if (!agent || !agent.isActive) {
            logInfo(`Skipping lead ${leadInFlow.lead.name} - no active follow-up agent`);
            stats.skipped++;
            continue;
          }

          // Verificar se a etapa atual é automática
          if (!leadInFlow.currentStep.isAutomatic) {
            logInfo(`Skipping lead ${leadInFlow.lead.name} - step is not automatic`);
            await db.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: { nextFollowUpAt: null },
            });
            stats.skipped++;
            continue;
          }

          // Verificar horário de trabalho
          if (!this.isWithinWorkingHours(agent)) {
            logInfo(`Skipping lead ${leadInFlow.lead.name} - outside working hours`);
            stats.skipped++;
            continue;
          }

          // Verificar se o lead tem WhatsApp
          const leadPhone = leadInFlow.lead.phone || leadInFlow.lead.whatsappJid;
          if (!leadPhone) {
            logWarn(`Lead ${leadInFlow.lead.name} has no phone number`);
            stats.skipped++;
            continue;
          }

          // Verificar limite de follow-ups
          if (leadInFlow.followUpCount >= agent.maxFollowUps) {
            logInfo(`Lead ${leadInFlow.lead.name} reached max follow-ups (${agent.maxFollowUps})`);
            await db.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: {
                nextFollowUpAt: null,
                status: "paused", // Pausar o lead
              },
            });
            stats.skipped++;
            continue;
          }

          // Verificar instância do Evolution
          // PRIORIDADE: Lead > Agente (usa a instância onde o lead já está conversando)
          const evolutionInstanceId = leadInFlow.lead.evolutionInstanceId || agent.evolutionInstanceId;
          if (!evolutionInstanceId) {
            logWarn(`No Evolution instance configured for follow-up`);
            stats.skipped++;
            continue;
          }

          // Buscar instância do Evolution para obter o nome
          const evolutionInstance = await db.evolutionInstance.findFirst({
            where: {
              OR: [
                { id: evolutionInstanceId },
                { instanceName: evolutionInstanceId },
              ],
            },
            select: { instanceName: true },
          });

          logInfo(`Using Evolution instance for lead ${leadInFlow.lead.name}`, {
            instanceId: evolutionInstanceId,
            instanceName: evolutionInstance?.instanceName,
            source: leadInFlow.lead.evolutionInstanceId ? "lead" : "agent",
          });

          // Buscar histórico de mensagens para contexto
          const messageHistory = await this.getMessageHistory(
            leadInFlow.lead.whatsappJid,
            leadInFlow.lead.phone,
            evolutionInstance?.instanceName || null,
            15 // Últimas 15 mensagens para contexto
          );

          // Buscar mensagens de follow-up anteriores para evitar repetição
          const previousFollowUpContacts = await db.followUpFlowContact.findMany({
            where: {
              leadId: leadInFlow.leadId,
              isAutomatic: true,
              status: "sent",
            },
            orderBy: { createdAt: "desc" },
            take: 5, // Últimas 5 mensagens de follow-up
            select: { message: true },
          });
          const previousFollowUps = previousFollowUpContacts.map(c => c.message);

          // Calcular dias desde último contato
          const lastContactDate = leadInFlow.lastFollowUpAt || leadInFlow.enteredAt;
          const daysSinceLastContact = lastContactDate
            ? Math.floor((Date.now() - lastContactDate.getTime()) / (1000 * 60 * 60 * 24))
            : 0;

          // Contar total de etapas do funil para contexto
          const totalSteps = await db.followUpFlowStep.count({
            where: {
              funnelId: leadInFlow.funnelId,
              type: "followup",
            },
          });

          // Gerar mensagem com IA
          let message: string | null = null;

          if (agent.autoFollowUp) {
            // Usar IA para gerar mensagem personalizada com contexto completo
            message = await this.generateAIMessage(
              agent,
              leadInFlow.lead,
              leadInFlow.currentStep.name,
              leadInFlow.followUpCount,
              messageHistory,
              previousFollowUps,
              daysSinceLastContact,
              leadInFlow.currentStep.order,
              totalSteps
            );
          }

          // Se não conseguiu gerar com IA, usar template da etapa
          if (!message) {
            message = leadInFlow.currentStep.messageTemplate;
          }

          if (!message) {
            logWarn(`No message available for lead ${leadInFlow.lead.name}`);
            stats.skipped++;
            continue;
          }

          // Personalizar mensagem com nome do lead
          message = message.replace(/\{nome\}/gi, leadInFlow.lead.name);
          message = message.replace(/\{name\}/gi, leadInFlow.lead.name);

          // Enviar via WhatsApp (usando whatsappJid do lead se disponível - chat já aberto)
          const sendResult = await this.sendWhatsAppMessage(
            evolutionInstanceId,
            leadPhone,
            message,
            leadInFlow.lead.whatsappJid // Passa o JID do chat já aberto
          );

          if (!sendResult.success) {
            logError(`Failed to send message to ${leadInFlow.lead.name}: ${sendResult.error}`);
            stats.errors++;
            continue;
          }

          stats.sent++;

          // Buscar próxima etapa
          const nextStep = await db.followUpFlowStep.findFirst({
            where: {
              funnelId: leadInFlow.funnelId,
              order: { gt: leadInFlow.currentStep.order },
              type: "followup",
            },
            orderBy: { order: "asc" },
          });

          // Calcular próxima data de follow-up
          let nextFollowUpAt: Date | null = null;
          if (nextStep && (nextStep.delayDays > 0 || nextStep.delayHours > 0)) {
            nextFollowUpAt = new Date();
            nextFollowUpAt.setDate(nextFollowUpAt.getDate() + nextStep.delayDays);
            nextFollowUpAt.setHours(nextFollowUpAt.getHours() + nextStep.delayHours);
          }

          // Usar transação para atualizar tudo
          await db.$transaction(async (tx) => {
            // Registrar contato automático
            await tx.followUpFlowContact.create({
              data: {
                leadId: leadInFlow.leadId,
                leadFlowId: leadInFlow.id,
                stepId: leadInFlow.currentStepId,
                contactType: "whatsapp",
                message: message!,
                status: "sent",
                isAutomatic: true,
                notes: `Follow-up automático enviado via IA - Etapa: ${leadInFlow.currentStep.name}`,
              },
            });

            // Registrar no histórico de follow-up
            await tx.followUpHistory.create({
              data: {
                leadId: leadInFlow.leadId,
                agentId: agent.id,
                message: message!,
                status: "sent",
                channel: "whatsapp",
                aiModel: agent.autoFollowUp ? agent.model : null,
                promptUsed: agent.autoFollowUp ? agent.systemPrompt : null,
              },
            });

            // Atualizar lead no fluxo
            const updateData: any = {
              followUpCount: { increment: 1 },
              lastFollowUpAt: new Date(),
            };

            // Se tem próxima etapa, mover para ela
            if (nextStep) {
              updateData.currentStepId = nextStep.id;
              updateData.nextFollowUpAt = nextFollowUpAt;
              stats.moved++;
            } else {
              // Última etapa, sem mais follow-ups
              updateData.nextFollowUpAt = null;
            }

            await tx.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: updateData,
            });

            // Atualizar último contato do lead
            await tx.funnelLead.update({
              where: { id: leadInFlow.leadId },
              data: { lastContactAt: new Date() },
            });
          });

          logInfo(
            `Follow-up sent to "${leadInFlow.lead.name}" - Step: ${leadInFlow.currentStep.name}${nextStep ? ` -> ${nextStep.name}` : " (last step)"}`
          );
        } catch (error: any) {
          stats.errors++;
          logError(`Error processing lead ${leadInFlow.id}`, error);
        }
      }

      logInfo("Follow-up flow processing completed", stats);
      return stats;
    } catch (error: any) {
      logError("Follow-up flow cron failed", error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Processa resposta de um lead e remove do fluxo de follow-up se necessário
   * Chamado quando uma mensagem é recebida de um lead no fluxo
   */
  async handleLeadResponse(
    phone: string,
    instanceName: string
  ): Promise<{ removed: boolean; leadId?: string }> {
    try {
      // Normalizar telefone
      const normalizedPhone = phone.replace(/\D/g, "").replace(/@.*$/, "");

      // Buscar lead pelo telefone ou WhatsApp JID
      const lead = await db.funnelLead.findFirst({
        where: {
          OR: [
            { phone: { contains: normalizedPhone } },
            { whatsappJid: { contains: normalizedPhone } },
          ],
          isInFollowUpFlow: true,
        },
        include: {
          inFollowUpFlow: {
            include: {
              currentStep: true,
            },
          },
        },
      });

      if (!lead || !lead.inFollowUpFlow) {
        return { removed: false };
      }

      // Lead respondeu! Remover do fluxo de follow-up automático
      // Pausar o fluxo (não remove, apenas pausa para acompanhamento manual)
      await db.$transaction(async (tx) => {
        // Atualizar status do lead no fluxo
        await tx.leadInFollowUpFlow.update({
          where: { id: lead.inFollowUpFlow!.id },
          data: {
            status: "paused", // Pausar para acompanhamento manual
            nextFollowUpAt: null, // Cancelar próximo follow-up automático
          },
        });

        // Registrar contato recebido
        await tx.followUpFlowContact.create({
          data: {
            leadId: lead.id,
            leadFlowId: lead.inFollowUpFlow!.id,
            stepId: lead.inFollowUpFlow!.currentStepId,
            contactType: "whatsapp",
            message: "Lead respondeu - fluxo pausado para acompanhamento manual",
            status: "replied",
            isAutomatic: false,
            outcome: "positive",
            notes: "Lead respondeu ao follow-up. Fluxo automático pausado.",
            respondedAt: new Date(),
          },
        });
      });

      logInfo(`Lead "${lead.name}" responded - follow-up flow paused`, {
        leadId: lead.id,
        phone: normalizedPhone,
      });

      // Criar notificação para o usuário
      try {
        const funnel = await db.funnel.findUnique({
          where: { id: lead.funnelId },
          select: { userId: true, name: true },
        });

        if (funnel) {
          await notificationService.notifyLeadExitedFollowUp({
            userId: funnel.userId,
            funnelId: lead.funnelId,
            leadId: lead.id,
            leadName: lead.name,
            leadPhone: lead.phone || undefined,
            stepName: lead.inFollowUpFlow?.currentStep?.name,
            funnelName: funnel.name,
          });
        }
      } catch (notifError) {
        logError("Error creating notification for lead response", notifError as Error);
      }

      return { removed: true, leadId: lead.id };
    } catch (error: any) {
      logError("Error handling lead response", error);
      return { removed: false };
    }
  }

  /**
   * Verifica leads que estão inativos há muito tempo
   */
  async checkStaleLeads(daysThreshold = 7): Promise<number> {
    try {
      const thresholdDate = new Date();
      thresholdDate.setDate(thresholdDate.getDate() - daysThreshold);

      const staleLeads = await db.leadInFollowUpFlow.findMany({
        where: {
          status: "active",
          lastFollowUpAt: {
            lt: thresholdDate,
          },
        },
        select: {
          id: true,
          lead: { select: { name: true } },
          currentStep: { select: { name: true } },
        },
      });

      if (staleLeads.length > 0) {
        logWarn(`Found ${staleLeads.length} stale leads (no contact in ${daysThreshold} days)`);
      }

      return staleLeads.length;
    } catch (error: any) {
      logError("Error checking stale leads", error);
      return 0;
    }
  }

  /**
   * Gera relatório de métricas do fluxo de follow-up
   */
  async getFlowMetrics(): Promise<{
    totalActive: number;
    totalPaused: number;
    totalCompleted: number;
    totalLost: number;
    byStep: { stepName: string; count: number }[];
  }> {
    try {
      const [active, paused, completed, lost] = await Promise.all([
        db.leadInFollowUpFlow.count({ where: { status: "active" } }),
        db.leadInFollowUpFlow.count({ where: { status: "paused" } }),
        db.leadInFollowUpFlow.count({ where: { status: "completed" } }),
        db.leadInFollowUpFlow.count({ where: { status: "lost" } }),
      ]);

      const byStepRaw = await db.leadInFollowUpFlow.groupBy({
        by: ["currentStepId"],
        where: { status: "active" },
        _count: { id: true },
      });

      const stepIds = byStepRaw.map((s) => s.currentStepId);
      const steps = await db.followUpFlowStep.findMany({
        where: { id: { in: stepIds } },
        select: { id: true, name: true },
      });

      const stepMap = new Map(steps.map((s) => [s.id, s.name]));
      const byStep = byStepRaw.map((s) => ({
        stepName: stepMap.get(s.currentStepId) || "Unknown",
        count: s._count.id,
      }));

      return {
        totalActive: active,
        totalPaused: paused,
        totalCompleted: completed,
        totalLost: lost,
        byStep,
      };
    } catch (error: any) {
      logError("Error getting flow metrics", error);
      return {
        totalActive: 0,
        totalPaused: 0,
        totalCompleted: 0,
        totalLost: 0,
        byStep: [],
      };
    }
  }
}

export const followUpFlowCronService = FollowUpFlowCronService.getInstance();
