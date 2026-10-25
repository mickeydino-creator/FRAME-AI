/**
 * Surface module: the multitrack timeline, drawn in cells with mouse and keys.
 * Click a clip to select it, drag it to move it (also across tracks of the
 * same kind), drag its first or last cell to trim, click the ruler to seek.
 * It never edits by itself: it posts what the person did to the hooks module,
 * which applies the edit and hands new props back.
 */
import type { ClientModule, ClientPointerEvent } from 'claude-code'

export type TimelineClip = { id: string; col: number; width: number; name: string; kind: string; isSelected: boolean }
export type TimelineRow = { id: string; label: string; kind: 'video' | 'audio'; isMuted: boolean; isHidden: boolean; clips: TimelineClip[] }
export type TimelineProps = {
  labelWidth: number
  laneWidth: number
  ruler: string
  playheadCol: number | null
  rows: TimelineRow[]
}

type Drag = { clipId: string; mode: 'move' | 'start' | 'end'; x0: number; y0: number; dx: number; dy: number; moved: boolean }
type State = { drag: Drag | null }

const COLORS: Record<string, string> = {
  video: '#2b5a99',
  image: '#5b4aa6',
  audio: '#237a52',
  text: '#9c6f1e',
}

function fit(text: string, width: number): string {
  if (width <= 0) return ''
  const t = text.length > width ? text.slice(0, Math.max(0, width - 1)) + '…' : text
  return t.padEnd(width, ' ')
}

const Timeline: ClientModule<TimelineProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  const state = surface.state ?? { drag: null }
  const drag = state.drag

  const hit = (e: ClientPointerEvent): { row: TimelineRow; clip?: TimelineClip; col: number } | null => {
    const row = props.rows[e.y - 1]
    const col = e.x - props.labelWidth
    if (!row) return null
    return { row, col, clip: row.clips.find(c => col >= c.col && col < c.col + c.width) }
  }

  surface.onPointer(e => {
    if (e.type === 'down') {
      if (e.y === 0 && e.x >= props.labelWidth) {
        surface.post({ type: 'seek', col: e.x - props.labelWidth })
        return
      }
      const h = hit(e)
      if (!h?.clip) {
        surface.post({ type: 'select', clipId: null })
        return
      }
      const c = h.clip
      const mode = c.width >= 4 && h.col === c.col ? 'start' : c.width >= 4 && h.col === c.col + c.width - 1 ? 'end' : 'move'
      surface.setState({ drag: { clipId: c.id, mode, x0: e.x, y0: e.y, dx: 0, dy: 0, moved: false } })
      surface.post({ type: 'select', clipId: c.id })
    } else if (e.type === 'move' && drag) {
      const dx = e.x - drag.x0
      const dy = e.y - drag.y0
      if (dx !== drag.dx || dy !== drag.dy) surface.setState({ drag: { ...drag, dx, dy, moved: drag.moved || dx !== 0 || dy !== 0 } })
    } else if (e.type === 'up' && drag) {
      if (drag.moved) {
        const target = props.rows[drag.y0 - 1 + drag.dy]
        surface.post({ type: 'drag', clipId: drag.clipId, mode: drag.mode, dCols: drag.dx, trackId: drag.mode === 'move' ? target?.id ?? null : null })
      }
      surface.setState({ drag: null })
    }
  })

  surface.onKey(e => {
    const map: Record<string, unknown> = {
      left: { type: 'nudge', dCols: e.shift ? -5 : -1 },
      right: { type: 'nudge', dCols: e.shift ? 5 : 1 },
      delete: { type: 'delete' },
      backspace: { type: 'delete' },
      s: { type: 'split' },
      ' ': { type: 'play' },
    }
    const msg = map[e.key]
    if (msg) surface.post(msg as { type: string })
  })

  const lane = (row: TimelineRow, rowIndex: number) => {
    // Apply the drag in progress to the dragged clip, drawn where it would land.
    const clips = row.clips
      .map(c => {
        if (!drag || drag.clipId !== c.id) return c
        if (drag.mode === 'move') return null
        if (drag.mode === 'start') return { ...c, col: c.col + drag.dx, width: Math.max(1, c.width - drag.dx) }
        return { ...c, width: Math.max(1, c.width + drag.dx) }
      })
      .filter((c): c is TimelineClip => c !== null)
    if (drag?.mode === 'move' && drag.y0 - 1 + drag.dy === rowIndex) {
      const source = props.rows.flatMap(r => r.clips).find(c => c.id === drag.clipId)
      if (source) clips.push({ ...source, col: Math.max(0, source.col + drag.dx), isSelected: true })
    }
    clips.sort((a, b) => a.col - b.col)
    const parts: { text: string; clip?: TimelineClip }[] = []
    let at = 0
    for (const c of clips) {
      const from = Math.max(at, c.col)
      const to = Math.min(props.laneWidth, c.col + c.width)
      if (to <= from) continue
      if (from > at) parts.push({ text: ' '.repeat(from - at) })
      parts.push({ text: fit(c.name, to - from), clip: c })
      at = to
    }
    if (at < props.laneWidth) parts.push({ text: ' '.repeat(props.laneWidth - at) })
    return parts.map(p =>
      p.clip ? (
        <Text backgroundColor={p.clip.isSelected ? '#e8e8ec' : COLORS[p.clip.kind] ?? '#3e4a5c'} color={p.clip.isSelected ? '#0b0b0c' : '#ffffff'} wrap="truncate">
          {p.text}
        </Text>
      ) : (
        <Text dimColor>{p.text.replace(/ /g, '·')}</Text>
      ),
    )
  }

  return (
    <Box flexDirection="column">
      <Box flexDirection="row">
        <Text dimColor>{fit('', props.labelWidth)}</Text>
        <Text dimColor>{props.ruler}</Text>
      </Box>
      {props.rows.map((row, i) => (
        <Box flexDirection="row">
          <Text color={row.kind === 'video' ? '#7aa7ff' : '#4cd08a'} dimColor={row.isHidden || row.isMuted}>
            {fit(`${row.label}${row.isMuted ? ' m' : ''}${row.isHidden ? ' h' : ''}`, props.labelWidth)}
          </Text>
          {lane(row, i)}
        </Box>
      ))}
    </Box>
  )
}

export default Timeline
