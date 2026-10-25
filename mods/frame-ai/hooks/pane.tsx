/**
 * The FRAME AI pane: header, preview, transport, timeline and a tabbed area
 * for the selected clip, the media library, the conversation with Claude and
 * export. Drawn from $.state; every control calls into engine.ts.
 */
import type { EngineInterface, RenderElement } from 'claude-code'

import type { FrameTab, FrameView } from '../types'
import { cancelExport, defaultExportPath, edit, exportMp4, getChat, getDir, getDraft, getEnv, getHistory, getJob, getLog, getMissing, getPreview, getProject, getView, importMedia, listProjects, newProject, openProject, openWithSystem, schedulePreview, setChat, setDraft, setView, undoRedo } from './engine'
import { type Clip, clipEnd, formatTime, parseTime, type Project, projectDuration, round } from './model'
import type { TimelineProps } from './timeline'

type $ = EngineInterface
// Elements differ per surface; this pane checks for the optional ones before drawing them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type El = (props: any) => RenderElement
type Els = { Box: El; Text: El; Button: El; Input?: El; Select?: El; Svg?: El; Image?: El; Client?: El }

export const PANE = 'frame-ai'
/** Width the timeline was last drawn at, so mouse columns map back to seconds. */
export let lastColumns = 80
const LABEL = 9

export const SUGGESTIONS = [
  'Cut the first two seconds.',
  'Add a title at the beginning.',
  'Put the last clip after the second clip.',
  'Create a cinematic sequence from the imported footage.',
]

function toast($: $, e: unknown) {
  $.ui.toast((e as Error).message ?? String(e), { timeoutMs: 6000 })
}

/** Run a press handler, turning a failure into a toast. */
function act($: $, fn: () => Promise<unknown>) {
  return () => void fn().catch(e => toast($, e))
}

export function secondsPerCol(view: FrameView, p: Project, laneWidth: number): number {
  if (view.zoom > 0) return view.zoom
  return Math.max(projectDuration(p) + 2, 10) / Math.max(10, laneWidth)
}

export function timelineProps(p: Project, view: FrameView, columns: number): TimelineProps {
  const laneWidth = Math.max(10, columns - LABEL - 1)
  const spc = secondsPerCol(view, p, laneWidth)
  const col = (t: number) => Math.round((t - view.scroll) / spc)
  const rows = p.tracks.map(t => ({
    id: t.id,
    label: t.id,
    kind: t.kind,
    isMuted: !!t.muted,
    isHidden: !!t.hidden,
    clips: p.clips
      .filter(c => c.trackId === t.id)
      .map(c => {
        const from = col(c.start)
        const to = Math.max(from + 1, col(clipEnd(c)))
        const media = p.media.find(m => m.id === c.mediaId)
        return { id: c.id, col: from, width: to - from, name: c.text?.content.split('\n')[0] ?? media?.name ?? c.kind, kind: c.kind, isSelected: c.id === view.selection }
      })
      .filter(c => c.col + c.width > 0 && c.col < laneWidth),
  }))
  // Ruler: a label every ~10 columns, the playhead as '|'.
  const cells = Array<string>(laneWidth).fill(' ')
  const step = Math.max(1, Math.ceil((spc * 10) / 1)) // seconds between labels
  for (let s = Math.ceil(view.scroll / step) * step; ; s += step) {
    const c = col(s)
    if (c >= laneWidth) break
    const label = `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`
    for (let i = 0; i < label.length && c + i < laneWidth; i++) if (c + i >= 0) cells[c + i] = label[i] ?? ' '
  }
  const ph = col(view.playhead)
  const playheadCol = ph >= 0 && ph < laneWidth ? ph : null
  if (playheadCol !== null) cells[playheadCol] = '|'
  return { labelWidth: LABEL, laneWidth, ruler: cells.join(''), playheadCol, rows }
}

