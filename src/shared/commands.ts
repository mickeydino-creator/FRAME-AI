/**
 * FRAME AI editing command layer (pure state transitions).
 *
 * Every edit to a project is expressed as a serializable `Command` object and
 * applied by `applyCommand`, which never mutates its input. This keeps the
 * editor deterministic, makes undo/redo trivial, and lets an external
 * controller (scripts, tests, a future MCP server) drive the editor by sending
 * the same JSON commands the UI uses. See docs/COMMANDS.md.
 */
import { produce, Draft } from 'immer'
import {
  AnimatableProp,
  ANIMATABLE_PROPS,
  AnimationPreset,
  AspectRatio,
  Clip,
  ClipType,
  Easing,
  Fill,
  MediaAsset,
  Project,
  ShapeStyle,
  TextStyle,
  Track,
  TrackKind,
  Transform
} from './types'
import {
  ASPECT_SIZES,
  clipEnd,
  createClip,
  createTrack,
  DEFAULT_STILL_DURATION,
  findMedia,
  nextTrackName,
  trackKindForClip
} from './project'
import { evaluateKeyframes } from './animation'
import { clamp, round, uid } from './util'

export type ClipPatch = Partial<
  Omit<Clip, 'id' | 'type' | 'trackId' | 'transform' | 'text' | 'shape' | 'animIn' | 'animOut' | 'keyframes'>
> & {
  transform?: Partial<Transform>
  text?: Partial<TextStyle>
  shape?: Partial<ShapeStyle>
  fill?: Fill
  animIn?: Partial<Clip['animIn']>
  animOut?: Partial<Clip['animOut']>
}

export type Command =
  | { type: 'setProjectName'; name: string }
  | { type: 'setProjectSettings'; aspect?: AspectRatio; fps?: number; background?: string }
  | { type: 'addMedia'; asset: MediaAsset }
  | { type: 'updateMedia'; mediaId: string; patch: Partial<MediaAsset> }
  | { type: 'removeMedia'; mediaId: string }
  | { type: 'addTrack'; kind: TrackKind; index?: number; name?: string; id?: string }
  | { type: 'removeTrack'; trackId: string }
  | { type: 'moveTrack'; trackId: string; index: number }
  | { type: 'updateTrack'; trackId: string; patch: Partial<Pick<Track, 'name' | 'muted' | 'hidden' | 'locked'>> }
  | { type: 'addClip'; clip: Partial<Clip> & { type: ClipType }; trackId?: string; start?: number }
  | { type: 'addMediaClip'; mediaId: string; trackId?: string; start?: number; duration?: number }
  | {
      type: 'addText'
      text?: string
      style?: Partial<TextStyle>
      start?: number
      duration?: number
      trackId?: string
      transform?: Partial<Transform>
      animIn?: { preset: AnimationPreset; duration?: number }
      animOut?: { preset: AnimationPreset; duration?: number }
    }
  | { type: 'moveClip'; clipId: string; start: number; trackId?: string }
  | { type: 'trimClip'; clipId: string; edge: 'start' | 'end'; time: number }
  | { type: 'setClipTiming'; clipId: string; start?: number; duration?: number; sourceStart?: number }
  | { type: 'splitClip'; clipId: string; time: number }
  | { type: 'deleteClips'; clipIds: string[] }
  | { type: 'duplicateClip'; clipId: string; start?: number; trackId?: string }
  | { type: 'updateClip'; clipId: string; patch: ClipPatch }
  | { type: 'setAnimation'; clipId: string; which: 'in' | 'out'; preset: AnimationPreset; duration?: number }
  | { type: 'setKeyframe'; clipId: string; prop: AnimatableProp; time: number; value: number; ease?: Easing }
  | { type: 'removeKeyframe'; clipId: string; prop: AnimatableProp; time: number }
  | { type: 'clearKeyframes'; clipId: string; prop?: AnimatableProp }
  | { type: 'crossfade'; clipId: string; duration: number }
  | { type: 'batch'; commands: Command[] }

export type CommandType = Command['type']

export interface CommandResult {
  clipId?: string
  clipIds?: string[]
  trackId?: string
  mediaId?: string
  results?: CommandResult[]
}

