// Renders resources/icon.svg (and icon-small.svg) to the PNG/ICO files used by
// the app window, the Windows executable and the installer. Run after editing the SVGs.
import { execFileSync } from 'node:child_process'
import { readFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { chromium } from 'playwright-core'

const root = resolve(import.meta.dirname, '..')
const out = join(root, 'build')
mkdirSync(out, { recursive: true })
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--no-sandbox'] })
const page = await browser.newPage()
async function render(svgFile, size, file) {
  const svg = readFileSync(join(root, 'resources', svgFile), 'utf8')
  await page.setViewportSize({ width: size, height: size })
  await page.setContent(`<html><body style="margin:0;background:transparent">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`)
  await page.screenshot({ path: join(out, file), omitBackground: true })
}
await render('icon.svg', 1024, 'icon.png')
await render('icon.svg', 256, 'icon-256.png')
for (const s of [16, 24, 32, 48]) await render('icon-small.svg', s, `icon-${s}.png`)
// NSIS installer artwork: welcome/finish sidebar (164x314) and page header (150x57).
const mark = readFileSync(join(root, 'resources', 'icon.svg'), 'utf8')
async function art(w, h, html, file) {
  await page.setViewportSize({ width: w, height: h })
  await page.setContent(`<html><body style="margin:0;width:${w}px;height:${h}px;overflow:hidden;font-family:Inter,'Segoe UI',Arial,sans-serif">${html}</body></html>`)
  await page.screenshot({ path: join(out, file) })
}
const word = (color) => `<span style="font-weight:800;letter-spacing:.12em;color:${color}">FRAME<span style="color:#3d8bff;margin-left:.3em">AI</span></span>`
await art(164, 314, `<div style="height:100%;background:#111114;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:16px">
  ${mark.replace('<svg ', '<svg width="84" height="84" ')}
  <div style="font-size:17px">${word('#ececef')}</div>
  <div style="font-size:11px;color:#8d8d98">Video editor</div></div>`, 'installer-sidebar.png')
await art(150, 57, `<div style="height:100%;background:#fff;display:flex;align-items:center;justify-content:flex-end;gap:8px;padding-right:10px">
  <div style="font-size:12px">${word('#111114')}</div>${mark.replace('<svg ', '<svg width="36" height="36" ')}</div>`, 'installer-header.png')
await browser.close()
// Assemble a multi-resolution .ico (small sizes use the heavier variant).
execFileSync('python3', ['-I', '-c', `
from PIL import Image
d = ${JSON.stringify(out)}
big = Image.open(d + '/icon.png')
imgs = [Image.open(f'{d}/icon-{s}.png') for s in (16, 24, 32, 48)]
imgs += [big.resize((s, s), Image.LANCZOS) for s in (64, 128, 256)]
imgs[-1].save(d + '/icon.ico', sizes=[(i.width, i.height) for i in imgs], append_images=imgs[:-1])
for name in ('installer-sidebar', 'installer-header'):
    Image.open(f'{d}/{name}.png').convert('RGB').save(f'{d}/{name}.bmp')
`])
console.log('icons written to', out)