function bar(fraction: number, width = 24): string {
  const n = Math.round(Math.max(0, Math.min(1, fraction)) * width)
  return `[${'#'.repeat(n)}${'-'.repeat(width - n)}] ${Math.round(fraction * 100)}%`
}

async function welcome($: $, T: Els, columns: number): Promise<RenderElement> {
  const { Box, Text, Button, Input } = T
  const env = await getEnv($)
  const draft = await getDraft($)
  const projects = env.isChecked ? await listProjects($) : []
  return (
    <Box flexDirection="column" gap={1}>
      <Text weight="bold" size="heading">FRAME AI</Text>
      <Text dimColor>Edit video beside Claude. Create a project, import files, then ask for edits.</Text>
      {!env.isChecked ? (
        <Text dimColor>Checking FFmpeg…</Text>
      ) : env.error ? (
        <Text color="#ff6464">{env.error}</Text>
      ) : (
        <Text color="#4cd08a">
          FFmpeg {env.ffmpegVersion}
          {env.hasX264 ? '' : ' (no H.264 encoder: MP4 export unavailable)'}
        </Text>
      )}
      {Input ? (
        <Input
          key="new-project"
          label="New project"
          placeholder="Project name, then Enter"
          value={draft.projectName}
          submitLabel="Create"
          onSubmit={(v: string) =>
            act($, async () => {
              await newProject($, v || 'Untitled')
              await setDraft($, d => ({ ...d, projectName: '' }))
            })()
          }
        />
      ) : (
        <Button key="new-project" label="New project" variant="primary" onPress={act($, () => newProject($, 'Untitled'))} />
      )}
      {projects.length > 0 && <Text dimColor>Recent projects</Text>}
      {projects.slice(0, 8).map(p => (
        <Button key={`open-${p.dir}`} plain onPress={act($, () => openProject($, p.dir))}>
          {p.name} <Text dimColor>{p.dir.length > columns - p.name.length - 4 ? '…' + p.dir.slice(-(columns - p.name.length - 6)) : p.dir}</Text>
        </Button>
      ))}
      <Text dimColor>Or type /frame new My Video, or just ask Claude.</Text>
    </Box>
  )
}

async function preview($: $, T: Els, surface: string, p: Project, columns: number): Promise<RenderElement> {
  const { Box, Text, Svg, Image } = T
  const pv = await getPreview($)
  const status = pv.error ? <Text color="#ff6464">{pv.error}</Text> : pv.isRendering ? <Text dimColor>Rendering frame…</Text> : null
  if (p.clips.length === 0) return <Text dimColor>Nothing on the timeline yet. Import media in the Media tab, or ask Claude.</Text>
  if (Svg && pv.jpeg) {
    const w = 480
    const h = Math.round((w * p.height) / p.width)
    const src = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#000"/><image width="${w}" height="${h}" href="data:image/jpeg;base64,${pv.jpeg}" xlink:href="data:image/jpeg;base64,${pv.jpeg}"/></svg>`
    const shown = Math.min(w, Math.max(160, columns * 7))
    return (
      <Box flexDirection="column">
        <Svg source={src} alt={`Frame at ${formatTime(pv.time, p.fps)}`} width={shown} height={Math.round((shown * p.height) / p.width)} />
        {status}
      </Box>
    )
  }
  if (Image && pv.png && surface === 'terminal') {
    const cols = Math.min(columns, 64)
    const rows = Math.max(4, Math.round((cols * p.height) / p.width / 2))
    return (
      <Box flexDirection="column">
        <Image key="preview" source={{ file: pv.png, format: 'png' }} columns={cols} rows={rows} alt={`Preview frame at ${formatTime(pv.time, p.fps)}: ${pv.png}`} />
        {status}
      </Box>
    )
  }
  return (
    <Box flexDirection="column">
      <Text dimColor>{pv.png ? `Frame at ${formatTime(pv.time, p.fps)}: ${pv.png}` : 'No frame rendered yet.'}</Text>
      {status}
    </Box>
  )
}

