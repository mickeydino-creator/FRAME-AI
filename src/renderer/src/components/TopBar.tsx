import { useEffect, useState } from 'react'
import { saveWithToast } from '../App'
import { editor } from '../editor/api'
import { getState, PreviewQuality, redo, setState, toast, tryDispatch, undo, useEditor } from '../editor/store'
import { Icon } from './Icon'

export function TopBar() {
  const name = useEditor((s) => s.project?.name ?? '')
  const dirty = useEditor((s) => s.dirty)
  const canUndo = useEditor((s) => s.past.length > 0)
  const canRedo = useEditor((s) => s.future.length > 0)
  const quality = useEditor((s) => s.previewQuality)
  const exporting = useEditor((s) => {
    const p = s.exportProgress
    return !!p && !['done', 'error', 'cancelled'].includes(p.phase)
  })
  const [draft, setDraft] = useState(name)
  useEffect(() => setDraft(name), [name])

  const commitName = () => {
    if (draft.trim() && draft !== name) tryDispatch({ type: 'setProjectName', name: draft })
    else setDraft(name)
  }

  const confirmLeave = async (): Promise<boolean> => {
    if (!getState().dirty) return true
    if (window.confirm('Save changes to the current project first?')) return saveWithToast()
    return true
  }

  return (
    <header className="topbar">
      <div className="brand">
        <Icon name="logo" size={18} className="logo-mark" />
        <span className="logo-text">
          FRAME<b>AI</b>
        </span>
      </div>
      <div className="menu-group">
        <button
          className="btn ghost"
          title="New project"
          onClick={async () => {
            if (await confirmLeave()) setState({ project: null, projectDir: null, dirty: false })
          }}
        >
          New
        </button>
        <button
          className="btn ghost"
          title="Open project"
          onClick={async () => {
            if (!(await confirmLeave())) return
            try {
              await editor.openProject()
            } catch (e) {
              toast('error', (e as Error).message)
            }
          }}
        >
          Open
        </button>
      </div>
      <div className="project-name">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commitName}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setDraft(name)
              ;(e.target as HTMLInputElement).blur()
            }
          }}
          spellCheck={false}
          title="Project name"
        />
        <span className={`save-state ${dirty ? 'dirty' : ''}`}>{dirty ? 'Unsaved changes' : 'Saved'}</span>
      </div>
      <div className="menu-group">
        <button className={`btn ghost ${dirty ? '' : 'quiet'}`} title="Save (Ctrl+S)" onClick={() => void saveWithToast()}>
          <Icon name="save" /> Save
        </button>
        <button className="icon-btn" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={() => undo()}>
          <Icon name="undo" />
        </button>
        <button className="icon-btn" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={() => redo()}>
          <Icon name="redo" />
        </button>
      </div>
      <div className="spacer" />
      <label className="inline-select" title="Preview render resolution">
        <span>Preview quality</span>
        <select value={quality} onChange={(e) => setState({ previewQuality: Number(e.target.value) as PreviewQuality })}>
          <option value={1}>Full</option>
          <option value={0.5}>Half</option>
          <option value={0.25}>Quarter</option>
        </select>
      </label>
      <button className="btn primary" onClick={() => setState({ exportOpen: true })}>
        <Icon name="export" /> {exporting ? 'Exporting…' : 'Export'}
      </button>
    </header>
  )
}
