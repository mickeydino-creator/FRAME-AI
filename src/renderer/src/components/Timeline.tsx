import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { clipEnd, findMedia, projectDuration, trackKindForClip } from '../../../shared/project'
import type { Clip, MediaAsset, Track } from '../../../shared/types'
import { snapToFrame, uid } from '../../../shared/util'
import { Command } from '../../../shared/commands'
import { editor } from '../editor/api'
import { getState, setState, toast, tryDispatch, useEditor } from '../editor/store'
import { mediaUrl } from '../engine/paths'
import { preview } from '../engine/preview'
import { Icon } from './Icon'
import { DND_ITEM, DND_MEDIA, DragItem, insertItem } from './MediaLibrary'

const HEADER_W = 168
const RULER_H = 28
const TRACK_H: Record<Track['kind'], number> = { video: 62, audio: 50 }
const SNAP_PX = 8

// ----------------------------------------------------------------- waveform

const waveformCache = new Map<string, Promise<{ rate: number; peaks: number[] } | null>>()

function loadWaveform(dir: string, asset: MediaAsset) {
  if (!asset.waveform) return Promise.resolve(null)
  const key = `${dir}|${asset.waveform}`
  let p = waveformCache.get(key)
  if (!p) {
    p = fetch(mediaUrl(dir, asset.waveform))
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)
    waveformCache.set(key, p)
  }
  return p
}

function Waveform({ asset, clip, width, dir }: { asset: MediaAsset; clip: Clip; width: number; dir: string }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const [data, setData] = useState<{ rate: number; peaks: number[] } | null>(null)
  useEffect(() => {
    let alive = true
    loadWaveform(dir, asset).then((d) => alive && setData(d))
    return () => {
      alive = false
    }
  }, [dir, asset])
  useEffect(() => {
    const c = ref.current
    if (!c || !data) return
    const w = Math.max(1, Math.min(4096, Math.round(width)))
    const h = c.clientHeight || 24
    c.width = w
    c.height = h
    const ctx = c.getContext('2d')!
    ctx.clearRect(0, 0, w, h)
    ctx.fillStyle = 'rgba(255,255,255,0.55)'
    const src0 = clip.sourceStart ?? 0
    const gain = clip.muted ? 0 : Math.min(2, clip.volume ?? 1)
    for (let x = 0; x < w; x++) {
      const t0 = src0 + (x / w) * clip.duration
      const t1 = src0 + ((x + 1) / w) * clip.duration
      let peak = 0
      for (let i = Math.floor(t0 * data.rate); i <= Math.floor(t1 * data.rate); i++) peak = Math.max(peak, data.peaks[i] ?? 0)
      const ph = Math.max(1, Math.min(1, peak * gain) * h * 0.95)
      ctx.fillRect(x, (h - ph) / 2, 1, ph)
    }
  }, [data, width, clip.duration, clip.sourceStart, clip.volume, clip.muted])
  return <canvas ref={ref} className="waveform" />
}

// ---------------------------------------------------------------------- clip

interface ClipViewProps {
  clip: Clip
  zoom: number
  selected: boolean
  locked: boolean
  asset?: MediaAsset
  dir: string
  onPointerDown: (e: React.PointerEvent, clip: Clip, mode: 'move' | 'trim-start' | 'trim-end') => void
}

