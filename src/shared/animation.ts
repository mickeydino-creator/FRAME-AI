import { AnimatableProp, AnimationPreset, Clip, Easing, Keyframe, Transform } from './types'
import { clamp } from './util'

export const ANIMATION_PRESETS: { id: AnimationPreset; label: string; textOnly?: boolean }[] = [
  { id: 'none', label: 'None' },
  { id: 'fade', label: 'Fade' },
  { id: 'slide-left', label: 'Slide Left' },
  { id: 'slide-right', label: 'Slide Right' },
  { id: 'slide-up', label: 'Slide Up' },
  { id: 'slide-down', label: 'Slide Down' },
  { id: 'scale', label: 'Scale' },
  { id: 'pop', label: 'Pop' },
  { id: 'zoom', label: 'Zoom' },
  { id: 'rotate', label: 'Rotate' },
  { id: 'wipe-left', label: 'Wipe Left' },
  { id: 'wipe-right', label: 'Wipe Right' },
  { id: 'wipe-up', label: 'Wipe Up' },
  { id: 'wipe-down', label: 'Wipe Down' },
  { id: 'blur', label: 'Blur' },
  { id: 'typewriter', label: 'Typewriter', textOnly: true }
]

export function ease(e: Easing, p: number): number {
  p = clamp(p, 0, 1)
  switch (e) {
    case 'linear':
      return p
    case 'easeIn':
      return p * p * p
    case 'easeOut':
      return 1 - (1 - p) ** 3
    case 'easeInOut':
      return p < 0.5 ? 4 * p * p * p : 1 - (-2 * p + 2) ** 3 / 2
    case 'hold':
      return p >= 1 ? 1 : 0
  }
}

function easeOutBack(p: number): number {
  const c1 = 1.70158
  const c3 = c1 + 1
  return 1 + c3 * (p - 1) ** 3 + c1 * (p - 1) ** 2
}

/** Interpolate a keyframe track at local time t. Keyframes must be sorted by time. */
export function evaluateKeyframes(kfs: Keyframe[], t: number): number {
  if (kfs.length === 0) return 0
  if (t <= kfs[0].t) return kfs[0].v
  const last = kfs[kfs.length - 1]
  if (t >= last.t) return last.v
  for (let i = 0; i < kfs.length - 1; i++) {
    const a = kfs[i]
    const b = kfs[i + 1]
    if (t >= a.t && t <= b.t) {
      const span = b.t - a.t
      const p = span <= 0 ? 1 : (t - a.t) / span
      return a.v + (b.v - a.v) * ease(a.ease, p)
    }
  }
  return last.v
}

/** Transform of a clip at local time t, including keyframes (but not in/out presets). */
export function evaluateTransform(clip: Clip, t: number): Transform {
  const out = { ...clip.transform }
  for (const prop of Object.keys(clip.keyframes) as AnimatableProp[]) {
    const kfs = clip.keyframes[prop]
    if (kfs && kfs.length > 0) out[prop] = evaluateKeyframes(kfs, t)
  }
  return out
}

export interface LayerState extends Transform {
  /** Gaussian blur radius in composition pixels. */
  blur: number
  /** Reveal clip, as a fraction (0..1) of the layer's size along `dir`. */
  wipe: { dir: 'left' | 'right' | 'up' | 'down'; p: number } | null
  /** Fraction of text characters visible (typewriter). */
  reveal: number
}

/**
 * Apply an in/out preset at progress p (0 = fully hidden, 1 = at rest).
 * `phase` decides direction for movement presets: an "in" slide enters
 * travelling in the named direction, an "out" slide leaves that way.
 */
function applyPreset(
  s: LayerState,
  preset: AnimationPreset,
  rawP: number,
  phase: 'in' | 'out',
  frame: { width: number; height: number }
): void {
  if (preset === 'none' || rawP >= 1) return
  const p = ease('easeOut', rawP)
  const sign = phase === 'in' ? 1 : -1
  const dx = frame.width * 0.25
  const dy = frame.height * 0.25
  switch (preset) {
    case 'fade':
      s.opacity *= p
      break
    case 'slide-left':
      s.x += sign * dx * (1 - p)
      s.opacity *= p
      break
    case 'slide-right':
      s.x -= sign * dx * (1 - p)
      s.opacity *= p
      break
    case 'slide-up':
      s.y += sign * dy * (1 - p)
      s.opacity *= p
      break
    case 'slide-down':
      s.y -= sign * dy * (1 - p)
      s.opacity *= p
      break
    case 'scale':
      s.scale *= 0.6 + 0.4 * p
      s.opacity *= p
      break
    case 'pop':
      s.scale *= Math.max(0, phase === 'in' ? easeOutBack(rawP) : p)
      s.opacity *= clamp(rawP * 3, 0, 1)
      break
    case 'zoom':
      s.scale *= 1 + 0.6 * (1 - p)
      s.opacity *= p
      break
    case 'rotate':
      s.rotation += sign * -90 * (1 - p)
      s.scale *= 0.5 + 0.5 * p
      s.opacity *= p
      break
    case 'wipe-left':
      s.wipe = { dir: 'left', p }
      break
    case 'wipe-right':
      s.wipe = { dir: 'right', p }
      break
    case 'wipe-up':
      s.wipe = { dir: 'up', p }
      break
    case 'wipe-down':
      s.wipe = { dir: 'down', p }
      break
    case 'blur':
      s.blur += 24 * (1 - p)
      s.opacity *= p
      break
    case 'typewriter':
      s.reveal = Math.min(s.reveal, rawP)
      break
  }
}

/** Full visual state of a clip at local time t (seconds since clip start). */
export function evaluateLayer(clip: Clip, t: number, frame: { width: number; height: number }): LayerState {
  const s: LayerState = { ...evaluateTransform(clip, t), blur: 0, wipe: null, reveal: 1 }
  s.opacity *= fadeMultiplier(clip, t)
  const { animIn, animOut } = clip
  if (animIn.preset !== 'none' && animIn.duration > 0 && t < animIn.duration) {
    applyPreset(s, animIn.preset, t / animIn.duration, 'in', frame)
  }
  const remaining = clip.duration - t
  if (animOut.preset !== 'none' && animOut.duration > 0 && remaining < animOut.duration) {
    applyPreset(s, animOut.preset, remaining / animOut.duration, 'out', frame)
  }
  s.opacity = clamp(s.opacity, 0, 1)
  return s
}

/** Linear fade-in/out multiplier shared by visual opacity and audio gain. */
export function fadeMultiplier(clip: Clip, t: number): number {
  let m = 1
  if (clip.fadeIn > 0 && t < clip.fadeIn) m *= clamp(t / clip.fadeIn, 0, 1)
  const remaining = clip.duration - t
  if (clip.fadeOut > 0 && remaining < clip.fadeOut) m *= clamp(remaining / clip.fadeOut, 0, 1)
  return m
}

/** Audio gain of a clip at local time t (volume x fades). */
export function audioGain(clip: Clip, t: number): number {
  if (clip.muted) return 0
  return (clip.volume ?? 1) * fadeMultiplier(clip, t)
}
