/**
 * Everything that reaches outside the mod: FFmpeg, the file system, the
 * session's state. The pane and Claude's tools both call these functions, so
 * an edit from either one goes through the same path, is saved the same way
 * and can be undone the same way.
 */
import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'

import type { FrameEnv, FrameJob, FrameLogEntry, FramePreview, FrameView } from '../types'
import { applyEdit, createProject, describeProject, type Edit, type EditResult, loadProject, type Media, newId, type Project, projectDuration, type Aspect } from './model'
import { baseName, classifyProbe, explainFfmpeg, exportArgs, extOf, frameArgs, joinPath, MEDIA_EXT, parseProgress, parseSrt, type Probe } from './render'

type $ = EngineInterface

export const projectAtom = atom({ plugin: 'frame-ai', key: 'project' } as const, null, { shape: 'project-1' })
export const dirAtom = atom({ plugin: 'frame-ai', key: 'dir' } as const, null, { shape: 'dir-1' })
export const missingAtom = atom({ plugin: 'frame-ai', key: 'missing' } as const, [], { shape: 'missing-1' })
export const historyAtom = atom({ plugin: 'frame-ai', key: 'history' } as const, { past: [], future: [] }, { shape: 'history-1' })
export const viewAtom = atom(
  { plugin: 'frame-ai', key: 'view' } as const,
  { playhead: 0, selection: null, tab: 'clip', zoom: 0, scroll: 0, isPlaying: false } as FrameView,
  { shape: 'view-1' },
)
export const envAtom = atom(
  { plugin: 'frame-ai', key: 'env' } as const,
  {
    isChecked: false,
    ffmpeg: 'ffmpeg',
    ffprobe: 'ffprobe',
    ffmpegVersion: null,
    hasX264: false,
    hasWhisper: false,
    fontFile: null,
    projectsDir: '',
    isWindows: false,
    error: null,
  } as FrameEnv,
  { shape: 'env-1' },
)
export const previewAtom = atom(
  { plugin: 'frame-ai', key: 'preview' } as const,
  { time: 0, png: null, jpeg: null, width: 0, height: 0, isRendering: false, error: null } as FramePreview,
  { shape: 'preview-1' },
)
export const jobAtom = atom({ plugin: 'frame-ai', key: 'job' } as const, null as FrameJob | null, { shape: 'job-1' })
export const logAtom = atom({ plugin: 'frame-ai', key: 'log' } as const, [] as FrameLogEntry[], { shape: 'log-1' })
export const chatAtom = atom({ plugin: 'frame-ai', key: 'chat' } as const, { isWaiting: false, sent: [] }, { shape: 'chat-1' })
export const draftAtom = atom(
  { plugin: 'frame-ai', key: 'draft' } as const,
  { projectName: '', importPath: '', exportPath: '', quality: 'high' as const, height: 0 },
  { shape: 'draft-1' },
)

export type Options = { ffmpegPath: string; ffprobePath: string; projectsDir: string; fontFile: string; whisperModel: string; askBeforeDestructive: boolean }

export class UserError extends Error {}

// ------------------------------------------------------------------ env

