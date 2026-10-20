/**
 * FRAME AI project model.
 *
 * Everything in a project is plain, serializable JSON. All times are in
 * seconds (floating point). Positions are in composition pixels, measured as
 * an offset from the center of the frame, so changing the aspect ratio keeps
 * layers centered.
 */

export const PROJECT_FORMAT = 'frame-ai-project'
export const PROJECT_VERSION = 1

export type AspectRatio = '16:9' | '9:16' | '1:1'
export type TrackKind = 'video' | 'audio'
export type MediaType = 'video' | 'image' | 'audio'
export type ClipType = 'video' | 'image' | 'audio' | 'text' | 'shape' | 'background'

export interface ProjectSettings {
  aspect: AspectRatio
  width: number
  height: number
  fps: number
  /** Canvas color behind every layer. */
  background: string
}

export interface MediaAsset {
  id: string
  name: string
  type: MediaType
  /** Path of the copied asset, relative to the project directory. */
  file: string
  /** Optional preview-compatible transcode (relative path). */
  proxy?: string
  /** Thumbnail image (relative path). */
  thumbnail?: string
  /** Waveform peaks JSON (relative path). */
  waveform?: string
  /** Absolute path the file was originally imported from. */
  originalPath: string
  /** Seconds; 0 for still images. */
  duration: number
  width?: number
  height?: number
  fps?: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
  size: number
  importedAt: string
  /** Runtime only: the asset file could not be found when the project was opened. */
  missing?: boolean
}

export interface Track {
  id: string
  name: string
  kind: TrackKind
  muted: boolean
  hidden: boolean
  locked: boolean
}

export interface Transform {
  /** Horizontal offset from frame center, in composition pixels. */
  x: number
  /** Vertical offset from frame center, in composition pixels. */
  y: number
  /** Uniform scale multiplier (1 = natural / fitted size). */
  scale: number
  /** Degrees, clockwise. */
  rotation: number
  /** 0..1 */
  opacity: number
}

export type AnimatableProp = keyof Transform
export const ANIMATABLE_PROPS: AnimatableProp[] = ['x', 'y', 'scale', 'rotation', 'opacity']

export type Easing = 'linear' | 'easeIn' | 'easeOut' | 'easeInOut' | 'hold'

export interface Keyframe {
  /** Seconds relative to the clip start. */
  t: number
  v: number
  /** Easing used from this keyframe to the next one. */
  ease: Easing
}

export type AnimationPreset =
  | 'none'
  | 'fade'
  | 'slide-left'
  | 'slide-right'
  | 'slide-up'
  | 'slide-down'
  | 'scale'
  | 'pop'
  | 'zoom'
  | 'rotate'
  | 'wipe-left'
  | 'wipe-right'
  | 'wipe-up'
  | 'wipe-down'
  | 'blur'
  | 'typewriter'

export interface ClipAnimation {
  preset: AnimationPreset
  /** Seconds. */
  duration: number
}

export type FitMode = 'contain' | 'cover' | 'fill'

export type Fill =
  | { kind: 'solid'; color: string }
  | { kind: 'linear'; colors: string[]; angle: number }
  | { kind: 'radial'; colors: string[] }

export type TextAlign = 'left' | 'center' | 'right'

export interface TextStyle {
  text: string
  fontFamily: string
  fontSize: number
  fontWeight: number
  italic: boolean
  color: string
  align: TextAlign
  /** Multiplier of font size. */
  lineHeight: number
  /** Pixels. */
  letterSpacing: number
  /** Wrap width in composition pixels; 0 = 90% of the frame width. */
  maxWidth: number
  strokeColor: string
  strokeWidth: number
  shadowColor: string
  shadowBlur: number
  shadowOffsetY: number
  /** Box behind the text; empty string = none. */
  backgroundColor: string
  backgroundPadding: number
  backgroundRadius: number
  uppercase: boolean
}

export type ShapeKind = 'rect' | 'ellipse' | 'triangle' | 'line' | 'star'

export interface ShapeStyle {
  shape: ShapeKind
  width: number
  height: number
  fill: Fill
  strokeColor: string
  strokeWidth: number
  cornerRadius: number
}

export interface Clip {
  id: string
  trackId: string
  type: ClipType
  name: string
  /** Timeline position of the clip's first frame. */
  start: number
  duration: number

  // Media clips (video / image / audio)
  mediaId?: string
  /** In-point inside the source media. */
  sourceStart?: number
  fit?: FitMode

  // Audio (audio clips and video clips with sound)
  /** Linear gain, 0..2 (1 = unity). */
  volume?: number
  muted?: boolean

  // Visual layers
  transform: Transform
  keyframes: Partial<Record<AnimatableProp, Keyframe[]>>
  animIn: ClipAnimation
  animOut: ClipAnimation

  /** Seconds. Opacity fade for visuals, volume fade for audio. */
  fadeIn: number
  fadeOut: number

  text?: TextStyle
  shape?: ShapeStyle
  fill?: Fill
}

export interface Project {
  format: typeof PROJECT_FORMAT
  version: number
  id: string
  name: string
  createdAt: string
  updatedAt: string
  settings: ProjectSettings
  media: MediaAsset[]
  /** Visual tracks are composited bottom-up: index 0 is the top layer. */
  tracks: Track[]
  clips: Clip[]
}

// ---------------------------------------------------------------------------
// Export

export type ExportFormat = 'mp4' | 'webm'
export type ExportQuality = 'high' | 'medium' | 'low'

export interface ExportOptions {
  outputPath: string
  format: ExportFormat
  /** Output height; width is derived from the project aspect ratio. 0 = project size. */
  height: number
  fps: number
  quality: ExportQuality
  /** Optional time range (seconds). Defaults to the whole project. */
  rangeStart?: number
  rangeEnd?: number
}

export interface ExportProgress {
  jobId: string
  phase: 'preparing' | 'audio' | 'rendering' | 'finalizing' | 'done' | 'error' | 'cancelled'
  frame: number
  totalFrames: number
  fps: number
  etaSeconds: number
  message?: string
  outputPath?: string
}

export interface SystemInfo {
  ffmpegPath: string | null
  ffprobePath: string | null
  ffmpegVersion: string | null
  encoders: { h264: boolean; vp9: boolean; aac: boolean; opus: boolean }
  platform: string
  defaultProjectsDir: string
}
