import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { clearHistory, sendMessage, setAssistantOpen, setDraft, useAssistant } from '../assistant/store'
import { describeContext, getProvider, summarizeEditorState } from '../assistant/provider'
import type { ChatMessage } from '../assistant/types'
import { useEditor } from '../editor/store'
import { Icon } from './Icon'

const SUGGESTIONS = [
  'Create a cinematic intro.',
  'Add animated typography.',
  'Add a new scene after this clip.',
  'Make the edit more dynamic.'
]

function time(iso: string): string {
  const d = new Date(iso)
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

function Message({ m }: { m: ChatMessage }) {
  return (
    <div className={`msg ${m.role}`}>
      <div className="msg-body" dir="auto">
        {m.text || (m.status === 'sending' ? '…' : '')}
      </div>
      <div className="msg-meta">
        {time(m.createdAt)}
        {m.status === 'local' && ' · Saved on this computer'}
        {m.status === 'error' && <span className="msg-error"> · {m.error ?? 'Failed'}</span>}
      </div>
    </div>
  )
}

function ContextLine() {
  // Narrow subscriptions: re-render on edits and selection, not on every playhead tick.
  const clips = useEditor((s) => s.project?.clips)
  const selection = useEditor((s) => s.selection)
  const text = useMemo(() => {
    const c = summarizeEditorState()
    return c ? describeContext(c) : ''
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clips, selection])
  return (
    <div className="assistant-context" title="What the assistant will be able to see">
      <span>Context</span> {text}
    </div>
  )
}

export function AssistantPanel() {
  const open = useAssistant((s) => s.open)
  const messages = useAssistant((s) => s.messages)
  const draft = useAssistant((s) => s.draft)
  const busy = useAssistant((s) => s.busy)
  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const connected = getProvider().isConnected()

  // Keep the newest message in view.
  useLayoutEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, open])

  // Grow the input with its content, up to a limit set in CSS.
  useLayoutEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [draft, open])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault()
        const next = !useAssistant.getState().open
        setAssistantOpen(next)
        if (next) requestAnimationFrame(() => inputRef.current?.focus())
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  if (!open) {
    return (
      <aside className="panel assistant-rail">
        <button className="icon-btn" title="Open AI Assistant (Ctrl+J)" aria-label="Open AI Assistant" onClick={() => setAssistantOpen(true)}>
          <Icon name="panelOpen" />
        </button>
        <button className="rail-label" onClick={() => setAssistantOpen(true)}>
          <Icon name="chat" size={14} />
          <span>AI Assistant</span>
        </button>
      </aside>
    )
  }

  const submit = () => void sendMessage(draft)
  const hasLocal = messages.some((m) => m.status === 'local')

  return (
    <aside className="panel assistant" aria-label="AI Assistant">
      <div className="panel-header">
        <Icon name="chat" size={14} />
        <span className="panel-header-title">AI Assistant</span>
        <span className={`status-pill ${connected ? 'on' : ''}`}>{connected ? getProvider().label : 'Not connected'}</span>
        <div className="spacer" />
        <button
          className="icon-btn small"
          title="Clear conversation"
          aria-label="Clear conversation"
          disabled={!messages.length}
          onClick={() => window.confirm('Clear this conversation? This cannot be undone.') && clearHistory()}
        >
          <Icon name="trash" size={13} />
        </button>
        <button className="icon-btn small" title="Collapse (Ctrl+J)" aria-label="Collapse AI Assistant" onClick={() => setAssistantOpen(false)}>
          <Icon name="panelRight" size={14} />
        </button>
      </div>

      <div className="assistant-list" ref={listRef}>
        {messages.length === 0 ? (
          <div className="assistant-empty">
            <p className="assistant-intro">Describe an edit in your own words.</p>
            <p className="muted">
              The assistant isn’t connected in this version. Messages are kept with this project on this computer and nothing is sent anywhere.
            </p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  className="suggestion"
                  onClick={() => {
                    setDraft(s)
                    inputRef.current?.focus()
                  }}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((m) => <Message key={m.id} m={m} />)
        )}
        {hasLocal && !connected && (
          <div className="assistant-note">Not connected. Your messages are saved, but no edits are made yet.</div>
        )}
      </div>

      <div className="assistant-compose">
        <ContextLine />
        <div className="compose-box">
          <textarea
            ref={inputRef}
            rows={1}
            value={draft}
            placeholder="Ask for an edit…"
            dir="auto"
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <button className="send-btn" title="Send (Enter)" aria-label="Send" disabled={!draft.trim() || busy} onClick={submit}>
            <Icon name="send" size={14} />
          </button>
        </div>
      </div>
    </aside>
  )
}
