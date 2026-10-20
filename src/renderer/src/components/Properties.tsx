import { ANIMATION_PRESETS, evaluateTransform } from '../../../shared/animation'
import { ClipPatch } from '../../../shared/commands'
import { clipEnd, findMedia, findTrack, FONT_FAMILIES } from '../../../shared/project'
import type { AnimatableProp, AspectRatio, Clip, Fill, FitMode, ShapeKind, TextAlign } from '../../../shared/types'
import { formatDuration } from '../../../shared/util'
import { editor } from '../editor/api'
import { getState, setState, toast, tryDispatch, useEditor } from '../editor/store'
import { ColorField, newMergeKey, NumberField, Row, Section, Select, TimeField, Toggle } from './fields'
import { Icon } from './Icon'

function patch(clip: Clip, p: ClipPatch, mergeKey?: string) {
  tryDispatch({ type: 'updateClip', clipId: clip.id, patch: p }, { mergeKey })
}

// ------------------------------------------------------------ fill editor

function FillEditor({ fill, onChange }: { fill: Fill; onChange: (f: Fill, key: string) => void }) {
  const colors = fill.kind === 'solid' ? [fill.color] : fill.colors
  const setKind = (kind: Fill['kind']) => {
    const base = colors[0] ?? '#3d8bff'
    const second = colors[1] ?? '#111111'
    if (kind === 'solid') onChange({ kind, color: base }, newMergeKey('fill-kind'))
    else if (kind === 'linear') onChange({ kind, colors: [base, second], angle: fill.kind === 'linear' ? fill.angle : 90 }, newMergeKey('fill-kind'))
    else onChange({ kind, colors: [base, second] }, newMergeKey('fill-kind'))
  }
  const setColor = (i: number, c: string, key: string) => {
    if (fill.kind === 'solid') onChange({ kind: 'solid', color: c }, key)
    else {
      const next = [...fill.colors]
      next[i] = c
      onChange({ ...fill, colors: next }, key)
    }
  }
  return (
    <>
      <Row label="Fill">
        <Select
          value={fill.kind}
          options={[
            { value: 'solid', label: 'Solid' },
            { value: 'linear', label: 'Linear gradient' },
            { value: 'radial', label: 'Radial gradient' }
          ]}
          onChange={setKind}
        />
      </Row>
      {colors.map((c, i) => (
        <Row
          key={i}
          label={fill.kind === 'solid' ? 'Color' : `Stop ${i + 1}`}
          extra={
            fill.kind !== 'solid' && colors.length > 2 ? (
              <button className="icon-btn small" onClick={() => onChange({ ...fill, colors: fill.colors.filter((_, j) => j !== i) }, newMergeKey('fill-rm'))}>
                <Icon name="close" size={11} />
              </button>
            ) : undefined
          }
        >
          <ColorField value={c} onChange={(v, k) => setColor(i, v, k)} />
        </Row>
      ))}
      {fill.kind !== 'solid' && colors.length < 4 && (
        <Row label="">
          <button className="btn small" onClick={() => onChange({ ...fill, colors: [...fill.colors, '#ffffff'] }, newMergeKey('fill-add'))}>
            <Icon name="plus" size={11} /> Add stop
          </button>
        </Row>
      )}
      {fill.kind === 'linear' && (
        <Row label="Angle">
          <NumberField value={fill.angle} unit="°" label="∠" onChange={(v, k) => onChange({ ...fill, angle: v }, k)} />
        </Row>
      )}
    </>
  )
}

// ------------------------------------------------------------- transform

const TRANSFORM_FIELDS: { prop: AnimatableProp; label: string; factor?: number; unit?: string; step?: number; min?: number; max?: number; precision?: number }[] = [
  { prop: 'x', label: 'X', unit: 'px' },
  { prop: 'y', label: 'Y', unit: 'px' },
  { prop: 'scale', label: 'Scale', factor: 100, unit: '%', step: 1, min: 0 },
  { prop: 'rotation', label: 'Rotation', unit: '°', step: 1, precision: 1 },
  { prop: 'opacity', label: 'Opacity', factor: 100, unit: '%', step: 1, min: 0, max: 1 }
]

