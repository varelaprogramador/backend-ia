import type { FastifyBaseLogger } from 'fastify'
import * as fs from 'fs'
import * as path from 'path'

/**
 * Interface para mapear tipos de credenciais do N8N com seus IDs
 */
interface CredentialMapping {
  type: string // Tipo da credencial no banco (GOOGLE_CALENDAR, CHATGPT, etc.)
  id_n8n: string | null // ID da credencial no N8N
  n8nType: string // Tipo no N8N (googleCalendarOAuth2Api, openAiApi, etc.)
}

/**
 * Mapeamento de tipos de credenciais entre nosso sistema e o N8N
 */
const CREDENTIAL_TYPE_MAP: Record<string, string> = {
  GOOGLE_CALENDAR: 'googleCalendarOAuth2Api',
  CHATGPT: 'openAiApi',
  N8N: 'n8nApi',
  CUSTOM: 'httpHeaderAuth',
}

/**
 * Mapeamento reverso: do tipo usado no template para o tipo N8N real
 * Usado quando o template tem nomes simplificados como "calendar" ou "openAiApi"
 */
const TEMPLATE_TYPE_TO_N8N_TYPE: Record<string, string> = {
  calendar: 'googleCalendarOAuth2Api',
  openAiApi: 'openAiApi',
  googleCalendarOAuth2Api: 'googleCalendarOAuth2Api',
  n8nApi: 'n8nApi',
  httpHeaderAuth: 'httpHeaderAuth',
}

/**
 * Carrega o template do workflow N8N do arquivo example-node.json
 * @param logger - Logger do Fastify (opcional)
 * @returns Template do workflow como objeto JSON
 */
export function loadN8NWorkflowTemplate(logger?: FastifyBaseLogger): any {
  try {
    const templatePath = path.join(__dirname, 'example-node.json')
    const templateContent = fs.readFileSync(templatePath, 'utf-8')
    return JSON.parse(templateContent)
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
      },
      'Erro ao carregar template do workflow N8N',
    )
    throw new Error('Falha ao carregar template do workflow N8N')
  }
}

/**
 * Substitui os placeholders de IDs de credenciais no template do N8N
 * @param template - Template do workflow N8N (objeto JSON)
 * @param credentials - Array de credenciais com id_n8n
 * @param workspaceName - Nome do workspace para substituir no template
 * @param logger - Logger do Fastify (opcional)
 * @returns Template com IDs substituídos
 */
export function replaceN8NCredentialIds(
  template: any,
  credentials: Array<{ type: string; id_n8n: string | null }>,
  workspaceName: string,
  logger?: FastifyBaseLogger,
): any {
  try {
    // Criar mapa de tipos de credenciais do N8N → id_n8n
    const credentialMap = new Map<string, string>()

    credentials.forEach((cred) => {
      if (cred.id_n8n) {
        const n8nType = CREDENTIAL_TYPE_MAP[cred.type]
        if (n8nType) {
          credentialMap.set(n8nType, cred.id_n8n)
          logger?.info(
            {
              type: cred.type,
              n8nType,
              id_n8n: cred.id_n8n,
            },
            'Mapeando credencial para substituição',
          )
        }
      }
    })

    // Converter template para string para fazer substituições
    let templateStr = JSON.stringify(template, null, 2)

    // Substituir o nome do workspace no template
    templateStr = templateStr.replace(
      /"name":\s*"WILLIAM\s*-\s*agencia\s*-\s*teste creator"/g,
      `"name": "${workspaceName}"`,
    )

    // Substituir os placeholders de IDs
    // Formato: [ID N8N - TYPE = openAiApi] ou [ID N8N -  TYPE = calendar]
    const placeholderRegex = /\[ID N8N\s*-\s*TYPE\s*=\s*([^\]]+)\]/g

    templateStr = templateStr.replace(placeholderRegex, (match, type) => {
      const trimmedType = type.trim()

      // Primeiro, normalizar o tipo do template para o tipo N8N real
      const n8nType = TEMPLATE_TYPE_TO_N8N_TYPE[trimmedType] || trimmedType

      // Buscar o ID no mapa de credenciais usando o tipo normalizado
      const id_n8n = credentialMap.get(n8nType)

      if (id_n8n) {
        logger?.info(
          {
            placeholder: match,
            templateType: trimmedType,
            n8nType: n8nType,
            id_n8n,
          },
          'Substituindo ID da credencial no template',
        )
        return id_n8n
      } else {
        logger?.warn(
          {
            placeholder: match,
            templateType: trimmedType,
            n8nType: n8nType,
            availableTypes: Array.from(credentialMap.keys()),
          },
          'ID não encontrado para tipo de credencial - mantendo placeholder',
        )
        return match // Manter placeholder se não houver ID
      }
    })

    // Converter de volta para objeto JSON
    return JSON.parse(templateStr)
  } catch (error: any) {
    logger?.error(
      {
        error: error.message,
      },
      'Erro ao substituir IDs de credenciais no template',
    )
    throw new Error('Falha ao processar template do workflow N8N')
  }
}

/**
 * Valida se todas as credenciais necessárias possuem id_n8n
 * @param template - Template do workflow N8N
 * @param credentials - Array de credenciais
 * @param logger - Logger do Fastify (opcional)
 * @returns { valid: boolean, missing: string[] }
 */
export function validateN8NCredentials(
  template: any,
  credentials: Array<{ type: string; id_n8n: string | null }>,
  logger?: FastifyBaseLogger,
): { valid: boolean; missing: string[] } {
  const templateStr = JSON.stringify(template)
  const placeholderRegex = /\[ID N8N\s*-\s*TYPE\s*=\s*([^\]]+)\]/g
  const requiredTypes = new Set<string>()

  // Extrair todos os tipos de credenciais necessários do template
  let match
  while ((match = placeholderRegex.exec(templateStr)) !== null) {
    const templateType = match[1].trim()
    // Normalizar o tipo do template para o tipo N8N real
    const n8nType = TEMPLATE_TYPE_TO_N8N_TYPE[templateType] || templateType
    requiredTypes.add(n8nType)
  }

  // Criar mapa de tipos disponíveis
  const availableTypes = new Set<string>()
  credentials.forEach((cred) => {
    if (cred.id_n8n) {
      const n8nType = CREDENTIAL_TYPE_MAP[cred.type]
      if (n8nType) {
        availableTypes.add(n8nType)
      }
    }
  })

  // Verificar quais tipos estão faltando
  const missing: string[] = []
  requiredTypes.forEach((n8nType) => {
    if (!availableTypes.has(n8nType)) {
      missing.push(n8nType)
    }
  })

  const valid = missing.length === 0

  if (!valid) {
    logger?.warn(
      {
        required: Array.from(requiredTypes),
        available: Array.from(availableTypes),
        missing,
      },
      'Validação de credenciais do N8N falhou',
    )
  }

  return { valid, missing }
}
