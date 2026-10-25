import { describe, expect, test } from 'claude-code/testing'

import { type Clip, applyEdit, clipEnd, createProject, describeProject, type Edit, loadProject, type Media, parseTime, type Project, projectDuration } from '../hooks/model'
import { buildGraph, classifyProbe, exportArgs, filterValue, parseProgress, parseSrt } from '../hooks/render'

const video = (id: string, duration: number): Media => ({
  id,
  name: `${id}.mp4`,
  path: `/media/${id}.mp4`,
  kind: 'video',
  duration,
  width: 1920,
  height: 1080,
  hasVideo: true,
  hasAudio: true,
})

function base(): Project {
  let p = createProject('Test')
  for (const m of [video('a', 6), video('b', 4), video('c', 5)]) p = applyEdit(p, { op: 'addMedia', media: m }).project
  for (const id of ['a', 'b', 'c']) p = applyEdit(p, { op: 'addClip', mediaId: id }).project
  return p
}

function run(p: Project, e: Edit | Edit[]) {
  return applyEdit(p, e)
}

describe('timeline edits', () => {
  test('media clips line up one after another on V1', async () => {
    const p = base()
    const v1 = p.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start)
    expect(v1.map(c => [c.start, clipEnd(c)])).toEqual([
      [0, 6],
      [6, 10],
      [10, 15],
    ])
    expect(projectDuration(p)).toBe(15)
  })

  test('edits never change the project they are given', async () => {
    const p = base()
    const before = JSON.stringify(p)
    run(p, { op: 'deleteRange', start: 0, end: 2, ripple: true })
    expect(JSON.stringify(p)).toBe(before)
  })

  test('"cut the first two seconds" trims the source and closes the gap', async () => {
    const { project } = run(base(), { op: 'deleteRange', start: 0, end: 2, ripple: true })
    const v1 = project.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start) as [Clip, Clip, Clip]
    expect(v1[0].start).toBe(0)
    expect(v1[0].sourceIn).toBe(2)
    expect(v1[0].duration).toBe(4)
    expect(v1[1].start).toBe(4)
    expect(projectDuration(project)).toBe(13)
  })

  test('"add a title at the beginning" puts text on a track above the footage', async () => {
    const { project, result } = run(base(), { op: 'addText', text: { content: 'Hello' }, start: 0, duration: 3 })
    const t = project.clips.find(c => c.id === result.clipIds![0])!
    expect(t.kind).toBe('text')
    expect(t.trackId).toBe('V2')
    expect(project.tracks.findIndex(x => x.id === 'V2')).toBeLessThan(project.tracks.findIndex(x => x.id === 'V1'))
  })

  test('"put this clip after the second clip" reorders the track', async () => {
    const p = base()
    const [first, second, third] = p.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start) as [Clip, Clip, Clip]
    const { project } = run(p, { op: 'moveClip', clipId: first.id, afterClipId: second.id })
    const order = project.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start).map(c => c.id)
    expect(order).toEqual([second.id, first.id, third.id])
    expect(project.clips.find(c => c.id === second.id)!.start).toBe(0)
    expect(projectDuration(project)).toBe(15)
  })

  test('"put the last clip first" inserts before the first clip', async () => {
    const p = base()
    const [first, second, third] = p.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start) as [Clip, Clip, Clip]
    const { project } = run(p, { op: 'moveClip', clipId: third.id, beforeClipId: first.id })
    const v1 = project.clips.filter(c => c.trackId === 'V1').sort((x, y) => x.start - y.start)
    expect(v1.map(c => [c.id, c.start])).toEqual([
      [third.id, 0],
      [first.id, 5],
      [second.id, 11],
    ])
  })

  test('split, trim and bad edits', async () => {
    const p = base()
    const a = p.clips[0]!
    const split = run(p, { op: 'splitClip', clipId: a.id, time: 2 })
    const right = split.project.clips.find(c => c.id === split.result.clipIds![1])!
    expect(right.sourceIn).toBe(2)
    expect(right.duration).toBe(4)
    // Trimming past the source end is clamped to the media length.
    const t = run(p, { op: 'trimClip', clipId: a.id, edge: 'end', time: 100 })
    expect(t.project.clips.find(c => c.id === a.id)!.duration).toBe(6)
    expect(() => run(p, { op: 'splitClip', clipId: a.id, time: 0 })).toThrow(/inside the clip/)
    expect(() => run(p, { op: 'addText', text: { content: 'x', color: 'red' } })).toThrow(/color/)
    expect(() => run(p, { op: 'deleteClips', clipIds: ['nope'] })).toThrow(/No clip/)
  })

  test('subtitles become boxed text clips on their own track', async () => {
    const { project, result } = run(base(), {
      op: 'addSubtitles',
      cues: [
        { start: 0.5, end: 2, text: 'One' },
        { start: 2, end: 3.5, text: 'Two' },
      ],
    })
    const subs = project.clips.filter(c => c.trackId === result.trackId)
    expect(subs.map(c => c.text!.content)).toEqual(['One', 'Two'])
    expect(subs.every(c => c.text!.box && c.text!.position === 'bottom')).toBe(true)
  })

  test('project files round-trip and refuse other files', async () => {
    const p = base()
    expect(loadProject(JSON.parse(JSON.stringify(p))).clips.length).toBe(3)
    expect(() => loadProject({ format: 'other' })).toThrow(/not a FRAME AI project/)
    expect(describeProject(p).tracks.find(t => t.id === 'V1')!.clips.length).toBe(3)
  })

  test('times parse in the forms people type', async () => {
    expect(parseTime('2')).toBe(2)
    expect(parseTime('1:05.5')).toBe(65.5)
    expect(parseTime('3s')).toBe(3)
    expect(parseTime('soon')).toBe(null)
  })
})