function TransformSection({ clip }: { clip: Clip }) {
  const playhead = useEditor((s) => s.playhead)
  const local = Math.min(Math.max(playhead - clip.start, 0), clip.duration)
  const inRange = playhead >= clip.start && playhead <= clipEnd(clip)
  const tr = evaluateTransform(clip, local)
  const set = (prop: AnimatableProp, v: number, key: string) => {
    const kfs = clip.keyframes[prop]
    if (kfs && kfs.length) {
      if (!inRange) return toast('info', 'Move the playhead over the clip to edit keyframed values.')
      tryDispatch({ type: 'setKeyframe', clipId: clip.id, prop, time: local, value: v }, { mergeKey: key })
    } else patch(clip, { transform: { [prop]: v } }, key)
  }
  const toggleKf = (prop: AnimatableProp) => {
    if (!inRange) return toast('info', 'Move the playhead over the clip to add a keyframe.')
    const kfs = clip.keyframes[prop] ?? []
    const here = kfs.find((k) => Math.abs(k.t - local) < 1e-3)
    if (here) tryDispatch({ type: 'removeKeyframe', clipId: clip.id, prop, time: here.t })
    else tryDispatch({ type: 'setKeyframe', clipId: clip.id, prop, time: local, value: tr[prop] })
  }
  const jumpKf = (dir: 1 | -1) => {
    const times = [...new Set(Object.values(clip.keyframes).flatMap((k) => (k ?? []).map((x) => x.t)))].sort((a, b) => a - b)
    const target = dir > 0 ? times.find((t) => t > local + 1e-3) : [...times].reverse().find((t) => t < local - 1e-3)
    if (target !== undefined) setState({ playhead: clip.start + target })
  }
  const hasAnyKf = Object.values(clip.keyframes).some((k) => k && k.length)
  return (
    <Section
      title="Transform"
      right={
        <div className="row tight">
          {hasAnyKf && (
            <>
              <button className="icon-btn small" title="Previous keyframe" onClick={() => jumpKf(-1)}>
                <Icon name="stepBack" size={12} />
              </button>
              <button className="icon-btn small" title="Next keyframe" onClick={() => jumpKf(1)}>
                <Icon name="stepFwd" size={12} />
              </button>
            </>
          )}
          <button
            className="btn ghost small"
            title="Reset transform and remove keyframes"
            onClick={() =>
              tryDispatch({
                type: 'batch',
                commands: [
                  { type: 'clearKeyframes', clipId: clip.id },
                  { type: 'updateClip', clipId: clip.id, patch: { transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 } } }
                ]
              })
            }
          >
            Reset
          </button>
        </div>
      }
    >
      {TRANSFORM_FIELDS.map((f) => {
        const kfs = clip.keyframes[f.prop] ?? []
        const atKf = kfs.some((k) => Math.abs(k.t - local) < 1e-3)
        return (
          <Row
            key={f.prop}
            label={f.label}
            extra={
              <button
                className={`kf-btn ${kfs.length ? 'has' : ''} ${atKf ? 'at' : ''}`}
                title={atKf ? 'Remove keyframe' : 'Add keyframe at playhead'}
                onClick={() => toggleKf(f.prop)}
              >
                <Icon name="diamond" size={11} />
              </button>
            }
          >
            <NumberField
              value={tr[f.prop]}
              label="↔"
              factor={f.factor}
              unit={f.unit}
              step={f.step ?? 1}
              min={f.min}
              max={f.max}
              precision={f.precision ?? 0}
              onChange={(v, k) => set(f.prop, v, k)}
            />
          </Row>
        )
      })}
      {(clip.type === 'video' || clip.type === 'image') && (
        <Row label="Fit">
          <Select<FitMode>
            value={clip.fit ?? 'contain'}
            options={[
              { value: 'contain', label: 'Fit (letterbox)' },
              { value: 'cover', label: 'Fill (crop)' },
              { value: 'fill', label: 'Stretch' }
            ]}
            onChange={(v) => patch(clip, { fit: v })}
          />
        </Row>
      )}
    </Section>
  )
}

// ----------------------------------------------------------------- timing

