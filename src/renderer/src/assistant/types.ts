export type ChatRole = 'user' | 'assistant'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  createdAt: string
  /** `local`: stored on this computer only, never sent (no assistant connected). */
  status: 'local' | 'sending' | 'sent' | 'error'
  error?: string
}
