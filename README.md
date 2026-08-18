# Ordinary Recorder

Windows desktop recorder (Electron) built for smooth 60fps capture with a
low CPU footprint. v2 records the whole desktop — games and any software —
with optional exclusive-fullscreen game capture, instant replay, and a clips
library.

Capture uses FFmpeg Desktop Duplication (`ddagrab`) plus a hardware encoder
when one is available:

- **NVIDIA** → NVENC (`h264_nvenc` / `hevc_nvenc` / `av1_nvenc`)
- **AMD** → AMF (`h264_amf` / `hevc_amf` when the GPU supports it)
- **Intel** → Quick Sync (`h264_qsv` / `hevc_qsv`)
- **None** → `libx264` software encode

Exclusive fullscreen games that block Desktop Duplication switch to a hidden
Chromium window (Windows Graphics Capture + WebCodecs) using the same codec
family. If hardware capture fails, the app falls back to `gdigrab` + `libx264`.

## 1. Install Node.js
Download from https://nodejs.org (LTS version). This gives you `node` and `npm`.

## 2. Get FFmpeg
You need a Windows build of FFmpeg that includes `ddagrab` and hardware
encoders (the standard "full" builds from gyan.dev do):

1. Download the "full" build (not "essentials") from:
   https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-full.7z)
