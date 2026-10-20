// UI performance probe: builds a heavy project and measures playback frame
// pacing, timeline drag cost and timeline scroll cost in the real app.
// Run `npm run build` first. Usage: node scripts/perf.mjs
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { _electron as electron } from 'playwright-core'

if (process.platform === 'linux' && !process.env.DISPLAY && !process.env.FRAME_AI_XVFB) {
  const r = spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1920x1080x24', process.execPath, ...process.argv.slice(1)], {
    stdio: 'inherit',
    env: { ...process.env, FRAME_AI_XVFB: '1' }
  })
  process.exit(r.status ?? 1)
}

const require = createRequire(import.meta.url)
const root = resolve(import.meta.dirname, '..')
const outDir = join(root, 'test-output')
const fixtures = join(outDir, 'fixtures')
const home = join(outDir, 'perf-home')
const parent = join(outDir, 'perf-projects')
rmSync(home, { recursive: true, force: true })
rmSync(parent, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
mkdirSync(parent, { recursive: true })
if (!existsSync(join(fixtures, 'clip-h264.mp4'))) execFileSync(process.execPath, [join(root, 'scripts/make-fixtures.mjs'), fixtures], { stdio: 'inherit' })

const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'out/main/index.js'), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...process.env, HOME: home, FRAME_AI_NO_SANDBOX: '1', ELECTRON_RENDERER_URL: '' }
})
const win = await app.firstWindow()
await win.waitForSelector('.start-card')
const ed = (fn, ...a) => win.evaluate(fn, ...a)
await ed((p) => window.frameEditor.newProject('Perf', '16:9', p), parent)
await win.waitForSelector('.timeline')
console.log('importing')
const [video, audio] = await ed((p) => window.frameEditor.importMedia(p), [join(fixtures, 'clip-h264.mp4'), join(fixtures, 'music.mp3')])
const firstClip = await ed(([v, a]) => {
  const e = window.frameEditor
  const cmds = []
  for (let i = 0; i < 6; i++) cmds.push({ type: 'addTrack', kind: 'video' })
  e.batch(cmds)
  let first = null
  for (let i = 0; i < 30; i++) {
    const r = e.addMediaToTimeline(v.id, { start: i * 6 })
    first = first ?? r.clipId
  }
  for (let i = 0; i < 10; i++) e.addMediaToTimeline(a.id, { start: i * 5 })
  for (let i = 0; i < 120; i++) e.addText(`Title ${i} with a few words`, { start: i * 1.5, duration: 3, animIn: { preset: 'pop' } })
  for (let i = 0; i < 40; i++) e.addShape({ shape: 'star' }, { start: i * 4, duration: 3 })
  e.setPlayhead(0)
  return first
}, [video, audio])
console.log('project built')
await win.waitForTimeout(1500)

const result = {}
const cdp = await app.context().newCDPSession(win)
await cdp.send('Performance.enable')
async function cpu(fn) {
  const m = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map((x) => [x.name, x.value]))
  const a = await m()
  await fn()
  const b = await m()
  return { scriptMs: Math.round((b.ScriptDuration - a.ScriptDuration) * 1000), taskMs: Math.round((b.TaskDuration - a.TaskDuration) * 1000), layoutMs: Math.round((b.LayoutDuration - a.LayoutDuration) * 1000), recalcStyleMs: Math.round((b.RecalcStyleDuration - a.RecalcStyleDuration) * 1000) }
}

// 1. Playback frame pacing with a text clip selected (Properties visible).
const textId = await ed(() => window.frameEditor.getProjectState().project.clips.find((c) => c.type === 'text').id)
await ed((id) => window.frameEditor.select([id]), textId)
await cdp.send('Profiler.enable'); await cdp.send('Profiler.start')
result.playbackCpu = await cpu(async () => { result.playback = await ed(
  () =>
    new Promise((resolve) => {
      const gaps = []
      let last = performance.now()
      let long = 0
      const obs = new PerformanceObserver((l) => (long += l.getEntries().length))
      obs.observe({ entryTypes: ['longtask'] })
      window.frameEditor.play()
      const end = last + 3000
      const tick = (t) => {
        gaps.push(t - last)
        last = t
        if (t < end) requestAnimationFrame(tick)
        else {
          window.frameEditor.pause()
          obs.disconnect()
          gaps.sort((a, b) => a - b)
          resolve({
            frames: gaps.length,
            p50: +gaps[Math.floor(gaps.length * 0.5)].toFixed(1),
            p95: +gaps[Math.floor(gaps.length * 0.95)].toFixed(1),
            longTasks: long
          })
        }
      }
      requestAnimationFrame(tick)
    })
) })

console.log('playback', JSON.stringify(result.playback))
{
  const { profile } = await cdp.send('Profiler.stop')
  const self = new Map()
  const byId = new Map(profile.nodes.map((n) => [n.id, n]))
  const dt = profile.timeDeltas
  profile.samples.forEach((id, i) => {
    const n = byId.get(id)
    const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').pop()}:${n.callFrame.lineNumber}`
    self.set(k, (self.get(k) ?? 0) + (dt[i] ?? 0) / 1000)
  })
  if (process.env.PROFILE) console.log([...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([k, v]) => `${v.toFixed(0).padStart(6)}ms ${k}`).join('\n'))
}
// 2. Timeline drag: 60 pointer moves on a clip.
await ed(() => window.frameEditor.setPlayhead(0))
await win.evaluate(() => (document.querySelector('.tl-scroll').scrollLeft = 0))
const el = await win.$(`.clip[data-clip-id="${firstClip}"]`)
await el.scrollIntoViewIfNeeded()
const box = await el.boundingBox()
const x0 = box.x + Math.min(40, box.width / 2)
const y0 = box.y + box.height / 2
await win.mouse.move(x0, y0)
await win.mouse.down()
const before = await ed((id) => window.frameEditor.findClip(id).start, firstClip)
result.drag60Cpu = await cpu(async () => {
  for (let i = 1; i <= 60; i++) await win.mouse.move(x0 + i * 2, y0)
  await win.mouse.up()
})

// 3. Timeline scroll: 60 scroll steps.
result.dragMovedSeconds = (await ed((id) => window.frameEditor.findClip(id).start, firstClip)) - before
result.scroll60Cpu = await cpu(() => ed(async () => {
  const s = document.querySelector('.tl-scroll')
  const t = performance.now()
  for (let i = 0; i < 60; i++) {
    s.scrollLeft = i * 40
    s.dispatchEvent(new Event('scroll'))
    await new Promise((r) => requestAnimationFrame(r))
  }
  return +((performance.now() - t) / 60).toFixed(1)
}))

console.log(JSON.stringify(result, null, 2))
await ed(() => window.frameEditor.saveProject())
await app.close()
