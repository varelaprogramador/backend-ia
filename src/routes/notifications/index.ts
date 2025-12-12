import { FastifyInstance } from "fastify";
import { db } from "@/lib/db";
import { z } from "zod";

// Schema de validação
const createNotificationSchema = z.object({
  userId: z.string().min(1, "userId obrigatório"),
  funnelId: z.string().optional(),
  leadId: z.string().optional(),
  type: z.enum([
    "LEAD_EXITED_FOLLOWUP",
    "LEAD_MARKED_WON",
    "LEAD_MARKED_LOST",
    "FOLLOWUP_COMPLETED",
    "LEAD_RESPONDED",
    "AGENT_ACTIVATED",
    "AGENT_DEACTIVATED",
    "AGENT_ERROR",
    "WHATSAPP_DISCONNECTED",
    "WHATSAPP_CONNECTED",
    "NEW_LEAD",
    "LEAD_STAGE_CHANGED",
    "SYSTEM_ALERT",
    "SYSTEM_INFO",
  ]),
  title: z.string().min(1, "Título obrigatório"),
  message: z.string().min(1, "Mensagem obrigatória"),
  metadata: z.record(z.any()).optional(),
  actionUrl: z.string().optional(),
  actionLabel: z.string().optional(),
  priority: z
    .enum(["LOW", "MEDIUM", "HIGH", "URGENT"])
    .optional()
    .default("MEDIUM"),
  isHighlighted: z.boolean().optional().default(true),
  highlightDays: z.number().optional().default(3), // Dias de destaque
  playSound: z.boolean().optional().default(true),
});

