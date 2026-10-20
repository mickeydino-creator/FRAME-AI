import { protocol } from 'electron'
import { createReadStream, statSync } from 'node:fs'
import { extname, resolve, sep } from 'node:path'
import { Readable } from 'node:stream'
import { allowedRoots } from './projects'

export const MEDIA_SCHEME = 'frame-media'

const MIME: Record<string, string> = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  bmp: 'image/bmp',
  wav: 'audio/wav',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  flac: 'audio/flac',
  json: 'application/json'
}

/** Must run before app ready. */
export function registerMediaScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MEDIA_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true }
    }
  ])
}

function isAllowed(file: string): boolean {
  const abs = resolve(file)
  for (const root of allowedRoots) if (abs === root || abs.startsWith(root + sep)) return true
  return false
}

/**
 * Serves project files to the renderer with HTTP range support, which media
 * elements need for seeking. URL form: frame-media://file/<encodeURIComponent(absPath)>
 */
export function handleMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, (request) => {
    const url = new URL(request.url)
    const file = decodeURIComponent(url.pathname.slice(1))
    if (!isAllowed(file)) return new Response('Forbidden', { status: 403 })
    let size: number
    try {
      size = statSync(file).size
    } catch {
      return new Response('Not found', { status: 404 })
    }
    const type = MIME[extname(file).slice(1).toLowerCase()] ?? 'application/octet-stream'
    const range = request.headers.get('range')
    const headers: Record<string, string> = {
      'Content-Type': type,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
    if (range) {
      const m = /bytes=(\d*)-(\d*)/.exec(range)
      let start = m && m[1] ? parseInt(m[1], 10) : 0
      let end = m && m[2] ? parseInt(m[2], 10) : size - 1
      if (m && !m[1] && m[2]) {
        start = Math.max(0, size - parseInt(m[2], 10))
        end = size - 1
      }
      if (start >= size || end < start) {
        return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } })
      }
      end = Math.min(end, size - 1)
      const stream = Readable.toWeb(createReadStream(file, { start, end })) as ReadableStream
      return new Response(stream, {
        status: 206,
        headers: { ...headers, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': String(end - start + 1) }
      })
    }
    const stream = Readable.toWeb(createReadStream(file)) as ReadableStream
    return new Response(stream, { status: 200, headers: { ...headers, 'Content-Length': String(size) } })
  })
}
