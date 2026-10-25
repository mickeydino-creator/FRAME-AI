/**
 * The FRAME AI timeline model: plain JSON data and pure edit operations.
 *
 * Every edit, whether it comes from the pane or from one of Claude's tools,
 * goes through `applyEdit`, which never mutates its input and throws an
 * `EditError` with a readable reason when an edit cannot be made. Nothing
 * here touches the engine, the file system or FFmpeg.
 */

export type Aspect = '16:9' | '9:16' | '1:1'
export type MediaKind = 'video' | 'image' | 'audio'
export type ClipKind = MediaKind | 'text'
export type TextPosition = 'top' | 'center' | 'bottom' | 'lower-third'
export type TextAnimation = 'none' | 'fade' | 'slide-up'

export type Media = {
  id: string
  name: string
  /** Absolute path of the original file; never modified. */
  path: string
  kind: MediaKind
  /** Seconds; 0 for still images. */
  duration: number
  width?: number
  height?: number
  fps?: number
  hasVideo: boolean
  hasAudio: boolean
  /** Thumbnail PNG in the project's cache folder. */
  thumb?: string
}

export type Track = { id: string; kind: 'video' | 'audio'; name: string; muted?: boolean; hidden?: boolean }

export type TextStyle = {
  content: string
  size: number
  color: string
  position: TextPosition
  box: boolean
  animation: TextAnimation
}

export type Clip = {
  id: string
  kind: ClipKind
  trackId: string
  /** Timeline position of the first frame, seconds. */
  start: number
  duration: number
  mediaId?: string
  /** In-point inside the source media, seconds. */
  sourceIn?: number
  /** 0..2, audio gain. */
  volume?: number
  /** 0..1 */
  opacity?: number
  /** 1 = fitted to the frame. */
  scale?: number
  /** Offset from the frame center, project pixels. */
  x?: number
  y?: number
  fadeIn?: number
  fadeOut?: number
  text?: TextStyle
}

export type Project = {
  format: 'frame-ai-mod'
  version: 1
  id: string
  name: string
  aspect: Aspect
  width: number
  height: number
  fps: number
  media: Media[]
  tracks: Track[]
  clips: Clip[]
  updatedAt: string
}

export const SIZES: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
}

export const DEFAULT_TEXT: TextStyle = {
  content: 'Title',
  size: 96,
  color: '#ffffff',
  position: 'center',
  box: false,
  animation: 'fade',
}

export class EditError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EditError'
  }
}

const EPS = 1e-6

function fail(message: string): never {
  throw new EditError(message)
}

let counter = 0
export function newId(prefix: string): string {
  counter = (counter + 1) % 1e6
  return `${prefix}_${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`
}

export function round(v: number): number {
  return Math.round(v * 1000) / 1000
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration
}

export function projectDuration(p: Project): number {
  return p.clips.reduce((d, c) => Math.max(d, clipEnd(c)), 0)
}

export function createProject(name: string, aspect: Aspect = '16:9', fps = 30): Project {
  return {
    format: 'frame-ai-mod',
    version: 1,
    id: newId('prj'),
    name: name.trim() || 'Untitled',
    aspect,
    ...SIZES[aspect],
    fps,
    media: [],
    tracks: [
      { id: 'V2', kind: 'video', name: 'V2 Titles' },
      { id: 'V1', kind: 'video', name: 'V1' },
      { id: 'A1', kind: 'audio', name: 'A1' },
    ],
    clips: [],
    updatedAt: new Date().toISOString(),
  }
}

/** Validate a parsed project file and fill missing fields. */
export function loadProject(raw: unknown): Project {
  const r = raw as Partial<Project> | null
  if (!r || typeof r !== 'object' || r.format !== 'frame-ai-mod') fail('This is not a FRAME AI project file.')
  if ((r.version ?? 0) > 1) fail('This project was saved by a newer version of FRAME AI.')
  const aspect = r.aspect && SIZES[r.aspect] ? r.aspect : '16:9'
  const p: Project = {
    ...createProject(r.name ?? 'Untitled', aspect, r.fps ?? 30),
    id: r.id ?? newId('prj'),
    media: Array.isArray(r.media) ? r.media : [],
    tracks: Array.isArray(r.tracks) && r.tracks.length ? r.tracks : createProject('x').tracks,
    clips: Array.isArray(r.clips) ? r.clips : [],
    updatedAt: r.updatedAt ?? new Date().toISOString(),
  }
  const trackIds = new Set(p.tracks.map(t => t.id))
  const mediaIds = new Set(p.media.map(m => m.id))
  p.clips = p.clips.filter(c => trackIds.has(c.trackId) && (c.kind === 'text' || (c.mediaId && mediaIds.has(c.mediaId))))
  return p
}

