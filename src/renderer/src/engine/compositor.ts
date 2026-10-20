/**
 * Canvas compositor shared by the live preview and the exporter, so what you
 * see in the preview is exactly what gets rendered into the final video.
 */
import { evaluateLayer, LayerState } from '../../../shared/animation'
import { clipEnd, findMedia } from '../../../shared/project'
import type { Clip, Fill, MediaAsset, Project, ShapeStyle, TextStyle } from '../../../shared/types'

export interface VisualSource {
  /** A drawable for the clip at the given source time, or null when not available yet. */
  get(clip: Clip, asset: MediaAsset, sourceTime: number): CanvasImageSource | null
}

export interface LayerHit {
  clipId: string
  /** Composition-space transform of the layer's local (centered) coordinate system. */
  matrix: DOMMatrix
  width: number
  height: number
}

export interface RenderOptions {
  /** Canvas pixels per composition pixel. */
  scale: number
  /** Draw "media offline" placeholders (preview only). */
  placeholders?: boolean
}

const RTL = /[֐-ࣿיִ-﷿ﹰ-ﻼ]/

/** Clips visible at `time`, in draw order (bottom first). */
export function activeVisualClips(project: Project, time: number): Clip[] {
  const out: Clip[] = []
  const tracks = project.tracks.filter((t) => t.kind === 'video' && !t.hidden)
  for (let i = tracks.length - 1; i >= 0; i--) {
    const track = tracks[i]
    const clips = project.clips
      .filter((c) => c.trackId === track.id && c.type !== 'audio' && time >= c.start && time < clipEnd(c))
      .sort((a, b) => a.start - b.start)
    out.push(...clips)
  }
  return out
}

export function fontString(s: TextStyle, size = s.fontSize): string {
  return `${s.italic ? 'italic ' : ''}${s.fontWeight} ${size}px "${s.fontFamily}", "Segoe UI", Arial, sans-serif`
}

export interface TextLayout {
  lines: string[]
  widths: number[]
  width: number
  height: number
  lineHeight: number
  rtl: boolean
}

export function layoutText(ctx: CanvasRenderingContext2D, s: TextStyle, frameWidth: number): TextLayout {
  const text = s.uppercase ? s.text.toUpperCase() : s.text
  ctx.font = fontString(s)
  ctx.letterSpacing = `${s.letterSpacing}px`
  const maxWidth = s.maxWidth > 0 ? s.maxWidth : frameWidth * 0.9
  const lines: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(/(\s+)/)
    let line = ''
    for (const w of words) {
      const candidate = line + w
      if (line.trim() && ctx.measureText(candidate.trimEnd()).width > maxWidth) {
        lines.push(line.trimEnd())
        line = w.trimStart()
      } else line = candidate
    }
    lines.push(line.trimEnd())
  }
  const widths = lines.map((l) => ctx.measureText(l).width)
  const lineHeight = s.fontSize * s.lineHeight
  return {
    lines,
    widths,
    width: Math.max(1, ...widths),
    height: Math.max(lineHeight, lines.length * lineHeight),
    lineHeight,
    rtl: RTL.test(text)
  }
}

export function makeFill(ctx: CanvasRenderingContext2D, fill: Fill, w: number, h: number): string | CanvasGradient {
  if (fill.kind === 'solid') return fill.color
  const colors = fill.colors.length ? fill.colors : ['#000000', '#ffffff']
  let g: CanvasGradient
  if (fill.kind === 'linear') {
    const a = (fill.angle * Math.PI) / 180
    const dx = (Math.cos(a) * w) / 2
    const dy = (Math.sin(a) * h) / 2
    g = ctx.createLinearGradient(-dx, -dy, dx, dy)
  } else {
    g = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) * 0.6)
  }
  colors.forEach((c, i) => g.addColorStop(colors.length === 1 ? 0 : i / (colors.length - 1), c))
  return g
}

