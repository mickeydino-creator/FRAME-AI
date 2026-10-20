import { useEffect, useState } from 'react'
import type { RecentProject } from '../../../shared/ipc'
import type { AspectRatio } from '../../../shared/types'
import { editor } from '../editor/api'
import { toast, useEditor } from '../editor/store'
import { Icon } from './Icon'

const ASPECTS: { id: AspectRatio; label: string; hint: string }[] = [
  { id: '16:9', label: '16:9', hint: 'Landscape · YouTube' },
  { id: '9:16', label: '9:16', hint: 'Vertical · Reels, TikTok' },
  { id: '1:1', label: '1:1', hint: 'Square · Feed' }
]

export function StartScreen() {
  const [name, setName] = useState('Untitled Project')
  const [aspect, setAspect] = useState<AspectRatio>('16:9')
  const [location, setLocation] = useState<string | null>(null)
  const [recent, setRecent] = useState<RecentProject[]>([])
  const [busy, setBusy] = useState(false)
  const info = useEditor((s) => s.systemInfo)

  useEffect(() => {
    window.frameAPI.project.recent().then(setRecent, () => undefined)
  }, [])

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    try {
      await fn()
    } catch (e) {
      toast('error', (e as Error).message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="start">
      <div className="start-card">
        <div className="start-brand">
          <Icon name="logo" size={22} className="logo-mark" />
          <span className="logo-text">
            FRAME<b>AI</b>
          </span>
        </div>
        <div className="start-cols">
          <section>
            <h2>New project</h2>
            <label className="field">
              <span>Name</span>
              <input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
            </label>
            <div className="field">
              <span>Format</span>
              <div className="aspect-pick">
                {ASPECTS.map((a) => (
                  <button key={a.id} className={aspect === a.id ? 'active' : ''} onClick={() => setAspect(a.id)}>
                    <i className={`ar ar-${a.id.replace(':', 'x')}`} />
                    <b>{a.label}</b>
                    <small>{a.hint}</small>
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <span>Location</span>
              <div className="row">
                <code className="path" title={location ?? info?.defaultProjectsDir}>
                  {location ?? info?.defaultProjectsDir ?? 'Documents/FRAME AI Projects'}
                </code>
                <button
                  className="btn"
                  onClick={async () => {
                    const dir = await window.frameAPI.project.chooseDirectory()
                    if (dir) setLocation(dir)
                  }}
                >
                  Change…
                </button>
              </div>
            </div>
            <button
              className="btn primary wide"
              disabled={busy || !name.trim()}
              onClick={() => run(() => editor.newProject(name.trim(), aspect, location ?? undefined))}
            >
              Create project
            </button>
          </section>
          <section>
            <h2>Open</h2>
            <button className="btn wide" disabled={busy} onClick={() => run(() => editor.openProject())}>
              <Icon name="folder" /> Open project…
            </button>
            <h3>Recent</h3>
            <div className="recent">
              {recent.length === 0 && <p className="muted">No recent projects yet.</p>}
              {recent.map((r) => (
                <button key={r.dir} className="recent-item" disabled={busy} onClick={() => run(() => editor.openProject(r.dir))}>
                  <b>{r.name}</b>
                  <small>{r.dir}</small>
                </button>
              ))}
            </div>
          </section>
        </div>
        <footer className="start-foot">
          {info ? (
            info.ffmpegPath ? (
              <span className="ok">FFmpeg {info.ffmpegVersion} ready</span>
            ) : (
              <span className="bad">FFmpeg not found - import and export are unavailable</span>
            )
          ) : (
            <span className="muted">Checking FFmpeg…</span>
          )}
          <span className="muted">Everything stays on this computer.</span>
        </footer>
      </div>
    </div>
  )
}
