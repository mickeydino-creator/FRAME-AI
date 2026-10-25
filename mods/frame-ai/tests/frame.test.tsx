import { expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'

// A fake computer beneath the mod: files in a Map, and an "ffmpeg" that
// answers probes and writes the files it is asked to write.
function world(on: On, opts: { hasFfmpeg?: boolean } = {}) {
  const files = new Map<string, string>([
    ['/media/shot.mp4', 'video'],
    ['/media/song.mp3', 'audio'],
  ])
  const runs: string[][] = []
  mock.env(on, { HOME: '/home/me' })
  mock.store(on)
  mock.clock(on)
  on('fs.exists', (_, e) => ({ value: files.has(e.path) || [...files.keys()].some(k => k.startsWith(e.path + '/')) }))
  on('fs.write', (_, e) => {
    files.set(e.path, e.text)
    return { value: undefined }
  })
  on('fs.read', (_, e) => {
    if (!files.has(e.path)) throw new Error(`ENOENT ${e.path}`)
    return { value: e.as === 'bytes' ? { base64: btoa('jpegbytes') } : files.get(e.path)! }
  })
  on('fs.stat', (_, e) => {
    if (files.has(e.path)) return { value: { kind: 'file', size: 10, mtimeMs: 0, isLink: false } }
    if ([...files.keys()].some(k => k.startsWith(e.path + '/'))) return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false } }
    throw new Error('ENOENT')
  })
  on('fs.list', (_, e) => {
    const names = [...new Set([...files.keys()].filter(k => k.startsWith(e.path + '/')).map(k => k.slice(e.path.length + 1).split('/')[0] ?? ''))]
    const entries = names.map(name => ({ name, kind: files.has(`${e.path}/${name}`) ? ('file' as const) : ('dir' as const), size: 0, mtimeMs: 0, isLink: false }))
    return { value: entries }
  })
  on('process.run', (_, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    const ok = (stdout = '') => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (opts.hasFfmpeg === false) throw new Error('ENOENT: ffmpeg')
    if (argv[0] === 'fc-match') return ok('/fonts/sans.ttf')
    if (argv.includes('-version')) return ok('ffmpeg version 7.1-test Copyright')
    if (argv.includes('-encoders')) return ok(' V....D libx264  H.264')
    if (argv.includes('-filters')) return ok(' ... drawtext')
    if (argv[0] === 'ffprobe') {
      const path = argv[argv.length - 1] ?? ''
      if (path.endsWith('.mp4'))
        return ok(JSON.stringify({ streams: [{ codec_type: 'video', width: 1920, height: 1080, avg_frame_rate: '30/1' }, { codec_type: 'audio' }], format: { duration: '8' } }))
      return ok(JSON.stringify({ streams: [{ codec_type: 'audio' }], format: { duration: '20' } }))
    }
    if (argv[0] === 'ffmpeg') {
      files.set(argv[argv.length - 1] ?? '', 'rendered')
      return ok()
    }
    return ok()
  })
  on('process.spawn', async function* (_, e) {
    const argv = [...e.argv]
    runs.push(argv)
    yield { stream: 'stdout', text: 'out_time_us=4000000\nprogress=continue\n' }
    files.set(argv[argv.length - 1] ?? '', 'mp4')
    yield { stream: 'stdout', text: 'out_time_us=8000000\nprogress=end\n' }
    return { value: { code: 0, signal: null } }
  })
  on('command.register', () => ({ value: { command: 'frame' } }))
  on('tool.register', (_, e) => ({ value: { tool: `mcp__frame-ai__${e.name}` } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  // Nobody answers the confirmation dialog: it is dismissed.
  on('tool.call', { tool: 'AskUserQuestion' }, () => ({ deny: 'dismissed' }))
  return { files, runs }
}

const PANE = {
  plugin: 'frame-ai',
  component: 'Pane',
  requestId: 'frame-ai',
  props: { title: 'FRAME AI', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 60 }, view: {} },
} as const

const tool = <N extends string>(name: N) => `mcp__frame-ai__${name}` as const

test('Claude builds and exports an edit through the tools', async ($, on) => {
  const w = world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const made = await $.tool.call({ tool: tool('new_project'), name: 'Demo' })
  expect(made.deny).toBeUndefined()
  expect(w.files.has('/home/me/FRAME AI Projects/Demo/project.json')).toBe(true)

  const imported = await $.tool.call({ tool: tool('import_media'), paths: ['/media'] })
  expect(String(imported.result)).toContain('Imported 2 file(s)')

  const project = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  const shot = project.media.find((m: { name: string }) => m.name === 'shot.mp4')
  await $.tool.call({ tool: tool('add_clip'), mediaId: shot.id })
  await $.tool.call({ tool: tool('add_clip'), mediaId: shot.id })
  const title = await $.tool.call({ tool: tool('add_text'), content: 'Summer', start: 0, duration: 3, animation: 'slide-up' })
  expect(String(title.result)).toMatch(/Added text clip .* from 0s to 3s/)

  // A failing edit is reported as a failure, not as success.
  const bad = await $.tool.call({ tool: tool('split_clip'), clipId: 'nope', time: 1 })
  expect(bad.deny).toMatch(/No clip with id nope/)

  const saved = JSON.parse(w.files.get('/home/me/FRAME AI Projects/Demo/project.json')!)
  expect(saved.clips.length).toBe(3)

  const frame = await $.tool.call({ tool: tool('render_frame'), time: 1 })
  expect(String(frame.result)).toMatch(/frame-1000\.png/)
  const frameRun = w.runs.find(a => a.includes('-frames:v'))!
  expect(frameRun.join(' ')).toContain('drawtext=')

  const exported = await $.tool.call({ tool: tool('export_mp4'), quality: 'draft' })
  expect(String(exported.result)).toContain('Demo/exports/Demo.mp4')
  expect(w.files.get('/home/me/FRAME AI Projects/Demo/exports/Demo.mp4')).toBe('mp4')

  // Exporting again over the same file asks first; a dismissed question keeps the file.
  const again = await $.tool.call({ tool: tool('export_mp4') })
  expect(again.deny).toMatch(/already exists, and the replace question was dismissed/)

  const undone = await $.tool.call({ tool: tool('undo') })
  expect(String(undone.result)).toBe('Undid the last edit.')
  const after = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  expect(after.tracks.flatMap((t: { clips: unknown[] }) => t.clips).length).toBe(2)
})

test('destructive tools ask, and do nothing when declined', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  await $.tool.call({ tool: tool('new_project'), name: 'Cut' })
  await $.tool.call({ tool: tool('import_media'), paths: ['/media/shot.mp4'] })
  const p = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  await $.tool.call({ tool: tool('add_clip'), mediaId: p.media[0].id })
  const cut = await $.tool.call({ tool: tool('cut_range'), start: 0, end: 2 })
  expect(cut.deny).toMatch(/Nothing was changed/)
  const still = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  expect(still.duration).toBe(8)
})