export class CommandError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CommandError'
  }
}

const EPS = 1e-6

function fail(msg: string): never {
  throw new CommandError(msg)
}

function minDuration(p: Project): number {
  return 1 / p.settings.fps
}

function getClip(p: Draft<Project>, id: string): Draft<Clip> {
  const c = p.clips.find((x) => x.id === id)
  if (!c) fail(`Clip not found: ${id}`)
  return c
}

function getTrack(p: Draft<Project>, id: string): Draft<Track> {
  const t = p.tracks.find((x) => x.id === id)
  if (!t) fail(`Track not found: ${id}`)
  return t
}

function sourceLength(p: Project, c: Clip): number | null {
  if (c.type !== 'video' && c.type !== 'audio') return null
  const m = findMedia(p, c.mediaId)
  return m && m.duration > 0 ? m.duration : null
}

function sortTracks(p: Draft<Project>): void {
  // Keep all video tracks above audio tracks while preserving relative order.
  const video = p.tracks.filter((t) => t.kind === 'video')
  const audio = p.tracks.filter((t) => t.kind === 'audio')
  p.tracks.splice(0, p.tracks.length, ...video, ...audio)
}

function overlaps(p: Project, trackId: string, start: number, end: number, ignoreId?: string): boolean {
  return p.clips.some(
    (c) => c.trackId === trackId && c.id !== ignoreId && c.start < end - EPS && clipEnd(c) > start + EPS
  )
}

/**
 * Choose a track for a new clip: the requested one if compatible, otherwise
 * the lowest free video track (or first free audio track), creating a new
 * track when every compatible track is occupied at that time.
 */
function resolveTrack(
  p: Draft<Project>,
  kind: TrackKind,
  start: number,
  duration: number,
  requested?: string,
  preferTop = false
): string {
  if (requested) {
    const t = p.tracks.find((x) => x.id === requested)
    if (t && t.kind === kind) return t.id
  }
  let candidates = p.tracks.filter((t) => t.kind === kind && !t.locked)
  if (kind === 'video' && !preferTop) candidates = [...candidates].reverse()
  const free = candidates.find((t) => !overlaps(p as Project, t.id, start, start + duration))
  if (free) return free.id
  const track = createTrack(kind, nextTrackName(p as Project, kind))
  if (kind === 'video') p.tracks.unshift(track)
  else p.tracks.push(track)
  return track.id
}

function normalizeKeyframes(c: Draft<Clip>): void {
  for (const prop of ANIMATABLE_PROPS) {
    const kfs = c.keyframes[prop]
    if (!kfs) continue
    const filtered = kfs.filter((k) => k.t >= -EPS && k.t <= c.duration + EPS)
    filtered.sort((a, b) => a.t - b.t)
    if (filtered.length === 0) delete c.keyframes[prop]
    else c.keyframes[prop] = filtered
  }
}

function clampClipSettings(c: Draft<Clip>): void {
  c.transform.opacity = clamp(c.transform.opacity, 0, 1)
  c.transform.scale = Math.max(0, c.transform.scale)
  if (c.volume !== undefined) c.volume = clamp(c.volume, 0, 2)
  c.fadeIn = clamp(c.fadeIn, 0, c.duration)
  c.fadeOut = clamp(c.fadeOut, 0, c.duration)
  c.animIn.duration = clamp(c.animIn.duration, 0, c.duration)
  c.animOut.duration = clamp(c.animOut.duration, 0, c.duration)
  if (c.text) c.text.fontSize = Math.max(1, c.text.fontSize)
}

/** Validate and set timing, respecting source media bounds. */
function setTiming(
  p: Draft<Project>,
  c: Draft<Clip>,
  next: { start?: number; duration?: number; sourceStart?: number }
): void {
  const minDur = minDuration(p as Project)
  const start = next.start ?? c.start
  let duration = next.duration ?? c.duration
  let sourceStart = next.sourceStart ?? c.sourceStart ?? 0
  if (!isFinite(start) || !isFinite(duration) || !isFinite(sourceStart)) fail('Timing values must be numbers.')
  if (start < -EPS) fail('Clip start cannot be negative.')
  if (duration < minDur - EPS) fail(`Clip duration must be at least one frame (${round(minDur, 3)}s).`)
  const srcLen = sourceLength(p as Project, c as Clip)
  if (srcLen !== null) {
    sourceStart = clamp(sourceStart, 0, Math.max(0, srcLen - minDur))
    duration = Math.min(duration, srcLen - sourceStart)
  }
  c.start = round(Math.max(0, start), 6)
  c.duration = round(duration, 6)
  if (c.sourceStart !== undefined) c.sourceStart = round(sourceStart, 6)
  normalizeKeyframes(c)
  clampClipSettings(c)
}

