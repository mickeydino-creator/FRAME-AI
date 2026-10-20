import { spawn, ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import type { SystemInfo } from '../shared/types'

export class FFmpegError extends Error {
  constructor(
    message: string,
    public readonly stderr = ''
  ) {
    super(message)
    this.name = 'FFmpegError'
  }
}

interface Binaries {
  ffmpeg: string | null
  ffprobe: string | null
}

let cached: Binaries | null = null
let cachedInfo: SystemInfo | null = null

const exe = process.platform === 'win32' ? '.exe' : ''

function unpacked(p: string): string {
  // Binaries inside app.asar cannot be executed; electron-builder unpacks them.
  return p.replace(`app.asar${process.platform === 'win32' ? '\\' : '/'}`, `app.asar.unpacked${process.platform === 'win32' ? '\\' : '/'}`)
}

function candidates(name: 'ffmpeg' | 'ffprobe'): string[] {
  const list: string[] = []
  const env = process.env[name === 'ffmpeg' ? 'FRAME_AI_FFMPEG' : 'FRAME_AI_FFPROBE']
  if (env) list.push(env)
  // Packaged app: binaries copied into resources/ffmpeg by electron-builder.
  if (app.isPackaged) list.push(join(process.resourcesPath, 'ffmpeg', `${name}${exe}`))
  try {
    if (name === 'ffmpeg') {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = require('ffmpeg-static') as string | null
      if (p) list.push(unpacked(p))
    } else {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const p = (require('ffprobe-static') as { path: string }).path
      if (p) list.push(unpacked(p))
    }
  } catch {
    // optional dependency not installed
  }
  list.push(name) // system PATH
  return list
}

function canRun(bin: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (bin.includes('/') || bin.includes('\\')) {
      if (!existsSync(bin)) return resolve(false)
    }
    const p = spawn(bin, ['-version'], { windowsHide: true })
    p.on('error', () => resolve(false))
    p.on('close', (code) => resolve(code === 0))
  })
}

export async function resolveBinaries(): Promise<Binaries> {
  if (cached) return cached
  const found: Binaries = { ffmpeg: null, ffprobe: null }
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    for (const c of candidates(name)) {
      if (await canRun(c)) {
        found[name] = c
        break
      }
    }
  }
  cached = found
  return found
}

async function requireBin(name: 'ffmpeg' | 'ffprobe'): Promise<string> {
  const bins = await resolveBinaries()
  const bin = bins[name]
  if (!bin)
    throw new FFmpegError(
      `${name} was not found. Install FFmpeg (https://ffmpeg.org) and add it to PATH, ` +
        `or set the FRAME_AI_${name.toUpperCase()} environment variable to the ${name}${exe} path.`
    )
  return bin
}

function capture(bin: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const p = spawn(bin, args, { windowsHide: true })
    let out = ''
    p.stdout.on('data', (d) => (out += d))
    p.on('error', () => resolve(''))
    p.on('close', () => resolve(out))
  })
}

export async function systemInfo(defaultProjectsDir: string): Promise<SystemInfo> {
  if (cachedInfo) return cachedInfo
  const bins = await resolveBinaries()
  let version: string | null = null
  const encoders = { h264: false, vp9: false, aac: false, opus: false }
  if (bins.ffmpeg) {
    const v = await capture(bins.ffmpeg, ['-hide_banner', '-version'])
    version = v.split('\n')[0]?.replace(/^ffmpeg version\s*/, '').split(' ')[0] ?? null
    const enc = await capture(bins.ffmpeg, ['-hide_banner', '-encoders'])
    encoders.h264 = /\blibx264\b/.test(enc)
    encoders.vp9 = /\blibvpx-vp9\b/.test(enc)
    encoders.aac = /^\s*A\S*\s+aac\b/m.test(enc)
    encoders.opus = /\blibopus\b/.test(enc)
  }
  cachedInfo = {
    ffmpegPath: bins.ffmpeg,
    ffprobePath: bins.ffprobe,
    ffmpegVersion: version,
    encoders,
    platform: process.platform,
    defaultProjectsDir
  }
  return cachedInfo
}

export interface RunOptions {
  /** Called with the processed output time in seconds. */
  onTime?: (seconds: number) => void
  onSpawn?: (proc: ChildProcess) => void
}

function tail(s: string, lines = 12): string {
  return s.trim().split(/\r?\n/).slice(-lines).join('\n')
}

