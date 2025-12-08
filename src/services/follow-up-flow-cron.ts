import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";

/**
 * Serviço de automação do fluxo de follow-up
 *
 * Este serviço é responsável por:
 * 1. Verificar leads que precisam avançar de etapa (baseado em nextFollowUpAt)
 * 2. Mover leads automaticamente para próxima etapa
 * 3. Registrar contatos automáticos
 * 4. Calcular próxima data de follow-up
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
   * Processa os leads que precisam avançar de etapa
   */
  async processFollowUpFlow(): Promise<{
    processed: number;
    moved: number;
    errors: number;
  }> {
    if (this.isRunning) {
      logWarn("Follow-up flow cron is already running, skipping...");
      return { processed: 0, moved: 0, errors: 0 };
    }

    this.isRunning = true;
    const stats = { processed: 0, moved: 0, errors: 0 };

    try {
      logInfo("Starting follow-up flow processing...");

      // Buscar leads ativos que precisam avançar (nextFollowUpAt <= now)
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
            },
          },
        },
        take: 100, // Processar em lotes de 100
      });

      logInfo(`Found ${leadsToProcess.length} leads to process`);

      for (const leadInFlow of leadsToProcess) {
        stats.processed++;

        try {
          // Verificar se a etapa atual é automática
          if (!leadInFlow.currentStep.isAutomatic) {
            // Etapa não é automática, apenas atualizar nextFollowUpAt para null
            await db.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: { nextFollowUpAt: null },
            });
            continue;
          }

          // Buscar próxima etapa do tipo followup
          const nextStep = await db.followUpFlowStep.findFirst({
            where: {
              funnelId: leadInFlow.funnelId,
              order: { gt: leadInFlow.currentStep.order },
              type: "followup",
            },
            orderBy: { order: "asc" },
          });

          if (!nextStep) {
            // Não há próxima etapa, manter na etapa atual
            await db.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: { nextFollowUpAt: null },
            });
            logInfo(`Lead ${leadInFlow.lead.name} reached last follow-up step`);
            continue;
          }

          // Calcular próxima data de follow-up
          const nextFollowUpAt = new Date();
          nextFollowUpAt.setDate(nextFollowUpAt.getDate() + nextStep.delayDays);
          nextFollowUpAt.setHours(nextFollowUpAt.getHours() + nextStep.delayHours);

          // Usar transação para mover lead e registrar contato
          await db.$transaction(async (tx) => {
            // Registrar contato automático
            await tx.followUpFlowContact.create({
              data: {
                leadId: leadInFlow.leadId,
                leadFlowId: leadInFlow.id,
                stepId: leadInFlow.currentStepId,
                contactType: "message",
                message: leadInFlow.currentStep.messageTemplate || "Follow-up automático",
                status: "sent",
                isAutomatic: true,
                notes: `Movido automaticamente de "${leadInFlow.currentStep.name}" para "${nextStep.name}"`,
              },
            });

            // Mover para próxima etapa
            await tx.leadInFollowUpFlow.update({
              where: { id: leadInFlow.id },
              data: {
                currentStepId: nextStep.id,
                nextFollowUpAt: nextStep.delayDays > 0 || nextStep.delayHours > 0
                  ? nextFollowUpAt
                  : null,
                followUpCount: { increment: 1 },
                lastFollowUpAt: new Date(),
              },
            });

            // Atualizar último contato do lead
            await tx.funnelLead.update({
              where: { id: leadInFlow.leadId },
              data: { lastContactAt: new Date() },
            });
          });

          stats.moved++;
          logInfo(
            `Lead "${leadInFlow.lead.name}" moved from "${leadInFlow.currentStep.name}" to "${nextStep.name}"`
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
   * Verifica leads que estão inativos há muito tempo e sugere ação
   * (pode ser usado para notificações ou alertas)
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

      // Contagem por etapa
      const byStepRaw = await db.leadInFollowUpFlow.groupBy({
        by: ["currentStepId"],
        where: { status: "active" },
        _count: { id: true },
      });

      // Buscar nomes das etapas
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