test('the pane: welcome, timeline, tabs and dragging a clip', async ($, on) => {
  world(on)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  for (const surface of ['terminal', 'desktop', 'vscode', 'mobile'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect((await ui.find({ type: 'Text', text: /Edit video beside Claude/ }))?.text).toBeDefined()
    await ui.unmount()
  }
  await $.tool.call({ tool: tool('new_project'), name: 'Pane' })
  await $.tool.call({ tool: tool('import_media'), paths: ['/media/shot.mp4'] })
  const p = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  await $.tool.call({ tool: tool('add_clip'), mediaId: p.media[0].id })
  await $.tool.call({ tool: tool('add_clip'), mediaId: p.media[0].id })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...PANE, surface })
    expect(await ui.find({ type: 'Client', key: 'timeline' })).toBeDefined()
    expect((await ui.find({ type: 'Button', key: 't-play' }))?.text).toBe('Play')
    await ui.press({ key: 'tab-export' })
    expect(await ui.find({ type: 'Button', key: 'export-go' })).toBeDefined()
    await ui.press({ key: 'tab-media' })
    expect((await ui.find({ type: 'Text', text: /shot\.mp4/ }))?.text).toContain('used')
    await ui.unmount()
  }

  // Drag the second clip to the right on the desktop timeline.
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.resize({ in: 'timeline', columns: 80, rows: 6 })
  const before = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  const second = before.tracks.find((t: { id: string }) => t.id === 'V1').clips[1]
  const drawn = JSON.stringify(await ui.drawn({ in: 'timeline' }))
  expect(drawn).toContain('shot.mp4')
  // Row 0 is the ruler, then V2, V1, A1: V1 is row 2. Find the clip's first column.
  const labelWidth = 9
  const spc = Math.max(16 + 2, 10) / (80 - labelWidth - 1)
  const x = labelWidth + Math.round(second.start / spc) + 2
  await ui.pointer({ in: 'timeline', type: 'down', x, y: 2, button: 'left' })
  await ui.pointer({ in: 'timeline', type: 'move', x: x + 6, y: 2, button: 'left' })
  await ui.pointer({ in: 'timeline', type: 'up', x: x + 6, y: 2, button: 'left' })
  const after = JSON.parse(String((await $.tool.call({ tool: tool('get_project') })).result))
  const moved = after.tracks.find((t: { id: string }) => t.id === 'V1').clips.find((c: { id: string }) => c.id === second.id)
  expect(moved.start).toBeGreaterThan(second.start)
  expect(after.selection).toEqual([second.id])
  await ui.unmount()
})

test('without FFmpeg the pane says how to install it', async ($, on) => {
  world(on, { hasFfmpeg: false })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  expect((await ui.find({ type: 'Text', text: /FFmpeg was not found/ }))?.text).toContain('ffmpeg')
  await ui.unmount()
  const r = await $.tool.call({ tool: tool('new_project'), name: 'X' })
  expect(r.deny).toBeUndefined()
  const imp = await $.tool.call({ tool: tool('import_media'), paths: ['/media/shot.mp4'] })
  expect(imp.deny).toMatch(/FFmpeg was not found/)
})
