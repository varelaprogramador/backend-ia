import { clerkClient, type User } from '@clerk/fastify'

import { db } from '@/lib/db'
import { logError, logInfo } from '@/utils/logger'

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

  async syncUsersWithDatabase(): Promise<{
    added: number
    updated: number
    removed: number
    errors: number
  }> {
    if (this.isSyncing) {
      logInfo('User sync already in progress, skipping...')
      return { added: 0, updated: 0, removed: 0, errors: 0 }
    }

    this.isSyncing = true
    const syncStartTime = Date.now()

    try {
      logInfo('Starting user synchronization with database...')

      // Fetch all users from Clerk
      const clerkUsers = await this.fetchAllUsersFromClerk()
      logInfo(`Fetched ${clerkUsers.length} users from Clerk`)

      // Get current database users
      const dbUsers = await this.getDatabaseUsers()
      logInfo(`Found ${Object.keys(dbUsers).length} users in database`)

      // Sync users
      const syncResult = await this.performSync(clerkUsers, dbUsers)

      const syncDuration = Date.now() - syncStartTime
      logInfo('User synchronization completed', {
        duration: `${syncDuration}ms`,
        ...syncResult,
      })

      return syncResult
    } catch (error) {
      logError('Failed to sync users with database', error as Error)
      return { added: 0, updated: 0, removed: 0, errors: 1 }
    } finally {
      this.isSyncing = false
    }
  }

  // Legacy method for backwards compatibility
  async syncUsersWithCache(): Promise<void> {
    await this.syncUsersWithDatabase()
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

  private async getDatabaseUsers(): Promise<Record<string, User>> {
    try {
      const dbUsers = await db.user.findMany()
      const users: Record<string, User> = {}

      for (const dbUser of dbUsers) {
        users[dbUser.id] = {
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
        } as User
      }

      return users
    } catch (error) {
      logError('Failed to get database users', error as Error)
      return {}
    }
  }

  private async performSync(
    clerkUsers: User[],
    dbUsers: Record<string, User>,
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

    // Process add/update operations
    const usersToCreate: any[] = []
    const usersToUpdate: { id: string; data: any }[] = []

    for (const user of clerkUsers) {
      try {
        const dbUser = dbUsers[user.id]

        if (!dbUser) {
          // User not in database, add it
          usersToCreate.push({
            id: user.id,
            firstName: user.firstName,
            lastName: user.lastName,
            imageUrl: user.imageUrl,
            hasImage: user.hasImage,
            primaryEmailId: user.primaryEmailAddressId,
            emailAddresses: user.emailAddresses,
            phoneNumbers: user.phoneNumbers,
            externalAccounts: user.externalAccounts,
            publicMetadata: user.publicMetadata,
            privateMetadata: user.privateMetadata,
            unsafeMetadata: user.unsafeMetadata,
            username: user.username,
            passwordEnabled: user.passwordEnabled,
            totpEnabled: user.totpEnabled,
            backupCodeEnabled: user.backupCodeEnabled,
            twoFactorEnabled: user.twoFactorEnabled,
            banned: user.banned,
            locked: user.locked,
            lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt) : null,
            lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt) : null,
          })
          added++
        } else {
          // Check if user data has changed
          const hasChanged = this.hasUserDataChanged(user, dbUser)

          if (hasChanged) {
            usersToUpdate.push({
              id: user.id,
              data: {
                firstName: user.firstName,
                lastName: user.lastName,
                imageUrl: user.imageUrl,
                hasImage: user.hasImage,
                primaryEmailId: user.primaryEmailAddressId,
                emailAddresses: user.emailAddresses,
                phoneNumbers: user.phoneNumbers,
                externalAccounts: user.externalAccounts,
                publicMetadata: user.publicMetadata,
                privateMetadata: user.privateMetadata,
                unsafeMetadata: user.unsafeMetadata,
                username: user.username,
                passwordEnabled: user.passwordEnabled,
                totpEnabled: user.totpEnabled,
                backupCodeEnabled: user.backupCodeEnabled,
                twoFactorEnabled: user.twoFactorEnabled,
                banned: user.banned,
                locked: user.locked,
                lastSignInAt: user.lastSignInAt ? new Date(user.lastSignInAt) : null,
                lastActiveAt: user.lastActiveAt ? new Date(user.lastActiveAt) : null,
              },
            })
            updated++
          }
        }
      } catch (error) {
        logError(`Failed to prepare sync for user ${user.id}`, error as Error)
        errors++
      }
    }

    // Find users to remove (exist in database but not in Clerk)
    const usersToRemove: string[] = []
    for (const userId of Object.keys(dbUsers)) {
      if (!clerkUsersMap.has(userId)) {
        usersToRemove.push(userId)
        removed++
      }
    }

    // Execute database operations in transaction
    try {
      await db.$transaction(async (tx) => {
        // Create new users
        if (usersToCreate.length > 0) {
          await tx.user.createMany({
            data: usersToCreate,
            skipDuplicates: true,
          })
        }

        // Update existing users
        for (const userUpdate of usersToUpdate) {
          await tx.user.update({
            where: { id: userUpdate.id },
            data: userUpdate.data,
          })
        }

        // Remove users that no longer exist in Clerk
        if (usersToRemove.length > 0) {
          await tx.user.deleteMany({
            where: {
              id: {
                in: usersToRemove,
              },
            },
          })
        }
      })

      logInfo(`Database sync completed: ${added} added, ${updated} updated, ${removed} removed`)
    } catch (error) {
      logError('Failed to execute database sync transaction', error as Error)
      errors++
      added = updated = removed = 0
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

  async getDatabaseStats(): Promise<{
    totalUsers: number
    recentUsers: number
    lastSync?: string
  }> {
    try {
      const [totalUsers, recentUsers] = await Promise.all([
        db.user.count(),
        db.user.count({
          where: {
            createdAt: {
              gte: new Date(Date.now() - 24 * 60 * 60 * 1000), // Last 24 hours
            },
          },
        }),
      ])

      return {
        totalUsers,
        recentUsers,
      }
    } catch (error) {
      logError('Failed to get database stats', error as Error)
      return {
        totalUsers: 0,
        recentUsers: 0,
      }
    }
  }

  // Legacy method for backwards compatibility
  async getCacheStats(): Promise<{
    totalUsers: number
    cacheSize: string
    lastSync?: string
  }> {
    const stats = await this.getDatabaseStats()
    return {
      totalUsers: stats.totalUsers,
      cacheSize: '0 B', // No cache size in database mode
      lastSync: stats.lastSync,
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
