export type RealtimePayload = {
  table?: string
  keysToDelete?: string[][]
  keysToInvalidate?: string[][]
  data?: Record<string, unknown>
  type?: 'INSERT' | 'UPDATE' | 'DELETE'
}

export type BatchManager = {
  events: RealtimePayload[]
  timeout: NodeJS.Timeout | null
}
