/**
 * FFmpeg command builders (pure). The same filter graph renders a preview
 * frame and the final MP4, so the preview shows what the export will hold.
 */
import { type Clip, clipEnd, type Media, type MediaKind, type Project, projectDuration, type TextStyle } from './model'

export type ProbeStream = {
  codec_type?: string
  codec_name?: string
  width?: number
  height?: number
  avg_frame_rate?: string
  disposition?: { attached_pic?: number }
  tags?: Record<string, string>
  side_data_list?: { rotation?: number }[]
}
export type Probe = { streams?: ProbeStream[]; format?: { duration?: string; format_name?: string } }

const IMAGE_EXT = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'tif', 'tiff']
const AUDIO_EXT = ['wav', 'mp3', 'm4a', 'aac', 'ogg', 'flac', 'opus']
const VIDEO_EXT = ['mp4', 'mov', 'm4v', 'mkv', 'webm', 'avi', 'mts', 'm2ts']
export const MEDIA_EXT = [...VIDEO_EXT, ...IMAGE_EXT, ...AUDIO_EXT]

export function extOf(path: string): string {
  const name = baseName(path)
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

export function baseName(path: string): string {
  return path.split(/[\\/]/).pop() ?? path
}

export function joinPath(dir: string, ...parts: string[]): string {
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/'
  return [dir.replace(/[\\/]+$/, ''), ...parts.map(p => p.replace(/^[\\/]+|[\\/]+$/g, ''))].join(sep)
}

/** Turn ffprobe JSON into what the timeline needs; throws a readable reason. */
export function classifyProbe(path: string, probe: Probe): Omit<Media, 'id' | 'name' | 'path' | 'thumb'> {
  const ext = extOf(path)
  const streams = probe.streams ?? []
  const video = streams.find(s => s.codec_type === 'video' && !s.disposition?.attached_pic)
  const audio = streams.find(s => s.codec_type === 'audio')
  const duration = Number(probe.format?.duration ?? 0) || 0
  let width = video?.width
  let height = video?.height
  const rot = Math.abs(Number(video?.side_data_list?.find(d => d.rotation !== undefined)?.rotation ?? video?.tags?.rotate ?? 0)) % 180
  if (rot === 90) [width, height] = [height, width]
  let kind: MediaKind
  if (IMAGE_EXT.includes(ext) && video) kind = 'image'
  else if (video) kind = 'video'
  else if (audio) kind = 'audio'
  else throw new Error('The file has no video or audio that FFmpeg can read.')
  if (kind !== 'image' && duration <= 0) throw new Error('FFmpeg could not read the file duration.')
  const [n, d] = (video?.avg_frame_rate ?? '0/1').split('/').map(Number)
  return {
    kind,
    duration: kind === 'image' ? 0 : Math.round(duration * 1000) / 1000,
    width,
    height,
    fps: n && d ? Math.round((n / d) * 100) / 100 : undefined,
    hasVideo: !!video,
    hasAudio: kind !== 'image' && !!audio,
  }
}

/** A value for a filter option, quoted so ':' ',' and spaces survive. Paths use '/'. */
export function filterValue(text: string): string {
  if (text.includes("'")) throw new Error(`A path or value used by FFmpeg cannot contain an apostrophe: ${text}`)
  return `'${text.replace(/\\/g, '/').replace(/:/g, '\\:')}'`
}

function num(v: number): string {
  return Number(v.toFixed(4)).toString()
}

function even(v: number): number {
  return Math.max(2, Math.round(v / 2) * 2)
}

function fadeAt(c: Clip, local: number): number {
  let a = 1
  if (c.fadeIn && local < c.fadeIn) a *= Math.max(0, local / c.fadeIn)
  if (c.fadeOut && c.duration - local < c.fadeOut) a *= Math.max(0, (c.duration - local) / c.fadeOut)
  return a
}

export type RenderJob = {
  project: Project
  /** Timeline range to render, seconds. */
  start: number
  end: number
  /** Output size; the layout scales from the project size. */
  width: number
  height: number
  fontFile: string
  /** Text clip id -> UTF-8 file holding its text (written by the caller). */
  textFiles: Record<string, string>
  /** Media id -> path to read (the original, or a cache copy). */
  mediaPath: (m: Media) => string
}

export type RenderGraph = { inputs: string[]; filter: string; hasAudio: boolean; duration: number }

function visualOrder(p: Project): Clip[] {
  // Tracks are listed top first: draw the bottom track first, clips by start.
  const out: Clip[] = []
  const video = p.tracks.filter(t => t.kind === 'video' && !t.hidden)
  for (const track of [...video].reverse()) {
    out.push(...p.clips.filter(c => c.trackId === track.id && c.kind !== 'audio').sort((a, b) => a.start - b.start))
  }
  return out
}

function textY(t: TextStyle, H: number, k: number): string {
  const margin = num(H * 0.08)
  switch (t.position) {
    case 'top':
      return margin
    case 'bottom':
      return `h-text_h-${margin}`
    case 'lower-third':
      return `h*0.72-text_h/2`
    default:
      return `(h-text_h)/2`
  }
  void k
}

/** Build inputs and a filter graph whose outputs are [vout] (and [aout] when there is sound). */
export function buildGraph(job: RenderJob): RenderGraph {
  const { project: p, start: R0, end: R1, width: W, height: H } = job
  const k = W / p.width
  const dur = R1 - R0
  const single = dur <= 1.5 / p.fps
  const inputs: string[] = []
  const chains: string[] = [`color=c=black:s=${W}x${H}:r=${p.fps}:d=${num(Math.max(dur, 1 / p.fps))},format=yuv420p[base]`]
  let last = 'base'
  let n = 0
  const audioLabels: string[] = []
  const mutedTracks = new Set(p.tracks.filter(t => t.muted).map(t => t.id))

  const addInput = (args: string[]) => {
    inputs.push(...args)
    return n++
  }

  for (const c of visualOrder(p)) {
    const a = Math.max(R0, c.start)
    const b = Math.min(R1, clipEnd(c))
    if (b - a <= 1e-4) continue
    const local0 = a - c.start
    const opacity = c.opacity ?? 1
    const enable = `between(t,${num(a - R0)},${num(b - R0)})`
    if (c.kind === 'text' && c.text) {
      const t = c.text
      const file = job.textFiles[c.id]
      if (!file) throw new Error(`Text for clip ${c.id} was not prepared.`)
      const lt = `(t+${num(R0 - c.start)})`
      let alpha = opacity < 1 ? num(opacity) : '1'
      if (single) alpha = num(opacity * fadeAt(c, local0) * (t.animation === 'fade' ? Math.min(1, local0 / 0.5) : 1))
      else {
        const terms = [num(opacity)]
        if (c.fadeIn) terms.push(`min(1,${lt}/${num(c.fadeIn)})`)
        if (c.fadeOut) terms.push(`min(1,max(0,(${num(c.duration)}-${lt})/${num(c.fadeOut)}))`)
        if (t.animation === 'fade') terms.push(`min(1,${lt}/0.5)`)
        alpha = terms.join('*')
      }
      let y = textY(t, H, k)
      if (t.animation === 'slide-up') y = `${y}+${num(H * 0.06)}*max(0,1-${lt}/0.6)`
      const x = `(w-text_w)/2+${num((c.x ?? 0) * k)}`
      const yy = `${y}+${num((c.y ?? 0) * k)}`
      const opts = [
        `fontfile=${filterValue(job.fontFile)}`,
        `textfile=${filterValue(file)}`,
        'expansion=none',
        `fontsize=${num(t.size * k * (c.scale ?? 1))}`,
        `fontcolor=${t.color}`,
        `x='${x}'`,
        `y='${yy}'`,
        `alpha='${alpha}'`,
        `line_spacing=${num(t.size * k * 0.15)}`,
        `enable='${enable}'`,
      ]
      if (t.box) opts.push('box=1', 'boxcolor=black@0.55', `boxborderw=${Math.round(t.size * k * 0.3)}`)
      else opts.push('shadowcolor=black@0.6', `shadowx=${Math.max(1, Math.round(2 * k))}`, `shadowy=${Math.max(1, Math.round(2 * k))}`)
      chains.push(`[${last}]drawtext=${opts.join(':')}[t${n}_${chains.length}]`)
      last = `t${n}_${chains.length - 1}`
      continue
    }
    const m = p.media.find(x => x.id === c.mediaId)
    if (!m || !m.width || !m.height) continue
    const path = job.mediaPath(m)
    const idx =
      c.kind === 'image'
        ? addInput(['-loop', '1', '-framerate', String(p.fps), '-t', num(b - a + 1 / p.fps), '-i', path])
        : addInput(['-ss', num((c.sourceIn ?? 0) + local0), '-t', num(b - a + 1 / p.fps), '-i', path])
    const fit = Math.min(W / m.width, H / m.height) * (c.scale ?? 1)
    const w = even(m.width * fit)
    const h = even(m.height * fit)
    const steps = [`fps=${p.fps}`, `scale=${w}:${h}:flags=bicubic`, 'format=yuva420p']
    if (single) {
      const alpha = opacity * fadeAt(c, local0)
      if (alpha < 0.999) steps.push(`colorchannelmixer=aa=${num(alpha)}`)
    } else {
      if (opacity < 0.999) steps.push(`colorchannelmixer=aa=${num(opacity)}`)
      if (c.fadeIn && local0 < c.fadeIn) steps.push(`fade=t=in:st=0:d=${num(c.fadeIn - local0)}:alpha=1`)
      if (c.fadeOut) {
        const st = Math.max(0, c.duration - c.fadeOut - local0)
        steps.push(`fade=t=out:st=${num(st)}:d=${num(Math.min(c.fadeOut, b - a))}:alpha=1`)
      }
    }
    steps.push(`setpts=PTS-STARTPTS+${num(a - R0)}/TB`)
    chains.push(`[${idx}:v]${steps.join(',')}[v${idx}]`)
    const x = `(W-w)/2+${num((c.x ?? 0) * k)}`
    const y = `(H-h)/2+${num((c.y ?? 0) * k)}`
    chains.push(`[${last}][v${idx}]overlay=x='${x}':y='${y}':eof_action=pass:enable='${enable}'[o${idx}]`)
    last = `o${idx}`

    if (!single && c.kind === 'video' && m.hasAudio && !mutedTracks.has(c.trackId) && (c.volume ?? 1) > 0) {
      audioLabels.push(audioChain(chains, idx, c, local0, a - R0, b - a))
    }
  }

  if (!single) {
    for (const c of p.clips) {
      if (c.kind !== 'audio' || mutedTracks.has(c.trackId) || (c.volume ?? 1) <= 0) continue
      const a = Math.max(R0, c.start)
      const b = Math.min(R1, clipEnd(c))
      if (b - a <= 1e-4) continue
      const m = p.media.find(x => x.id === c.mediaId)
      if (!m) continue
      const local0 = a - c.start
      const idx = addInput(['-ss', num((c.sourceIn ?? 0) + local0), '-t', num(b - a), '-i', job.mediaPath(m)])
      audioLabels.push(audioChain(chains, idx, c, local0, a - R0, b - a))
    }
  }

  chains.push(`[${last}]format=yuv420p[vout]`)
  if (audioLabels.length) {
    chains.push(
      `${audioLabels.join('')}amix=inputs=${audioLabels.length}:normalize=0:duration=longest,apad=whole_dur=${num(dur)},atrim=end=${num(dur)}[aout]`,
    )
  }
  return { inputs, filter: chains.join(';'), hasAudio: audioLabels.length > 0, duration: dur }
}

function audioChain(chains: string[], idx: number, c: Clip, local0: number, delay: number, len: number): string {
  const lt = `(t+${num(local0)})`
  const terms = [num(c.volume ?? 1)]
  if (c.fadeIn) terms.push(`min(1,${lt}/${num(c.fadeIn)})`)
  if (c.fadeOut) terms.push(`min(1,max(0,(${num(c.duration)}-${lt})/${num(c.fadeOut)}))`)
  const label = `a${idx}`
  chains.push(
    `[${idx}:a]atrim=duration=${num(len)},asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
      `volume='${terms.join('*')}':eval=frame,adelay=${Math.round(delay * 1000)}:all=1[${label}]`,
  )
  return `[${label}]`
}

/** Arguments that write one PNG of the composition at time `t`. */
export function frameArgs(job: Omit<RenderJob, 'start' | 'end'>, t: number, out: string): string[] {
  const g = buildGraph({ ...job, start: t, end: t + 1 / job.project.fps })
  return ['-hide_banner', '-loglevel', 'error', '-y', ...g.inputs, '-filter_complex', g.filter, '-map', '[vout]', '-frames:v', '1', out]
}

export type ExportOptions = { output: string; height: number; quality: 'high' | 'medium' | 'draft'; start?: number; end?: number }

export function exportSize(p: Project, short: number): { width: number; height: number } {
  if (!short) return { width: even(p.width), height: even(p.height) }
  const s = short / Math.min(p.width, p.height)
  return { width: even(p.width * s), height: even(p.height * s) }
}

/** Arguments that render the timeline to an H.264/AAC MP4, reporting progress on stdout. */
export function exportArgs(job: Omit<RenderJob, 'start' | 'end' | 'width' | 'height'>, o: ExportOptions): { args: string[]; duration: number } {
  const total = projectDuration(job.project)
  const start = Math.max(0, o.start ?? 0)
  const end = Math.min(o.end ?? total, total)
  if (end - start <= 0) throw new Error('The timeline is empty: add clips before exporting.')
  const size = exportSize(job.project, o.height)
  const g = buildGraph({ ...job, ...size, start, end })
  const crf = { high: 18, medium: 22, draft: 28 }[o.quality]
  const preset = o.quality === 'draft' ? 'veryfast' : 'medium'
  return {
    duration: g.duration,
    args: [
      '-hide_banner', '-nostdin', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats',
      ...g.inputs,
      '-filter_complex', g.filter,
      '-map', '[vout]', ...(g.hasAudio ? ['-map', '[aout]'] : []),
      '-c:v', 'libx264', '-preset', preset, '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(job.project.fps),
      ...(g.hasAudio ? ['-c:a', 'aac', '-b:a', '192k'] : []),
      '-t', num(g.duration), '-movflags', '+faststart', o.output,
    ],
  }
}

/** Seconds rendered so far, from FFmpeg's `-progress` key=value output. */
export function parseProgress(text: string): number | null {
  const m = /out_time_(?:us|ms)=(\d+)/g
  let last: number | null = null
  for (const hit of text.matchAll(m)) last = Number(hit[1]) / 1e6
  return last
}

/** Readable reason from FFmpeg's stderr. */
export function explainFfmpeg(stderr: string): string {
  if (/Unknown encoder|Encoder not found|libx264/i.test(stderr) && /not found|Unknown/i.test(stderr))
    return 'Your FFmpeg has no H.264 encoder (libx264). Install a full FFmpeg build, e.g. `winget install Gyan.FFmpeg`.'
  if (/No such file or directory/i.test(stderr)) return 'A media file could not be found. Check the media library for missing files.'
  if (/Invalid data found/i.test(stderr)) return 'A file is damaged or not a supported media format.'
  if (/Permission denied/i.test(stderr)) return 'Permission denied while reading or writing a file.'
  if (/No space left/i.test(stderr)) return 'The disk is full.'
  if (/drawtext|fontfile|Cannot find a valid font/i.test(stderr)) return 'FFmpeg could not load the title font. Set "Title font file" in /config.'
  return `FFmpeg failed: ${stderr.trim().split(/\r?\n/).slice(-4).join(' / ')}`
}

/** Parse an SRT file into cues. */
export function parseSrt(text: string): { start: number; end: number; text: string }[] {
  const ts = (s: string | undefined) => {
    const m = /(\d+):(\d+):(\d+)[,.](\d+)/.exec(s ?? '')
    return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000 : NaN
  }
  const cues: { start: number; end: number; text: string }[] = []
  for (const block of text.replace(/\r/g, '').split(/\n{2,}/)) {
    const lines = block.trim().split('\n')
    const i = lines.findIndex(l => l.includes('-->'))
    if (i < 0) continue
    const [a, b] = (lines[i] ?? '').split('-->')
    const body = lines.slice(i + 1).join('\n').trim()
    if (body && isFinite(ts(a)) && isFinite(ts(b))) cues.push({ start: ts(a), end: ts(b), text: body })
  }
  return cues
}