/** Run ffmpeg to completion. Rejects with the tail of stderr on failure. */
export async function runFFmpeg(args: string[], opts: RunOptions = {}): Promise<void> {
  const bin = await requireBin('ffmpeg')
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-hide_banner', '-nostdin', '-y', ...args], { windowsHide: true })
    opts.onSpawn?.(proc)
    let stderr = ''
    proc.stderr.on('data', (d: Buffer) => {
      const s = d.toString()
      stderr = (stderr + s).slice(-20000)
      const m = /time=(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(s)
      if (m && opts.onTime) opts.onTime(+m[1] * 3600 + +m[2] * 60 + +m[3])
    })
    proc.on('error', (e) => reject(new FFmpegError(`Could not start FFmpeg: ${e.message}`)))
    proc.on('close', (code, signal) => {
      if (code === 0) resolve()
      else if (signal) reject(new FFmpegError('FFmpeg was stopped.', stderr))
      else reject(new FFmpegError(explainFailure(stderr), stderr))
    })
  })
}

/** Run ffmpeg and collect stdout as a Buffer. */
export async function runFFmpegBuffer(args: string[]): Promise<Buffer> {
  const bin = await requireBin('ffmpeg')
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-hide_banner', '-nostdin', ...args], { windowsHide: true })
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (d: Buffer) => chunks.push(d))
    proc.stderr.on('data', (d: Buffer) => (stderr = (stderr + d.toString()).slice(-20000)))
    proc.on('error', (e) => reject(new FFmpegError(`Could not start FFmpeg: ${e.message}`)))
    proc.on('close', (code) => {
      if (code === 0) resolve(Buffer.concat(chunks))
      else reject(new FFmpegError(explainFailure(stderr), stderr))
    })
  })
}

export function ffmpegPathSync(): string | null {
  return cached?.ffmpeg ?? null
}

/** Turn common FFmpeg failures into actionable messages. */
export function explainFailure(stderr: string): string {
  const s = stderr
  if (/Unknown encoder|Encoder not found|Encoder .* not found/i.test(s))
    return 'The required encoder is not available in this FFmpeg build. Install a full FFmpeg build (with libx264 / libvpx / libopus).'
  if (/Decoder .* not found|no decoder|could not find codec parameters/i.test(s))
    return 'This media uses a codec that FFmpeg cannot decode.'
  if (/Invalid data found when processing input/i.test(s)) return 'The file is damaged or is not a supported media format.'
  if (/No such file or directory/i.test(s)) return 'A media file could not be found on disk.'
  if (/Permission denied/i.test(s)) return 'Permission denied while reading or writing a file.'
  if (/No space left on device/i.test(s)) return 'The disk is full.'
  return `FFmpeg failed:\n${tail(s, 6)}`
}

export interface ProbeStream {
  codec_type: string
  codec_name?: string
  width?: number
  height?: number
  pix_fmt?: string
  avg_frame_rate?: string
  r_frame_rate?: string
  duration?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}

export interface ProbeResult {
  streams: ProbeStream[]
  format: { format_name?: string; duration?: string; size?: string }
}

export async function probe(file: string): Promise<ProbeResult> {
  const bin = await requireBin('ffprobe')
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], {
      windowsHide: true
    })
    let out = ''
    let err = ''
    proc.stdout.on('data', (d) => (out += d))
    proc.stderr.on('data', (d) => (err += d))
    proc.on('error', (e) => reject(new FFmpegError(`Could not start ffprobe: ${e.message}`)))
    proc.on('close', (code) => {
      if (code !== 0) return reject(new FFmpegError(explainFailure(err), err))
      try {
        resolve(JSON.parse(out) as ProbeResult)
      } catch {
        reject(new FFmpegError('ffprobe returned unreadable output.'))
      }
    })
  })
}

export function parseRate(r?: string): number | undefined {
  if (!r) return undefined
  const [a, b] = r.split('/').map(Number)
  if (!a || !b) return undefined
  return a / b
}

export function streamRotation(s: ProbeStream): number {
  const fromSide = s.side_data_list?.find((d) => typeof d.rotation === 'number')?.rotation
  const fromTag = s.tags?.rotate ? Number(s.tags.rotate) : undefined
  const r = fromSide ?? fromTag ?? 0
  return ((Math.round(r) % 360) + 360) % 360
}
