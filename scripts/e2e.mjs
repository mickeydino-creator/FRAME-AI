// End-to-end test: launches the built Electron app, drives it through the
// editor command layer (window.frameEditor) and the UI, then verifies the
// exported video with ffprobe. Run `npm run build` first.
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync, unlinkSync } from 'node:fs'
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
const home = join(outDir, 'home')
const projectsParent = join(outDir, 'projects')
rmSync(home, { recursive: true, force: true })
rmSync(projectsParent, { recursive: true, force: true })
mkdirSync(home, { recursive: true })
mkdirSync(projectsParent, { recursive: true })
if (!existsSync(join(fixtures, 'clip-h264.mp4'))) execFileSync(process.execPath, [join(root, 'scripts/make-fixtures.mjs'), fixtures], { stdio: 'inherit' })

let failures = 0
function check(cond, msg) {
  if (cond) console.log(`  ✓ ${msg}`)
  else {
    failures++
    console.log(`  ✗ ${msg}`)
  }
}

function probe(file) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file]).toString())
}

const app = await electron.launch({
  executablePath: require('electron'),
  args: [join(root, 'out/main/index.js'), ...(process.getuid?.() === 0 ? ['--no-sandbox'] : [])],
  env: { ...process.env, HOME: home, FRAME_AI_NO_SANDBOX: '1', ELECTRON_RENDERER_URL: '' },
  timeout: 60000
})
const logs = []
const win = await app.firstWindow()
win.on('console', (m) => logs.push(`[${m.type()}] ${m.text()}`))
win.on('pageerror', (e) => logs.push(`[pageerror] ${e.message}`))
await win.setViewportSize?.({ width: 1600, height: 940 }).catch(() => undefined)
await win.waitForSelector('.start-card', { timeout: 30000 })
await win.screenshot({ path: join(outDir, 'screen-start.png') })

const ed = (fn, ...args) => win.evaluate(fn, ...args)

