/**
 * The tools Claude edits the timeline with. Each handler validates its input,
 * runs the real edit or render, and answers with what actually changed; a
 * failure is reported as an error, never as success.
 */
import type { EngineInterface, ToolSpec } from 'claude-code'

import { edit, exportMp4, getEnv, importMedia, listProjects, newProject, openProject, type Options, relinkMedia, renderStill, requireProject, setView, summary, transcribe, undoRedo } from './engine'
import { clipEnd, type Edit, formatTime, projectDuration, round } from './model'

type $ = EngineInterface

const num = { type: 'number' }
const str = { type: 'string' }
const textProps = {
  content: { ...str, description: 'The words to show. Use \\n for a new line.' },
  size: { ...num, description: 'Font size in project pixels (1080p frame). Titles ~90-140, subtitles ~50.' },
  color: { ...str, description: 'Hex color like #ffffff.' },
  position: { type: 'string', enum: ['top', 'center', 'bottom', 'lower-third'] },
  box: { type: 'boolean', description: 'Draw a dark box behind the text (good for subtitles).' },
  animation: { type: 'string', enum: ['none', 'fade', 'slide-up'] },
}

export const TOOLS: ToolSpec[] = [
  {
    name: 'get_project',
    description:
      'Read the open FRAME AI video project: media (ids, durations), tracks and every clip with its id, start and end in seconds, plus playhead and selection. Call this before editing and after edits to confirm the result. How to edit with the mcp__frame-ai__* tools: times are timeline seconds; "cut the first two seconds" is cut_range 0..2; titles use add_text; check visual results with render_frame and Read the PNG; report only what the tools say happened, and when a tool fails say so and why.',
  },
  {
    name: 'list_projects',
    description: 'List saved FRAME AI projects (name and folder).',
  },
  {
    name: 'new_project',
    description: 'Create and open a new, empty FRAME AI project.',
    inputSchema: { type: 'object', properties: { name: str, aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] } }, required: ['name'] },
  },
  {
    name: 'open_project',
    description: 'Open a saved project by its folder (from list_projects) or its project.json path.',
    inputSchema: { type: 'object', properties: { path: str }, required: ['path'] },
  },
  {
    name: 'import_media',
    description: 'Import local video, image or audio files (or every media file in a folder) into the media library. Files are referenced, never modified. Returns the new media ids.',
    inputSchema: { type: 'object', properties: { paths: { type: 'array', items: str } }, required: ['paths'] },
  },
  {
    name: 'relink_media',
    description: 'Point a missing media item at its file in a new location.',
    inputSchema: { type: 'object', properties: { mediaId: str, path: str }, required: ['mediaId', 'path'] },
  },
  {
    name: 'add_clip',
    description:
      'Place a media item on the timeline. Without start it goes right after the existing clips. sourceIn/duration pick the part of the source to use (seconds). track is a track id like V1 or A1 (optional).',
    inputSchema: { type: 'object', properties: { mediaId: str, start: num, sourceIn: num, duration: num, track: str }, required: ['mediaId'] },
  },
  {
    name: 'add_text',
    description: 'Add a title or text overlay on a video track above the footage.',
    inputSchema: {
      type: 'object',
      properties: { ...textProps, start: num, duration: num, fadeIn: num, fadeOut: num, track: str },
      required: ['content'],
    },
  },
  {
    name: 'update_clip',
    description:
      'Change a clip: timing (start, duration, sourceIn), look (opacity 0-1, scale, x/y offset in project pixels), sound (volume 0-2), fades in seconds, track, or a text clip\'s text settings.',
    inputSchema: {
      type: 'object',
      properties: {
        clipId: str,
        start: num,
        duration: num,
        sourceIn: num,
        opacity: num,
        scale: num,
        x: num,
        y: num,
        volume: num,
        fadeIn: num,
        fadeOut: num,
        track: str,
        text: { type: 'object', properties: textProps },
      },
      required: ['clipId'],
    },
  },
  {
    name: 'move_clip',
    description: 'Move a clip to a start time, or insert it right after (afterClipId) or right before (beforeClipId) another clip on its track; the other clips shift so nothing overlaps.',
    inputSchema: { type: 'object', properties: { clipId: str, start: num, afterClipId: str, beforeClipId: str, track: str }, required: ['clipId'] },
  },
  {
    name: 'trim_clip',
    description: 'Move one edge of a clip to a timeline time (seconds). Trimming the start also moves the source in-point.',
    inputSchema: { type: 'object', properties: { clipId: str, edge: { type: 'string', enum: ['start', 'end'] }, time: num }, required: ['clipId', 'edge', 'time'] },
  },
  {
    name: 'split_clip',
    description: 'Split a clip in two at a timeline time.',
    inputSchema: { type: 'object', properties: { clipId: str, time: num }, required: ['clipId', 'time'] },
  },
  {
    name: 'cut_range',
    description:
      'Remove everything between start and end seconds on all tracks (e.g. "cut the first two seconds" is start 0, end 2). ripple (default true) closes the gap. The person is asked to confirm.',
    inputSchema: { type: 'object', properties: { start: num, end: num, ripple: { type: 'boolean' } }, required: ['start', 'end'] },
  },
  {
    name: 'delete_clips',
    description: 'Delete clips by id. The person is asked to confirm.',
    inputSchema: { type: 'object', properties: { clipIds: { type: 'array', items: str } }, required: ['clipIds'] },
  },
  {
    name: 'add_subtitles',
    description: 'Add subtitles as timed text cues (seconds) on their own track. Use the transcript the person gave, or the output of transcribe_audio.',
    inputSchema: {
      type: 'object',
      properties: { cues: { type: 'array', items: { type: 'object', properties: { start: num, end: num, text: str }, required: ['start', 'end', 'text'] } } },
      required: ['cues'],
    },
  },
  {
    name: 'transcribe_audio',
    description:
      'Transcribe the timeline\'s sound locally and return timed cues (needs FFmpeg 8 with the whisper filter and a model file set in /config). Then add them with add_subtitles. Fails with the reason when unavailable.',
    inputSchema: { type: 'object', properties: { language: { ...str, description: 'e.g. en, he, auto' } } },
  },
  {
    name: 'set_format',
    description: 'Change the project aspect ratio (16:9, 9:16, 1:1) or frame rate.',
    inputSchema: { type: 'object', properties: { aspect: { type: 'string', enum: ['16:9', '9:16', '1:1'] }, fps: num } },
  },
  { name: 'undo', description: 'Undo the last edit.' },
  { name: 'redo', description: 'Redo the last undone edit.' },
  {
    name: 'render_frame',
    description: 'Render the composition at a time (seconds) to a PNG file and return its path. Read that file to see the frame and check your edit.',
    inputSchema: { type: 'object', properties: { time: num }, required: ['time'] },
  },
  {
    name: 'export_mp4',
    description:
      'Render the timeline to an MP4 file with FFmpeg and return the path when it is done. height: 0 = project size, or 1080/720/480. If the file exists the person is asked before it is replaced.',
    inputSchema: {
      type: 'object',
      properties: {
        output: { ...str, description: 'Path ending in .mp4; default is the project\'s exports folder.' },
        height: num,
        quality: { type: 'string', enum: ['high', 'medium', 'draft'] },
        overwrite: { type: 'boolean', description: 'Replace an existing file without asking. Only when the person explicitly said to replace it.' },
      },
    },
  },
]

