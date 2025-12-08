import { ENV } from '@/config/env'

type CredentialType = 'GOOGLE_CALENDAR' | 'CHATGPT' | 'N8N' | 'CUSTOM'

/**
 * Resolve a URL da credencial baseado no tipo
 * Se a URL estiver vazia e for um tipo pré-configurado, usa a URL padrão do ambiente
 *
 * @param type - Tipo da credencial
 * @param url - URL fornecida pelo usuário
 * @returns URL resolvida
 */
export function resolveCredentialUrl(
  type: CredentialType,
  url: string | null | undefined,
): string {
  // Se a URL foi fornecida, usa ela
  if (url && url.trim()) {
    return url
  }

  // Se não foi fornecida, usa a URL padrão baseada no tipo
  switch (type) {
    case 'CHATGPT':
      return ENV.DEFAULT_CHATGPT_URL || 'https://api.openai.com/v1'

    case 'GOOGLE_CALENDAR':
      return (
        ENV.DEFAULT_GOOGLE_CALENDAR_URL ||
        'https://www.googleapis.com/calendar/v3'
      )

    case 'N8N':
      return ENV.DEFAULT_N8N_URL || 'https://localhost:5678'

    case 'CUSTOM':
      // Para CUSTOM, se não tiver URL, retorna string vazia
      // (a validação do controller deve pegar isso)
      return ''

    default:
      return ''
  }
}