export default async function (fastify: FastifyInstance) {
  // GET /notifications - Listar notificações do usuário
  fastify.get("/", async (request, reply) => {
    const { userId, unreadOnly, type, limit, offset } = request.query as {
      userId?: string;
      unreadOnly?: string;
      type?: string;
      limit?: string;
      offset?: string;
    };

    if (!userId) {
      return reply.code(400).send({
        success: false,
        message: "userId é obrigatório",
      });
    }

    try {
      const where: any = {
        userId,
        isDismissed: false,
      };

      if (unreadOnly === "true") {
        where.isRead = false;
      }

      if (type) {
        where.type = type;
      }

      const [notifications, total, unreadCount] = await Promise.all([
        db.notification.findMany({
          where,
          orderBy: [
            { isRead: "asc" }, // Não lidas primeiro
            { priority: "desc" }, // Maior prioridade primeiro
            { createdAt: "desc" }, // Mais recentes primeiro
          ],
          take: limit ? parseInt(limit) : 50,
          skip: offset ? parseInt(offset) : 0,
        }),
        db.notification.count({ where }),
        db.notification.count({
          where: {
            userId,
            isRead: false,
            isDismissed: false,
          },
        }),
      ]);

      return reply.code(200).send({
        success: true,
        data: notifications,
        metadata: {
          total,
          unreadCount,
          limit: limit ? parseInt(limit) : 50,
          offset: offset ? parseInt(offset) : 0,
        },
      });
    } catch (error) {
      console.error("Error fetching notifications:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao buscar notificações",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  // GET /notifications/unread-count - Contar notificações não lidas
  fastify.get("/unread-count", async (request, reply) => {
    const { userId } = request.query as { userId?: string };

    if (!userId) {
      return reply.code(400).send({
        success: false,
        message: "userId é obrigatório",
      });
    }

    try {
      const count = await db.notification.count({
        where: {
          userId,
          isRead: false,
          isDismissed: false,
        },
      });

      // Buscar também notificações com som pendente
      const pendingSound = await db.notification.findMany({
        where: {
          userId,
          playSound: true,
          soundPlayed: false,
          isDismissed: false,
        },
        select: { id: true, type: true, priority: true },
      });

      return reply.code(200).send({
        success: true,
        data: {
          count,
          pendingSound: pendingSound.length,
          soundNotifications: pendingSound,
        },
      });
    } catch (error) {
      console.error("Error counting notifications:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao contar notificações",
      });
    }
  });

  // GET /notifications/highlighted - Notificações destacadas (para o funil)
  fastify.get("/highlighted", async (request, reply) => {
    const { userId, funnelId } = request.query as {
      userId?: string;
      funnelId?: string;
    };

    if (!userId) {
      return reply.code(400).send({
        success: false,
        message: "userId é obrigatório",
      });
    }

    try {
      const now = new Date();

      const where: any = {
        userId,
        isHighlighted: true,
        isDismissed: false,
        OR: [{ highlightUntil: null }, { highlightUntil: { gte: now } }],
      };

      if (funnelId) {
        where.funnelId = funnelId;
      }

      const notifications = await db.notification.findMany({
        where,
        orderBy: { createdAt: "desc" },
      });

      // Extrair leadIds das notificações destacadas
      const highlightedLeadIds = notifications
        .filter((n) => n.leadId)
        .map((n) => n.leadId as string);

      return reply.code(200).send({
        success: true,
        data: {
          notifications,
          highlightedLeadIds,
        },
      });
    } catch (error) {
      console.error("Error fetching highlighted notifications:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao buscar notificações destacadas",
      });
    }
  });

  // POST /notifications - Criar notificação
  fastify.post("/", async (request, reply) => {
    try {
      const body = createNotificationSchema.parse(request.body);

      // Calcular highlightUntil (padrão 3 dias)
      const highlightUntil = new Date();
      highlightUntil.setDate(
        highlightUntil.getDate() + (body.highlightDays || 3)
      );

      const notification = await db.notification.create({
        data: {
          userId: body.userId,
          funnelId: body.funnelId,
          leadId: body.leadId,
          type: body.type,
          title: body.title,
          message: body.message,
          metadata: body.metadata,
          actionUrl: body.actionUrl,
          actionLabel: body.actionLabel,
          priority: body.priority,
          isHighlighted: body.isHighlighted,
          highlightUntil,
          playSound: body.playSound,
        },
      });

      return reply.code(201).send({
        success: true,
        data: notification,
      });
    } catch (error) {
      if (error instanceof z.ZodError) {
        return reply.code(400).send({
          success: false,
          message: "Dados inválidos",
          errors: error.errors,
        });
      }
      console.error("Error creating notification:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao criar notificação",
      });
    }
  });

  // PATCH /notifications/:id/read - Marcar como lida
  fastify.patch("/:id/read", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const notification = await db.notification.update({
        where: { id },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return reply.code(200).send({
        success: true,
        data: notification,
      });
    } catch (error) {
      console.error("Error marking notification as read:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao marcar notificação como lida",
      });
    }
  });

  // PATCH /notifications/read-all - Marcar todas como lidas
  fastify.patch("/read-all", async (request, reply) => {
    const { userId } = request.body as { userId: string };

    if (!userId) {
      return reply.code(400).send({
        success: false,
        message: "userId é obrigatório",
      });
    }

    try {
      await db.notification.updateMany({
        where: {
          userId,
          isRead: false,
        },
        data: {
          isRead: true,
          readAt: new Date(),
        },
      });

      return reply.code(200).send({
        success: true,
        message: "Todas notificações marcadas como lidas",
      });
    } catch (error) {
      console.error("Error marking all notifications as read:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao marcar notificações como lidas",
      });
    }
  });

  // PATCH /notifications/:id/sound-played - Marcar som como tocado
  fastify.patch("/:id/sound-played", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const notification = await db.notification.update({
        where: { id },
        data: {
          soundPlayed: true,
        },
      });

      return reply.code(200).send({
        success: true,
        data: notification,
      });
    } catch (error) {
      console.error("Error marking sound as played:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao marcar som como tocado",
      });
    }
  });

  // PATCH /notifications/:id/dismiss - Dispensar notificação
  fastify.patch("/:id/dismiss", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      const notification = await db.notification.update({
        where: { id },
        data: {
          isDismissed: true,
          dismissedAt: new Date(),
        },
      });

      return reply.code(200).send({
        success: true,
        data: notification,
      });
    } catch (error) {
      console.error("Error dismissing notification:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao dispensar notificação",
      });
    }
  });

  // DELETE /notifications/:id - Deletar notificação
  fastify.delete("/:id", async (request, reply) => {
    const { id } = request.params as { id: string };

    try {
      await db.notification.delete({
        where: { id },
      });

      return reply.code(200).send({
        success: true,
        message: "Notificação deletada",
      });
    } catch (error) {
      console.error("Error deleting notification:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao deletar notificação",
      });
    }
  });

  // DELETE /notifications/expired - Limpar notificações expiradas
  fastify.delete("/expired", async (request, reply) => {
    try {
      const now = new Date();

      // Deletar notificações:
      // 1. Expiradas
      // 2. Lidas há mais de 30 dias
      // 3. Dispensadas há mais de 7 dias
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const sevenDaysAgo = new Date();
      sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

      const result = await db.notification.deleteMany({
        where: {
          OR: [
            { expiresAt: { lt: now } },
            { readAt: { lt: thirtyDaysAgo } },
            { dismissedAt: { lt: sevenDaysAgo } },
          ],
        },
      });

      return reply.code(200).send({
        success: true,
        message: `${result.count} notificações expiradas removidas`,
      });
    } catch (error) {
      console.error("Error cleaning expired notifications:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao limpar notificações expiradas",
      });
    }
  });
}
