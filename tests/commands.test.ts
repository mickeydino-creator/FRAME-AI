import { describe, expect, it } from 'vitest'
import { evaluateLayer, evaluateKeyframes } from '../src/shared/animation'
import { buildAudioMix } from '../src/shared/audioMix'
import { applyCommand, Command } from '../src/shared/commands'
import { clipEnd, createProject, migrateProject, serializeProject } from '../src/shared/project'
import type { MediaAsset, Project } from '../src/shared/types'
import { formatTimecode, parseTime } from '../src/shared/util'

function asset(partial: Partial<MediaAsset>): MediaAsset {
  return {
    id: 'med_1',
    name: 'clip.mp4',
    type: 'video',
    file: 'assets/clip.mp4',
    originalPath: '/tmp/clip.mp4',
    duration: 10,
    width: 1920,
    height: 1080,
    hasVideo: true,
    hasAudio: true,
    size: 1,
    importedAt: '',
    ...partial
  }
}

function run(p: Project, ...cmds: Command[]) {
  let project = p
  let result = {}
  for (const c of cmds) ({ project, result } = applyCommand(project, c) as { project: Project; result: object })
  return { project, result: result as Record<string, unknown> }
}

function setup() {
  const p = createProject('Test')
  return run(p, { type: 'addMedia', asset: asset({}) }, { type: 'addMedia', asset: asset({ id: 'med_a', type: 'audio', name: 'a.wav', hasVideo: false, duration: 20 }) }).project
}

describe('commands', () => {
  it('never mutates the input project', () => {
    const p = setup()
    const before = JSON.stringify(p)
    applyCommand(p, { type: 'addMediaClip', mediaId: 'med_1', start: 2 })
    expect(JSON.stringify(p)).toBe(before)
  })

  it('adds media clips to compatible tracks with full source duration', () => {
    const p = setup()
    const { project, result } = run(p, { type: 'addMediaClip', mediaId: 'med_1', start: 2 })
    const clip = project.clips.find((c) => c.id === result.clipId)!
    expect(clip.duration).toBe(10)
    expect(clip.start).toBe(2)
    expect(project.tracks.find((t) => t.id === clip.trackId)!.kind).toBe('video')
    const r2 = run(project, { type: 'addMediaClip', mediaId: 'med_a', start: 0 })
    const a = r2.project.clips.find((c) => c.id === r2.result.clipId)!
    expect(r2.project.tracks.find((t) => t.id === a.trackId)!.kind).toBe('audio')
  })

  it('splits a clip into two contiguous parts with matching source offsets', () => {
    const p = setup()
    const { project, result } = run(p, { type: 'addMediaClip', mediaId: 'med_1', start: 1 })
    const id = result.clipId as string
    const r = run(project, { type: 'splitClip', clipId: id, time: 4 })
    const left = r.project.clips.find((c) => c.id === id)!
    const right = r.project.clips.find((c) => c.id === r.result.clipId)!
    expect(left.duration).toBeCloseTo(3)
    expect(right.start).toBeCloseTo(4)
    expect(right.duration).toBeCloseTo(7)
    expect(right.sourceStart).toBeCloseTo(3)
    expect(() => run(r.project, { type: 'splitClip', clipId: id, time: 0.5 })).toThrow()
  })

  it('trims within source media bounds', () => {
    const p = setup()
    const { project, result } = run(p, { type: 'addMediaClip', mediaId: 'med_1', start: 5 })
    const id = result.clipId as string
    let r = run(project, { type: 'trimClip', clipId: id, edge: 'start', time: 7 })
    let c = r.project.clips.find((x) => x.id === id)!
    expect(c.start).toBeCloseTo(7)
    expect(c.sourceStart).toBeCloseTo(2)
    expect(clipEnd(c)).toBeCloseTo(15)
    // Cannot extend before the first source frame.
    r = run(r.project, { type: 'trimClip', clipId: id, edge: 'start', time: 0 })
    c = r.project.clips.find((x) => x.id === id)!
    expect(c.start).toBeCloseTo(5)
    expect(c.sourceStart).toBeCloseTo(0)
    // Cannot extend past the end of the source.
    r = run(r.project, { type: 'trimClip', clipId: id, edge: 'end', time: 100 })
    c = r.project.clips.find((x) => x.id === id)!
    expect(c.duration).toBeCloseTo(10)
  })

  it('moves clips across compatible tracks only', () => {
    const p = setup()
    const { project, result } = run(p, { type: 'addMediaClip', mediaId: 'med_1', start: 0 })
    const audioTrack = project.tracks.find((t) => t.kind === 'audio')!
    expect(() => run(project, { type: 'moveClip', clipId: result.clipId as string, start: 1, trackId: audioTrack.id })).toThrow(/cannot be placed/)
    const otherVideo = project.tracks.filter((t) => t.kind === 'video')[0]
    const r = run(project, { type: 'moveClip', clipId: result.clipId as string, start: 3, trackId: otherVideo.id })
    const c = r.project.clips[0]
    expect(c.start).toBe(3)
    expect(c.trackId).toBe(otherVideo.id)
  })

  it('adds text with animation and keyframes', () => {
    const p = setup()
    const { project, result } = run(p, {
      type: 'addText',
      text: 'Hello',
      start: 1,
      duration: 3,
      animIn: { preset: 'fade', duration: 1 }
    })
    const id = result.clipId as string
    const r = run(
      project,
      { type: 'setKeyframe', clipId: id, prop: 'x', time: 0, value: -100, ease: 'linear' },
      { type: 'setKeyframe', clipId: id, prop: 'x', time: 2, value: 100, ease: 'linear' }
    )
    const c = r.project.clips.find((x) => x.id === id)!
    expect(c.text!.text).toBe('Hello')
    expect(evaluateKeyframes(c.keyframes.x!, 1)).toBeCloseTo(0)
    const st = evaluateLayer(c, 0.5, { width: 1920, height: 1080 })
    expect(st.opacity).toBeGreaterThan(0)
    expect(st.opacity).toBeLessThan(1)
    expect(st.x).toBeCloseTo(-50)
  })

  it('crossfade overlaps with the previous clip and sets fades', () => {
    const p = setup()
    let r = run(p, { type: 'addMediaClip', mediaId: 'med_1', start: 0, duration: 4 })
    const first = r.result.clipId as string
    const track = r.project.clips[0].trackId
    r = run(r.project, { type: 'addMediaClip', mediaId: 'med_1', start: 4, duration: 4, trackId: track })
    const second = r.result.clipId as string
    r = run(r.project, { type: 'crossfade', clipId: second, duration: 1 })
    const a = r.project.clips.find((c) => c.id === first)!
    const b = r.project.clips.find((c) => c.id === second)!
    expect(b.start).toBeCloseTo(3)
    expect(b.fadeIn).toBeCloseTo(1)
    expect(a.fadeOut).toBeCloseTo(1)
  })

  it('batch is atomic', () => {
    const p = setup()
    expect(() =>
      run(p, { type: 'batch', commands: [{ type: 'addText', text: 'ok' }, { type: 'deleteClips', clipIds: [] }, { type: 'moveClip', clipId: 'nope', start: 0 }] })
    ).toThrow()
  })

  it('serializes and migrates projects', () => {
    const p = setup()
    const { project } = run(p, { type: 'addText', text: 'Persist me' })
    const back = migrateProject(JSON.parse(serializeProject(project)))
    expect(back.clips[0].text!.text).toBe('Persist me')
    expect(back.media.length).toBe(2)
    expect(() => migrateProject({ format: 'other' })).toThrow()
    expect(() => migrateProject({ format: 'frame-ai-project', version: 999 })).toThrow(/newer/)
  })
})