export function findClip(p: Project, id: string): Clip {
  return p.clips.find(c => c.id === id) ?? fail(`No clip with id ${id}.`)
}

export function findMedia(p: Project, id: string): Media {
  return p.media.find(m => m.id === id) ?? fail(`No media with id ${id}.`)
}

function trackFor(p: Project, kind: ClipKind, requested?: string, start = 0, duration = 0): string {
  const want = kind === 'audio' ? 'audio' : 'video'
  if (requested) {
    const t = p.tracks.find(x => x.id === requested || x.name === requested)
    if (!t) fail(`No track named ${requested}.`)
    if (t.kind !== want) fail(`A ${kind} clip cannot go on audio/video track ${t.name} (${t.kind}).`)
    return t.id
  }
  const candidates = p.tracks.filter(t => t.kind === want)
  // Text goes on the top video track; media on the lowest free one.
  const ordered = kind === 'text' ? candidates : [...candidates].reverse()
  const free = ordered.find(t => !p.clips.some(c => c.trackId === t.id && c.start < start + duration - EPS && clipEnd(c) > start + EPS))
  if (free) return free.id
  const id = `${want === 'video' ? 'V' : 'A'}${p.tracks.filter(t => t.kind === want).length + 1}`
  const track: Track = { id, kind: want, name: id }
  if (want === 'video') p.tracks.unshift(track)
  else p.tracks.push(track)
  return id
}

function sourceLength(p: Project, c: Clip): number | null {
  if (c.kind !== 'video' && c.kind !== 'audio') return null
  const m = p.media.find(x => x.id === c.mediaId)
  return m && m.duration > 0 ? m.duration : null
}

function clampTiming(p: Project, c: Clip): void {
  const minDur = 1 / p.fps
  if (!(c.start >= -EPS)) fail('A clip cannot start before 0 seconds.')
  c.start = round(Math.max(0, c.start))
  const len = sourceLength(p, c)
  if (len !== null) {
    c.sourceIn = Math.min(Math.max(0, c.sourceIn ?? 0), Math.max(0, len - minDur))
    c.duration = Math.min(c.duration, len - c.sourceIn)
    c.sourceIn = round(c.sourceIn)
  }
  if (!(c.duration >= minDur - EPS)) fail(`A clip must be at least one frame long (${round(minDur)} s).`)
  c.duration = round(c.duration)
  for (const key of ['fadeIn', 'fadeOut'] as const) if (c[key] !== undefined) c[key] = round(Math.min(Math.max(0, c[key]!), c.duration))
  if (c.opacity !== undefined) c.opacity = Math.min(1, Math.max(0, c.opacity))
  if (c.volume !== undefined) c.volume = Math.min(2, Math.max(0, c.volume))
  if (c.scale !== undefined) c.scale = Math.min(10, Math.max(0.05, c.scale))
}

export type Edit =
  | { op: 'rename'; name: string }
  | { op: 'setFormat'; aspect?: Aspect; fps?: number }
  | { op: 'addMedia'; media: Media }
  | { op: 'removeMedia'; mediaId: string }
  | { op: 'addClip'; mediaId: string; start?: number; trackId?: string; sourceIn?: number; duration?: number }
  | { op: 'addText'; text: Partial<TextStyle> & { content: string }; start?: number; duration?: number; trackId?: string; fadeIn?: number; fadeOut?: number }
  | { op: 'updateClip'; clipId: string; patch: ClipPatch }
  | { op: 'moveClip'; clipId: string; start?: number; trackId?: string; afterClipId?: string; beforeClipId?: string }
  | { op: 'trimClip'; clipId: string; edge: 'start' | 'end'; time: number }
  | { op: 'splitClip'; clipId: string; time: number }
  | { op: 'deleteClips'; clipIds: string[] }
  | { op: 'deleteRange'; start: number; end: number; ripple: boolean }
  | { op: 'addSubtitles'; cues: { start: number; end: number; text: string }[]; trackId?: string }
  | { op: 'addTrack'; kind: 'video' | 'audio' }
  | { op: 'updateTrack'; trackId: string; muted?: boolean; hidden?: boolean }

