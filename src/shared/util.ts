export function uid(prefix: string): string {
  const bytes = new Uint8Array(6)
  globalThis.crypto.getRandomValues(bytes)
  let s = ''
  for (const b of bytes) s += b.toString(36).padStart(2, '0').slice(-2)
  return `${prefix}_${s}`
}

export function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v))
}

export function round(v: number, decimals = 4): number {
  const f = 10 ** decimals
  return Math.round(v * f) / f
}

/** Snap a time to the nearest frame boundary. */
export function snapToFrame(t: number, fps: number): number {
  return round(Math.round(t * fps) / fps, 6)
}

/** HH:MM:SS:FF timecode. */
export function formatTimecode(t: number, fps: number): string {
  const totalFrames = Math.max(0, Math.round(t * fps))
  const f = totalFrames % fps
  const totalSec = Math.floor(totalFrames / fps)
  const s = totalSec % 60
  const m = Math.floor(totalSec / 60) % 60
  const h = Math.floor(totalSec / 3600)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(h)}:${p(m)}:${p(s)}:${p(f)}`
}

/** Short m:ss display used for media durations. */
export function formatDuration(t: number): string {
  if (!isFinite(t) || t <= 0) return '0:00'
  const s = Math.round(t)
  const m = Math.floor(s / 60)
  return `${m}:${String(s % 60).padStart(2, '0')}`
}

/**
 * Parse a timecode (HH:MM:SS:FF, MM:SS, SS.ss) or a plain seconds value.
 * Returns null when the input cannot be parsed.
 */
export function parseTime(input: string, fps: number): number | null {
  const str = input.trim()
  if (!str) return null
  if (/^-?\d+(\.\d+)?s?$/.test(str)) return parseFloat(str)
  const parts = str.split(':')
  if (parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) return null
  const nums = parts.map(Number)
  if (nums.length === 4) return nums[0] * 3600 + nums[1] * 60 + nums[2] + nums[3] / fps
  if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
  if (nums.length === 2) return nums[0] * 60 + nums[1]
  return null
}

export function deepClone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T
}
