/**
 * EditorAPI - the documented editing command layer of FRAME AI.
 *
 * The UI and any future external controller (e.g. a local MCP server talking
 * to the main process through src/main/bridge.ts) use the same methods.
 * Pure timeline edits are expressed as `Command` objects (src/shared/commands.ts)
 * and go through `dispatch`, so they are undoable and serializable. Methods
 * with side effects (file dialogs, import, save, export) wrap the IPC API.
 *
 * Available from DevTools as `window.frameEditor`. Reference: docs/COMMANDS.md
 */
import { Command, CommandResult } from '../../../shared/commands'
import type { OpenedProject } from '../../../shared/ipc'
import { clipEnd, createProject, findClip, projectDuration, serializeProject } from '../../../shared/project'
import type {
  AnimatableProp,
  AnimationPreset,
  AspectRatio,
  Easing,
  ExportOptions,
  ExportProgress,
  Fill,
  MediaAsset,
  Project,
  ShapeStyle,
  TextStyle,
  Transform
} from '../../../shared/types'
import { snapToFrame, uid } from '../../../shared/util'
import { preview } from '../engine/preview'
import { BACKGROUND_PRESETS, SHAPE_PRESETS, TEMPLATES, TEXT_PRESETS } from './presets'
import { dispatch, getState, loadProject, redo, setState, toast, undo } from './store'

function api() {
  return window.frameAPI
}

function requireProject(): { project: Project; dir: string } {
  const { project, projectDir } = getState()
  if (!project || !projectDir) throw new Error('No project is open.')
  return { project, dir: projectDir }
}

export interface ProjectState {
  project: Project
  projectDir: string
  duration: number
  playhead: number
  selection: string[]
  dirty: boolean
  canUndo: boolean
  canRedo: boolean
}

