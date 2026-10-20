import { useState } from 'react'
import type { MediaAsset } from '../../../shared/types'
import { formatDuration } from '../../../shared/util'
import { editor } from '../editor/api'
import { BACKGROUND_PRESETS, fillCss, SHAPE_PRESETS, TEMPLATES, TEXT_PRESETS } from '../editor/presets'
import { setState, toast, useEditor } from '../editor/store'
import { mediaUrl } from '../engine/paths'
import { Icon } from './Icon'

export const DND_MEDIA = 'application/x-frame-media'
export const DND_ITEM = 'application/x-frame-item'

export interface DragItem {
  kind: 'text' | 'shape' | 'background' | 'template'
  id: string
}

function guard(fn: () => unknown): void {
  try {
    fn()
  } catch (e) {
    toast('error', (e as Error).message)
  }
}

/** Insert a generated item; used by click, double-click and timeline drops. */
export function insertItem(item: DragItem, start?: number, trackId?: string): void {
  guard(() => {
    if (item.kind === 'text') {
      const r = editor.addTextPreset(item.id, start, trackId)
      if (r.clipId) setState({ selection: [r.clipId] })
    } else if (item.kind === 'shape') {
      const r = editor.addShape({ shape: item.id as never }, { start, trackId })
      if (r.clipId) setState({ selection: [r.clipId] })
    } else if (item.kind === 'background') {
      const preset = BACKGROUND_PRESETS.find((b) => b.id === item.id)!
      const r = editor.addBackground(preset.fill, { start, trackId })
      if (r.clipId) setState({ selection: [r.clipId] })
    } else editor.applyTemplate(item.id, start)
  })
}

function MediaCard({ asset, dir }: { asset: MediaAsset; dir: string }) {
  const used = useEditor((s) => s.project?.clips.some((c) => c.mediaId === asset.id) ?? false)
  const thumb = asset.thumbnail ? mediaUrl(dir, asset.thumbnail) : null
  return (
    <div
      className={`media-card ${asset.missing ? 'missing' : ''}`}
      draggable={!asset.missing}
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MEDIA, asset.id)
        e.dataTransfer.effectAllowed = 'copy'
      }}
      onDoubleClick={() => guard(() => {
        const r = editor.addMediaToTimeline(asset.id)
        if (r.clipId) setState({ selection: [r.clipId] })
      })}
      title={`${asset.name}\n${asset.width ? `${asset.width}×${asset.height} · ` : ''}${asset.videoCodec ?? asset.audioCodec ?? ''}${asset.proxy ? ' · preview proxy' : ''}\nDouble-click or drag to the timeline`}
    >
      <div className={`media-thumb ${asset.type}`}>
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <Icon name={asset.type} size={26} />}
        <span className="badge">{asset.type}</span>
        {asset.duration > 0 && <span className="dur">{formatDuration(asset.duration)}</span>}
        {used && <span className="used" title="Used in timeline" />}
        {asset.missing && (
          <div className="missing-overlay">
            <Icon name="warning" />
            <button className="btn small" onClick={() => editor.relinkMedia(asset.id).catch((e) => toast('error', e.message))}>
              Relink
            </button>
          </div>
        )}
      </div>
      <div className="media-name">
        <span>{asset.name}</span>
        <button
          className="icon-btn small"
          title="Remove from project"
          onClick={(e) => {
            e.stopPropagation()
            if (!used || window.confirm(`Remove "${asset.name}" and its clips from the timeline?`)) editor.removeMedia(asset.id)
          }}
        >
          <Icon name="trash" size={12} />
        </button>
      </div>
    </div>
  )
}

