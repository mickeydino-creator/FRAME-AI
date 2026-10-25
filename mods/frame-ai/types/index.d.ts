// FRAME AI mod: the values it keeps in $.state (the session's), per key.

export type FrameTab = 'clip' | 'media' | 'chat' | 'export'

export type FrameView = {
  playhead: number
  selection: string | null
  tab: FrameTab
  /** Seconds per timeline column; 0 = fit the whole timeline. */
  zoom: number
  /** First visible second of the timeline. */
  scroll: number
  isPlaying: boolean
}

export type FrameEnv = {
  isChecked: boolean
  ffmpeg: string
  ffprobe: string
  ffmpegVersion: string | null
  hasX264: boolean
  hasWhisper: boolean
  fontFile: string | null
  projectsDir: string
  isWindows: boolean
  error: string | null
}

export type FramePreview = {
  time: number
  /** PNG for the terminal's Image element. */
  png: string | null
  /** JPEG, base64, for an Svg on the desktop. */
  jpeg: string | null
  width: number
  height: number
  isRendering: boolean
  error: string | null
}

export type FrameJob = {
  label: string
  /** 0..1, or null while it cannot be measured. */
  fraction: number | null
  isRunning: boolean
  error: string | null
  output: string | null
}

export type FrameLogEntry = { at: string; text: string; isError: boolean; origin: 'claude' | 'you' }

export type FrameChat = { isWaiting: boolean; sent: { at: string; text: string }[] }

/** A project as stored: see hooks/model.ts (Project) for the fields. */
export type FrameProject = {
  format: 'frame-ai-mod'
  version: 1
  id: string
  name: string
  aspect: '16:9' | '9:16' | '1:1'
  width: number
  height: number
  fps: number
  media: {
    id: string
    name: string
    path: string
    kind: 'video' | 'image' | 'audio'
    duration: number
    width?: number
    height?: number
    fps?: number
    hasVideo: boolean
    hasAudio: boolean
    thumb?: string
  }[]
  tracks: { id: string; kind: 'video' | 'audio'; name: string; muted?: boolean; hidden?: boolean }[]
  clips: {
    id: string
    kind: 'video' | 'image' | 'audio' | 'text'
    trackId: string
    start: number
    duration: number
    mediaId?: string
    sourceIn?: number
    volume?: number
    opacity?: number
    scale?: number
    x?: number
    y?: number
    fadeIn?: number
    fadeOut?: number
    text?: {
      content: string
      size: number
      color: string
      position: 'top' | 'center' | 'bottom' | 'lower-third'
      box: boolean
      animation: 'none' | 'fade' | 'slide-up'
    }
  }[]
  updatedAt: string
}

export type FrameHistory = { past: FrameProject[]; future: FrameProject[] }

declare module 'claude-code' {
  interface PluginState {
    'frame-ai': {
      project: Shaped<FrameProject | null>
      dir: Shaped<string | null>
      missing: Shaped<string[]>
      history: Shaped<FrameHistory>
      view: Shaped<FrameView>
      env: Shaped<FrameEnv>
      preview: Shaped<FramePreview>
      job: Shaped<FrameJob | null>
      log: Shaped<FrameLogEntry[]>
      chat: Shaped<FrameChat>
      draft: Shaped<{ projectName: string; importPath: string; exportPath: string; quality: 'high' | 'medium' | 'draft'; height: number }>
    }
  }
}
