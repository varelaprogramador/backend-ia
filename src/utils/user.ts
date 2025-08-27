import { clerkClient, type User } from '@clerk/fastify'

import { redis } from '@/lib/redis'

const USERS_CACHE_KEY = 'users:list'
const EMAIL_INDEX_KEY = 'users:email_index' // New: email -> userId mapping
const BATCH_SIZE = 50 // Chunk size for batch operations

/**
 * Busca um usuário no Clerk
 * @param userId - O ID do usuário
 * @returns O usuário ou null se não encontrado
 */
export const getUser = async (userId: string): Promise<User | null> => {
  try {
    // Primeiro tenta buscar no cache
    const cachedUser = await redis.hget(USERS_CACHE_KEY, userId)
    if (cachedUser) {
      return JSON.parse(cachedUser) as User
    }

    // Se não encontrar no cache, busca no Clerk
    const user = await clerkClient.users.getUser(userId)

    if (!user) {
      return null
    }

    // Atualiza o cache com o usuário encontrado
    await redis.hset(USERS_CACHE_KEY, userId, JSON.stringify(user))

    return {
      ...user,
    } as User
  } catch (error) {
    return null
  }
}

/**
 * Busca um usuário no Clerk pelo email
 * @param email - O email do usuário
 * @returns O usuário ou null se não encontrado
 */
export const getUserByEmail = async (email: string): Promise<User | null> => {
  try {
    const normalizedEmail = email?.toLowerCase()?.trim()

    // OTIMIZAÇÃO: Busca rápida no índice de emails O(1)
    const userId = await redis.hget(EMAIL_INDEX_KEY, normalizedEmail)
    if (userId) {
      const cachedUser = await redis.hget(USERS_CACHE_KEY, userId)
      if (cachedUser) {
        return JSON.parse(cachedUser) as User
      }
    }

    // Se não encontrar no cache, busca no Clerk
    const userList = await clerkClient.users.getUserList({
      emailAddress: [normalizedEmail],
      limit: 1,
    })

    const user = userList.data[0]
    if (user) {
      // Atualiza cache e índice usando pipeline
      const pipeline = redis.pipeline()
      pipeline.hset(USERS_CACHE_KEY, user.id, JSON.stringify(user))
      
      // Atualiza índice de emails
      for (const emailAddr of user.emailAddresses || []) {
        pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), user.id)
      }
      
      await pipeline.exec()
      return user
    }

    return null
  } catch (error) {
    return null
  }
}

/**
 * Cria um usuário no Clerk
 * @param user - O usuário a ser criado
 * @returns O usuário criado
 */
export const createUser = async (user: {
  email: string
  lastName?: string
  password?: string
  firstName?: string
  publicMetadata?: Record<string, any>
  unsafeMetadata?: Record<string, any>
  privateMetadata?: Record<string, any>
}) => {
  const createdUser = await clerkClient.users.createUser({
    skipPasswordChecks: true,
    emailAddress: [user.email],
    lastName: user.lastName || '',
    skipPasswordRequirement: true,
    firstName: user.firstName || '',
    publicMetadata: user.publicMetadata || {},
    unsafeMetadata: user.unsafeMetadata || {},
    privateMetadata: user.privateMetadata || {},
    ...(user.password && { password: user.password }),
  })

  // Adiciona o novo usuário ao cache e índice usando pipeline
  if (createdUser && createdUser.id) {
    try {
      const pipeline = redis.pipeline()
      pipeline.hset(USERS_CACHE_KEY, createdUser.id, JSON.stringify(createdUser))
      
      // Adiciona ao índice de emails
      for (const emailAddr of createdUser.emailAddresses || []) {
        pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), createdUser.id)
      }
      
      await pipeline.exec()
    } catch (error) {
      console.error('Failed to cache created user:', error)
    }
  }

  return createdUser
}

/**
 * Lista todos os usuários
 * @returns Array com todos os usuários
 */
export const getAllUsers = async (): Promise<User[]> => {
  try {
    // Primeiro tenta buscar todos os usuários do cache
    const cachedUsers = await redis.hgetall(USERS_CACHE_KEY)

    // Se o cache tem usuários, retorna eles
    if (cachedUsers && Object.keys(cachedUsers).length > 0) {
      return Object.values(cachedUsers).map(
        userJson => JSON.parse(userJson) as User,
      )
    }

    // Se o cache está vazio, busca todos os usuários do Clerk
    const users: User[] = []
    let hasMore = true
    let offset = 0
    const limit = 100

    while (hasMore) {
      const userList = await clerkClient.users.getUserList({
        limit,
        offset,
      })

      users.push(...userList.data)

      // OTIMIZAÇÃO: Adiciona usuários em batch usando pipeline
      if (userList.data.length > 0) {
        const pipeline = redis.pipeline()
        
        for (const user of userList.data) {
          pipeline.hset(USERS_CACHE_KEY, user.id, JSON.stringify(user))
          
          // Adiciona ao índice de emails
          for (const emailAddr of user.emailAddresses || []) {
            pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), user.id)
          }
        }
        
        await pipeline.exec()
      }

      hasMore = userList.totalCount > offset + limit
      offset += limit
    }

    return users
  } catch (error) {
    console.error('Failed to get all users:', error)
    return []
  }
}