export type ClipPatch = Partial<Pick<Clip, 'start' | 'duration' | 'sourceIn' | 'volume' | 'opacity' | 'scale' | 'x' | 'y' | 'fadeIn' | 'fadeOut' | 'trackId'>> & {
  text?: Partial<TextStyle>
}

export type EditResult = { clipIds?: string[]; mediaId?: string; trackId?: string }

const COLOR = /^#[0-9a-fA-F]{6}$/

function textStyle(base: TextStyle, patch: Partial<TextStyle>): TextStyle {
  const t = { ...base, ...patch }
  if (typeof t.content !== 'string' || !t.content.trim()) fail('Text cannot be empty.')
  if (!COLOR.test(t.color)) fail(`Text color must look like #ffcc00, not ${t.color}.`)
  if (!(t.size >= 8 && t.size <= 400)) fail('Text size must be between 8 and 400 px.')
  if (!['top', 'center', 'bottom', 'lower-third'].includes(t.position)) fail(`Unknown text position ${t.position}.`)
  if (!['none', 'fade', 'slide-up'].includes(t.animation)) fail(`Unknown text animation ${t.animation}.`)
  return t
}

/** Shift every clip that starts at or after `from` by `delta` seconds. */
function shiftAfter(p: Project, from: number, delta: number): void {
  for (const c of p.clips) if (c.start >= from - EPS) c.start = round(Math.max(0, c.start + delta))
}

function split(p: Project, c: Clip, time: number): Clip {
  const minDur = 1 / p.fps
  const offset = time - c.start
  if (offset < minDur - EPS || c.duration - offset < minDur - EPS) fail('The split point must be inside the clip.')
  const right: Clip = { ...structuredClone(c), id: newId('clp'), start: round(time), duration: round(c.duration - offset), fadeIn: 0 }
  if (right.sourceIn !== undefined) right.sourceIn = round((c.sourceIn ?? 0) + offset)
  c.duration = round(offset)
  c.fadeOut = 0
  p.clips.push(right)
  return right
}