try {
  console.log('Project + import')
  const dir = await ed((p) => window.frameEditor.newProject('E2E Project', '16:9', p), projectsParent)
  check(existsSync(join(dir, 'project.frameai')), 'project folder created with project.frameai')
  await win.waitForSelector('.timeline')
  const files = ['clip-h264.mp4', 'clip-prores.mov', 'clip-vp9.webm', 'image.png', 'photo.jpg', 'tone.wav', 'music.mp3'].map((f) => join(fixtures, f))
  const assets = await ed((paths) => window.frameEditor.importMedia(paths), files)
  check(assets.length === 7, `imported 7 files (got ${assets.length})`)
  const byName = Object.fromEntries(assets.map((a) => [a.name, a]))
  check(byName['clip-prores.mov']?.proxy, 'ProRes MOV got an H.264 preview proxy')
  check(byName['clip-h264.mp4']?.thumbnail && byName['clip-h264.mp4']?.waveform, 'thumbnail and waveform generated')
  check(byName['image.png']?.type === 'image' && byName['tone.wav']?.type === 'audio', 'media types classified')
  const bad = join(outDir, 'not-media.mp4')
  writeFileSync(bad, 'this is not a video')
  const badRes = await ed((p) => window.frameEditor.importMedia([p]), bad)
  check(badRes.length === 0, 'corrupt file rejected without crashing')

  console.log('Timeline editing')
  const r1 = await ed((id) => window.frameEditor.addMediaToTimeline(id, { start: 0 }), byName['clip-h264.mp4'].id)
  const r2 = await ed((id) => window.frameEditor.addMediaToTimeline(id, { start: 6 }), byName['clip-prores.mov'].id)
  const r3 = await ed((id) => window.frameEditor.addMediaToTimeline(id, { start: 10, duration: 3 }), byName['image.png'].id)
  const r4 = await ed((id) => window.frameEditor.addMediaToTimeline(id, { start: 0 }), byName['music.mp3'].id)
  await ed((id) => window.frameEditor.setVolume(id, 0.4), r4.clipId)
  await ed((id) => window.frameEditor.setFades(id, 1, 1), r4.clipId)
  const split = await ed((id) => window.frameEditor.splitClip(id, 3), r1.clipId)
  check(split.clipIds?.length === 2, 'split clip in two')
  await ed((id) => window.frameEditor.trimClip(id, 'end', 5.5), split.clipId)
  await ed(([id, track]) => window.frameEditor.moveClip(id, 5.5, track), [r2.clipId, (await ed(() => window.frameEditor.getProjectState().project.clips[0].trackId))])
  await ed((id) => window.frameEditor.addCrossfade(id, 0.5), r2.clipId)
  await ed((id) => window.frameEditor.setTransform(id, { scale: 0.6, rotation: 8, x: 300 }), r3.clipId)
  await ed((id) => window.frameEditor.setAnimation(id, 'in', 'slide-left', 0.6), r3.clipId)
  const t = await ed(() =>
    window.frameEditor.addText('FRAME AI', {
      start: 0.5,
      duration: 4,
      style: { fontSize: 120, color: '#ffd23f', strokeWidth: 4 },
      animIn: { preset: 'pop', duration: 0.6 },
      animOut: { preset: 'fade', duration: 0.5 }
    })
  )
  await ed((id) => window.frameEditor.setKeyframe(id, 'y', 0, -200, 'easeOut'), t.clipId)
  await ed((id) => window.frameEditor.setKeyframe(id, 'y', 2, 0, 'easeOut'), t.clipId)
  await ed(() => window.frameEditor.addShape({ shape: 'star' }, { start: 9, duration: 2, transform: { x: -500 } }))
  await ed(() => window.frameEditor.applyTemplate('promo-intro', 13))
  const state = await ed(() => window.frameEditor.getProjectState())
  check(state.duration > 17, `timeline duration ${state.duration.toFixed(2)}s`)
  check(state.project.clips.length >= 11, `${state.project.clips.length} clips on the timeline`)

  console.log('Undo / redo')
  const before = state.project.clips.length
  await ed(() => window.frameEditor.undo())
  const afterUndo = (await ed(() => window.frameEditor.getProjectState())).project.clips.length
  await ed(() => window.frameEditor.redo())
  const afterRedo = (await ed(() => window.frameEditor.getProjectState())).project.clips.length
  check(afterUndo < before && afterRedo === before, `undo removed template (${before}→${afterUndo}), redo restored (${afterRedo})`)

  console.log('Preview')
  const png = await ed(() => window.frameEditor.renderPreviewFrame(1.2, 960))
  writeFileSync(join(outDir, 'preview-frame.png'), Buffer.from(png.split(',')[1], 'base64'))
  check(png.length > 20000, `preview frame rendered (${Math.round(png.length / 1024)} KB)`)
  const png2 = await ed(() => window.frameEditor.renderPreviewFrame(14.5, 960))
  writeFileSync(join(outDir, 'preview-template.png'), Buffer.from(png2.split(',')[1], 'base64'))
  await ed(() => window.frameEditor.setPlayhead(1.2))
  await ed((id) => window.frameEditor.select([id]), t.clipId)
  await win.waitForTimeout(800)
  await win.screenshot({ path: join(outDir, 'screen-editor.png') })
  await ed(() => window.frameEditor.play())
  await win.waitForTimeout(1200)
  await ed(() => window.frameEditor.pause())
  const ph = (await ed(() => window.frameEditor.getProjectState())).playhead
  check(ph > 1.6, `playback advanced the playhead (to ${ph.toFixed(2)}s)`)

  console.log('UI interactions')
  // Split via keyboard at the playhead on the selected clip and undo it.
  await win.click('.preview-stage')
  const n0 = (await ed(() => window.frameEditor.getProjectState())).project.clips.length
  await ed(() => window.frameEditor.setPlayhead(2))
  await ed((id) => window.frameEditor.select([id]), t.clipId)
  await win.keyboard.press('s')
  const n1 = (await ed(() => window.frameEditor.getProjectState())).project.clips.length
  await win.keyboard.press('Control+z')
  const n2 = (await ed(() => window.frameEditor.getProjectState())).project.clips.length
  check(n1 === n0 + 1 && n2 === n0, 'keyboard split (S) and undo (Ctrl+Z)')
  // Drag a clip in the timeline.
  const clipEl = await win.$(`.clip[data-clip-id="${r3.clipId}"]`)
  const box = await clipEl.boundingBox()
  await win.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await win.mouse.down()
  await win.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2, { steps: 6 })
  await win.mouse.up()
  const moved = (await ed(() => window.frameEditor.getProjectState())).project.clips.find((c) => c.id === r3 && false)
  const img = await ed((id) => window.frameEditor.findClip(id), r3.clipId)
  check(img.start > 10.2, `dragging a clip moved it (start ${img.start.toFixed(2)}s)`)
  void moved

  console.log('AI Assistant panel')
  check(await win.isVisible('.assistant'), 'assistant panel is open')
  check((await win.$$('.suggestion')).length === 4, 'suggested prompts shown for an empty conversation')
  await win.click('.suggestion >> nth=0')
  check((await win.inputValue('.compose-box textarea')) === 'Create a cinematic intro.', 'suggestion fills the input')
  await win.click('.send-btn')
  check((await win.$$('.msg.user')).length === 1, 'message added to history')
  check((await win.$$('.msg.assistant')).length === 0, 'no fake assistant reply')
  check(await win.isVisible('.assistant-note'), 'not-connected note shown')
  await win.click('[aria-label="Collapse AI Assistant"]')
  check(await win.isVisible('.assistant-rail'), 'panel collapses to a rail')
  await win.keyboard.press('Control+j')
  check(await win.isVisible('.assistant'), 'Ctrl+J reopens the panel')

  console.log('Save / reopen')
  await ed(() => window.frameEditor.saveProject())
  const opened = await ed((d) => window.frameEditor.openProject(d), dir)
  check(opened.project.clips.length === before, 'reopened project has every clip')
  check(opened.missing.length === 0, 'no missing media after reopen')
  await win.waitForSelector('.msg.user')
  check((await win.$$('.msg.user')).length === 1, 'assistant history restored with the project')

  console.log('Export (MP4)')
  const out = join(outDir, 'export.mp4')
  rmSync(out, { force: true })
  const t0 = Date.now()
  const jobId = await ed((p) => window.frameEditor.exportProject({ outputPath: p, height: 720, quality: 'medium' }), out)
  const done = await ed((id) => window.frameEditor.waitForExport(id), jobId)
  const secs = (Date.now() - t0) / 1000
  check(done.phase === 'done', `export finished in ${secs.toFixed(1)}s`)
  const info = probe(out)
  const v = info.streams.find((s) => s.codec_type === 'video')
  const a = info.streams.find((s) => s.codec_type === 'audio')
  const dur = Number(info.format.duration)
  const projDur = (await ed(() => window.frameEditor.getProjectState())).duration
  check(v?.codec_name === 'h264' && v.width === 1280 && v.height === 720, `video stream h264 ${v?.width}x${v?.height}`)
  check(a?.codec_name === 'aac', 'audio stream aac')
  check(Math.abs(dur - projDur) < 0.15, `duration ${dur.toFixed(2)}s matches timeline ${projDur.toFixed(2)}s`)
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '1.2', '-i', out, '-frames:v', '1', join(outDir, 'export-frame-1.2s.png')])
  execFileSync('ffmpeg', ['-v', 'error', '-y', '-ss', '14.5', '-i', out, '-frames:v', '1', join(outDir, 'export-frame-14.5s.png')])
  const vol = execFileSync('ffmpeg', ['-hide_banner', '-ss', '1', '-t', '2', '-i', out, '-af', 'volumedetect', '-f', 'null', '-'], { stdio: ['ignore', 'pipe', 'pipe'] })
  void vol

  console.log('Export (WebM, range)')
  const outW = join(outDir, 'export.webm')
  const jobW = await ed((p) => window.frameEditor.exportProject({ outputPath: p, format: 'webm', height: 480, rangeStart: 2, rangeEnd: 5, quality: 'low' }), outW)
  await ed((id) => window.frameEditor.waitForExport(id), jobW)
  const infoW = probe(outW)
  check(infoW.streams.some((s) => s.codec_name === 'vp9') && infoW.streams.some((s) => s.codec_name === 'opus'), 'webm has vp9 + opus')
  check(Math.abs(Number(infoW.format.duration) - 3) < 0.15, `range export is 3s (${Number(infoW.format.duration).toFixed(2)}s)`)

  console.log('Export cancel')
  const outC = join(outDir, 'export-cancel.mp4')
  const jobC = await ed((p) => window.frameEditor.exportProject({ outputPath: p }), outC)
  await win.waitForTimeout(1500)
  await ed((id) => window.frameEditor.cancelExport(id), jobC)
  await win.waitForTimeout(800)
  check(!existsSync(outC), 'cancelled export removed partial file')

  console.log('Missing media')
  await ed(() => window.frameEditor.saveProject())
  const st = await ed(() => window.frameEditor.getProjectState())
  const wav = st.project.media.find((m) => m.name === 'tone.wav')
  unlinkSync(join(dir, wav.file))
  const tmpOrig = join(outDir, 'tone-moved.wav')
  rmSync(tmpOrig, { force: true })
  execFileSync('mv', [wav.originalPath, tmpOrig])
  const reopened = await ed((d) => window.frameEditor.openProject(d), dir)
  check(reopened.missing.includes('tone.wav'), 'missing file detected on open')
  const relinked = await ed(([id, p]) => window.frameEditor.relinkMedia(id, p), [wav.id, tmpOrig])
  check(relinked && !relinked.missing, 'relinked missing media')
  execFileSync('mv', [tmpOrig, wav.originalPath])
} catch (e) {
  failures++
  console.error('E2E error:', e)
} finally {
  await win.screenshot({ path: join(outDir, 'screen-final.png') }).catch(() => undefined)
  const errs = logs.filter((l) => l.startsWith('[error]') || l.startsWith('[pageerror]'))
  if (errs.length) console.log('Renderer errors:\n' + errs.join('\n'))
  await ed(() => window.frameEditor.saveProject()).catch(() => undefined)
  const proc = app.process()
  await Promise.race([app.close(), new Promise((r) => setTimeout(r, 5000))])
  proc.kill('SIGKILL')
}
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll e2e checks passed')
process.exit(failures ? 1 : 0)
