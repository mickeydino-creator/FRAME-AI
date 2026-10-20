import { create } from 'zustand'
import { applyCommand, Command, CommandResult } from '../../../shared/commands'
import type { ImportProgress } from '../../../shared/ipc'
import type { ExportProgress, Project, SystemInfo } from '../../../shared/types'

export type PreviewQuality = 1 | 0.5 | 0.25

export interface Toast {
  id: number
  kind: 'info' | 'success' | 'error'
  message: string
}

export interface EditorState {
  project: Project | null
  projectDir: string | null
  dirty: boolean
  past: Project[]
  future: Project[]
  lastMergeKey: string | null
  lastMergeAt: number

  selection: string[]
  selectedTrackId: string | null
  playhead: number
  playing: boolean
  previewQuality: PreviewQuality
  previewZoom: 'fit' | number
  /** Timeline zoom in pixels per second. */
  zoom: number
  snapping: boolean
  libraryTab: 'media' | 'graphics'

  toasts: Toast[]
  importing: Record<string, ImportProgress>
  exportProgress: ExportProgress | null
  exportOpen: boolean
  systemInfo: SystemInfo | null
}

const HISTORY_LIMIT = 200

export const useEditor = create<EditorState>(() => ({
  project: null,
  projectDir: null,
  dirty: false,
  past: [],
  future: [],
  lastMergeKey: null,
  lastMergeAt: 0,
  selection: [],
  selectedTrackId: null,
  playhead: 0,
  playing: false,
  previewQuality: 0.5,
  previewZoom: 'fit',
  zoom: 60,
  snapping: true,
  libraryTab: 'media',
  toasts: [],
  importing: {},
  exportProgress: null,
  exportOpen: false,
  systemInfo: null
}))

export const getState = useEditor.getState
export const setState = useEditor.setState

export function loadProject(project: Project, dir: string): void {
  setState({
    project,
    projectDir: dir,
    dirty: false,
    past: [],
    future: [],
    selection: [],
    selectedTrackId: null,
    playhead: 0,
    playing: false,
    lastMergeKey: null
  })
}

export interface DispatchOptions {
  /** Consecutive commands with the same key (within 1.5s) become one undo step. */
  mergeKey?: string
}

/** Apply a command to the current project and record it in history. Throws CommandError. */
export function dispatch(cmd: Command, opts: DispatchOptions = {}): CommandResult {
  const s = getState()
  if (!s.project) throw new Error('No project is open.')
  const { project: next, result } = applyCommand(s.project, cmd)
  if (next === s.project) return result
  const now = Date.now()
  const merge = !!opts.mergeKey && opts.mergeKey === s.lastMergeKey && now - s.lastMergeAt < 1500
  const ids = new Set(next.clips.map((c) => c.id))
  setState({
    project: next,
    past: merge ? s.past : [...s.past.slice(-(HISTORY_LIMIT - 1)), s.project],
    future: [],
    dirty: true,
    lastMergeKey: opts.mergeKey ?? null,
    lastMergeAt: now,
    selection: s.selection.filter((id) => ids.has(id)),
    selectedTrackId: next.tracks.some((t) => t.id === s.selectedTrackId) ? s.selectedTrackId : null
  })
  return result
}

function pruneSelection(p: Project, sel: string[]): string[] {
  const ids = new Set(p.clips.map((c) => c.id))
  return sel.filter((id) => ids.has(id))
}

export function undo(): boolean {
  const s = getState()
  if (!s.project || s.past.length === 0) return false
  const prev = s.past[s.past.length - 1]
  setState({
    project: prev,
    past: s.past.slice(0, -1),
    future: [s.project, ...s.future],
    dirty: true,
    lastMergeKey: null,
    selection: pruneSelection(prev, s.selection)
  })
  return true
}

export function redo(): boolean {
  const s = getState()
  if (!s.project || s.future.length === 0) return false
  const next = s.future[0]
  setState({
    project: next,
    past: [...s.past, s.project],
    future: s.future.slice(1),
    dirty: true,
    lastMergeKey: null,
    selection: pruneSelection(next, s.selection)
  })
  return true
}

let toastId = 1
export function toast(kind: Toast['kind'], message: string, ms = kind === 'error' ? 8000 : 4000): void {
  const id = toastId++
  setState((s) => ({ toasts: [...s.toasts, { id, kind, message }].slice(-5) }))
  setTimeout(() => setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms)
}

export function dismissToast(id: number): void {
  setState((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }))
}

/** Run a command and report failures as a toast instead of throwing. */
export function tryDispatch(cmd: Command, opts?: DispatchOptions): CommandResult | null {
  try {
    return dispatch(cmd, opts)
  } catch (e) {
    toast('error', (e as Error).message)
    return null
  }
}
