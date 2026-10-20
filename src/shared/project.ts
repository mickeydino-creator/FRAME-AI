import {
  AspectRatio,
  Clip,
  ClipAnimation,
  ClipType,
  MediaAsset,
  Project,
  PROJECT_FORMAT,
  PROJECT_VERSION,
  ShapeStyle,
  TextStyle,
  Track,
  TrackKind,
  Transform
} from './types'
import { uid } from './util'

export const ASPECT_SIZES: Record<AspectRatio, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 }
}

export const DEFAULT_TRANSFORM: Transform = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }
export const NO_ANIMATION: ClipAnimation = { preset: 'none', duration: 0.5 }

export const DEFAULT_TEXT: TextStyle = {
  text: 'Your title here',
  fontFamily: 'Segoe UI',
  fontSize: 96,
  fontWeight: 700,
  italic: false,
  color: '#ffffff',
  align: 'center',
  lineHeight: 1.15,
  letterSpacing: 0,
  maxWidth: 0,
  strokeColor: '#000000',
  strokeWidth: 0,
  shadowColor: 'rgba(0,0,0,0.5)',
  shadowBlur: 0,
  shadowOffsetY: 0,
  backgroundColor: '',
  backgroundPadding: 24,
  backgroundRadius: 12,
  uppercase: false
}

export const DEFAULT_SHAPE: ShapeStyle = {
  shape: 'rect',
  width: 600,
  height: 300,
  fill: { kind: 'solid', color: '#3d8bff' },
  strokeColor: '#ffffff',
  strokeWidth: 0,
  cornerRadius: 0
}

/** Default duration (seconds) for clips that have no intrinsic length. */
export const DEFAULT_STILL_DURATION = 5

export const FONT_FAMILIES = [
  'Segoe UI',
  'Arial',
  'Arial Black',
  'Helvetica',
  'Impact',
  'Georgia',
  'Times New Roman',
  'Trebuchet MS',
  'Verdana',
  'Tahoma',
  'Courier New',
  'Consolas',
  'Bahnschrift',
  'Segoe Script',
  'Comic Sans MS'
]

export function createTrack(kind: TrackKind, name: string): Track {
  return { id: uid('trk'), name, kind, muted: false, hidden: false, locked: false }
}

export function createProject(name = 'Untitled Project', aspect: AspectRatio = '16:9', fps = 30): Project {
  const now = new Date().toISOString()
  return {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: uid('prj'),
    name,
    createdAt: now,
    updatedAt: now,
    settings: { aspect, ...ASPECT_SIZES[aspect], fps, background: '#000000' },
    media: [],
    tracks: [
      createTrack('video', 'V2'),
      createTrack('video', 'V1'),
      createTrack('audio', 'A1'),
      createTrack('audio', 'A2')
    ],
    clips: []
  }
}

/** Build a complete clip of the given type, filling every field with defaults. */
export function createClip(type: ClipType, trackId: string, input: Partial<Clip> = {}): Clip {
  // Ignore explicitly-undefined fields so they don't clobber defaults.
  const partial = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<Clip>
  const base: Clip = {
    id: uid('clp'),
    trackId,
    type,
    name: defaultClipName(type),
    start: 0,
    duration: DEFAULT_STILL_DURATION,
    transform: { ...DEFAULT_TRANSFORM },
    keyframes: {},
    animIn: { ...NO_ANIMATION },
    animOut: { ...NO_ANIMATION },
    fadeIn: 0,
    fadeOut: 0
  }
  if (type === 'video' || type === 'image' || type === 'audio') {
    base.sourceStart = 0
    base.fit = 'contain'
  }
  if (type === 'video' || type === 'audio') {
    base.volume = 1
    base.muted = false
  }
  if (type === 'text') base.text = { ...DEFAULT_TEXT }
  if (type === 'shape') base.shape = { ...DEFAULT_SHAPE, fill: { ...DEFAULT_SHAPE.fill } }
  if (type === 'background') base.fill = { kind: 'solid', color: '#111318' }
  const merged: Clip = {
    ...base,
    ...partial,
    transform: { ...base.transform, ...(partial.transform ?? {}) },
    animIn: { ...base.animIn, ...(partial.animIn ?? {}) },
    animOut: { ...base.animOut, ...(partial.animOut ?? {}) },
    keyframes: { ...(partial.keyframes ?? {}) }
  }
  if (base.text) merged.text = { ...base.text, ...(partial.text ?? {}) }
  if (base.shape) merged.shape = { ...base.shape, ...(partial.shape ?? {}) }
  if (partial.id === undefined) merged.id = base.id
  return merged
}

