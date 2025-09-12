import { FastifyInstance, FastifyPluginOptions, FastifyRequest } from "fastify";
import { z } from "zod";
import { db } from "@/lib/db";
import { formatResponse, sendError } from "@/utils/response-formatter";
import { logError, logInfo } from "@/utils/logger";

const systemConfigSchema = z.object({
  systemName: z.string().optional(),
  systemTitle: z.string().optional(),
  systemDescription: z.string().optional(),

  // SEO
  seoTitle: z.string().optional(),
  seoDescription: z.string().optional(),
  seoKeywords: z.string().optional(),

  // Visual Identity
  logoUrl: z.string().optional(),
  logoUrlDark: z.string().optional(),
  faviconUrl: z.string().optional(),
  primaryColor: z.string().optional(),
  secondaryColor: z.string().optional(),

  // Contact & Links
  contactEmail: z.union([z.string().email(), z.literal("")]).optional(),
  supportUrl: z.union([z.string().url(), z.literal("")]).optional(),
  websiteUrl: z.union([z.string().url(), z.literal("")]).optional(),
  privacyPolicyUrl: z.union([z.string().url(), z.literal("")]).optional(),
  termsOfServiceUrl: z.union([z.string().url(), z.literal("")]).optional(),

  // Social Media
  facebookUrl: z.union([z.string().url(), z.literal("")]).optional(),
  twitterUrl: z.union([z.string().url(), z.literal("")]).optional(),
  linkedinUrl: z.union([z.string().url(), z.literal("")]).optional(),
  instagramUrl: z.union([z.string().url(), z.literal("")]).optional(),

  // System Settings
  maintenanceMode: z.boolean().optional(),
  allowRegistration: z.boolean().optional(),
  version: z.string().optional(),
});

