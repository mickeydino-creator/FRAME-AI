import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import type { ImportProgress, ImportResult } from '../shared/ipc'
import type { MediaAsset, MediaType } from '../shared/types'
import { uid } from '../shared/util'
import { FFmpegError, parseRate, probe, ProbeResult, runFFmpeg, runFFmpegBuffer, streamRotation } from './ffmpeg'

export const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'webm', 'mkv', 'avi']
export const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif']
export const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'oga', 'flac', 'opus']
export const ALL_EXT = [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT]

export const PROJECT_SUBDIRS = ['assets', 'thumbs', 'waveforms', 'proxies']

// Codecs Chromium can decode natively; anything else gets a preview proxy.
const BROWSER_VIDEO = ['h264', 'vp8', 'vp9', 'av1']
const BROWSER_AUDIO_IN_VIDEO = ['aac', 'mp3', 'opus', 'vorbis', 'flac']
const BROWSER_AUDIO_FILE = [...BROWSER_AUDIO_IN_VIDEO, 'pcm_s16le', 'pcm_s24le', 'pcm_f32le', 'pcm_u8']
const BROWSER_PIX = ['yuv420p', 'yuvj420p']

function safeName(name: string): string {
  return name.replace(/[^\w.\- ]+/g, '_').slice(0, 80)
}

export async function ensureProjectDirs(dir: string): Promise<void> {
  for (const sub of PROJECT_SUBDIRS) await mkdir(join(dir, sub), { recursive: true })
}

interface Classified {
  type: MediaType
  duration: number
  width?: number
  height?: number
  fps?: number
  hasVideo: boolean
  hasAudio: boolean
  videoCodec?: string
  audioCodec?: string
  needsProxy: boolean
}

export function classify(file: string, info: ProbeResult): Classified {
  const ext = extname(file).slice(1).toLowerCase()
  const video = info.streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = info.streams.find((s) => s.codec_type === 'audio')
  const duration = Number(info.format.duration ?? video?.duration ?? audio?.duration ?? 0) || 0

  if (IMAGE_EXT.includes(ext) || (video && !audio && duration <= 0.05 && video.codec_name !== 'h264')) {
    if (!video) throw new FFmpegError('The image could not be decoded.')
    return {
      type: 'image',
      duration: 0,
      width: video.width,
      height: video.height,
      hasVideo: true,
      hasAudio: false,
      videoCodec: video.codec_name,
      needsProxy: false
    }
  }
  if (video) {
    let width = video.width
    let height = video.height
    const rot = streamRotation(video)
    if (rot === 90 || rot === 270) [width, height] = [height, width]
    const fmt = info.format.format_name ?? ''
    const containerOk = /mp4|mov|webm|matroska/.test(fmt)
    const videoOk =
      BROWSER_VIDEO.includes(video.codec_name ?? '') &&
      (video.codec_name !== 'h264' || BROWSER_PIX.includes(video.pix_fmt ?? ''))
    const audioOk = !audio || BROWSER_AUDIO_IN_VIDEO.includes(audio.codec_name ?? '')
    if (duration <= 0) throw new FFmpegError('The video has no readable duration.')
    return {
      type: 'video',
      duration,
      width,
      height,
      fps: parseRate(video.avg_frame_rate) ?? parseRate(video.r_frame_rate),
      hasVideo: true,
      hasAudio: !!audio,
      videoCodec: video.codec_name,
      audioCodec: audio?.codec_name,
      needsProxy: !(containerOk && videoOk && audioOk)
    }
  }
  if (audio) {
    if (duration <= 0) throw new FFmpegError('The audio file has no readable duration.')
    return {
      type: 'audio',
      duration,
      hasVideo: false,
      hasAudio: true,
      audioCodec: audio.codec_name,
      needsProxy: !BROWSER_AUDIO_FILE.includes(audio.codec_name ?? '')
    }
  }
  throw new FFmpegError('The file contains no video or audio streams.')
}

async function makeThumbnail(src: string, out: string, type: MediaType, duration: number): Promise<void> {
  const seek = type === 'video' ? Math.min(1, duration * 0.1) : 0
  const args = type === 'video' ? ['-ss', seek.toFixed(3), '-i', src] : ['-i', src]
  await runFFmpeg([...args, '-frames:v', '1', '-vf', "scale='min(320,iw)':-2", '-q:v', '4', out])
}

