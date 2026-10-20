import { clipEnd, findMedia, findTrack } from './project'
import { Clip, MediaAsset, Project } from './types'

export interface AudioMixPlan {
  /** Absolute input file paths, one `-i` per entry. */
  inputs: string[]
  /** filter_complex graph whose output label is [aout]. */
  filter: string
  segments: { clipId: string; delay: number; duration: number }[]
}

function num(v: number): string {
  return Number(v.toFixed(6)).toString()
}

/** Clips that produce sound, honoring clip mute, track mute and missing media. */
export function audibleClips(p: Project): { clip: Clip; asset: MediaAsset }[] {
  const out: { clip: Clip; asset: MediaAsset }[] = []
  for (const clip of p.clips) {
    if (clip.type !== 'audio' && clip.type !== 'video') continue
    if (clip.muted || (clip.volume ?? 1) <= 0) continue
    const track = findTrack(p, clip.trackId)
    if (!track || track.muted) continue
    const asset = findMedia(p, clip.mediaId)
    if (!asset || !asset.hasAudio || asset.missing) continue
    out.push({ clip, asset })
  }
  return out
}

/**
 * Build an FFmpeg filter graph that mixes every audible clip in [rangeStart, rangeEnd)
 * into a single stereo 48 kHz stream labelled [aout] of exactly the range length.
 * Fades use the same linear curve as the preview (see animation.audioGain).
 * Returns null when nothing in the range makes a sound.
 */
export function buildAudioMix(
  p: Project,
  resolvePath: (asset: MediaAsset) => string,
  rangeStart: number,
  rangeEnd: number
): AudioMixPlan | null {
  const total = rangeEnd - rangeStart
  const inputs: string[] = []
  const chains: string[] = []
  const labels: string[] = []
  const segments: AudioMixPlan['segments'] = []

  for (const { clip, asset } of audibleClips(p)) {
    const a = Math.max(0, rangeStart - clip.start)
    const b = Math.min(clip.duration, rangeEnd - clip.start)
    if (b - a <= 1e-4) continue
    const idx = inputs.length
    inputs.push(resolvePath(asset))
    const srcStart = (clip.sourceStart ?? 0) + a
    const len = b - a
    const delayMs = Math.max(0, Math.round((clip.start + a - rangeStart) * 1000))

    // Gain expression in terms of local clip time (t + a).
    const lt = `(t+${num(a)})`
    const terms = [num(clip.volume ?? 1)]
    if (clip.fadeIn > 0) terms.push(`min(1,${lt}/${num(clip.fadeIn)})`)
    if (clip.fadeOut > 0) terms.push(`min(1,max(0,(${num(clip.duration)}-${lt})/${num(clip.fadeOut)}))`)
    const label = `a${idx}`
    chains.push(
      `[${idx}:a]atrim=start=${num(srcStart)}:duration=${num(len)},asetpts=PTS-STARTPTS,` +
        `aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,` +
        `volume='${terms.join('*')}':eval=frame,adelay=${delayMs}:all=1[${label}]`
    )
    labels.push(`[${label}]`)
    segments.push({ clipId: clip.id, delay: delayMs / 1000, duration: len })
  }
  if (inputs.length === 0) return null
  const mix =
    `${labels.join('')}amix=inputs=${labels.length}:normalize=0:duration=longest:dropout_transition=0,` +
    `apad=whole_dur=${num(total)},atrim=end=${num(total)}[aout]`
  return { inputs, filter: [...chains, mix].join(';'), segments }
}

/** Duration used for exports: the end of the last clip (at least one frame). */
export function exportRange(p: Project, start?: number, end?: number): { start: number; end: number } {
  let last = 0
  for (const c of p.clips) last = Math.max(last, clipEnd(c))
  const s = Math.max(0, start ?? 0)
  const e = Math.min(end ?? last, last)
  return { start: s, end: Math.max(e, s) }
}
