import { create } from 'zustand'
import { uid } from '../../../shared/util'
import { useEditor } from '../editor/store'
import { getProvider, summarizeEditorState } from './provider'
import type { ChatMessage } from './types'

const MAX_MESSAGES = 300
const OPEN_KEY = 'frameai.assistant.open'

interface AssistantState {
  open: boolean
  projectId: string | null
  messages: ChatMessage[]
  draft: string
  busy: boolean
}

function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== '0'
  } catch {
    return true
  }
}

export const useAssistant = create<AssistantState>(() => ({
  open: readOpen(),
  projectId: null,
  messages: [],
  draft: '',
  busy: false
}))

const historyKey = (projectId: string) => `frameai.assistant.history.${projectId}`

function load(projectId: string): ChatMessage[] {
  try {
    const raw = localStorage.getItem(historyKey(projectId))
    return raw ? (JSON.parse(raw) as ChatMessage[]) : []
  } catch {
    return []
  }
}

function persist(): void {
  const { projectId, messages } = useAssistant.getState()
  if (!projectId) return
  try {
    localStorage.setItem(historyKey(projectId), JSON.stringify(messages.slice(-MAX_MESSAGES)))
  } catch {
    // Storage full or unavailable: history stays in memory for this session.
  }
}

// History is kept per project and switches with the open project.
useEditor.subscribe((s, prev) => {
  const id = s.project?.id ?? null
  if (id === (prev.project?.id ?? null) && id === useAssistant.getState().projectId) return
  useAssistant.setState({ projectId: id, messages: id ? load(id) : [], draft: '', busy: false })
})

export function setAssistantOpen(open: boolean): void {
  useAssistant.setState({ open })
  try {
    localStorage.setItem(OPEN_KEY, open ? '1' : '0')
  } catch {
    // ignore
  }
}

export function setDraft(draft: string): void {
  useAssistant.setState({ draft })
}

export function clearHistory(): void {
  useAssistant.setState({ messages: [] })
  persist()
}

function append(m: ChatMessage): void {
  useAssistant.setState((s) => ({ messages: [...s.messages, m].slice(-MAX_MESSAGES) }))
}

function patch(id: string, p: Partial<ChatMessage>): void {
  useAssistant.setState((s) => ({ messages: s.messages.map((m) => (m.id === id ? { ...m, ...p } : m)) }))
}

/**
 * Record a user message. Without a connected provider it is stored locally
 * and nothing else happens; with one, the reply is streamed into the history.
 */
export async function sendMessage(text: string): Promise<void> {
  const body = text.trim()
  if (!body || useAssistant.getState().busy) return
  const provider = getProvider()
  const user: ChatMessage = {
    id: uid('msg'),
    role: 'user',
    text: body,
    createdAt: new Date().toISOString(),
    status: provider.isConnected() ? 'sent' : 'local'
  }
  append(user)
  useAssistant.setState({ draft: '' })
  persist()
  if (!provider.isConnected()) return

  const context = summarizeEditorState()
  if (!context) return
  const reply: ChatMessage = { id: uid('msg'), role: 'assistant', text: '', createdAt: new Date().toISOString(), status: 'sending' }
  append(reply)
  useAssistant.setState({ busy: true })
  const abort = new AbortController()
  try {
    for await (const ev of provider.send({ messages: useAssistant.getState().messages.filter((m) => m.id !== reply.id), context }, abort.signal)) {
      if (ev.type === 'text') {
        const cur = useAssistant.getState().messages.find((m) => m.id === reply.id)
        patch(reply.id, { text: (cur?.text ?? '') + ev.delta })
      } else if (ev.type === 'error') throw new Error(ev.message)
      else if (ev.type === 'done') break
    }
    patch(reply.id, { status: 'sent' })
  } catch (e) {
    patch(reply.id, { status: 'error', error: (e as Error).message })
  } finally {
    useAssistant.setState({ busy: false })
    persist()
  }
}
