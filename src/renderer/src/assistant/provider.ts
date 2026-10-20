/**
 * Seam for a future assistant backend (e.g. a local Claude/MCP bridge).
 *
 * The chat UI talks only to an AssistantProvider. A provider receives the
 * conversation plus a summary of the editor state and streams events back.
 * Edits must go through the EditorAPI command layer (`runEditorTool`), so an
 * assistant can only do what the user could do, with full undo.
 *
 * No provider is connected in this version: messages are stored locally and
 * nothing is sent anywhere.
 */
import { clipEnd, projectDuration } from '../../../shared/project'
import { formatDuration } from '../../../shared/util'
import { editor } from '../editor/api'
import { getState } from '../editor/store'
import type { ChatMessage } from './types'

export interface EditorContextSummary {
  projectName: string
  aspect: string
  duration: number
  playhead: number
  clipCount: number
  trackCount: number
  mediaCount: number
  selection: { id: string; type: string; name: string; start: number; end: number }[]
}

export type AssistantEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool'; method: string; args: unknown[] }
  | { type: 'error'; message: string }
  | { type: 'done' }

export interface AssistantProvider {
  readonly id: string
  readonly label: string
  isConnected(): boolean
  send(
    request: { messages: ChatMessage[]; context: EditorContextSummary },
    signal: AbortSignal
  ): AsyncIterable<AssistantEvent>
}

/** The default: nothing is connected, so nothing is ever sent. */
export const disconnectedProvider: AssistantProvider = {
  id: 'none',
  label: 'Not connected',
  isConnected: () => false,
  // eslint-disable-next-line require-yield
  async *send() {
    throw new Error('No assistant is connected.')
  }
}

let current: AssistantProvider = disconnectedProvider

export function getProvider(): AssistantProvider {
  return current
}

/** Register a provider (called by a future integration). */
export function setProvider(p: AssistantProvider): void {
  current = p
}

export function summarizeEditorState(): EditorContextSummary | null {
  const { project, playhead, selection } = getState()
  if (!project) return null
  return {
    projectName: project.name,
    aspect: project.settings.aspect,
    duration: projectDuration(project),
    playhead,
    clipCount: project.clips.length,
    trackCount: project.tracks.length,
    mediaCount: project.media.length,
    selection: project.clips
      .filter((c) => selection.includes(c.id))
      .map((c) => ({ id: c.id, type: c.type, name: c.type === 'text' ? c.text?.text ?? c.name : c.name, start: c.start, end: clipEnd(c) }))
  }
}

export function describeContext(c: EditorContextSummary): string {
  const parts = [`${c.clipCount} clip${c.clipCount === 1 ? '' : 's'}`, formatDuration(c.duration)]
  if (c.selection.length === 1) parts.push(`selected: ${c.selection[0].name.split('\n')[0]}`)
  else if (c.selection.length > 1) parts.push(`${c.selection.length} selected`)
  return parts.join(' · ')
}

/** Execute an assistant tool call through the editor command layer. */
export async function runEditorTool(method: string, args: unknown[]): Promise<unknown> {
  const fn = (editor as Record<string, unknown>)[method]
  if (typeof fn !== 'function') throw new Error(`Unknown editor method: ${method}`)
  return await (fn as (...a: unknown[]) => unknown).apply(editor, args)
}
