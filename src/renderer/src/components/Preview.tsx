import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { evaluateTransform } from '../../../shared/animation'
import { findClip, findTrack, projectDuration } from '../../../shared/project'
import type { AspectRatio } from '../../../shared/types'
import { formatTimecode } from '../../../shared/util'
import { getState, setState, tryDispatch, useEditor } from '../editor/store'
import { hitTest } from '../engine/compositor'
import { preview } from '../engine/preview'
import { Icon } from './Icon'

function Timecode() {
  const playhead = useEditor((s) => s.playhead)
  const fps = useEditor((s) => s.project!.settings.fps)
  const clips = useEditor((s) => s.project!.clips)
  const duration = useMemo(() => projectDuration(getState().project!), [clips])
  return (
    <div className="timecode">
      <span className="tc-now">{formatTimecode(playhead, fps)}</span>
      <span className="tc-sep">/</span>
      <span className="tc-dur">{formatTimecode(duration, fps)}</span>
    </div>
  )
}

const ZOOMS: ('fit' | number)[] = ['fit', 0.25, 0.5, 0.75, 1, 1.5, 2]

export function Preview() {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const [stage, setStage] = useState({ w: 800, h: 450 })
  const settings = useEditor((s) => s.project!.settings)
  const playing = useEditor((s) => s.playing)
  const zoom = useEditor((s) => s.previewZoom)
  const empty = useEditor((s) => s.project!.clips.length === 0)

  useEffect(() => {
    preview.attach(canvasRef.current)
    return () => preview.attach(null)
  }, [])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const ro = new ResizeObserver(() => setStage({ w: el.clientWidth, h: el.clientHeight }))
    ro.observe(el)
    setStage({ w: el.clientWidth, h: el.clientHeight })
    return () => ro.disconnect()
  }, [])

  const fitScale = Math.min((stage.w - 32) / settings.width, (stage.h - 32) / settings.height)
  const scale = zoom === 'fit' ? Math.max(0.05, fitScale) : zoom
  const cssW = Math.round(settings.width * scale)
  const cssH = Math.round(settings.height * scale)

  const drag = useRef<{ clipId: string; startX: number; startY: number; baseX: number; baseY: number; key: string } | null>(
    null
  )

  const toComp = (e: React.PointerEvent) => {
    const rect = canvasRef.current!.getBoundingClientRect()
    return {
      x: ((e.clientX - rect.left) / rect.width) * settings.width,
      y: ((e.clientY - rect.top) / rect.height) * settings.height
    }
  }

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    preview.pause()
    const p = toComp(e)
    const project = getState().project!
    const sel = getState().selection
    // Prefer dragging the current selection if the pointer is over it.
    const selectedHit = preview.lastHits.filter((h) => sel.includes(h.clipId))
    const hit = hitTest(selectedHit, p.x, p.y) ?? hitTest(preview.lastHits, p.x, p.y)
    if (!hit) {
      setState({ selection: [] })
      return
    }
    const clip = findClip(project, hit.clipId)
    if (!clip || clip.type === 'background') {
      setState({ selection: clip ? [clip.id] : [] })
      return
    }
    if (findTrack(project, clip.trackId)?.locked) return
    setState({ selection: [clip.id] })
    const local = getState().playhead - clip.start
    const tr = evaluateTransform(clip, local)
    drag.current = { clipId: clip.id, startX: p.x, startY: p.y, baseX: tr.x, baseY: tr.y, key: `pv-move-${clip.id}-${Date.now()}` }
    ;(e.target as HTMLElement).setPointerCapture(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d) return
    const p = toComp(e)
    let x = Math.round(d.baseX + p.x - d.startX)
    let y = Math.round(d.baseY + p.y - d.startY)
    // Snap to center lines.
    if (Math.abs(x) < 12) x = 0
    if (Math.abs(y) < 12) y = 0
    const s = getState()
    const clip = findClip(s.project!, d.clipId)
    if (!clip) return
    const local = s.playhead - clip.start
    const hasKf = (clip.keyframes.x?.length ?? 0) > 0 || (clip.keyframes.y?.length ?? 0) > 0
    if (hasKf) {
      tryDispatch(
        {
          type: 'batch',
          commands: [
            { type: 'setKeyframe', clipId: clip.id, prop: 'x', time: local, value: x },
            { type: 'setKeyframe', clipId: clip.id, prop: 'y', time: local, value: y }
          ]
        },
        { mergeKey: d.key }
      )
    } else tryDispatch({ type: 'updateClip', clipId: clip.id, patch: { transform: { x, y } } }, { mergeKey: d.key })
  }

  const onPointerUp = () => {
    drag.current = null
  }

  const setAspect = (aspect: AspectRatio) => tryDispatch({ type: 'setProjectSettings', aspect })

  return (
    <section className="panel preview">
      <div className="preview-head">
        <div className="seg">
          {(['16:9', '9:16', '1:1'] as AspectRatio[]).map((a) => (
            <button key={a} className={settings.aspect === a ? 'active' : ''} onClick={() => setAspect(a)} title={`Aspect ratio ${a}`}>
              {a}
            </button>
          ))}
        </div>
        <span className="muted small">
          {settings.width}×{settings.height} · {settings.fps} fps
        </span>
        <div className="spacer" />
        <button className="icon-btn" title="Fit to window" onClick={() => setState({ previewZoom: 'fit' })}>
          <Icon name="fit" />
        </button>
        <select
          className="mini-select"
          value={String(zoom)}
          onChange={(e) => setState({ previewZoom: e.target.value === 'fit' ? 'fit' : Number(e.target.value) })}
          title="Preview zoom"
        >
          {ZOOMS.map((z) => (
            <option key={String(z)} value={String(z)}>
              {z === 'fit' ? `Fit (${Math.round(fitScale * 100)}%)` : `${z * 100}%`}
            </option>
          ))}
        </select>
      </div>
      <div className={`preview-stage ${zoom === 'fit' ? '' : 'scroll'}`} ref={stageRef}>
        <div className="canvas-wrap" style={{ width: cssW, height: cssH }}>
          <canvas
            ref={canvasRef}
            style={{ width: cssW, height: cssH }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {empty && (
            <div className="preview-empty">
              <b>Nothing on the timeline yet</b>
              <span>Add media or a title to see it here.</span>
            </div>
          )}
        </div>
      </div>
      <div className="transport">
        <Timecode />
        <div className="transport-buttons">
          <button className="icon-btn" title="Go to start (Home)" onClick={() => { preview.pause(); setState({ playhead: 0 }) }}>
            <Icon name="prev" />
          </button>
          <button
            className="icon-btn"
            title="Previous frame (←)"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }))}
          >
            <Icon name="stepBack" />
          </button>
          <button className="play-btn" title="Play / Pause (Space)" onClick={() => preview.toggle()}>
            <Icon name={playing ? 'pause' : 'play'} size={18} />
          </button>
          <button
            className="icon-btn"
            title="Next frame (→)"
            onClick={() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }))}
          >
            <Icon name="stepFwd" />
          </button>
          <button
            className="icon-btn"
            title="Go to end (End)"
            onClick={() => { preview.pause(); setState({ playhead: projectDuration(getState().project!) }) }}
          >
            <Icon name="next" />
          </button>
        </div>
        <div className="transport-right" />
      </div>
    </section>
  )
}
