import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { FrameAPI } from '../shared/ipc'

const MEDIA_SCHEME = 'frame-media'

function listen<T>(channel: string, cb: (payload: T) => void): () => void {
  const handler = (_e: Electron.IpcRendererEvent, payload: T) => cb(payload)
  ipcRenderer.on(channel, handler)
  return () => ipcRenderer.removeListener(channel, handler)
}

const api: FrameAPI = {
  system: {
    info: () => ipcRenderer.invoke('system:info'),
    showItemInFolder: (p) => ipcRenderer.invoke('system:showItemInFolder', p),
    openPath: (p) => ipcRenderer.invoke('system:openPath', p)
  },
  project: {
    create: (name, parentDir) => ipcRenderer.invoke('project:create', name, parentDir),
    save: (dir, json) => ipcRenderer.invoke('project:save', dir, json),
    open: (dir) => ipcRenderer.invoke('project:open', dir),
    chooseDirectory: () => ipcRenderer.invoke('project:chooseDirectory'),
    recent: () => ipcRenderer.invoke('project:recent'),
    setDirty: (d) => ipcRenderer.send('project:dirty', d)
  },
  media: {
    chooseFiles: () => ipcRenderer.invoke('media:choose'),
    import: (dir, paths) => ipcRenderer.invoke('media:import', dir, paths),
    relink: (dir, asset, newPath) => ipcRenderer.invoke('media:relink', dir, asset, newPath),
    onProgress: (cb) => listen('media:progress', cb),
    pathForFile: (file) => webUtils.getPathForFile(file),
    toUrl: (absPath) => `${MEDIA_SCHEME}://file/${encodeURIComponent(absPath)}`
  },
  export: {
    chooseOutput: (name, format) => ipcRenderer.invoke('export:chooseOutput', name, format),
    start: (project, dir, options) => ipcRenderer.invoke('export:start', project, dir, options),
    cancel: (jobId) => ipcRenderer.invoke('export:cancel', jobId),
    onProgress: (cb) => listen('export:progress', cb),
    getJob: () => ipcRenderer.invoke('export:getJob'),
    nextVideoFrame: (jobId, clipId, t) => ipcRenderer.invoke('export:nextVideoFrame', jobId, clipId, t),
    writeFrame: (jobId, frame) => ipcRenderer.invoke('export:writeFrame', jobId, frame),
    finishFrames: (jobId) => ipcRenderer.invoke('export:finishFrames', jobId),
    fail: (jobId, message) => ipcRenderer.invoke('export:fail', jobId, message)
  },
  bridge: {
    onCommand: (handler) => {
      ipcRenderer.on('bridge:invoke', async (_e, msg: { id: number; method: string; args: unknown[] }) => {
        try {
          const value = await handler(msg.method, msg.args)
          ipcRenderer.send('bridge:result', { id: msg.id, ok: true, value })
        } catch (err) {
          ipcRenderer.send('bridge:result', { id: msg.id, ok: false, error: (err as Error).message })
        }
      })
    }
  },
  app: {
    onCloseRequest: (cb) => {
      ipcRenderer.on('app:close-request', () => cb())
    },
    confirmClose: () => ipcRenderer.send('app:confirm-close')
  }
}

contextBridge.exposeInMainWorld('frameAPI', api)