export default async function (fastify: FastifyInstance) {
  // GET /system-config - Get system configuration (creates default if not exists)
  fastify.get(
    "/",
    {
      schema: {
        tags: ["System Config"],
        description: "Get system configuration settings",
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  id: { type: "string" },
                  systemName: { type: "string" },
                  systemTitle: { type: "string" },
                  systemDescription: { type: "string" },
                  seoTitle: { type: "string" },
                  seoDescription: { type: "string" },
                  seoKeywords: { type: "string" },
                  logoUrl: { type: "string" },
                  logoUrlDark: { type: "string" },
                  faviconUrl: { type: "string" },
                  primaryColor: { type: "string" },
                  secondaryColor: { type: "string" },
                  contactEmail: { type: "string" },
                  supportUrl: { type: "string" },
                  websiteUrl: { type: "string" },
                  privacyPolicyUrl: { type: "string" },
                  termsOfServiceUrl: { type: "string" },
                  facebookUrl: { type: "string" },
                  twitterUrl: { type: "string" },
                  linkedinUrl: { type: "string" },
                  instagramUrl: { type: "string" },
                  maintenanceMode: { type: "boolean" },
                  allowRegistration: { type: "boolean" },
                  version: { type: "string" },
                  createdAt: { type: "string" },
                  updatedAt: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        // Buscar configuração existente ou criar uma padrão
        let systemConfig = await db.systemConfig.findFirst();

        if (!systemConfig) {
          // Criar configuração padrão se não existir
          systemConfig = await db.systemConfig.create({
            data: {
              systemName: "AI System",
              systemTitle: "AI Management Platform",
              systemDescription:
                "Sistema de Gerenciamento de IA com Evolution API",
              seoTitle: "AI Management Platform",
              seoDescription:
                "Plataforma completa para gerenciamento de agentes de IA",
              primaryColor: "#000000",
              secondaryColor: "#ffffff",
              maintenanceMode: false,
              allowRegistration: true,
              version: "1.0.0",
            },
          });

          logInfo("Default system configuration created", {
            id: systemConfig.id,
          });
        }

        return formatResponse({ data: systemConfig });
      } catch (error) {
        logError("Error getting system configuration", error as Error);
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // PUT /system-config - Update system configuration
  fastify.put(
    "/",
    {
      schema: {
        tags: ["System Config"],
        description: "Update system configuration settings",
        body: {
          type: "object",
          properties: {
            systemName: { type: "string" },
            systemTitle: { type: "string" },
            systemDescription: { type: "string" },
            seoTitle: { type: "string" },
            seoDescription: { type: "string" },
            seoKeywords: { type: "string" },
            logoUrl: { type: "string" },
            logoUrlDark: { type: "string" },
            faviconUrl: { type: "string" },
            primaryColor: { type: "string" },
            secondaryColor: { type: "string" },
            contactEmail: { type: "string" },
            supportUrl: { type: "string" },
            websiteUrl: { type: "string" },
            privacyPolicyUrl: { type: "string" },
            termsOfServiceUrl: { type: "string" },
            facebookUrl: { type: "string" },
            twitterUrl: { type: "string" },
            linkedinUrl: { type: "string" },
            instagramUrl: { type: "string" },
            maintenanceMode: { type: "boolean" },
            allowRegistration: { type: "boolean" },
            version: { type: "string" },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        const validatedData = systemConfigSchema.parse(request.body);

        // Buscar configuração existente
        let systemConfig = await db.systemConfig.findFirst();

        if (!systemConfig) {
          // Criar se não existir
          systemConfig = await db.systemConfig.create({
            data: {
              systemName: "AI System",
              systemTitle: "AI Management Platform",
              ...validatedData,
            },
          });
        } else {
          // Atualizar existente
          systemConfig = await db.systemConfig.update({
            where: { id: systemConfig.id },
            data: validatedData,
          });
        }

        logInfo("System configuration updated", {
          id: systemConfig.id,
          updatedFields: Object.keys(validatedData),
        });

        return formatResponse({
          data: systemConfig,
          message: "Configuração do sistema atualizada com sucesso",
        });
      } catch (error) {
        if (error instanceof z.ZodError) {
          return reply.status(400).send(
            formatResponse({
              success: false,
              message: "Dados inválidos",
              error: error.errors.map((err) => err.message).join(", "),
            })
          );
        }

        logError("Error updating system configuration", error as Error);
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );

  // PUT /system-config/upload - Upload images as base64
  fastify.put(
    "/upload",
    {
      schema: {
        tags: ["System Config"],
        description: "Upload system images as base64",
        body: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["logoUrl", "logoUrlDark", "faviconUrl"],
              description: "Type of image being uploaded",
            },
            base64: {
              type: "string",
              description: "Base64 encoded image data",
            },
            filename: {
              type: "string",
              description: "Original filename",
            },
          },
          required: ["type", "base64"],
        },
      },
    },
    async (request, reply) => {
      try {
        const { type, base64, filename } = request.body as {
          type: "logoUrl" | "logoUrlDark" | "faviconUrl";
          base64: string;
          filename?: string;
        };

        // Validate base64 format
        if (!base64.startsWith('data:image/')) {
          return reply.status(400).send({
            success: false,
            message: "Base64 deve começar com 'data:image/'",
          });
        }

        // Update system config with base64 image
        let systemConfig = await db.systemConfig.findFirst();

        if (!systemConfig) {
          systemConfig = await db.systemConfig.create({
            data: {
              systemName: "AI System",
              systemTitle: "AI Management Platform",
              [type]: base64,
            },
          });
        } else {
          systemConfig = await db.systemConfig.update({
            where: { id: systemConfig.id },
            data: { [type]: base64 },
          });
        }

        logInfo("System image uploaded", {
          type,
          filename: filename || 'unknown',
        });

        return formatResponse({
          data: {
            [type]: base64,
            type,
            filename: filename || 'unknown',
          },
          message: "Imagem enviada com sucesso",
        });
      } catch (error) {
        logError("Error uploading system image", error as Error);
        return sendError(reply, {
          status: 500,
          error: "Erro no upload da imagem",
        });
      }
    }
  );

  // GET /system-config/public - Get public system information (no auth required)
  fastify.get(
    "/public",
    {
      schema: {
        tags: ["System Config"],
        description:
          "Get public system information (no authentication required)",
        response: {
          200: {
            type: "object",
            properties: {
              success: { type: "boolean" },
              data: {
                type: "object",
                properties: {
                  systemName: { type: "string" },
                  systemTitle: { type: "string" },
                  systemDescription: { type: "string" },
                  seoTitle: { type: "string" },
                  seoDescription: { type: "string" },
                  seoKeywords: { type: "string" },
                  logoUrl: { type: "string" },
                  logoUrlDark: { type: "string" },
                  faviconUrl: { type: "string" },
                  primaryColor: { type: "string" },
                  secondaryColor: { type: "string" },
                  websiteUrl: { type: "string" },
                  maintenanceMode: { type: "boolean" },
                  allowRegistration: { type: "boolean" },
                  version: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
    async (request, reply) => {
      try {
        let systemConfig = await db.systemConfig.findFirst({
          select: {
            systemName: true,
            systemTitle: true,
            systemDescription: true,
            seoTitle: true,
            seoDescription: true,
            seoKeywords: true,
            logoUrl: true,
            logoUrlDark: true,
            faviconUrl: true,
            primaryColor: true,
            secondaryColor: true,
            websiteUrl: true,
            maintenanceMode: true,
            allowRegistration: true,
            version: true,
          },
        });

        if (!systemConfig) {
          // Retornar configuração padrão se não existir
          systemConfig = {
            systemName: "AI System",
            systemTitle: "AI Management Platform",
            systemDescription:
              "Sistema de Gerenciamento de IA com Evolution API",
            seoTitle: "AI Management Platform",
            seoDescription:
              "Plataforma completa para gerenciamento de agentes de IA",
            seoKeywords: null,
            logoUrl: null,
            logoUrlDark: null,
            faviconUrl: null,
            primaryColor: "#000000",
            secondaryColor: "#ffffff",
            websiteUrl: null,
            maintenanceMode: false,
            allowRegistration: true,
            version: "1.0.0",
          };
        }

        return formatResponse({ data: systemConfig });
      } catch (error) {
        logError("Error getting public system configuration", error as Error);
        return sendError(reply, {
          status: 500,
          error: "Erro interno do servidor",
        });
      }
    }
  );
}
