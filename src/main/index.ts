import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { join } from 'node:path'
import type { ExportOptions, MediaAsset, Project } from '../shared/types'
import { cancelAll, cancelExport, failJob, finishFrames, jobForSender, nextVideoFrame, startExport, writeFrame } from './exporter'
import './bridge'
import { systemInfo } from './ffmpeg'
import { ALL_EXT, AUDIO_EXT, IMAGE_EXT, importFiles, importOne, VIDEO_EXT } from './media'
import { handleMediaProtocol, registerMediaScheme } from './mediaProtocol'
import { allowRoot, createProjectDir, defaultProjectsDir, listRecent, openProject, saveProject } from './projects'

registerMediaScheme()

// Containers and CI often run as root, where Chromium refuses to sandbox.
if (process.env.FRAME_AI_NO_SANDBOX === '1') app.commandLine.appendSwitch('no-sandbox')

let mainWindow: BrowserWindow | null = null
let dirty = false
let forceClose = false

const preloadPath = join(__dirname, '../preload/index.js')

function loadRenderer(win: BrowserWindow, hash = ''): Promise<void> {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) {
    return win.loadURL(`${process.env.ELECTRON_RENDERER_URL}${hash ? `#${hash}` : ''}`)
  }
  return win.loadFile(join(__dirname, '../renderer/index.html'), hash ? { hash } : undefined)
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 940,
    minWidth: 1180,
    minHeight: 700,
    backgroundColor: '#0a0a0b',
    title: 'FRAME AI',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath,
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  mainWindow.setMenuBarVisibility(false)
  mainWindow.once('ready-to-show', () => {
    mainWindow?.maximize()
    mainWindow?.show()
  })
  mainWindow.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && (input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i'))) {
      mainWindow?.webContents.toggleDevTools()
    }
  })
  // Never navigate away from the editor (e.g. a file dropped outside a drop zone).
  mainWindow.webContents.on('will-navigate', (e) => e.preventDefault())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.on('close', async (e) => {
    if (forceClose || !dirty) return
    e.preventDefault()
    const res = await dialog.showMessageBox(mainWindow!, {
      type: 'question',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      title: 'FRAME AI',
      message: 'Save changes to this project before closing?'
    })
    if (res.response === 0) mainWindow?.webContents.send('app:close-request')
    else if (res.response === 1) {
      forceClose = true
      mainWindow?.close()
    }
  })
  mainWindow.on('closed', () => {
    mainWindow = null
    cancelAll()
  })
  void loadRenderer(mainWindow)
}

function senderWindow(e: Electron.IpcMainInvokeEvent): BrowserWindow | null {
  return BrowserWindow.fromWebContents(e.sender)
}

function registerIpc(): void {
  ipcMain.handle('system:info', () => systemInfo(defaultProjectsDir()))
  ipcMain.handle('system:showItemInFolder', (_e, p: string) => shell.showItemInFolder(p))
  ipcMain.handle('system:openPath', (_e, p: string) => shell.openPath(p))

  ipcMain.handle('project:create', (_e, name: string, parentDir?: string) =>
    createProjectDir(name, parentDir).then((dir) => ({ dir }))
  )
  ipcMain.handle('project:save', (_e, dir: string, json: string) => saveProject(dir, json))
  ipcMain.handle('project:open', (e, dir?: string) => openProject(senderWindow(e), dir))
  ipcMain.handle('project:recent', () => listRecent())
  ipcMain.handle('project:chooseDirectory', async (e) => {
    const res = await dialog.showOpenDialog(senderWindow(e)!, {
      title: 'Choose project location',
      defaultPath: defaultProjectsDir(),
      properties: ['openDirectory', 'createDirectory']
    })
    return res.canceled ? null : res.filePaths[0]
  })
  ipcMain.on('project:dirty', (_e, d: boolean) => {
    dirty = d
  })

  ipcMain.handle('media:choose', async (e) => {
    const res = await dialog.showOpenDialog(senderWindow(e)!, {
      title: 'Import media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'All supported media', extensions: ALL_EXT },
        { name: 'Video', extensions: VIDEO_EXT },
        { name: 'Images', extensions: IMAGE_EXT },
        { name: 'Audio', extensions: AUDIO_EXT }
      ]
    })
    return res.canceled ? [] : res.filePaths
  })
  ipcMain.handle('media:import', (e, projectDir: string, paths: string[]) => {
    allowRoot(projectDir)
    return importFiles(projectDir, paths, (p) => e.sender.send('media:progress', p))
  })
  ipcMain.handle('media:relink', async (e, projectDir: string, asset: MediaAsset, newPath?: string) => {
    let file = newPath
    if (!file) {
      const ext = asset.name.split('.').pop() ?? ''
      const res = await dialog.showOpenDialog(senderWindow(e)!, {
        title: `Locate ${asset.name}`,
        properties: ['openFile'],
        filters: [{ name: 'Media', extensions: ext ? [ext, ...ALL_EXT] : ALL_EXT }]
      })
      if (res.canceled || !res.filePaths[0]) return null
      file = res.filePaths[0]
    }
    const fresh = await importOne(projectDir, file, (p) => e.sender.send('media:progress', p), asset.id)
    return { ...fresh, name: asset.name }
  })

  ipcMain.handle('export:chooseOutput', async (e, defaultName: string, format: string) => {
    const res = await dialog.showSaveDialog(senderWindow(e)!, {
      title: 'Export video',
      defaultPath: join(app.getPath('videos'), `${defaultName}.${format}`),
      filters: [{ name: format.toUpperCase(), extensions: [format] }]
    })
    return res.canceled ? null : res.filePath
  })
  ipcMain.handle('export:start', (e, project: Project, projectDir: string, options: ExportOptions) =>
    startExport(project, projectDir, options, e.sender, preloadPath, (win) => loadRenderer(win, 'export'))
  )
  ipcMain.handle('export:cancel', (_e, jobId: string) => cancelExport(jobId))
  ipcMain.handle('export:getJob', (e) => jobForSender(e.sender))
  ipcMain.handle('export:nextVideoFrame', (_e, jobId: string, clipId: string, t: number) => nextVideoFrame(jobId, clipId, t))
  ipcMain.handle('export:writeFrame', (_e, jobId: string, frame: Uint8Array) => writeFrame(jobId, frame))
  ipcMain.handle('export:finishFrames', (_e, jobId: string) => finishFrames(jobId))
  ipcMain.handle('export:fail', (_e, jobId: string, message: string) => failJob(jobId, message))

  ipcMain.on('app:confirm-close', () => {
    forceClose = true
    mainWindow?.close()
  })
}

app.whenReady().then(() => {
  handleMediaProtocol()
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => cancelAll())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
