import { clerkClient, type User } from "@clerk/fastify";
import type { Prisma } from "@/generated/prisma";

import { db } from "@/lib/db";

const BATCH_SIZE = 50; // Chunk size for batch operations

/**
 * Busca um usuário na base de dados local ou no Clerk
 * @param userId - O ID do usuário
 * @returns O usuário ou null se não encontrado
 */
export const getUser = async (userId: string): Promise<User | null> => {
  try {
    // Primeiro tenta buscar na base de dados local
    const dbUser = await db.user.findUnique({
      where: { id: userId },
    });

    if (dbUser) {
      // Converte o usuário da base de dados para o formato Clerk
      return {
        id: dbUser.id,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        imageUrl: dbUser.imageUrl,
        hasImage: dbUser.hasImage,
        primaryEmailAddressId: dbUser.primaryEmailId,
        emailAddresses: dbUser.emailAddresses as any,
        phoneNumbers: dbUser.phoneNumbers as any,
        externalAccounts: dbUser.externalAccounts as any,
        publicMetadata: dbUser.publicMetadata as any,
        privateMetadata: dbUser.privateMetadata as any,
        unsafeMetadata: dbUser.unsafeMetadata as any,
        username: dbUser.username,
        passwordEnabled: dbUser.passwordEnabled,
        totpEnabled: dbUser.totpEnabled,
        backupCodeEnabled: dbUser.backupCodeEnabled,
        twoFactorEnabled: dbUser.twoFactorEnabled,
        banned: dbUser.banned,
        locked: dbUser.locked,
        createdAt: dbUser.createdAt.getTime(),
        updatedAt: dbUser.updatedAt.getTime(),
        lastSignInAt: dbUser.lastSignInAt?.getTime() || null,
        lastActiveAt: dbUser.lastActiveAt?.getTime() || null,
      } as User;
    }

    // Se não encontrar na base local, busca no Clerk
    const user = await clerkClient.users.getUser(userId);
    return user || null;
  } catch (error) {
    return null;
  }
};

/**
 * Busca um usuário na base de dados local ou no Clerk pelo email
 * @param email - O email do usuário
 * @returns O usuário ou null se não encontrado
 */
export const getUserByEmail = async (email: string): Promise<User | null> => {
  try {
    const normalizedEmail = email?.toLowerCase()?.trim();

    // Busca na base de dados local usando JSON path para emailAddresses
    const dbUser = await db.user.findFirst({
      where: {
        emailAddresses: {
          path: ["$[*].emailAddress"],
          array_contains: [normalizedEmail],
        },
      },
    });

    if (dbUser) {
      // Converte o usuário da base de dados para o formato Clerk
      return {
        id: dbUser.id,
        firstName: dbUser.firstName,
        lastName: dbUser.lastName,
        imageUrl: dbUser.imageUrl,
        hasImage: dbUser.hasImage,
        primaryEmailAddressId: dbUser.primaryEmailId,
        emailAddresses: dbUser.emailAddresses as any,
        phoneNumbers: dbUser.phoneNumbers as any,
        externalAccounts: dbUser.externalAccounts as any,
        publicMetadata: dbUser.publicMetadata as any,
        privateMetadata: dbUser.privateMetadata as any,
        unsafeMetadata: dbUser.unsafeMetadata as any,
        username: dbUser.username,
        passwordEnabled: dbUser.passwordEnabled,
        totpEnabled: dbUser.totpEnabled,
        backupCodeEnabled: dbUser.backupCodeEnabled,
        twoFactorEnabled: dbUser.twoFactorEnabled,
        banned: dbUser.banned,
        locked: dbUser.locked,
        createdAt: dbUser.createdAt.getTime(),
        updatedAt: dbUser.updatedAt.getTime(),
        lastSignInAt: dbUser.lastSignInAt?.getTime() || null,
        lastActiveAt: dbUser.lastActiveAt?.getTime() || null,
      } as User;
    }

    // Se não encontrar na base local, busca no Clerk
    const userList = await clerkClient.users.getUserList({
      emailAddress: [normalizedEmail],
      limit: 1,
    });

    return userList.data[0] || null;
  } catch (error) {
    return null;
  }
};

/**
 * Cria um usuário no Clerk e sincroniza com a base de dados local
 * @param user - O usuário a ser criado
 * @returns O usuário criado
 */