2. Extract it, find `ffmpeg.exe` inside the `bin` folder.
3. Inside this project, create a folder called `ffmpeg/` and put `ffmpeg.exe`
   inside it: `screen-recorder/ffmpeg/ffmpeg.exe`
   (Alternative: add ffmpeg's `bin` folder to your system PATH instead —
   the app checks PATH automatically if it can't find the bundled copy.)

## 3. Install dependencies
Open a terminal in this folder and run:
```
npm install
```

## 4. Run it
```
npm start
```

On first launch a hardware profile wizard classifies the PC (low / mid / high)
and sets resolution, fps, and replay-buffer defaults. After that a control
panel opens. Hit **Start Recording**, or use the hotkey **Ctrl+Shift+R** from
anywhere (works even if the window is hidden in the tray).

The app stays in the tray when you close the window. Quit from the tray menu.

## 5. What you can do
- **Record / stop / pause / resume** the whole desktop
- **Instant replay** — rolling buffer (1–5 min, RAM-capped). Save the last
  30s–5 min with **Ctrl+Shift+I** (or the Clips page)
- **Exclusive fullscreen / game capture** — if a game takes over the screen,
  press the record hotkey while that game is in front
- **Audio** — WASAPI loopback when it works (no Stereo Mix required). Test
  Audio in Settings. Per-source Game/Mic meters while recording
- **Hotkeys** — click a shortcut, then press the new keys. Defaults:
  Ctrl+Shift+R record, Ctrl+Shift+P pause, Ctrl+Shift+I clip,
  Ctrl+Shift+B bookmark a moment in the replay buffer
- **Clips library** — open, show in folder, trim (fast stream-copy, or
  frame-accurate re-encode). Replay bookmarks are saved as a `.json` sidecar
  (and chapter markers when ffmpeg can copy them)
- **Encoder override** — Auto, NVIDIA NVENC, AMD AMF, Intel Quick Sync, or
  software x264. H.265 / AV1 appear when the GPU encoder actually works

Files are saved as `recording-<timestamp>.mp4` in the folder you pick
(Videos by default). While a take is in progress the encoder writes Matroska
(`.mkv`) or, for Chromium game capture, WebM — both survive a crash. A clean
stop remuxes to `.mp4` with no re-encode. Leftover files from a killed session
are recovered automatically on the next launch.

Trimmed clips are new files; originals are never overwritten.

## 6. Settings (in the app)
- **Frame rate**: 30, 60, or 144 fps
- **Output resolution**: native, 1440p, 1080p, or 720p
- **Hardware encoder / codec**: auto-detected, with a manual override. H.264
  is the default. H.265 is offered only when NVENC / AMF / QSV HEVC probed
  successfully — that is the real space saver versus H.264. **Smaller Files**
  is a bitrate cap on top of the selected codec (it does not switch to HEVC
  by itself).
- **Game Capture / Exclusive Fullscreen**: keep these on to also catch games
  that take over the display
- **Game Audio + Audio Device**: WASAPI loopback is preferred when FFmpeg can
  open it. Stereo Mix / VB-CABLE are fallbacks only. Use **Test Audio** to
  hear a 3-second capture before a real take
- **Instant Replay buffer**: length is capped from system RAM and current
  resolution/fps. The UI shows estimated RAM use as you change those settings.
  Bookmark moments with Ctrl+Shift+B while the buffer is live; they are stored
  with the next saved clip
- **Save to**: pick the output folder
- **Disk reserve**: stop a take (and remux it) before the output drive fills
  up. Default is 500 MB free; a warning appears in the Recorder page first
- **Capture fallbacks**: games that blocked Desktop Duplication are remembered
  and skip straight to Chromium/WGC next time. Remove a title in Settings to
  retry the desktop path after a driver update

A startup diagnostics log (GPU, RAM, selected encoder and why, plus disk
reserve and remembered games) is written next to the settings file in the app
userData folder (`diagnostics.log`).

## 7. Build a standalone .exe (optional)
Once you're happy with it:
```
npm run build
```
This uses `electron-builder` to produce a portable `.exe` in the `dist/`
folder. Make sure the `ffmpeg/` folder with `ffmpeg.exe` sits next to it,
or is on PATH.

## Notes on audio capture
Windows doesn't always expose "Stereo Mix" by default. To enable it:
1. Right-click the speaker icon in the taskbar → Sounds → Recording tab
2. Right-click empty space → "Show Disabled Devices"
3. Enable "Stereo Mix" if it appears

If it's not available on your audio driver, a virtual audio cable app
(e.g. VB-Audio Virtual Cable, free) works as a drop-in replacement — pick it
in **Audio Device**. The app prefers WASAPI loopback when FFmpeg supports it,
so many machines need no extra device.

## How it stays lightweight
- **ddagrab**: captures frames via Windows' GPU-based Desktop Duplication
  API instead of CPU-based screen scraping (`gdigrab`). If your FFmpeg build
  doesn't support it, the app automatically falls back to `gdigrab`.
- **Hardware encoding**: NVENC, AMF, or Quick Sync does the work instead of
  your CPU (`libx264` would spike CPU hard at 60fps).
- **Bitrate caps**: Smaller Files keeps H.264 files from ballooning during
  fast-motion scenes. H.265 uses a lower bitrate for similar quality when
  the GPU encoder is available.

## Troubleshooting
- **"FFmpeg not found"**: check the `ffmpeg/ffmpeg.exe` path or your PATH env var.
- **Choppy recording**: update GPU drivers (NVIDIA / AMD Adrenalin / Intel).
- **No NVENC / AMF / QSV**: the app logs which encoder was selected and why
  in `diagnostics.log`. Override Encoder in Settings, or leave Auto.
- **Exclusive fullscreen is black**: keep Exclusive Fullscreen on, start the
  game first, then press Ctrl+Shift+R while that game is in front. After one
  failure that title is remembered and skipped to game capture next time.
  Borderless windowed is the most reliable if a title still blocks capture.
- **Recovered recording from last session**: the previous run did not stop
  cleanly. The leftover `.mkv` / `.webm` was remuxed to `.mp4` in your clips
  folder.
- **Recording stopped — disk space low**: raise Disk Reserve in Settings or
  free space on the output drive, then start again.
- **No audio**: keep Game Audio on. If WASAPI is missing, enable Stereo Mix
  or install VB-CABLE, then use Test Audio. The Settings page explains which
  loopback source was detected.
