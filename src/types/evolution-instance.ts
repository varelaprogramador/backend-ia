export interface EvolutionInstance {
  id: string
  userId: string
  instanceName: string
  displayName: string
  connectionState: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'TIMEOUT' | 'CLOSE'
  ownerJid?: string
  profileName?: string
  profilePictureUrl?: string
  status: 'active' | 'inactive' | 'suspended'
  serverUrl?: string
  webhookUrl?: string
  webhookByEvents?: boolean
  webhookBase64?: boolean
  webhookEvents?: string[]
  isDefault?: boolean
  sendConnectionStatus?: boolean
  chatwootAccountId?: string
  chatwootToken?: string
  chatwootUrl?: string
  chatwootSignMsg?: boolean
  createdAt: Date
  updatedAt: Date
}

export interface CreateEvolutionInstanceRequest {
  instanceName: string
  displayName?: string
  serverUrl?: string
  webhookUrl?: string
  webhookByEvents?: boolean
  webhookBase64?: boolean
  webhookEvents?: string[]
  isDefault?: boolean
  sendConnectionStatus?: boolean
  chatwootAccountId?: string
  chatwootToken?: string
  chatwootUrl?: string
  chatwootSignMsg?: boolean
}

export interface UpdateEvolutionInstanceRequest {
  displayName?: string
  serverUrl?: string
  webhookUrl?: string
  webhookByEvents?: boolean
  webhookBase64?: boolean
  webhookEvents?: string[]
  status?: 'active' | 'inactive' | 'suspended'
  sendConnectionStatus?: boolean
  chatwootAccountId?: string
  chatwootToken?: string
  chatwootUrl?: string
  chatwootSignMsg?: boolean
}

export interface EvolutionInstanceResponse {
  instance: EvolutionInstance
  hash?: {
    apikey: string
  }
  webhook?: {
    webhook: string
    events: string[]
  }
  websocket?: {
    enabled: boolean
    events: string[]
  }
  rabbitmq?: {
    enabled: boolean
    events: string[]
  }
  sqs?: {
    enabled: boolean
    events: string[]
  }
  typebot?: {
    enabled: boolean
  }
  chatwoot?: {
    enabled: boolean
    account_id: string
    token: string
    url: string
    sign_msg: boolean
  }
}

export interface QRCodeResponse {
  base64?: string
  code: string
  count: number
  pairingCode?: string
}

export interface InstanceStatusResponse {
  instance: {
    instanceName: string
    status: string
  }
}

export interface ConnectionStateResponse {
  state: 'CONNECTING' | 'CONNECTED' | 'DISCONNECTED' | 'TIMEOUT' | 'CLOSE'
  statusReason?: number
}