async function transport($: $, T: Els, p: Project): Promise<RenderElement> {
  const { Box, Text, Button } = T
  const view = await getView($)
  const total = projectDuration(p)
  const seek = (t: number) => act($, async () => {
    await setView($, v => ({ ...v, playhead: Math.max(0, Math.min(total, round(t))) }))
    schedulePreview($, 0)
  })
  const laneZoom = (factor: number) => act($, async () => {
    await setView($, v => {
      const base = v.zoom > 0 ? v.zoom : Math.max(total + 2, 10) / 60
      return { ...v, zoom: Math.max(0.02, Math.min(60, base * factor)) }
    })
  })
  return (
    <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
      <Button key="t-start" label="|<" onPress={seek(0)} />
      <Button key="t-back" label="-1s" onPress={seek(view.playhead - 1)} />
      <Button key="t-frame-back" label="-1f" onPress={seek(view.playhead - 1 / p.fps)} />
      <Button
        key="t-play"
        variant="primary"
        label={view.isPlaying ? 'Pause' : 'Play'}
        onPress={act($, () => setView($, v => ({ ...v, isPlaying: !v.isPlaying, playhead: !v.isPlaying && v.playhead >= total ? 0 : v.playhead })))}
      />
      <Button key="t-frame" label="+1f" onPress={seek(view.playhead + 1 / p.fps)} />
      <Button key="t-fwd" label="+1s" onPress={seek(view.playhead + 1)} />
      <Button key="t-end" label=">|" onPress={seek(total)} />
      <Text tabular mono>
        {formatTime(view.playhead, p.fps)} / {formatTime(total, p.fps)}
      </Text>
      <Button key="z-out" label="Zoom -" onPress={laneZoom(1.5)} />
      <Button key="z-in" label="Zoom +" onPress={laneZoom(1 / 1.5)} />
      <Button key="z-fit" label="Fit" onPress={act($, () => setView($, v => ({ ...v, zoom: 0, scroll: 0 })))} />
    </Box>
  )
}

function timelineFallback(T: Els, $: $, props: TimelineProps): RenderElement {
  // Surfaces without Client (VS Code, mobile): clips as buttons, one row per track.
  const { Box, Text, Button } = T
  return (
    <Box flexDirection="column">
      {props.rows.map(r => (
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          <Text dimColor>{r.label}</Text>
          {r.clips.length === 0 && <Text dimColor>empty</Text>}
          {r.clips.map(c => (
            <Button key={`sel-${c.id}`} plain variant={c.isSelected ? 'primary' : undefined} onPress={act($, () => setView($, v => ({ ...v, selection: c.id })))}>
              {c.name.slice(0, 18)}
            </Button>
          ))}
        </Box>
      ))}
    </Box>
  )
}

function numberField(T: Els, $: $, key: string, label: string, value: number | undefined, apply: (v: number) => Promise<unknown>, unit = 's'): RenderElement {
  const { Input, Text } = T
  if (!Input) return <Text>{label}: {value ?? '-'}{unit}</Text>
  return (
    <Input
      key={key}
      label={`${label} (${unit})`}
      value={value === undefined ? '' : String(round(value))}
      submitLabel="Set"
      onSubmit={(v: string) =>
        act($, async () => {
          const n = unit === 's' ? parseTime(v) : Number(v)
          if (n === null || !isFinite(n)) throw new Error(`${label}: "${v}" is not a number.`)
          await apply(n)
        })()
      }
    />
  )
}

