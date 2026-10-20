// Generates small test media files with FFmpeg (used by the e2e test).
import { execFileSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

const out = process.argv[2] ?? 'test-output/fixtures'
mkdirSync(out, { recursive: true })
const ff = (args) => execFileSync(process.env.FRAME_AI_FFMPEG ?? 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args])

ff(['-f', 'lavfi', '-i', 'testsrc2=size=1280x720:rate=30:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=6',
  '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', join(out, 'clip-h264.mp4')])
ff(['-f', 'lavfi', '-i', 'smptebars=size=640x480:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=660:duration=4',
  '-c:v', 'prores_ks', '-c:a', 'pcm_s16le', join(out, 'clip-prores.mov')])
ff(['-f', 'lavfi', '-i', 'mandelbrot=size=640x360:rate=25', '-t', '3', '-c:v', 'libvpx-vp9', '-b:v', '1M', join(out, 'clip-vp9.webm')])
ff(['-f', 'lavfi', '-i', 'color=c=0x2266ff:size=800x800', '-vf', "drawbox=x=200:y=200:w=400:h=400:color=yellow:t=fill", '-frames:v', '1', join(out, 'image.png')])
ff(['-f', 'lavfi', '-i', 'testsrc=size=1024x768', '-frames:v', '1', join(out, 'photo.jpg')])
ff(['-f', 'lavfi', '-i', 'sine=frequency=220:duration=8', '-c:a', 'pcm_s16le', join(out, 'tone.wav')])
ff(['-f', 'lavfi', '-i', 'anoisesrc=d=5:c=pink:a=0.2', '-c:a', 'libmp3lame', join(out, 'music.mp3')])
console.log('fixtures written to', out)
