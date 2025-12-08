import { FastifyInstance, FastifyPluginOptions } from "fastify";
import { UsersController } from "@/controllers/users.controller";

export default async function (
  fastify: FastifyInstance,
  opts: FastifyPluginOptions
) {
  const usersController = new UsersController();

  // List all users
  fastify.get("/", async (request, reply) => {
    return usersController.listUsers(request, reply);
  });

  // Invite new user (must come before /:id to avoid route conflicts)
  fastify.post("/invite", async (request, reply) => {
    return usersController.inviteUser(request, reply);
  });

  // Get single user
  fastify.get("/:id", async (request, reply) => {
    return usersController.getUser(request, reply);
  });

  // Update user
  fastify.patch("/:id", async (request, reply) => {
    return usersController.updateUser(request, reply);
  });

  // Delete user
  fastify.delete("/:id", async (request, reply) => {
    return usersController.deleteUser(request, reply);
  });

  // Ban user
  fastify.post("/:id/ban", async (request, reply) => {
    return usersController.banUser(request, reply);
  });

  // Unban user
  fastify.post("/:id/unban", async (request, reply) => {
    return usersController.unbanUser(request, reply);
  });

  // Update metadata
  fastify.patch("/:id/metadata/:type", async (request, reply) => {
    return usersController.updateMetadata(request, reply);
  });
}