/**
 * Busca usuários com base em um array de IDs
 * @param userIds - Array de IDs dos usuários
 * @returns Array com os usuários encontrados
 */
export const getUsersByIds = async (userIds: string[]): Promise<User[]> => {
  try {
    if (!userIds || userIds.length === 0) {
      return []
    }

    const users: User[] = []
    const missingIds: string[] = []

    // OTIMIZAÇÃO: Usa HMGET para buscar apenas os IDs solicitados
    const cachedUserData = await redis.hmget(USERS_CACHE_KEY, ...userIds)

    for (let i = 0; i < userIds.length; i++) {
      const userData = cachedUserData[i]
      if (userData) {
        users.push(JSON.parse(userData) as User)
      } else {
        missingIds.push(userIds[i])
      }
    }

    // Se houver IDs faltando, busca no Clerk
    if (missingIds.length > 0) {
      // OTIMIZAÇÃO: Processa em chunks para evitar timeout
      const chunks = []
      for (let i = 0; i < missingIds.length; i += BATCH_SIZE) {
        chunks.push(missingIds.slice(i, i + BATCH_SIZE))
      }

      const pipeline = redis.pipeline()
      
      for (const chunk of chunks) {
        const userList = await clerkClient.users.getUserList({
          userId: chunk,
          limit: chunk.length,
        })

        for (const user of userList.data) {
          users.push(user)
          
          // Adiciona ao cache usando pipeline
          pipeline.hset(USERS_CACHE_KEY, user.id, JSON.stringify(user))
          
          // Adiciona ao índice de emails
          for (const emailAddr of user.emailAddresses || []) {
            pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), user.id)
          }
        }
      }
      
      if (pipeline.length > 0) {
        await pipeline.exec()
      }
    }

    return users
  } catch (error) {
    console.error('Failed to get users by IDs:', error)
    return []
  }
}

/**
 * Busca um usuário por email e se não encontrar, cria um novo
 * @param userData - Os dados do usuário a ser criado caso não exista
 * @returns O usuário encontrado ou criado
 */
export const findOrCreateUserByEmail = async (userData: {
  email: string
  firstName?: string
  lastName?: string
  password?: string
  publicMetadata?: Record<string, any>
  unsafeMetadata?: Record<string, any>
  privateMetadata?: Record<string, any>
}): Promise<User> => {
  const existingUser = await getUserByEmail(userData.email)

  if (existingUser) {
    return existingUser
  }

  return await createUser(userData)
}

/**
 * Busca um usuário por email e atualiza se existir, ou cria se não existir
 * @param userData - Os dados do usuário a ser criado/atualizado
 * @returns O usuário criado ou atualizado
 */
export const findOrUpdateUserByEmail = async (userData: {
  email: string
  firstName?: string
  lastName?: string
  password?: string
  publicMetadata?: Record<string, any>
  unsafeMetadata?: Record<string, any>
  privateMetadata?: Record<string, any>
}): Promise<{ user: User; isNewUser: boolean }> => {
  let isNewUser = true
  const existingUser = await getUserByEmail(userData.email)

  if (existingUser) {
    isNewUser = false
    // Atualiza o usuário existente fazendo merge dos metadados
    const updatedUser = await clerkClient.users.updateUser(existingUser.id, {
      firstName: userData.firstName,
      lastName: userData.lastName,
      publicMetadata: userData.publicMetadata 
        ? { ...existingUser.publicMetadata, ...userData.publicMetadata }
        : existingUser.publicMetadata,
      unsafeMetadata: userData.unsafeMetadata
        ? { ...existingUser.unsafeMetadata, ...userData.unsafeMetadata }
        : existingUser.unsafeMetadata,
      privateMetadata: userData.privateMetadata
        ? { ...existingUser.privateMetadata, ...userData.privateMetadata }
        : existingUser.privateMetadata,
      ...(userData.password && { password: userData.password }),
    })

    // Atualiza cache e índice usando pipeline
    if (updatedUser && updatedUser.id) {
      try {
        const pipeline = redis.pipeline()
        pipeline.hset(USERS_CACHE_KEY, updatedUser.id, JSON.stringify(updatedUser))
        
        // Remove emails antigos do índice
        if (existingUser.emailAddresses) {
          for (const emailAddr of existingUser.emailAddresses) {
            pipeline.hdel(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase())
          }
        }
        
        // Adiciona novos emails ao índice
        for (const emailAddr of updatedUser.emailAddresses || []) {
          pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), updatedUser.id)
        }
        
        await pipeline.exec()
      } catch (error) {
        console.error('Failed to cache updated user:', error)
      }
    }

    return {
      user: updatedUser,
      isNewUser,
    }
  }

  // Se não existir, cria um novo
  return {
    user: await createUser(userData),
    isNewUser,
  }
}
