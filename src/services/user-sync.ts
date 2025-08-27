import { clerkClient, type User } from '@clerk/fastify'

import { redis } from '@/lib/redis'
import { logError, logInfo } from '@/utils/logger'

const USERS_CACHE_KEY = 'users:list'
const EMAIL_INDEX_KEY = 'users:email_index'
const BATCH_SIZE = 50 // Parallel batch size
const MAX_CONCURRENT_REQUESTS = 3 // Limit concurrent Clerk API calls

export class UserSyncService {
  private static instance: UserSyncService
  private isSyncing = false

  private constructor() {}

  static getInstance(): UserSyncService {
    if (!UserSyncService.instance) {
      UserSyncService.instance = new UserSyncService()
    }
    return UserSyncService.instance
  }

  async syncUsersWithCache(): Promise<void> {
    if (this.isSyncing) {
      logInfo('User sync already in progress, skipping...')
      return
    }

    this.isSyncing = true
    const syncStartTime = Date.now()

    try {
      logInfo('Starting user synchronization with cache...')

      // Fetch all users from Clerk
      const clerkUsers = await this.fetchAllUsersFromClerk()
      logInfo(`Fetched ${clerkUsers.length} users from Clerk`)

      // Get current cached users
      const cachedUsers = await this.getCachedUsers()
      logInfo(`Found ${Object.keys(cachedUsers).length} users in cache`)

      // Sync users
      const syncResult = await this.performSync(clerkUsers, cachedUsers)

      const syncDuration = Date.now() - syncStartTime
      logInfo('User synchronization completed', {
        duration: `${syncDuration}ms`,
        ...syncResult,
      })
    } catch (error) {
      logError('Failed to sync users with cache', error as Error)
    } finally {
      this.isSyncing = false
    }
  }

  private async fetchAllUsersFromClerk(): Promise<User[]> {
    // First, get total count to determine parallelization strategy
    const initialList = await clerkClient.users.getUserList({ limit: 1 })
    const totalUsers = initialList.totalCount
    
    if (totalUsers <= 100) {
      // Small dataset, single request
      const userList = await clerkClient.users.getUserList({ limit: totalUsers })
      return userList.data
    }

    // OTIMIZAÇÃO: Paraleliza requests para grandes datasets
    const limit = 100
    const totalPages = Math.ceil(totalUsers / limit)
    const batches: number[][] = []
    
    // Create batches of offsets to process in parallel
    for (let i = 0; i < totalPages; i += MAX_CONCURRENT_REQUESTS) {
      const batch = []
      for (let j = 0; j < MAX_CONCURRENT_REQUESTS && i + j < totalPages; j++) {
        batch.push((i + j) * limit)
      }
      batches.push(batch)
    }

    const users: User[] = []
    
    // Process batches sequentially, but parallelize within each batch
    for (const batch of batches) {
      const promises = batch.map(offset =>
        clerkClient.users.getUserList({ limit, offset })
      )
      
      const results = await Promise.all(promises)
      for (const result of results) {
        users.push(...result.data)
      }
    }

    return users
  }

  private async getCachedUsers(): Promise<Record<string, User>> {
    try {
      const cachedData = await redis.hgetall(USERS_CACHE_KEY)
      const cachedUsers: Record<string, User> = {}

      for (const [userId, userJson] of Object.entries(cachedData)) {
        try {
          cachedUsers[userId] = JSON.parse(userJson) as User
        } catch (parseError) {
          logError(`Failed to parse cached user ${userId}`, parseError as Error)
          // Remove invalid cached data
          await redis.hdel(USERS_CACHE_KEY, userId)
        }
      }

      return cachedUsers
    } catch (error) {
      logError('Failed to get cached users', error as Error)
      return {}
    }
  }

