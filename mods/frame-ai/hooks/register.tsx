import type { EngineInterface, Register } from 'claude-code'

import { checkEnv, edit, exportMp4, getPreview, getProject, getView, importMedia, newProject, openProject, type Options, requireProject, schedulePreview, setChat, setView } from './engine'
import { clipEnd, type Project, projectDuration, round } from './model'
import { drawPane, lastColumns, PANE, secondsPerCol, timelineProps } from './pane'
import { PROMPT_SECTION, runTool, TOOLS } from './tools'

type $ = EngineInterface

async function openPane($: $): Promise<void> {
  const opened = await $.ui.open({ id: PANE, title: 'FRAME AI' }).catch(() => null)
  if (opened && !opened.isPlaced) $.ui.log(`FRAME AI pane is waiting for room: ${opened.reason}`, { to: 'debug' })
}

export const register: Register = (on, options) => {
  const o = options as unknown as Options
  let playTimer: { cancel: () => void } | null = null
  let lastTick = 0

  on('session.start', async ($, e, next) => {
    const started = await next(e)
    await $.command.register({
      name: 'frame',
      description: 'FRAME AI video editor: open the pane, or new <name>, open <folder>, import <path>, export',
      argumentHint: '[new <name> | open <folder> | import <path> | export]',
    })
    for (const tool of TOOLS) await $.tool.register({ ...tool, isDeferred: false })
    const env = await checkEnv($, o)
    // Reopen the last project of the previous session, if it is still there.
    const last = (await $.store.get('lastProject')) as string | undefined
    if (!(await getProject($)) && last && !env.error) await openProject($, last).catch(() => undefined)
    if (await getProject($)) schedulePreview($, 0)
    // Playback: advance the playhead in real time and refresh the frame when FFmpeg is free.
    playTimer?.cancel()
    playTimer = $.clock.every(250, () => {
      void (async () => {
        const view = await getView($)
        const now = Date.now()
        const dt = lastTick ? (now - lastTick) / 1000 : 0
        lastTick = now
        if (!view.isPlaying) {
          lastTick = 0
          return
        }
        const p = (await getProject($))
        if (!p) return
        const total = projectDuration(p)
        const t = Math.min(total, view.playhead + dt)
        await setView($, v => ({ ...v, playhead: round(t), isPlaying: t < total }))
        if (!(await getPreview($)).isRendering) schedulePreview($, 0)
      })().catch(() => undefined)
    })
    return started
  })

  on('command.run', { command: 'frame' }, async ($, e) => {
    const args = (e.args ?? '').trim()
    const [verb, ...rest] = args.split(/\s+/)
    const arg = rest.join(' ').replace(/^["']|["']$/g, '')
    try {
      await openPane($)
      if (!verb) return { text: 'FRAME AI is open.' }
      if (verb === 'new') {
        const dir = await newProject($, arg || 'Untitled')
        return { text: `Created project in ${dir}.` }
      }
      if (verb === 'open') {
        const r = await openProject($, arg)
        return { text: `Opened ${r.project.name}.${r.missing.length ? ` ${r.missing.length} media file(s) are missing.` : ''}` }
      }
      if (verb === 'import') {
        const r = await importMedia($, [arg], 'you')
        return { text: `Imported ${r.added.length} file(s).${r.errors.length ? ` Not imported: ${r.errors.join('; ')}` : ''}` }
      }
      if (verb === 'export') {
        const r = await exportMp4($, {}, 'you')
        return { text: `Exported ${r.output} in ${r.seconds}s.` }
      }
      return { text: 'Usage: /frame [new <name> | open <folder> | import <path> | export]' }
    } catch (err) {
      return { text: `FRAME AI: ${(err as Error).message}` }
    }
  })

  for (const tool of TOOLS) {
    on('tool.call', { tool: `mcp__frame-ai__${tool.name}` }, async ($, e) => {
      const { tool: _t, tool_use_id: _id, ...input } = e as unknown as Record<string, unknown>
      void _t
      void _id
      try {
        void openPane($)
        const text = await runTool($, tool.name, input, o)
        return { result: text }
      } catch (err) {
        return { deny: `FRAME AI: ${(err as Error).message}` }
      }
    }).catch(() => ({ deny: 'FRAME AI: the tool failed unexpectedly; nothing was reported as done.' }))
  }

  // Tell Claude how to use the editor while a project is open.
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    const project = (await getProject($))
    const text = project
      ? `${PROMPT_SECTION}\nOpen project: "${project.name}", ${project.clips.length} clips, ${round(projectDuration(project))}s.`
      : `${PROMPT_SECTION}\nNo project is open yet: create one with new_project when the person wants to edit a video.`
    return { sections: [...composed.sections, { id: 'frame-ai:editor', text, scope: 'session' }] }
  })

  on('turn.complete', async ($, e, next) => {
    await setChat($, c => (c.isWaiting ? { ...c, isWaiting: false } : c))
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, ($, e) => drawPane($, e))

  // What the person did on the timeline (timeline.tsx posts it).
  on('ui.message', { requestId: PANE }, async ($, e, next) => {
    const msg = e.data as { type?: string; clipId?: string | null; col?: number; dCols?: number; mode?: string; trackId?: string | null }
    try {
      const { project } = await requireProject($)
      const view = await getView($)
      const props = timelineProps(project, view, lastColumns)
      const spc = secondsPerCol(view, project, props.laneWidth)
      const selected = project.clips.find(c => c.id === view.selection)
      switch (msg?.type) {
        case 'seek':
          await setView($, v => ({ ...v, playhead: Math.max(0, round(view.scroll + (msg.col ?? 0) * spc)) }))
          schedulePreview($, 0)
          break
        case 'select':
          await setView($, v => ({ ...v, selection: msg.clipId ?? null, tab: msg.clipId ? 'clip' : v.tab }))
          break
        case 'drag': {
          const c = project.clips.find(x => x.id === msg.clipId)
          if (!c) break
          const dt = (msg.dCols ?? 0) * spc
          if (msg.mode === 'move') {
            const target = msg.trackId && project.tracks.find(t => t.id === msg.trackId)
            const trackId = target && (target.kind === 'audio') === (c.kind === 'audio') ? target.id : undefined
            await edit($, { op: 'moveClip', clipId: c.id, start: Math.max(0, c.start + dt), trackId }, 'you', `Moved ${c.id}`)
          } else if (msg.mode === 'start') await edit($, { op: 'trimClip', clipId: c.id, edge: 'start', time: c.start + dt }, 'you', `Trimmed ${c.id}`)
          else await edit($, { op: 'trimClip', clipId: c.id, edge: 'end', time: clipEnd(c) + dt }, 'you', `Trimmed ${c.id}`)
          break
        }
        case 'nudge':
          if (selected) await edit($, { op: 'moveClip', clipId: selected.id, start: Math.max(0, selected.start + (msg.dCols ?? 0) * spc) }, 'you')
          break
        case 'delete':
          if (selected) await edit($, { op: 'deleteClips', clipIds: [selected.id] }, 'you', 'Deleted a clip')
          break
        case 'split':
          if (selected) await edit($, { op: 'splitClip', clipId: selected.id, time: view.playhead }, 'you', 'Split a clip')
          break
        case 'play':
          await setView($, v => ({ ...v, isPlaying: !v.isPlaying }))
          break
      }
    } catch (err) {
      $.ui.toast((err as Error).message, { timeoutMs: 6000 })
    }
    return next(e)
  })
}
