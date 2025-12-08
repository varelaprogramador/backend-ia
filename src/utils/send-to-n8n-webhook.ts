import axios from 'axios'
import type { FastifyBaseLogger } from 'fastify'

import { ENV } from '@/config/env'

interface SendToN8NWebhookParams {
  data: Record<string, any>
  logger?: FastifyBaseLogger
  webhookUrl?: string
}

/**
 * Envia dados para um webhook N8N
 * @param params - Parâmetros da requisição
 * @param params.data - Dados a serem enviados
 * @param params.logger - Logger do Fastify (opcional)
 * @param params.webhookUrl - URL do webhook (opcional, usa WEBHOOK_N8N_CREDENTIALS_URL por padrão)
 * @returns Promise<boolean> - true se enviado com sucesso, false caso contrário
 */
export async function sendToN8NWebhook({
  data,
  logger,
  webhookUrl,
}: SendToN8NWebhookParams): Promise<boolean> {
  const url = webhookUrl || ENV.WEBHOOK_N8N_CREDENTIALS_URL

  // Se não houver URL configurada, não faz nada e retorna true
  if (!url) {
    logger?.warn('WEBHOOK_N8N_CREDENTIALS_URL não configurado, pulando envio ao N8N')
    return true
  }

  try {
    const response = await axios.post(url, data, {
      headers: {
        'Content-Type': 'application/json',
      },
      timeout: 10000, // 10 segundos
    })

    logger?.info(
      {
        status: response.status,
        data: response.data,
      },
      'Dados enviados ao N8N com sucesso',
    )

    return true
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
        response: error.response?.data,
        status: error.response?.status,
      },
      'Erro ao enviar dados ao N8N',
    )

    // Não propaga o erro para não quebrar o fluxo principal
    // A criação da credencial deve continuar mesmo se o webhook falhar
    return false
  }
}