async function clipTab($: $, T: Els, p: Project): Promise<RenderElement> {
  const { Box, Text, Button, Input, Select } = T
  const view = await getView($)
  const c: Clip | undefined = p.clips.find(x => x.id === view.selection)
  if (!c) return <Text dimColor>Select a clip on the timeline to edit it. Drag a clip to move it, drag its first or last cell to trim, arrow keys nudge, S splits, Delete removes.</Text>
  const patch = (patch: Record<string, unknown>) => edit($, { op: 'updateClip', clipId: c.id, patch }, 'you')
  const media = p.media.find(m => m.id === c.mediaId)
  return (
    <Box flexDirection="column" gap={0}>
      <Text weight="semibold">
        {c.kind === 'text' ? 'Text' : media?.name ?? c.kind} <Text dimColor>{c.id} on {c.trackId}</Text>
      </Text>
      <Text dimColor>
        {formatTime(c.start, p.fps)} to {formatTime(clipEnd(c), p.fps)} ({round(c.duration)}s)
      </Text>
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {numberField(T, $, `start-${c.id}`, 'Start', c.start, v => edit($, { op: 'moveClip', clipId: c.id, start: v }, 'you'))}
        {numberField(T, $, `dur-${c.id}`, 'Duration', c.duration, v => patch({ duration: v }))}
        {c.sourceIn !== undefined && numberField(T, $, `in-${c.id}`, 'Source in', c.sourceIn, v => patch({ sourceIn: v }))}
        {c.kind !== 'audio' && numberField(T, $, `op-${c.id}`, 'Opacity', c.opacity ?? 1, v => patch({ opacity: v }), '0-1')}
        {c.kind !== 'audio' && c.kind !== 'text' && numberField(T, $, `scale-${c.id}`, 'Scale', c.scale ?? 1, v => patch({ scale: v }), 'x')}
        {c.volume !== undefined && numberField(T, $, `vol-${c.id}`, 'Volume', c.volume, v => patch({ volume: v }), '0-2')}
        {numberField(T, $, `fi-${c.id}`, 'Fade in', c.fadeIn ?? 0, v => patch({ fadeIn: v }))}
        {numberField(T, $, `fo-${c.id}`, 'Fade out', c.fadeOut ?? 0, v => patch({ fadeOut: v }))}
      </Box>
      {c.text && Input && (
        <Input
          key={`text-${c.id}`}
          label="Text"
          value={c.text.content}
          rows={2}
          submitLabel="Set"
          onSubmit={(v: string) => act($, () => patch({ text: { content: v } }))()}
        />
      )}
      {c.text && (
        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          {numberField(T, $, `size-${c.id}`, 'Size', c.text.size, v => patch({ text: { size: v } }), 'px')}
          {Input && (
            <Input key={`color-${c.id}`} label="Color" value={c.text.color} submitLabel="Set" onSubmit={(v: string) => act($, () => patch({ text: { color: v.trim() } }))()} />
          )}
          {Select && (
            <Select
              key={`pos-${c.id}`}
              label="Position"
              value={c.text.position}
              options={['top', 'center', 'lower-third', 'bottom'].map(v => ({ value: v, label: v }))}
              onSelect={(v: string) => act($, () => patch({ text: { position: v } }))()}
            />
          )}
          {Select && (
            <Select
              key={`anim-${c.id}`}
              label="Animation"
              value={c.text.animation}
              options={['none', 'fade', 'slide-up'].map(v => ({ value: v, label: v }))}
              onSelect={(v: string) => act($, () => patch({ text: { animation: v } }))()}
            />
          )}
        </Box>
      )}
      <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
        <Button key="split" label="Split at playhead" onPress={act($, () => edit($, { op: 'splitClip', clipId: c.id, time: view.playhead }, 'you', 'Split a clip'))} />
        <Button key="delete" label="Delete clip" onPress={act($, () => edit($, { op: 'deleteClips', clipIds: [c.id] }, 'you', 'Deleted a clip'))} />
        <Button key="deselect" label="Done" onPress={act($, () => setView($, v => ({ ...v, selection: null })))} />
      </Box>
    </Box>
  )
}