/** Peak envelope at `rate` values per second, normalized 0..1. */
async function makeWaveform(src: string, out: string): Promise<void> {
  const sampleRate = 4000
  const rate = 50
  const pcm = await runFFmpegBuffer(['-i', src, '-vn', '-ac', '1', '-ar', String(sampleRate), '-f', 's16le', '-'])
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2))
  const per = sampleRate / rate
  const peaks: number[] = []
  for (let i = 0; i < samples.length; i += per) {
    let max = 0
    const end = Math.min(samples.length, i + per)
    for (let j = i; j < end; j++) {
      const v = Math.abs(samples[j])
      if (v > max) max = v
    }
    peaks.push(Math.round((max / 32768) * 1000) / 1000)
  }
  await writeFile(out, JSON.stringify({ rate, peaks }))
}

async function makeProxy(
  src: string,
  out: string,
  c: Classified,
  onPercent: (p: number) => void
): Promise<void> {
  const onTime = (t: number) => onPercent(Math.min(99, Math.round((t / Math.max(c.duration, 0.01)) * 100)))
  if (c.type === 'audio') {
    await runFFmpeg(['-i', src, '-vn', '-c:a', 'aac', '-b:a', '192k', out], { onTime })
    return
  }
  await runFFmpeg(
    [
      '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
      '-vf', "scale='min(1920,iw)':-2",
      '-g', '30',
      '-c:a', 'aac', '-b:a', '192k',
      '-movflags', '+faststart',
      out
    ],
    { onTime }
  )
}

export async function importOne(
  projectDir: string,
  file: string,
  progress: (p: ImportProgress) => void,
  existingId?: string
): Promise<MediaAsset> {
  const name = basename(file)
  const ext = extname(file).slice(1).toLowerCase()
  if (!ALL_EXT.includes(ext))
    throw new FFmpegError(`Unsupported file type ".${ext}". Supported: ${ALL_EXT.join(', ')}.`)
  await ensureProjectDirs(projectDir)
  progress({ file: name, stage: 'probing' })
  const st = await stat(file).catch(() => {
    throw new FFmpegError('The file could not be found or read.')
  })
  const info = await probe(file)
  const c = classify(file, info)
  const id = existingId ?? uid('med')
  const rel = `assets/${id}_${safeName(name)}`
  progress({ file: name, stage: 'copying' })
  await copyFile(file, join(projectDir, rel))

  const asset: MediaAsset = {
    id,
    name,
    type: c.type,
    file: rel,
    originalPath: file,
    duration: c.duration,
    width: c.width,
    height: c.height,
    fps: c.fps,
    hasVideo: c.hasVideo,
    hasAudio: c.hasAudio,
    videoCodec: c.videoCodec,
    audioCodec: c.audioCodec,
    size: st.size,
    importedAt: new Date().toISOString()
  }
  const abs = join(projectDir, rel)

  if (c.type !== 'audio') {
    progress({ file: name, stage: 'thumbnail' })
    const thumb = `thumbs/${id}.jpg`
    try {
      await makeThumbnail(abs, join(projectDir, thumb), c.type, c.duration)
      asset.thumbnail = thumb
    } catch {
      // Thumbnail failures are cosmetic.
    }
  }
  if (c.hasAudio) {
    progress({ file: name, stage: 'waveform' })
    const wf = `waveforms/${id}.json`
    try {
      await makeWaveform(abs, join(projectDir, wf))
      asset.waveform = wf
    } catch {
      // Waveform failures are cosmetic.
    }
  }
  if (c.needsProxy) {
    progress({ file: name, stage: 'proxy', percent: 0, message: 'Creating preview proxy' })
    const proxy = `proxies/${id}.${c.type === 'audio' ? 'm4a' : 'mp4'}`
    try {
      await makeProxy(abs, join(projectDir, proxy), c, (percent) =>
        progress({ file: name, stage: 'proxy', percent, message: 'Creating preview proxy' })
      )
      asset.proxy = proxy
    } catch (e) {
      throw new FFmpegError(
        `This file uses a codec (${c.videoCodec ?? c.audioCodec}) that cannot be previewed, and converting it failed: ${(e as Error).message}`
      )
    }
  }
  progress({ file: name, stage: 'done' })
  return asset
}

export async function importFiles(
  projectDir: string,
  files: string[],
  progress: (p: ImportProgress) => void
): Promise<ImportResult> {
  const result: ImportResult = { assets: [], errors: [] }
  for (const file of files) {
    try {
      result.assets.push(await importOne(projectDir, file, progress))
    } catch (e) {
      const message = (e as Error).message
      result.errors.push({ file: basename(file), message })
      progress({ file: basename(file), stage: 'error', message })
    }
  }
  return result
}
