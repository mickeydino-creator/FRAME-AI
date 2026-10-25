# FRAME AI: a video editor mod for Claude Code

FRAME AI adds a video editor pane beside your Claude Code conversation. Import video, image and audio files, preview frames, arrange clips on a multitrack timeline, add titles and subtitles, then ask Claude to edit in plain words ("cut the first two seconds", "add a title at the beginning"). Claude edits the real timeline through the mod's tools, in your existing Claude Code session, on your plan. No API key is needed and nothing is billed separately. FFmpeg renders the final MP4 on your computer.

## Requirements

- **Claude Code** with mods (function-hook plugins). This mod was built and tested on Claude Code 2.1.310. Check your version with `claude --version` and update it with `claude update`.
- **FFmpeg** with libx264. On Windows: `winget install Gyan.FFmpeg`, then restart Claude Code so `ffmpeg` is on PATH. Alternatively, set the FFmpeg path in `/config`.

## Install

From a folder, which works on Windows, macOS and Linux:

```
claude plugin marketplace add <path-to-the-FRAME-AI-repository>
claude plugin install frame-ai@frame-ai
```

To try it for one session only: `claude --plugin-dir <path>\mods\frame-ai`.

In the Claude desktop or web app, you can also save the `frame-ai.plugin` file you were given: press **Save plugin** on its card.

## Use

1. Type `/frame` to open the pane. To start a project, type `/frame new My Video`, or ask Claude to create one.
2. In the **Media** tab, paste a file or folder path and press Import. Files are referenced where they are and are never modified.
3. Press **Add** to place media on the timeline, or ask Claude. On the timeline:
   - Click a clip to select it.
   - Drag it to move it.
   - Drag its first or last cell to trim it.
   - Click the ruler to seek.
   - The arrow keys nudge the selected clip, **S** splits it and **Delete** removes it.
4. Edit the selected clip in the **Clip** tab: timing, opacity, scale, volume, fades, and text settings.
5. Type an instruction in the **Claude** tab, or in the normal prompt box. Claude reads the project, edits it, renders a frame to check its work, and reports what changed.
6. In the **Export** tab, choose the file, quality and size, then press **Export MP4**. Progress is shown live. Replacing an existing file asks first.

Projects are saved automatically to `~/FRAME AI Projects/<name>/project.json` (on Windows, `%USERPROFILE%\FRAME AI Projects`).

## Claude's tools

`get_project`, `new_project`, `open_project`, `list_projects`, `import_media`, `relink_media`, `add_clip`, `add_text`, `update_clip`, `move_clip` (`afterClipId` / `beforeClipId`), `trim_clip`, `split_clip`, `cut_range`, `delete_clips`, `add_subtitles`, `transcribe_audio`, `set_format`, `undo`, `redo`, `render_frame`, `export_mp4`.

A tool that fails reports the failure and its reason to Claude, never success. `cut_range`, `delete_clips` and replacing an export ask you first, unless you turn off "Ask before destructive edits" in `/config`.

## Settings (`/config`)

| Setting | Meaning |
|---|---|
| FFmpeg path / ffprobe path | Use these when FFmpeg is not on PATH |
| Projects folder | Where projects are saved |
| Title font file | The .ttf/.otf file for titles (default: Segoe UI or Arial on Windows) |
| Whisper model file | Enables automatic subtitles when FFmpeg 8 has the whisper filter |
| Ask before destructive edits | On by default |

## Limitations

- **Preview is frame by frame, not live video.** A pane can draw only text, buttons, inputs, an SVG picture (desktop) or an image (terminal), so there is no video element. The preview frame is rendered by FFmpeg at the playhead. **Play** steps through frames at a few per second without sound. For real playback, export a draft and press **Play the file** to open it in your system player.
- **No file picker.** Mods have no file dialog, so you paste a path, or ask Claude with the path.
- **Timeline in character cells.** The timeline is drawn in character cells on the terminal and the desktop app, with mouse dragging. VS Code and the mobile app show clips as buttons instead, and the mobile app has no text fields.
- **Desktop preview image is unverified.** On the desktop the frame is embedded as a JPEG inside an SVG. Whether every surface keeps embedded images was not verified live; where it does not, the pane shows the frame's file path instead.
- **The chat is the Claude Code conversation.** The Claude tab sends your message into this session, and the replies appear in the transcript, not inside the pane.
- **Subtitle sync needs local speech recognition.** Automatic sync needs FFmpeg 8 with whisper and a model file. Otherwise Claude adds subtitles from text and times you provide.
- **No apostrophes in paths.** Paths that FFmpeg reads for titles (the projects folder, the font) cannot contain an apostrophe.