type Input = Record<string, unknown>

function n(v: unknown, name: string): number {
  if (typeof v !== 'number' || !isFinite(v)) throw new Error(`${name} must be a number of seconds.`)
  return v
}

function opt(v: unknown): number | undefined {
  return typeof v === 'number' && isFinite(v) ? v : undefined
}

/** Ask the person; throws a clear reason unless they said yes. */
async function confirm($: $, question: string, options: Options): Promise<void> {
  if (options.askBeforeDestructive === false) return
  const answer = await $.ui.ask(question, ['Yes, do it', 'No']).catch(() => null)
  if (answer === null) throw new Error('Nothing was changed: the confirmation was dismissed or could not be shown (no one to ask in a headless run).')
  if (answer !== 'Yes, do it') throw new Error('Nothing was changed: the person said no.')
}

/** Run one tool; returns the text Claude reads. Throws on failure. */
export async function runTool($: $, name: string, input: Input, options: Options): Promise<string> {
  const origin = 'claude' as const
  switch (name) {
    case 'get_project':
      return JSON.stringify(await summary($), null, 1)
    case 'list_projects': {
      const list = await listProjects($)
      return list.length ? list.map(p => `${p.name} — ${p.dir}`).join('\n') : `No projects yet in ${(await getEnv($)).projectsDir}.`
    }
    case 'new_project': {
      const dir = await newProject($, String(input.name ?? 'Untitled'), (input.aspect as '16:9') ?? '16:9')
      return `Created and opened project "${input.name}" in ${dir}.`
    }
    case 'open_project': {
      const r = await openProject($, String(input.path ?? ''))
      return `Opened "${r.project.name}" (${r.project.clips.length} clips).${r.missing.length ? ` Missing media: ${r.missing.join(', ')}` : ''}`
    }
    case 'import_media': {
      const paths = Array.isArray(input.paths) ? input.paths.map(String) : []
      if (!paths.length) throw new Error('Give at least one file or folder path.')
      const r = await importMedia($, paths, origin)
      const lines = r.added.map(m => `${m.id}: ${m.name} (${m.kind}${m.duration ? `, ${m.duration}s` : ''}${m.width ? `, ${m.width}x${m.height}` : ''})`)
      if (!r.added.length) throw new Error(`Nothing was imported. ${r.errors.join('; ')}`)
      return `Imported ${r.added.length} file(s):\n${lines.join('\n')}${r.errors.length ? `\nNot imported: ${r.errors.join('; ')}` : ''}`
    }
    case 'relink_media':
      await relinkMedia($, String(input.mediaId), String(input.path), origin)
      return `Relinked ${input.mediaId} to ${input.path}.`
    case 'add_clip': {
      const r = await edit(
        $,
        { op: 'addClip', mediaId: String(input.mediaId), start: opt(input.start), sourceIn: opt(input.sourceIn), duration: opt(input.duration), trackId: input.track as string | undefined },
        origin,
        'Added a clip',
      )
      const { project } = await requireProject($)
      const c = project.clips.find(x => x.id === r.clipIds?.[0])!
      return `Added clip ${c.id} on ${c.trackId} from ${c.start}s to ${round(clipEnd(c))}s.`
    }
    case 'add_text': {
      const { start, duration, fadeIn, fadeOut, track, ...text } = input
      const r = await edit(
        $,
        { op: 'addText', text: text as { content: string }, start: opt(start), duration: opt(duration), fadeIn: opt(fadeIn), fadeOut: opt(fadeOut), trackId: track as string | undefined },
        origin,
        `Added text "${String(text.content).slice(0, 40)}"`,
      )
      const { project } = await requireProject($)
      const c = project.clips.find(x => x.id === r.clipIds?.[0])!
      return `Added text clip ${c.id} on ${c.trackId} from ${c.start}s to ${round(clipEnd(c))}s.`
    }
    case 'update_clip': {
      const { clipId, track, text, ...rest } = input
      const patch: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(rest)) if (v !== undefined) patch[k] = v
      if (track) patch.trackId = track
      if (text) patch.text = text
      await edit($, { op: 'updateClip', clipId: String(clipId), patch }, origin, `Changed clip ${clipId}`)
      const { project } = await requireProject($)
      const c = project.clips.find(x => x.id === clipId)!
      return `Updated ${c.id}: ${c.start}s to ${round(clipEnd(c))}s on ${c.trackId}.`
    }
    case 'move_clip': {
      await edit(
        $,
        { op: 'moveClip', clipId: String(input.clipId), start: opt(input.start), afterClipId: input.afterClipId as string | undefined, beforeClipId: input.beforeClipId as string | undefined, trackId: input.track as string | undefined },
        origin,
        `Moved clip ${input.clipId}`,
      )
      const { project } = await requireProject($)
      const c = project.clips.find(x => x.id === input.clipId)!
      return `Clip ${c.id} now runs ${c.start}s to ${round(clipEnd(c))}s on ${c.trackId}.`
    }
    case 'trim_clip': {
      await edit($, { op: 'trimClip', clipId: String(input.clipId), edge: input.edge === 'start' ? 'start' : 'end', time: n(input.time, 'time') }, origin, `Trimmed clip ${input.clipId}`)
      const { project } = await requireProject($)
      const c = project.clips.find(x => x.id === input.clipId)!
      return `Clip ${c.id} now runs ${c.start}s to ${round(clipEnd(c))}s (source from ${c.sourceIn ?? 0}s).`
    }
    case 'split_clip': {
      const r = await edit($, { op: 'splitClip', clipId: String(input.clipId), time: n(input.time, 'time') }, origin, `Split clip ${input.clipId}`)
      return `Split into ${r.clipIds?.join(' and ')}.`
    }
    case 'cut_range': {
      const start = n(input.start, 'start')
      const end = n(input.end, 'end')
      const ripple = input.ripple !== false
      await confirm($, `Remove ${formatTime(start)} to ${formatTime(end)} from the timeline${ripple ? ' and close the gap' : ''}?`, options)
      const r = await edit($, { op: 'deleteRange', start, end, ripple }, origin, `Cut ${start}s to ${end}s`)
      const { project } = await requireProject($)
      return `Removed ${end - start}s (${r.clipIds?.length ?? 0} clip part(s) deleted). The timeline is now ${round(projectDuration(project))}s.`
    }
    case 'delete_clips': {
      const ids = Array.isArray(input.clipIds) ? input.clipIds.map(String) : []
      if (!ids.length) throw new Error('Give the ids of the clips to delete.')
      await confirm($, `Delete ${ids.length} clip(s) from the timeline?`, options)
      await edit($, { op: 'deleteClips', clipIds: ids }, origin, `Deleted ${ids.length} clip(s)`)
      return `Deleted ${ids.join(', ')}.`
    }
    case 'add_subtitles': {
      const cues = (Array.isArray(input.cues) ? input.cues : []) as { start: number; end: number; text: string }[]
      const r = await edit($, { op: 'addSubtitles', cues }, origin, `Added ${cues.length} subtitle(s)`)
      return `Added ${r.clipIds?.length ?? 0} subtitle clips on track ${r.trackId}.`
    }
    case 'transcribe_audio': {
      const cues = await transcribe($, options.whisperModel, String(input.language ?? 'auto'))
      return cues.length ? JSON.stringify(cues) : 'The transcription found no speech.'
    }
    case 'set_format': {
      const e: Edit = { op: 'setFormat', aspect: input.aspect as '16:9' | undefined, fps: opt(input.fps) }
      await edit($, e, origin, 'Changed the format')
      const { project } = await requireProject($)
      return `Format is now ${project.width}x${project.height} (${project.aspect}) at ${project.fps} fps.`
    }
    case 'undo':
      return (await undoRedo($, 'undo', origin)) ? 'Undid the last edit.' : 'Nothing to undo.'
    case 'redo':
      return (await undoRedo($, 'redo', origin)) ? 'Redid the edit.' : 'Nothing to redo.'
    case 'render_frame': {
      const t = n(input.time, 'time')
      const path = await renderStill($, t)
      await setView($, v => ({ ...v, playhead: t }))
      return `Rendered the frame at ${t}s to ${path}. Read it to see it.`
    }
    case 'export_mp4': {
      const r = await exportMp4(
        $,
        { output: input.output as string | undefined, height: opt(input.height), quality: input.quality as 'high' | undefined, overwrite: options.askBeforeDestructive === false || input.overwrite === true },
        origin,
      )
      return `Exported ${r.output} in ${r.seconds}s.`
    }
  }
  throw new Error(`Unknown FRAME AI tool ${name}.`)
}

export const PROMPT_SECTION = `FRAME AI video editor (a mod in this session). The person edits a video in the FRAME AI pane and asks you to edit it in plain words. Use the mcp__frame-ai__* tools: get_project first to learn ids and times, then the edit tools, then get_project or render_frame (and Read the PNG) to check the result. Report only what the tools say happened; if a tool fails, say so and why. Times are seconds on the timeline. "Cut the first two seconds" is cut_range 0..2. "After the second clip" means after the second clip by start time on the main video track. Titles go on a video track above the footage (add_text). Ask before large destructive changes the person did not ask for; cut_range, delete_clips and replacing an export already ask the person. For subtitles synced to the audio use transcribe_audio when available; otherwise ask for the words. export_mp4 renders a real file; tell the person its path.`