function addClipInternal(
  p: Draft<Project>,
  partial: Partial<Clip> & { type: ClipType },
  trackId: string | undefined,
  start: number | undefined,
  preferTop = false
): Draft<Clip> {
  const st = Math.max(0, start ?? partial.start ?? 0)
  let duration = partial.duration ?? DEFAULT_STILL_DURATION
  if (partial.mediaId) {
    const m = findMedia(p as Project, partial.mediaId)
    if (!m) fail(`Media not found: ${partial.mediaId}`)
    if (partial.duration === undefined && m.duration > 0) duration = m.duration - (partial.sourceStart ?? 0)
  }
  const kind = trackKindForClip(partial.type)
  const tid = resolveTrack(p, kind, st, duration, trackId ?? partial.trackId, preferTop)
  const clip = createClip(partial.type, tid, { ...partial, id: undefined, start: st, duration, trackId: tid })
  p.clips.push(clip)
  const c = p.clips[p.clips.length - 1]
  setTiming(p, c, {})
  return c
}

function splitKeyframes(c: Draft<Clip>, right: Draft<Clip>, offset: number): void {
  for (const prop of ANIMATABLE_PROPS) {
    const kfs = c.keyframes[prop]
    if (!kfs || kfs.length === 0) continue
    const boundary = evaluateKeyframes(kfs as never, offset)
    const before = kfs.filter((k) => k.t < offset - EPS)
    const after = kfs.filter((k) => k.t > offset + EPS)
    const easeAt = (before[before.length - 1]?.ease ?? 'linear') as Easing
    c.keyframes[prop] = [...before, { t: offset, v: boundary, ease: easeAt }]
    right.keyframes[prop] = [{ t: 0, v: boundary, ease: easeAt }, ...after.map((k) => ({ ...k, t: k.t - offset }))]
  }
}

