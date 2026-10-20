import { app, BrowserWindow, dialog } from 'electron'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import type { OpenedProject, RecentProject } from '../shared/ipc'
import { migrateProject } from '../shared/project'
import { ensureProjectDirs } from './media'

export const PROJECT_FILE = 'project.frameai'

/** Directories the media protocol is allowed to serve from. */
export const allowedRoots = new Set<string>()

export function allowRoot(dir: string): void {
  allowedRoots.add(resolve(dir))
}

export function defaultProjectsDir(): string {
  return join(app.getPath('documents'), 'FRAME AI Projects')
}

function safeDirName(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim().slice(0, 60) || 'Untitled Project'
}

export async function createProjectDir(name: string, parentDir?: string): Promise<string> {
  const parent = parentDir || defaultProjectsDir()
  await mkdir(parent, { recursive: true })
  const base = safeDirName(name)
  let dir = join(parent, base)
  let n = 2
  while (existsSync(dir)) dir = join(parent, `${base} (${n++})`)
  await mkdir(dir, { recursive: true })
  await ensureProjectDirs(dir)
  allowRoot(dir)
  return dir
}

export async function saveProject(dir: string, json: string): Promise<void> {
  await ensureProjectDirs(dir)
  const file = join(dir, PROJECT_FILE)
  const tmp = `${file}.tmp`
  await writeFile(tmp, json, 'utf8')
  if (existsSync(file)) await copyFile(file, `${file}.bak`).catch(() => undefined)
  await rename(tmp, file)
  allowRoot(dir)
  await addRecent(dir, (JSON.parse(json) as { name?: string }).name ?? 'Project')
}

export async function openProject(win: BrowserWindow | null, dirOrFile?: string): Promise<OpenedProject | null> {
  let target = dirOrFile
  if (!target) {
    const res = await dialog.showOpenDialog(win ?? undefined!, {
      title: 'Open FRAME AI project',
      defaultPath: defaultProjectsDir(),
      filters: [{ name: 'FRAME AI Project', extensions: ['frameai'] }],
      properties: ['openFile']
    })
    if (res.canceled || res.filePaths.length === 0) return null
    target = res.filePaths[0]
  }
  const file = target.endsWith('.frameai') ? target : join(target, PROJECT_FILE)
  const dir = dirname(file)
  if (!existsSync(file)) throw new Error(`No FRAME AI project found at ${dir}.`)
  let raw: unknown
  try {
    raw = JSON.parse(await readFile(file, 'utf8'))
  } catch {
    throw new Error('The project file is damaged and could not be read. A backup may exist as project.frameai.bak.')
  }
  const project = migrateProject(raw)
  await ensureProjectDirs(dir)
  const missing: string[] = []
  for (const m of project.media) {
    const abs = join(dir, m.file)
    if (existsSync(abs)) continue
    // Recover from the original import location when possible.
    if (m.originalPath && existsSync(m.originalPath)) {
      try {
        await copyFile(m.originalPath, abs)
        continue
      } catch {
        // fall through to missing
      }
    }
    m.missing = true
    missing.push(m.name)
  }
  for (const m of project.media) {
    if (m.proxy && !existsSync(join(dir, m.proxy))) m.proxy = undefined
    if (m.thumbnail && !existsSync(join(dir, m.thumbnail))) m.thumbnail = undefined
    if (m.waveform && !existsSync(join(dir, m.waveform))) m.waveform = undefined
  }
  allowRoot(dir)
  await addRecent(dir, project.name)
  return { project, dir, missing }
}

function recentFile(): string {
  return join(app.getPath('userData'), 'recent-projects.json')
}

export async function listRecent(): Promise<RecentProject[]> {
  try {
    const list = JSON.parse(await readFile(recentFile(), 'utf8')) as RecentProject[]
    return list.filter((r) => existsSync(join(r.dir, PROJECT_FILE)))
  } catch {
    return []
  }
}

async function addRecent(dir: string, name: string): Promise<void> {
  const list = (await listRecent()).filter((r) => resolve(r.dir) !== resolve(dir))
  list.unshift({ dir, name, openedAt: new Date().toISOString() })
  await mkdir(dirname(recentFile()), { recursive: true })
  await writeFile(recentFile(), JSON.stringify(list.slice(0, 12), null, 2))
}
