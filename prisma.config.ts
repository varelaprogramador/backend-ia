/**
 * Prisma Configuration File
 *
 * This replaces the deprecated package.json#prisma configuration
 * See: https://pris.ly/prisma-config
 */

import type { PrismaConfig } from 'prisma'

import 'dotenv/config'

const config = {
  schema: 'prisma/schema.prisma',
} satisfies PrismaConfig

export default config
