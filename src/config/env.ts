import "dotenv/config";
import { z } from "zod";

/**
 * Schema de validação das variáveis de ambiente
 * Organizado por categoria para melhor legibilidade
 */
const envSchema = z.object({
  // Configuração da aplicação
  APP_URL: z.string().url("APP_URL deve ser uma URL válida").optional(),
  NODE_ENV: z
    .enum(["development", "production", "test"], {
      errorMap: () => ({
        message: 'NODE_ENV deve ser "development", "production" ou "test"',
      }),
    })
    .default("development"),
  PORT: z
    .string()
    .trim()
    .regex(/^\d+$/, "PORT deve ser um número válido")
    .transform(Number)
    .pipe(
      z
        .number()
        .min(1, "PORT deve ser maior que 0")
        .max(65535, "PORT deve ser menor que 65536")
    )
    .default("3000"),

  // Autenticação - Clerk
  CLERK_SECRET_KEY: z.string().trim().optional(),
  CLERK_WEBHOOK_USER_SECRET: z.string().trim().optional(),
  CLERK_PUBLISHABLE_KEY: z.string().trim().optional(),

  // Banco de dados
  DATABASE_URL: z
    .string()
    .url("DATABASE_URL deve ser uma URL válida")
    .trim()
    .min(1, "DATABASE_URL é obrigatório"),

  // User Sync Configuration
  ENABLE_USER_SYNC: z.string().optional().default("true"),
  USER_SYNC_CRON_SCHEDULE: z.string().optional().default("0 */30 * * * *"), // Every 30 minutes

  // Socket.IO Configuration for Replicas
  SOCKET_IO_ADAPTER_TYPE: z
    .enum(["local", "redis"])
    .optional()
    .default("redis"),
  SOCKET_IO_BATCH_INTERVAL: z
    .string()
    .optional()
    .default("500")
    .transform(Number)
    .pipe(z.number().min(100).max(5000)), // 100ms to 5s
  SOCKET_IO_CONNECTION_STATE_RECOVERY: z.string().optional().default("true"),
  SOCKET_IO_MAX_DISCONNECTION_DURATION: z
    .string()
    .optional()
    .default("120000") // 2 minutes
    .transform(Number)
    .pipe(z.number().min(30000).max(600000)), // 30s to 10min

  // N8N Webhook Configuration
  N8N_WEBHOOK_URL: z
    .string()
    .url("N8N_WEBHOOK_URL deve ser uma URL válida")
    .optional(),

  // My Phone Number for message identification
  MY_PHONE_NUMBER: z
    .string()
    .optional()
});

// Tipagem das variáveis de ambiente validadas
type EnvSchema = z.infer<typeof envSchema>;

declare global {
  namespace NodeJS {
    interface ProcessEnv extends Record<keyof EnvSchema, string> {}
  }
}

/**
 * Valida e processa as variáveis de ambiente
 */
const validateEnv = () => {
  const parsedEnv = envSchema.safeParse(process.env);

  if (!parsedEnv.success) {
    console.error("❌ Falha na validação das variáveis de ambiente:");

    // Exibe erros de forma mais organizada
    const errors = parsedEnv.error.errors;
    errors.forEach((error) => {
      const field = error.path.join(".");
      console.error(`  • ${field}: ${error.message}`);
    });

    console.error("\n🔍 Verifique o arquivo .env e tente novamente.");
    process.exit(1);
  }

  return parsedEnv.data;
};

// Executa a validação
const env = validateEnv();

/**
 * Variáveis de ambiente validadas e tipadas
 * Exportadas para uso em toda a aplicação
 */
export const ENV = {
  // Configuração
  NODE_ENV: env.NODE_ENV,
  PORT: env.PORT,
  IS_DEVELOPMENT: env.NODE_ENV === "development",
  IS_PRODUCTION: env.NODE_ENV === "production",
  IS_TEST: env.NODE_ENV === "test",
  APP_URL: env.APP_URL,

  // Clerk
  CLERK: {
    SECRET_KEY: env.CLERK_SECRET_KEY,
    PUBLISHABLE_KEY: env.CLERK_PUBLISHABLE_KEY,
    WEBHOOK_USER_SECRET: env.CLERK_WEBHOOK_USER_SECRET,
  },

  // Database
  DATABASE_URL: env.DATABASE_URL,

  // User Sync
  ENABLE_USER_SYNC: env.ENABLE_USER_SYNC,
  USER_SYNC_CRON_SCHEDULE: env.USER_SYNC_CRON_SCHEDULE,

  // Socket.IO
  SOCKET_IO: {
    ADAPTER_TYPE: env.SOCKET_IO_ADAPTER_TYPE,
    BATCH_INTERVAL: env.SOCKET_IO_BATCH_INTERVAL,
    CONNECTION_STATE_RECOVERY:
      env.SOCKET_IO_CONNECTION_STATE_RECOVERY === "true",
    MAX_DISCONNECTION_DURATION: env.SOCKET_IO_MAX_DISCONNECTION_DURATION,
  },

  // N8N Webhook
  N8N_WEBHOOK_URL: env.N8N_WEBHOOK_URL,

  // My Phone Number
  MY_PHONE_NUMBER: env.MY_PHONE_NUMBER,
} as const;

// Exportação legacy para compatibilidade
export const PORT = ENV.PORT;
