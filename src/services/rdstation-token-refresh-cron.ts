import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";

/**
 * Serviço de renovação automática de tokens do RD Station CRM
 *
 * O access_token do RD Station CRM tem validade de 2 horas.
 * O refresh_token expira se não for usado em 14 dias.
 *
 * Este serviço roda periodicamente para:
 * 1. Identificar tokens que estão próximos de expirar ou já expiraram
 * 2. Renovar usando o refresh_token
 * 3. Atualizar os tokens no banco de dados
 *
 * Documentação: https://developers.rdstation.com/reference/crm-v2-authentication-step-4
 */

const RDSTATION_TOKEN_URL = "https://api.rd.services/oauth2/token";
const RDSTATION_CRM_API_URL = "https://api.rd.services/crm/v2";

export class RDStationTokenRefreshCronService {
  private static instance: RDStationTokenRefreshCronService;
  private isRunning = false;

  private constructor() {}

  static getInstance(): RDStationTokenRefreshCronService {
    if (!RDStationTokenRefreshCronService.instance) {
      RDStationTokenRefreshCronService.instance = new RDStationTokenRefreshCronService();
    }
    return RDStationTokenRefreshCronService.instance;
  }

  /**
   * Verifica se um token é válido fazendo uma requisição leve
   */
  private async isTokenValid(accessToken: string): Promise<boolean> {
    try {
      await axios.get(`${RDSTATION_CRM_API_URL}/users`, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
        timeout: 10000,
      });
      return true;
    } catch (error: any) {
      if (error.response?.status === 401) {
        return false;
      }
      // Outros erros (timeout, network) não significam que o token é inválido
      logWarn("Error checking token validity, assuming valid", {
        error: error.message,
      });
      return true;
    }
  }

  /**
   * Renova o token de uma ConfigIA específica
   */
  private async refreshTokenForConfig(configIA: {
    id: string;
    nome: string;
    rdstationClientId: string;
    rdstationClientSecret: string;
    rdstationRefreshToken: string;
  }): Promise<boolean> {
    try {
      logInfo("Refreshing RD Station token", {
        configIAId: configIA.id,
        agentName: configIA.nome,
      });

      const tokenResponse = await axios.post(
        RDSTATION_TOKEN_URL,
        new URLSearchParams({
          client_id: configIA.rdstationClientId,
          client_secret: configIA.rdstationClientSecret,
          refresh_token: configIA.rdstationRefreshToken,
          grant_type: "refresh_token",
        }).toString(),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded",
          },
          timeout: 15000,
        }
      );

      const { access_token, refresh_token } = tokenResponse.data;

      if (!access_token) {
        throw new Error("No access_token received from RD Station");
      }

      // Atualizar tokens no banco
      await db.configIA.update({
        where: { id: configIA.id },
        data: {
          rdstationAccessToken: access_token,
          // Atualizar refresh_token se um novo foi retornado
          rdstationRefreshToken: refresh_token || configIA.rdstationRefreshToken,
        },
      });

      logInfo("RD Station token refreshed successfully", {
        configIAId: configIA.id,
        agentName: configIA.nome,
        hasNewRefreshToken: !!refresh_token,
      });

      return true;
    } catch (error: any) {
      logError("Failed to refresh RD Station token", {
        configIAId: configIA.id,
        agentName: configIA.nome,
        error: error.message,
        response: error.response?.data,
      });

      // Se o refresh_token expirou (401), limpar os tokens para forçar nova autorização
      if (error.response?.status === 401 || error.response?.status === 400) {
        logWarn("Refresh token expired or invalid, clearing tokens", {
          configIAId: configIA.id,
        });

        await db.configIA.update({
          where: { id: configIA.id },
          data: {
            rdstationAccessToken: null,
            rdstationRefreshToken: null,
          },
        });
      }

      return false;
    }
  }

  /**
   * Processa todas as ConfigIAs que têm tokens do RD Station
   */
  async processTokenRefresh(): Promise<{
    processed: number;
    refreshed: number;
    errors: number;
    skipped: number;
  }> {
    if (this.isRunning) {
      logWarn("RD Station token refresh cron is already running, skipping...");
      return { processed: 0, refreshed: 0, errors: 0, skipped: 0 };
    }

    this.isRunning = true;
    const stats = { processed: 0, refreshed: 0, errors: 0, skipped: 0 };

    try {
      logInfo("Starting RD Station token refresh processing...");

      // Buscar todas as ConfigIAs que têm tokens do RD Station
      const configsWithTokens = await db.configIA.findMany({
        where: {
          rdstationAccessToken: { not: null },
          rdstationRefreshToken: { not: null },
          rdstationClientId: { not: null },
          rdstationClientSecret: { not: null },
        },
        select: {
          id: true,
          nome: true,
          rdstationClientId: true,
          rdstationClientSecret: true,
          rdstationAccessToken: true,
          rdstationRefreshToken: true,
        },
      });

      logInfo(`Found ${configsWithTokens.length} configs with RD Station tokens`);

      for (const config of configsWithTokens) {
        stats.processed++;

        try {
          // Verificar se o token atual ainda é válido
          const isValid = await this.isTokenValid(config.rdstationAccessToken!);

          if (isValid) {
            // Token ainda válido, mas vamos renovar proativamente para manter ativo
            // O access_token tem validade de 2 horas, então renovamos em cada execução do cron
            const success = await this.refreshTokenForConfig({
              id: config.id,
              nome: config.nome,
              rdstationClientId: config.rdstationClientId!,
              rdstationClientSecret: config.rdstationClientSecret!,
              rdstationRefreshToken: config.rdstationRefreshToken!,
            });

            if (success) {
              stats.refreshed++;
            } else {
              stats.errors++;
            }
          } else {
            // Token expirado, tentar renovar
            const success = await this.refreshTokenForConfig({
              id: config.id,
              nome: config.nome,
              rdstationClientId: config.rdstationClientId!,
              rdstationClientSecret: config.rdstationClientSecret!,
              rdstationRefreshToken: config.rdstationRefreshToken!,
            });

            if (success) {
              stats.refreshed++;
            } else {
              stats.errors++;
            }
          }
        } catch (error: any) {
          stats.errors++;
          logError(`Error processing token refresh for config ${config.id}`, error);
        }

        // Pequeno delay entre requisições para evitar rate limiting
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      logInfo("RD Station token refresh processing completed", stats);
      return stats;
    } catch (error: any) {
      logError("RD Station token refresh cron failed", error);
      throw error;
    } finally {
      this.isRunning = false;
    }
  }

  /**
   * Verifica o status de conexão de todas as integrações RD Station
   */
  async checkConnectionStatus(): Promise<{
    total: number;
    connected: number;
    expired: number;
    needsReauth: number;
  }> {
    const status = { total: 0, connected: 0, expired: 0, needsReauth: 0 };

    try {
      // Buscar todas as ConfigIAs com credenciais do RD Station
      const configs = await db.configIA.findMany({
        where: {
          rdstationClientId: { not: null },
          rdstationClientSecret: { not: null },
        },
        select: {
          id: true,
          nome: true,
          rdstationAccessToken: true,
          rdstationRefreshToken: true,
        },
      });

      status.total = configs.length;

      for (const config of configs) {
        if (!config.rdstationAccessToken) {
          status.needsReauth++;
          continue;
        }

        const isValid = await this.isTokenValid(config.rdstationAccessToken);

        if (isValid) {
          status.connected++;
        } else if (config.rdstationRefreshToken) {
          status.expired++;
        } else {
          status.needsReauth++;
        }

        // Delay entre verificações
        await new Promise((resolve) => setTimeout(resolve, 300));
      }

      logInfo("RD Station connection status check completed", status);
      return status;
    } catch (error: any) {
      logError("Error checking RD Station connection status", error);
      return status;
    }
  }
}

export const rdstationTokenRefreshCronService = RDStationTokenRefreshCronService.getInstance();
