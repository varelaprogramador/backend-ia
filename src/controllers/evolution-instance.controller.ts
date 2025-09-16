import { FastifyRequest, FastifyReply } from "fastify";
import {
  CreateEvolutionInstanceRequest,
  UpdateEvolutionInstanceRequest,
  EvolutionInstance,
  EvolutionInstanceResponse,
  QRCodeResponse,
  InstanceStatusResponse,
  ConnectionStateResponse,
} from "../types/evolution-instance";
import { PrismaClient } from "../generated/prisma";

const prisma = new PrismaClient();

export class EvolutionInstanceController {
  // GET /evolution-instances/user/:userId
  async getAllInstances(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { userId } = request.params as { userId?: string };

      if (!userId) {
        return reply.code(400).send({
          success: false,
          message: "UserId é obrigatório",
        });
      }

      const instances = await prisma.evolutionInstance.findMany({
        where: { userId },
        orderBy: { createdAt: "desc" },
        select: {
          id: true,
          userId: true,
          instanceName: true,
          displayName: true,
          connectionState: true,
          ownerJid: true,
          profileName: true,
          profilePictureUrl: true,
          status: true,
          serverUrl: true,
          webhookUrl: true,
          webhookByEvents: true,
          webhookBase64: true,
          webhookEvents: true,
          isDefault: true,
          sendConnectionStatus: true,
          chatwootAccountId: true,
          chatwootToken: true,
          chatwootUrl: true,
          chatwootSignMsg: true,
          createdAt: true,
          updatedAt: true,
          apiKey: true,
        },
      });

      return reply.code(200).send({
        success: true,
        instances,
        count: instances.length,
      });
    } catch (error) {
      console.error("Error in getAllInstances:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /evolution-instances/stats/:userId
  async getInstanceStats(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { userId } = request.params as { userId?: string };

      if (!userId) {
        return reply.code(400).send({
          success: false,
          message: "UserId é obrigatório",
        });
      }

      const userInstances = await prisma.evolutionInstance.findMany({
        where: { userId },
        select: {
          connectionState: true,
          status: true,
        },
      });

      const stats = {
        totalInstances: userInstances.length,
        connectedInstances: userInstances.filter(
          (i) => i.connectionState === "CONNECTED"
        ).length,
        disconnectedInstances: userInstances.filter(
          (i) => i.connectionState === "DISCONNECTED"
        ).length,
        connectingInstances: userInstances.filter(
          (i) => i.connectionState === "CONNECTING"
        ).length,
        errorInstances: userInstances.filter(
          (i) => i.connectionState === "ERROR"
        ).length,
        activeInstances: userInstances.filter((i) => i.status === "active")
          .length,
        inactiveInstances: userInstances.filter((i) => i.status === "inactive")
          .length,
        suspendedInstances: userInstances.filter(
          (i) => i.status === "suspended"
        ).length,
      };

      return reply.code(200).send({
        success: true,
        stats,
        userId,
      });
    } catch (error) {
      console.error("Error in getInstanceStats:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /evolution-instances/:id
  async getInstanceById(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const instance = await prisma.evolutionInstance.findUnique({
        where: { id },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      reply.code(200).send({
        success: true,
        instance,
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /evolution-instances
  async createInstance(request: FastifyRequest, reply: FastifyReply) {
    try {
      console.log("🚀 [CREATE INSTANCE] Iniciando criação de instância");
      console.log(
        "📋 [CREATE INSTANCE] Request body:",
        JSON.stringify(request.body, null, 2)
      );

      const data = request.body as any;
      console.log(
        "✅ [CREATE INSTANCE] Dados parseados:",
        JSON.stringify(data, null, 2)
      );

      // Mapear evolutionUrl para serverUrl se necessário
      const serverUrl = data.serverUrl || data.evolutionUrl;
      const userId = data.userId || "default-user";
      const apikey = data.apiKey;
      // Verificar se o servidor Evolution API existe antes de criar instância
      if (serverUrl) {
        console.log(
          "🔍 [CREATE INSTANCE] Verificando se servidor Evolution existe:",
          serverUrl
        );

        try {
          const serverCheckUrl = `${serverUrl.replace(/\/$/, "")}/`;
          console.log(
            "🌐 [CREATE INSTANCE] Testando conectividade:",
            serverCheckUrl
          );

          const serverResponse = await fetch(serverCheckUrl, {
            method: "GET",
            headers: {
              "Content-Type": "application/json",
            },
            signal: AbortSignal.timeout(5000), // 5 segundos timeout
          });

          console.log("📡 [CREATE INSTANCE] Resposta do servidor:", {
            status: serverResponse.status,
            statusText: serverResponse.statusText,
            ok: serverResponse.ok,
          });

          if (!serverResponse.ok) {
            console.log(
              "❌ [CREATE INSTANCE] Servidor não está acessível:",
              serverResponse.status
            );
            return reply.code(400).send({
              success: false,
              message: `Servidor Evolution API não está acessível (${serverResponse.status})`,
            });
          }

          const serverData = await serverResponse.json();
          console.log(
            "✅ [CREATE INSTANCE] Servidor Evolution API respondeu:",
            JSON.stringify(serverData, null, 2)
          );

          // Agora criar instância no Evolution API
          console.log(
            "🚀 [CREATE INSTANCE] Criando instância no Evolution API:",
            data.instanceName
          );

          const evolutionCreateUrl = `${serverUrl.replace(/\/$/, "")}/instance/create`;
          console.log(
            "🌐 [CREATE INSTANCE] URL de criação:",
            evolutionCreateUrl
          );

          // URL padrão do webhook se não fornecida
          const defaultWebhookUrl = data.webhookUrl || data.webhook;

          const evolutionPayload = {
            instanceName: data.instanceName,
            integration: "WHATSAPP-BAILEYS",
            qrcode: true,
            webhook: {
              url: defaultWebhookUrl,
              byEvents: false, // Sempre desativado para não criar rotas por evento
              base64: true, // Sempre ativado para receber dados em base64
              events: ["MESSAGES_UPSERT"], // Apenas mensagens
            },
          };

          console.log(
            "📋 [CREATE INSTANCE] Payload Evolution:",
            JSON.stringify(evolutionPayload, null, 2)
          );

          // Create an AbortController for better timeout handling
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), 10000);

          try {
            const evolutionResponse = await fetch(evolutionCreateUrl, {
              method: "POST",
              headers: {
                apikey: data.apiKey || "",
                "Content-Type": "application/json",
              },
              body: JSON.stringify(evolutionPayload),
              signal: abortController.signal,
            });

            clearTimeout(timeoutId);

            console.log("📡 [CREATE INSTANCE] Resposta Evolution API:", {
              status: evolutionResponse.status,
              statusText: evolutionResponse.statusText,
              ok: evolutionResponse.ok,
            });

            if (!evolutionResponse.ok) {
              const errorData = await evolutionResponse.text();
              console.log(
                "❌ [CREATE INSTANCE] Erro na criação Evolution API:",
                errorData
              );
              return reply.code(400).send({
                success: false,
                message: `Erro ao criar instância no Evolution API (${evolutionResponse.status})`,
                error: errorData,
              });
            }

            const evolutionData = await evolutionResponse.json();
            console.log(
              "✅ [CREATE INSTANCE] Instância criada no Evolution API:",
              JSON.stringify(evolutionData, null, 2)
            );
          } catch (fetchError) {
            clearTimeout(timeoutId);
            console.log(
              "💥 [CREATE INSTANCE] Erro na requisição Evolution API:",
              fetchError
            );
            // Handle timeout specifically
            if (
              fetchError instanceof Error &&
              fetchError.name === "AbortError"
            ) {
              return reply.code(408).send({
                success: false,
                message: "Timeout na criação da instância no Evolution API",
                error: "Request timeout",
              });
            }

            return reply.code(500).send({
              success: false,
              message: "Erro na comunicação com Evolution API",
              error:
                fetchError instanceof Error
                  ? fetchError.message
                  : "Erro de conexão",
            });
          }

          // Criar instância no banco de dados após sucesso no Evolution API
          console.log(
            "💾 [CREATE INSTANCE] Salvando instância no banco de dados"
          );

          try {
            const dbInstance = await prisma.evolutionInstance.create({
              data: {
                userId: userId,
                apiKey: apikey,
                instanceName: data.instanceName,
                displayName: data.displayName || data.instanceName,
                connectionState: "DISCONNECTED",
                status: "active",
                serverUrl: serverUrl,
                webhookUrl: defaultWebhookUrl,
                webhookByEvents: false, // Sempre desativado para não criar rotas por evento
                webhookBase64: true, // Sempre ativado para receber dados em base64
                webhookEvents: ["MESSAGES_UPSERT"], // Apenas mensagens
                isDefault: data.isDefault || false,
                sendConnectionStatus:
                  data.sendConnectionStatus !== undefined
                    ? data.sendConnectionStatus
                    : true,
                chatwootAccountId: data.chatwootAccountId,
                chatwootToken: data.chatwootToken,
                chatwootUrl: data.chatwootUrl,
                chatwootSignMsg: data.chatwootSignMsg || false,
              },
            });

            console.log(
              "✅ [CREATE INSTANCE] Instância salva no banco:",
              JSON.stringify(dbInstance, null, 2)
            );

            const response: EvolutionInstanceResponse = {
              instance: {
                id: dbInstance.id,
                userId: dbInstance.userId,
                instanceName: dbInstance.instanceName,
                displayName: dbInstance.displayName,
                connectionState: dbInstance.connectionState as any,
                ownerJid: dbInstance.ownerJid ?? undefined,
                profileName: dbInstance.profileName ?? undefined,
                profilePictureUrl: dbInstance.profilePictureUrl ?? undefined,
                status: dbInstance.status as any,
                serverUrl: dbInstance.serverUrl ?? undefined,
                webhookUrl: dbInstance.webhookUrl ?? undefined,
                webhookByEvents: dbInstance.webhookByEvents ?? undefined,
                webhookBase64: dbInstance.webhookBase64 ?? undefined,
                webhookEvents: dbInstance.webhookEvents as string[],
                isDefault: dbInstance.isDefault ?? undefined,
                sendConnectionStatus:
                  dbInstance.sendConnectionStatus ?? undefined,
                chatwootAccountId: dbInstance.chatwootAccountId ?? undefined,
                chatwootToken: dbInstance.chatwootToken ?? undefined,
                chatwootUrl: dbInstance.chatwootUrl ?? undefined,
                chatwootSignMsg: dbInstance.chatwootSignMsg ?? undefined,
                createdAt: dbInstance.createdAt,
                updatedAt: dbInstance.updatedAt,
              },
              hash: {
                apikey: apikey,
              },
            };

            console.log(
              "📤 [CREATE INSTANCE] Resposta final preparada:",
              JSON.stringify(response, null, 2)
            );

            reply.code(201).send({
              success: true,
              message:
                "Instância criada com sucesso no Evolution API e banco de dados",
              data: response,
            });

            console.log("✅ [CREATE INSTANCE] Resposta enviada com sucesso");
            return;
          } catch (dbError) {
            console.log(
              "💥 [CREATE INSTANCE] Erro ao salvar no banco:",
              dbError
            );

            // Tentar deletar a instância do Evolution API se falhar ao salvar no DB
            try {
              const deleteUrl = `${serverUrl.replace(/\/$/, "")}/instance/delete/${data.instanceName}`;
              await fetch(deleteUrl, {
                method: "DELETE",
                headers: {
                  apikey: data.apiKey || "",
                },
              });
              console.log(
                "🗑️ [CREATE INSTANCE] Instância removida do Evolution API devido ao erro no banco"
              );
            } catch (cleanupError) {
              console.log(
                "⚠️ [CREATE INSTANCE] Erro ao limpar instância do Evolution:",
                cleanupError
              );
            }

            return reply.code(500).send({
              success: false,
              message:
                "Instância criada no Evolution API mas falha ao salvar no banco de dados",
              error:
                dbError instanceof Error
                  ? dbError.message
                  : "Erro no banco de dados",
            });
          }
        } catch (serverError) {
          console.log(
            "💥 [CREATE INSTANCE] Erro ao verificar/criar no servidor:",
            serverError
          );
          return reply.code(400).send({
            success: false,
            message:
              "Não foi possível conectar ou criar instância no servidor Evolution API. Verifique a URL e API Key.",
            error:
              serverError instanceof Error
                ? serverError.message
                : "Erro de conexão",
          });
        }
      } else {
        console.log(
          "⚠️ [CREATE INSTANCE] URL do servidor não fornecida, criando apenas no banco de dados"
        );

        // Criar instância apenas no banco de dados quando não há serverUrl
        console.log(
          "💾 [CREATE INSTANCE] Salvando instância no banco de dados (sem Evolution API)"
        );

        try {
          // Verificar se instância já existe no banco
          const existingInstance = await prisma.evolutionInstance.findUnique({
            where: { instanceName: data.instanceName },
          });

          if (existingInstance) {
            console.log(
              "❌ [CREATE INSTANCE] Instância já existe:",
              data.instanceName
            );
            return reply.code(409).send({
              success: false,
              message: "Já existe uma instância com esse nome",
            });
          }

          // URL padrão do webhook se não fornecida (sem servidor Evolution)
          const defaultWebhookUrl = data.webhookUrl || data.webhook;

          const dbInstance = await prisma.evolutionInstance.create({
            data: {
              userId: userId,
              instanceName: data.instanceName,
              displayName: data.displayName || data.instanceName,
              connectionState: "DISCONNECTED",
              status: "active",
              serverUrl: serverUrl,
              webhookUrl: defaultWebhookUrl,
              webhookByEvents: false, // Sempre desativado para não criar rotas por evento
              webhookBase64: true, // Sempre ativado para receber dados em base64
              webhookEvents: ["MESSAGES_UPSERT"], // Apenas mensagens
              isDefault: data.isDefault || false,
              sendConnectionStatus:
                data.sendConnectionStatus !== undefined
                  ? data.sendConnectionStatus
                  : true,
              chatwootAccountId: data.chatwootAccountId,
              chatwootToken: data.chatwootToken,
              chatwootUrl: data.chatwootUrl,
              chatwootSignMsg: data.chatwootSignMsg || false,
            },
          });

          console.log(
            "✅ [CREATE INSTANCE] Instância salva no banco:",
            JSON.stringify(dbInstance, null, 2)
          );

          const response: EvolutionInstanceResponse = {
            instance: {
              id: dbInstance.id,
              userId: dbInstance.userId,
              instanceName: dbInstance.instanceName,
              displayName: dbInstance.displayName,
              connectionState: dbInstance.connectionState as any,
              ownerJid: dbInstance.ownerJid ?? undefined,
              profileName: dbInstance.profileName ?? undefined,
              profilePictureUrl: dbInstance.profilePictureUrl ?? undefined,
              status: dbInstance.status as any,
              serverUrl: dbInstance.serverUrl ?? undefined,
              webhookUrl: dbInstance.webhookUrl ?? undefined,
              webhookByEvents: dbInstance.webhookByEvents ?? undefined,
              webhookBase64: dbInstance.webhookBase64 ?? undefined,
              webhookEvents: dbInstance.webhookEvents as string[],
              isDefault: dbInstance.isDefault ?? undefined,
              sendConnectionStatus:
                dbInstance.sendConnectionStatus ?? undefined,
              chatwootAccountId: dbInstance.chatwootAccountId ?? undefined,
              chatwootToken: dbInstance.chatwootToken ?? undefined,
              chatwootUrl: dbInstance.chatwootUrl ?? undefined,
              chatwootSignMsg: dbInstance.chatwootSignMsg ?? undefined,
              createdAt: dbInstance.createdAt,
              updatedAt: dbInstance.updatedAt,
            },
            hash: {
              apikey: `${dbInstance.id}-api-key-${Date.now()}`,
            },
          };

          reply.code(201).send({
            success: true,
            message: "Instância criada com sucesso no banco de dados",
            data: response,
          });

          console.log("✅ [CREATE INSTANCE] Resposta enviada com sucesso");
        } catch (dbError) {
          console.log("💥 [CREATE INSTANCE] Erro ao salvar no banco:", dbError);
          return reply.code(500).send({
            success: false,
            message: "Erro ao salvar instância no banco de dados",
            error:
              dbError instanceof Error
                ? dbError.message
                : "Erro no banco de dados",
          });
        }
      }
    } catch (error) {
      console.log("💥 [CREATE INSTANCE] Erro na criação:", error);
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // PUT /evolution-instances/:id
  async updateInstance(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const data = request.body as UpdateEvolutionInstanceRequest;

      const instance = await prisma.evolutionInstance.findUnique({
        where: { id },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      const updatedInstance = await prisma.evolutionInstance.update({
        where: { id },
        data: {
          ...data,
          updatedAt: new Date(),
        },
      });

      reply.code(200).send({
        success: true,
        message: "Instância atualizada com sucesso",
        instance: updatedInstance,
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // DELETE /evolution-instances/:id
  async deleteInstance(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const instance = await prisma.evolutionInstance.findUnique({
        where: { id },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      await prisma.evolutionInstance.delete({
        where: { id },
      });

      reply.code(200).send({
        success: true,
        message: "Instância deletada com sucesso",
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /evolution-instances/:instanceName/connect - Conectar e gerar QR Code
  async connectInstance(request: FastifyRequest, reply: FastifyReply) {
    console.log("🚀 [CONNECT] Iniciando conectInstance");
    console.log("📋 [CONNECT] Params:", request.params);

    // TESTE SIMPLES - retornar resposta mock primeiro
    console.log("🧪 [CONNECT] Retornando resposta de teste");
    const testResponse = {
      success: true,
      message: "QR Code de teste gerado com sucesso",
      qrcode: {
        base64: "test-qr-code-base64",
        code: "test-qr-code",
        count: 1,
        pairingCode: null,
      },
      instanceId: "test-instance-id",
      instanceName: "test-instance",
    };

    console.log(
      "✅ [CONNECT] Enviando resposta de teste:",
      JSON.stringify(testResponse, null, 2)
    );

    // Tentar forma mais simples de enviar resposta
    console.log("📤 [CONNECT] Tentando enviar resposta...");
    return reply.code(200).send(testResponse);
  }

  // Método auxiliar para buscar instância por nome ou ID
  private async findInstanceByNameOrId(nameOrId: string) {
    // Tentar por instanceName primeiro
    let instance = await prisma.evolutionInstance.findUnique({
      where: { instanceName: nameOrId },
      select: {
        id: true,
        instanceName: true,
        connectionState: true,
        serverUrl: true,
        apiKey: true,
      },
    });

    // Se não encontrou, tentar por ID
    if (!instance) {
      instance = await prisma.evolutionInstance.findUnique({
        where: { id: nameOrId },
        select: {
          id: true,
          instanceName: true,
          connectionState: true,
          serverUrl: true,
          apiKey: true,
        },
      });
    }

    return instance;
  }

  // Método auxiliar para gerar QR Code via Evolution API
  private async generateQRCode(instance: {
    instanceName: string;
    serverUrl: string;
    apiKey: string;
  }) {
    const evolutionUrl = `${instance.serverUrl.replace(/\/$/, "")}/instance/connect/${instance.instanceName}`;

    console.log("🔗 [GENERATE QR] Chamando Evolution API:", evolutionUrl);
    console.log(
      "🔑 [GENERATE QR] API Key:",
      instance.apiKey ? "Presente" : "Ausente"
    );

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15 segundos

    try {
      const response = await fetch(evolutionUrl, {
        method: "GET",
        headers: {
          apikey: instance.apiKey,
          "Content-Type": "application/json",
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      console.log("📡 [GENERATE QR] Resposta Evolution API:", {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.log("❌ [GENERATE QR] Erro na Evolution API:", errorText);
        throw new Error(
          `Evolution API error (${response.status}): ${errorText}`
        );
      }

      const data = await response.json();
      console.log(
        "📋 [GENERATE QR] Dados recebidos:",
        JSON.stringify(data, null, 2)
      );

      // Log do QR Code gerado
      console.log(
        "🔲 [QR CODE] QR Code gerado para instância:",
        instance.instanceName
      );
      console.log(
        "📱 [QR CODE] Base64:",
        data.code || data.base64 || "Não disponível"
      );
      if (data.pairingCode) {
        console.log("🔗 [QR CODE] Pairing Code:", data.pairingCode);
      }

      const qrCodeResponse = {
        base64: data.code || data.base64,
        code: data.code,
        count: data.count || 1,
        pairingCode: data.pairingCode,
      };

      console.log(
        "✅ [GENERATE QR] QR Code response preparada:",
        JSON.stringify(qrCodeResponse, null, 2)
      );

      // Verificar se o QR code tem conteúdo válido
      if (!qrCodeResponse.base64 && !qrCodeResponse.code) {
        console.log("❌ [GENERATE QR] QR Code sem conteúdo válido");
        return null;
      }

      return qrCodeResponse;
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("Timeout ao conectar com Evolution API");
      }

      throw error;
    }
  }

  // PATCH /evolution-instances/:instanceName/status OR /:id/status - Update instance status in DB
  async updateInstanceStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { instanceName } = request.params as { instanceName: string };
      const { connectionState, ownerJid, profileName, profilePictureUrl } =
        request.body as {
          connectionState?:
            | "CONNECTING"
            | "CONNECTED"
            | "DISCONNECTED"
            | "TIMEOUT"
            | "CLOSE";
          ownerJid?: string;
          profileName?: string;
          profilePictureUrl?: string;
        };

      // Try to find instance by instanceName first, then by ID
      let instance = await prisma.evolutionInstance.findUnique({
        where: { instanceName },
      });

      // If not found by instanceName, try by ID (for frontend compatibility)
      if (!instance) {
        instance = await prisma.evolutionInstance.findUnique({
          where: { id: instanceName }, // instanceName parameter might actually be an ID
        });
      }

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      console.log(
        `📝 [UPDATE STATUS] Atualizando status da instância: ${instance.instanceName}`
      );
      console.log(`📝 [UPDATE STATUS] Novo estado:`, {
        connectionState,
        ownerJid,
        profileName,
        profilePictureUrl,
      });

      // Update instance in database
      const updateData: any = {
        updatedAt: new Date(),
      };

      if (connectionState) {
        updateData.connectionState = connectionState;
      }

      if (ownerJid !== undefined) {
        updateData.ownerJid = ownerJid;
      }

      if (profileName !== undefined) {
        updateData.profileName = profileName;
      }

      if (profilePictureUrl !== undefined) {
        updateData.profilePictureUrl = profilePictureUrl;
      }

      // If disconnecting, clear profile data
      if (connectionState === "DISCONNECTED") {
        updateData.ownerJid = null;
        updateData.profileName = null;
        updateData.profilePictureUrl = null;
      }

      const updatedInstance = await prisma.evolutionInstance.update({
        where: { id: instance.id },
        data: updateData,
      });

      console.log(
        `✅ [UPDATE STATUS] Status atualizado com sucesso:`,
        updatedInstance.connectionState
      );

      reply.code(200).send({
        success: true,
        message: "Status da instância atualizado com sucesso",
        instance: {
          id: updatedInstance.id,
          instanceName: updatedInstance.instanceName,
          connectionState: updatedInstance.connectionState,
          ownerJid: updatedInstance.ownerJid,
          profileName: updatedInstance.profileName,
          profilePictureUrl: updatedInstance.profilePictureUrl,
          updatedAt: updatedInstance.updatedAt,
        },
      });
    } catch (error) {
      console.log("💥 [UPDATE STATUS] Erro ao atualizar status:", error);
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // DELETE /evolution-instances/:instanceName/logout OR POST /:id/disconnect
  async disconnectInstance(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { instanceName } = request.params as { instanceName: string };

      // Try to find instance by instanceName first, then by ID
      let instance = await prisma.evolutionInstance.findUnique({
        where: { instanceName },
      });

      // If not found by instanceName, try by ID (for frontend compatibility)
      if (!instance) {
        instance = await prisma.evolutionInstance.findUnique({
          where: { id: instanceName }, // instanceName parameter might actually be an ID
        });
      }

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      // Update connection state
      await prisma.evolutionInstance.update({
        where: { id: instance.id },
        data: {
          connectionState: "DISCONNECTED",
          ownerJid: null,
          profileName: null,
          profilePictureUrl: null,
          updatedAt: new Date(),
        },
      });

      reply.code(200).send({
        success: true,
        message: "Instância desconectada com sucesso",
        instance: {
          instanceName: instance.instanceName,
          status: "disconnected",
        },
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /evolution-instances/:instanceName/connect - Obter QR Code
  async getQRCode(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { instanceName } = request.params as { instanceName?: string };

      if (!instanceName) {
        return reply.code(400).send({
          success: false,
          message: "Nome da instância ou ID é obrigatório",
        });
      }

      // Buscar instância por instanceName ou ID
      const instance = await this.findInstanceByNameOrId(instanceName);

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      // Verificar se já está conectada
      if (instance.connectionState === "CONNECTED") {
        return reply.code(409).send({
          success: false,
          message: "Instância já está conectada",
          qrcode: null,
        });
      }

      // Gerar QR Code via Evolution API
      if (instance.serverUrl && instance.apiKey) {
        try {
          const qrCodeData = await this.generateQRCode({
            instanceName: instance.instanceName,
            serverUrl: instance.serverUrl,
            apiKey: instance.apiKey,
          });

          return reply.code(200).send({
            success: true,
            message: "QR Code obtido com sucesso",
            qrcode: qrCodeData,
            instanceId: instance.id,
            instanceName: instance.instanceName,
          });
        } catch (evolutionError) {
          console.error("Erro ao obter QR Code:", evolutionError);

          return reply.code(500).send({
            success: false,
            message: "Erro ao obter QR Code do servidor Evolution API",
            error:
              evolutionError instanceof Error
                ? evolutionError.message
                : "Erro de conexão",
          });
        }
      }

      // Se não há serverUrl ou apiKey configurados
      return reply.code(400).send({
        success: false,
        message:
          "Instância não possui servidor Evolution API ou chave API configurados",
      });
    } catch (error) {
      console.error("Error in getQRCode:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /evolution-instances/:instanceName/status
  async getInstanceStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { instanceName } = request.params as { instanceName: string };

      const instance = await prisma.evolutionInstance.findUnique({
        where: { instanceName },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      const statusResponse: InstanceStatusResponse = {
        instance: {
          instanceName: instance.instanceName,
          status: instance.connectionState.toLowerCase(),
        },
      };

      reply.code(200).send({
        success: true,
        ...statusResponse,
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /evolution-instances/:instanceName/connectionState
  async getConnectionState(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { instanceName } = request.params as { instanceName: string };

      const instance = await prisma.evolutionInstance.findUnique({
        where: { instanceName },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      const connectionResponse: ConnectionStateResponse = {
        state: instance.connectionState as
          | "CONNECTING"
          | "CONNECTED"
          | "DISCONNECTED"
          | "TIMEOUT"
          | "CLOSE",
      };

      reply.code(200).send({
        success: true,
        ...connectionResponse,
      });
    } catch (error) {
      reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /evolution-instances/:id/refresh-status - Atualizar status da instância
  async refreshInstanceStatus(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      console.log(
        `🔄 [REFRESH STATUS] Iniciando atualização de status para ID: ${id}`
      );

      // Buscar instância no banco
      const instance = await prisma.evolutionInstance.findUnique({
        where: { id },
      });

      if (!instance) {
        return reply.code(404).send({
          success: false,
          message: "Instância não encontrada",
        });
      }

      if (!instance.serverUrl || !instance.apiKey) {
        return reply.code(400).send({
          success: false,
          message:
            "Instância não possui configurações válidas (serverUrl ou apiKey)",
        });
      }

      try {
        // Verificar status na Evolution API
        const evolutionStatusUrl = `${instance.serverUrl.replace(/\/$/, "")}/instance/connectionState/${instance.instanceName}`;

        console.log(
          `🌐 [REFRESH STATUS] Consultando Evolution API: ${evolutionStatusUrl}`
        );

        const response = await fetch(evolutionStatusUrl, {
          method: "GET",
          headers: {
            apikey: instance.apiKey,
            "Content-Type": "application/json",
          },
          signal: AbortSignal.timeout(10000), // 10 segundos timeout
        });

        console.log(`📡 [REFRESH STATUS] Resposta Evolution API:`, {
          status: response.status,
          statusText: response.statusText,
          ok: response.ok,
        });

        if (!response.ok) {
          const errorText = await response.text();
          console.log(
            `❌ [REFRESH STATUS] Erro na Evolution API: ${errorText}`
          );

          // Se instância não existe na Evolution API, marcar como DISCONNECTED
          if (response.status === 404) {
            await prisma.evolutionInstance.update({
              where: { id: instance.id },
              data: {
                connectionState: "DISCONNECTED",
                ownerJid: null,
                profileName: null,
                profilePictureUrl: null,
                updatedAt: new Date(),
              },
            });

            return reply.code(200).send({
              success: true,
              message:
                "Status atualizado - instância não encontrada na Evolution API",
              connectionState: "DISCONNECTED",
              source: "evolution_api_not_found",
            });
          }

          throw new Error(
            `Evolution API error (${response.status}): ${errorText}`
          );
        }

        const statusData = await response.json();
        console.log(
          `📋 [REFRESH STATUS] Dados recebidos:`,
          JSON.stringify(statusData, null, 2)
        );

        // Mapear estado da Evolution API para nosso formato
        let newConnectionState = "DISCONNECTED";
        let ownerJid = instance.ownerJid;
        let profileName = instance.profileName;
        let profilePictureUrl = instance.profilePictureUrl;

        if (statusData.instance) {
          const evolutionState = statusData.instance.state;

          switch (evolutionState) {
            case "open":
              newConnectionState = "CONNECTED";
              break;
            case "connecting":
              newConnectionState = "CONNECTING";
              break;
            case "close":
            case "closed":
              newConnectionState = "DISCONNECTED";
              break;
            default:
              newConnectionState = "DISCONNECTED";
          }

          // Se conectado, buscar informações do perfil
          if (newConnectionState === "CONNECTED") {
            try {
              const profileUrl = `${instance.serverUrl.replace(/\/$/, "")}/instance/fetchInstances/${instance.instanceName}`;
              const profileResponse = await fetch(profileUrl, {
                method: "GET",
                headers: {
                  apikey: instance.apiKey,
                  "Content-Type": "application/json",
                },
                signal: AbortSignal.timeout(5000),
              });

              if (profileResponse.ok) {
                const profileData = await profileResponse.json();
                console.log(
                  `👤 [REFRESH STATUS] Dados do perfil:`,
                  JSON.stringify(profileData, null, 2)
                );

                if (profileData.instance) {
                  ownerJid = profileData.instance.ownerJid || ownerJid;
                  profileName = profileData.instance.profileName || profileName;
                  profilePictureUrl =
                    profileData.instance.profilePictureUrl || profilePictureUrl;
                }
              }
            } catch (profileError) {
              console.warn(
                `⚠️ [REFRESH STATUS] Erro ao buscar perfil:`,
                profileError
              );
            }
          }

          // Se desconectado, limpar dados do perfil
          if (newConnectionState === "DISCONNECTED") {
            ownerJid = null;
            profileName = null;
            profilePictureUrl = null;
          }
        }

        // Atualizar no banco de dados
        const updatedInstance = await prisma.evolutionInstance.update({
          where: { id: instance.id },
          data: {
            connectionState: newConnectionState,
            ownerJid,
            profileName,
            profilePictureUrl,
            updatedAt: new Date(),
          },
        });

        console.log(`✅ [REFRESH STATUS] Status atualizado com sucesso:`, {
          instanceName: instance.instanceName,
          oldState: instance.connectionState,
          newState: newConnectionState,
          ownerJid,
          profileName,
        });

        return reply.code(200).send({
          success: true,
          message: "Status da instância atualizado com sucesso",
          connectionState: newConnectionState,
          ownerJid,
          profileName,
          profilePictureUrl,
          source: "evolution_api",
          instance: {
            id: updatedInstance.id,
            instanceName: updatedInstance.instanceName,
            connectionState: updatedInstance.connectionState,
            ownerJid: updatedInstance.ownerJid,
            profileName: updatedInstance.profileName,
            profilePictureUrl: updatedInstance.profilePictureUrl,
            updatedAt: updatedInstance.updatedAt,
          },
        });
      } catch (evolutionError) {
        console.error(
          `💥 [REFRESH STATUS] Erro ao consultar Evolution API:`,
          evolutionError
        );

        return reply.code(500).send({
          success: false,
          message: "Erro ao consultar status na Evolution API",
          error:
            evolutionError instanceof Error
              ? evolutionError.message
              : "Erro de conexão",
        });
      }
    } catch (error) {
      console.error(`💥 [REFRESH STATUS] Erro geral:`, error);
      return reply.code(500).send({
        success: false,
        message: "Erro interno do servidor",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }
}