function TimingSection({ clip, fps }: { clip: Clip; fps: number }) {
  const asset = useEditor((s) => findMedia(s.project!, clip.mediaId))
  const timing = (t: { start?: number; duration?: number; sourceStart?: number }) =>
    tryDispatch({ type: 'setClipTiming', clipId: clip.id, ...t })
  return (
    <Section title="Timing">
      <Row label="Start">
        <TimeField value={clip.start} fps={fps} onChange={(v) => timing({ start: v })} />
      </Row>
      <Row label="End">
        <TimeField value={clipEnd(clip)} fps={fps} onChange={(v) => tryDispatch({ type: 'trimClip', clipId: clip.id, edge: 'end', time: v })} />
      </Row>
      <Row label="Duration">
        <TimeField value={clip.duration} fps={fps} onChange={(v) => timing({ duration: v })} />
      </Row>
      {clip.sourceStart !== undefined && clip.type !== 'image' && (
        <>
          <Row label="Source in">
            <TimeField value={clip.sourceStart} fps={fps} onChange={(v) => timing({ sourceStart: v })} />
          </Row>
          <Row label="Source out">
            <TimeField value={clip.sourceStart + clip.duration} fps={fps} disabled onChange={() => undefined} />
          </Row>
          {asset && <div className="hint">Source length {formatDuration(asset.duration)} · {asset.name}</div>}
        </>
      )}
    </Section>
  )
}

// ------------------------------------------------------------------- text

function TextSection({ clip }: { clip: Clip }) {
  const t = clip.text!
  const set = (p: Partial<typeof t>, key?: string) => patch(clip, { text: p }, key)
  return (
    <>
      <Section title="Text">
        <textarea
          className="text-input"
          value={t.text}
          rows={3}
          onChange={(e) => set({ text: e.target.value }, `text-${clip.id}`)}
          dir="auto"
        />
        <Row label="Font">
          <Select value={t.fontFamily} options={FONT_FAMILIES.map((f) => ({ value: f, label: f }))} onChange={(v) => set({ fontFamily: v })} />
        </Row>
        <Row label="Size">
          <NumberField value={t.fontSize} label="↔" unit="px" min={1} onChange={(v, k) => set({ fontSize: v }, k)} />
        </Row>
        <Row label="Weight">
          <Select
            value={t.fontWeight}
            options={[300, 400, 500, 600, 700, 800, 900].map((w) => ({ value: w, label: String(w) }))}
            onChange={(v) => set({ fontWeight: v })}
          />
        </Row>
        <Row label="Style">
          <div className="row tight">
            <Toggle value={t.italic} onChange={(v) => set({ italic: v })} title="Italic">
              <i>I</i>
            </Toggle>
            <Toggle value={t.uppercase} onChange={(v) => set({ uppercase: v })} title="Uppercase">
              AA
            </Toggle>
            <div className="seg">
              {(['left', 'center', 'right'] as TextAlign[]).map((a) => (
                <button key={a} className={t.align === a ? 'active' : ''} onClick={() => set({ align: a })} title={`Align ${a}`}>
                  <Icon name={`align${a[0].toUpperCase()}${a.slice(1)}`} size={13} />
                </button>
              ))}
            </div>
          </div>
        </Row>
        <Row label="Color">
          <ColorField value={t.color} onChange={(v, k) => set({ color: v }, k)} />
        </Row>
        <Row label="Line height">
          <NumberField value={t.lineHeight} label="↔" step={0.01} precision={2} min={0.5} onChange={(v, k) => set({ lineHeight: v }, k)} />
        </Row>
        <Row label="Spacing">
          <NumberField value={t.letterSpacing} label="↔" unit="px" onChange={(v, k) => set({ letterSpacing: v }, k)} />
        </Row>
        <Row label="Wrap width">
          <NumberField value={t.maxWidth} label="↔" unit="px" min={0} onChange={(v, k) => set({ maxWidth: v }, k)} />
        </Row>
      </Section>
      <Section title="Text effects">
        <Row label="Outline">
          <NumberField value={t.strokeWidth} label="↔" unit="px" min={0} onChange={(v, k) => set({ strokeWidth: v }, k)} />
        </Row>
        {t.strokeWidth > 0 && (
          <Row label="Outline color">
            <ColorField value={t.strokeColor} onChange={(v, k) => set({ strokeColor: v }, k)} />
          </Row>
        )}
        <Row label="Shadow blur">
          <NumberField value={t.shadowBlur} label="↔" unit="px" min={0} onChange={(v, k) => set({ shadowBlur: v }, k)} />
        </Row>
        <Row label="Shadow offset">
          <NumberField value={t.shadowOffsetY} label="↔" unit="px" onChange={(v, k) => set({ shadowOffsetY: v }, k)} />
        </Row>
        {(t.shadowBlur > 0 || t.shadowOffsetY !== 0) && (
          <Row label="Shadow color">
            <ColorField value={t.shadowColor} onChange={(v, k) => set({ shadowColor: v }, k)} />
          </Row>
        )}
        <Row label="Box">
          <Toggle value={!!t.backgroundColor} onChange={(v) => set({ backgroundColor: v ? 'rgba(0,0,0,0.7)' : '' })}>
            {t.backgroundColor ? 'On' : 'Off'}
          </Toggle>
        </Row>
        {t.backgroundColor && (
          <>
            <Row label="Box color">
              <ColorField value={t.backgroundColor} onChange={(v, k) => set({ backgroundColor: v }, k)} />
            </Row>
            <Row label="Box padding">
              <NumberField value={t.backgroundPadding} label="↔" unit="px" min={0} onChange={(v, k) => set({ backgroundPadding: v }, k)} />
            </Row>
            <Row label="Box radius">
              <NumberField value={t.backgroundRadius} label="↔" unit="px" min={0} onChange={(v, k) => set({ backgroundRadius: v }, k)} />
            </Row>
          </>
        )}
      </Section>
    </>
  )
}