export const createUser = async (user: {
  email: string;
  lastName?: string;
  password?: string;
  firstName?: string;
  publicMetadata?: Record<string, any>;
  unsafeMetadata?: Record<string, any>;
  privateMetadata?: Record<string, any>;
}) => {
  const createdUser = await clerkClient.users.createUser({
    skipPasswordChecks: true,
    emailAddress: [user.email],
    lastName: user.lastName || "",
    skipPasswordRequirement: true,
    firstName: user.firstName || "",
    publicMetadata: (user.publicMetadata || {}) as any,
    unsafeMetadata: (user.unsafeMetadata || {}) as any,
    privateMetadata: (user.privateMetadata || {}) as any,
    ...(user.password && { password: user.password }),
  });

  // Adiciona o novo usuário à base de dados local
  if (createdUser && createdUser.id) {
    try {
      await db.user.create({
        data: {
          id: createdUser.id,
          firstName: createdUser.firstName,
          lastName: createdUser.lastName,
          imageUrl: createdUser.imageUrl,
          hasImage: createdUser.hasImage,
          primaryEmailId: createdUser.primaryEmailAddressId,
          emailAddresses:
            createdUser.emailAddresses as unknown as Prisma.InputJsonValue,
          phoneNumbers:
            createdUser.phoneNumbers as unknown as Prisma.InputJsonValue,
          externalAccounts:
            createdUser.externalAccounts as unknown as Prisma.InputJsonValue,
          publicMetadata:
            createdUser.publicMetadata as unknown as Prisma.InputJsonValue,
          privateMetadata:
            createdUser.privateMetadata as unknown as Prisma.InputJsonValue,
          unsafeMetadata:
            createdUser.unsafeMetadata as unknown as Prisma.InputJsonValue,
          username: createdUser.username,
          passwordEnabled: createdUser.passwordEnabled,
          totpEnabled: createdUser.totpEnabled,
          backupCodeEnabled: createdUser.backupCodeEnabled,
          twoFactorEnabled: createdUser.twoFactorEnabled,
          banned: createdUser.banned,
          locked: createdUser.locked,
          lastSignInAt: createdUser.lastSignInAt
            ? new Date(createdUser.lastSignInAt)
            : null,
          lastActiveAt: createdUser.lastActiveAt
            ? new Date(createdUser.lastActiveAt)
            : null,
        },
      });
    } catch (error) {
      console.error("Failed to save created user to database:", error);
    }
  }

  return createdUser;
};

/**
 * Lista todos os usuários da base de dados local
 * @returns Array com todos os usuários
 */
export const getAllUsers = async (): Promise<User[]> => {
  try {
    // Busca todos os usuários da base de dados local
    const dbUsers = await db.user.findMany({
      orderBy: { createdAt: "desc" },
    });

    // Converte os usuários da base de dados para o formato Clerk
    return dbUsers.map(
      (dbUser) =>
        ({
          id: dbUser.id,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          imageUrl: dbUser.imageUrl,
          hasImage: dbUser.hasImage,
          primaryEmailAddressId: dbUser.primaryEmailId,
          emailAddresses: dbUser.emailAddresses as any,
          phoneNumbers: dbUser.phoneNumbers as any,
          externalAccounts: dbUser.externalAccounts as any,
          publicMetadata: dbUser.publicMetadata as any,
          privateMetadata: dbUser.privateMetadata as any,
          unsafeMetadata: dbUser.unsafeMetadata as any,
          username: dbUser.username,
          passwordEnabled: dbUser.passwordEnabled,
          totpEnabled: dbUser.totpEnabled,
          backupCodeEnabled: dbUser.backupCodeEnabled,
          twoFactorEnabled: dbUser.twoFactorEnabled,
          banned: dbUser.banned,
          locked: dbUser.locked,
          createdAt: dbUser.createdAt.getTime(),
          updatedAt: dbUser.updatedAt.getTime(),
          lastSignInAt: dbUser.lastSignInAt?.getTime() || null,
          lastActiveAt: dbUser.lastActiveAt?.getTime() || null,
        }) as User
    );
  } catch (error) {
    console.error("Failed to get all users from database:", error);
    return [];
  }
};

/**
 * Busca usuários com base em um array de IDs
 * @param userIds - Array de IDs dos usuários
 * @returns Array com os usuários encontrados
 */
export const getUsersByIds = async (userIds: string[]): Promise<User[]> => {
  try {
    if (!userIds || userIds.length === 0) {
      return [];
    }

    // Busca os usuários na base de dados local
    const dbUsers = await db.user.findMany({
      where: {
        id: {
          in: userIds,
        },
      },
    });

    // Converte os usuários da base de dados para o formato Clerk
    const users = dbUsers.map(
      (dbUser) =>
        ({
          id: dbUser.id,
          firstName: dbUser.firstName,
          lastName: dbUser.lastName,
          imageUrl: dbUser.imageUrl,
          hasImage: dbUser.hasImage,
          primaryEmailAddressId: dbUser.primaryEmailId,
          emailAddresses: dbUser.emailAddresses as any,
          phoneNumbers: dbUser.phoneNumbers as any,
          externalAccounts: dbUser.externalAccounts as any,
          publicMetadata: dbUser.publicMetadata as any,
          privateMetadata: dbUser.privateMetadata as any,
          unsafeMetadata: dbUser.unsafeMetadata as any,
          username: dbUser.username,
          passwordEnabled: dbUser.passwordEnabled,
          totpEnabled: dbUser.totpEnabled,
          backupCodeEnabled: dbUser.backupCodeEnabled,
          twoFactorEnabled: dbUser.twoFactorEnabled,
          banned: dbUser.banned,
          locked: dbUser.locked,
          createdAt: dbUser.createdAt.getTime(),
          updatedAt: dbUser.updatedAt.getTime(),
          lastSignInAt: dbUser.lastSignInAt?.getTime() || null,
          lastActiveAt: dbUser.lastActiveAt?.getTime() || null,
        }) as User
    );

    // Se algum ID não foi encontrado na base local, busca no Clerk
    const foundIds = users.map((u) => u.id);
    const missingIds = userIds.filter((id) => !foundIds.includes(id));

    if (missingIds.length > 0) {
      // Processa em chunks para evitar timeout
      const chunks = [];
      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        chunks.push(missingIds.slice(i, i + BATCH_SIZE));
      }

      for (const chunk of chunks) {
        const userList = await clerkClient.users.getUserList({
          userId: chunk,
          limit: chunk.length,
        });

        users.push(...userList.data);
      }
    }

    return users;
  } catch (error) {
    console.error("Failed to get users by IDs:", error);
    return [];
  }
};