  private async performSync(
    clerkUsers: User[],
    cachedUsers: Record<string, User>,
  ): Promise<{
    added: number
    updated: number
    removed: number
    errors: number
  }> {
    let added = 0
    let updated = 0
    let removed = 0
    let errors = 0

    // Create a map of Clerk users for efficient lookup
    const clerkUsersMap = new Map<string, User>()
    for (const user of clerkUsers) {
      clerkUsersMap.set(user.id, user)
    }

    // OTIMIZAÇÃO: Usa pipeline para batch operations
    const pipeline = redis.pipeline()
    const operationsToAdd: { type: string, userId: string, user?: User }[] = []

    // Prepare add/update operations
    for (const user of clerkUsers) {
      try {
        const cachedUser = cachedUsers[user.id]

        if (!cachedUser) {
          // User not in cache, add it
          pipeline.hset(USERS_CACHE_KEY, user.id, JSON.stringify(user))
          
          // Add to email index
          for (const emailAddr of user.emailAddresses || []) {
            pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), user.id)
          }
          
          operationsToAdd.push({ type: 'add', userId: user.id, user })
          added++
        } else {
          // Check if user data has changed (optimized)
          const hasChanged = this.hasUserDataChanged(user, cachedUser)

          if (hasChanged) {
            pipeline.hset(USERS_CACHE_KEY, user.id, JSON.stringify(user))
            
            // Update email index (remove old, add new)
            if (cachedUser.emailAddresses) {
              for (const emailAddr of cachedUser.emailAddresses) {
                pipeline.hdel(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase())
              }
            }
            
            for (const emailAddr of user.emailAddresses || []) {
              pipeline.hset(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase(), user.id)
            }
            
            operationsToAdd.push({ type: 'update', userId: user.id, user })
            updated++
          }
        }
      } catch (error) {
        logError(`Failed to prepare sync for user ${user.id}`, error as Error)
        errors++
      }
    }

    // Prepare remove operations  
    for (const userId of Object.keys(cachedUsers)) {
      if (!clerkUsersMap.has(userId)) {
        try {
          pipeline.hdel(USERS_CACHE_KEY, userId)
          
          // Remove from email index
          const cachedUser = cachedUsers[userId]
          if (cachedUser.emailAddresses) {
            for (const emailAddr of cachedUser.emailAddresses) {
              pipeline.hdel(EMAIL_INDEX_KEY, emailAddr.emailAddress.toLowerCase())
            }
          }
          
          operationsToAdd.push({ type: 'remove', userId })
          removed++
        } catch (error) {
          logError(`Failed to prepare removal of user ${userId}`, error as Error)
          errors++
        }
      }
    }

    // OTIMIZAÇÃO: Execute all operations in single pipeline
    if (pipeline.length > 0) {
      try {
        await pipeline.exec()
        logInfo(`Batch sync completed: ${operationsToAdd.length} operations executed`)
      } catch (error) {
        logError('Failed to execute batch sync pipeline', error as Error)
        errors += operationsToAdd.length
        added = updated = removed = 0
      }
    }

    return { added, updated, removed, errors }
  }

  private hasUserDataChanged(clerkUser: User, cachedUser: User): boolean {
    // OTIMIZAÇÃO: Comparação mais eficiente sem JSON.stringify custoso
    
    // Quick check: updatedAt timestamp (most reliable indicator)
    if (clerkUser.updatedAt !== cachedUser.updatedAt) {
      return true
    }
    
    // Fast string comparisons
    if (clerkUser.firstName !== cachedUser.firstName ||
        clerkUser.lastName !== cachedUser.lastName ||
        clerkUser.imageUrl !== cachedUser.imageUrl) {
      return true
    }
    
    // Array length comparisons (quick)
    if ((clerkUser.emailAddresses?.length || 0) !== (cachedUser.emailAddresses?.length || 0) ||
        (clerkUser.phoneNumbers?.length || 0) !== (cachedUser.phoneNumbers?.length || 0)) {
      return true
    }
    
    // Email addresses comparison (more efficient)
    if (clerkUser.emailAddresses && cachedUser.emailAddresses) {
      for (let i = 0; i < clerkUser.emailAddresses.length; i++) {
        if (clerkUser.emailAddresses[i].emailAddress !== cachedUser.emailAddresses[i]?.emailAddress) {
          return true
        }
      }
    }
    
    // Only use JSON.stringify for complex objects as last resort
    const clerkMetadataHash = this.hashMetadata(clerkUser)
    const cachedMetadataHash = this.hashMetadata(cachedUser) 
    
    return clerkMetadataHash !== cachedMetadataHash
  }
  
  private hashMetadata(user: User): string {
    // Simple hash for metadata comparison (more efficient than JSON.stringify)
    const metadata = {
      pub: user.publicMetadata,
      priv: user.privateMetadata, 
      unsafe: user.unsafeMetadata
    }
    
    return JSON.stringify(metadata)
  }

  async getCacheStats(): Promise<{
    totalUsers: number
    cacheSize: string
    lastSync?: string
  }> {
    try {
      const cachedUsers = await redis.hgetall(USERS_CACHE_KEY)
      const totalUsers = Object.keys(cachedUsers).length

      // Calculate approximate cache size
      const cacheSize = Object.values(cachedUsers).reduce(
        (size, userData) => size + userData.length,
        0,
      )

      return {
        totalUsers,
        cacheSize: this.formatBytes(cacheSize),
      }
    } catch (error) {
      logError('Failed to get cache stats', error as Error)
      return {
        totalUsers: 0,
        cacheSize: '0 B',
      }
    }
  }

  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B'

    const k = 1024
    const sizes = ['B', 'KB', 'MB', 'GB']
    const i = Math.floor(Math.log(bytes) / Math.log(k))

    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
  }
}