function ShapeSection({ clip }: { clip: Clip }) {
  const s = clip.shape!
  const set = (p: Partial<typeof s>, key?: string) => patch(clip, { shape: p }, key)
  return (
    <Section title="Shape">
      <Row label="Type">
        <Select<ShapeKind>
          value={s.shape}
          options={[
            { value: 'rect', label: 'Rectangle' },
            { value: 'ellipse', label: 'Ellipse' },
            { value: 'triangle', label: 'Triangle' },
            { value: 'line', label: 'Line' },
            { value: 'star', label: 'Star' }
          ]}
          onChange={(v) => set({ shape: v })}
        />
      </Row>
      <Row label="Width">
        <NumberField value={s.width} label="↔" unit="px" min={1} onChange={(v, k) => set({ width: v }, k)} />
      </Row>
      <Row label="Height">
        <NumberField value={s.height} label="↔" unit="px" min={1} onChange={(v, k) => set({ height: v }, k)} />
      </Row>
      {(s.shape === 'rect' || s.shape === 'line') && (
        <Row label="Corner radius">
          <NumberField value={s.cornerRadius} label="↔" unit="px" min={0} onChange={(v, k) => set({ cornerRadius: v }, k)} />
        </Row>
      )}
      <FillEditor fill={s.fill} onChange={(f, k) => set({ fill: f }, k)} />
      <Row label="Stroke">
        <NumberField value={s.strokeWidth} label="↔" unit="px" min={0} onChange={(v, k) => set({ strokeWidth: v }, k)} />
      </Row>
      {s.strokeWidth > 0 && (
        <Row label="Stroke color">
          <ColorField value={s.strokeColor} onChange={(v, k) => set({ strokeColor: v }, k)} />
        </Row>
      )}
    </Section>
  )
}