function GraphicsPanel() {
  const drag = (item: DragItem) => (e: React.DragEvent) => {
    e.dataTransfer.setData(DND_ITEM, JSON.stringify(item))
    e.dataTransfer.effectAllowed = 'copy'
  }
  return (
    <div className="graphics">
      <h4>Text</h4>
      <div className="tile-grid">
        {TEXT_PRESETS.map((p) => (
          <button
            key={p.id}
            className="tile text-tile"
            draggable
            onDragStart={drag({ kind: 'text', id: p.id })}
            onClick={() => insertItem({ kind: 'text', id: p.id })}
            title="Click to add at the playhead, or drag to the timeline"
          >
            <span
              style={{
                fontFamily: p.style.fontFamily,
                fontWeight: p.style.fontWeight,
                color: p.style.color,
                background: p.style.backgroundColor || undefined,
                letterSpacing: p.style.letterSpacing ? 1 : undefined
              }}
            >
              Aa
            </span>
            <small>{p.label}</small>
          </button>
        ))}
      </div>
      <h4>Shapes</h4>
      <div className="tile-grid">
        {SHAPE_PRESETS.map((p) => (
          <button
            key={p.id}
            className="tile"
            draggable
            onDragStart={drag({ kind: 'shape', id: p.id })}
            onClick={() => insertItem({ kind: 'shape', id: p.id })}
          >
            <i className={`shape-icon ${p.id}`} />
            <small>{p.label}</small>
          </button>
        ))}
      </div>
      <h4>Backgrounds</h4>
      <div className="tile-grid">
        {BACKGROUND_PRESETS.map((p) => (
          <button
            key={p.id}
            className="tile"
            draggable
            onDragStart={drag({ kind: 'background', id: p.id })}
            onClick={() => insertItem({ kind: 'background', id: p.id })}
          >
            <i className="swatch" style={{ background: fillCss(p.fill) }} />
            <small>{p.label}</small>
          </button>
        ))}
      </div>
      <h4>Motion templates</h4>
      <div className="template-list">
        {TEMPLATES.map((t) => (
          <button
            key={t.id}
            className="template"
            draggable
            onDragStart={drag({ kind: 'template', id: t.id })}
            onClick={() => insertItem({ kind: 'template', id: t.id })}
          >
            <Icon name="template" />
            <span>
              <b>{t.label}</b>
              <small>{t.description}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}

export function MediaLibrary() {
  const media = useEditor((s) => s.project?.media ?? [])
  const dir = useEditor((s) => s.projectDir ?? '')
  const tab = useEditor((s) => s.libraryTab)
  const [over, setOver] = useState(false)
  const [filter, setFilter] = useState<'all' | 'video' | 'image' | 'audio'>('all')

  const doImport = (paths?: string[]) => {
    editor.importMedia(paths).catch((e) => toast('error', (e as Error).message))
  }

  const shown = filter === 'all' ? media : media.filter((m) => m.type === filter)

  return (
    <aside className="panel library">
      <div className="panel-tabs">
        <button className={tab === 'media' ? 'active' : ''} onClick={() => setState({ libraryTab: 'media' })}>
          Media <span className="count">{media.length}</span>
        </button>
        <button className={tab === 'graphics' ? 'active' : ''} onClick={() => setState({ libraryTab: 'graphics' })}>
          Text &amp; Graphics
        </button>
      </div>
      {tab === 'media' ? (
        <div
          className={`library-body ${over ? 'drop-over' : ''}`}
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault()
              setOver(true)
            }
          }}
          onDragLeave={() => setOver(false)}
          onDrop={(e) => {
            setOver(false)
            if (!e.dataTransfer.files.length) return
            e.preventDefault()
            const paths = [...e.dataTransfer.files].map((f) => window.frameAPI.media.pathForFile(f)).filter(Boolean)
            doImport(paths)
          }}
        >
          <div className="library-actions">
            <button className="btn primary wide" onClick={() => doImport()}>
              <Icon name="import" /> Import media
            </button>
            <div className="seg">
              {(['all', 'video', 'image', 'audio'] as const).map((f) => (
                <button key={f} className={filter === f ? 'active' : ''} onClick={() => setFilter(f)}>
                  {f}
                </button>
              ))}
            </div>
          </div>
          {media.length === 0 ? (
            <div className="empty">
              <Icon name="import" size={28} />
              <p>Drop video, image or audio files here</p>
              <small>MP4 · MOV · WebM · PNG · JPG · WAV · MP3</small>
            </div>
          ) : (
            <div className="media-grid">
              {shown.map((m) => (
                <MediaCard key={m.id} asset={m} dir={dir} />
              ))}
            </div>
          )}
        </div>
      ) : (
        <div className="library-body">
          <GraphicsPanel />
        </div>
      )}
    </aside>
  )
}