function apply(p: Draft<Project>, cmd: Command): CommandResult {
  switch (cmd.type) {
    case 'setProjectName': {
      const name = cmd.name.trim()
      if (!name) fail('Project name cannot be empty.')
      p.name = name
      return {}
    }
    case 'setProjectSettings': {
      if (cmd.aspect) {
        if (!ASPECT_SIZES[cmd.aspect]) fail(`Unsupported aspect ratio: ${cmd.aspect}`)
        p.settings.aspect = cmd.aspect
        p.settings.width = ASPECT_SIZES[cmd.aspect].width
        p.settings.height = ASPECT_SIZES[cmd.aspect].height
      }
      if (cmd.fps !== undefined) {
        if (![24, 25, 30, 50, 60].includes(cmd.fps)) fail('Frame rate must be 24, 25, 30, 50 or 60.')
        p.settings.fps = cmd.fps
      }
      if (cmd.background !== undefined) p.settings.background = cmd.background
      return {}
    }
    case 'addMedia': {
      if (p.media.some((m) => m.id === cmd.asset.id)) fail(`Media already exists: ${cmd.asset.id}`)
      p.media.push(cmd.asset)
      return { mediaId: cmd.asset.id }
    }
    case 'updateMedia': {
      const m = p.media.find((x) => x.id === cmd.mediaId)
      if (!m) fail(`Media not found: ${cmd.mediaId}`)
      Object.assign(m, cmd.patch, { id: m.id })
      return { mediaId: m.id }
    }
    case 'removeMedia': {
      const idx = p.media.findIndex((x) => x.id === cmd.mediaId)
      if (idx < 0) fail(`Media not found: ${cmd.mediaId}`)
      p.media.splice(idx, 1)
      const removed = p.clips.filter((c) => c.mediaId === cmd.mediaId).map((c) => c.id)
      p.clips = p.clips.filter((c) => c.mediaId !== cmd.mediaId)
      return { mediaId: cmd.mediaId, clipIds: removed }
    }
    case 'addTrack': {
      const t = createTrack(cmd.kind, cmd.name?.trim() || nextTrackName(p as Project, cmd.kind))
      if (cmd.id) {
        if (p.tracks.some((x) => x.id === cmd.id)) fail(`Track already exists: ${cmd.id}`)
        t.id = cmd.id
      }
      if (cmd.index !== undefined) p.tracks.splice(clamp(cmd.index, 0, p.tracks.length), 0, t)
      else if (cmd.kind === 'video') p.tracks.unshift(t)
      else p.tracks.push(t)
      sortTracks(p)
      return { trackId: t.id }
    }
    case 'removeTrack': {
      getTrack(p, cmd.trackId)
      p.tracks = p.tracks.filter((t) => t.id !== cmd.trackId)
      const removed = p.clips.filter((c) => c.trackId === cmd.trackId).map((c) => c.id)
      p.clips = p.clips.filter((c) => c.trackId !== cmd.trackId)
      return { trackId: cmd.trackId, clipIds: removed }
    }
    case 'moveTrack': {
      const idx = p.tracks.findIndex((t) => t.id === cmd.trackId)
      if (idx < 0) fail(`Track not found: ${cmd.trackId}`)
      const [t] = p.tracks.splice(idx, 1)
      p.tracks.splice(clamp(cmd.index, 0, p.tracks.length), 0, t)
      sortTracks(p)
      return { trackId: t.id }
    }
    case 'updateTrack': {
      const t = getTrack(p, cmd.trackId)
      const { name, muted, hidden, locked } = cmd.patch
      if (name !== undefined && name.trim()) t.name = name.trim()
      if (muted !== undefined) t.muted = muted
      if (hidden !== undefined) t.hidden = hidden
      if (locked !== undefined) t.locked = locked
      return { trackId: t.id }
    }
    case 'addClip': {
      const c = addClipInternal(p, cmd.clip, cmd.trackId, cmd.start, cmd.clip.type !== 'background')
      return { clipId: c.id, trackId: c.trackId }
    }
    case 'addMediaClip': {
      const m = findMedia(p as Project, cmd.mediaId)
      if (!m) fail(`Media not found: ${cmd.mediaId}`)
      const type: ClipType = m.type === 'image' ? 'image' : m.type === 'audio' ? 'audio' : 'video'
      const c = addClipInternal(
        p,
        { type, mediaId: m.id, name: m.name, duration: cmd.duration },
        cmd.trackId,
        cmd.start
      )
      return { clipId: c.id, trackId: c.trackId }
    }
    case 'addText': {
      const c = addClipInternal(
        p,
        {
          type: 'text',
          name: (cmd.text ?? cmd.style?.text ?? 'Text').split('\n')[0].slice(0, 40) || 'Text',
          duration: cmd.duration,
          text: { ...(cmd.style as TextStyle), ...(cmd.text !== undefined ? { text: cmd.text } : {}) },
          transform: cmd.transform as Transform,
          animIn: cmd.animIn ? { preset: cmd.animIn.preset, duration: cmd.animIn.duration ?? 0.6 } : undefined,
          animOut: cmd.animOut ? { preset: cmd.animOut.preset, duration: cmd.animOut.duration ?? 0.6 } : undefined
        },
        cmd.trackId,
        cmd.start,
        true
      )
      return { clipId: c.id, trackId: c.trackId }
    }
    case 'moveClip': {
      const c = getClip(p, cmd.clipId)
      if (cmd.trackId && cmd.trackId !== c.trackId) {
        const t = getTrack(p, cmd.trackId)
        if (t.kind !== trackKindForClip(c.type))
          fail(`A ${c.type} clip cannot be placed on a ${t.kind} track.`)
        if (t.locked) fail(`Track ${t.name} is locked.`)
        c.trackId = t.id
      }
      setTiming(p, c, { start: Math.max(0, cmd.start) })
      return { clipId: c.id, trackId: c.trackId }
    }
    case 'trimClip': {
      const c = getClip(p, cmd.clipId)
      const minDur = minDuration(p as Project)
      const end = clipEnd(c)
      if (cmd.edge === 'start') {
        let newStart = Math.min(cmd.time, end - minDur)
        const srcLen = sourceLength(p as Project, c as Clip)
        const src = c.sourceStart ?? 0
        // Cannot extend before the first frame of the source.
        if (srcLen !== null || c.type === 'image') newStart = Math.max(newStart, c.start - src)
        newStart = Math.max(0, newStart)
        const delta = newStart - c.start
        // Keep keyframes anchored to the same source moment.
        for (const prop of ANIMATABLE_PROPS) {
          const kfs = c.keyframes[prop]
          if (kfs) for (const k of kfs) k.t -= delta
        }
        setTiming(p, c, {
          start: newStart,
          duration: end - newStart,
          sourceStart: c.sourceStart !== undefined ? src + delta : undefined
        })
      } else {
        const newEnd = Math.max(cmd.time, c.start + minDur)
        setTiming(p, c, { duration: newEnd - c.start })
      }
      return { clipId: c.id }
    }
    case 'setClipTiming': {
      const c = getClip(p, cmd.clipId)
      setTiming(p, c, cmd)
      return { clipId: c.id }
    }
    case 'splitClip': {
      const c = getClip(p, cmd.clipId)
      const minDur = minDuration(p as Project)
      const offset = cmd.time - c.start
      if (offset < minDur - EPS || c.duration - offset < minDur - EPS)
        fail('The split point must be inside the clip.')
      const right = createClip(c.type, c.trackId, JSON.parse(JSON.stringify(c)) as Clip)
      right.id = uid('clp')
      right.start = round(cmd.time, 6)
      right.duration = round(c.duration - offset, 6)
      if (right.sourceStart !== undefined) right.sourceStart = round((c.sourceStart ?? 0) + offset, 6)
      right.fadeIn = 0
      right.animIn = { preset: 'none', duration: c.animIn.duration }
      right.keyframes = {}
      splitKeyframes(c, right as Draft<Clip>, offset)
      c.duration = round(offset, 6)
      c.fadeOut = 0
      c.animOut = { preset: 'none', duration: c.animOut.duration }
      p.clips.push(right)
      const r = p.clips[p.clips.length - 1]
      setTiming(p, c, {})
      setTiming(p, r, {})
      return { clipId: r.id, clipIds: [c.id, r.id] }
    }
    case 'deleteClips': {
      const ids = new Set(cmd.clipIds)
      p.clips = p.clips.filter((c) => !ids.has(c.id))
      return { clipIds: cmd.clipIds }
    }
    case 'duplicateClip': {
      const c = getClip(p, cmd.clipId)
      const copy = JSON.parse(JSON.stringify(c)) as Clip
      const start = cmd.start ?? clipEnd(c)
      const dup = addClipInternal(
        p,
        { ...copy, id: undefined, start, duration: c.duration },
        cmd.trackId ?? c.trackId,
        start
      )
      // addClipInternal resolves a free track only when the requested one is incompatible;
      // keep the duplicate on the same track (overlap is allowed).
      return { clipId: dup.id, trackId: dup.trackId }
    }
    case 'updateClip': {
      const c = getClip(p, cmd.clipId)
      const { transform, text, shape, fill, animIn, animOut, start, duration, sourceStart, ...rest } = cmd.patch
      const allowed: (keyof Clip)[] = ['name', 'volume', 'muted', 'fit', 'fadeIn', 'fadeOut', 'mediaId']
      for (const key of Object.keys(rest) as (keyof typeof rest)[]) {
        if (!allowed.includes(key as keyof Clip)) fail(`Property "${String(key)}" cannot be changed with updateClip.`)
        ;(c as Record<string, unknown>)[key] = rest[key]
      }
      if (transform) Object.assign(c.transform, transform)
      if (text) {
        if (!c.text) fail('Only text clips have text properties.')
        Object.assign(c.text, text)
      }
      if (shape) {
        if (!c.shape) fail('Only shape clips have shape properties.')
        Object.assign(c.shape, shape)
      }
      if (fill) {
        if (c.type !== 'background') fail('Only background clips have a fill; use shape.fill for shapes.')
        c.fill = fill
      }
      if (animIn) Object.assign(c.animIn, animIn)
      if (animOut) Object.assign(c.animOut, animOut)
      setTiming(p, c, { start, duration, sourceStart })
      return { clipId: c.id }
    }
    case 'setAnimation': {
      const c = getClip(p, cmd.clipId)
      if (cmd.preset === 'typewriter' && c.type !== 'text') fail('Typewriter animation only applies to text.')
      const target = cmd.which === 'in' ? c.animIn : c.animOut
      target.preset = cmd.preset
      if (cmd.duration !== undefined) target.duration = Math.max(0, cmd.duration)
      clampClipSettings(c)
      return { clipId: c.id }
    }
    case 'setKeyframe': {
      const c = getClip(p, cmd.clipId)
      if (!ANIMATABLE_PROPS.includes(cmd.prop)) fail(`Property cannot be keyframed: ${cmd.prop}`)
      const t = clamp(cmd.time, 0, c.duration)
      const list = c.keyframes[cmd.prop] ?? []
      const existing = list.find((k) => Math.abs(k.t - t) < 1e-3)
      if (existing) {
        existing.v = cmd.value
        if (cmd.ease) existing.ease = cmd.ease
      } else list.push({ t: round(t, 6), v: cmd.value, ease: cmd.ease ?? 'easeInOut' })
      c.keyframes[cmd.prop] = list
      normalizeKeyframes(c)
      return { clipId: c.id }
    }
    case 'removeKeyframe': {
      const c = getClip(p, cmd.clipId)
      const list = c.keyframes[cmd.prop]
      if (list) {
        c.keyframes[cmd.prop] = list.filter((k) => Math.abs(k.t - cmd.time) >= 1e-3)
        normalizeKeyframes(c)
      }
      return { clipId: c.id }
    }
    case 'clearKeyframes': {
      const c = getClip(p, cmd.clipId)
      if (cmd.prop) delete c.keyframes[cmd.prop]
      else c.keyframes = {}
      return { clipId: c.id }
    }
    case 'crossfade': {
      // Overlap this clip with the previous clip on the same track and fade
      // between them. Later clips draw on top, so fading this clip in over the
      // previous one produces a cross-dissolve (and an audio crossfade).
      const c = getClip(p, cmd.clipId)
      const prev = p.clips
        .filter((x) => x.trackId === c.trackId && x.id !== c.id && x.start < c.start - EPS)
        .sort((a, b) => clipEnd(b) - clipEnd(a))[0]
      if (!prev) fail('There is no previous clip on this track to transition from.')
      const d = Math.min(cmd.duration, c.duration, prev.duration)
      if (d <= 0) fail('Transition duration must be positive.')
      const newStart = Math.max(prev.start + EPS, clipEnd(prev) - d)
      setTiming(p, c, { start: newStart })
      const actual = clipEnd(prev) - c.start
      c.fadeIn = round(Math.max(actual, 0), 6)
      prev.fadeOut = round(Math.max(actual, 0), 6)
      clampClipSettings(c)
      clampClipSettings(prev)
      return { clipId: c.id, clipIds: [prev.id, c.id] }
    }
    case 'batch': {
      return { results: cmd.commands.map((sub) => apply(p, sub)) }
    }
    default: {
      const unknown = cmd as { type?: string }
      fail(`Unknown command: ${unknown.type}`)
    }
  }
}

/** Apply a command, returning the new project (input is never mutated). */
export function applyCommand(project: Project, cmd: Command): { project: Project; result: CommandResult } {
  let result: CommandResult = {}
  const next = produce(project, (draft) => {
    result = apply(draft, cmd)
  })
  return { project: next, result }
}

/** Human readable label for history UI. */
export function describeCommand(cmd: Command): string {
  switch (cmd.type) {
    case 'batch':
      return cmd.commands.length === 1 ? describeCommand(cmd.commands[0]) : `${cmd.commands.length} edits`
    default:
      return cmd.type.replace(/([A-Z])/g, ' $1').toLowerCase()
  }
}