function apply(p: Project, e: Edit): EditResult {
  switch (e.op) {
    case 'rename':
      if (!e.name.trim()) fail('The project name cannot be empty.')
      p.name = e.name.trim()
      return {}
    case 'setFormat':
      if (e.aspect) {
        if (!SIZES[e.aspect]) fail(`Aspect must be 16:9, 9:16 or 1:1.`)
        Object.assign(p, { aspect: e.aspect }, SIZES[e.aspect])
      }
      if (e.fps !== undefined) {
        if (![24, 25, 30, 50, 60].includes(e.fps)) fail('Frame rate must be 24, 25, 30, 50 or 60.')
        p.fps = e.fps
      }
      return {}
    case 'addMedia':
      if (p.media.some(m => m.path === e.media.path)) {
        const existing = p.media.find(m => m.path === e.media.path)!
        return { mediaId: existing.id }
      }
      p.media.push(e.media)
      return { mediaId: e.media.id }
    case 'removeMedia': {
      findMedia(p, e.mediaId)
      const removed = p.clips.filter(c => c.mediaId === e.mediaId).map(c => c.id)
      p.media = p.media.filter(m => m.id !== e.mediaId)
      p.clips = p.clips.filter(c => c.mediaId !== e.mediaId)
      return { clipIds: removed }
    }
    case 'addClip': {
      const m = findMedia(p, e.mediaId)
      const sourceIn = e.sourceIn ?? 0
      const duration = e.duration ?? (m.duration > 0 ? m.duration - sourceIn : 5)
      // Default placement: right after everything on the chosen kind of track.
      const start = e.start ?? p.clips.filter(c => (c.kind === 'audio') === (m.kind === 'audio')).reduce((t, c) => Math.max(t, clipEnd(c)), 0)
      const trackId = trackFor(p, m.kind, e.trackId, start, duration)
      const c: Clip = { id: newId('clp'), kind: m.kind, trackId, start, duration, mediaId: m.id, sourceIn: m.kind === 'image' ? undefined : sourceIn }
      if (m.kind !== 'image' && m.hasAudio) c.volume = 1
      clampTiming(p, c)
      p.clips.push(c)
      return { clipIds: [c.id], trackId }
    }
    case 'addText': {
      const start = e.start ?? 0
      const duration = e.duration ?? 4
      const trackId = trackFor(p, 'text', e.trackId, start, duration)
      const c: Clip = {
        id: newId('clp'),
        kind: 'text',
        trackId,
        start,
        duration,
        text: textStyle(DEFAULT_TEXT, e.text),
        fadeIn: e.fadeIn,
        fadeOut: e.fadeOut,
      }
      clampTiming(p, c)
      p.clips.push(c)
      return { clipIds: [c.id], trackId }
    }
    case 'updateClip': {
      const c = findClip(p, e.clipId)
      const { text, trackId, ...rest } = e.patch
      for (const [k, v] of Object.entries(rest)) {
        if (v === undefined) continue
        if (typeof v !== 'number' || !isFinite(v)) fail(`${k} must be a number.`)
        ;(c as Record<string, unknown>)[k] = v
      }
      if (trackId) c.trackId = trackFor(p, c.kind, trackId)
      if (text) {
        if (!c.text) fail('Only text clips have text settings.')
        c.text = textStyle(c.text, text)
      }
      clampTiming(p, c)
      return { clipIds: [c.id] }
    }
    case 'moveClip': {
      const c = findClip(p, e.clipId)
      if (e.trackId) c.trackId = trackFor(p, c.kind, e.trackId)
      const anchorId = e.afterClipId ?? e.beforeClipId
      if (anchorId) {
        const anchor = findClip(p, anchorId)
        if (anchor.id === c.id) fail('A clip cannot be placed after itself.')
        // Insert: remove the clip from its place, then make room after the anchor on this track.
        const oldStart = c.start
        const len = c.duration
        const sameTrack = p.clips.filter(x => x.trackId === c.trackId && x.id !== c.id)
        for (const x of sameTrack) if (x.start > oldStart + EPS) x.start = round(x.start - len)
        const at = e.afterClipId ? clipEnd(anchor) : anchor.start
        for (const x of sameTrack) if (x.start >= at - EPS) x.start = round(x.start + len)
        c.start = round(at)
      } else if (e.start !== undefined) c.start = e.start
      clampTiming(p, c)
      return { clipIds: [c.id] }
    }
    case 'trimClip': {
      const c = findClip(p, e.clipId)
      const minDur = 1 / p.fps
      const end = clipEnd(c)
      if (e.edge === 'start') {
        let t = Math.min(e.time, end - minDur)
        if (c.sourceIn !== undefined) t = Math.max(t, c.start - c.sourceIn)
        t = Math.max(0, t)
        const delta = t - c.start
        if (c.sourceIn !== undefined) c.sourceIn += delta
        c.start = t
        c.duration = end - t
      } else c.duration = Math.max(e.time, c.start + minDur) - c.start
      clampTiming(p, c)
      return { clipIds: [c.id] }
    }
    case 'splitClip': {
      const c = findClip(p, e.clipId)
      const right = split(p, c, e.time)
      return { clipIds: [c.id, right.id] }
    }
    case 'deleteClips': {
      for (const id of e.clipIds) findClip(p, id)
      const ids = new Set(e.clipIds)
      p.clips = p.clips.filter(c => !ids.has(c.id))
      return { clipIds: e.clipIds }
    }
    case 'deleteRange': {
      if (!(e.end > e.start + EPS) || e.start < 0) fail('The range end must be after its start, from 0 seconds on.')
      // Split clips crossing the edges, drop what lies inside, close the gap if ripple.
      for (const c of [...p.clips]) if (c.start < e.start - EPS && clipEnd(c) > e.start + EPS) split(p, c, e.start)
      for (const c of [...p.clips]) if (c.start < e.end - EPS && clipEnd(c) > e.end + EPS) split(p, c, e.end)
      const inside = p.clips.filter(c => c.start >= e.start - EPS && clipEnd(c) <= e.end + EPS).map(c => c.id)
      p.clips = p.clips.filter(c => !inside.includes(c.id))
      if (e.ripple) shiftAfter(p, e.end, -(e.end - e.start))
      return { clipIds: inside }
    }
    case 'addSubtitles': {
      if (!e.cues.length) fail('No subtitle cues were given.')
      const ids: string[] = []
      let trackId = e.trackId
      if (!trackId) {
        trackId = `V${p.tracks.filter(t => t.kind === 'video').length + 1}`
        p.tracks.unshift({ id: trackId, kind: 'video', name: `${trackId} Subtitles` })
      }
      for (const cue of e.cues) {
        if (!(cue.end > cue.start)) fail(`Subtitle "${cue.text}" ends before it starts.`)
        const r = apply(p, {
          op: 'addText',
          text: { content: cue.text, size: 54, position: 'bottom', box: true, animation: 'none' },
          start: cue.start,
          duration: cue.end - cue.start,
          trackId,
        })
        ids.push(...(r.clipIds ?? []))
      }
      return { clipIds: ids, trackId }
    }
    case 'addTrack': {
      const id = `${e.kind === 'video' ? 'V' : 'A'}${p.tracks.filter(t => t.kind === e.kind).length + 1}`
      if (p.tracks.some(t => t.id === id)) fail(`Track ${id} already exists.`)
      const t: Track = { id, kind: e.kind, name: id }
      if (e.kind === 'video') p.tracks.unshift(t)
      else p.tracks.push(t)
      return { trackId: id }
    }
    case 'updateTrack': {
      const t = p.tracks.find(x => x.id === e.trackId) ?? fail(`No track ${e.trackId}.`)
      if (e.muted !== undefined) t.muted = e.muted
      if (e.hidden !== undefined) t.hidden = e.hidden
      return { trackId: t.id }
    }
  }
}