function shapePath(ctx: CanvasRenderingContext2D, s: ShapeStyle): void {
  const w = s.width
  const h = s.height
  ctx.beginPath()
  switch (s.shape) {
    case 'rect':
      ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(s.cornerRadius, w / 2, h / 2))
      break
    case 'ellipse':
      ctx.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2)
      break
    case 'triangle':
      ctx.moveTo(0, -h / 2)
      ctx.lineTo(w / 2, h / 2)
      ctx.lineTo(-w / 2, h / 2)
      ctx.closePath()
      break
    case 'line':
      ctx.roundRect(-w / 2, -h / 2, w, h, Math.min(h / 2, s.cornerRadius))
      break
    case 'star': {
      const spikes = 5
      for (let i = 0; i < spikes * 2; i++) {
        const r = i % 2 === 0 ? 1 : 0.45
        const a = (i * Math.PI) / spikes - Math.PI / 2
        const x = (Math.cos(a) * r * w) / 2
        const y = (Math.sin(a) * r * h) / 2
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
      break
    }
  }
}

function drawText(ctx: CanvasRenderingContext2D, s: TextStyle, layout: TextLayout, reveal: number): void {
  const { lines, widths, width, height, lineHeight, rtl } = layout
  if (s.backgroundColor) {
    const pad = s.backgroundPadding
    ctx.save()
    ctx.fillStyle = s.backgroundColor
    ctx.beginPath()
    ctx.roundRect(-width / 2 - pad, -height / 2 - pad, width + pad * 2, height + pad * 2, s.backgroundRadius)
    ctx.fill()
    ctx.restore()
  }
  ctx.font = fontString(s)
  ctx.letterSpacing = `${s.letterSpacing}px`
  ctx.textBaseline = 'middle'
  ctx.direction = rtl ? 'rtl' : 'ltr'
  ctx.textAlign = rtl ? 'right' : 'left'
  const total = lines.reduce((n, l) => n + l.length, 0)
  let budget = reveal >= 1 ? Infinity : Math.floor(total * reveal)
  if (s.shadowBlur > 0 || s.shadowOffsetY !== 0) {
    ctx.shadowColor = s.shadowColor
    ctx.shadowBlur = s.shadowBlur
    ctx.shadowOffsetY = s.shadowOffsetY
  }
  lines.forEach((line, i) => {
    if (budget <= 0) return
    const visible = budget >= line.length ? line : line.slice(0, budget)
    budget -= line.length
    const lw = widths[i]
    let left: number
    if (s.align === 'left') left = -width / 2
    else if (s.align === 'right') left = width / 2 - lw
    else left = -lw / 2
    const x = rtl ? left + lw : left
    const y = -height / 2 + lineHeight * (i + 0.5)
    if (s.strokeWidth > 0) {
      ctx.save()
      ctx.strokeStyle = s.strokeColor
      ctx.lineWidth = s.strokeWidth * 2
      ctx.lineJoin = 'round'
      ctx.strokeText(visible, x, y)
      ctx.restore()
      // Shadow is drawn once with the stroke; avoid doubling it on the fill.
      ctx.shadowColor = 'transparent'
    }
    ctx.fillStyle = s.color
    ctx.fillText(visible, x, y)
  })
}

function contentSize(
  ctx: CanvasRenderingContext2D,
  clip: Clip,
  asset: MediaAsset | undefined,
  img: CanvasImageSource | null,
  W: number,
  H: number
): { w: number; h: number; sx: number; sy: number; text?: TextLayout } {
  switch (clip.type) {
    case 'video':
    case 'image': {
      let w = asset?.width ?? 0
      let h = asset?.height ?? 0
      if ((!w || !h) && img) {
        const anyImg = img as HTMLVideoElement & HTMLImageElement
        w = anyImg.videoWidth || anyImg.naturalWidth || (img as ImageBitmap).width || W
        h = anyImg.videoHeight || anyImg.naturalHeight || (img as ImageBitmap).height || H
      }
      if (!w || !h) {
        w = W
        h = H
      }
      const fit = clip.fit ?? 'contain'
      if (fit === 'fill') return { w: W, h: H, sx: 1, sy: 1 }
      const k = fit === 'cover' ? Math.max(W / w, H / h) : Math.min(W / w, H / h)
      return { w: w * k, h: h * k, sx: 1, sy: 1 }
    }
    case 'text': {
      const text = layoutText(ctx, clip.text!, W)
      return { w: text.width, h: text.height, sx: 1, sy: 1, text }
    }
    case 'shape':
      return { w: clip.shape!.width, h: clip.shape!.height, sx: 1, sy: 1 }
    default:
      return { w: W, h: H, sx: 1, sy: 1 }
  }
}