function AudioSection({ clip }: { clip: Clip }) {
  const vol = clip.volume ?? 1
  const db = vol > 0 ? (20 * Math.log10(vol)).toFixed(1) : '-∞'
  return (
    <Section title="Audio">
      <Row label="Volume">
        <div className="slider-row">
          <input
            type="range"
            min={0}
            max={2}
            step={0.01}
            value={vol}
            onChange={(e) => patch(clip, { volume: Number(e.target.value) }, `vol-${clip.id}`)}
          />
          <NumberField value={vol} factor={100} unit="%" min={0} max={2} onChange={(v, k) => patch(clip, { volume: v }, k)} />
        </div>
      </Row>
      <Row label="">
        <div className="row tight">
          <span className="muted small">{db} dB</span>
          <div className="spacer" />
          <Toggle value={!!clip.muted} onChange={(v) => patch(clip, { muted: v })}>
            <Icon name={clip.muted ? 'mute' : 'volume'} size={12} /> {clip.muted ? 'Muted' : 'Mute'}
          </Toggle>
        </div>
      </Row>
    </Section>
  )
}

function FadeSection({ clip, isAudio }: { clip: Clip; isAudio: boolean }) {
  return (
    <Section title="Fades">
      <Row label="Fade in">
        <NumberField value={clip.fadeIn} label="↔" step={0.05} precision={2} unit="s" min={0} max={clip.duration} onChange={(v, k) => patch(clip, { fadeIn: v }, k)} />
      </Row>
      <Row label="Fade out">
        <NumberField value={clip.fadeOut} label="↔" step={0.05} precision={2} unit="s" min={0} max={clip.duration} onChange={(v, k) => patch(clip, { fadeOut: v }, k)} />
      </Row>
      <div className="hint">{isAudio ? 'Fades the volume.' : clip.type === 'video' ? 'Fades picture and sound.' : 'Fades opacity.'}</div>
    </Section>
  )
}

function AnimationSection({ clip }: { clip: Clip }) {
  const presets = ANIMATION_PRESETS.filter((p) => !p.textOnly || clip.type === 'text')
  const isMedia = clip.type === 'video' || clip.type === 'image'
  const row = (which: 'in' | 'out') => {
    const a = which === 'in' ? clip.animIn : clip.animOut
    return (
      <>
        <Row label={which === 'in' ? 'In' : 'Out'}>
          <Select value={a.preset} options={presets.map((p) => ({ value: p.id, label: p.label }))} onChange={(v) => editor.setAnimation(clip.id, which, v)} />
        </Row>
        {a.preset !== 'none' && (
          <Row label="Duration">
            <NumberField
              value={a.duration}
              label="↔"
              step={0.05}
              precision={2}
              unit="s"
              min={0.05}
              max={clip.duration}
              onChange={(v, k) => tryDispatch({ type: 'setAnimation', clipId: clip.id, which, preset: a.preset, duration: v }, { mergeKey: k })}
            />
          </Row>
        )}
      </>
    )
  }
  return (
    <Section title={isMedia ? 'Transitions & animation' : 'Animation'}>
      {row('in')}
      {row('out')}
      {isMedia && (
        <Row label="Cross-dissolve">
          <button
            className="btn small"
            title="Overlap with the previous clip on this track and dissolve between them"
            onClick={() => {
              try {
                editor.addCrossfade(clip.id, 0.5)
              } catch (e) {
                toast('error', (e as Error).message)
              }
            }}
          >
            <Icon name="transition" size={12} /> From previous clip (0.5s)
          </button>
        </Row>
      )}
    </Section>
  )
}

// ---------------------------------------------------------- no selection

