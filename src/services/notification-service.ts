import { db } from "../lib/db";
import type { Server as SocketServer } from "socket.io";

// Tipos de notificação
type NotificationType =
  | "LEAD_EXITED_FOLLOWUP"
  | "LEAD_MARKED_WON"
  | "LEAD_MARKED_LOST"
  | "FOLLOWUP_COMPLETED"
  | "LEAD_RESPONDED"
  | "AGENT_ACTIVATED"
  | "AGENT_DEACTIVATED"
  | "AGENT_ERROR"
  | "WHATSAPP_DISCONNECTED"
  | "WHATSAPP_CONNECTED"
  | "NEW_LEAD"
  | "LEAD_STAGE_CHANGED"
  | "SYSTEM_ALERT"
  | "SYSTEM_INFO";

type NotificationPriority = "LOW" | "MEDIUM" | "HIGH" | "URGENT";

interface CreateNotificationParams {
  userId: string;
  funnelId?: string;
  leadId?: string;
  type: NotificationType;
  title: string;
  message: string;
  metadata?: Record<string, any>;
  actionUrl?: string;
  actionLabel?: string;
  priority?: NotificationPriority;
  isHighlighted?: boolean;
  highlightDays?: number;
  playSound?: boolean;
}

class NotificationService {
  private io: SocketServer | null = null;

  /**
   * Define a instância do Socket.IO para emitir eventos em tempo real
   */
  setSocketIO(io: SocketServer) {
    this.io = io;
    console.log("📡 NotificationService conectado ao Socket.IO");
  }

  /**
   * Emite notificação em tempo real para o usuário via Socket.IO
   */
  private emitToUser(userId: string, notification: any) {
    if (this.io) {
      // Emitir para a sala específica do usuário
      const roomName = `user:${userId}`;
      this.io.to(roomName).emit("notification:new", notification);
      console.log(`📡 Notificação emitida para sala ${roomName}`);
    }
  }

  /**
   * Cria uma notificação genérica
   */
  async createNotification(params: CreateNotificationParams) {
    const {
      userId,
      funnelId,
      leadId,
      type,
      title,
      message,
      metadata,
      actionUrl,
      actionLabel,
      priority = "MEDIUM",
      isHighlighted = true,
      highlightDays = 3,
      playSound = true,
    } = params;

    // Calcular data de destaque
    const highlightUntil = new Date();
    highlightUntil.setDate(highlightUntil.getDate() + highlightDays);

    try {
      const notification = await db.notification.create({
        data: {
          userId,
          funnelId,
          leadId,
          type,
          title,
          message,
          metadata,
          actionUrl,
          actionLabel,
          priority,
          isHighlighted,
          highlightUntil,
          playSound,
        },
      });

      console.log(`📣 Notificação criada: [${type}] ${title}`);

      // Emitir em tempo real via Socket.IO
      this.emitToUser(userId, notification);

      return notification;
    } catch (error) {
      console.error("Erro ao criar notificação:", error);
      throw error;
    }
  }