async function mediaTab($: $, T: Els, p: Project): Promise<RenderElement> {
  const { Box, Text, Button, Input } = T
  const missing = await getMissing($)
  const draft = await getDraft($)
  const used = new Set(p.clips.map(c => c.mediaId))
  return (
    <Box flexDirection="column">
      {Input ? (
        <Input
          key="import"
          label="Import"
          placeholder="Paste a file or folder path (video, image, audio)"
          value={draft.importPath}
          submitLabel="Import"
          onSubmit={(v: string) =>
            act($, async () => {
              const r = await importMedia($, v.split(/\r?\n|;/), 'you')
              if (!r.added.length && r.errors.length) throw new Error(r.errors.join('; '))
              await setDraft($, d => ({ ...d, importPath: '' }))
            })()
          }
        />
      ) : (
        <Text dimColor>Ask Claude to import files: "import C:\Videos\clip.mp4".</Text>
      )}
      {p.media.length === 0 && <Text dimColor>No media yet. Files are referenced where they are and never changed.</Text>}
      {p.media.map(m => (
        <Box flexDirection="row" columnGap={1}>
          <Button
            key={`add-${m.id}`}
            label="Add"
            onPress={act($, async () => {
              await edit($, { op: 'addClip', mediaId: m.id }, 'you', `Added ${m.name}`)
            })}
          />
          <Text wrap="truncate-middle" color={missing.includes(m.id) ? '#ff6464' : undefined}>
            {m.name}{' '}
            <Text dimColor>
              {m.kind}
              {m.duration ? ` ${formatTime(m.duration, p.fps)}` : ''}
              {m.width ? ` ${m.width}x${m.height}` : ''}
              {used.has(m.id) ? ' · used' : ''}
              {missing.includes(m.id) ? ' · MISSING (ask Claude to relink it)' : ''}
            </Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

async function chatTab($: $, T: Els): Promise<RenderElement> {
  const { Box, Text, Button, Input } = T
  const chat = await getChat($)
  const logs = await getLog($)
  const send = (text: string) =>
    act($, async () => {
      if (!text.trim()) return
      await setChat($, c => ({ isWaiting: true, sent: [...c.sent, { at: new Date().toISOString(), text }].slice(-20) }))
      await $.prompt.submit({ text })
    })
  return (
    <Box flexDirection="column">
      <Text dimColor>Messages go to this Claude Code session, on your plan. Claude edits with the FRAME AI tools; its replies appear in the conversation.</Text>
      {Input ? (
        <Input key="ask" label="Ask Claude" placeholder="e.g. Add a title at the beginning" submitLabel="Send" onSubmit={(v: string) => send(v)()} />
      ) : (
        <Text dimColor>Type your request in the prompt box.</Text>
      )}
      {chat.isWaiting && <Text color="#ffb547">Claude is working on it…</Text>}
      {chat.sent.length === 0 && (
        <Box flexDirection="column">
          <Text dimColor>Try:</Text>
          {SUGGESTIONS.map(s => (
            <Button key={`sug-${s}`} plain onPress={send(s)}>
              {s}
            </Button>
          ))}
        </Box>
      )}
      {logs.length > 0 && <Text weight="semibold">What changed</Text>}
      {logs.slice(-8).map(l => (
        <Text color={l.isError ? '#ff6464' : undefined} dimColor={!l.isError}>
          {l.origin === 'claude' ? 'Claude: ' : 'You: '}
          {l.text}
        </Text>
      ))}
    </Box>
  )
}

async function exportTab($: $, T: Els, p: Project): Promise<RenderElement> {
  const { Box, Text, Button, Input, Select } = T
  const job = await getJob($)
  const draft = await getDraft($)
  const dir = (await getDir($)) ?? ''
  const output = draft.exportPath || defaultExportPath(p, dir)
  const start = act($, () => exportMp4($, { output, height: draft.height, quality: draft.quality }, 'you'))
  return (
    <Box flexDirection="column">
      {Input ? (
        <Input key="export-path" label="File" value={output} submitLabel="Set" onSubmit={(v: string) => act($, () => setDraft($, d => ({ ...d, exportPath: v.trim() })))()} />
      ) : (
        <Text dimColor>{output}</Text>
      )}
      {Select && (
        <Box flexDirection="row" columnGap={2}>
          <Select
            key="export-quality"
            label="Quality"
            value={draft.quality}
            options={[
              { value: 'high', label: 'High' },
              { value: 'medium', label: 'Medium' },
              { value: 'draft', label: 'Draft (fast)' },
            ]}
            onSelect={(v: string) => act($, () => setDraft($, d => ({ ...d, quality: v as 'high' })))()}
          />
          <Select
            key="export-size"
            label="Size"
            value={String(draft.height)}
            options={[
              { value: '0', label: `Project (${p.width}x${p.height})` },
              { value: '720', label: '720p' },
              { value: '480', label: '480p' },
            ]}
            onSelect={(v: string) => act($, () => setDraft($, d => ({ ...d, height: Number(v) })))()}
          />
        </Box>
      )}
      <Box flexDirection="row" columnGap={1}>
        {job?.isRunning ? (
          <Button key="export-cancel" label="Cancel export" onPress={() => cancelExport()} />
        ) : (
          <Button key="export-go" variant="primary" label="Export MP4" onPress={start} />
        )}
        {job && !job.isRunning && !job.error && job.output && <Button key="export-open" label="Play the file" onPress={act($, () => openWithSystem($, job.output!))} />}
      </Box>
      {job && (
        <Text color={job.error ? '#ff6464' : undefined}>
          {job.label} {job.isRunning ? (job.fraction === null ? '…' : bar(job.fraction)) : ''}
        </Text>
      )}
      {job?.error && <Text color="#ff6464">{job.error}</Text>}
      {job && !job.isRunning && !job.error && job.output && <Text dimColor>{job.output}</Text>}
    </Box>
  )
}

const TABS: { id: FrameTab; label: string }[] = [
  { id: 'clip', label: 'Clip' },
  { id: 'media', label: 'Media' },
  { id: 'chat', label: 'Claude' },
  { id: 'export', label: 'Export' },
]

export async function drawPane($: $, e: { surface: string; props: { bodyColumns: number } }): Promise<RenderElement> {
  const T = $.ui.resolve(e as never) as unknown as Els
  const { Box, Text, Button, Client } = T
  const columns = Math.max(30, e.props.bodyColumns)
  lastColumns = columns
  const project = (await getProject($))
  if (!project) return welcome($, T, columns)
  const view = await getView($)
  const history = await getHistory($)
  const job = await getJob($)
  const tl = timelineProps(project, view, columns)
  const body =
    view.tab === 'clip'
      ? await clipTab($, T, project)
      : view.tab === 'media'
        ? await mediaTab($, T, project)
        : view.tab === 'chat'
          ? await chatTab($, T)
          : await exportTab($, T, project)
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" flexWrap="wrap" columnGap={1} alignItems="center">
        <Text weight="bold">FRAME AI</Text>
        <Text>{project.name}</Text>
        <Text dimColor>
          {project.width}x{project.height} · {project.fps} fps · saved
        </Text>
        <Button key="undo" label="Undo" dimColor={history.past.length === 0} onPress={act($, () => undoRedo($, 'undo', 'you'))} />
        <Button key="redo" label="Redo" dimColor={history.future.length === 0} onPress={act($, () => undoRedo($, 'redo', 'you'))} />
        {job?.isRunning && <Text color="#ffb547">{job.fraction === null ? 'Exporting…' : bar(job.fraction, 10)}</Text>}
      </Box>
      {await preview($, T, e.surface, project, columns)}
      {await transport($, T, project)}
      {Client ? <Client key="timeline" module="./timeline.tsx" props={tl} /> : timelineFallback(T, $, tl)}
      <Box flexDirection="row" columnGap={1}>
        {TABS.map(t => (
          <Button key={`tab-${t.id}`} label={t.label} variant={view.tab === t.id ? 'primary' : undefined} onPress={act($, () => setView($, v => ({ ...v, tab: t.id })))} />
        ))}
      </Box>
      {body}
    </Box>
  )
}
