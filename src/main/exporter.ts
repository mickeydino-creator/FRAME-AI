import { BrowserWindow, WebContents } from 'electron'
import { spawn, ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildAudioMix, exportRange } from '../shared/audioMix'
import type { ExportJob } from '../shared/ipc'
import { findMedia } from '../shared/project'
import type { ExportOptions, ExportProgress, Project } from '../shared/types'
import { uid } from '../shared/util'
import { explainFailure, FFmpegError, resolveBinaries, runFFmpeg, systemInfo } from './ffmpeg'
import { defaultProjectsDir } from './projects'

const CRF = {
  mp4: { high: 18, medium: 23, low: 28 },
  webm: { high: 28, medium: 33, low: 38 }
}

/** Sequential raw-RGBA frame decoder for one clip, driven by the export renderer. */
class FrameReader {
  private proc: ChildProcess | null = null
  private chunks: Buffer[] = []
  private buffered = 0
  private ended = false
  private index = -1
  private startTime = 0
  private last: Buffer | null = null
  private waiters: (() => void)[] = []
  readonly frameSize: number

  constructor(
    private readonly ffmpeg: string,
    private readonly file: string,
    readonly width: number,
    readonly height: number,
    private readonly fps: number
  ) {
    this.frameSize = width * height * 4
  }

  private start(at: number): void {
    this.stop()
    this.startTime = at
    this.index = -1
    this.ended = false
    this.chunks = []
    this.buffered = 0
    const args = [
      '-hide_banner', '-nostdin', '-loglevel', 'error',
      '-ss', at.toFixed(6), '-i', this.file,
      '-an', '-sn',
      '-vf', `fps=${this.fps},scale=${this.width}:${this.height}:flags=bicubic`,
      '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1'
    ]
    const proc = spawn(this.ffmpeg, args, { windowsHide: true })
    this.proc = proc
    proc.stdout!.on('data', (d: Buffer) => {
      this.chunks.push(d)
      this.buffered += d.length
      // Backpressure: keep at most a few frames in memory.
      if (this.buffered > this.frameSize * 4) proc.stdout!.pause()
      this.wake()
    })
    proc.stdout!.on('end', () => {
      this.ended = true
      this.wake()
    })
    proc.on('error', () => {
      this.ended = true
      this.wake()
    })
  }

  private wake(): void {
    const w = this.waiters
    this.waiters = []
    w.forEach((f) => f())
  }

  private async readFrame(): Promise<Buffer | null> {
    while (this.buffered < this.frameSize) {
      if (this.ended) return null
      this.proc?.stdout?.resume()
      await new Promise<void>((r) => this.waiters.push(r))
    }
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks)
    const frame = Buffer.from(all.subarray(0, this.frameSize))
    const rest = all.subarray(this.frameSize)
    this.chunks = rest.length ? [rest] : []
    this.buffered = rest.length
    if (this.buffered <= this.frameSize * 4) this.proc?.stdout?.resume()
    this.index++
    return frame
  }

  /** Frame closest to `sourceTime`; reuses the last frame past the end of the stream. */
  async frameAt(sourceTime: number): Promise<Buffer | null> {
    const target = Math.round((sourceTime - this.startTime) * this.fps)
    if (!this.proc || target < this.index || target > this.index + this.fps * 3) {
      this.start(Math.max(0, sourceTime))
      return this.frameAt(sourceTime)
    }
    while (this.index < target) {
      const f = await this.readFrame()
      if (!f) break
      this.last = f
    }
    return this.last
  }

  stop(): void {
    const p = this.proc
    this.proc = null
    if (p && p.exitCode === null) {
      // SIGKILL: a SIGTERM is not noticed while FFmpeg is blocked writing to a full pipe.
      p.stdout?.destroy()
      p.kill('SIGKILL')
    }
  }
}