const ClipView = memo(function ClipView({ clip, zoom, selected, locked, asset, dir, onPointerDown }: ClipViewProps) {
  const width = Math.max(2, clip.duration * zoom)
  const thumb = asset?.thumbnail ? mediaUrl(dir, asset.thumbnail) : null
  const kfTimes = [...new Set(Object.values(clip.keyframes).flatMap((k) => (k ?? []).map((x) => x.t)))]
  let label = clip.name
  if (clip.type === 'text') label = clip.text?.text.replace(/\n/g, ' ') || 'Text'
  return (
    <div
      className={`clip clip-${clip.type} ${selected ? 'selected' : ''} ${locked ? 'locked' : ''} ${asset?.missing ? 'offline' : ''}`}
      style={{ left: clip.start * zoom, width }}
      onPointerDown={(e) => onPointerDown(e, clip, 'move')}
      data-clip-id={clip.id}
    >
      {clip.type === 'video' && thumb && <div className="clip-thumbs" style={{ backgroundImage: `url("${thumb}")` }} />}
      {clip.type === 'image' && thumb && <div className="clip-thumbs" style={{ backgroundImage: `url("${thumb}")` }} />}
      {asset?.hasAudio && (clip.type === 'audio' || clip.type === 'video') && (
        <Waveform asset={asset} clip={clip} width={width} dir={dir} />
      )}
      <div className="clip-label">
        <Icon name={clip.type} size={11} />
        <span>{label}</span>
        {clip.muted && <Icon name="mute" size={11} />}
      </div>
      {clip.fadeIn > 0 && <div className="fade fade-in" style={{ width: clip.fadeIn * zoom }} />}
      {clip.fadeOut > 0 && <div className="fade fade-out" style={{ width: clip.fadeOut * zoom }} />}
      {(clip.animIn.preset !== 'none' || clip.animOut.preset !== 'none') && (
        <>
          {clip.animIn.preset !== 'none' && <div className="anim-bar in" style={{ width: clip.animIn.duration * zoom }} />}
          {clip.animOut.preset !== 'none' && <div className="anim-bar out" style={{ width: clip.animOut.duration * zoom }} />}
        </>
      )}
      {kfTimes.map((t) => (
        <i key={t} className="kf-mark" style={{ left: t * zoom }} />
      ))}
      {!locked && (
        <>
          <div className="trim trim-start" onPointerDown={(e) => onPointerDown(e, clip, 'trim-start')} />
          <div className="trim trim-end" onPointerDown={(e) => onPointerDown(e, clip, 'trim-end')} />
        </>
      )}
    </div>
  )
})

// --------------------------------------------------------------------- ruler

function pickInterval(zoom: number): { major: number; minor: number } {
  const steps = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 1800]
  const major = steps.find((s) => s * zoom >= 90) ?? 3600
  const minor = major / (major === 15 || major === 30 ? 3 : 5)
  return { major, minor }
}

function fmtRuler(t: number, major: number): string {
  const m = Math.floor(t / 60)
  const s = t - m * 60
  if (major < 1) return `${m}:${s.toFixed(1).padStart(4, '0')}`
  return `${m}:${String(Math.round(s)).padStart(2, '0')}`
}

function Ruler({ zoom, scrollLeft, width }: { zoom: number; scrollLeft: number; width: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const scrub = useRef(false)
  useEffect(() => {
    const c = ref.current
    if (!c) return
    const dpr = window.devicePixelRatio || 1
    c.width = Math.max(1, Math.floor(width * dpr))
    c.height = RULER_H * dpr
    const ctx = c.getContext('2d')!
    ctx.scale(dpr, dpr)
    ctx.clearRect(0, 0, width, RULER_H)
    const { major, minor } = pickInterval(zoom)
    const t0 = scrollLeft / zoom
    const t1 = (scrollLeft + width) / zoom
    ctx.strokeStyle = '#3a3a42'
    ctx.fillStyle = '#8a8a94'
    ctx.font = '10px "Segoe UI", Arial, sans-serif'
    ctx.beginPath()
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round(t * zoom - scrollLeft) + 0.5
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6
      ctx.moveTo(x, RULER_H)
      ctx.lineTo(x, isMajor ? 8 : RULER_H - 6)
      if (isMajor) ctx.fillText(fmtRuler(Math.round(t * 1000) / 1000, major), x + 4, 14)
    }
    ctx.stroke()
  }, [zoom, scrollLeft, width])

  const seek = (e: React.PointerEvent) => {
    const rect = ref.current!.getBoundingClientRect()
    const t = Math.max(0, (e.clientX - rect.left + scrollLeft) / zoom)
    const fps = getState().project!.settings.fps
    setState({ playhead: snapToFrame(t, fps) })
  }
  return (
    <canvas
      ref={ref}
      className="ruler"
      style={{ width, height: RULER_H }}
      onPointerDown={(e) => {
        preview.pause()
        scrub.current = true
        ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
        seek(e)
      }}
      onPointerMove={(e) => scrub.current && seek(e)}
      onPointerUp={() => (scrub.current = false)}
    />
  )
}

function PlayheadLine({ zoom }: { zoom: number }) {
  const t = useEditor((s) => s.playhead)
  return <div className="playhead" style={{ left: HEADER_W + t * zoom }} />
}

// --------------------------------------------------------------- track head