/**
 * Busca um usuário por email e se não encontrar, cria um novo
 * @param userData - Os dados do usuário a ser criado caso não exista
 * @returns O usuário encontrado ou criado
 */
export const findOrCreateUserByEmail = async (userData: {
  email: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  publicMetadata?: Record<string, any>;
  unsafeMetadata?: Record<string, any>;
  privateMetadata?: Record<string, any>;
}): Promise<User> => {
  const existingUser = await getUserByEmail(userData.email);

  if (existingUser) {
    return existingUser;
  }

  return await createUser(userData);
};

/**
 * Busca um usuário por email e atualiza se existir, ou cria se não existir
 * @param userData - Os dados do usuário a ser criado/atualizado
 * @returns O usuário criado ou atualizado
 */
export const findOrUpdateUserByEmail = async (userData: {
  email: string;
  firstName?: string;
  lastName?: string;
  password?: string;
  publicMetadata?: Record<string, any>;
  unsafeMetadata?: Record<string, any>;
  privateMetadata?: Record<string, any>;
}): Promise<{ user: User; isNewUser: boolean }> => {
  let isNewUser = true;
  const existingUser = await getUserByEmail(userData.email);

  if (existingUser) {
    isNewUser = false;
    // Atualiza o usuário existente fazendo merge dos metadados
    const updatedUser = await clerkClient.users.updateUser(existingUser.id, {
      firstName: userData.firstName,
      lastName: userData.lastName,
      publicMetadata: (userData.publicMetadata
        ? {
            ...(existingUser.publicMetadata as any),
            ...(userData.publicMetadata as any),
          }
        : (existingUser.publicMetadata as any)) as any,
      unsafeMetadata: userData.unsafeMetadata
        ? { ...existingUser.unsafeMetadata, ...userData.unsafeMetadata }
        : existingUser.unsafeMetadata,
      privateMetadata: userData.privateMetadata
        ? { ...existingUser.privateMetadata, ...userData.privateMetadata }
        : existingUser.privateMetadata,
      ...(userData.password && { password: userData.password }),
    });

    // Atualiza o usuário na base de dados local
    if (updatedUser && updatedUser.id) {
      try {
        await db.user.update({
          where: { id: updatedUser.id },
          data: {
            firstName: updatedUser.firstName,
            lastName: updatedUser.lastName,
            imageUrl: updatedUser.imageUrl,
            hasImage: updatedUser.hasImage,
            primaryEmailId: updatedUser.primaryEmailAddressId,
            emailAddresses: JSON.stringify(updatedUser.emailAddresses),
            phoneNumbers: JSON.stringify(updatedUser.phoneNumbers),
            externalAccounts: JSON.stringify(updatedUser.externalAccounts),
            publicMetadata: JSON.stringify(updatedUser.publicMetadata),
            privateMetadata: JSON.stringify(updatedUser.privateMetadata),
            unsafeMetadata: JSON.stringify(updatedUser.unsafeMetadata),
            username: updatedUser.username,
            passwordEnabled: updatedUser.passwordEnabled,
            totpEnabled: updatedUser.totpEnabled,
            backupCodeEnabled: updatedUser.backupCodeEnabled,
            twoFactorEnabled: updatedUser.twoFactorEnabled,
            banned: updatedUser.banned,
            locked: updatedUser.locked,
            lastSignInAt: updatedUser.lastSignInAt
              ? new Date(updatedUser.lastSignInAt)
              : null,
            lastActiveAt: updatedUser.lastActiveAt
              ? new Date(updatedUser.lastActiveAt)
              : null,
          },
        });
      } catch (error) {
        console.error("Failed to update user in database:", error);
      }
    }

    return {
      user: updatedUser,
      isNewUser,
    };
  }

  // Se não existir, cria um novo
  return {
    user: await createUser(userData),
    isNewUser,
  };
};