export async function checkEnv($: $, o: Options): Promise<FrameEnv> {
  const isWindows = (await $.env.get('OS')) === 'Windows_NT'
  const home = (await $.env.get('USERPROFILE')) || (await $.env.get('HOME')) || '.'
  const projectsDir = o.projectsDir || joinPath(home, 'FRAME AI Projects')
  const ffmpeg = o.ffmpegPath || 'ffmpeg'
  let ffprobe = o.ffprobePath || 'ffprobe'
  if (!o.ffprobePath && o.ffmpegPath) ffprobe = o.ffmpegPath.replace(/ffmpeg(\.exe)?$/i, m => m.replace(/ffmpeg/i, 'ffprobe'))
  const env: FrameEnv = { isChecked: true, ffmpeg, ffprobe, ffmpegVersion: null, hasX264: false, hasWhisper: false, fontFile: null, projectsDir, isWindows, error: null }
  try {
    const v = await $.process.run([ffmpeg, '-hide_banner', '-version'], { timeoutMs: 15000 })
    env.ffmpegVersion = /ffmpeg version (\S+)/.exec(v.stdout)?.[1] ?? 'unknown'
    const enc = await $.process.run([ffmpeg, '-hide_banner', '-encoders'], { timeoutMs: 15000 })
    env.hasX264 = /\blibx264\b/.test(enc.stdout)
    const filters = await $.process.run([ffmpeg, '-hide_banner', '-filters'], { timeoutMs: 15000 })
    env.hasWhisper = /\bwhisper\b/.test(filters.stdout)
    await $.process.run([ffprobe, '-version'], { timeoutMs: 15000 })
  } catch {
    env.error = isWindows
      ? 'FFmpeg was not found. Install it with `winget install Gyan.FFmpeg`, restart Claude Code, or set the FFmpeg path in /config.'
      : 'FFmpeg was not found. Install ffmpeg (brew install ffmpeg / apt install ffmpeg) or set the FFmpeg path in /config.'
  }
  env.fontFile = await findFont($, o.fontFile, isWindows)
  await update($, envAtom, () => env)
  return env
}

async function findFont($: $, configured: string, isWindows: boolean): Promise<string | null> {
  const candidates = configured
    ? [configured]
    : isWindows
      ? ['C:/Windows/Fonts/segoeui.ttf', 'C:/Windows/Fonts/arial.ttf', 'C:/Windows/Fonts/calibri.ttf']
      : [
          '/System/Library/Fonts/Supplemental/Arial.ttf',
          '/Library/Fonts/Arial.ttf',
          '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
          '/usr/share/fonts/TTF/DejaVuSans.ttf',
          '/usr/share/fonts/dejavu/DejaVuSans.ttf',
        ]
  for (const f of candidates) if (await $.fs.exists(f).catch(() => false)) return f
  if (!isWindows) {
    const r = await $.process.run(['fc-match', '-f', '%{file}', 'sans'], { timeoutMs: 5000 }).catch(() => null)
    if (r?.exitCode === 0 && r.stdout.trim()) return r.stdout.trim()
  }
  return null
}

async function requireFfmpeg($: $): Promise<FrameEnv> {
  const env = await read($, envAtom)
  if (env.error || !env.ffmpegVersion) throw new UserError(env.error ?? 'FFmpeg has not been checked yet.')
  return env
}

// ------------------------------------------------------------- logging

export async function log($: $, text: string, origin: FrameLogEntry['origin'], isError = false): Promise<void> {
  await update($, logAtom, list => [...list, { at: new Date().toISOString(), text, isError, origin }].slice(-60))
}

// ------------------------------------------------------------ projects

function slug(name: string): string {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '_').trim().slice(0, 60) || 'Untitled'
}

export async function requireProject($: $): Promise<{ project: Project; dir: string }> {
  const project = (await read($, projectAtom)) as Project | null
  const dir = await read($, dirAtom)
  if (!project || !dir) throw new UserError('No project is open. Create one with new_project or /frame new <name>.')
  return { project, dir }
}

async function save($: $, project: Project, dir: string): Promise<void> {
  await $.fs.write(joinPath(dir, 'project.json'), JSON.stringify(project, null, 2))
}

async function setProject($: $, project: Project, dir: string): Promise<void> {
  await update($, projectAtom, () => project)
  await update($, dirAtom, () => dir)
  await update($, historyAtom, () => ({ past: [], future: [] }))
  await update($, viewAtom, v => ({ ...v, playhead: 0, selection: null, scroll: 0, zoom: 0, isPlaying: false }))
  await update($, previewAtom, p => ({ ...p, png: null, jpeg: null, error: null }))
  await $.store.set('lastProject', dir)
  await refreshMissing($, project)
}

