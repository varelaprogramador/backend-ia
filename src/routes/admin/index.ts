import type { FastifyInstance } from "fastify";
import { StatusCodes } from "http-status-codes";
import { followUpFlowCronService } from "@/services/follow-up-flow-cron";
import { rdstationTokenRefreshCronService } from "@/services/rdstation-token-refresh-cron";
import { logInfo, logError } from "@/utils/logger";

/**
 * Rotas administrativas para testes e monitoramento
 * Usar com cuidado em produção
 */
export default async function (fastify: FastifyInstance) {
  /**
   * Verificar status dos cron jobs
   */
  fastify.get("/cron/status", async (_req, reply) => {
    try {
      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          cronJobs: {
            followUpFlow: {
              name: "Follow-up Flow Automation",
              schedule: "*/5 * * * *", // A cada 5 minutos
              description: "Processa leads que precisam avançar de etapa automaticamente",
            },
            rdstationTokenRefresh: {
              name: "RD Station Token Refresh",
              schedule: "0 * * * *", // A cada hora
              description: "Renova tokens do RD Station CRM (access_token expira em 2h)",
            },
            userSync: {
              name: "User Sync",
              schedule: "0 */15 * * * *", // A cada 15 minutos
              description: "Sincroniza usuários com cache",
            },
          },
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error getting cron status", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao obter status dos cron jobs",
      });
    }
  });

  /**
   * Executar cron job do Follow-up Flow manualmente
   */
  fastify.post("/cron/follow-up-flow/run", async (_req, reply) => {
    try {
      logInfo("Manual execution of follow-up flow cron requested");

      const startTime = Date.now();
      const result = await followUpFlowCronService.processFollowUpFlow();
      const duration = Date.now() - startTime;

      logInfo("Manual follow-up flow cron execution completed", {
        ...result,
        durationMs: duration,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "Follow-up flow cron executado com sucesso",
        data: {
          ...result,
          durationMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error running follow-up flow cron manually", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao executar follow-up flow cron",
        details: error.message,
      });
    }
  });

  /**
   * Obter métricas do Follow-up Flow
   */
  fastify.get("/cron/follow-up-flow/metrics", async (_req, reply) => {
    try {
      const metrics = await followUpFlowCronService.getFlowMetrics();

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          metrics,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error getting follow-up flow metrics", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao obter métricas do follow-up flow",
      });
    }
  });

  /**
   * Verificar leads inativos
   */
  fastify.get<{
    Querystring: { days?: string };
  }>("/cron/follow-up-flow/stale-leads", async (req, reply) => {
    try {
      const daysThreshold = parseInt(req.query.days || "7");
      const staleCount = await followUpFlowCronService.checkStaleLeads(daysThreshold);

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          staleLeadsCount: staleCount,
          daysThreshold,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error checking stale leads", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao verificar leads inativos",
      });
    }
  });

  /**
   * Executar cron job do RD Station Token Refresh manualmente
   */
  fastify.post("/cron/rdstation-token-refresh/run", async (_req, reply) => {
    try {
      logInfo("Manual execution of RD Station token refresh cron requested");

      const startTime = Date.now();
      const result = await rdstationTokenRefreshCronService.processTokenRefresh();
      const duration = Date.now() - startTime;

      logInfo("Manual RD Station token refresh cron execution completed", {
        ...result,
        durationMs: duration,
      });

      return reply.code(StatusCodes.OK).send({
        success: true,
        message: "RD Station token refresh cron executado com sucesso",
        data: {
          ...result,
          durationMs: duration,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error running RD Station token refresh cron manually", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao executar RD Station token refresh cron",
        details: error.message,
      });
    }
  });

  /**
   * Verificar status de conexão do RD Station para todos os agentes
   */
  fastify.get("/cron/rdstation-token-refresh/connection-status", async (_req, reply) => {
    try {
      const status = await rdstationTokenRefreshCronService.checkConnectionStatus();

      return reply.code(StatusCodes.OK).send({
        success: true,
        data: {
          status,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error checking RD Station connection status", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao verificar status de conexão do RD Station",
      });
    }
  });

  /**
   * Executar todos os cron jobs manualmente (útil para testes)
   */
  fastify.post("/cron/run-all", async (_req, reply) => {
    try {
      logInfo("Manual execution of all cron jobs requested");

      const results = {
        followUpFlow: { success: false, error: null as string | null, data: null as any },
        rdstationTokenRefresh: { success: false, error: null as string | null, data: null as any },
      };

      // Executar follow-up flow
      try {
        const followUpResult = await followUpFlowCronService.processFollowUpFlow();
        results.followUpFlow = { success: true, error: null, data: followUpResult };
      } catch (error: any) {
        results.followUpFlow = { success: false, error: error.message, data: null };
      }

      // Executar RD Station token refresh
      try {
        const rdResult = await rdstationTokenRefreshCronService.processTokenRefresh();
        results.rdstationTokenRefresh = { success: true, error: null, data: rdResult };
      } catch (error: any) {
        results.rdstationTokenRefresh = { success: false, error: error.message, data: null };
      }

      const allSuccess = results.followUpFlow.success && results.rdstationTokenRefresh.success;

      logInfo("Manual execution of all cron jobs completed", { results });

      return reply.code(allSuccess ? StatusCodes.OK : StatusCodes.PARTIAL_CONTENT).send({
        success: allSuccess,
        message: allSuccess ? "Todos os cron jobs executados com sucesso" : "Alguns cron jobs falharam",
        data: {
          results,
          timestamp: new Date().toISOString(),
        },
      });
    } catch (error: any) {
      logError("Error running all cron jobs manually", error);
      return reply.code(StatusCodes.INTERNAL_SERVER_ERROR).send({
        success: false,
        error: "Erro ao executar cron jobs",
        details: error.message,
      });
    }
  });
}
