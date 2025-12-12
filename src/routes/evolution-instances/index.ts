import { FastifyInstance } from "fastify";
import { EvolutionInstanceController } from "../../controllers/evolution-instance.controller";
import { PrismaClient } from "../../generated/prisma";

const prisma = new PrismaClient();

export default async function evolutionInstanceRoutes(
  fastify: FastifyInstance
) {
  const controller = new EvolutionInstanceController();

  // CRUD Routes
  fastify.get("/", controller.getAllInstances.bind(controller));
  fastify.get("/user/:userId", controller.getAllInstances.bind(controller));
  fastify.get("/stats/:userId", controller.getInstanceStats.bind(controller));

  // GET /config-ia/:configIaId - Buscar instâncias por ConfigIA
  fastify.get("/config-ia/:configIaId", async (request, reply) => {
    const { configIaId } = request.params as { configIaId: string };

    try {
      const instances = await prisma.evolutionInstance.findMany({
        where: { configIAId: configIaId },
        orderBy: { createdAt: "desc" },
      });

      return reply.code(200).send({
        success: true,
        data: instances,
      });
    } catch (error) {
      console.error("Error fetching instances by configIaId:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao buscar instâncias",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  fastify.get("/:id", controller.getInstanceById.bind(controller));
  fastify.post("/", controller.createInstance.bind(controller));
  fastify.put("/:id", controller.updateInstance.bind(controller));
  fastify.delete("/:id", controller.deleteInstance.bind(controller));

  // Evolution API Routes - NOVA IMPLEMENTAÇÃO SIMPLES
  // POST /:id/connect - Conectar instância e gerar QR Code
  fastify.post("/:id/connect", async (request, reply) => {
    console.log("🚀 [CONNECT] POST /:id/connect chamada");
    const { id } = request.params as { id: string };
    console.log("📋 [CONNECT] ID da instância:", id);
    
    try {
      // Buscar instância por ID
      const instance = await prisma.evolutionInstance.findUnique({
        where: { id },
        select: {
          id: true,
          instanceName: true,
          connectionState: true,
          serverUrl: true,
          apiKey: true,
        },
      });

      if (!instance) {
        console.log("❌ [CONNECT] Instância não encontrada:", id);
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      console.log("✅ [CONNECT] Instância encontrada:", {
        id: instance.id,
        name: instance.instanceName,
        state: instance.connectionState,
        hasServerUrl: !!instance.serverUrl,
        hasApiKey: !!instance.apiKey
      });

      // Verificar se já está conectada
      if (instance.connectionState === "CONNECTED") {
        console.log("⚠️ [CONNECT] Instância já conectada");
        return reply.code(409).send({
          success: false,
          message: "Instância já está conectada",
        });
      }

      // Verificar configurações necessárias
      if (!instance.serverUrl || !instance.apiKey) {
        console.log("❌ [CONNECT] Configurações faltando:", {
          hasServerUrl: !!instance.serverUrl,
          hasApiKey: !!instance.apiKey
        });
        return reply.code(400).send({
          success: false,
          message: "Instância não possui servidor Evolution API ou chave API configurados",
        });
      }

      // Atualizar status para CONNECTING
      console.log("🔄 [CONNECT] Atualizando status para CONNECTING");
      await prisma.evolutionInstance.update({
        where: { id: instance.id },
        data: {
          connectionState: "CONNECTING",
          updatedAt: new Date(),
        },
      });

      // Gerar QR Code via Evolution API
      console.log("📡 [CONNECT] Chamando Evolution API para gerar QR Code");
      const evolutionUrl = `${instance.serverUrl.replace(/\/$/, "")}/instance/connect/${instance.instanceName}`;
      
      const response = await fetch(evolutionUrl, {
        method: "GET",
        headers: {
          apikey: instance.apiKey,
          "Content-Type": "application/json",
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log("❌ [CONNECT] Erro na Evolution API:", errorText);
        
        // Reverter status se falhou
        await prisma.evolutionInstance.update({
          where: { id: instance.id },
          data: { connectionState: "DISCONNECTED" },
        });
        
        return reply.code(500).send({
          success: false,
          message: "Erro ao conectar com servidor Evolution API",
          error: errorText,
        });
      }

      const qrData = await response.json();
      console.log("📋 [CONNECT] Dados do QR Code recebidos:", JSON.stringify(qrData, null, 2));

      const qrCodeResponse = {
        base64: qrData.code || qrData.base64,
        code: qrData.code,
        count: qrData.count || 1,
        pairingCode: qrData.pairingCode,
      };

      // Verificar se o QR code tem conteúdo válido
      if (!qrCodeResponse.base64 && !qrCodeResponse.code) {
        console.log("❌ [CONNECT] QR Code sem conteúdo válido");
        return reply.code(400).send({
          success: false,
          message: "QR Code não foi gerado corretamente",
        });
      }

      const successResponse = {
        success: true,
        message: "QR Code gerado com sucesso",
        qrcode: qrCodeResponse,
        instanceId: instance.id,
        instanceName: instance.instanceName,
      };

      console.log("✅ [CONNECT] Enviando resposta de sucesso:", JSON.stringify(successResponse, null, 2));
      return reply.code(200).send(successResponse);

    } catch (error) {
      console.error("💥 [CONNECT] Erro na conexão:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });

  // Outras rotas Evolution API
  fastify.post("/:id/disconnect", controller.disconnectInstance.bind(controller));
  fastify.get("/:id/status", controller.getInstanceStatus.bind(controller));
  fastify.post("/:id/refresh-status", controller.refreshInstanceStatus.bind(controller));
}
