import type { ExportOptions, ExportProgress, MediaAsset, Project, SystemInfo } from './types'

export interface OpenedProject {
  project: Project
  dir: string
  /** Names of media files that could not be found. */
  missing: string[]
}

export interface ImportProgress {
  file: string
  stage: 'probing' | 'copying' | 'thumbnail' | 'waveform' | 'proxy' | 'done' | 'error'
  percent?: number
  message?: string
}

export interface ImportResult {
  assets: MediaAsset[]
  errors: { file: string; message: string }[]
}

export interface RecentProject {
  name: string
  dir: string
  openedAt: string
}

/** Export job sent from the main process to the hidden export renderer. */
export interface ExportJob {
  jobId: string
  project: Project
  projectDir: string
  options: ExportOptions
  width: number
  height: number
  rangeStart: number
  rangeEnd: number
  totalFrames: number
}

/** API exposed to renderers by the preload script as `window.frameAPI`. */
export interface FrameAPI {
  system: {
    info(): Promise<SystemInfo>
    showItemInFolder(path: string): Promise<void>
    openPath(path: string): Promise<string>
  }
  project: {
    create(name: string, parentDir?: string): Promise<{ dir: string }>
    save(dir: string, json: string): Promise<void>
    open(dir?: string): Promise<OpenedProject | null>
    chooseDirectory(): Promise<string | null>
    recent(): Promise<RecentProject[]>
    setDirty(dirty: boolean): void
  }
  media: {
    chooseFiles(): Promise<string[]>
    import(projectDir: string, paths: string[]): Promise<ImportResult>
    relink(projectDir: string, asset: MediaAsset, newPath?: string): Promise<MediaAsset | null>
    onProgress(cb: (p: ImportProgress) => void): () => void
    pathForFile(file: File): string
    toUrl(absPath: string): string
  }
  export: {
    chooseOutput(defaultName: string, format: string): Promise<string | null>
    start(project: Project, projectDir: string, options: ExportOptions): Promise<{ jobId: string }>
    cancel(jobId: string): Promise<void>
    onProgress(cb: (p: ExportProgress) => void): () => void
    // Used only by the hidden export renderer:
    getJob(): Promise<ExportJob>
    nextVideoFrame(jobId: string, clipId: string, sourceTime: number): Promise<{ width: number; height: number; data: Uint8Array } | null>
    writeFrame(jobId: string, frame: Uint8Array): Promise<void>
    finishFrames(jobId: string): Promise<void>
    fail(jobId: string, message: string): Promise<void>
  }
  bridge: {
    /** Register the handler that executes commands sent from the main process. */
    onCommand(handler: (method: string, args: unknown[]) => Promise<unknown>): void
  }
  app: {
    onCloseRequest(cb: () => void): void
    confirmClose(): void
  }
}