export const editor = {
  // ------------------------------------------------------------------ state
  /** Full serializable project state plus editor context. */
  getProjectState(): ProjectState {
    const { project, dir } = requireProject()
    const s = getState()
    return {
      project,
      projectDir: dir,
      duration: projectDuration(project),
      playhead: s.playhead,
      selection: s.selection,
      dirty: s.dirty,
      canUndo: s.past.length > 0,
      canRedo: s.future.length > 0
    }
  },

  /** Apply any raw command (see shared/commands.ts). */
  dispatch(cmd: Command): CommandResult {
    return dispatch(cmd)
  },

  /** Apply several commands as a single undo step. */
  batch(commands: Command[]): CommandResult {
    return dispatch({ type: 'batch', commands })
  },

  undo(): boolean {
    return undo()
  },

  redo(): boolean {
    return redo()
  },

  // ---------------------------------------------------------------- project
  async newProject(name = 'Untitled Project', aspect: AspectRatio = '16:9', parentDir?: string): Promise<string> {
    const { dir } = await api().project.create(name, parentDir)
    const project = createProject(name, aspect)
    await api().project.save(dir, serializeProject(project))
    loadProject(project, dir)
    return dir
  },

  async openProject(dir?: string): Promise<OpenedProject | null> {
    const opened = await api().project.open(dir)
    if (!opened) return null
    loadProject(opened.project, opened.dir)
    if (opened.missing.length)
      toast('error', `${opened.missing.length} media file(s) are missing: ${opened.missing.join(', ')}. Use Relink in the Media panel.`)
    return opened
  },

  async saveProject(): Promise<void> {
    const { project, dir } = requireProject()
    await api().project.save(dir, serializeProject(project))
    setState({ dirty: false })
  },

  // ------------------------------------------------------------------ media
  /** Import files (absolute paths). With no paths a file dialog opens. */
  async importMedia(paths?: string[]): Promise<MediaAsset[]> {
    const { dir } = requireProject()
    const files = paths ?? (await api().media.chooseFiles())
    if (!files.length) return []
    const res = await api().media.import(dir, files)
    if (res.assets.length) dispatch({ type: 'batch', commands: res.assets.map((asset) => ({ type: 'addMedia' as const, asset })) })
    for (const e of res.errors) toast('error', `${e.file}: ${e.message}`)
    return res.assets
  },

  /** Replace a missing (or any) media file. With no path a file dialog opens. */
  async relinkMedia(mediaId: string, newPath?: string): Promise<MediaAsset | null> {
    const { project, dir } = requireProject()
    const asset = project.media.find((m) => m.id === mediaId)
    if (!asset) throw new Error(`Media not found: ${mediaId}`)
    const fresh = await api().media.relink(dir, asset, newPath)
    if (!fresh) return null
    dispatch({ type: 'updateMedia', mediaId, patch: { ...fresh, missing: false } })
    return fresh
  },

  removeMedia(mediaId: string): CommandResult {
    return dispatch({ type: 'removeMedia', mediaId })
  },

  // ------------------------------------------------------------------ clips
  /** Place a media asset on the timeline (defaults: playhead, automatic track). */
  addMediaToTimeline(mediaId: string, opts: { start?: number; trackId?: string; duration?: number } = {}): CommandResult {
    return dispatch({ type: 'addMediaClip', mediaId, start: opts.start ?? getState().playhead, trackId: opts.trackId, duration: opts.duration })
  },

  moveClip(clipId: string, start: number, trackId?: string): CommandResult {
    return dispatch({ type: 'moveClip', clipId, start, trackId })
  },

  /** Move one edge of a clip to timeline time `time` (adjusting the source in-point for the start edge). */
  trimClip(clipId: string, edge: 'start' | 'end', time: number): CommandResult {
    return dispatch({ type: 'trimClip', clipId, edge, time })
  },

  setClipTiming(clipId: string, timing: { start?: number; duration?: number; sourceStart?: number }): CommandResult {
    return dispatch({ type: 'setClipTiming', clipId, ...timing })
  },

  splitClip(clipId: string, time: number): CommandResult {
    return dispatch({ type: 'splitClip', clipId, time })
  },

  /** Split the selected clips (or every unlocked clip) under the playhead. */
  splitAtPlayhead(): CommandResult {
    const { project } = requireProject()
    const s = getState()
    const t = snapToFrame(s.playhead, project.settings.fps)
    const locked = new Set(project.tracks.filter((tr) => tr.locked).map((tr) => tr.id))
    const under = project.clips.filter((c) => t > c.start + 1e-6 && t < clipEnd(c) - 1e-6 && !locked.has(c.trackId))
    const targets = s.selection.length ? under.filter((c) => s.selection.includes(c.id)) : under
    if (!targets.length) throw new Error('No clip under the playhead to split.')
    return dispatch({ type: 'batch', commands: targets.map((c) => ({ type: 'splitClip' as const, clipId: c.id, time: t })) })
  },

  deleteClips(clipIds: string[]): CommandResult {
    return dispatch({ type: 'deleteClips', clipIds })
  },

  duplicateClip(clipId: string, start?: number): CommandResult {
    return dispatch({ type: 'duplicateClip', clipId, start })
  },

  /** Change any clip property: transform, text, shape, fill, volume, fades, fit, name. */
  updateClip(clipId: string, patch: Extract<Command, { type: 'updateClip' }>['patch']): CommandResult {
    return dispatch({ type: 'updateClip', clipId, patch })
  },

  setTransform(clipId: string, transform: Partial<Transform>): CommandResult {
    return dispatch({ type: 'updateClip', clipId, patch: { transform } })
  },

  setVolume(clipId: string, volume: number): CommandResult {
    return dispatch({ type: 'updateClip', clipId, patch: { volume } })
  },

  setFades(clipId: string, fadeIn?: number, fadeOut?: number): CommandResult {
    return dispatch({ type: 'updateClip', clipId, patch: { fadeIn, fadeOut } })
  },

  /** Cross-dissolve from the previous clip on the same track. */
  addCrossfade(clipId: string, duration = 0.5): CommandResult {
    return dispatch({ type: 'crossfade', clipId, duration })
  },

  // ------------------------------------------------------- text & graphics
  addText(
    text: string,
    opts: {
      start?: number
      duration?: number
      trackId?: string
      style?: Partial<TextStyle>
      transform?: Partial<Transform>
      animIn?: { preset: AnimationPreset; duration?: number }
      animOut?: { preset: AnimationPreset; duration?: number }
    } = {}
  ): CommandResult {
    return dispatch({ type: 'addText', text, start: opts.start ?? getState().playhead, ...opts })
  },

  addTextPreset(presetId: string, start = getState().playhead, trackId?: string): CommandResult {
    const { project } = requireProject()
    const p = TEXT_PRESETS.find((x) => x.id === presetId)
    if (!p) throw new Error(`Unknown text preset: ${presetId}`)
    return dispatch({
      type: 'addText',
      style: p.style,
      start,
      trackId,
      duration: p.duration,
      transform: { y: p.y(project.settings.height) },
      animIn: p.animIn,
      animOut: p.animOut
    })
  },

  addShape(shape: Partial<ShapeStyle> = {}, opts: { start?: number; duration?: number; trackId?: string; transform?: Partial<Transform> } = {}): CommandResult {
    const preset = SHAPE_PRESETS.find((s) => s.id === shape.shape) ?? SHAPE_PRESETS[0]
    return dispatch({
      type: 'addClip',
      clip: {
        type: 'shape',
        name: preset.label,
        duration: opts.duration,
        shape: { shape: preset.id, width: preset.width, height: preset.height, cornerRadius: preset.cornerRadius ?? 0, ...shape } as ShapeStyle,
        transform: opts.transform as Transform
      },
      trackId: opts.trackId,
      start: opts.start ?? getState().playhead
    })
  },

  addBackground(fill: Fill, opts: { start?: number; duration?: number; trackId?: string } = {}): CommandResult {
    return dispatch({
      type: 'addClip',
      clip: { type: 'background', name: 'Background', fill, duration: opts.duration },
      trackId: opts.trackId,
      start: opts.start ?? getState().playhead
    })
  },

  addBackgroundPreset(presetId: string, start = getState().playhead): CommandResult {
    const p = BACKGROUND_PRESETS.find((x) => x.id === presetId)
    if (!p) throw new Error(`Unknown background preset: ${presetId}`)
    return editor.addBackground(p.fill, { start })
  },

  /** Insert a multi-layer motion template on a new track (one undo step). */
  applyTemplate(templateId: string, start = getState().playhead): CommandResult {
    const { project } = requireProject()
    const t = TEMPLATES.find((x) => x.id === templateId)
    if (!t) throw new Error(`Unknown template: ${templateId}`)
    const trackId = uid('trk')
    const commands = t.build(start, project.settings).map((c): Command => {
      if (c.type === 'addTrack') return { ...c, id: trackId }
      if (c.type === 'addClip' || c.type === 'addText') return { ...c, trackId }
      return c
    })
    return dispatch({ type: 'batch', commands })
  },

  setAnimation(clipId: string, which: 'in' | 'out', preset: AnimationPreset, duration?: number): CommandResult {
    return dispatch({ type: 'setAnimation', clipId, which, preset, duration })
  },

  /** Add or update a keyframe at clip-local time `time` (seconds from clip start). */
  setKeyframe(clipId: string, prop: AnimatableProp, time: number, value: number, ease?: Easing): CommandResult {
    return dispatch({ type: 'setKeyframe', clipId, prop, time, value, ease })
  },

  removeKeyframe(clipId: string, prop: AnimatableProp, time: number): CommandResult {
    return dispatch({ type: 'removeKeyframe', clipId, prop, time })
  },

  // ----------------------------------------------------------------- tracks
  addTrack(kind: 'video' | 'audio', name?: string): CommandResult {
    return dispatch({ type: 'addTrack', kind, name })
  },

  removeTrack(trackId: string): CommandResult {
    return dispatch({ type: 'removeTrack', trackId })
  },

  moveTrack(trackId: string, index: number): CommandResult {
    return dispatch({ type: 'moveTrack', trackId, index })
  },

  // -------------------------------------------------------------- selection
  select(clipIds: string[]): void {
    setState({ selection: clipIds })
  },

  // --------------------------------------------------------------- playback
  setPlayhead(time: number): void {
    const { project } = requireProject()
    preview.pause()
    setState({ playhead: Math.max(0, snapToFrame(time, project.settings.fps)) })
  },

  play(): void {
    preview.play()
  },

  pause(): void {
    preview.pause()
  },

  /** Render one frame of the composition as a PNG data URL. */
  renderPreviewFrame(time = getState().playhead, maxWidth = 1280): Promise<string> {
    return preview.snapshot(time, maxWidth)
  },

  // ----------------------------------------------------------------- export
  /** Start an export; resolves with the job id. Progress is reported via waitForExport / UI. */
  async exportProject(options: Partial<ExportOptions> & { outputPath: string }): Promise<string> {
    const { project, dir } = requireProject()
    const opts: ExportOptions = {
      format: options.outputPath.toLowerCase().endsWith('.webm') ? 'webm' : 'mp4',
      height: 0,
      fps: project.settings.fps,
      quality: 'high',
      ...options
    }
    setState({ exportProgress: null })
    const { jobId } = await api().export.start(project, dir, opts)
    return jobId
  },

  /** Resolve when the export job finishes (rejects on error or cancel). */
  waitForExport(jobId: string): Promise<ExportProgress> {
    return new Promise((resolve, reject) => {
      const off = api().export.onProgress((p) => {
        if (p.jobId !== jobId) return
        if (p.phase === 'done') {
          off()
          resolve(p)
        } else if (p.phase === 'error' || p.phase === 'cancelled') {
          off()
          reject(new Error(p.message ?? `Export ${p.phase}`))
        }
      })
    })
  },

  cancelExport(jobId: string): Promise<void> {
    return api().export.cancel(jobId)
  },

  // ---------------------------------------------------------------- helpers
  findClip(clipId: string) {
    return findClip(requireProject().project, clipId)
  },

  /** Names of every API method (for discovery by external controllers). */
  listMethods(): string[] {
    return Object.keys(editor).sort()
  }
}

export type EditorAPI = typeof editor

/** Expose the API for DevTools and the main-process command bridge. */
export function installEditorBridge(): void {
  ;(window as unknown as { frameEditor: EditorAPI }).frameEditor = editor
  api().bridge.onCommand(async (method, args) => {
    const fn = (editor as Record<string, unknown>)[method]
    if (typeof fn !== 'function') throw new Error(`Unknown editor method: ${method}`)
    return await (fn as (...a: unknown[]) => unknown).apply(editor, args)
  })
}
