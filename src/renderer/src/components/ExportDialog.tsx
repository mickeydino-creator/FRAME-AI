import { useState } from 'react'
import { projectDuration } from '../../../shared/project'
import type { ExportFormat, ExportQuality } from '../../../shared/types'
import { formatTimecode } from '../../../shared/util'
import { editor } from '../editor/api'
import { getState, setState, toast, useEditor } from '../editor/store'
import { Row, Select } from './fields'
import { Icon } from './Icon'

function outSize(w: number, h: number, short: number) {
  if (!short) return { w, h }
  const s = short / Math.min(w, h)
  return { w: Math.round((w * s) / 2) * 2, h: Math.round((h * s) / 2) * 2 }
}

export function ExportDialog() {
  const project = useEditor((s) => s.project!)
  const progress = useEditor((s) => s.exportProgress)
  const info = useEditor((s) => s.systemInfo)
  const [format, setFormat] = useState<ExportFormat>('mp4')
  const [res, setRes] = useState(0)
  const [fps, setFps] = useState(project.settings.fps)
  const [quality, setQuality] = useState<ExportQuality>('high')
  const [busy, setBusy] = useState(false)
  const duration = projectDuration(project)
  const running = !!progress && !['done', 'error', 'cancelled'].includes(progress.phase)
  const size = outSize(project.settings.width, project.settings.height, res)
  const missing = project.media.filter((m) => m.missing && project.clips.some((c) => c.mediaId === m.id))
  const encoderOk = !info || (format === 'mp4' ? info.encoders.h264 : info.encoders.vp9)

  const start = async () => {
    setBusy(true)
    try {
      const out = await window.frameAPI.export.chooseOutput(project.name.replace(/[<>:"/\\|?*]+/g, '_'), format)
      if (!out) return
      setState({ exportProgress: null })
      await editor.exportProject({ outputPath: out, format, height: res, fps, quality })
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  const close = () => {
    if (!running) setState({ exportOpen: false, exportProgress: null })
    else setState({ exportOpen: false })
  }

  const pct = progress && progress.totalFrames ? Math.round((progress.frame / progress.totalFrames) * 100) : 0

  return (
    <div className="modal-backdrop" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal">
        <div className="modal-head">
          <h3>Export video</h3>
          <button className="icon-btn" onClick={close}>
            <Icon name="close" />
          </button>
        </div>
        {!progress || progress.phase === 'error' || progress.phase === 'cancelled' ? (
          <div className="modal-body">
            <Row label="Format">
              <Select<ExportFormat>
                value={format}
                options={[
                  { value: 'mp4', label: 'MP4 (H.264 + AAC)' },
                  { value: 'webm', label: 'WebM (VP9 + Opus)' }
                ]}
                onChange={setFormat}
              />
            </Row>
            <Row label="Resolution">
              <Select
                value={res}
                options={[
                  { value: 0, label: `Project (${project.settings.width}×${project.settings.height})` },
                  { value: 720, label: '720p' },
                  { value: 480, label: '480p' }
                ]}
                onChange={setRes}
              />
            </Row>
            <Row label="Frame rate">
              <Select value={fps} options={[24, 25, 30, 50, 60].map((f) => ({ value: f, label: `${f} fps` }))} onChange={setFps} />
            </Row>
            <Row label="Quality">
              <Select<ExportQuality>
                value={quality}
                options={[
                  { value: 'high', label: 'High' },
                  { value: 'medium', label: 'Medium' },
                  { value: 'low', label: 'Low (small file)' }
                ]}
                onChange={setQuality}
              />
            </Row>
            <div className="export-summary">
              <span>
                {size.w}×{size.h} · {fps} fps · {formatTimecode(duration, fps)}
              </span>
            </div>
            {progress?.phase === 'error' && (
              <div className="error-box">
                <Icon name="warning" /> <pre>{progress.message}</pre>
              </div>
            )}
            {progress?.phase === 'cancelled' && <div className="hint">Export cancelled.</div>}
            {!encoderOk && (
              <div className="error-box">
                <Icon name="warning" /> Your FFmpeg build has no {format === 'mp4' ? 'H.264 (libx264)' : 'VP9 (libvpx-vp9)'} encoder.
              </div>
            )}
            {info && !info.ffmpegPath && (
              <div className="error-box">
                <Icon name="warning" /> FFmpeg was not found. See README for installation.
              </div>
            )}
            {missing.length > 0 && (
              <div className="error-box">
                <Icon name="warning" /> Relink missing media first: {missing.map((m) => m.name).join(', ')}
              </div>
            )}
            {duration <= 0 && <div className="hint">The timeline is empty.</div>}
            <div className="modal-actions">
              <button className="btn" onClick={close}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={busy || duration <= 0 || missing.length > 0 || !encoderOk || !info?.ffmpegPath}
                onClick={start}
              >
                <Icon name="export" /> Export…
              </button>
            </div>
          </div>
        ) : (
          <div className="modal-body">
            <div className="export-status">
              <b>
                {progress.phase === 'done'
                  ? 'Export complete'
                  : progress.phase === 'audio'
                    ? 'Mixing audio…'
                    : progress.phase === 'finalizing'
                      ? 'Finalizing…'
                      : progress.phase === 'preparing'
                        ? 'Preparing…'
                        : `Rendering frame ${progress.frame} / ${progress.totalFrames}`}
              </b>
              <div className="progress">
                <div style={{ width: `${progress.phase === 'done' ? 100 : pct}%` }} />
              </div>
              {progress.phase === 'rendering' && (
                <span className="muted small">
                  {pct}% · {progress.fps} fps · about {Math.max(0, progress.etaSeconds)}s left
                </span>
              )}
              <code className="path">{progress.outputPath}</code>
            </div>
            <div className="modal-actions">
              {progress.phase === 'done' ? (
                <>
                  <button className="btn" onClick={() => progress.outputPath && window.frameAPI.system.showItemInFolder(progress.outputPath)}>
                    <Icon name="folder" /> Show in folder
                  </button>
                  <button className="btn" onClick={() => progress.outputPath && window.frameAPI.system.openPath(progress.outputPath)}>
                    <Icon name="play" /> Play
                  </button>
                  <button className="btn primary" onClick={() => setState({ exportOpen: false, exportProgress: null })}>
                    Done
                  </button>
                </>
              ) : (
                <>
                  <span className="muted small">You can keep editing while this renders.</span>
                  <div className="spacer" />
                  <button className="btn" onClick={() => setState({ exportOpen: false })}>
                    Hide
                  </button>
                  <button className="btn danger" onClick={() => editor.cancelExport(getState().exportProgress!.jobId)}>
                    Cancel export
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