function defaultClipName(type: ClipType): string {
  switch (type) {
    case 'text':
      return 'Text'
    case 'shape':
      return 'Shape'
    case 'background':
      return 'Background'
    default:
      return 'Clip'
  }
}

export function trackKindForClip(type: ClipType): TrackKind {
  return type === 'audio' ? 'audio' : 'video'
}

export function clipEnd(c: Clip): number {
  return c.start + c.duration
}

export function projectDuration(p: Project): number {
  let d = 0
  for (const c of p.clips) d = Math.max(d, clipEnd(c))
  return d
}

export function findMedia(p: Project, id: string | undefined): MediaAsset | undefined {
  if (!id) return undefined
  return p.media.find((m) => m.id === id)
}

export function findClip(p: Project, id: string): Clip | undefined {
  return p.clips.find((c) => c.id === id)
}

export function findTrack(p: Project, id: string): Track | undefined {
  return p.tracks.find((t) => t.id === id)
}

/** Whether a clip plays sound (audio clips and video clips with an audio stream). */
export function clipHasAudio(p: Project, c: Clip): boolean {
  if (c.type !== 'audio' && c.type !== 'video') return false
  const m = findMedia(p, c.mediaId)
  return !!m && m.hasAudio
}

export function isVisualClip(c: Clip): boolean {
  return c.type !== 'audio'
}

export function nextTrackName(p: Project, kind: TrackKind): string {
  const prefix = kind === 'video' ? 'V' : 'A'
  let n = 1
  const names = new Set(p.tracks.map((t) => t.name))
  while (names.has(`${prefix}${n}`)) n++
  return `${prefix}${n}`
}

export class ProjectFormatError extends Error {}

/**
 * Validate and upgrade a parsed project file. Unknown/missing fields are
 * filled with defaults so older or hand-edited files keep loading.
 */
export function migrateProject(raw: unknown): Project {
  if (!raw || typeof raw !== 'object') throw new ProjectFormatError('Project file is empty or not valid JSON.')
  const r = raw as Record<string, unknown>
  if (r.format !== PROJECT_FORMAT) throw new ProjectFormatError('This file is not a FRAME AI project.')
  const version = typeof r.version === 'number' ? r.version : 0
  if (version > PROJECT_VERSION)
    throw new ProjectFormatError(
      `This project was saved by a newer version of FRAME AI (format v${version}). Please update the app.`
    )
  const fresh = createProject()
  const settingsRaw = (r.settings ?? {}) as Partial<Project['settings']>
  const aspect = (['16:9', '9:16', '1:1'] as const).includes(settingsRaw.aspect as AspectRatio)
    ? (settingsRaw.aspect as AspectRatio)
    : '16:9'
  const project: Project = {
    format: PROJECT_FORMAT,
    version: PROJECT_VERSION,
    id: typeof r.id === 'string' ? r.id : fresh.id,
    name: typeof r.name === 'string' ? r.name : 'Untitled Project',
    createdAt: typeof r.createdAt === 'string' ? r.createdAt : fresh.createdAt,
    updatedAt: typeof r.updatedAt === 'string' ? r.updatedAt : fresh.updatedAt,
    settings: {
      aspect,
      width: Number(settingsRaw.width) || ASPECT_SIZES[aspect].width,
      height: Number(settingsRaw.height) || ASPECT_SIZES[aspect].height,
      fps: Number(settingsRaw.fps) || 30,
      background: typeof settingsRaw.background === 'string' ? settingsRaw.background : '#000000'
    },
    media: Array.isArray(r.media) ? (r.media as MediaAsset[]).map((m) => ({ ...m, missing: undefined })) : [],
    tracks: Array.isArray(r.tracks)
      ? (r.tracks as Track[]).map((t) => ({ ...createTrack(t.kind === 'audio' ? 'audio' : 'video', t.name), ...t }))
      : fresh.tracks,
    clips: []
  }
  const trackIds = new Set(project.tracks.map((t) => t.id))
  for (const c of Array.isArray(r.clips) ? (r.clips as Clip[]) : []) {
    if (!c || typeof c !== 'object' || !trackIds.has(c.trackId)) continue
    project.clips.push(createClip(c.type, c.trackId, c))
  }
  return project
}

/** Strip runtime-only fields before writing to disk. */
export function serializeProject(p: Project): string {
  const clean: Project = {
    ...p,
    updatedAt: new Date().toISOString(),
    media: p.media.map(({ missing: _missing, ...m }) => m)
  }
  return JSON.stringify(clean, null, 2)
}
