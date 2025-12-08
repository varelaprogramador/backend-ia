import { FastifyInstance, FastifyPluginOptions } from "fastify";
import axios from "axios";

export default async function (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions
) {
  // Verificar credenciais e buscar pipelines do Kommo
  fastify.post("/verify", async (request, reply) => {
    try {
      const { subdomain, accessToken } = request.body as {
        subdomain: string;
        accessToken: string;
      };

      if (!subdomain || !accessToken) {
        return reply.code(400).send({
          success: false,
          message: "Subdomínio e access token são obrigatórios",
        });
      }

      const url = `https://${subdomain}.kommo.com/api/v4/leads/pipelines`;
      const response = await axios.get(url, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      return reply.code(200).send({
        success: true,
        data: response.data,
      });
    } catch (error) {
      console.error("Error verifying Kommo credentials:", error);

      if (axios.isAxiosError(error)) {
        if (error.response) {
          const status = error.response.status;
          return reply.code(status).send({
            success: false,
            message:
              status === 401
                ? "Access token inválido ou expirado"
                : `Erro ${status}: Verifique o subdomínio e tente novamente`,
            error: error.response.data,
          });
        } else if (error.request) {
          return reply.code(503).send({
            success: false,
            message:
              "Não foi possível conectar à API do Kommo. Verifique sua conexão.",
          });
        }
      }

      return reply.code(500).send({
        success: false,
        message: "Erro ao verificar credenciais do Kommo",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  });
}
