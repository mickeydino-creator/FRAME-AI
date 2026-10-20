/**
 * Live preview engine: keeps one media element per audible/visible media clip,
 * syncs them to the playhead, routes audio through Web Audio gain nodes and
 * draws the composition with the shared compositor.
 */
import { audioGain } from '../../../shared/animation'
import { clipEnd, findMedia, findTrack, projectDuration } from '../../../shared/project'
import type { Clip, MediaAsset } from '../../../shared/types'
import { getState, setState, useEditor } from '../editor/store'
import { LayerHit, renderFrame, VisualSource } from './compositor'
import { mediaUrl } from './paths'

interface MediaEntry {
  el: HTMLVideoElement | HTMLAudioElement
  src: string
  gain: GainNode | null
}

class PreviewEngine {
  private canvas: HTMLCanvasElement | null = null
  private media = new Map<string, MediaEntry>()
  private images = new Map<string, HTMLImageElement>()
  private audio: AudioContext | null = null
  private raf = 0
  private needsRender = true
  private playStartWall = 0
  private playStartPos = 0
  private renderListeners = new Set<() => void>()
  lastHits: LayerHit[] = []

  constructor() {
    useEditor.subscribe((s, prev) => {
      if (s.project !== prev.project || s.projectDir !== prev.projectDir) this.syncElements()
      if (s.project !== prev.project || s.previewQuality !== prev.previewQuality || s.selection !== prev.selection)
        this.requestRender()
      if (s.playhead !== prev.playhead && !s.playing) {
        this.syncMedia(s.playhead, false)
        this.requestRender()
      }
    })
    this.loop = this.loop.bind(this)
    this.raf = requestAnimationFrame(this.loop)
  }

  attach(canvas: HTMLCanvasElement | null): void {
    this.canvas = canvas
    this.requestRender()
  }

  onRender(cb: () => void): () => void {
    this.renderListeners.add(cb)
    return () => this.renderListeners.delete(cb)
  }

  requestRender(): void {
    this.needsRender = true
  }

  private ctx(): AudioContext {
    if (!this.audio) this.audio = new AudioContext({ latencyHint: 'playback' })
    return this.audio
  }

  private assetSrc(asset: MediaAsset): string | null {
    const dir = getState().projectDir
    if (!dir || asset.missing) return null
    return mediaUrl(dir, asset.proxy ?? asset.file)
  }

  /** Create/remove media elements so every media clip has one. */
  private syncElements(): void {
    const { project } = getState()
    const wanted = new Set<string>()
    if (project) {
      for (const clip of project.clips) {
        const asset = findMedia(project, clip.mediaId)
        if (!asset) continue
        const src = this.assetSrc(asset)
        if (!src) continue
        if (clip.type === 'image') {
          if (!this.images.has(asset.id)) {
            const img = new Image()
            img.crossOrigin = 'anonymous'
            img.decoding = 'async'
            img.onload = () => this.requestRender()
            img.src = src
            this.images.set(asset.id, img)
          }
          continue
        }
        if (clip.type !== 'video' && clip.type !== 'audio') continue
        wanted.add(clip.id)
        const existing = this.media.get(clip.id)
        if (existing && existing.src === src) continue
        if (existing) this.disposeEntry(clip.id)
        const el = clip.type === 'video' ? document.createElement('video') : document.createElement('audio')
        el.preload = 'auto'
        el.crossOrigin = 'anonymous'
        if (el instanceof HTMLVideoElement) el.playsInline = true
        el.src = src
        el.addEventListener('seeked', () => this.requestRender())
        el.addEventListener('loadeddata', () => {
          this.requestRender()
          if (!getState().playing) this.syncMedia(getState().playhead, false)
        })
        let gain: GainNode | null = null
        if (asset.hasAudio) {
          try {
            const ctx = this.ctx()
            const node = ctx.createMediaElementSource(el)
            gain = ctx.createGain()
            gain.gain.value = 0
            node.connect(gain).connect(ctx.destination)
          } catch {
            el.muted = true
          }
        } else el.muted = true
        this.media.set(clip.id, { el, src, gain })
      }
    }
    for (const id of [...this.media.keys()]) if (!wanted.has(id)) this.disposeEntry(id)
    if (project) {
      const used = new Set(project.clips.map((c) => c.mediaId))
      for (const id of [...this.images.keys()]) if (!used.has(id)) this.images.delete(id)
    }
    this.syncMedia(getState().playhead, getState().playing)
    this.requestRender()
  }

  private disposeEntry(id: string): void {
    const e = this.media.get(id)
    if (!e) return
    e.el.pause()
    e.gain?.disconnect()
    e.el.removeAttribute('src')
    e.el.load()
    this.media.delete(id)
  }

  /** Drive every media element to match timeline time t. */
  private syncMedia(t: number, playing: boolean): void {
    const { project } = getState()
    if (!project) return
    const fps = project.settings.fps
    for (const [clipId, entry] of this.media) {
      const clip = project.clips.find((c) => c.id === clipId)
      if (!clip) continue
      const track = findTrack(project, clip.trackId)
      const el = entry.el
      const active = t >= clip.start && t < clipEnd(clip)
      const expected = (clip.sourceStart ?? 0) + (t - clip.start)
      const audible = active && !!track && !track.muted
      if (entry.gain) {
        const g = audible ? audioGain(clip, t - clip.start) : 0
        entry.gain.gain.setTargetAtTime(g, this.audio!.currentTime, 0.01)
      }
      if (active) {
        if (playing) {
          if (el.paused) {
            el.currentTime = expected
            void el.play().catch(() => undefined)
          } else if (Math.abs(el.currentTime - expected) > 0.3) el.currentTime = expected
        } else {
          if (!el.paused) el.pause()
          if (Math.abs(el.currentTime - expected) > 0.5 / fps && el.readyState >= 1) el.currentTime = expected
        }
      } else {
        if (!el.paused) el.pause()
        // Pre-roll clips that start within the next second.
        const preroll = clip.start - t
        if (preroll > 0 && preroll < 1.5 && Math.abs(el.currentTime - (clip.sourceStart ?? 0)) > 0.05 && !el.seeking)
          el.currentTime = clip.sourceStart ?? 0
      }
    }
  }