  /**
   * Notifica quando um lead sai do fluxo de follow-up (respondeu)
   */
  async notifyLeadExitedFollowUp(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    leadPhone?: string;
    stepName?: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, leadPhone, stepName, funnelName } = params;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "LEAD_EXITED_FOLLOWUP",
      title: "🔔 Lead respondeu ao Follow-up!",
      message: `${leadName} respondeu e saiu do fluxo automático. Precisa de atendimento humano!`,
      metadata: {
        leadName,
        leadPhone,
        stepName,
        funnelName,
        exitedAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver no Funil",
      priority: "HIGH",
      isHighlighted: true,
      highlightDays: 3,
      playSound: true,
    });
  }

  /**
   * Notifica quando um lead responde a uma mensagem
   */
  async notifyLeadResponded(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    messagePreview?: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, messagePreview, funnelName } = params;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "LEAD_RESPONDED",
      title: "💬 Nova resposta de lead!",
      message: `${leadName} respondeu: "${messagePreview?.substring(0, 50) || "..."}"`,
      metadata: {
        leadName,
        messagePreview,
        funnelName,
        respondedAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Responder",
      priority: "HIGH",
      isHighlighted: true,
      highlightDays: 2,
      playSound: true,
    });
  }

  /**
   * Notifica quando um lead é marcado como ganho
   */
  async notifyLeadMarkedWon(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    value?: number;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, value, funnelName } = params;

    const valueText = value ? ` - R$ ${value.toLocaleString("pt-BR")}` : "";

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "LEAD_MARKED_WON",
      title: "🎉 Lead convertido!",
      message: `${leadName} foi marcado como GANHO${valueText}`,
      metadata: {
        leadName,
        value,
        funnelName,
        wonAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver Detalhes",
      priority: "MEDIUM",
      isHighlighted: true,
      highlightDays: 2,
      playSound: true,
    });
  }

  /**
   * Notifica quando um lead é marcado como perdido
   */
  async notifyLeadMarkedLost(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    reason?: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, reason, funnelName } = params;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "LEAD_MARKED_LOST",
      title: "❌ Lead perdido",
      message: `${leadName} foi marcado como perdido${reason ? `: ${reason}` : ""}`,
      metadata: {
        leadName,
        reason,
        funnelName,
        lostAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver Detalhes",
      priority: "LOW",
      isHighlighted: false,
      highlightDays: 1,
      playSound: false,
    });
  }

  /**
   * Notifica quando um novo lead entra no funil
   */
  async notifyNewLead(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    source?: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, source, funnelName } = params;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "NEW_LEAD",
      title: "🆕 Novo lead!",
      message: `${leadName} entrou no funil${source ? ` via ${source}` : ""}`,
      metadata: {
        leadName,
        source,
        funnelName,
        enteredAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver Lead",
      priority: "MEDIUM",
      isHighlighted: true,
      highlightDays: 1,
      playSound: true,
    });
  }

  /**
   * Notifica quando um lead é adicionado ao fluxo de follow-up
   */
  async notifyLeadAddedToFollowUp(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    flowName?: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, flowName, funnelName } = params;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "FOLLOWUP_COMPLETED",
      title: "🚀 Lead adicionado ao Follow-up!",
      message: `${leadName} foi adicionado ao fluxo${flowName ? ` "${flowName}"` : ""}`,
      metadata: {
        leadName,
        flowName,
        funnelName,
        addedAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver Lead",
      priority: "MEDIUM",
      isHighlighted: true,
      highlightDays: 1,
      playSound: true,
    });
  }

  /**
   * Notifica quando um lead muda de estágio no funil
   */
  async notifyLeadStageChanged(params: {
    userId: string;
    funnelId: string;
    leadId: string;
    leadName: string;
    fromStageName?: string;
    toStageName: string;
    funnelName?: string;
  }) {
    const { userId, funnelId, leadId, leadName, fromStageName, toStageName, funnelName } = params;

    const moveText = fromStageName
      ? `movido de "${fromStageName}" para "${toStageName}"`
      : `movido para "${toStageName}"`;

    return this.createNotification({
      userId,
      funnelId,
      leadId,
      type: "LEAD_STAGE_CHANGED",
      title: "📋 Lead mudou de estágio",
      message: `${leadName} foi ${moveText}`,
      metadata: {
        leadName,
        fromStageName,
        toStageName,
        funnelName,
        changedAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}`,
      actionLabel: "Ver Lead",
      priority: "LOW",
      isHighlighted: false,
      highlightDays: 1,
      playSound: false,
    });
  }

  /**
   * Notifica erro no agente
   */
  async notifyAgentError(params: {
    userId: string;
    funnelId: string;
    agentName: string;
    errorMessage: string;
  }) {
    const { userId, funnelId, agentName, errorMessage } = params;

    return this.createNotification({
      userId,
      funnelId,
      type: "AGENT_ERROR",
      title: "⚠️ Erro no Agente",
      message: `${agentName}: ${errorMessage.substring(0, 100)}`,
      metadata: {
        agentName,
        errorMessage,
        errorAt: new Date().toISOString(),
      },
      actionUrl: `/funil/${funnelId}/follow-up`,
      actionLabel: "Ver Configuração",
      priority: "URGENT",
      isHighlighted: true,
      highlightDays: 1,
      playSound: true,
    });
  }

  /**
   * Notifica WhatsApp desconectado
   */
  async notifyWhatsAppDisconnected(params: {
    userId: string;
    instanceName: string;
    funnelId?: string;
  }) {
    const { userId, instanceName, funnelId } = params;

    return this.createNotification({
      userId,
      funnelId,
      type: "WHATSAPP_DISCONNECTED",
      title: "📵 WhatsApp Desconectado",
      message: `A instância "${instanceName}" perdeu a conexão. Reconecte para continuar enviando mensagens.`,
      metadata: {
        instanceName,
        disconnectedAt: new Date().toISOString(),
      },
      actionUrl: "/instances",
      actionLabel: "Reconectar",
      priority: "URGENT",
      isHighlighted: true,
      highlightDays: 1,
      playSound: true,
    });
  }

  /**
   * Buscar IDs de leads destacados para um funil
   */
  async getHighlightedLeadIds(userId: string, funnelId?: string): Promise<string[]> {
    const now = new Date();

    const where: any = {
      userId,
      isHighlighted: true,
      isDismissed: false,
      leadId: { not: null },
      OR: [
        { highlightUntil: null },
        { highlightUntil: { gte: now } },
      ],
    };

    if (funnelId) {
      where.funnelId = funnelId;
    }

    const notifications = await db.notification.findMany({
      where,
      select: { leadId: true },
    });

    return notifications
      .filter((n) => n.leadId)
      .map((n) => n.leadId as string);
  }

  /**
   * Remover destaque de um lead específico
   */
  async removeLeadHighlight(leadId: string) {
    await db.notification.updateMany({
      where: { leadId },
      data: {
        isHighlighted: false,
      },
    });
  }
}

// Exportar instância singleton
export const notificationService = new NotificationService();