describe('ffmpeg graph', () => {
  const job = (p: Project) => ({
    project: p,
    fontFile: 'C:\\Windows\\Fonts\\arial.ttf',
    textFiles: Object.fromEntries(p.clips.filter(c => c.text).map(c => [c.id, `/cache/${c.id}.txt`])),
    mediaPath: (m: Media) => m.path,
  })

  test('export maps video, mixed audio and the title, for the whole timeline', async () => {
    const p = run(base(), { op: 'addText', text: { content: 'Hi' }, start: 0, duration: 3 }).project
    const { args, duration } = exportArgs(job(p), { output: '/out/x.mp4', height: 720, quality: 'high' })
    expect(duration).toBe(15)
    const graph = args[args.indexOf('-filter_complex') + 1]
    expect(graph).toContain("fontfile='C\\:/Windows/Fonts/arial.ttf'")
    expect(graph).toContain('drawtext=')
    expect(graph).toContain('amix=inputs=3')
    expect(graph).toContain('[vout]')
    expect(args).toContain('libx264')
    expect(args.slice(-1)[0]).toBe('/out/x.mp4')
    expect(args[args.indexOf('-crf') + 1]).toBe('18')
  })

  test('a preview frame needs only the clips under the playhead and no sound', async () => {
    const g = buildGraph({ ...job(base()), start: 7, end: 7 + 1 / 30, width: 640, height: 360 })
    expect(g.inputs.filter(a => a === '-i').length).toBe(1)
    expect(g.hasAudio).toBe(false)
  })

  test('an empty timeline cannot be exported', async () => {
    expect(() => exportArgs(job(createProject('x')), { output: '/o.mp4', height: 0, quality: 'high' })).toThrow(/empty/)
  })

  test('probe, progress and subtitle parsing', async () => {
    const m = classifyProbe('/a/clip.MOV', {
      streams: [{ codec_type: 'video', width: 1080, height: 1920, avg_frame_rate: '30000/1001', side_data_list: [{ rotation: -90 }] }, { codec_type: 'audio' }],
      format: { duration: '12.5' },
    })
    expect([m.kind, m.width, m.height, m.hasAudio, m.duration]).toEqual(['video', 1920, 1080, true, 12.5])
    expect(classifyProbe('/a/p.png', { streams: [{ codec_type: 'video', width: 10, height: 10 }], format: {} }).kind).toBe('image')
    expect(() => classifyProbe('/a/x.mp4', { streams: [], format: {} })).toThrow()
    expect(parseProgress('frame=3\nout_time_us=1500000\nprogress=continue\nout_time_us=2500000\n')).toBe(2.5)
    expect(parseSrt('1\n00:00:01,000 --> 00:00:02,500\nHello\n\n2\n00:00:03,000 --> 00:00:04,000\nWorld\n')).toEqual([
      { start: 1, end: 2.5, text: 'Hello' },
      { start: 3, end: 4, text: 'World' },
    ])
    expect(() => filterValue("it's")).toThrow(/apostrophe/)
  })
})
