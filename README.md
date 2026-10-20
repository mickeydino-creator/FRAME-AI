# FRAME AI

FRAME AI is a local desktop video editor for Windows, built with Electron, React, TypeScript and FFmpeg. Everything runs on your computer. There is no account, cloud service or API key.

> This phase covers only the editor itself. AI control is planned for a later phase, and the editing command layer it will use is already in place (see [docs/COMMANDS.md](docs/COMMANDS.md)).

## Features

- **Media library**: import MP4, MOV, WebM, MKV, PNG, JPG, WebP, WAV, MP3, M4A, OGG and FLAC using the button or drag-and-drop. Files are copied into the project, and thumbnails, durations and audio waveforms are generated. Media in codecs Chromium can't play (ProRes, HEVC, PCM-in-MOV, AVI…) gets an H.264 preview proxy automatically. Unreadable files show a clear error.
- **Preview**: the real composition at the playhead, with play/pause, frame stepping and timecode. Aspect ratios are 16:9, 9:16 and 1:1, with fit and zoom levels and a Full/Half/Quarter preview resolution. You can drag layers directly in the frame.
- **Timeline**: multiple video and audio tracks, drag-and-drop from the library, moving clips (including across tracks), edge trimming and split at the playhead (S). Also delete, duplicate, snapping, zoom (Ctrl+wheel), track reorder, rename, mute, hide, lock and delete. Each clip type has its own color, with thumbnails, waveforms and markers for fades, animations and keyframes.
- **Properties**: timing (start, end, duration, source in) and transform (position, scale, rotation, opacity) with per-property keyframes. Also fit mode, volume (0-200%), mute, fade in/out, and in/out animations and transitions.
- **Text and motion graphics**: text with font, size, weight, italic, uppercase, alignment, color, line height, letter spacing, wrapping, outline, shadow and a background box. There are 16 animation presets: fade, slide, scale, pop, zoom, rotate, wipe, blur and typewriter. Also shapes (rectangle, ellipse, triangle, line, star), solid and gradient backgrounds, and 3 motion templates (Promo Intro, Sale Ad, Title Sequence).
- **Transitions**: in/out transition presets on any visual clip, plus a true cross-dissolve (picture and audio) from the previous clip on the track.
- **Undo/redo** for every edit, including drags, which count as one step each.
- **Projects**: a versioned JSON project folder with copied assets. When you reopen a project it detects missing files, recovers them from the original location when possible, and otherwise offers Relink. A recent-projects list is included.
- **Export**: MP4 (H.264/AAC) or WebM (VP9/Opus) at project size, 720p or 480p. You choose 24-60 fps and the quality. Rendering runs in a hidden window and FFmpeg processes, so the editor stays responsive. It shows progress and an ETA, and can be cancelled.

## Install and run on Windows (from source)

1. Install **Node.js 20 or newer** (LTS) from https://nodejs.org.
2. Install **Git**, or download this repository as a ZIP.
3. In PowerShell:
   ```powershell
   git clone https://github.com/mickeydino-creator/FRAME-AI.git
   cd FRAME-AI
   npm install
   npm run build
   npm start
   ```
   For development with hot reload, use `npm run dev`.

### FFmpeg

`npm install` downloads Windows FFmpeg/ffprobe binaries through the `ffmpeg-static` and `ffprobe-static` packages, so you usually don't need to do anything. FRAME AI looks for FFmpeg in this order:

1. the environment variables `FRAME_AI_FFMPEG` / `FRAME_AI_FFPROBE` (full paths to the `.exe` files)
2. the bundled binaries (in the installer build: `resources\ffmpeg\`)
3. the `ffmpeg` / `ffprobe` on your `PATH`

If FFmpeg can't be found, the start screen says so, and import and export show an explanatory error. To fix it, install FFmpeg (for example `winget install Gyan.FFmpeg`) or set the variables above.

### Build a Windows installer

```powershell
npm run dist:win
```

This creates an NSIS installer and a portable `.exe` in `release\`. Run it on Windows so the Windows FFmpeg binaries get bundled.

## Using FRAME AI

1. On the start screen, enter a name, pick 16:9, 9:16 or 1:1, and click **Create project**. Projects are saved under `Documents\FRAME AI Projects\<name>\`.
2. Click **Import media**, or drop files onto the Media panel.
3. Drag media onto a track, or double-click it to add it at the playhead.
4. Switch to **Text & Graphics** to add titles, shapes, backgrounds or a motion template.
5. Select a clip and edit it in **Properties**. Click the ◆ next to a transform value to keyframe it at the playhead.
6. Press **Ctrl+S** to save, and click **Export** to render a video file.

Keyboard shortcuts: Space plays/pauses. ← → step one frame (Shift: 1 s). ↑ ↓ jump to the previous/next edit. S splits. Del deletes. Ctrl+D duplicates. Ctrl+Z undoes and Ctrl+Y / Ctrl+Shift+Z redo. +/− zoom the timeline. Home/End go to the start/end.

## Project format

```
My Project\
  project.frameai      versioned JSON (format "frame-ai-project", version 1)
  project.frameai.bak  previous save
  assets\              copied source media
  proxies\             preview proxies for codecs Chromium can't decode
  thumbs\              thumbnails
  waveforms\           audio peak data
```

## Architecture

| Path | Role |
|---|---|
| `src/shared/types.ts` | Serializable project model |
| `src/shared/commands.ts` | Pure, undoable editing commands |
| `src/shared/animation.ts` | Keyframe interpolation, easing, animation presets, fades |
| `src/shared/audioMix.ts` | FFmpeg audio mix graph (volume, fades, offsets) |
| `src/renderer/src/engine/compositor.ts` | Canvas compositor, **shared by preview and export** so they match |
| `src/renderer/src/engine/preview.ts` | Playback engine (media element sync, Web Audio gain) |
| `src/renderer/src/editor/api.ts` | EditorAPI command layer (`window.frameEditor`) |
| `src/renderer/src/export/runExport.ts` | Frame renderer that runs in the hidden export window |
| `src/main/exporter.ts` | Export orchestration: FFmpeg decode → composite → encode |
| `src/main/media.ts` | Import: probe, copy, thumbnail, waveform, proxy |
| `src/main/projects.ts` | Save/open, missing-media recovery, recent list |
| `src/main/mediaProtocol.ts` | `frame-media://` file protocol with range requests |
| `src/main/bridge.ts` | Main-process entry point into EditorAPI (for future local automation) |

Export pipeline:
1. FFmpeg mixes all audio into a temporary WAV.
2. A hidden window renders each frame with the compositor, using frames decoded exactly by FFmpeg.
3. The raw frames are piped into an FFmpeg H.264/VP9 encoder and muxed with the audio.

## Tests

```bash
npm test            # unit tests (command layer, animation, audio mix, timecode)
npm run build
npm run test:e2e    # launches the real app, imports, edits, saves/reopens, exports and checks the result with ffprobe
```

## Known limitations

- Playback speed changes, color correction, masks and audio effects other than volume and fades are not implemented yet.
- Keyframes cover position, scale, rotation and opacity. Audio volume can't be keyframed, only faded.
- Export is CPU-bound (canvas compositing plus x264). Expect roughly real-time speed for 720p and slower for 1080p.
- Preview of very long timelines with many simultaneous videos depends on Chromium's decoder; use Half or Quarter preview quality on slower machines.
- Fonts come from the system. A project that uses a font missing on another computer falls back to Segoe UI or Arial.
- The Windows installer build has been configured but was not built or tested on Windows in this phase. Development and testing were done on Linux.