describe('audio mix', () => {
  it('builds a filter graph with delays, volume and fades', () => {
    const p = setup()
    let r = run(p, { type: 'addMediaClip', mediaId: 'med_a', start: 2 })
    r = run(r.project, { type: 'updateClip', clipId: r.result.clipId as string, patch: { volume: 0.5, fadeIn: 1 } })
    const plan = buildAudioMix(r.project, (a) => `/p/${a.file}`, 0, 22)!
    expect(plan.inputs).toEqual(['/p/assets/clip.mp4'])
    expect(plan.filter).toContain('adelay=2000')
    expect(plan.filter).toContain("volume='0.5*min(1,(t+0)/1)'")
    expect(plan.filter).toContain('[aout]')
  })

  it('skips muted tracks and clips', () => {
    const p = setup()
    let r = run(p, { type: 'addMediaClip', mediaId: 'med_a', start: 0 })
    r = run(r.project, { type: 'updateClip', clipId: r.result.clipId as string, patch: { muted: true } })
    expect(buildAudioMix(r.project, (a) => a.file, 0, 10)).toBeNull()
  })
})

describe('time utils', () => {
  it('formats and parses timecode', () => {
    expect(formatTimecode(61.5, 30)).toBe('00:01:01:15')
    expect(parseTime('00:01:01:15', 30)).toBeCloseTo(61.5)
    expect(parseTime('1:30', 30)).toBe(90)
    expect(parseTime('2.5', 30)).toBe(2.5)
    expect(parseTime('abc', 30)).toBeNull()
  })
})
