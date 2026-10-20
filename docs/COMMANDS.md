# FRAME AI editing command layer

Every edit in FRAME AI goes through one documented layer, so a future local controller (for example a Claude Desktop + MCP server) can drive the editor exactly the way the UI does. This phase includes no AI integration. This document describes the layer that one would use.

```
UI components ─┐
               ├─► EditorAPI (src/renderer/src/editor/api.ts)
main bridge  ──┘        │  pure edits                        side effects
(src/main/bridge.ts)    ▼                                    ▼
                 dispatch(Command) ──► applyCommand()     IPC → main process
                 (undo history)        (src/shared/        (import, save, export,
                                        commands.ts)        FFmpeg)
```

* **Commands** (`src/shared/commands.ts`) are plain JSON objects applied by the pure function `applyCommand(project, command)`. It never mutates its input, throws a `CommandError` with a readable message on invalid input, and returns `{ project, result }`. `result` holds new ids (`clipId`, `trackId`, …).
* **EditorAPI** (`editor` in `src/renderer/src/editor/api.ts`) wraps commands with undo history and adds operations that touch the disk (import, save, export). In DevTools it is available as `window.frameEditor`.
* **Main-process bridge**: `executeEditorCommand(webContents, method, ...args)` in `src/main/bridge.ts` calls any EditorAPI method from the main process and resolves with its return value. That is the intended hook for a local MCP server.

The project state is fully serializable (`src/shared/types.ts`). Times are seconds. Positions are composition pixels measured from the frame center.

## EditorAPI methods

| Area | Method | Notes |
|---|---|---|
| State | `getProjectState()` | `{ project, projectDir, duration, playhead, selection, dirty, canUndo, canRedo }` |
| | `dispatch(command)` / `batch(commands)` | Apply raw commands; a batch is one undo step and is atomic |
| | `undo()` / `redo()` | |
| | `listMethods()` | Discovery |
| Project | `newProject(name, aspect, parentDir?)` | Creates the folder and `project.frameai` |
| | `openProject(dir?)` / `saveProject()` | `openProject` reports missing media |
| Media | `importMedia(paths?)` | Copies into `assets/`, probes, builds thumbnails, waveforms and proxies |
| | `relinkMedia(mediaId, path?)` / `removeMedia(mediaId)` | |
| Clips | `addMediaToTimeline(mediaId, {start, trackId, duration})` | Picks a free compatible track automatically |
| | `moveClip(clipId, start, trackId?)` | |
| | `trimClip(clipId, 'start'\|'end', time)` | Respects source media bounds |
| | `setClipTiming(clipId, {start, duration, sourceStart})` | |
| | `splitClip(clipId, time)` / `splitAtPlayhead()` | |
| | `deleteClips(ids)` / `duplicateClip(id, start?)` | |
| | `updateClip(clipId, patch)` | transform, text, shape, fill, volume, muted, fadeIn/Out, fit, name |
| | `setTransform`, `setVolume`, `setFades`, `addCrossfade(clipId, d)` | Shortcuts |
| Graphics | `addText(text, {start, duration, style, transform, animIn, animOut})` | |
| | `addTextPreset(id, start?)`, `addShape(shape, opts)`, `addBackground(fill, opts)`, `addBackgroundPreset(id)` | |
| | `applyTemplate('promo-intro'\|'sale-ad'\|'title-sequence', start?)` | Multi-layer motion template |
| | `setAnimation(clipId, 'in'\|'out', preset, duration?)` | |
| | `setKeyframe(clipId, prop, time, value, ease?)` / `removeKeyframe(...)` | `time` is relative to the clip start |
| Tracks | `addTrack(kind, name?)`, `removeTrack(id)`, `moveTrack(id, index)` | |
| Playback | `setPlayhead(t)`, `play()`, `pause()`, `select(ids)` | |
| Render | `renderPreviewFrame(time?, maxWidth?)` | PNG data URL of the composition |
| Export | `exportProject({outputPath, format, height, fps, quality, rangeStart, rangeEnd})` → jobId | |
| | `waitForExport(jobId)`, `cancelExport(jobId)` | |

## Commands

| type | fields |
|---|---|
| `setProjectName` | `name` |
| `setProjectSettings` | `aspect?` (`16:9`, `9:16`, `1:1`), `fps?` (24/25/30/50/60), `background?` |
| `addMedia` / `updateMedia` / `removeMedia` | `asset` / `mediaId, patch` / `mediaId` |
| `addTrack` | `kind`, `index?`, `name?`, `id?` |
| `removeTrack` / `moveTrack` / `updateTrack` | `trackId` (+ `index` / `patch: {name, muted, hidden, locked}`) |
| `addClip` | `clip: Partial<Clip> & {type}`, `trackId?`, `start?` |
| `addMediaClip` | `mediaId`, `trackId?`, `start?`, `duration?` |
| `addText` | `text?`, `style?`, `start?`, `duration?`, `trackId?`, `transform?`, `animIn?`, `animOut?` |
| `moveClip` | `clipId`, `start`, `trackId?` |
| `trimClip` | `clipId`, `edge`, `time` |
| `setClipTiming` | `clipId`, `start?`, `duration?`, `sourceStart?` |
| `splitClip` | `clipId`, `time` |
| `deleteClips` | `clipIds` |
| `duplicateClip` | `clipId`, `start?`, `trackId?` |
| `updateClip` | `clipId`, `patch` |
| `setAnimation` | `clipId`, `which`, `preset`, `duration?` |
| `setKeyframe` / `removeKeyframe` / `clearKeyframes` | `clipId`, `prop` (`x`,`y`,`scale`,`rotation`,`opacity`), `time`, `value`, `ease?` |
| `crossfade` | `clipId`, `duration` |
| `batch` | `commands` |

Animation presets: `none fade slide-left slide-right slide-up slide-down scale pop zoom rotate wipe-left wipe-right wipe-up wipe-down blur typewriter` (typewriter is text only).

Easing: `linear easeIn easeOut easeInOut hold`.

## Example

```js
const ed = window.frameEditor
const [video] = await ed.importMedia(['C:\\Videos\\shot.mp4'])
const { clipId } = ed.addMediaToTimeline(video.id, { start: 0 })
ed.splitClip(clipId, 4)
const title = ed.addText('Summer Sale', {
  start: 0.5, duration: 3,
  style: { fontSize: 140, color: '#ffd23f' },
  animIn: { preset: 'pop', duration: 0.6 }, animOut: { preset: 'fade' }
})
ed.setKeyframe(title.clipId, 'scale', 0, 1)
ed.setKeyframe(title.clipId, 'scale', 3, 1.2)
const job = await ed.exportProject({ outputPath: 'C:\\Videos\\out.mp4', height: 1080 })
await ed.waitForExport(job)
```

## Assistant panel seam

The AI Assistant panel (`src/renderer/src/components/AssistantPanel.tsx`) talks only to an `AssistantProvider` (`src/renderer/src/assistant/provider.ts`):

* `setProvider(provider)` registers a backend. The default `disconnectedProvider` sends nothing.
* `provider.send({ messages, context }, signal)` streams `text`, `tool`, `error` and `done` events. `context` comes from `summarizeEditorState()`.
* Tool calls must run through `runEditorTool(method, args)`, which calls the EditorAPI above, so every assistant edit is a normal undoable command.
* Conversation history is stored per project in local storage (`src/renderer/src/assistant/store.ts`).