interface RunningJob {
  job: ExportJob
  win: BrowserWindow | null
  encoder: ChildProcess | null
  encoderDone: Promise<void> | null
  encoderStderr: string
  readers: Map<string, FrameReader>
  audioFile: string | null
  started: number
  lastProgress: number
  cancelled: boolean
  finished: boolean
  ffmpeg: string
  sendProgress: (p: ExportProgress) => void
  resolveFrames?: () => void
}

const jobs = new Map<string, RunningJob>()

function killProc(p: ChildProcess | null): void {
  if (!p || p.exitCode !== null) return
  p.stdin?.destroy()
  p.kill('SIGKILL')
}
const jobByWebContents = new Map<number, string>()

function even(n: number): number {
  return Math.max(2, Math.round(n / 2) * 2)
}

export function outputSize(p: Project, height: number): { width: number; height: number } {
  const { width: W, height: H } = p.settings
  if (!height) return { width: even(W), height: even(H) }
  // `height` names the short side (1080p, 720p...), so portrait exports stay sharp.
  const s = height / Math.min(W, H)
  return { width: even(W * s), height: even(H * s) }
}

function encoderArgs(o: ExportOptions, hasAudio: boolean): string[] {
  if (o.format === 'webm') {
    return [
      '-c:v', 'libvpx-vp9', '-b:v', '0', '-crf', String(CRF.webm[o.quality]),
      '-row-mt', '1', '-deadline', 'good', '-cpu-used', '4', '-pix_fmt', 'yuv420p',
      ...(hasAudio ? ['-c:a', 'libopus', '-b:a', '160k'] : [])
    ]
  }
  return [
    '-c:v', 'libx264', '-preset', 'medium', '-crf', String(CRF.mp4[o.quality]), '-pix_fmt', 'yuv420p',
    ...(hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
    '-movflags', '+faststart'
  ]
}

export async function startExport(
  project: Project,
  projectDir: string,
  options: ExportOptions,
  progressTarget: WebContents,
  preloadPath: string,
  loadExportPage: (win: BrowserWindow) => Promise<void>
): Promise<{ jobId: string }> {
  const info = await systemInfo(defaultProjectsDir())
  const bins = await resolveBinaries()
  if (!bins.ffmpeg) throw new FFmpegError('FFmpeg was not found, so the video cannot be exported.')
  if (options.format === 'mp4' && !info.encoders.h264)
    throw new FFmpegError('Your FFmpeg build has no H.264 encoder (libx264). Choose WebM or install a full FFmpeg build.')
  if (options.format === 'webm' && !info.encoders.vp9)
    throw new FFmpegError('Your FFmpeg build has no VP9 encoder (libvpx-vp9). Choose MP4 or install a full FFmpeg build.')
  const missing = project.media.filter((m) => m.missing && project.clips.some((c) => c.mediaId === m.id))
  if (missing.length)
    throw new Error(`Relink missing media before exporting: ${missing.map((m) => m.name).join(', ')}`)

  const range = exportRange(project, options.rangeStart, options.rangeEnd)
  if (range.end - range.start <= 0) throw new Error('The timeline is empty; add clips before exporting.')
  const { width, height } = outputSize(project, options.height)
  const fps = options.fps || project.settings.fps
  const totalFrames = Math.max(1, Math.round((range.end - range.start) * fps))
  const jobId = uid('exp')
  const job: ExportJob = {
    jobId,
    project,
    projectDir,
    options: { ...options, fps },
    width,
    height,
    rangeStart: range.start,
    rangeEnd: range.end,
    totalFrames
  }
  const running: RunningJob = {
    job,
    win: null,
    encoder: null,
    encoderDone: null,
    encoderStderr: '',
    readers: new Map(),
    audioFile: null,
    started: Date.now(),
    lastProgress: 0,
    cancelled: false,
    finished: false,
    ffmpeg: bins.ffmpeg,
    sendProgress: (p) => {
      if (!progressTarget.isDestroyed()) progressTarget.send('export:progress', p)
    }
  }
  jobs.set(jobId, running)
  void run(running, preloadPath, loadExportPage)
  return { jobId }
}

function progress(r: RunningJob, phase: ExportProgress['phase'], frame = 0, message?: string): void {
  const elapsed = (Date.now() - r.started) / 1000
  const fps = phase === 'rendering' && elapsed > 0 ? frame / elapsed : 0
  const remaining = fps > 0 ? (r.job.totalFrames - frame) / fps : 0
  r.sendProgress({
    jobId: r.job.jobId,
    phase,
    frame,
    totalFrames: r.job.totalFrames,
    fps: Math.round(fps * 10) / 10,
    etaSeconds: Math.round(remaining),
    message,
    outputPath: r.job.options.outputPath
  })
}

async function run(
  r: RunningJob,
  preloadPath: string,
  loadExportPage: (win: BrowserWindow) => Promise<void>
): Promise<void> {
  const { job } = r
  try {
    progress(r, 'preparing')
    // 1. Mix audio to a temporary WAV.
    const plan = buildAudioMix(
      job.project,
      (asset) => join(job.projectDir, asset.file),
      job.rangeStart,
      job.rangeEnd
    )
    if (plan) {
      progress(r, 'audio', 0, 'Mixing audio')
      r.audioFile = join(tmpdir(), `frameai-${job.jobId}.wav`)
      const args: string[] = []
      for (const input of plan.inputs) args.push('-i', input)
      args.push('-filter_complex', plan.filter, '-map', '[aout]', '-ac', '2', '-ar', '48000', '-c:a', 'pcm_s16le', r.audioFile)
      await runFFmpeg(args, {
        onSpawn: (p) => {
          r.encoder = p
        }
      })
      r.encoder = null
    }
    if (r.cancelled) return

    // 2. Start the encoder reading raw frames from stdin.
    const { width, height, options } = job
    const encArgs = [
      '-hide_banner', '-nostdin', '-y', '-loglevel', 'error',
      '-f', 'rawvideo', '-pix_fmt', 'rgba', '-s', `${width}x${height}`, '-framerate', String(options.fps), '-i', 'pipe:0',
      ...(r.audioFile ? ['-i', r.audioFile] : []),
      '-map', '0:v:0', ...(r.audioFile ? ['-map', '1:a:0'] : []),
      ...encoderArgs(options, !!r.audioFile),
      '-r', String(options.fps),
      options.outputPath
    ]
    const enc = spawn(r.ffmpeg, encArgs, { windowsHide: true })
    r.encoder = enc
    enc.stderr!.on('data', (d: Buffer) => (r.encoderStderr = (r.encoderStderr + d.toString()).slice(-20000)))
    enc.stdin!.on('error', () => undefined)
    r.encoderDone = new Promise<void>((resolve, reject) => {
      enc.on('error', (e) => reject(new FFmpegError(`Could not start FFmpeg: ${e.message}`)))
      enc.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new FFmpegError(r.cancelled ? 'Export cancelled.' : explainFailure(r.encoderStderr), r.encoderStderr))
      })
    })
    r.encoderDone.catch(() => undefined)

    // 3. Render frames in a hidden window so the editor UI stays responsive.
    progress(r, 'rendering', 0)
    const framesDone = new Promise<void>((resolve) => (r.resolveFrames = resolve))
    const win = new BrowserWindow({
      show: false,
      width: 640,
      height: 360,
      webPreferences: {
        preload: preloadPath,
        sandbox: true,
        contextIsolation: true,
        backgroundThrottling: false,
        offscreen: false
      }
    })
    r.win = win
    jobByWebContents.set(win.webContents.id, job.jobId)
    win.webContents.on('render-process-gone', () => {
      if (!r.finished) void failJob(job.jobId, 'The export renderer crashed.')
    })
    await loadExportPage(win)
    await Promise.race([framesDone, r.encoderDone])
    if (r.cancelled) return

    // 4. Finish encoding.
    progress(r, 'finalizing', job.totalFrames)
    enc.stdin!.end()
    await r.encoderDone
    r.finished = true
    progress(r, 'done', job.totalFrames)
  } catch (e) {
    if (!r.cancelled) {
      r.finished = true
      progress(r, 'error', 0, (e as Error).message)
      if (existsSync(job.options.outputPath)) await rm(job.options.outputPath, { force: true }).catch(() => undefined)
    }
  } finally {
    await cleanup(r)
  }
}