/** Apply one or more edits atomically; the input project is never changed. */
export function applyEdit(project: Project, edits: Edit | Edit[]): { project: Project; result: EditResult } {
  const p = structuredClone(project)
  let result: EditResult = {}
  for (const e of Array.isArray(edits) ? edits : [edits]) {
    const r = apply(p, e)
    result = { ...result, ...r, clipIds: [...(result.clipIds ?? []), ...(r.clipIds ?? [])] }
  }
  p.updatedAt = new Date().toISOString()
  return { project: p, result }
}

/** Human summary of the project for Claude: ids, times and what is where. */
export function describeProject(p: Project, extra: { playhead?: number; selection?: string[]; missing?: string[] } = {}) {
  const mediaName = (id?: string) => p.media.find(m => m.id === id)?.name
  const tracks = p.tracks.map(t => ({
    id: t.id,
    kind: t.kind,
    muted: t.muted || undefined,
    hidden: t.hidden || undefined,
    clips: p.clips
      .filter(c => c.trackId === t.id)
      .sort((a, b) => a.start - b.start)
      .map(c => ({
        id: c.id,
        kind: c.kind,
        start: c.start,
        end: round(clipEnd(c)),
        media: mediaName(c.mediaId),
        mediaId: c.mediaId,
        sourceIn: c.sourceIn,
        text: c.text?.content,
        opacity: c.opacity,
        volume: c.volume,
        fadeIn: c.fadeIn || undefined,
        fadeOut: c.fadeOut || undefined,
      })),
  }))
  return {
    name: p.name,
    format: `${p.width}x${p.height} ${p.aspect} @ ${p.fps} fps`,
    duration: round(projectDuration(p)),
    playhead: extra.playhead,
    selection: extra.selection,
    media: p.media.map(m => ({
      id: m.id,
      name: m.name,
      kind: m.kind,
      duration: m.duration,
      size: m.width ? `${m.width}x${m.height}` : undefined,
      hasAudio: m.hasAudio,
      missing: extra.missing?.includes(m.id) || undefined,
    })),
    tracks,
  }
}

export function formatTime(t: number, fps = 30): string {
  const total = Math.max(0, Math.round(t * fps))
  const f = total % fps
  const s = Math.floor(total / fps)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}.${String(f).padStart(2, '0')}`
}

/** Parse "1:23.5", "83.5" or "83.5s" into seconds. */
export function parseTime(text: string): number | null {
  const s = text.trim().replace(/s$/, '')
  if (/^\d+(\.\d+)?$/.test(s)) return Number(s)
  const m = /^(\d+):(\d{1,2}(?:\.\d+)?)$/.exec(s)
  return m ? Number(m[1]) * 60 + Number(m[2]) : null
}