function TrackHeader({ track, index }: { track: Track; index: number }) {
  const selected = useEditor((s) => s.selectedTrackId === track.id)
  const clipCount = useEditor((s) => s.project!.clips.filter((c) => c.trackId === track.id).length)
  const [editing, setEditing] = useState(false)
  const update = (patch: Partial<Track>) => tryDispatch({ type: 'updateTrack', trackId: track.id, patch })
  return (
    <div
      className={`track-head ${track.kind} ${selected ? 'selected' : ''}`}
      style={{ height: TRACK_H[track.kind] }}
      onClick={() => setState({ selectedTrackId: track.id, selection: [] })}
      draggable={!editing}
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-frame-track', track.id)
        e.dataTransfer.effectAllowed = 'move'
      }}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('application/x-frame-track')) e.preventDefault()
      }}
      onDrop={(e) => {
        const id = e.dataTransfer.getData('application/x-frame-track')
        if (id && id !== track.id) tryDispatch({ type: 'moveTrack', trackId: id, index })
      }}
      title="Drag to reorder tracks"
    >
      <span className="grip">⋮⋮</span>
      <div className="track-title">
        {editing ? (
          <input
            autoFocus
            defaultValue={track.name}
            onBlur={(e) => {
              update({ name: e.target.value })
              setEditing(false)
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        ) : (
          <b onDoubleClick={() => setEditing(true)} title="Double-click to rename">
            {track.name}
          </b>
        )}
        <small>{clipCount} clip{clipCount === 1 ? '' : 's'}</small>
      </div>
      <div className="track-buttons" onClick={(e) => e.stopPropagation()}>
        {track.kind === 'video' && (
          <button className={`icon-btn small ${track.hidden ? 'on' : ''}`} title={track.hidden ? 'Show track' : 'Hide track'} onClick={() => update({ hidden: !track.hidden })}>
            <Icon name={track.hidden ? 'eyeOff' : 'eye'} size={13} />
          </button>
        )}
        <button className={`icon-btn small ${track.muted ? 'on' : ''}`} title={track.muted ? 'Unmute track' : 'Mute track'} onClick={() => update({ muted: !track.muted })}>
          <Icon name={track.muted ? 'mute' : 'volume'} size={13} />
        </button>
        <button className={`icon-btn small ${track.locked ? 'on' : ''}`} title={track.locked ? 'Unlock track' : 'Lock track'} onClick={() => update({ locked: !track.locked })}>
          <Icon name={track.locked ? 'lock' : 'unlock'} size={13} />
        </button>
        <button
          className="icon-btn small"
          title="Delete track"
          onClick={() => {
            if (clipCount === 0 || window.confirm(`Delete track ${track.name} and its ${clipCount} clip(s)?`))
              tryDispatch({ type: 'removeTrack', trackId: track.id })
          }}
        >
          <Icon name="trash" size={13} />
        </button>
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ timeline

interface DragState {
  mode: 'move' | 'trim-start' | 'trim-end'
  clipId: string
  pointerX: number
  pointerY: number
  started: boolean
  key: string
  orig: Map<string, { start: number; end: number; trackId: string }>
}

export function Timeline() {
  const project = useEditor((s) => s.project!)
  const dir = useEditor((s) => s.projectDir!)
  const zoom = useEditor((s) => s.zoom)
  const selection = useEditor((s) => s.selection)
  const snapping = useEditor((s) => s.snapping)
  const scrollRef = useRef<HTMLDivElement>(null)
  const [scroll, setScroll] = useState({ left: 0, width: 800 })
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const drag = useRef<DragState | null>(null)

  const duration = projectDuration(project)
  const contentW = Math.max((duration + 30) * zoom, scroll.width - HEADER_W)

  useLayoutEffect(() => {
    const el = scrollRef.current!
    const update = () => setScroll({ left: el.scrollLeft, width: el.clientWidth })
    const ro = new ResizeObserver(update)
    ro.observe(el)
    update()
    return () => ro.disconnect()
  }, [])

  // Keep the playhead visible while playing.
  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (!s.playing || s.playhead === prev.playhead) return
        const el = scrollRef.current
        if (!el) return
        const x = s.playhead * s.zoom
        const viewW = el.clientWidth - HEADER_W
        if (x > el.scrollLeft + viewW - 40 || x < el.scrollLeft) el.scrollLeft = Math.max(0, x - 60)
      }),
    []
  )

  // Ctrl + wheel zooms around the cursor.
  useEffect(() => {
    const el = scrollRef.current!
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const cursorX = e.clientX - rect.left - HEADER_W
      const z = getState().zoom
      const t = (el.scrollLeft + cursorX) / z
      const nz = Math.min(800, Math.max(4, z * (e.deltaY < 0 ? 1.15 : 1 / 1.15)))
      setState({ zoom: nz })
      requestAnimationFrame(() => (el.scrollLeft = Math.max(0, t * nz - cursorX)))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [])

  const snapCandidates = useCallback((exclude: Set<string>): number[] => {
    const s = getState()
    const out = [0, s.playhead]
    for (const c of s.project!.clips) if (!exclude.has(c.id)) out.push(c.start, clipEnd(c))
    return out
  }, [])

  const snapTime = (t: number, cands: number[], z: number): number | null => {
    let best: number | null = null
    let bestD = SNAP_PX / z
    for (const c of cands) {
      const d = Math.abs(c - t)
      if (d < bestD) {
        bestD = d
        best = c
      }
    }
    return best
  }

  const onClipPointerDown = useCallback((e: React.PointerEvent, clip: Clip, mode: DragState['mode']) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const s = getState()
    const track = s.project!.tracks.find((t) => t.id === clip.trackId)
    let sel = s.selection
    if (e.ctrlKey || e.metaKey || e.shiftKey) {
      sel = sel.includes(clip.id) ? sel.filter((id) => id !== clip.id) : [...sel, clip.id]
      setState({ selection: sel })
      return
    }
    if (!sel.includes(clip.id) || mode !== 'move') sel = [clip.id]
    setState({ selection: sel, selectedTrackId: clip.trackId })
    if (track?.locked) return
    preview.pause()
    const orig = new Map<string, { start: number; end: number; trackId: string }>()
    for (const id of mode === 'move' ? sel : [clip.id]) {
      const c = s.project!.clips.find((x) => x.id === id)
      if (c) orig.set(id, { start: c.start, end: clipEnd(c), trackId: c.trackId })
    }
    drag.current = { mode, clipId: clip.id, pointerX: e.clientX, pointerY: e.clientY, started: false, key: `drag-${Date.now()}`, orig }
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
  }, [])

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    if (!d.started) {
      if (Math.abs(e.clientX - d.pointerX) < 3 && Math.abs(e.clientY - d.pointerY) < 3) return
      d.started = true
    }
    const s = getState()
    const z = s.zoom
    const fps = s.project!.settings.fps
    const dt = (e.clientX - d.pointerX) / z
    const primary = d.orig.get(d.clipId)!
    const cands = s.snapping && !e.altKey ? snapCandidates(new Set(d.orig.keys())) : []
    if (d.mode === 'move') {
      let delta = dt
      const snapStart = snapTime(primary.start + dt, cands, z)
      const snapEnd = snapTime(primary.end + dt, cands, z)
      if (snapStart !== null) delta = snapStart - primary.start
      else if (snapEnd !== null) delta = snapEnd - primary.end
      // Keep every moved clip at t >= 0.
      const minStart = Math.min(...[...d.orig.values()].map((o) => o.start))
      delta = Math.max(delta, -minStart)
      // Track change (single clip only), resolved from the lane under the pointer.
      let trackId: string | undefined
      if (d.orig.size === 1) {
        const el = document.elementFromPoint(e.clientX, e.clientY)?.closest('[data-track-id]') as HTMLElement | null
        const tid = el?.dataset.trackId
        const clip = s.project!.clips.find((c) => c.id === d.clipId)!
        const track = s.project!.tracks.find((t) => t.id === tid)
        if (track && track.kind === trackKindForClip(clip.type) && !track.locked) trackId = track.id
      }
      const commands: Command[] = [...d.orig.entries()].map(([id, o]) => ({
        type: 'moveClip',
        clipId: id,
        start: snapToFrame(o.start + delta, fps),
        trackId: id === d.clipId ? trackId : undefined
      }))
      tryDispatch({ type: 'batch', commands }, { mergeKey: d.key })
    } else {
      const edge = d.mode === 'trim-start' ? 'start' : 'end'
      let t = (edge === 'start' ? primary.start : primary.end) + dt
      const snapped = snapTime(t, cands, z)
      if (snapped !== null) t = snapped
      tryDispatch({ type: 'trimClip', clipId: d.clipId, edge, time: snapToFrame(t, fps) }, { mergeKey: d.key })
    }
  }

  const onPointerUp = () => {
    drag.current = null
  }

  // ------------------------------------------------------------- drop zone
  const dropTime = (e: React.DragEvent, lane: HTMLElement) => {
    const rect = lane.getBoundingClientRect()
    return snapToFrame(Math.max(0, (e.clientX - rect.left) / getState().zoom), getState().project!.settings.fps)
  }

  const acceptsDrop = (e: React.DragEvent) =>
    e.dataTransfer.types.includes(DND_MEDIA) || e.dataTransfer.types.includes(DND_ITEM) || e.dataTransfer.types.includes('Files')

  const handleDrop = async (e: React.DragEvent, trackId: string | 'new-video' | 'new-audio', lane: HTMLElement) => {
    e.preventDefault()
    setDropTarget(null)
    const start = dropTime(e, lane)
    const s = getState()
    const mediaId = e.dataTransfer.getData(DND_MEDIA)
    const itemRaw = e.dataTransfer.getData(DND_ITEM)
    let target: string | undefined = trackId
    const ensureTrack = (kind: 'video' | 'audio'): Command[] => {
      if (trackId !== 'new-video' && trackId !== 'new-audio') return []
      target = uid('trk')
      return [{ type: 'addTrack', kind, id: target }]
    }
    try {
      if (mediaId) {
        const asset = findMedia(s.project!, mediaId)
        if (!asset) return
        const kind = asset.type === 'audio' ? 'audio' : 'video'
        const pre = ensureTrack(kind)
        const r = tryDispatch({ type: 'batch', commands: [...pre, { type: 'addMediaClip', mediaId, start, trackId: target }] })
        const id = r?.results?.[pre.length]?.clipId
        if (id) setState({ selection: [id] })
      } else if (itemRaw) {
        const item = JSON.parse(itemRaw) as DragItem
        if (item.kind === 'template') return insertItem(item, start)
        const pre = ensureTrack('video')
        if (pre.length) tryDispatch(pre[0])
        insertItem(item, start, target)
      } else if (e.dataTransfer.files.length) {
        const paths = [...e.dataTransfer.files].map((f) => window.frameAPI.media.pathForFile(f)).filter(Boolean)
        const assets = await editor.importMedia(paths)
        let t = start
        for (const a of assets) {
          const r = editor.addMediaToTimeline(a.id, { start: t, trackId: trackId.startsWith('new-') ? undefined : trackId })
          const c = r.clipId ? editor.findClip(r.clipId) : undefined
          if (c) t = clipEnd(c)
        }
      }
    } catch (err) {
      toast('error', (err as Error).message)
    }
  }

  const zoomTo = (z: number) => setState({ zoom: Math.min(800, Math.max(4, z)) })
  const fit = () => {
    const viewW = (scrollRef.current?.clientWidth ?? 800) - HEADER_W - 40
    zoomTo(viewW / Math.max(duration, 5))
    if (scrollRef.current) scrollRef.current.scrollLeft = 0
  }

  const run = (fn: () => unknown) => {
    try {
      fn()
    } catch (err) {
      toast('error', (err as Error).message)
    }
  }

  const tracks = project.tracks
  const sel1 = selection.length === 1 ? project.clips.find((c) => c.id === selection[0]) : undefined

  return (
    <section className="panel timeline">
      <div className="tl-toolbar">
        <button className="icon-btn" title="Split at playhead (S)" onClick={() => run(() => editor.splitAtPlayhead())}>
          <Icon name="scissors" />
        </button>
        <button className="icon-btn" title="Delete (Del)" disabled={!selection.length} onClick={() => run(() => editor.deleteClips(selection))}>
          <Icon name="trash" />
        </button>
        <button className="icon-btn" title="Duplicate (Ctrl+D)" disabled={!selection.length} onClick={() => run(() => selection.forEach((id) => editor.duplicateClip(id)))}>
          <Icon name="copy" />
        </button>
        <button
          className="icon-btn"
          title="Cross-dissolve from the previous clip on this track"
          disabled={!sel1}
          onClick={() => run(() => sel1 && editor.addCrossfade(sel1.id, 0.5))}
        >
          <Icon name="transition" />
        </button>
        <span className="divider" />
        <button className={`icon-btn ${snapping ? 'on' : ''}`} title="Snapping (hold Alt to bypass)" onClick={() => setState({ snapping: !snapping })}>
          <Icon name="magnet" />
        </button>
        <span className="divider" />
        <button className="btn ghost small" onClick={() => run(() => editor.addTrack('video'))}>
          <Icon name="plus" size={12} /> Video track
        </button>
        <button className="btn ghost small" onClick={() => run(() => editor.addTrack('audio'))}>
          <Icon name="plus" size={12} /> Audio track
        </button>
        <div className="spacer" />
        <button className="icon-btn" title="Zoom out (-)" onClick={() => zoomTo(zoom / 1.25)}>
          <Icon name="zoomOut" />
        </button>
        <input
          type="range"
          className="zoom-slider"
          min={Math.log(4)}
          max={Math.log(800)}
          step={0.01}
          value={Math.log(zoom)}
          onChange={(e) => zoomTo(Math.exp(Number(e.target.value)))}
          title="Timeline zoom (Ctrl + wheel)"
        />
        <button className="icon-btn" title="Zoom in (+)" onClick={() => zoomTo(zoom * 1.25)}>
          <Icon name="zoomIn" />
        </button>
        <button className="icon-btn" title="Zoom to fit" onClick={fit}>
          <Icon name="fit" />
        </button>
      </div>
      <div
        className="tl-scroll"
        ref={scrollRef}
        onScroll={(e) => setScroll({ left: e.currentTarget.scrollLeft, width: e.currentTarget.clientWidth })}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        <div className="tl-inner" style={{ width: HEADER_W + contentW }}>
          <div className="tl-ruler-row" style={{ height: RULER_H }}>
            <div className="tl-corner" style={{ width: HEADER_W }} />
            <div className="ruler-holder" style={{ left: HEADER_W, width: scroll.width - HEADER_W }}>
              <Ruler zoom={zoom} scrollLeft={scroll.left} width={Math.max(1, scroll.width - HEADER_W)} />
            </div>
          </div>
          {tracks.map((track, i) => (
            <div key={track.id} className="tl-row">
              <TrackHeader track={track} index={i} />
              <div
                className={`lane ${track.kind} ${dropTarget === track.id ? 'drop' : ''} ${track.hidden ? 'hidden-track' : ''}`}
                style={{ height: TRACK_H[track.kind], width: contentW }}
                data-track-id={track.id}
                onPointerDown={(e) => {
                  if (e.target === e.currentTarget) setState({ selection: [], selectedTrackId: track.id })
                }}
                onDragOver={(e) => {
                  if (!acceptsDrop(e)) return
                  e.preventDefault()
                  setDropTarget(track.id)
                }}
                onDragLeave={() => setDropTarget(null)}
                onDrop={(e) => handleDrop(e, track.id, e.currentTarget)}
              >
                {project.clips
                  .filter((c) => c.trackId === track.id)
                  .map((c) => (
                    <ClipView
                      key={c.id}
                      clip={c}
                      zoom={zoom}
                      selected={selection.includes(c.id)}
                      locked={track.locked}
                      asset={findMedia(project, c.mediaId)}
                      dir={dir}
                      onPointerDown={onClipPointerDown}
                    />
                  ))}
              </div>
            </div>
          ))}
          <div className="tl-row">
            <div className="track-head new" style={{ height: 40 }}>
              <small className="muted">Drop to add a track</small>
            </div>
            <div
              className={`lane new ${dropTarget === 'new' ? 'drop' : ''}`}
              style={{ height: 40, width: contentW }}
              onDragOver={(e) => {
                if (!acceptsDrop(e)) return
                e.preventDefault()
                setDropTarget('new')
              }}
              onDragLeave={() => setDropTarget(null)}
              onDrop={(e) => {
                const mediaId = e.dataTransfer.getData(DND_MEDIA)
                const asset = mediaId ? findMedia(getState().project!, mediaId) : undefined
                void handleDrop(e, asset?.type === 'audio' ? 'new-audio' : 'new-video', e.currentTarget)
              }}
            />
          </div>
          <PlayheadLine zoom={zoom} />
        </div>
      </div>
    </section>
  )
}