async function cleanup(r: RunningJob): Promise<void> {
  for (const reader of r.readers.values()) reader.stop()
  r.readers.clear()
  if (r.win && !r.win.isDestroyed()) {
    jobByWebContents.delete(r.win.webContents.id)
    r.win.destroy()
  }
  r.win = null
  if (r.audioFile) await rm(r.audioFile, { force: true }).catch(() => undefined)
  jobs.delete(r.job.jobId)
}

export function jobForSender(sender: WebContents): ExportJob {
  const id = jobByWebContents.get(sender.id)
  const r = id ? jobs.get(id) : undefined
  if (!r) throw new Error('No export job for this window.')
  return r.job
}

export async function nextVideoFrame(
  jobId: string,
  clipId: string,
  sourceTime: number
): Promise<{ width: number; height: number; data: Buffer } | null> {
  const r = jobs.get(jobId)
  if (!r || r.cancelled) return null
  let reader = r.readers.get(clipId)
  if (!reader) {
    const clip = r.job.project.clips.find((c) => c.id === clipId)
    const asset = clip && findMedia(r.job.project, clip.mediaId)
    if (!clip || !asset || !asset.width || !asset.height) return null
    // Decode at the size that covers the output (never above native size).
    const maxScale = Math.max(
      clip.transform.scale,
      ...(clip.keyframes.scale ?? []).map((k) => k.v),
      clip.animIn.preset === 'zoom' || clip.animOut.preset === 'zoom' ? 1.6 : 1
    )
    const cover = Math.max(r.job.width / asset.width, r.job.height / asset.height) * Math.max(1, maxScale)
    const s = Math.min(1, cover)
    reader = new FrameReader(r.ffmpeg, join(r.job.projectDir, asset.file), even(asset.width * s), even(asset.height * s), r.job.options.fps)
    r.readers.set(clipId, reader)
  }
  const data = await reader.frameAt(sourceTime)
  if (!data) return null
  return { width: reader.width, height: reader.height, data }
}

