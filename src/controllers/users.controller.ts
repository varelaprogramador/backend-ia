import { FastifyRequest, FastifyReply } from "fastify";
import { clerkClient } from "@clerk/fastify";

export class UsersController {
  // GET /users - List all users
  async listUsers(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { page = "1", limit = "50", query } = request.query as {
        page?: string;
        limit?: string;
        query?: string;
      };

      const pageNum = parseInt(page);
      const limitNum = parseInt(limit);
      const offset = (pageNum - 1) * limitNum;

      // Get users from Clerk
      const usersResponse = await clerkClient.users.getUserList({
        limit: limitNum,
        offset,
        ...(query && { query }),
      });

      return reply.code(200).send({
        success: true,
        data: usersResponse.data,
        total: usersResponse.totalCount,
        page: pageNum,
        limit: limitNum,
      });
    } catch (error) {
      console.error("Error listing users:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao listar usuários",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // GET /users/:id - Get single user
  async getUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const user = await clerkClient.users.getUser(id);

      return reply.code(200).send({
        success: true,
        data: user,
      });
    } catch (error) {
      console.error("Error getting user:", error);
      return reply.code(404).send({
        success: false,
        message: "Usuário não encontrado",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /users/invite - Invite new user
  async inviteUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { emailAddress, publicMetadata, redirectUrl } = request.body as {
        emailAddress: string;
        publicMetadata?: Record<string, any>;
        redirectUrl?: string;
      };

      if (!emailAddress) {
        return reply.code(400).send({
          success: false,
          message: "Email é obrigatório",
        });
      }

      const invitation = await clerkClient.invitations.createInvitation({
        emailAddress,
        publicMetadata: publicMetadata || {},
        redirectUrl: redirectUrl || undefined,
      });

      return reply.code(201).send({
        success: true,
        data: invitation,
        message: "Convite enviado com sucesso",
      });
    } catch (error) {
      console.error("Error inviting user:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao enviar convite",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // PATCH /users/:id - Update user
  async updateUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };
      const { firstName, lastName, publicMetadata, privateMetadata } =
        request.body as {
          firstName?: string;
          lastName?: string;
          publicMetadata?: Record<string, any>;
          privateMetadata?: Record<string, any>;
        };

      const updateData: any = {};
      if (firstName !== undefined) updateData.firstName = firstName;
      if (lastName !== undefined) updateData.lastName = lastName;
      if (publicMetadata !== undefined)
        updateData.publicMetadata = publicMetadata;
      if (privateMetadata !== undefined)
        updateData.privateMetadata = privateMetadata;

      const user = await clerkClient.users.updateUser(id, updateData);

      return reply.code(200).send({
        success: true,
        data: user,
        message: "Usuário atualizado com sucesso",
      });
    } catch (error) {
      console.error("Error updating user:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao atualizar usuário",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // DELETE /users/:id - Delete user
  async deleteUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      await clerkClient.users.deleteUser(id);

      return reply.code(200).send({
        success: true,
        message: "Usuário excluído com sucesso",
      });
    } catch (error) {
      console.error("Error deleting user:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao excluir usuário",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /users/:id/ban - Ban user
  async banUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const user = await clerkClient.users.banUser(id);

      return reply.code(200).send({
        success: true,
        data: user,
        message: "Usuário bloqueado com sucesso",
      });
    } catch (error) {
      console.error("Error banning user:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao bloquear usuário",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // POST /users/:id/unban - Unban user
  async unbanUser(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id } = request.params as { id: string };

      const user = await clerkClient.users.unbanUser(id);

      return reply.code(200).send({
        success: true,
        data: user,
        message: "Usuário desbloqueado com sucesso",
      });
    } catch (error) {
      console.error("Error unbanning user:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao desbloquear usuário",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }

  // PATCH /users/:id/metadata/:type - Update user metadata
  async updateMetadata(request: FastifyRequest, reply: FastifyReply) {
    try {
      const { id, type } = request.params as { id: string; type: string };
      const { metadata } = request.body as { metadata: Record<string, any> };

      if (!metadata) {
        return reply.code(400).send({
          success: false,
          message: "Metadata é obrigatória",
        });
      }

      if (type !== "public" && type !== "private") {
        return reply.code(400).send({
          success: false,
          message: "Tipo deve ser 'public' ou 'private'",
        });
      }

      const updateData =
        type === "public"
          ? { publicMetadata: metadata }
          : { privateMetadata: metadata };

      const user = await clerkClient.users.updateUser(id, updateData);

      return reply.code(200).send({
        success: true,
        data: user,
        message: "Metadata atualizada com sucesso",
      });
    } catch (error) {
      console.error("Error updating metadata:", error);
      return reply.code(500).send({
        success: false,
        message: "Erro ao atualizar metadata",
        error: error instanceof Error ? error.message : "Erro desconhecido",
      });
    }
  }
}
