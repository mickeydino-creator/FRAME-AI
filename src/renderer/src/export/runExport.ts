/**
 * Runs inside the hidden export window. Decoded video frames come from FFmpeg
 * (main process), are composited with the same compositor as the preview, and
 * the finished RGBA frames are streamed back to the FFmpeg encoder.
 */
import { findMedia } from '../../../shared/project'
import type { Clip, MediaAsset } from '../../../shared/types'
import { activeVisualClips, fontString, renderFrame, VisualSource } from '../engine/compositor'
import { mediaUrl } from '../engine/paths'

export async function runExport(): Promise<void> {
  const api = window.frameAPI.export
  const job = await api.getJob()
  const { project, projectDir, jobId, width, height, options } = job
  try {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false })
    if (!ctx) throw new Error('Could not create a 2D canvas for rendering.')
    const scale = width / project.settings.width

    // Preload still images.
    const images = new Map<string, HTMLImageElement>()
    for (const clip of project.clips) {
      if (clip.type !== 'image') continue
      const asset = findMedia(project, clip.mediaId)
      if (!asset || images.has(asset.id)) continue
      if (asset.missing) throw new Error(`Image is missing: ${asset.name}`)
      const img = new Image()
      img.crossOrigin = 'anonymous'
      img.src = mediaUrl(projectDir, asset.file)
      try {
        await img.decode()
      } catch {
        throw new Error(`Could not load image ${asset.name}.`)
      }
      images.set(asset.id, img)
    }
    // Make sure every font used by text layers is ready before the first frame.
    await Promise.all(
      project.clips.filter((c) => c.text).map((c) => document.fonts.load(fontString(c.text!)).catch(() => []))
    )

    const frames = new Map<string, ImageBitmap>()
    const source: VisualSource = {
      get(clip: Clip, asset: MediaAsset) {
        if (clip.type === 'image') return images.get(asset.id) ?? null
        return frames.get(clip.id) ?? null
      }
    }

    for (let f = 0; f < job.totalFrames; f++) {
      const t = job.rangeStart + f / options.fps
      for (const clip of activeVisualClips(project, t)) {
        if (clip.type !== 'video') continue
        const asset = findMedia(project, clip.mediaId)
        if (!asset || asset.missing) continue
        const srcT = (clip.sourceStart ?? 0) + (t - clip.start)
        const raw = await api.nextVideoFrame(jobId, clip.id, srcT)
        if (!raw) continue
        const pixels = new Uint8ClampedArray(raw.data.buffer as ArrayBuffer, raw.data.byteOffset, raw.data.byteLength)
        frames.set(clip.id, await createImageBitmap(new ImageData(pixels, raw.width, raw.height)))
      }
      renderFrame(ctx, project, t, source, { scale })
      const data = ctx.getImageData(0, 0, width, height).data
      await api.writeFrame(jobId, new Uint8Array(data.buffer, data.byteOffset, data.byteLength))
      for (const [id, bmp] of frames) {
        bmp.close()
        frames.delete(id)
      }
    }
    await api.finishFrames(jobId)
  } catch (e) {
    await api.fail(jobId, (e as Error).message || String(e))
  }
}
