import { useEffect } from 'react'
import { clipEnd, projectDuration } from '../../shared/project'
import { snapToFrame } from '../../shared/util'
import { editor, installEditorBridge } from './editor/api'
import { getState, redo, setState, toast, undo, useEditor } from './editor/store'
import { preview } from './engine/preview'
import { ExportDialog } from './components/ExportDialog'
import { MediaLibrary } from './components/MediaLibrary'
import { Preview } from './components/Preview'
import { Properties } from './components/Properties'
import { StartScreen } from './components/StartScreen'
import { Timeline } from './components/Timeline'
import { Toasts } from './components/Toasts'
import { TopBar } from './components/TopBar'

function isTyping(e: KeyboardEvent): boolean {
  const el = e.target as HTMLElement | null
  if (!el) return false
  const tag = el.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable
}

export async function saveWithToast(): Promise<boolean> {
  try {
    await editor.saveProject()
    toast('success', 'Project saved')
    return true
  } catch (e) {
    toast('error', `Save failed: ${(e as Error).message}`)
    return false
  }
}

function stepFrames(n: number): void {
  const s = getState()
  if (!s.project) return
  preview.pause()
  const fps = s.project.settings.fps
  setState({ playhead: Math.max(0, snapToFrame(s.playhead + n / fps, fps)) })
}

function onKeyDown(e: KeyboardEvent): void {
  const s = getState()
  if (!s.project) return
  const mod = e.ctrlKey || e.metaKey
  const key = e.key.toLowerCase()
  if (mod && key === 's') {
    e.preventDefault()
    void saveWithToast()
    return
  }
  if (isTyping(e)) return
  if (mod && key === 'z' && !e.shiftKey) {
    e.preventDefault()
    undo()
  } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
    e.preventDefault()
    redo()
  } else if (mod && key === 'd') {
    e.preventDefault()
    for (const id of s.selection) {
      try {
        editor.duplicateClip(id)
      } catch (err) {
        toast('error', (err as Error).message)
      }
    }
  } else if (mod && key === 'a') {
    e.preventDefault()
    setState({ selection: s.project.clips.map((c) => c.id) })
  } else if (key === ' ') {
    e.preventDefault()
    preview.toggle()
  } else if (key === 'arrowleft') {
    e.preventDefault()
    stepFrames(e.shiftKey ? -s.project.settings.fps : -1)
  } else if (key === 'arrowright') {
    e.preventDefault()
    stepFrames(e.shiftKey ? s.project.settings.fps : 1)
  } else if (key === 'home') {
    preview.pause()
    setState({ playhead: 0 })
  } else if (key === 'end') {
    preview.pause()
    setState({ playhead: projectDuration(s.project) })
  } else if (key === 's' || (mod && key === 'k')) {
    e.preventDefault()
    try {
      editor.splitAtPlayhead()
    } catch (err) {
      toast('error', (err as Error).message)
    }
  } else if (key === 'delete' || key === 'backspace') {
    if (s.selection.length) {
      e.preventDefault()
      editor.deleteClips(s.selection)
    }
  } else if (key === 'escape') {
    setState({ selection: [] })
  } else if (key === '=' || key === '+') {
    setState({ zoom: Math.min(800, s.zoom * 1.25) })
  } else if (key === '-') {
    setState({ zoom: Math.max(4, s.zoom / 1.25) })
  } else if (key === 'arrowup' || key === 'arrowdown') {
    // Jump to previous/next clip edge.
    e.preventDefault()
    const edges = [...new Set(s.project.clips.flatMap((c) => [c.start, clipEnd(c)]))].sort((a, b) => a - b)
    const t = s.playhead
    const target = key === 'arrowup' ? [...edges].reverse().find((x) => x < t - 1e-4) : edges.find((x) => x > t + 1e-4)
    if (target !== undefined) {
      preview.pause()
      setState({ playhead: target })
    }
  }
}

export function App() {
  const hasProject = useEditor((s) => !!s.project)
  const exportOpen = useEditor((s) => s.exportOpen)

  useEffect(() => {
    installEditorBridge()
    window.frameAPI.system.info().then(
      (info) => {
        setState({ systemInfo: info })
        if (!info.ffmpegPath || !info.ffprobePath)
          toast('error', 'FFmpeg was not found. Import and export need FFmpeg - see README for setup.', 15000)
      },
      () => undefined
    )
    window.addEventListener('keydown', onKeyDown)
    const offImport = window.frameAPI.media.onProgress((p) => {
      setState((s) => {
        const importing = { ...s.importing }
        if (p.stage === 'done' || p.stage === 'error') delete importing[p.file]
        else importing[p.file] = p
        return { importing }
      })
    })
    const offExport = window.frameAPI.export.onProgress((p) => setState({ exportProgress: p }))
    window.frameAPI.app.onCloseRequest(async () => {
      if (await saveWithToast()) window.frameAPI.app.confirmClose()
    })
    // Prevent the window from navigating when files are dropped outside a drop zone.
    const stop = (e: DragEvent) => e.preventDefault()
    window.addEventListener('dragover', stop)
    window.addEventListener('drop', stop)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('dragover', stop)
      window.removeEventListener('drop', stop)
      offImport()
      offExport()
    }
  }, [])

  useEffect(
    () =>
      useEditor.subscribe((s, prev) => {
        if (s.dirty !== prev.dirty) window.frameAPI.project.setDirty(s.dirty)
        if (s.project?.name !== prev.project?.name || s.dirty !== prev.dirty)
          document.title = s.project ? `${s.dirty ? '• ' : ''}${s.project.name} - FRAME AI` : 'FRAME AI'
      }),
    []
  )

  if (!hasProject) {
    return (
      <>
        <StartScreen />
        <Toasts />
      </>
    )
  }
  return (
    <div className="app">
      <TopBar />
      <div className="workspace">
        <MediaLibrary />
        <Preview />
        <Properties />
      </div>
      <Timeline />
      {exportOpen && <ExportDialog />}
      <Toasts />
    </div>
  )
}