export async function writeFrame(jobId: string, frame: Uint8Array): Promise<void> {
  const r = jobs.get(jobId)
  if (!r || r.cancelled || !r.encoder?.stdin) throw new Error('Export is not running.')
  const expected = r.job.width * r.job.height * 4
  if (frame.byteLength !== expected) throw new Error(`Frame has ${frame.byteLength} bytes, expected ${expected}.`)
  const stdin = r.encoder.stdin
  if (!stdin.write(Buffer.from(frame.buffer, frame.byteOffset, frame.byteLength))) {
    await Promise.race([once(stdin, 'drain'), r.encoderDone])
  }
  r.lastProgress++
  if (r.lastProgress % 5 === 0 || r.lastProgress === r.job.totalFrames) progress(r, 'rendering', r.lastProgress)
}

export function finishFrames(jobId: string): void {
  jobs.get(jobId)?.resolveFrames?.()
}

export async function failJob(jobId: string, message: string): Promise<void> {
  const r = jobs.get(jobId)
  if (!r || r.finished) return
  r.finished = true
  r.cancelled = true
  killProc(r.encoder)
  progress(r, 'error', 0, message)
  r.resolveFrames?.()
  await rm(r.job.options.outputPath, { force: true }).catch(() => undefined)
}

export async function cancelExport(jobId: string): Promise<void> {
  const r = jobs.get(jobId)
  if (!r || r.finished) return
  r.cancelled = true
  killProc(r.encoder)
  r.resolveFrames?.()
  progress(r, 'cancelled', r.lastProgress)
  await new Promise((res) => setTimeout(res, 200))
  await rm(r.job.options.outputPath, { force: true }).catch(() => undefined)
}

export function cancelAll(): void {
  for (const id of jobs.keys()) void cancelExport(id)
}