function ProjectSection() {
  const settings = useEditor((s) => s.project!.settings)
  const trackId = useEditor((s) => s.selectedTrackId)
  const track = useEditor((s) => (trackId ? findTrack(s.project!, trackId) : undefined))
  const counts = {
    clips: useEditor((s) => s.project!.clips.length),
    media: useEditor((s) => s.project!.media.length)
  }
  const dir = useEditor((s) => s.projectDir)
  return (
    <>
      <Section title="Project">
        <Row label="Aspect">
          <Select<AspectRatio>
            value={settings.aspect}
            options={[
              { value: '16:9', label: '16:9 Landscape' },
              { value: '9:16', label: '9:16 Vertical' },
              { value: '1:1', label: '1:1 Square' }
            ]}
            onChange={(v) => tryDispatch({ type: 'setProjectSettings', aspect: v })}
          />
        </Row>
        <Row label="Resolution">
          <span className="value-text">
            {settings.width} × {settings.height}
          </span>
        </Row>
        <Row label="Frame rate">
          <Select
            value={settings.fps}
            options={[24, 25, 30, 50, 60].map((f) => ({ value: f, label: `${f} fps` }))}
            onChange={(v) => tryDispatch({ type: 'setProjectSettings', fps: v })}
          />
        </Row>
        <Row label="Background">
          <ColorField value={settings.background} onChange={(v, k) => tryDispatch({ type: 'setProjectSettings', background: v }, { mergeKey: k })} />
        </Row>
        <div className="hint">
          {counts.media} media · {counts.clips} clips
          <br />
          <span className="path-hint" title={dir ?? ''}>{dir}</span>
        </div>
      </Section>
      {track && (
        <Section title={`Track ${track.name}`}>
          <Row label="Kind">
            <span className="value-text">{track.kind}</span>
          </Row>
          <Row label="Name">
            <input
              className="text"
              key={track.id}
              defaultValue={track.name}
              onBlur={(e) => tryDispatch({ type: 'updateTrack', trackId: track.id, patch: { name: e.target.value } })}
            />
          </Row>
        </Section>
      )}
      <div className="shortcuts">
        <h4>Shortcuts</h4>
        <dl>
          <dt>Space</dt><dd>Play / pause</dd>
          <dt>← →</dt><dd>Step one frame (Shift: 1s)</dd>
          <dt>↑ ↓</dt><dd>Previous / next edit</dd>
          <dt>S</dt><dd>Split at playhead</dd>
          <dt>Del</dt><dd>Delete selection</dd>
          <dt>Ctrl+D</dt><dd>Duplicate</dd>
          <dt>Ctrl+Z / Ctrl+Y</dt><dd>Undo / redo</dd>
          <dt>Ctrl+S</dt><dd>Save</dd>
          <dt>+ / −</dt><dd>Timeline zoom</dd>
        </dl>
      </div>
    </>
  )
}

const TYPE_LABEL: Record<Clip['type'], string> = {
  video: 'Video',
  image: 'Image',
  audio: 'Audio',
  text: 'Text',
  shape: 'Shape',
  background: 'Background'
}

export function Properties() {
  const selection = useEditor((s) => s.selection)
  const clip = useEditor((s) => (s.selection.length === 1 ? s.project!.clips.find((c) => c.id === s.selection[0]) : undefined))
  const fps = useEditor((s) => s.project!.settings.fps)

  let body
  if (selection.length > 1) {
    body = (
      <div className="multi">
        <p>{selection.length} clips selected</p>
        <button className="btn" onClick={() => editor.deleteClips(getState().selection)}>
          <Icon name="trash" /> Delete selected
        </button>
      </div>
    )
  } else if (!clip) body = <ProjectSection />
  else {
    const visual = clip.type !== 'audio'
    body = (
      <>
        <div className="clip-head">
          <span className={`type-chip ${clip.type}`}>
            <Icon name={clip.type} size={12} /> {TYPE_LABEL[clip.type]}
          </span>
          <input
            className="clip-name"
            key={clip.id}
            defaultValue={clip.name}
            onBlur={(e) => e.target.value.trim() && e.target.value !== clip.name && patch(clip, { name: e.target.value.trim() })}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
        </div>
        <TimingSection clip={clip} fps={fps} />
        {clip.type === 'text' && <TextSection clip={clip} />}
        {clip.type === 'shape' && <ShapeSection clip={clip} />}
        {clip.type === 'background' && (
          <Section title="Background">
            <FillEditor fill={clip.fill ?? { kind: 'solid', color: '#000' }} onChange={(f, k) => patch(clip, { fill: f }, k)} />
          </Section>
        )}
        {visual && <TransformSection clip={clip} />}
        {(clip.type === 'audio' || clip.type === 'video') && <AudioSection clip={clip} />}
        <FadeSection clip={clip} isAudio={!visual} />
        {visual && <AnimationSection clip={clip} />}
      </>
    )
  }
  return (
    <aside className="panel properties">
      <div className="panel-title">{clip ? 'Properties' : selection.length > 1 ? 'Selection' : 'Project'}</div>
      <div className="properties-body">{body}</div>
    </aside>
  )
}