export async function newProject($: $, name: string, aspect: Aspect = '16:9'): Promise<string> {
  const env = await read($, envAtom)
  const base = joinPath(env.projectsDir, slug(name))
  let dir = base
  for (let n = 2; await $.fs.exists(joinPath(dir, 'project.json')); n++) dir = `${base} (${n})`
  const project = createProject(name, aspect)
  await save($, project, dir)
  await setProject($, project, dir)
  return dir
}

export async function openProject($: $, target: string): Promise<{ project: Project; dir: string; missing: string[] }> {
  const file = target.toLowerCase().endsWith('.json') ? target : joinPath(target, 'project.json')
  if (!(await $.fs.exists(file))) throw new UserError(`No FRAME AI project at ${target}.`)
  let raw: unknown
  try {
    raw = JSON.parse(await $.fs.read(file))
  } catch {
    throw new UserError(`The project file ${file} is damaged and could not be read.`)
  }
  const project = loadProject(raw)
  const dir = file.replace(/[\\/]project\.json$/i, '')
  await setProject($, project, dir)
  return { project, dir, missing: await read($, missingAtom) }
}

export async function listProjects($: $): Promise<{ name: string; dir: string; updatedAt: string }[]> {
  const env = await read($, envAtom)
  const entries = await $.fs.list(env.projectsDir).catch(() => [])
  const out: { name: string; dir: string; updatedAt: string }[] = []
  for (const e of entries) {
    if (e.kind !== 'dir') continue
    const dir = joinPath(env.projectsDir, e.name)
    try {
      const p = JSON.parse(await $.fs.read(joinPath(dir, 'project.json'))) as Project
      if (p.format === 'frame-ai-mod') out.push({ name: p.name, dir, updatedAt: p.updatedAt })
    } catch {
      // not a project folder
    }
  }
  return out.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

export async function refreshMissing($: $, project: Project): Promise<string[]> {
  const missing: string[] = []
  for (const m of project.media) if (!(await $.fs.exists(m.path).catch(() => false))) missing.push(m.id)
  await update($, missingAtom, () => missing)
  return missing
}

// --------------------------------------------------------------- edits

/** Apply edits to the open project, save it, and record undo history. */
export async function edit($: $, edits: Edit | Edit[], origin: FrameLogEntry['origin'], summary?: string): Promise<EditResult> {
  const { project, dir } = await requireProject($)
  const { project: next, result } = applyEdit(project, edits)
  await save($, next, dir)
  await update($, historyAtom, h => ({ past: [...h.past, project].slice(-40), future: [] }))
  await update($, projectAtom, () => next)
  const sel = (await read($, viewAtom)).selection
  if (sel && !next.clips.some(c => c.id === sel)) await update($, viewAtom, v => ({ ...v, selection: null }))
  if (summary) await log($, summary, origin)
  schedulePreview($)
  return result
}

export async function undoRedo($: $, which: 'undo' | 'redo', origin: FrameLogEntry['origin']): Promise<boolean> {
  const { project, dir } = await requireProject($)
  const h = await read($, historyAtom)
  const stack = which === 'undo' ? h.past : h.future
  if (!stack.length) return false
  const target = stack[stack.length - 1] as Project
  await update($, historyAtom, () =>
    which === 'undo'
      ? { past: h.past.slice(0, -1), future: [...h.future, project] }
      : { past: [...h.past, project], future: h.future.slice(0, -1) },
  )
  await update($, projectAtom, () => target)
  await save($, target, dir)
  await log($, which === 'undo' ? 'Undid the last edit' : 'Redid an edit', origin)
  schedulePreview($)
  return true
}

// -------------------------------------------------------------- import

async function probe($: $, env: FrameEnv, path: string): Promise<Probe> {
  const r = await $.process.run([env.ffprobe, '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', path], { timeoutMs: 60000 })
  if (r.exitCode !== 0) throw new UserError(`FFmpeg cannot read ${baseName(path)}: ${explainFfmpeg(r.stderr)}`)
  return JSON.parse(r.stdout) as Probe
}

/** Import files, or every media file in a folder. Originals are only read. */
export async function importMedia($: $, paths: string[], origin: FrameLogEntry['origin']): Promise<{ added: Media[]; errors: string[] }> {
  const env = await requireFfmpeg($)
  await requireProject($)
  const files: string[] = []
  const errors: string[] = []
  for (const raw of paths) {
    const path = raw.trim().replace(/^["']|["']$/g, '')
    if (!path) continue
    const st = await $.fs.stat(path).catch(() => null)
    if (!st) {
      errors.push(`${path}: not found`)
      continue
    }
    if (st.kind === 'dir') {
      for (const e of await $.fs.list(path)) if (e.kind === 'file' && MEDIA_EXT.includes(extOf(e.name))) files.push(joinPath(path, e.name))
    } else if (!MEDIA_EXT.includes(extOf(path))) errors.push(`${baseName(path)}: unsupported file type (.${extOf(path)})`)
    else files.push(path)
  }
  const added: Media[] = []
  for (const path of files) {
    try {
      const info = classifyProbe(path, await probe($, env, path))
      const media: Media = { id: newId('med'), name: baseName(path), path, ...info }
      added.push(media)
    } catch (e) {
      errors.push(`${baseName(path)}: ${(e as Error).message}`)
    }
  }
  if (added.length) await edit($, added.map(media => ({ op: 'addMedia', media }) as Edit), origin, `Imported ${added.map(m => m.name).join(', ')}`)
  for (const e of errors) await log($, `Import failed: ${e}`, origin, true)
  return { added, errors }
}

export async function relinkMedia($: $, mediaId: string, path: string, origin: FrameLogEntry['origin']): Promise<void> {
  const env = await requireFfmpeg($)
  const { project, dir } = await requireProject($)
  const m = project.media.find(x => x.id === mediaId)
  if (!m) throw new UserError(`No media with id ${mediaId}.`)
  if (!(await $.fs.exists(path))) throw new UserError(`${path} does not exist.`)
  const info = classifyProbe(path, await probe($, env, path))
  const next = { ...project, media: project.media.map(x => (x.id === mediaId ? { ...x, ...info, path } : x)) }
  await save($, next, dir)
  await update($, projectAtom, () => next)
  await refreshMissing($, next)
  await log($, `Relinked ${m.name} to ${path}`, origin)
  schedulePreview($)
}

// ----------------------------------------------------------- rendering

async function prepareText($: $, project: Project, dir: string): Promise<Record<string, string>> {
  const files: Record<string, string> = {}
  for (const c of project.clips) {
    if (!c.text) continue
    const file = joinPath(dir, 'cache', `text-${c.id}.txt`)
    await $.fs.write(file, c.text.content)
    files[c.id] = file
  }
  return files
}

async function renderJob($: $) {
  const env = await requireFfmpeg($)
  const { project, dir } = await requireProject($)
  const missing = await refreshMissing($, project)
  const used = new Set(project.clips.map(c => c.mediaId))
  const lost = project.media.filter(m => missing.includes(m.id) && used.has(m.id))
  if (lost.length) throw new UserError(`Missing media: ${lost.map(m => m.name).join(', ')}. Relink or remove it first.`)
  if (project.clips.some(c => c.kind === 'text') && !env.fontFile)
    throw new UserError('No font was found for titles. Set "Title font file" in /config.')
  const textFiles = await prepareText($, project, dir)
  return { env, project, dir, job: { project, fontFile: env.fontFile ?? '', textFiles, mediaPath: (m: Media) => m.path } }
}

let previewTimer: { cancel: () => void } | null = null
let previewGen = 0

/** Re-render the preview frame soon (edits and seeks come in bursts). */
export function schedulePreview($: $, delay = 120): void {
  previewTimer?.cancel()
  previewTimer = $.clock.after(delay, () => void renderPreview($).catch(() => undefined))
}

export async function renderPreview($: $, t?: number, width = 640): Promise<{ png: string } | null> {
  const project = (await read($, projectAtom)) as Project | null
  if (!project) return null
  const time = Math.min(t ?? (await read($, viewAtom)).playhead, Math.max(0, projectDuration(project) - 1 / project.fps))
  const gen = ++previewGen
  await update($, previewAtom, p => ({ ...p, isRendering: true }))
  try {
    const { env, dir, job } = await renderJob($)
    const height = Math.max(2, Math.round((width * project.height) / project.width / 2) * 2)
    const slot = gen % 2
    const png = joinPath(dir, 'cache', `preview-${slot}.png`)
    const jpg = joinPath(dir, 'cache', `preview-${slot}.jpg`)
    const args = frameArgs({ ...job, width, height }, time, png)
    const r = await $.process.run([env.ffmpeg, ...args], { timeoutMs: 60000 })
    if (r.exitCode !== 0) throw new UserError(explainFfmpeg(r.stderr))
    // A small JPEG for the desktop, whose Svg markup is capped at 131072 characters.
    let jpeg: string | null = null
    for (const q of [5, 9, 14]) {
      const j = await $.process.run([env.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', png, '-vf', 'scale=480:-2', '-q:v', String(q), jpg], { timeoutMs: 30000 })
      if (j.exitCode !== 0) break
      const { base64 } = (await $.fs.read(jpg, { as: 'bytes' })) as { base64: string }
      if (base64.length < 120000) {
        jpeg = base64
        break
      }
    }
    if (gen !== previewGen) return { png }
    await update($, previewAtom, () => ({ time, png, jpeg, width, height, isRendering: false, error: null }))
    return { png }
  } catch (e) {
    if (gen === previewGen) await update($, previewAtom, p => ({ ...p, isRendering: false, error: (e as Error).message }))
    throw e
  }
}

/** Render one full-size PNG for Claude to look at with its Read tool. */
export async function renderStill($: $, time: number): Promise<string> {
  const { env, project, dir, job } = await renderJob($)
  const t = Math.min(Math.max(0, time), Math.max(0, projectDuration(project) - 1 / project.fps))
  const out = joinPath(dir, 'cache', `frame-${Math.round(t * 1000)}.png`)
  const w = Math.min(1280, project.width)
  const h = Math.round((w * project.height) / project.width / 2) * 2
  const r = await $.process.run([env.ffmpeg, ...frameArgs({ ...job, width: w, height: h }, t, out)], { timeoutMs: 120000 })
  if (r.exitCode !== 0) throw new UserError(explainFfmpeg(r.stderr))
  return out
}

// -------------------------------------------------------------- export

export function defaultExportPath(project: Project, dir: string): string {
  return joinPath(dir, 'exports', `${slug(project.name)}.mp4`)
}

let exportAbort: AbortController | null = null

/**
 * Render the timeline to MP4. Asks before replacing an existing file.
 * Resolves with the output path once FFmpeg has finished successfully.
 */
export async function exportMp4(
  $: $,
  o: { output?: string; height?: number; quality?: 'high' | 'medium' | 'draft'; overwrite?: boolean; start?: number; end?: number },
  origin: FrameLogEntry['origin'],
): Promise<{ output: string; seconds: number }> {
  const running = await read($, jobAtom)
  if (running?.isRunning) throw new UserError('An export is already running.')
  const { env, project, dir, job } = await renderJob($)
  if (!env.hasX264) throw new UserError('Your FFmpeg has no H.264 encoder (libx264). Install a full build, e.g. `winget install Gyan.FFmpeg`.')
  const output = o.output?.trim() || defaultExportPath(project, dir)
  if (!output.toLowerCase().endsWith('.mp4')) throw new UserError('The export file name must end in .mp4.')
  if (await $.fs.exists(output)) {
    if (!o.overwrite) {
      const answer = await $.ui.ask(`${baseName(output)} already exists. Replace it?`, ['Replace it', 'Keep the old file']).catch(() => null)
      if (answer === null) throw new UserError(`Export not started: ${output} already exists, and the replace question was dismissed or could not be shown. Pass overwrite only if the person said to replace it.`)
      if (answer !== 'Replace it') throw new UserError(`Export cancelled: the person chose to keep ${output}.`)
    }
  }
  const parent = output.replace(/[\\/][^\\/]+$/, '')
  if (parent && parent !== output && !(await $.fs.exists(parent))) {
    // Only the project's own exports folder is created; any other folder must exist.
    if (parent !== joinPath(dir, 'exports')) throw new UserError(`The folder ${parent} does not exist.`)
    await $.fs.write(joinPath(parent, 'README.txt'), 'Videos exported from this FRAME AI project.\n')
  }
  const { args, duration } = exportArgs(job, { output, height: o.height ?? 0, quality: o.quality ?? 'high', start: o.start, end: o.end })
  const started = Date.now()
  await update($, jobAtom, () => ({ label: `Exporting ${baseName(output)}`, fraction: 0, isRunning: true, error: null, output }))
  exportAbort = new AbortController()
  let stderr = ''
  let code: number | null = null
  try {
    const stream = $.process.spawn({ argv: [env.ffmpeg, ...args] })
    let lastWrite = 0
    while (true) {
      const step = await stream.next()
      if (step.done) {
        code = step.value?.code ?? null
        break
      }
      if (exportAbort.signal.aborted) {
        await stream.return?.(undefined as never)
        throw new UserError('Export cancelled.')
      }
      const { stream: which, text } = step.value
      if (which === 'stderr') stderr = (stderr + text).slice(-8000)
      else {
        const t = parseProgress(text)
        if (t !== null && Date.now() - lastWrite > 300) {
          lastWrite = Date.now()
          await update($, jobAtom, j => (j ? { ...j, fraction: Math.min(1, t / duration) } : j))
        }
      }
    }
    if (code !== 0) throw new UserError(explainFfmpeg(stderr || `FFmpeg exited with code ${code}`))
    if (!(await $.fs.exists(output))) throw new UserError('FFmpeg finished but the file was not written.')
    const seconds = Math.round((Date.now() - started) / 100) / 10
    await update($, jobAtom, () => ({ label: `Exported ${baseName(output)}`, fraction: 1, isRunning: false, error: null, output }))
    await log($, `Exported ${output} (${seconds}s)`, origin)
    return { output, seconds }
  } catch (e) {
    const message = (e as Error).message
    await update($, jobAtom, () => ({ label: 'Export failed', fraction: null, isRunning: false, error: message, output }))
    await log($, `Export failed: ${message}`, origin, true)
    throw e
  } finally {
    exportAbort = null
  }
}

export function cancelExport(): void {
  exportAbort?.abort()
}

/** Open a file with the system's default app (the video player for an MP4). */
export async function openWithSystem($: $, path: string): Promise<void> {
  const env = await read($, envAtom)
  const argv = env.isWindows ? ['cmd', '/c', 'start', '', path] : (await $.env.get('HOME'))?.startsWith('/Users/') ? ['open', path] : ['xdg-open', path]
  const r = await $.process.run(argv, { timeoutMs: 15000 }).catch(e => ({ exitCode: 1, stderr: String(e), stdout: '' }))
  if (r.exitCode !== 0) throw new UserError(`Could not open ${path}: ${r.stderr.trim() || 'no default app'}`)
}

// --------------------------------------------------------- subtitles

/** Transcribe the timeline's sound with FFmpeg's whisper filter (FFmpeg 8+ and a local model). */
export async function transcribe($: $, model: string, language: string): Promise<{ start: number; end: number; text: string }[]> {
  const env = await requireFfmpeg($)
  if (!env.hasWhisper) throw new UserError('Your FFmpeg has no whisper filter (it needs FFmpeg 8 built with whisper.cpp). Give the subtitle text instead, and add it with add_subtitles.')
  if (!model) throw new UserError('Set "Whisper model file" in /config to a whisper.cpp ggml model (for example ggml-base.bin).')
  if (!(await $.fs.exists(model))) throw new UserError(`The whisper model ${model} does not exist.`)
  const { project, dir, job } = await renderJob($)
  const wav = joinPath(dir, 'cache', 'mix.wav')
  const srt = joinPath(dir, 'cache', 'transcript.srt')
  const { args } = exportArgs(job, { output: wav, height: 360, quality: 'draft' })
  // Reuse the export graph's audio mix only.
  const graphIdx = args.indexOf('-filter_complex')
  const head = args.slice(0, graphIdx).filter(a => a !== '-progress' && a !== 'pipe:1' && a !== '-nostats')
  const audioArgs = [...head, '-filter_complex', `${args[graphIdx + 1]};[vout]nullsink`, '-map', '[aout]', '-ac', '1', '-ar', '16000', wav]
  if (!args.includes('[aout]')) throw new UserError('The timeline has no sound to transcribe.')
  let r = await $.process.run([env.ffmpeg, ...audioArgs], { timeoutMs: 600000 })
  if (r.exitCode !== 0) throw new UserError(explainFfmpeg(r.stderr))
  const filter = `whisper=model=${model.replace(/\\/g, '/').replace(/:/g, '\\:')}:language=${language || 'auto'}:destination=${srt.replace(/\\/g, '/').replace(/:/g, '\\:')}:format=srt`
  r = await $.process.run([env.ffmpeg, '-hide_banner', '-loglevel', 'error', '-y', '-i', wav, '-af', filter, '-f', 'null', '-'], { timeoutMs: 600000 })
  if (r.exitCode !== 0) throw new UserError(explainFfmpeg(r.stderr))
  const cues = parseSrt(await $.fs.read(srt))
  void project
  return cues
}

export async function summary($: $) {
  const { project } = await requireProject($)
  const view = await read($, viewAtom)
  return describeProject(project, { playhead: view.playhead, selection: view.selection ? [view.selection] : [], missing: await read($, missingAtom) })
}

// ------------------------------------------------- accessors for other files
// The state scanner reads each atom where it is declared, so other files reach
// the session's values through these.
type Updater<T> = (v: T) => T
export async function getProject($: $) {
  return (await read($, projectAtom)) as Project | null
}
export function getDir($: $) {
  return read($, dirAtom)
}
export function getMissing($: $) {
  return read($, missingAtom)
}
export function getHistory($: $) {
  return read($, historyAtom)
}
export function getView($: $) {
  return read($, viewAtom)
}
export function setView($: $, fn: Updater<FrameView>) {
  return update($, viewAtom, fn)
}
export function getEnv($: $) {
  return read($, envAtom)
}
export function getPreview($: $) {
  return read($, previewAtom)
}
export function getJob($: $) {
  return read($, jobAtom)
}
export function getLog($: $) {
  return read($, logAtom)
}
export function getChat($: $) {
  return read($, chatAtom)
}
export function setChat($: $, fn: Updater<{ isWaiting: boolean; sent: { at: string; text: string }[] }>) {
  return update($, chatAtom, fn)
}
export function getDraft($: $) {
  return read($, draftAtom)
}
export function setDraft($: $, fn: Updater<{ projectName: string; importPath: string; exportPath: string; quality: 'high' | 'medium' | 'draft'; height: number }>) {
  return update($, draftAtom, fn)
}
