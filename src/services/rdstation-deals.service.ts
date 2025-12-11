import axios from "axios";
import { db } from "@/lib/db";
import { logError, logInfo, logWarn } from "@/utils/logger";

// ========================================
// RD STATION CRM DEALS SERVICE
// ========================================

/**
 * Servico para sincronizar deals do RD Station CRM
 * Documentacao: https://developers.rdstation.com/reference/crm-v2-deals
 */

const RDSTATION_CRM_API_URL = "https://api.rd.services/crm/v2";

interface DealCreateInput {
  name: string;
  status: "ongoing" | "won" | "lost"; // Status obrigatório
  pipeline_id: string; // ID do funil de vendas (obrigatório)
  stage_id: string; // ID da etapa do funil de vendas (obrigatório)
  owner_id: string; // ID do usuário responsável (obrigatório)
  rating?: number; // 1-5 (qualificação da negociação)
  expected_close_date?: string | null; // Data de previsão de fechamento (YYYY-MM-DD)
  recurrence_price?: number; // Valor recorrente
  one_time_price?: number; // Valor único
  organization_id?: string; // ID da empresa associada
  source_id?: string; // ID da fonte da negociação
  contact_ids?: string[]; // IDs dos contatos associados
  custom_fields?: Record<string, any>;
}

interface DealUpdateInput {
  name?: string;
  stage_id?: string;
  pipeline_id?: string; // Obrigatório para atualização
  owner_id?: string; // Obrigatório para atualização
  rating?: number;
  expected_close_date?: string | null;
  status?: "won" | "lost" | "ongoing" | "paused";
  recurrence_price?: number;
  one_time_price?: number;
  lost_reason_id?: string; // ID do motivo de perda
  custom_fields?: Record<string, any>;
}

interface DealResponse {
  id: string;
  name: string;
  total_price?: number;
  stage_id: string;
  pipeline_id: string;
  status?: string;
  expected_close_date?: string | null;
  created_at?: string;
  updated_at?: string;
}

export class RDStationDealsService {
  private static instance: RDStationDealsService;

  private constructor() {}

  public static getInstance(): RDStationDealsService {
    if (!RDStationDealsService.instance) {
      RDStationDealsService.instance = new RDStationDealsService();
    }
    return RDStationDealsService.instance;
  }

  /**
   * Obtem o access token e configuracao RD Station para um funil
   */
  private async getFunnelRdStationConfig(funnelId: string): Promise<{
    accessToken: string;
    pipelineId: string;
    configIaId: string;
    ownerId: string | null;
  } | null> {
    const funnel = await db.funnel.findUnique({
      where: { id: funnelId },
      select: {
        rdstationPipelineId: true,
        rdstationOwnerId: true,
        configIaId: true,
        configIa: {
          select: {
            rdstationAccessToken: true,
            rdstationRefreshToken: true,
            rdstationClientId: true,
            rdstationClientSecret: true,
          },
        },
      },
    });

    if (!funnel?.rdstationPipelineId || !funnel?.configIaId || !funnel?.configIa?.rdstationAccessToken) {
      return null;
    }

    return {
      accessToken: funnel.configIa.rdstationAccessToken,
      pipelineId: funnel.rdstationPipelineId,
      configIaId: funnel.configIaId,
      ownerId: funnel.rdstationOwnerId || null,
    };
  }

  /**
   * Obtem o stage_id do RD Station correspondente ao stage do funil
   * Usa o rdstationStageId armazenado diretamente no stage
   */
  private async getRdStationStageId(funnelId: string, stageId: string): Promise<string | null> {
    // Buscar o stage do funil local com o rdstationStageId
    const stage = await db.funnelStage.findUnique({
      where: { id: stageId },
      select: { rdstationStageId: true, name: true },
    });

    if (!stage) {
      logWarn("Stage not found", { stageId });
      return null;
    }

    if (!stage.rdstationStageId) {
      logWarn("Stage does not have RD Station stage ID mapped", {
        stageId,
        stageName: stage.name,
        hint: "Configure the RD Station stage mapping for this stage"
      });
      return null;
    }

    return stage.rdstationStageId;
  }