function applyWipe(ctx: CanvasRenderingContext2D, st: LayerState, w: number, h: number): void {
  if (!st.wipe) return
  const p = st.wipe.p
  ctx.beginPath()
  switch (st.wipe.dir) {
    case 'left':
      ctx.rect(w / 2 - p * w, -h / 2, p * w, h)
      break
    case 'right':
      ctx.rect(-w / 2, -h / 2, p * w, h)
      break
    case 'up':
      ctx.rect(-w / 2, h / 2 - p * h, w, p * h)
      break
    case 'down':
      ctx.rect(-w / 2, -h / 2, w, p * h)
      break
  }
  ctx.clip()
}

/** Render the composition at `time` into ctx. Returns hit-test info for visible layers. */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  project: Project,
  time: number,
  source: VisualSource,
  opts: RenderOptions
): LayerHit[] {
  const { width: W, height: H, background } = project.settings
  const hits: LayerHit[] = []
  ctx.save()
  ctx.setTransform(opts.scale, 0, 0, opts.scale, 0, 0)
  ctx.globalAlpha = 1
  ctx.filter = 'none'
  ctx.fillStyle = background
  ctx.fillRect(0, 0, W, H)

  for (const clip of activeVisualClips(project, time)) {
    const local = time - clip.start
    const st = evaluateLayer(clip, local, { width: W, height: H })
    const asset = findMedia(project, clip.mediaId)
    let img: CanvasImageSource | null = null
    let offline = false
    if (clip.type === 'video' || clip.type === 'image') {
      if (!asset || asset.missing) offline = true
      else img = source.get(clip, asset, (clip.sourceStart ?? 0) + local)
    }
    const size = contentSize(ctx, clip, asset, img, W, H)
    const matrix = new DOMMatrix()
      .translate(W / 2 + st.x, H / 2 + st.y)
      .rotate(st.rotation)
      .scale(st.scale, st.scale)
    hits.push({ clipId: clip.id, matrix, width: size.w, height: size.h })
    if (st.opacity <= 0.001 || st.scale <= 0) continue

    ctx.save()
    ctx.globalAlpha = st.opacity
    if (st.blur > 0.05) ctx.filter = `blur(${(st.blur * opts.scale).toFixed(2)}px)`
    ctx.setTransform(new DOMMatrix().scale(opts.scale, opts.scale).multiply(matrix))
    applyWipe(ctx, st, size.w, size.h)

    switch (clip.type) {
      case 'video':
      case 'image':
        if (img) ctx.drawImage(img, -size.w / 2, -size.h / 2, size.w, size.h)
        else if (offline && opts.placeholders) {
          ctx.fillStyle = '#2a1416'
          ctx.fillRect(-size.w / 2, -size.h / 2, size.w, size.h)
          ctx.fillStyle = '#ff6b6b'
          ctx.font = `600 ${Math.round(H / 24)}px "Segoe UI", Arial, sans-serif`
          ctx.textAlign = 'center'
          ctx.textBaseline = 'middle'
          ctx.fillText(`Media offline: ${asset?.name ?? clip.name}`, 0, 0)
        }
        break
      case 'text':
        drawText(ctx, clip.text!, size.text!, st.reveal)
        break
      case 'shape': {
        const s = clip.shape!
        shapePath(ctx, s)
        ctx.fillStyle = makeFill(ctx, s.fill, s.width, s.height)
        ctx.fill()
        if (s.strokeWidth > 0) {
          ctx.strokeStyle = s.strokeColor
          ctx.lineWidth = s.strokeWidth
          ctx.stroke()
        }
        break
      }
      case 'background':
        ctx.fillStyle = makeFill(ctx, clip.fill ?? { kind: 'solid', color: '#000' }, W, H)
        ctx.fillRect(-W / 2, -H / 2, W, H)
        break
    }
    ctx.restore()
  }
  ctx.restore()
  return hits
}

/** Topmost layer containing the composition-space point (x, y). */
export function hitTest(hits: LayerHit[], x: number, y: number): LayerHit | null {
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i]
    const p = h.matrix.inverse().transformPoint(new DOMPoint(x, y))
    if (Math.abs(p.x) <= h.width / 2 && Math.abs(p.y) <= h.height / 2) return h
  }
  return null
}