  private source: VisualSource = {
    get: (clip: Clip, asset: MediaAsset) => {
      if (clip.type === 'image') {
        const img = this.images.get(asset.id)
        return img && img.complete && img.naturalWidth > 0 ? img : null
      }
      const e = this.media.get(clip.id)
      if (!e || !(e.el instanceof HTMLVideoElement)) return null
      return e.el.readyState >= 2 ? e.el : null
    }
  }

  play(): void {
    const s = getState()
    if (!s.project || s.playing) return
    const duration = projectDuration(s.project)
    let start = s.playhead
    if (duration > 0 && start >= duration - 1e-3) start = 0
    void this.ctx().resume()
    this.playStartPos = start
    this.playStartWall = performance.now()
    setState({ playing: true, playhead: start })
    this.syncMedia(start, true)
  }

  pause(): void {
    if (!getState().playing) return
    setState({ playing: false })
    this.syncMedia(getState().playhead, false)
    this.requestRender()
  }

  toggle(): void {
    if (getState().playing) this.pause()
    else this.play()
  }

  private loop(): void {
    this.raf = requestAnimationFrame(this.loop)
    const s = getState()
    if (!s.project) return
    if (s.playing) {
      const duration = projectDuration(s.project)
      let t = this.playStartPos + (performance.now() - this.playStartWall) / 1000
      if (t >= duration) {
        t = duration
        setState({ playhead: t, playing: false })
        this.syncMedia(t, false)
      } else {
        setState({ playhead: t })
        this.syncMedia(t, true)
      }
      this.needsRender = true
    }
    if (this.needsRender) {
      this.needsRender = false
      this.draw()
    }
  }

  private draw(): void {
    const canvas = this.canvas
    const s = getState()
    if (!canvas || !s.project) return
    const { width, height } = s.project.settings
    const q = s.previewQuality
    const cw = Math.round(width * q)
    const ch = Math.round(height * q)
    if (canvas.width !== cw || canvas.height !== ch) {
      canvas.width = cw
      canvas.height = ch
    }
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    this.lastHits = renderFrame(ctx, s.project, s.playhead, this.source, { scale: q, placeholders: true })
    this.drawSelection(ctx, q)
    this.renderListeners.forEach((f) => f())
  }

  private drawSelection(ctx: CanvasRenderingContext2D, q: number): void {
    const { selection, playing } = getState()
    if (playing) return
    for (const hit of this.lastHits) {
      if (!selection.includes(hit.clipId)) continue
      const w = hit.width / 2
      const h = hit.height / 2
      const pts = [
        [-w, -h],
        [w, -h],
        [w, h],
        [-w, h]
      ].map(([x, y]) => hit.matrix.transformPoint(new DOMPoint(x, y)))
      ctx.save()
      ctx.setTransform(q, 0, 0, q, 0, 0)
      ctx.strokeStyle = '#3d8bff'
      ctx.lineWidth = 2 / q
      ctx.setLineDash([8 / q, 5 / q])
      ctx.beginPath()
      pts.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)))
      ctx.closePath()
      ctx.stroke()
      ctx.setLineDash([])
      ctx.fillStyle = '#3d8bff'
      for (const p of pts) ctx.fillRect(p.x - 4 / q, p.y - 4 / q, 8 / q, 8 / q)
      ctx.restore()
    }
  }

  /**
   * Render the composition at `time` into a PNG data URL, waiting for video
   * frames to be decoded. Used by the command layer's renderPreviewFrame.
   */
  async snapshot(time: number, maxWidth = 1280): Promise<string> {
    const s = getState()
    if (!s.project) throw new Error('No project is open.')
    this.pause()
    setState({ playhead: time })
    this.syncMedia(time, false)
    const waits: Promise<void>[] = []
    for (const [clipId, entry] of this.media) {
      const clip = s.project.clips.find((c) => c.id === clipId)
      if (!clip || clip.type !== 'video' || time < clip.start || time >= clipEnd(clip)) continue
      waits.push(waitForFrame(entry.el as HTMLVideoElement))
    }
    for (const img of this.images.values()) if (!img.complete) waits.push(img.decode().catch(() => undefined))
    await Promise.all(waits)
    const { width, height } = s.project.settings
    const scale = Math.min(1, maxWidth / width)
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(width * scale)
    canvas.height = Math.round(height * scale)
    renderFrame(canvas.getContext('2d')!, getState().project!, time, this.source, { scale })
    return canvas.toDataURL('image/png')
  }

  dispose(): void {
    cancelAnimationFrame(this.raf)
  }
}

function waitForFrame(el: HTMLVideoElement): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer)
      el.removeEventListener('seeked', check)
      el.removeEventListener('loadeddata', check)
      resolve()
    }
    const check = () => {
      if (!el.seeking && el.readyState >= 2) done()
    }
    const timer = setTimeout(done, 5000)
    el.addEventListener('seeked', check)
    el.addEventListener('loadeddata', check)
    check()
  })
}

export const preview = new PreviewEngine()