  /**
   * Cria um deal no RD Station quando um lead é criado
   */
  async createDeal(
    funnelId: string,
    leadId: string,
    leadData: {
      name: string;
      value?: number;
      expectedCloseDate?: Date | null;
      email?: string | null;
      phone?: string | null;
    },
    stageId: string
  ): Promise<string | null> {
    const config = await this.getFunnelRdStationConfig(funnelId);
    if (!config) {
      logInfo("RD Station not configured for funnel, skipping deal creation", { funnelId });
      return null;
    }

    // owner_id é obrigatório para criar deals no RD Station
    if (!config.ownerId) {
      logWarn("RD Station owner_id not configured for funnel, skipping deal creation", {
        funnelId,
        hint: "Configure o usuário responsável nas configurações do funil",
      });
      return null;
    }

    const rdStageId = await this.getRdStationStageId(funnelId, stageId);
    if (!rdStageId) {
      logWarn("Could not find matching RD Station stage", { funnelId, stageId });
      return null;
    }

    try {
      // Campos obrigatórios: name, status, pipeline_id, stage_id, owner_id
      const dealData: DealCreateInput = {
        name: leadData.name,
        status: "ongoing", // Status inicial: em andamento
        pipeline_id: config.pipelineId,
        stage_id: rdStageId,
        owner_id: config.ownerId,
      };

      // Adicionar data prevista se existir
      if (leadData.expectedCloseDate) {
        dealData.expected_close_date = leadData.expectedCloseDate.toISOString().split("T")[0];
      }

      // Adicionar valor se existir
      if (leadData.value && leadData.value > 0) {
        dealData.one_time_price = leadData.value;
      }

      logInfo("Creating deal in RD Station", {
        funnelId,
        leadId,
        dealData,
      });

      // API do RD Station v2 - dados devem estar dentro do objeto "data"
      // A resposta pode vir como { data: DealResponse } ou diretamente como DealResponse
      const response = await axios.post<{ data?: DealResponse } & DealResponse>(
        `${RDSTATION_CRM_API_URL}/deals`,
        { data: dealData },
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      logInfo("RD Station create deal response", {
        leadId,
        responseStatus: response.status,
        responseData: response.data,
      });

      // RD Station v2 pode retornar:
      // - { data: { id: "...", ... } } (formato com wrapper)
      // - { id: "...", ... } (formato direto)
      let dealId: string | null = null;

      // Tentar extrair do formato com wrapper "data"
      if (response.data?.data?.id) {
        dealId = response.data.data.id;
      }
      // Tentar extrair do formato direto (sem wrapper)
      else if (response.data?.id) {
        dealId = response.data.id;
      }

      if (dealId) {
        // Salvar o ID do deal no lead para referência futura
        await db.funnelLead.update({
          where: { id: leadId },
          data: {
            rdstationDealId: dealId,
          },
        });

        logInfo("Deal created in RD Station and saved to lead", {
          leadId,
          rdstationDealId: dealId,
        });

        return dealId;
      }

      logWarn("RD Station response did not contain deal ID", {
        leadId,
        responseData: response.data,
      });

      return null;
    } catch (error: any) {
      logError("Error creating deal in RD Station", {
        funnelId,
        leadId,
        error: error.message,
        response: error.response?.data,
      });
      return null;
    }
  }

  /**
   * Atualiza um deal no RD Station quando um lead é atualizado
   */
  async updateDeal(
    funnelId: string,
    leadId: string,
    leadData: {
      name?: string;
      value?: number;
      expectedCloseDate?: Date | null;
    }
  ): Promise<boolean> {
    // Buscar o lead para pegar o rdstationDealId
    const lead = await db.funnelLead.findUnique({
      where: { id: leadId },
      select: { rdstationDealId: true },
    });

    if (!lead?.rdstationDealId) {
      logInfo("Lead has no RD Station deal, skipping update", { leadId });
      return false;
    }

    const config = await this.getFunnelRdStationConfig(funnelId);
    if (!config) {
      return false;
    }

    // owner_id é obrigatório para atualizar deals no RD Station
    if (!config.ownerId) {
      logWarn("RD Station owner_id not configured for funnel, skipping deal update", {
        funnelId,
        hint: "Configure o usuário responsável nas configurações do funil",
      });
      return false;
    }

    try {
      // Campos obrigatórios para atualização: pipeline_id, owner_id
      const updateData: DealUpdateInput = {
        pipeline_id: config.pipelineId,
        owner_id: config.ownerId,
      };

      if (leadData.name !== undefined) {
        updateData.name = leadData.name;
      }
      if (leadData.expectedCloseDate !== undefined) {
        updateData.expected_close_date = leadData.expectedCloseDate?.toISOString().split("T")[0] || null;
      }

      // Verificar se há algo além dos campos obrigatórios para atualizar
      const hasChanges = leadData.name !== undefined || leadData.expectedCloseDate !== undefined;
      if (!hasChanges) {
        return true; // Nada para atualizar
      }

      // Remover campos nulos/undefined (exceto os obrigatórios)
      const cleanUpdateData = Object.fromEntries(
        Object.entries(updateData).filter(([key, v]) =>
          key === 'pipeline_id' || key === 'owner_id' || (v !== null && v !== undefined)
        )
      );

      logInfo("Updating deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        updateData: cleanUpdateData,
      });

      // API do RD Station v2 - usar PUT para atualizar deal
      await axios.put(
        `${RDSTATION_CRM_API_URL}/deals/${lead.rdstationDealId}`,
        { data: cleanUpdateData },
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      logInfo("Deal updated in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
      });

      return true;
    } catch (error: any) {
      // Se retornar 404, o deal foi deletado no RD Station
      if (error.response?.status === 404) {
        logInfo("Deal not found in RD Station, clearing reference", {
          leadId,
          dealId: lead.rdstationDealId,
        });

        await db.funnelLead.update({
          where: { id: leadId },
          data: { rdstationDealId: null },
        });

        return false;
      }

      logError("Error updating deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        error: error.message,
        response: error.response?.data,
      });
      return false;
    }
  }

  /**
   * Deleta um deal no RD Station quando um lead é deletado
   */
  async deleteDeal(funnelId: string, leadId: string): Promise<boolean> {
    // Buscar o lead para pegar o rdstationDealId antes de deletar
    const lead = await db.funnelLead.findUnique({
      where: { id: leadId },
      select: { rdstationDealId: true },
    });

    if (!lead?.rdstationDealId) {
      logInfo("Lead has no RD Station deal, skipping delete", { leadId });
      return true;
    }

    const config = await this.getFunnelRdStationConfig(funnelId);
    if (!config) {
      return true; // Se não tem config, considera sucesso (nada a deletar)
    }

    try {
      logInfo("Deleting deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
      });

      await axios.delete(
        `${RDSTATION_CRM_API_URL}/deals/${lead.rdstationDealId}`,
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
          },
          timeout: 15000,
        }
      );

      logInfo("Deal deleted in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
      });

      return true;
    } catch (error: any) {
      // Se retornar 404, o deal já foi deletado
      if (error.response?.status === 404) {
        logInfo("Deal already deleted in RD Station", {
          leadId,
          dealId: lead.rdstationDealId,
        });
        return true;
      }

      logError("Error deleting deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        error: error.message,
        response: error.response?.data,
      });
      return false;
    }
  }

  /**
   * Move um deal para outro stage no RD Station quando um lead é movido
   */
  async moveDeal(
    funnelId: string,
    leadId: string,
    newStageId: string
  ): Promise<boolean> {
    // Buscar o lead para pegar o rdstationDealId
    const lead = await db.funnelLead.findUnique({
      where: { id: leadId },
      select: { rdstationDealId: true },
    });

    if (!lead?.rdstationDealId) {
      logInfo("Lead has no RD Station deal, skipping move", { leadId });
      return false;
    }

    const config = await this.getFunnelRdStationConfig(funnelId);
    if (!config) {
      return false;
    }

    // owner_id é obrigatório para atualizar deals no RD Station
    if (!config.ownerId) {
      logWarn("RD Station owner_id not configured for funnel, skipping deal move", {
        funnelId,
        hint: "Configure o usuário responsável nas configurações do funil",
      });
      return false;
    }

    const rdStageId = await this.getRdStationStageId(funnelId, newStageId);
    if (!rdStageId) {
      logWarn("Could not find matching RD Station stage for move", {
        funnelId,
        stageId: newStageId,
      });
      return false;
    }

    // Verificar se é stage fixo (ganho/perdido) para atualizar status também
    const stage = await db.funnelStage.findUnique({
      where: { id: newStageId },
      select: { fixedType: true },
    });

    try {
      // Campos obrigatórios para atualização: stage_id, pipeline_id, owner_id
      const updateData: DealUpdateInput = {
        stage_id: rdStageId,
        pipeline_id: config.pipelineId,
        owner_id: config.ownerId,
      };

      // Se for stage fixo, atualizar status do deal
      if (stage?.fixedType === "won") {
        updateData.status = "won";
      } else if (stage?.fixedType === "lost") {
        updateData.status = "lost";
      }

      logInfo("Moving deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        newStageId: rdStageId,
        pipelineId: config.pipelineId,
        ownerId: config.ownerId,
        status: updateData.status,
      });

      // API do RD Station v2 - usar PUT para atualizar deal
      await axios.put(
        `${RDSTATION_CRM_API_URL}/deals/${lead.rdstationDealId}`,
        { data: updateData },
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
            "Content-Type": "application/json",
          },
          timeout: 15000,
        }
      );

      logInfo("Deal moved in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        newStageId: rdStageId,
      });

      return true;
    } catch (error: any) {
      if (error.response?.status === 404) {
        logInfo("Deal not found in RD Station, clearing reference", {
          leadId,
          dealId: lead.rdstationDealId,
        });

        await db.funnelLead.update({
          where: { id: leadId },
          data: { rdstationDealId: null },
        });

        return false;
      }

      logError("Error moving deal in RD Station", {
        leadId,
        dealId: lead.rdstationDealId,
        error: error.message,
        response: error.response?.data,
      });
      return false;
    }
  }

  /**
   * Busca um deal especifico no RD Station
   */
  async getDeal(funnelId: string, dealId: string): Promise<DealResponse | null> {
    const config = await this.getFunnelRdStationConfig(funnelId);
    if (!config) {
      return null;
    }

    try {
      const response = await axios.get<DealResponse>(
        `${RDSTATION_CRM_API_URL}/deals/${dealId}`,
        {
          headers: {
            Authorization: `Bearer ${config.accessToken}`,
          },
          timeout: 15000,
        }
      );

      return response.data;
    } catch (error: any) {
      logError("Error fetching deal from RD Station", {
        dealId,
        error: error.message,
      });
      return null;
    }
  }
}

// Exportar instancia singleton
export const rdstationDealsService = RDStationDealsService.getInstance();
