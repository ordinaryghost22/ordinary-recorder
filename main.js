const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, dialog, shell, desktopCapturer, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn, spawnSync, execSync } = require('child_process');

// Only one instance — many copies steal hotkeys and break recording
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

process.on('uncaughtException', (err) => {
  console.error('uncaughtException (kept alive):', err);
});
process.on('unhandledRejection', (err) => {
  console.error('unhandledRejection (kept alive):', err);
});

// Hidden capture window still needs audio + timers
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');
app.commandLine.appendSwitch('enable-usermedia-screen-capturing');
app.commandLine.appendSwitch('enable-experimental-web-platform-features');
app.commandLine.appendSwitch(
  'enable-features',
  'WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer,WebCodecs'
);

let mainWindow = null;
let tray = null;
let ffmpegProcess = null;
let isRecording = false;
let isPaused = false;
let currentOutputFile = null;
let recordingStartedAt = null;
let pauseStartedAt = null;
let totalPausedMs = 0;
let statsInterval = null;

/** Active segmented recording session (null when idle). */
let session = null;

/** Instant Replay rolling buffer (separate from normal recording). */
let replayProcess = null;
let instantReplayActive = false;
let replayPausedForRecording = false;
let replayUseDdagrab = true;
let replayUseAmf = true;
let replayCrashCount = 0;
let replayStableTimer = null;

/** Chromium/WGC capture window (Medal-style: WGC + HW encode + WASAPI loopback). */
let gameCaptureWin = null;
let gameCaptureStream = null;
let gameCaptureFile = null;
let gameCaptureBytes = 0;
let usingGameCapture = false;
let gameCaptureDone = null;
let gameCaptureMime = 'video/webm';
let lastGameSourceId = null;
let webCodecsUnavailable = false;

/** Medal-style rolling buffer (encoded H264 + PCM loopback). */
const medal = {
  active: false,
  recording: false,
  video: [],
  audio: [],
  sessionVideo: [],
  sessionAudio: [],
  sessionBytes: 0,
  startedAt: 0,
  fps: 30,
  audioRate: 48000,
  hasAudio: false,
  hasLoopback: false,
  hasMic: false,
  sourceId: null,
  sourceName: null
};

let powerSaveId = null;
let lastAudioPeak = 0;
let gameWatchTimer = null;
let retargetingCapture = false;

/** Probed once at startup — used to pick capture/encoder paths and warn the user. */
let ffmpegCaps = {
  path: 'ffmpeg',
  available: false,
  hasDdagrab: false,
  hasH264Amf: false,
  hasHevcAmf: false
};

// ---------- Settings (persisted to a plain JSON file next to the exe) ----------
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const REPLAY_SEGMENT_SECONDS = 10;

const SETTINGS_VERSION = 8;

const defaultSettings = {
  settingsVersion: SETTINGS_VERSION,
  fps: 30,
  gameMode: true,
  exclusiveFullscreen: true,
  spaceSaving: true,
  amfRateControl: 'vbr_peak',
  audioSource: 'system',
  recordAudio: true,
  audioDevice: null,
  pttEnabled: false,
  pttKey: 'V',
  drawMouse: true,
  outputFolder: app.getPath('videos'),
  hotkey: 'CommandOrControl+Shift+R',
  pauseHotkey: 'CommandOrControl+Shift+P',
  replayHotkey: 'CommandOrControl+Shift+I',
  instantReplayEnabled: true,
  instantReplayMinutes: 5,
  instantReplaySaveMinutes: 2,
  instantReplayFps: 30
};

function loadSettings() {
  try {
    if (fs.existsSync(settingsPath)) {
      const loaded = { ...defaultSettings, ...JSON.parse(fs.readFileSync(settingsPath, 'utf-8')) };
      // v6: full desktop capture. v7: always-on mic so in-game voice is recorded.
      let migrated = false;
      const ver = Number(loaded.settingsVersion);
      if (!Number.isFinite(ver) || ver < 6) {
        loaded.gameMode = true;
        loaded.exclusiveFullscreen = false;
        loaded.spaceSaving = true;
        loaded.audioSource = 'system';
        loaded.recordAudio = true;
        loaded.pttKey = loaded.pttKey || 'V';
        loaded.drawMouse = true;
        loaded.fps = 30;
        loaded.instantReplayEnabled = true;
        migrated = true;
      }
      if (!Number.isFinite(ver) || ver < 7) {
        loaded.recordAudio = true;
        loaded.audioSource = 'system';
        loaded.pttEnabled = false;
        migrated = true;
      }
      if (!Number.isFinite(ver) || ver < 8) {
        loaded.gameMode = true;
        loaded.exclusiveFullscreen = true;
        migrated = true;
      }
      if (migrated) loaded.settingsVersion = SETTINGS_VERSION;
      loaded.instantReplayMinutes = Math.min(5, Math.max(1, Number(loaded.instantReplayMinutes) || 5));
      const saveOpts = [0.5, 1, 2, 3, 4, 5];
      const saveMin = Number(loaded.instantReplaySaveMinutes);
      loaded.instantReplaySaveMinutes = saveOpts.includes(saveMin) ? saveMin : 2;
      const fpsOpts = [15, 30, 60];
      loaded.instantReplayFps = fpsOpts.includes(Number(loaded.instantReplayFps))
        ? Number(loaded.instantReplayFps)
        : 30;
      loaded.exclusiveFullscreen = Boolean(loaded.exclusiveFullscreen);
      loaded.gameMode = loaded.gameMode !== false;
      loaded.amfRateControl = loaded.amfRateControl === 'cqp' ? 'cqp' : 'vbr_peak';
      loaded.audioSource = loaded.audioSource === 'mic' ? 'mic' : 'system';
      loaded.pttEnabled = loaded.pttEnabled === true;
      loaded.pttKey = PTT_KEYS[loaded.pttKey] ? loaded.pttKey : 'V';
      loaded.hotkey = sanitizeAccelerator(loaded.hotkey, defaultSettings.hotkey);
      loaded.pauseHotkey = sanitizeAccelerator(loaded.pauseHotkey, defaultSettings.pauseHotkey);
      loaded.replayHotkey = sanitizeAccelerator(loaded.replayHotkey, defaultSettings.replayHotkey);
      if (migrated) {
        try { fs.writeFileSync(settingsPath, JSON.stringify(loaded, null, 2)); } catch (e) { /* ignore */ }
      }
      return loaded;
    }
  } catch (e) { /* fall through to defaults */ }
  return { ...defaultSettings };
}

function saveSettings(next) {
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
}

let pttProc = null;
let pttHeld = false;

const PTT_KEYS = {
  V: 0x56,
  Mouse4: 0x05,
  Mouse5: 0x06,
  Grave: 0xC0,
  Alt: 0x12
};

function sanitizeAccelerator(acc, fallback) {
  const raw = String(acc || '').trim();
  if (!raw) return fallback;
  const parts = raw.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return fallback;
  const mods = new Set(['CommandOrControl', 'Ctrl', 'Control', 'Alt', 'Shift', 'Super', 'Cmd', 'Command', 'Meta']);
  const normalized = parts.map((p) => {
    if (/^ctrl$/i.test(p) || /^control$/i.test(p) || /^cmd$/i.test(p) || /^command$/i.test(p) || /^meta$/i.test(p)) {
      return 'CommandOrControl';
    }
    if (/^commandorcontrol$/i.test(p)) return 'CommandOrControl';
    if (/^alt$/i.test(p) || /^option$/i.test(p)) return 'Alt';
    if (/^shift$/i.test(p)) return 'Shift';
    if (/^super$/i.test(p) || /^win$/i.test(p)) return 'Super';
    if (/^esc(ape)?$/i.test(p)) return 'Esc';
    if (/^return$/i.test(p) || /^enter$/i.test(p)) return 'Enter';
    if (/^space$/i.test(p)) return 'Space';
    if (/^plus$/i.test(p)) return 'Plus';
    if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(p)) return p.toUpperCase();
    if (/^[A-Z0-9]$/i.test(p)) return p.toUpperCase();
    if (/^[`\-\[\]\\;',./=]$/.test(p)) return p;
    return null;
  });
  if (normalized.some((p) => !p)) return fallback;
  const key = normalized[normalized.length - 1];
  if (mods.has(key) || key === 'CommandOrControl') return fallback;
  const seen = new Set();
  const unique = [];
  for (const p of normalized) {
    if (seen.has(p)) continue;
    seen.add(p);
    unique.push(p);
  }
  return unique.join('+');
}

let settings = loadSettings();

/** Live capture fps / drop signals parsed from ffmpeg stderr (recording session). */
let liveCaptureFps = null;
let frameDropHits = 0;
let borderlessWarnShown = false;
let lastFpsUiAt = 0;

// ---------- FFmpeg location ----------
function ffmpegCandidatePaths() {
  const candidates = [];

  // Packaged app: ffmpeg is in extraResources next to app.asar — never inside asar
  if (app.isPackaged) {
    if (process.resourcesPath) {
      candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
    }
    candidates.push(path.join(path.dirname(process.execPath), 'resources', 'ffmpeg', 'ffmpeg.exe'));
    // Portable sometimes keeps resources beside the original .exe the user launched
    try {
      const exeDir = path.dirname(app.getPath('exe'));
      candidates.push(path.join(exeDir, 'resources', 'ffmpeg', 'ffmpeg.exe'));
      candidates.push(path.join(exeDir, 'ffmpeg', 'ffmpeg.exe'));
    } catch (e) { /* ignore */ }
  }

  // Dev / fallback
  candidates.push(path.join(__dirname, 'ffmpeg', 'ffmpeg.exe'));
  if (!app.isPackaged && process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe'));
  }

  // System PATH last
  candidates.push('ffmpeg');
  return candidates;
}

const FFMPEG_MIN_BYTES = 5 * 1024 * 1024; // full builds are large; reject partial portable extracts

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getFfmpegPath() {
  for (const candidate of ffmpegCandidatePaths()) {
    if (!candidate) continue;
    if (candidate === 'ffmpeg') return candidate;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size >= FFMPEG_MIN_BYTES) {
        return candidate;
      }
    } catch (e) { /* ignore */ }
  }
  return 'ffmpeg';
}

function resolveBundledFfmpegPath() {
  for (const candidate of ffmpegCandidatePaths()) {
    if (!candidate || candidate === 'ffmpeg') continue;
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).size >= FFMPEG_MIN_BYTES) {
        return candidate;
      }
    } catch (e) { /* ignore */ }
  }
  return null;
}

/** Prefer spawnSync; fall back to execSync (some AV tools break one or the other). */
function runFfmpegArgv(ffmpegPath, argv, timeoutMs = 20000) {
  const result = spawnSync(ffmpegPath, argv, {
    encoding: 'utf8',
    timeout: timeoutMs,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 8 * 1024 * 1024,
    env: process.env
  });

  if (!result.error && result.status === 0) {
    return `${result.stdout || ''}${result.stderr || ''}`;
  }

  try {
    const quotedArgs = argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
    return execSync(`"${ffmpegPath}" ${quotedArgs}`, {
      encoding: 'utf8',
      timeout: timeoutMs,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 8 * 1024 * 1024
    });
  } catch (e2) {
    if (result.error) {
      const err = result.error;
      err.stderr = result.stderr || e2.stderr || '';
      err.stdout = result.stdout || e2.stdout || '';
      throw err;
    }
    const err = new Error(`ffmpeg exited ${result.status}`);
    err.status = result.status;
    err.stderr = result.stderr || '';
    err.stdout = result.stdout || '';
    throw err;
  }
}

function runFfmpeg(args, timeoutMs = 20000) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  const argv = typeof args === 'string'
    ? args.trim().match(/(?:[^\s"]+|"[^"]*")+/g).map((a) => a.replace(/^"|"$/g, ''))
    : args;
  return runFfmpegArgv(ffmpegPath, argv, timeoutMs);
}

function canRunFfmpeg(ffmpegPath) {
  try {
    const out = runFfmpegArgv(ffmpegPath, ['-hide_banner', '-version'], 20000);
    if (/ffmpeg version/i.test(out)) return { ok: true };
    return { ok: false, error: 'Unexpected ffmpeg -version output', stderr: out.slice(0, 200) };
  } catch (e) {
    return {
      ok: false,
      error: `${e.code || ''} ${e.message || e}`.trim(),
      stderr: String(e.stderr || '').slice(0, 300)
    };
  }
}

/** List DirectShow audio input device names (stderr from -list_devices). */
function listDshowAudioDevices() {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  // FFmpeg 8 often exits 0 here — must capture stderr even on "success"
  const result = spawnSync(
    ffmpegPath,
    ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'],
    {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  const out = `${result.stderr || ''}${result.stdout || ''}${result.error ? result.error.message : ''}`;

  const devices = [];

  // FFmpeg 8+ format:  "Microphone (Realtek...)" (audio)
  for (const line of out.split(/\r?\n/)) {
    const m8 = line.match(/"([^"]+)"\s*\(audio\)/i);
    if (m8 && !devices.includes(m8[1])) devices.push(m8[1]);
  }
  if (devices.length) return devices;

  // Older FFmpeg format: section header + quoted names
  let inAudio = false;
  for (const line of out.split(/\r?\n/)) {
    if (/DirectShow audio devices/i.test(line)) {
      inAudio = true;
      continue;
    }
    if (/DirectShow video devices/i.test(line)) {
      inAudio = false;
      continue;
    }
    if (!inAudio) continue;
    if (/Alternative name/i.test(line)) continue;
    const m = line.match(/"([^"]+)"/);
    if (m && !devices.includes(m[1])) devices.push(m[1]);
  }
  return devices;
}

function isSystemAudioDevice(name) {
  return /virtual-audio-capturer|stereo mix|what u hear|cable output|vb-audio|wave out mix|loopback|speakers? \(.*\) \(loopback\)/i.test(name || '');
}

function isMicrophoneDevice(name) {
  return /microphone|mic\b|headset.*mic|array/i.test(name || '');
}

function pickPreferredAudioDevice(devices, source = 'system') {
  if (!devices.length) return null;

  if (source === 'mic') {
    const mic = devices.find((d) => isMicrophoneDevice(d));
    return mic || devices[0] || null;
  }

  // System / game audio — never silently fall back to a mic
  const preferred = [
    /^virtual-audio-capturer$/i,
    /cable output/i,
    /vb-audio/i,
    /stereo mix/i,
    /what u hear/i,
    /wave out mix/i
  ];

  for (const re of preferred) {
    const hit = devices.find((d) => re.test(d));
    if (hit) return hit;
  }

  const nonMic = devices.find((d) => !isMicrophoneDevice(d));
  return nonMic || null;
}

function resolveAudioDevice(devices) {
  const source = settings.audioSource === 'mic' ? 'mic' : 'system';

  if (settings.audioDevice && devices.includes(settings.audioDevice)) {
    // Saved mic while wanting system audio → switch to Cable/Stereo Mix if available
    if (source === 'system' && isMicrophoneDevice(settings.audioDevice)) {
      const sys = pickPreferredAudioDevice(devices, 'system');
      if (sys) return sys;
    }
    if (source === 'mic' && isSystemAudioDevice(settings.audioDevice)) {
      const mic = pickPreferredAudioDevice(devices, 'mic');
      if (mic) return mic;
    }
    return settings.audioDevice;
  }
  return pickPreferredAudioDevice(devices, source);
}

function getAudioSetupHint(devices) {
  const hasSystem = devices.some((d) => isSystemAudioDevice(d) || /cable output|stereo mix|vb-audio|virtual-audio/i.test(d));
  if (hasSystem) {
    return 'Game audio: select “CABLE Output”. In Windows sound, set the game/default output to “CABLE Input” (or enable Stereo Mix).';
  }
  return 'No system-audio device found. Enable Stereo Mix in Sound settings, or install VB-Audio Cable to record game audio.';
}

/** Actually open the encoder for a tiny encode — "-encoders" listing alone lies when AMF HW is missing. */
function encoderWorks(ffmpegPath, encoderName) {
  try {
    execSync(
      `"${ffmpegPath}" -hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:d=0.2 -pix_fmt yuv420p -c:v ${encoderName} -f null -`,
      {
        encoding: 'utf8',
        timeout: 12000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    return true;
  } catch (e) {
    const err = `${e.stderr || ''}${e.message || ''}`;
    // Some builds still write frames then exit non-zero on null muxer — treat as OK if no AMF create error
    if (/frame=\s*[1-9]/i.test(err) && !/CreateComponent\(AMF|Encoder not found|Cannot load AMF/i.test(err)) {
      return true;
    }
    console.warn(`Encoder probe failed for ${encoderName}:`, err.slice(0, 240));
    return false;
  }
}

function probeFfmpeg() {
  // Sync quick probe used by recording start if async startup probe hasn't finished.
  let ffmpegPath = resolveBundledFfmpegPath() || getFfmpegPath();
  const pathRun = canRunFfmpeg(ffmpegPath);
  if (!pathRun.ok) {
    const sys = canRunFfmpeg('ffmpeg');
    if (sys.ok) ffmpegPath = 'ffmpeg';
  }

  const caps = {
    path: ffmpegPath,
    available: false,
    hasDdagrab: false,
    hasH264Amf: false,
    hasHevcAmf: false,
    probeError: null
  };

  const check = canRunFfmpeg(ffmpegPath);
  if (!check.ok) {
    caps.probeError = `${check.error} ${check.stderr || ''}`.trim();
    ffmpegCaps = caps;
    return caps;
  }

  caps.available = true;
  ffmpegCaps = caps;

  try {
    const filters = runFfmpeg('-hide_banner -filters', 30000);
    caps.hasDdagrab = /\bddagrab\b/i.test(filters);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    caps.hasDdagrab = /\bddagrab\b/i.test(out);
  }

  let listsH264Amf = false;
  try {
    const encoders = runFfmpeg('-hide_banner -encoders', 30000);
    listsH264Amf = /\bh264_amf\b/i.test(encoders);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    listsH264Amf = /\bh264_amf\b/i.test(out);
  }

  // Only probe h264_amf — hevc_amf fails on this GPU and only freezes startup
  caps.hasH264Amf = listsH264Amf && encoderWorks(ffmpegPath, 'h264_amf');
  caps.hasHevcAmf = false;
  console.log('Encoder caps:', { hasH264Amf: caps.hasH264Amf, hasHevcAmf: caps.hasHevcAmf, hasDdagrab: caps.hasDdagrab });

  try {
    const devices = listDshowAudioDevices();
    const resolved = resolveAudioDevice(devices);
    if (resolved && resolved !== settings.audioDevice) {
      settings.audioDevice = resolved;
      saveSettings(settings);
    }
  } catch (e) {
    console.warn('Audio device probe failed:', e.message || e);
  }

  ffmpegCaps = caps;
  return caps;
}

/** Non-blocking startup probe with retries (does not freeze the UI). */
async function probeFfmpegAsync() {
  let ffmpegPath = null;

  for (let attempt = 1; attempt <= 6; attempt++) {
    ffmpegPath = resolveBundledFfmpegPath() || getFfmpegPath();
    let run = canRunFfmpeg(ffmpegPath);
    if (!run.ok) {
      const sys = canRunFfmpeg('ffmpeg');
      if (sys.ok) {
        ffmpegPath = 'ffmpeg';
        run = sys;
      }
    }

    if (run.ok) {
      // Full capability probe once the binary actually runs
      return probeFfmpeg();
    }

    console.warn(`FFmpeg async probe attempt ${attempt} failed:`, run.error, run.stderr);
    await delay(attempt === 1 ? 1500 : 2000);
  }

  const caps = {
    path: ffmpegPath || getFfmpegPath(),
    available: false,
    hasDdagrab: false,
    hasH264Amf: false,
    hasHevcAmf: false,
    probeError: 'Could not start ffmpeg after retries'
  };
  ffmpegCaps = caps;
  return caps;
}

function ffmpegInstallMessage(caps) {
  const dest = app.isPackaged
    ? path.join(process.resourcesPath, 'ffmpeg', 'ffmpeg.exe')
    : path.join(__dirname, 'ffmpeg', 'ffmpeg.exe');
  const exists = (() => {
    try { return fs.existsSync(dest) && fs.statSync(dest).size >= FFMPEG_MIN_BYTES; } catch (e) { return false; }
  })();

  if (exists) {
    return [
      'Bundled FFmpeg was found but could not be started yet.',
      dest,
      '',
      caps && caps.probeError ? `Details: ${caps.probeError}` : '',
      '',
      'Usually Windows Defender is still scanning the portable extract.',
      'Click OK, wait ~10 seconds, then try recording again (or restart the app).',
      'If it keeps failing: allow ffmpeg.exe through Defender, or run the app from:',
      path.join(path.dirname(process.execPath))
    ].filter(Boolean).join('\n');
  }

  return [
    'Put a Windows FFmpeg "full" build here:',
    dest,
    '',
    'Download: https://www.gyan.dev/ffmpeg/builds/ (ffmpeg-release-full.7z)',
    'Copy bin\\ffmpeg.exe into that folder, then restart the app.'
  ].join('\n');
}

function showFfmpegWarning(caps) {
  // Missing AMF is fine — we fall back to libx264 without scaring the user.
  if (!caps.available) {
    const bundled = resolveBundledFfmpegPath();

    // File is on disk — don't scare the user; silent retry later on Start Recording
    if (bundled) {
      console.warn('FFmpeg binary present but probe failed; will retry on record:', caps.probeError);
      return;
    }

    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error',
      title: 'FFmpeg not found',
      message: 'FFmpeg is required to record.',
      detail: ffmpegInstallMessage(caps),
      buttons: ['OK']
    });
    return;
  }

  if (!caps.hasDdagrab) {
    console.warn('ddagrab missing — exclusive fullscreen capture may be black');
    return;
  }

  if (!caps.hasH264Amf && !caps.hasHevcAmf) {
    console.warn('AMF unavailable — using libx264 software encode (higher CPU).');
  }
}

function getSelectedAudioDevice() {
  return settings.recordAudio ? settings.audioDevice : null;
}

function effectiveFps() {
  const f = Number(settings.fps) === 60 ? 60 : 30;
  return f;
}

function effectiveReplayFps() {
  if (settings.gameMode) return Math.min(30, Number(settings.instantReplayFps) || 30);
  return Number(settings.instantReplayFps) || 30;
}

function drawMouseFlag() {
  return settings.drawMouse ? 1 : 0;
}

/** Keep encode responsive enough to avoid choppy footage, without starving the game. */
function softenProcessPriority(proc) {
  if (!proc || !proc.pid) return;
  try {
    const p = os.constants.priority;
    // LOW was dropping frames in the recording — BELOW_NORMAL keeps footage smooth
    os.setPriority(proc.pid, p.PRIORITY_BELOW_NORMAL != null ? p.PRIORITY_BELOW_NORMAL : 1);
  } catch (e) { /* ignore */ }
}

/**
 * Desktop Duplication (same family as AMD Relive display capture).
 * Works with desktop / borderless; exclusive fullscreen uses WGC game-capture instead.
 */
function pushDesktopCaptureArgs(args, { fps, useDdagrab }) {
  const mouse = drawMouseFlag();
  const game = Boolean(settings.gameMode);
  if (useDdagrab && ffmpegCaps.hasDdagrab) {
    // Bigger queues = fewer underruns / hitchy fps during fast motion
    if (game) {
      args.push('-probesize', '42M', '-analyzeduration', '0', '-thread_queue_size', '1024');
    } else {
      args.push('-thread_queue_size', '256');
    }
    args.push(
      '-f', 'lavfi',
      '-i', `ddagrab=framerate=${fps}:output_idx=0:draw_mouse=${mouse}:dup_frames=1`
    );
  } else {
    args.push(
      '-thread_queue_size', game ? '1024' : '256',
      '-f', 'gdigrab',
      '-framerate', String(fps),
      '-draw_mouse', String(mouse),
      '-i', 'desktop'
    );
  }
}

/**
 * Minimal GPU→CPU convert for AMF. NO scale — CPU scaling was the lag.
 * Download as BGRA then convert to NV12. Direct nv12 hwdownload is invalid
 * on current FFmpeg/D3D11 (fails Instant Replay with error -22).
 */
function videoFilterForCapture(useDdagrab, { useAmf } = {}) {
  if (!(useDdagrab && ffmpegCaps.hasDdagrab)) return null;
  return 'hwdownload,format=bgra,format=nv12';
}

/** Keep UI out of the way without killing the recording window. */
function getOutOfTheWay() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.minimize();
  } catch (e) { /* ignore */ }
}

function restoreMainWindow() {
  showMainWindow();
}

function pushStableVideoEncoderArgs(args, { fps, useAmf, forReplay }) {
  const gop = fps; // 1s GOP
  const game = Boolean(settings.gameMode);

  if (useAmf && ffmpegCaps.hasH264Amf) {
    // Avoid cavlc/passthrough quirks — those caused colorful block glitches on playback
    args.push(
      '-c:v', 'h264_amf',
      '-usage', 'transcoding',
      '-quality', 'speed'
    );

    if (game && !forReplay && settings.amfRateControl === 'cqp') {
      const qpI = settings.spaceSaving ? '26' : '22';
      const qpP = settings.spaceSaving ? '28' : '24';
      args.push(
        '-rc', 'cqp',
        '-qp_i', qpI,
        '-qp_p', qpP,
        '-g', String(gop),
        '-bf', '0'
      );
    } else {
      let bitrate = '12M';
      let maxrate = '16M';
      let bufsize = '24M';
      if (forReplay) {
        bitrate = '5M'; maxrate = '6M'; bufsize = '8M';
      } else if (settings.spaceSaving) {
        bitrate = '8M'; maxrate = '10M'; bufsize = '12M';
      } else if (!game) {
        bitrate = '10M'; maxrate = '14M'; bufsize = '18M';
      } else {
        bitrate = '8M'; maxrate = '10M'; bufsize = '12M';
      }
      args.push(
        '-rc', 'vbr_peak',
        '-b:v', bitrate,
        '-maxrate', maxrate,
        '-bufsize', bufsize,
        '-g', String(gop),
        '-bf', '0'
      );
    }
  } else {
    // Software fallback — keep ultrafast so games stay playable
    args.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-crf', settings.spaceSaving ? '26' : '21',
      '-g', String(gop),
      '-keyint_min', String(gop),
      '-sc_threshold', '0',
      '-bf', '0'
    );
  }
}

// ---------- Build the ffmpeg args ----------
function buildArgs(outputFile, { useDdagrab, useAmf, audioDevice, useWasapi }) {
  const fps = effectiveFps();
  const args = [];
  const game = Boolean(settings.gameMode);

  // 1) All inputs first
  pushDesktopCaptureArgs(args, { fps, useDdagrab });

  const wantAudio = Boolean(useWasapi) || Boolean(audioDevice);
  if (useWasapi) {
    args.push(
      '-thread_queue_size', game ? '1024' : '256',
      '-f', 'wasapi',
      '-i', 'loopback'
    );
  } else if (audioDevice) {
    args.push(
      '-thread_queue_size', game ? '1024' : '256',
      '-f', 'dshow',
      '-audio_buffer_size', '80',
      '-i', `audio=${audioDevice}`
    );
  }

  // 2) Filters after every -i (critical for FFmpeg 8 + audio)
  const vf = videoFilterForCapture(useDdagrab, { useAmf });
  if (vf) args.push('-filter:v', vf);

  // Keep A/V aligned without dropping video when desktop audio clock drifts
  if (wantAudio && game) {
    args.push('-af', 'aresample=async=1000:first_pts=0');
  }

  // 3) Encoders / mux
  pushStableVideoEncoderArgs(args, { fps, useAmf, forReplay: false });

  if (wantAudio) {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000');
  } else {
    args.push('-an');
  }

  // Stable software frames into AMF — prevents the rainbow block glitches
  args.push('-pix_fmt', 'nv12');

  args.push(
    '-fps_mode', 'cfr',
    '-max_muxing_queue_size', game ? '2048' : '1024',
    '-movflags', '+frag_keyframe+empty_moov+default_base_moof',
    '-y', outputFile
  );
  return args;
}

function isDdagrabFailure(msg) {
  // Do NOT match mere mentions of "ddagrab" — normal startup logs include the filter name.
  return /No such filter.*ddagrab|Unknown (input )?filter.*ddagrab|Filter not found.*ddagrab|Error .*ddagrab|ddagrab.*fail|Cannot load.*ddagrab|Failed to.*Desktop Duplication|DXGI_ERROR|AcquireNextFrame failed|887a0026|887a0027/i.test(msg);
}

function isAmfFailure(msg) {
  // Do NOT match mere "h264_amf" in Stream mapping / encoder banner lines.
  return /CreateComponent\(AMF|Cannot load AMF|Error initializing.*(h264_amf|hevc_amf|AMF)|Encoder not found|Failed to open (encoder|codec).*(h264_amf|hevc_amf)|(h264_amf|hevc_amf).*failed with error|Error while opening encoder/i.test(msg);
}

function isAmfHwFormatFailure(msg) {
  return /Impossible to convert|No matching formats|Unsupported pixel format|Could not get .* format|Error reinitializing filters|Error while filtering|Function not implemented|surfaces are not supported|Failed to inject frame into filter network|Error while processing the decoded data/i.test(msg);
}

function isAudioFailure(msg) {
  return /Could not find audio only device|IAudioClient|Error opening input.*dshow|Could not run graph|audio device.*not found|Cannot open.*dshow|Unknown input format.*wasapi|wasapi.*(error|fail)|Failed to (open|init).*wasapi/i.test(msg);
}

function isCaptureDropMessage(msg) {
  return /frame\s*drops?|frames?\s+dropped|drop=\s*[1-9]\d*|capture timeout|timeout.*(?:capture|ddagrab|duplication)|Cannot capture|Desktop Duplication.*(?:fail|error|timeout)|DXGI_ERROR_WAIT_TIMEOUT|lost .*capture/i.test(msg);
}

function parseLiveFps(msg) {
  // ffmpeg progress lines: fps= 30.1  or fps=30
  const m = msg.match(/\bfps=\s*([\d.]+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

function resetCaptureStats() {
  liveCaptureFps = null;
  frameDropHits = 0;
  borderlessWarnShown = false;
  lastFpsUiAt = 0;
  lastAudioPeak = 0;
}

function surfaceBorderlessWarning() {
  // Exclusive fullscreen is supported via WGC window capture — do not nag.
}

function pushCaptureStatsToUi(extra = {}) {
  if (!mainWindow || mainWindow.isDestroyed() || !isRecording) return;
  mainWindow.webContents.send('recording-state', {
    ...getStatePayload(),
    ...extra
  });
}

function handleFfmpegProgress(msg) {
  const fps = parseLiveFps(msg);
  if (fps != null) {
    liveCaptureFps = fps;
    const now = Date.now();
    // Throttle UI fps updates (~4/sec) so stderr spam doesn't flood IPC
    if (now - lastFpsUiAt >= 250) {
      lastFpsUiAt = now;
      pushCaptureStatsToUi();
    }
  }

  if (settings.gameMode && isCaptureDropMessage(msg)) {
    frameDropHits += 1;
    // Repeated drops → exclusive fullscreen almost always the cause with ddagrab
    if (frameDropHits >= 3) {
      surfaceBorderlessWarning();
    }
  }
}

function formatBytesShort(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${Math.max(0, Math.round(n))} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(n < 100 * 1024 * 1024 ? 1 : 0)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
  } catch (e) { /* ignore */ }
}

function friendlyCaptureError(err) {
  const msg = String(err || '');
  if (msg === 'WECODECS_UNAVAILABLE' || /webcodecs/i.test(msg)) {
    return 'Could not start capture. Press Ctrl+Shift+R while the game is in front.';
  }
  return msg || 'Could not start recording.';
}

function getElapsedMs() {
  if (!recordingStartedAt) return 0;
  const pausedNow = isPaused && pauseStartedAt ? Date.now() - pauseStartedAt : 0;
  return Math.max(0, Date.now() - recordingStartedAt - totalPausedMs - pausedNow);
}

function getSessionFileSize() {
  if (medal.recording) return medal.sessionBytes;
  if (usingGameCapture && gameCaptureFile) {
    try {
      if (fs.existsSync(gameCaptureFile)) return fs.statSync(gameCaptureFile).size;
    } catch (e) { /* ignore */ }
    return gameCaptureBytes;
  }
  if (!session) {
    if (!currentOutputFile) return 0;
    try {
      if (fs.existsSync(currentOutputFile)) return fs.statSync(currentOutputFile).size;
    } catch (e) { /* ignore */ }
    return 0;
  }

  let total = 0;
  for (const file of session.segments) {
    try {
      if (fs.existsSync(file)) total += fs.statSync(file).size;
    } catch (e) { /* ignore */ }
  }
  // Include the in-progress segment — otherwise UI always shows 0 B while recording
  try {
    const current = currentSegmentPath();
    if (current && fs.existsSync(current) && !session.segments.includes(current)) {
      total += fs.statSync(current).size;
    }
  } catch (e) { /* ignore */ }
  return total;
}

function getStatePayload() {
  return {
    isRecording,
    isPaused,
    file: currentOutputFile,
    startedAt: recordingStartedAt,
    elapsedMs: getElapsedMs(),
    fileSize: getSessionFileSize(),
    segmentCount: session ? session.segments.length : 0,
    captureFps: liveCaptureFps,
    targetFps: effectiveFps(),
    pttHeld,
    pttKey: settings.pttKey || 'V',
    pttEnabled: settings.pttEnabled === true,
    hasAudio: Boolean(medal.hasAudio),
    audioLive: Boolean(medal.hasAudio && lastAudioPeak > 0.004),
    hotkey: settings.hotkey,
    pauseHotkey: settings.pauseHotkey,
    replayHotkey: settings.replayHotkey,
    instantReplay: getInstantReplayState()
  };
}

function startStatsPolling() {
  stopStatsPolling();
  let lastSize = 0;
  let stalledChecks = 0;
  statsInterval = setInterval(() => {
    if (!isRecording) {
      stopStatsPolling();
      return;
    }
    const size = getSessionFileSize();
    if (!isPaused) {
      if (size <= lastSize + 2048) stalledChecks += 1;
      else stalledChecks = 0;
      lastSize = size;
      // After ~6s with no growth, warn via tray/status
      if (stalledChecks >= 3 && mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('recording-state', {
          ...getStatePayload(),
          warning: 'Capture looks empty — press Ctrl+Shift+R while the game is already fullscreen'
        });
      }
    }
    broadcastState();
  }, 2000);
}

function stopStatsPolling() {
  if (statsInterval) {
    clearInterval(statsInterval);
    statsInterval = null;
  }
}

function waitForProcessClose(proc, timeoutMs = 20000) {
  return new Promise((resolve) => {
    if (!proc || proc.killed || proc.exitCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* ignore */ }
      resolve();
    }, timeoutMs);
    proc.once('close', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function sendQuit(proc) {
  if (!proc) return;
  try {
    proc.stdin.write('q');
  } catch (e) {
    try { proc.kill(); } catch (e2) { /* ignore */ }
  }
}

function rmSessionFolder(folder) {
  if (!folder) return;
  try {
    fs.rmSync(folder, { recursive: true, force: true });
  } catch (e) {
    console.warn('Failed to remove session folder:', e.message);
  }
}

function escapeConcatPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/'/g, "'\\''");
}

function concatSegments(segments, outputFile) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!segments.length) throw new Error('No segments to concatenate');

  // Remux to a normal faststart mp4 (segments may be fragmented)
  if (segments.length === 1) {
    execSync(
      `"${ffmpegPath}" -hide_banner -y -i "${segments[0]}" -c copy -movflags +faststart "${outputFile}"`,
      {
        encoding: 'utf8',
        timeout: 180000,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    return;
  }

  const listFile = path.join(session.folder, 'segments-list.txt');
  const body = segments.map((s) => `file '${escapeConcatPath(s)}'`).join('\n');
  fs.writeFileSync(listFile, body, 'utf8');

  execSync(
    `"${ffmpegPath}" -hide_banner -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outputFile}"`,
    {
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    }
  );
}

function nextSegmentPath() {
  session.segmentIndex += 1;
  return path.join(session.folder, `segment-${session.segmentIndex}.mp4`);
}

function currentSegmentPath() {
  return path.join(session.folder, `segment-${session.segmentIndex}.mp4`);
}

function launchSegment() {
  if (!session) return;

  const outputFile = currentSegmentPath();
  const args = buildArgs(outputFile, {
    useDdagrab: session.useDdagrab,
    useAmf: session.useAmf,
    audioDevice: session.audioDevice,
    useWasapi: session.useWasapi
  });

  let fallbackStage = 0;
  let stderrBuf = '';
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) {
    console.error('No ffmpeg path available');
    return;
  }

  console.log('ffmpeg args:', args.join(' '));
  ffmpegProcess = spawn(ffmpegPath, args, { windowsHide: true });
  softenProcessPriority(ffmpegProcess);
  session.intent = 'running';
  stderrBuf = '';

  ffmpegProcess.on('error', (err) => {
    console.error('ffmpeg spawn error:', err);
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrBuf += msg;
    handleFfmpegProgress(msg);

    // Keep console quieter — only log real problems
    if (/error|fail|invalid|could not/i.test(msg)) console.error(msg);

    if (fallbackStage > 0 || !isRecording || isPaused || !session || session.intent !== 'running') return;

    if (session.useWasapi && isAudioFailure(msg)) {
      fallbackStage = 1;
      console.warn('WASAPI loopback failed; retrying DirectShow audio.');
      session.useWasapi = false;
      restartCurrentSegment();
      return;
    }

    if (session.audioDevice && isAudioFailure(msg)) {
      fallbackStage = 1;
      console.warn('Audio device failed; retrying without audio.');
      session.audioDevice = null;
      restartCurrentSegment();
      return;
    }

    if (session.useDdagrab && isDdagrabFailure(msg)) {
      fallbackStage = 1;
      console.warn('ddagrab lost the display; retrying capture in 1.5s.');
      setTimeout(() => {
        if (isRecording && !isPaused && session && session.intent === 'running') {
          fallbackStage = 0;
          restartCurrentSegment();
        }
      }, 1500);
      return;
    }

    if (session.useAmf && isAmfFailure(msg)) {
      fallbackStage = 1;
      // gameMode: first retry AMF with nv12 download if hw passthrough failed
      if (
        settings.gameMode &&
        session.useDdagrab &&
        !session.forceAmfDownload &&
        isAmfHwFormatFailure(msg)
      ) {
        console.warn('AMF hw passthrough failed; retrying with hwdownload,format=nv12.');
        session.forceAmfDownload = true;
        restartCurrentSegment();
        return;
      }
      console.warn('AMF encoder failed; falling back to libx264.');
      session.useAmf = false;
      session.forceAmfDownload = true;
      restartCurrentSegment();
      return;
    }

    // Format/filter errors before encoder open (hw passthrough path)
    if (
      session.useAmf &&
      settings.gameMode &&
      session.useDdagrab &&
      !session.forceAmfDownload &&
      isAmfHwFormatFailure(msg)
    ) {
      fallbackStage = 1;
      console.warn('AMF hw format mismatch; retrying with hwdownload,format=nv12.');
      session.forceAmfDownload = true;
      restartCurrentSegment();
    }
  });

  ffmpegProcess.on('close', (code) => {
    const intent = session ? session.intent : 'idle';
    ffmpegProcess = null;

    if (intent === 'restarting') {
      return;
    }

    if (intent === 'running' && code && code !== 0 && fallbackStage === 0 && isRecording && !isPaused) {
      const msg = stderrBuf;
      if (session.useDdagrab && isDdagrabFailure(msg)) {
        session.useDdagrab = false;
        launchSegment();
        return;
      }
      if (session.useAmf && isAmfFailure(msg)) {
        if (
          settings.gameMode &&
          session.useDdagrab &&
          !session.forceAmfDownload &&
          isAmfHwFormatFailure(msg)
        ) {
          session.forceAmfDownload = true;
          launchSegment();
          return;
        }
        session.useAmf = false;
        session.forceAmfDownload = true;
        launchSegment();
        return;
      }
      if (session.useWasapi && isAudioFailure(msg)) {
        session.useWasapi = false;
        launchSegment();
        return;
      }
      if (session.audioDevice && isAudioFailure(msg)) {
        session.audioDevice = null;
        launchSegment();
        return;
      }
    }

    if (intent === 'pausing' || intent === 'stopping') {
      if (outputFile && fs.existsSync(outputFile) && !session.segments.includes(outputFile)) {
        try {
          if (fs.statSync(outputFile).size > 0) session.segments.push(outputFile);
        } catch (e) { /* ignore */ }
      }
      return;
    }

  // Unexpected exit while supposedly recording
    if (isRecording && !isPaused && intent === 'running') {
      console.error('ffmpeg exited unexpectedly while recording, code=', code);
      console.error(stderrBuf.slice(-1500));
      isRecording = false;
      isPaused = false;
      recordingStartedAt = null;
      pauseStartedAt = null;
      totalPausedMs = 0;
      resetCaptureStats();
      stopStatsPolling();
      const failedFolder = session ? session.folder : null;
      session = null;
      ffmpegProcess = null;
      if (failedFolder) rmSessionFolder(failedFolder);
      restoreMainWindow();
      broadcastState();
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: 'Recording stopped',
        message: 'FFmpeg quit while recording — nothing usable was saved.',
        detail: (stderrBuf || '').split(/\r?\n/).slice(-8).join('\n') || `exit code ${code}`,
        buttons: ['OK']
      });
    }
  });
}

function restartCurrentSegment() {
  if (!session || !ffmpegProcess) {
    launchSegment();
    return;
  }
  session.intent = 'restarting';
  const proc = ffmpegProcess;
  try {
    proc.removeAllListeners('close');
    proc.kill();
  } catch (e) { /* ignore */ }
  ffmpegProcess = null;
  // Overwrite the failed/partial segment file
  try {
    const p = currentSegmentPath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch (e) { /* ignore */ }
  launchSegment();
}

// ---------- Instant Replay (rolling segment buffer) ----------
// Uses MPEG-TS segments (.ts) — far more reliable with ffmpeg's segment muxer
// than MP4, and concat -c copy into a final .mp4 works consistently.
function getReplayBufferDir() {
  return path.join(settings.outputFolder, '.replay-buffer');
}

function getReplayWrapCount() {
  const minutes = Math.min(5, Math.max(1, Number(settings.instantReplayMinutes) || 5));
  return Math.ceil((minutes * 60) / REPLAY_SEGMENT_SECONDS);
}

function getInstantReplayState() {
  const files = listReplayBufferFilesDetailed();
  const medalSeconds = medalVideoSeconds();
  const medalOn = Boolean(medal.active);
  return {
    enabled: Boolean(settings.instantReplayEnabled),
    active: Boolean(settings.instantReplayEnabled && (medalOn || instantReplayActive || replayProcess)),
    minutes: Math.min(5, Number(settings.instantReplayMinutes) || 5),
    saveMinutes: Number(settings.instantReplaySaveMinutes) || 2,
    fps: Number(settings.instantReplayFps) || 30,
    pausedForRecording: replayPausedForRecording,
    bufferDir: getReplayBufferDir(),
    bufferFiles: medalOn ? medal.video.length : files.length,
    bufferSeconds: medalOn ? medalSeconds : files.length * REPLAY_SEGMENT_SECONDS
  };
}

function buildReplayArgs(bufferPattern) {
  const fps = effectiveReplayFps();
  const wrap = getReplayWrapCount();
  const useDdagrab = replayUseDdagrab && ffmpegCaps.hasDdagrab;
  const args = [];

  pushDesktopCaptureArgs(args, { fps, useDdagrab });
  const vf = videoFilterForCapture(useDdagrab, { useAmf: replayUseAmf });
  if (vf) args.push('-filter:v', vf);
  pushStableVideoEncoderArgs(args, { fps, useAmf: replayUseAmf, forReplay: true });

  args.push(
    '-an',
    '-pix_fmt', 'nv12',
    '-f', 'segment',
    '-segment_time', String(REPLAY_SEGMENT_SECONDS),
    '-segment_wrap', String(wrap),
    '-segment_format', 'mpegts',
    '-reset_timestamps', '1',
    '-strftime', '0',
    bufferPattern
  );

  return args;
}

function listReplayBufferFilesDetailed() {
  const dir = getReplayBufferDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^buffer_\d+\.(ts|mp4)$/i.test(name))
    .map((name) => {
      const full = path.join(dir, name);
      let mtime = 0;
      let size = 0;
      try {
        const st = fs.statSync(full);
        mtime = st.mtimeMs;
        size = st.size;
      } catch (e) { /* ignore */ }
      return { full, mtime, size, name };
    })
    .filter((f) => f.size > 1024) // skip tiny/corrupt stubs
    .sort((a, b) => a.mtime - b.mtime);
}

function listReplayBufferFiles() {
  return listReplayBufferFilesDetailed().map((f) => f.full);
}

/** Take only the last N minutes (by mtime order / segment count). */
function selectReplaySegmentsForSave(saveMinutes) {
  const all = listReplayBufferFilesDetailed();
  if (!all.length) return [];
  const seconds = Math.max(30, Math.round(Number(saveMinutes) * 60)) || 300;
  const need = Math.max(1, Math.ceil(seconds / REPLAY_SEGMENT_SECONDS));
  return all.slice(-need).map((f) => f.full);
}

function clearReplayBufferFiles() {
  const dir = getReplayBufferDir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (/^buffer_\d+\.(ts|mp4)$/i.test(name) || name === 'replay-concat.txt') {
      try { fs.unlinkSync(path.join(dir, name)); } catch (e) { /* ignore */ }
    }
  }
}

function startReplayProcess({ clearBuffer = false } = {}) {
  if (!ffmpegCaps.available) {
    return { ok: false, error: 'FFmpeg not found' };
  }
  if (isRecording) {
    return { ok: false, error: 'Stop normal recording before enabling Instant Replay' };
  }
  if (replayProcess) {
    return { ok: true, alreadyRunning: true };
  }

  if (!fs.existsSync(settings.outputFolder)) {
    fs.mkdirSync(settings.outputFolder, { recursive: true });
  }
  const dir = getReplayBufferDir();
  fs.mkdirSync(dir, { recursive: true });
  if (clearBuffer) clearReplayBufferFiles();

  replayUseDdagrab = ffmpegCaps.hasDdagrab;
  // Prefer working H.264 AMF — HEVC AMF often fails at runtime on consumer GPUs
  replayUseAmf = Boolean(ffmpegCaps.hasH264Amf || ffmpegCaps.hasHevcAmf);

  // MPEG-TS segments — reliable rolling buffer
  const pattern = path.join(dir, 'buffer_%03d.ts');
  const args = buildReplayArgs(pattern);
  const ffmpegPath = ffmpegCaps.path;

  let fallbackStage = 0;
  let stderrBuf = '';
  let replayIntent = 'running'; // closed-over intent (avoids race on process object)

  console.log('Starting Instant Replay:', ffmpegPath, args.join(' '));

  const proc = spawn(ffmpegPath, args, { windowsHide: true });
  replayProcess = proc;
  instantReplayActive = true;
  replayPausedForRecording = false;
  softenProcessPriority(proc);

  proc._setReplayIntent = (v) => { replayIntent = v; };

  if (replayStableTimer) clearTimeout(replayStableTimer);
  replayStableTimer = setTimeout(() => { replayCrashCount = 0; }, 45000);

  proc.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrBuf += msg;
    if (/error|failed|invalid|not found/i.test(msg)) console.error('[replay]', msg.trim());

    if (fallbackStage > 0 || replayIntent !== 'running') return;

    if (replayUseDdagrab && isDdagrabFailure(msg)) {
      if (isRecording || replayPausedForRecording) return;
      fallbackStage = 1;
      console.warn('Replay lost the display (game fullscreen). Restarting in 2s.');
      setTimeout(() => {
        if (!isRecording && !replayPausedForRecording && settings.instantReplayEnabled) {
          restartReplayProcess();
        }
      }, 2000);
      return;
    }
    if (replayUseAmf && isAmfFailure(msg)) {
      fallbackStage = 1;
      replayUseAmf = false;
      restartReplayProcess();
    }
  });

  proc.on('error', (err) => {
    console.error('Replay process error:', err);
    if (replayProcess === proc) replayProcess = null;
    instantReplayActive = false;
    scheduleReplayAutoRestart('spawn-error');
  });

  proc.on('close', (code) => {
    const intent = replayIntent;
    if (replayProcess === proc) replayProcess = null;

    if (intent === 'restart' || intent === 'save' || intent === 'pause' || intent === 'stop') {
      return;
    }

    if (settings.instantReplayEnabled && !replayPausedForRecording && code && code !== 0 && fallbackStage === 0) {
      const msg = stderrBuf;
      console.error('Replay ffmpeg exited:', code, msg.slice(-500));
      if (replayUseAmf && isAmfFailure(msg)) {
        replayUseAmf = false;
        startReplayProcess({ clearBuffer: false });
        return;
      }
      if (replayUseDdagrab && isDdagrabFailure(msg) && !settings.gameMode) {
        replayUseDdagrab = false;
        startReplayProcess({ clearBuffer: false });
        return;
      }
    }

    instantReplayActive = false;
    scheduleReplayAutoRestart(`exit-${code}`);
  });

  broadcastState();
  updateTrayMenu();
  return { ok: true };
}

function scheduleReplayAutoRestart(reason) {
  if (!settings.instantReplayEnabled || replayPausedForRecording || isRecording) {
    broadcastState();
    updateTrayMenu();
    return;
  }
  const lostDisplay = /887a0026|887a0027|AcquireNextFrame|ddagrab|exit-1|exit-224/i.test(String(reason || ''));
  if (!lostDisplay && replayCrashCount >= 8) {
    console.error('Replay auto-restart limit reached:', reason);
    broadcastState();
    updateTrayMenu();
    return;
  }
  if (!lostDisplay) replayCrashCount += 1;
  const delay = lostDisplay ? 2000 : Math.min(8000, 1000 * Math.max(1, replayCrashCount));
  console.warn(`Auto-restarting Instant Replay in ${delay}ms (${reason}, attempt ${replayCrashCount})`);
  setTimeout(() => {
    if (!settings.instantReplayEnabled || isRecording || replayProcess) return;
    startReplayProcess({ clearBuffer: false });
  }, delay);
  broadcastState();
  updateTrayMenu();
}

function restartReplayProcess() {
  if (isRecording || replayPausedForRecording) return { ok: false, error: 'busy' };
  if (replayProcess) {
    if (typeof replayProcess._setReplayIntent === 'function') replayProcess._setReplayIntent('restart');
    try {
      replayProcess.removeAllListeners('close');
      replayProcess.kill();
    } catch (e) { /* ignore */ }
    replayProcess = null;
  }
  return startReplayProcess({ clearBuffer: false });
}

async function stopReplayProcess() {
  if (!replayProcess) {
    instantReplayActive = false;
    return;
  }
  const proc = replayProcess;
  if (typeof proc._setReplayIntent === 'function') proc._setReplayIntent('stop');
  sendQuit(proc);
  await waitForProcessClose(proc);
  replayProcess = null;
  instantReplayActive = false;
}

async function pauseReplayForRecording() {
  if (medal.active) {
    replayPausedForRecording = false;
    return;
  }
  if (!instantReplayActive && !replayProcess) return;
  replayPausedForRecording = true;
  if (replayProcess) {
    const proc = replayProcess;
    if (typeof proc._setReplayIntent === 'function') proc._setReplayIntent('pause');
    sendQuit(proc);
    await waitForProcessClose(proc);
    replayProcess = null;
  }
  instantReplayActive = false;
  await new Promise((r) => setTimeout(r, 700));
  broadcastState();
  updateTrayMenu();
}

async function resumeReplayAfterRecording() {
  replayPausedForRecording = false;
  if (!settings.instantReplayEnabled) return;
  startReplayProcess({ clearBuffer: false });
}

async function toggleInstantReplay(enable) {
  const want = typeof enable === 'boolean' ? enable : !settings.instantReplayEnabled;

  if (want && isRecording) {
    return { ok: false, error: 'Stop recording before enabling Instant Replay' };
  }

  settings.instantReplayEnabled = want;
  settings.instantReplayMinutes = Math.min(5, Math.max(1, Number(settings.instantReplayMinutes) || 5));
  saveSettings(settings);

  if (want) {
    const result = startReplayProcess({ clearBuffer: true });
    if (!result.ok) {
      settings.instantReplayEnabled = false;
      saveSettings(settings);
      return result;
    }
    broadcastState();
    updateTrayMenu();
    return { ok: true, ...getInstantReplayState() };
  }

  await stopReplayProcess();
  if (!isRecording) await stopMedalEngine({ force: true });
  replayPausedForRecording = false;
  broadcastState();
  updateTrayMenu();
  return { ok: true, ...getInstantReplayState() };
}

async function saveInstantReplay(saveMinutesOverride) {
  if (!settings.instantReplayEnabled && !medal.active && !instantReplayActive && !replayProcess) {
    return { ok: false, error: 'Instant Replay is not active — turn it ON and wait for the buffer to fill' };
  }

  const saveMinutes = (() => {
    const opts = [0.5, 1, 2, 3, 4, 5];
    const v = Number(saveMinutesOverride != null ? saveMinutesOverride : settings.instantReplaySaveMinutes);
    return opts.includes(v) ? v : 5;
  })();

  if (medal.active) {
    return saveMedalReplay(saveMinutes);
  }

  // Finalize the current rolling segment so the last file is complete, then stitch.
  if (replayProcess) {
    const proc = replayProcess;
    if (typeof proc._setReplayIntent === 'function') proc._setReplayIntent('save');
    sendQuit(proc);
    await waitForProcessClose(proc, 25000);
    replayProcess = null;
    instantReplayActive = false;
    // Give Windows a moment to flush file handles
    await new Promise((r) => setTimeout(r, 400));
  }

  let segments = selectReplaySegmentsForSave(saveMinutes);
  if (!segments.length) {
    if (settings.instantReplayEnabled) startReplayProcess({ clearBuffer: false });
    return {
      ok: false,
      error: 'Replay buffer is empty — leave Instant Replay ON for at least ~15–30 seconds, then try again'
    };
  }

  if (!fs.existsSync(settings.outputFolder)) {
    fs.mkdirSync(settings.outputFolder, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = saveMinutes < 1 ? '30s' : `${saveMinutes}min`;
  const outputFile = path.join(settings.outputFolder, `replay-${label}-${timestamp}.mp4`);
  const dir = getReplayBufferDir();
  const listFile = path.join(dir, 'replay-concat.txt');

  // Copy chosen segments to a staging folder so a restarted buffer can't overwrite mid-save
  const staging = path.join(dir, `.save-staging-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });
  const staged = [];
  try {
    segments.forEach((src, i) => {
      const dest = path.join(staging, `part_${String(i).padStart(3, '0')}${path.extname(src)}`);
      fs.copyFileSync(src, dest);
      staged.push(dest);
    });

    const body = staged.map((s) => `file '${escapeConcatPath(s)}'`).join('\n') + '\n';
    // No UTF-8 BOM — ffmpeg concat demuxer rejects BOM as an unknown keyword
    fs.writeFileSync(listFile, body, { encoding: 'ascii' });

    const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
    if (staged.length === 1 && staged[0].toLowerCase().endsWith('.mp4')) {
      fs.copyFileSync(staged[0], outputFile);
    } else {
      try {
        execSync(
          `"${ffmpegPath}" -hide_banner -y -f concat -safe 0 -i "${listFile}" -c copy -movflags +faststart "${outputFile}"`,
          {
            encoding: 'utf8',
            timeout: 180000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          }
        );
      } catch (copyErr) {
        // Fallback: remux if bitstream copy fails across segments
        console.warn('concat -c copy failed, remuxing:', copyErr.stderr || copyErr.message);
        execSync(
          `"${ffmpegPath}" -hide_banner -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset veryfast -crf 23 -c:a aac -b:a 192k -movflags +faststart "${outputFile}"`,
          {
            encoding: 'utf8',
            timeout: 300000,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
          }
        );
      }
    }

    if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 1024) {
      throw new Error('Save produced an empty file');
    }
  } catch (e) {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    if (settings.instantReplayEnabled) startReplayProcess({ clearBuffer: false });
    const detail = (e.stderr && String(e.stderr).slice(-300)) || e.message || String(e);
    return { ok: false, error: `Save failed: ${detail}` };
  }

  try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }

  // Keep buffering — do not delete segment files
  if (settings.instantReplayEnabled && !isRecording) {
    startReplayProcess({ clearBuffer: false });
  }

  broadcastState();
  return { ok: true, file: outputFile, segments: segments.length, saveMinutes };
}

function setPttHeld(held) {
  held = Boolean(held);
  if (pttHeld === held) return;
  pttHeld = held;
  sendCaptureAudioMode();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-state', getStatePayload());
  }
}

function sendCaptureAudioMode() {
  if (!gameCaptureWin || gameCaptureWin.isDestroyed()) return;
  try {
    gameCaptureWin.webContents.send('medal-ptt', pttHeld);
    gameCaptureWin.webContents.send('medal-audio-mode', {
      pttEnabled: settings.pttEnabled === true,
      held: pttHeld
    });
  } catch (e) { /* ignore */ }
}

function stopPttWatcher() {
  if (!pttProc) return;
  try { pttProc.kill(); } catch (e) { /* ignore */ }
  pttProc = null;
}

function startPttWatcher() {
  stopPttWatcher();
  setPttHeld(false);
  if (settings.pttEnabled !== true) return;

  const vk = PTT_KEYS[settings.pttKey] || PTT_KEYS.V;
  const ps = [
    'Add-Type @"',
    'using System.Runtime.InteropServices;',
    'public static class GoatedPtt {',
    '  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int nVirtKey);',
    '}',
    '"@',
    `$vk = ${vk}`,
    '$prev = -1',
    'while ($true) {',
    '  $down = 0',
    '  if ([GoatedPtt]::GetAsyncKeyState($vk) -band 0x8000) { $down = 1 }',
    '  if ($down -ne $prev) { Write-Output $down; [Console]::Out.Flush(); $prev = $down }',
    '  Start-Sleep -Milliseconds 25',
    '}'
  ].join('\n');

  pttProc = spawn('powershell.exe', ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', ps], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  pttProc.stdout.setEncoding('utf8');
  pttProc.stdout.on('data', (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      const t = line.trim();
      if (t === '1') setPttHeld(true);
      else if (t === '0') setPttHeld(false);
    }
  });
  pttProc.on('error', (err) => console.warn('PTT watcher failed:', err.message || err));
}

function medalVideoSeconds() {
  if (!medal.video.length) return 0;
  const first = medal.video[0].ts;
  const last = medal.video[medal.video.length - 1].ts;
  return Math.max(0, (last - first) / 1e6);
}

function pruneMedalRing() {
  const keepUs = (Math.min(5, Number(settings.instantReplayMinutes) || 5) * 60) * 1e6;
  if (medal.video.length < 8) return;
  const lastTs = medal.video[medal.video.length - 1].ts;
  const cutoff = lastTs - keepUs;
  let firstKeep = 0;
  for (let i = 0; i < medal.video.length; i++) {
    if (medal.video[i].ts >= cutoff && medal.video[i].type === 'key') {
      firstKeep = i;
      break;
    }
  }
  if (firstKeep > 0) medal.video = medal.video.slice(firstKeep);
  if (medal.audio.length > 4) {
    const rate = medal.audioRate || 48000;
    const audioKeep = Math.ceil(keepUs / 1e6 * rate * 4) + rate * 4;
    let total = 0;
    for (let i = medal.audio.length - 1; i >= 0; i--) {
      total += medal.audio[i].buf.length;
      if (total >= audioKeep) {
        medal.audio = medal.audio.slice(i);
        break;
      }
    }
  }
}

function sliceMedalReplay(saveMinutes) {
  const saveUs = Math.max(30, Math.round(Number(saveMinutes) * 60)) * 1e6;
  if (!medal.video.length) return { video: [], audio: [] };
  const lastTs = medal.video[medal.video.length - 1].ts;
  const cutoff = lastTs - saveUs;
  let start = 0;
  for (let i = medal.video.length - 1; i >= 0; i--) {
    if (medal.video[i].type === 'key' && medal.video[i].ts <= cutoff) {
      start = i;
      break;
    }
  }
  if (start === 0) {
    const key = medal.video.findIndex((c) => c.type === 'key');
    start = key >= 0 ? key : 0;
  }
  const video = medal.video.slice(start);
  const durationSec = video.length ? (video[video.length - 1].ts - video[0].ts) / 1e6 : 0;
  const rate = medal.audioRate || 48000;
  const audioBytes = Math.max(0, Math.round(durationSec * rate * 4));
  let collected = 0;
  const audioRev = [];
  for (let i = medal.audio.length - 1; i >= 0 && collected < audioBytes; i--) {
    audioRev.push(medal.audio[i]);
    collected += medal.audio[i].buf.length;
  }
  return { video, audio: audioRev.reverse() };
}

function muxMedalMp4(videoChunks, audioChunks, outputFile, fps) {
  if (!videoChunks.length) throw new Error('Replay buffer is empty');
  const tmp = path.join(os.tmpdir(), `goated-mux-${Date.now()}`);
  fs.mkdirSync(tmp, { recursive: true });
  const vfile = path.join(tmp, 'v.h264');
  const afile = path.join(tmp, 'a.pcm');
  try {
    const vfd = fs.openSync(vfile, 'w');
    for (const c of videoChunks) fs.writeSync(vfd, c.buf);
    fs.closeSync(vfd);
    const hasAudio = audioChunks && audioChunks.length > 0;
    if (hasAudio) {
      const afd = fs.openSync(afile, 'w');
      for (const c of audioChunks) fs.writeSync(afd, c.buf);
      fs.closeSync(afd);
    }
    const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
    const rate = fps || 30;
    const audioRate = medal.audioRate || 48000;
    const cmd = hasAudio
      ? `"${ffmpegPath}" -hide_banner -y -fflags +genpts -r ${rate} -f h264 -i "${vfile}" -f s16le -ar ${audioRate} -ac 2 -i "${afile}" -c:v copy -c:a aac -b:a 192k -af apad -shortest -movflags +faststart "${outputFile}"`
      : `"${ffmpegPath}" -hide_banner -y -fflags +genpts -r ${rate} -f h264 -i "${vfile}" -c:v copy -an -movflags +faststart "${outputFile}"`;
    execSync(cmd, {
      encoding: 'utf8',
      timeout: 180000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
    if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 8192) {
      throw new Error('Mux produced an empty file');
    }
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ignore */ }
  }
}

function startPowerSave() {
  try {
    if (powerSaveId == null || !powerSaveBlocker.isStarted(powerSaveId)) {
      powerSaveId = powerSaveBlocker.start('prevent-app-suspension');
    }
  } catch (e) { /* ignore */ }
}

function stopPowerSave() {
  try {
    if (powerSaveId != null && powerSaveBlocker.isStarted(powerSaveId)) {
      powerSaveBlocker.stop(powerSaveId);
    }
  } catch (e) { /* ignore */ }
  powerSaveId = null;
}

function configureCaptureSession(win, source) {
  if (!win || win.isDestroyed()) return;
  const ses = win.webContents.session;
  ses.setPermissionCheckHandler((_wc, permission) => (
    permission === 'media' ||
    permission === 'mediaKeySystem' ||
    permission === 'fullscreen'
  ));
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(
      permission === 'media' ||
      permission === 'display-capture' ||
      permission === 'mediaKeySystem'
    );
  });
  ses.setDisplayMediaRequestHandler((_request, callback) => {
    callback({
      video: source,
      audio: settings.recordAudio ? 'loopback' : undefined
    });
  });
  try { win.webContents.setBackgroundThrottling(false); } catch (e) { /* ignore */ }
}

async function startMedalEngine({ retarget = false } = {}) {
  if (retargetingCapture) {
    if (medal.active) {
      return {
        ok: true,
        already: true,
        audio: medal.hasAudio,
        loopback: medal.hasLoopback,
        mic: medal.hasMic,
        source: medal.sourceName
      };
    }
    return { ok: false, error: 'Capture is starting' };
  }
  retargetingCapture = true;
  try {
    return await startMedalEngineLocked(retarget);
  } finally {
    retargetingCapture = false;
  }
}

async function startMedalEngineLocked(retarget) {
  const sources = await listCaptureSources();
  const source = pickGameCaptureSource(sources, medal.sourceId);
  if (!source) return { ok: false, error: 'No screen available to capture' };
  const screenId = screenFallbackId(sources);

  if (medal.active && gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    if (!retarget || medal.sourceId === source.id) {
      instantReplayActive = Boolean(settings.instantReplayEnabled);
      startGameWatch();
      return {
        ok: true,
        already: true,
        audio: medal.hasAudio,
        loopback: medal.hasLoopback,
        mic: medal.hasMic,
        source: medal.sourceName
      };
    }
    if (medal.recording || isRecording) {
      return {
        ok: true,
        already: true,
        audio: medal.hasAudio,
        loopback: medal.hasLoopback,
        mic: medal.hasMic,
        source: medal.sourceName
      };
    }
    await stopMedalEngine({ force: true });
  }

  const fps = 30;
  medal.fps = fps;
  const audio = settings.recordAudio ? '1' : '0';
  const ptt = settings.pttEnabled === true ? '1' : '0';
  const bitrate = settings.spaceSaving ? 6_000_000 : 8_000_000;
  const url = `file://${path.join(__dirname, 'game-capture.html').replace(/\\/g, '/')}?mode=medal&sourceId=${encodeURIComponent(source.id)}&screenId=${encodeURIComponent(screenId)}&fps=${fps}&audio=${audio}&ptt=${ptt}&bitrate=${bitrate}`;

  closeGameCaptureWindow();
  gameCaptureWin = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'game-capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: false,
      enableBlinkFeatures: 'WebCodecs,MediaStreamTrackProcessor',
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  configureCaptureSession(gameCaptureWin, source);

  const ready = new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanupReady();
      resolve({ ok: false, error: 'Capture timed out starting' });
    }, 15000);
    const onStarted = (_e, info) => {
      clearTimeout(t);
      cleanupReady();
      resolve({ ok: true, info });
    };
    const onFailed = (_e, msg) => {
      clearTimeout(t);
      cleanupReady();
      resolve({ ok: false, error: msg || 'Capture failed' });
    };
    function cleanupReady() {
      ipcMain.removeListener('game-capture-started', onStarted);
      ipcMain.removeListener('game-capture-failed', onFailed);
    }
    ipcMain.once('game-capture-started', onStarted);
    ipcMain.once('game-capture-failed', onFailed);
  });

  gameCaptureWin.loadURL(url);
  const result = await ready;
  if (!result.ok) {
    if (/WECODECS/i.test(result.error || '')) webCodecsUnavailable = true;
    closeGameCaptureWindow();
    medal.active = false;
    return result;
  }

  medal.active = true;
  medal.sourceId = source.id;
  medal.sourceName = source.name;
  medal.hasAudio = Boolean(result.info && result.info.audio);
  medal.hasLoopback = Boolean(result.info && result.info.loopback);
  medal.hasMic = Boolean(result.info && result.info.mic);
  medal.audioRate = Number(result.info && result.info.sampleRate) || 48000;
  medal.startedAt = Date.now();
  medal.video = [];
  medal.audio = [];
  instantReplayActive = Boolean(settings.instantReplayEnabled);
  startPowerSave();
  startGameWatch();
  sendCaptureAudioMode();
  broadcastState();
  updateTrayMenu();
  return { ok: true, source: source.name, audio: medal.hasAudio, loopback: medal.hasLoopback, mic: medal.hasMic };
}

async function stopMedalEngine({ force = false } = {}) {
  if (medal.recording && !force) return;
  stopGameWatch();
  medal.active = false;
  medal.recording = false;
  instantReplayActive = false;
  medal.sourceId = null;
  medal.sourceName = null;
  if (gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    gameCaptureWin.webContents.send('game-capture-stop');
    await new Promise((r) => setTimeout(r, 250));
  }
  closeGameCaptureWindow();
  medal.video = [];
  medal.audio = [];
  medal.hasAudio = false;
  medal.hasLoopback = false;
  medal.hasMic = false;
  if (!isRecording) stopPowerSave();
  broadcastState();
  updateTrayMenu();
}

function beginMedalSession() {
  medal.sessionVideo = [];
  medal.sessionAudio = [];
  medal.sessionBytes = 0;
  medal.recording = true;
  isRecording = true;
  isPaused = false;
  recordingStartedAt = Date.now();
  pauseStartedAt = null;
  totalPausedMs = 0;
  session = null;
  usingGameCapture = false;
  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  currentOutputFile = path.join(settings.outputFolder, `recording-${timestamp}.mp4`);
  getOutOfTheWay();
  startStatsPolling();
  updateTrayMenu();
  broadcastState();
  return { ok: true, file: currentOutputFile, mode: 'medal' };
}

async function stopMedalRecording() {
  if (!medal.recording) return { ok: false, error: 'Not recording' };
  medal.recording = false;
  isRecording = false;
  stopStatsPolling();

  const video = medal.sessionVideo.slice();
  const audio = medal.sessionAudio.slice();
  medal.sessionVideo = [];
  medal.sessionAudio = [];
  const out = currentOutputFile;
  let error = null;
  let finalSize = 0;
  try {
    muxMedalMp4(video, audio, out, medal.fps || 30);
    finalSize = fs.existsSync(out) ? fs.statSync(out).size : 0;
  } catch (e) {
    error = e.message || String(e);
  }

  isPaused = false;
  recordingStartedAt = null;
  await resumeReplayAfterRecording();
  if (settings.instantReplayEnabled && medal.active) instantReplayActive = true;
  if (!settings.instantReplayEnabled) await stopMedalEngine({ force: true });
  updateTrayMenu();
  broadcastState();
  restoreMainWindow();

  if (error) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Recording failed',
      message: 'Nothing usable was saved.',
      detail: error,
      buttons: ['OK']
    });
    return { ok: false, error };
  }
  return { ok: true, file: out, fileSize: finalSize };
}

async function saveMedalReplay(saveMinutes) {
  const { video, audio } = sliceMedalReplay(saveMinutes);
  if (!video.length) {
    return { ok: false, error: 'Replay buffer is empty — leave Instant Replay ON for ~15 seconds, then clip' };
  }
  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = saveMinutes < 1 ? '30s' : `${saveMinutes}min`;
  const outputFile = path.join(settings.outputFolder, `replay-${label}-${timestamp}.mp4`);
  try {
    muxMedalMp4(video, audio, outputFile, medal.fps || 30);
  } catch (e) {
    return { ok: false, error: `Save failed: ${e.message || e}` };
  }
  broadcastState();
  return { ok: true, file: outputFile, segments: video.length, saveMinutes };
}

// ---------- Game / exclusive-fullscreen capture (Chromium WGC) ----------
// DXGI desktop duplication goes black in exclusive fullscreen.
// WGC window capture (the game HWND) is what Medal/OBS use.

const SKIP_CAPTURE_WINDOWS = /ordinary recorder|goated recorder|electron|cursor|discord|nvidia|geforce|overlay|steam|spotify|chrome|msedge|explorer|program manager|windows input|text input/i;
const LAUNCHER_WINDOWS = /launcher|bootstrapper|easy anti-cheat|battleye|rockstar games|rgsc/i;

function isGameLikeWindow(name) {
  const n = String(name || '');
  return Boolean(n) && !SKIP_CAPTURE_WINDOWS.test(n) && !LAUNCHER_WINDOWS.test(n);
}

function queryTopWindows() {
  const ps = [
    'Add-Type @"',
    'using System;',
    'using System.Text;',
    'using System.Runtime.InteropServices;',
    'public static class OrdinaryWinEnum {',
    '  public delegate bool EnumProc(IntPtr h, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);',
    '  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);',
    '  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);',
    '  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr h, int n);',
    '  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
    '  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);',
    '  public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }',
    '  static StringBuilder output;',
    '  static IntPtr fg;',
    '  public static bool OnEnum(IntPtr h, IntPtr l) {',
    '    if (!IsWindowVisible(h)) return true;',
    '    if ((GetWindowLong(h, -20) & 0x80) != 0) return true;',
    '    RECT r; GetWindowRect(h, out r);',
    '    int w = r.Right - r.Left; int hgt = r.Bottom - r.Top;',
    '    if (w < 640 || hgt < 400) return true;',
    '    var sb = new StringBuilder(512);',
    '    GetWindowText(h, sb, 512);',
    '    string t = sb.ToString();',
    '    if (string.IsNullOrWhiteSpace(t)) return true;',
    '    t = t.Replace("|", " ").Replace("\\r", " ").Replace("\\n", " ");',
    '    int isFg = (h == fg) ? 1 : 0;',
    '    output.Append(h.ToInt64()).Append("|").Append(w).Append("|").Append(hgt).Append("|").Append(isFg).Append("|").Append(t).Append("\\n");',
    '    return true;',
    '  }',
    '  public static string Dump() {',
    '    output = new StringBuilder();',
    '    fg = GetForegroundWindow();',
    '    EnumWindows(OnEnum, IntPtr.Zero);',
    '    return output.ToString();',
    '  }',
    '}',
    '"@',
    '[OrdinaryWinEnum]::Dump()'
  ].join('\n');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-STA', '-Command', ps], {
      encoding: 'utf8',
      timeout: 4000,
      windowsHide: true
    });
    const lines = String(r.stdout || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    return lines.map((line) => {
      const parts = line.split('|');
      if (parts.length < 5) return null;
      const hwnd = parts[0];
      const width = Number(parts[1]);
      const height = Number(parts[2]);
      const foreground = parts[3] === '1';
      const title = parts.slice(4).join('|').trim();
      if (!hwnd || hwnd === '0' || !title) return null;
      return { hwnd, width, height, foreground, title };
    }).filter(Boolean);
  } catch (e) {
    return [];
  }
}

function isRectFullscreen(info) {
  if (!info || info.width < 640 || info.height < 480) return false;
  try {
    return screen.getAllDisplays().some((d) => (
      info.width >= d.bounds.width - 8 &&
      info.height >= d.bounds.height - 8
    ));
  } catch (e) {
    return info.width >= 1280 && info.height >= 720;
  }
}

function sourceMatchesHwnd(source, hwnd) {
  if (!source || !hwnd) return false;
  const id = String(source.id || '');
  const h = String(hwnd);
  return id.startsWith(`window:${h}:`) || id === `window:${h}` || id.includes(`:${h}:`);
}

function listCaptureSources() {
  return desktopCapturer.getSources({
    types: ['window', 'screen'],
    thumbnailSize: { width: 32, height: 32 },
    fetchWindowIcons: false
  });
}

function matchSourceToWindow(windows, hwnd, title) {
  if (hwnd) {
    const byHwnd = windows.find((s) => sourceMatchesHwnd(s, hwnd));
    if (byHwnd) return byHwnd;
  }
  if (!title) return null;
  const t = String(title).toLowerCase();
  return windows.find((s) => {
    const n = String(s.name || '').toLowerCase();
    return n === t || (t.length > 3 && (n.includes(t) || t.includes(n)));
  }) || null;
}

function isFolderWindow(name) {
  const n = String(name || '').trim();
  if (!n) return true;
  const outBase = path.basename(settings.outputFolder || '');
  if (outBase && n.toLowerCase() === outBase.toLowerCase()) return true;
  if (/^ordianry records$/i.test(n)) return true;
  return false;
}

function gameWindowScore(name, top) {
  const n = String(name || '');
  if (!isGameLikeWindow(n) || isFolderWindow(n)) return -1;
  let score = 1;
  if (/(grand theft|gta v\b|gta5|rage multiplayer|fivem|alt:v|altv)/i.test(n)) score += 12000;
  if (/d3dproxy/i.test(n)) {
    if (top && top.width >= 1280 && top.height >= 720) score += 9000;
    else score += 40;
  }
  if (/grand rp/i.test(n) && !/launcher/i.test(n)) score += 8000;
  if (top && isRectFullscreen(top)) score += 5000;
  if (top) score += Math.min(3000, Math.round((top.width * top.height) / 2000));
  return score;
}

function pickGameCaptureSource(sources, currentId) {
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  const windows = sources.filter((s) => s.id.startsWith('window:'));
  const usableWindows = windows.filter((s) => s.name && !SKIP_CAPTURE_WINDOWS.test(s.name) && !isFolderWindow(s.name));
  const gameWindows = usableWindows.filter((s) => isGameLikeWindow(s.name));
  const tops = queryTopWindows();
  const fg = tops.find((w) => w.foreground && isGameLikeWindow(w.title) && !isFolderWindow(w.title));

  if (fg) {
    const hit = matchSourceToWindow(gameWindows.length ? gameWindows : usableWindows, fg.hwnd, fg.title);
    if (hit && gameWindowScore(hit.name, fg) > 0) {
      lastGameSourceId = hit.id;
      console.log('Capture target (foreground):', hit.name, hit.id);
      return hit;
    }
  }

  const remembered = currentId || lastGameSourceId;
  if (remembered && String(remembered).startsWith('window:')) {
    const cur = gameWindows.find((s) => s.id === remembered);
    if (cur && gameWindowScore(cur.name) > 1) {
      console.log('Capture target (remembered):', cur.name, cur.id);
      return cur;
    }
  }

  const scored = gameWindows.map((s) => {
    const top = tops.find((w) => sourceMatchesHwnd(s, w.hwnd) || String(s.name).toLowerCase() === w.title.toLowerCase());
    return { s, score: gameWindowScore(s.name, top) };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);

  if (scored[0] && scored[0].score >= 8000) {
    lastGameSourceId = scored[0].s.id;
    console.log('Capture target (game window):', scored[0].s.name, scored[0].s.id, 'score', scored[0].score);
    return scored[0].s;
  }

  if (screens[0]) {
    console.log('Capture target (screen WGC) — exclusive fullscreen / no game HWND');
    return screens[0];
  }

  if (scored[0]) {
    lastGameSourceId = scored[0].s.id;
    return scored[0].s;
  }

  return gameWindows[0] || usableWindows[0] || windows[0] || null;
}

function screenFallbackId(sources) {
  const screenSource = sources.find((s) => s.id.startsWith('screen:'));
  return screenSource ? screenSource.id : '';
}

function startGameWatch() {
  if (gameWatchTimer) return;
  gameWatchTimer = setInterval(() => {
    maybeRetargetCapture().catch((e) => console.warn('game watch failed:', e.message || e));
  }, 3000);
}

function stopGameWatch() {
  if (!gameWatchTimer) return;
  clearInterval(gameWatchTimer);
  gameWatchTimer = null;
}

async function maybeRetargetCapture() {
  if (retargetingCapture || !medal.active || medal.recording || isRecording) return;
  await startMedalEngine({ retarget: true });
}

function closeGameCaptureWindow() {
  if (gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    try { gameCaptureWin.close(); } catch (e) { /* ignore */ }
  }
  gameCaptureWin = null;
}

async function convertWebmToMp4(webmPath, mp4Path) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  const run = (args) => {
    execSync(`"${ffmpegPath}" ${args}`, {
      encoding: 'utf8',
      timeout: 300000,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true
    });
  };

  try {
    run(`-hide_banner -y -i "${webmPath}" -c copy -movflags +faststart "${mp4Path}"`);
  } catch (e) {
    try {
      if (ffmpegCaps.hasH264Amf) {
        run(`-hide_banner -y -i "${webmPath}" -c:v h264_amf -quality speed -b:v 6M -c:a aac -b:a 160k -movflags +faststart "${mp4Path}"`);
      } else {
        throw e;
      }
    } catch (e2) {
      run(`-hide_banner -y -i "${webmPath}" -c:v libx264 -preset ultrafast -crf 23 -c:a aac -b:a 160k -movflags +faststart "${mp4Path}"`);
    }
  }
  if (!fs.existsSync(mp4Path) || fs.statSync(mp4Path).size < 8192) {
    throw new Error('Could not convert capture to mp4');
  }
}

async function startGameCapture() {
  // Clicking Start focuses this app — hide first so the game can become foreground
  getOutOfTheWay();
  await new Promise((r) => setTimeout(r, 700));

  const sources = await listCaptureSources();
  console.log(
    'Visible capture windows:',
    sources.filter((s) => s.id.startsWith('window:') && s.name).map((s) => s.name).join(' | ') || '(none)'
  );
  const source = pickGameCaptureSource(sources, medal.sourceId || lastGameSourceId);
  if (!source) {
    restoreMainWindow();
    return { ok: false, error: 'No game window found. Open the game, then press Ctrl+Shift+R while it is in front.' };
  }
  lastGameSourceId = source.id;
  console.log('Game capture source:', source.name, source.id);

  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  gameCaptureFile = path.join(settings.outputFolder, `recording-${timestamp}.webm`);
  currentOutputFile = path.join(settings.outputFolder, `recording-${timestamp}.mp4`);
  gameCaptureBytes = 0;
  gameCaptureStream = fs.createWriteStream(gameCaptureFile);
  usingGameCapture = true;

  // Fullscreen WGC path — 30fps / up to 1080p (tuned in game-capture.html)
  const fps = Math.min(30, effectiveFps());
  const audio = settings.recordAudio ? '1' : '0';
  const quality = settings.spaceSaving ? 'light' : 'full';
  const url = `file://${path.join(__dirname, 'game-capture.html').replace(/\\/g, '/')}?mode=record&sourceId=${encodeURIComponent(source.id)}&screenId=${encodeURIComponent(screenFallbackId(sources))}&fps=${fps}&audio=${audio}&quality=${quality}`;

  gameCaptureWin = new BrowserWindow({
    show: false,
    width: 64,
    height: 64,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'game-capture-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      offscreen: false,
      enableBlinkFeatures: 'WebCodecs,MediaStreamTrackProcessor',
      autoplayPolicy: 'no-user-gesture-required'
    }
  });

  configureCaptureSession(gameCaptureWin, source);

  const ready = new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanupReady();
      resolve({ ok: false, error: 'Game capture timed out starting' });
    }, 15000);

    const onStarted = (_e, info) => {
      clearTimeout(t);
      cleanupReady();
      gameCaptureMime = (info && info.mimeType) || 'video/webm';
      resolve({ ok: true, source: source.name });
    };
    const onFailed = (_e, msg) => {
      clearTimeout(t);
      cleanupReady();
      resolve({ ok: false, error: msg || 'Game capture failed' });
    };
    function cleanupReady() {
      ipcMain.removeListener('game-capture-started', onStarted);
      ipcMain.removeListener('game-capture-failed', onFailed);
    }
    ipcMain.once('game-capture-started', onStarted);
    ipcMain.once('game-capture-failed', onFailed);
  });

  gameCaptureWin.loadURL(url);
  const result = await ready;
  if (!result.ok) {
    try {
      if (gameCaptureFile && fs.existsSync(gameCaptureFile)) fs.unlinkSync(gameCaptureFile);
    } catch (e) { /* ignore */ }
    cleanupGameCaptureFiles();
    closeGameCaptureWindow();
    usingGameCapture = false;
    gameCaptureFile = null;
    return result;
  }

  isRecording = true;
  isPaused = false; // pause not supported on this path yet
  recordingStartedAt = Date.now();
  pauseStartedAt = null;
  totalPausedMs = 0;
  session = null;

  getOutOfTheWay();
  startStatsPolling();
  updateTrayMenu();
  broadcastState();
  return { ok: true, file: currentOutputFile, mode: 'game-capture', source: result.source };
}

function cleanupGameCaptureFiles() {
  try { if (gameCaptureStream) gameCaptureStream.end(); } catch (e) { /* ignore */ }
  gameCaptureStream = null;
  gameCaptureBytes = 0;
}

async function stopGameCapture() {
  if (!usingGameCapture) return { ok: false, error: 'Not using game capture' };

  const stopPromise = new Promise((resolve) => {
    gameCaptureDone = resolve;
    const t = setTimeout(() => resolve('timeout'), 10000);
    ipcMain.once('game-capture-stopped', () => {
      clearTimeout(t);
      resolve('stopped');
    });
  });

  if (gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    gameCaptureWin.webContents.send('game-capture-stop');
  }

  await stopPromise;
  closeGameCaptureWindow();

  try { if (gameCaptureStream) gameCaptureStream.end(); } catch (e) { /* ignore */ }
  gameCaptureStream = null;

  // Flush
  await new Promise((r) => setTimeout(r, 300));

  const webm = gameCaptureFile;
  const mp4 = currentOutputFile;
  let error = null;
  let finalSize = 0;

  try {
    if (!webm || !fs.existsSync(webm) || fs.statSync(webm).size < 8192) {
      error = 'Fullscreen capture got no frames. Disable Discord/NVIDIA overlay, then start recording with Ctrl+Shift+R AFTER the game is already fullscreen.';
    } else {
      await convertWebmToMp4(webm, mp4);
      finalSize = fs.statSync(mp4).size;
      try { fs.unlinkSync(webm); } catch (e) { /* keep webm if delete fails */ }
    }
  } catch (e) {
    // If convert fails but webm exists, rename webm to final name for the user
    try {
      if (webm && fs.existsSync(webm)) {
        const fallback = mp4.replace(/\.mp4$/i, '.webm');
        fs.renameSync(webm, fallback);
        currentOutputFile = fallback;
        finalSize = fs.statSync(fallback).size;
        error = null;
      } else {
        error = e.message || String(e);
      }
    } catch (e2) {
      error = e.message || String(e);
    }
  }

  usingGameCapture = false;
  gameCaptureFile = null;
  isRecording = false;
  isPaused = false;
  recordingStartedAt = null;
  stopStatsPolling();
  await resumeReplayAfterRecording();
  updateTrayMenu();
  broadcastState();
  restoreMainWindow();

  if (error) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Recording failed',
      message: 'Fullscreen capture did not save usable video.',
      detail: error,
      buttons: ['OK']
    });
    return { ok: false, error };
  }
  return { ok: true, file: currentOutputFile, fileSize: finalSize };
}

ipcMain.on('medal-video-chunk', (_e, buf, type, timestamp) => {
  if (!medal.active) return;
  try {
    const item = {
      buf: Buffer.from(buf),
      type: type === 'key' ? 'key' : 'delta',
      ts: Number(timestamp) || 0
    };
    medal.video.push(item);
    if (medal.recording && !isPaused) {
      medal.sessionVideo.push(item);
      medal.sessionBytes += item.buf.length;
    }
    pruneMedalRing();
  } catch (e) {
    console.error('medal video chunk failed:', e);
  }
});

ipcMain.on('medal-audio-chunk', (_e, buf) => {
  if (!medal.active) return;
  try {
    const item = { buf: Buffer.from(buf) };
    medal.audio.push(item);
    if (medal.recording && !isPaused) medal.sessionAudio.push(item);
  } catch (e) {
    console.error('medal audio chunk failed:', e);
  }
});

ipcMain.on('medal-capture-stats', (_e, info) => {
  if (!info || info.captureFps == null) return;
  liveCaptureFps = Number(info.captureFps);
  if (typeof info.audioPeak === 'number') lastAudioPeak = info.audioPeak;
  if (typeof info.hasLoopback === 'boolean') medal.hasLoopback = info.hasLoopback;
  if (typeof info.hasMic === 'boolean') medal.hasMic = info.hasMic;
  if (info.audioLive != null) medal.hasAudio = Boolean(info.audioLive);
  if (isRecording) pushCaptureStatsToUi();
});

// Wire chunk IPC once
ipcMain.on('game-capture-chunk', (_e, buf) => {
  if (!usingGameCapture || !gameCaptureStream) return;
  try {
    const data = Buffer.from(buf);
    gameCaptureBytes += data.length;
    gameCaptureStream.write(data);
  } catch (e) {
    console.error('game capture write failed:', e);
  }
});

// ---------- Recording control ----------
async function startRecording() {
  if (isRecording) return { ok: false, error: 'Already recording' };

  // If startup probe hasn't finished / failed transiently, retry once now
  if (!ffmpegCaps.available) {
    probeFfmpeg();
  }

  if (!ffmpegCaps.available) {
    showFfmpegWarning(ffmpegCaps);
    return {
      ok: false,
      error: 'FFmpeg not found. Put ffmpeg.exe in the ffmpeg/ folder or install it and add to PATH.'
    };
  }

  // Instant Replay holds DXGI — release it, then capture with a fresh DDA session
  if (instantReplayActive || replayProcess) {
    await pauseReplayForRecording();
  } else if (settings.instantReplayEnabled) {
    replayPausedForRecording = false;
  }

  const audioDevice = getSelectedAudioDevice();
  if (settings.recordAudio && !audioDevice) {
    console.warn('No audio device selected. Recording video only.');
    if (settings.audioSource !== 'mic') {
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'warning',
        title: 'Game audio not available',
        message: 'No system/game audio device found.',
        detail: 'You have VB-Cable or need Stereo Mix.\n\n1) Open Sound settings → Playback → set default to “CABLE Input” (hear via Cable app or set Listening).\n2) In Ordinary Recorder pick “CABLE Output (VB-Audio Virtual Cable)”.\n\nOr switch Audio source to Microphone for voice only.',
        buttons: ['OK']
      });
    }
  } else if (
    settings.recordAudio &&
    settings.audioSource !== 'mic' &&
    audioDevice &&
    isMicrophoneDevice(audioDevice)
  ) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'info',
      title: 'Recording microphone only',
      message: 'Audio device is a microphone — game sounds will not be recorded.',
      detail: 'Select “CABLE Output (VB-Audio Virtual Cable)” under Audio device, and set Windows/game output to “CABLE Input”.',
      buttons: ['OK']
    });
  }

  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionFolder = path.join(settings.outputFolder, `.session-${timestamp}`);
  fs.mkdirSync(sessionFolder, { recursive: true });

  currentOutputFile = path.join(settings.outputFolder, `recording-${timestamp}.mp4`);

  let useDdagrab = ffmpegCaps.hasDdagrab;
  // Game mode: always use working h264_amf when available (skip flaky hevc)
  let useAmf = Boolean(ffmpegCaps.hasH264Amf || (!settings.gameMode && ffmpegCaps.hasHevcAmf));
  if (settings.gameMode) useDdagrab = ffmpegCaps.hasDdagrab; // never prefer GDI for games

  session = {
    folder: sessionFolder,
    finalFile: currentOutputFile,
    segmentIndex: 1,
    segments: [],
    useDdagrab,
    useAmf,
    forceAmfDownload: false,
    audioDevice,
    useWasapi: Boolean(settings.recordAudio && settings.audioSource !== 'mic'),
    intent: 'running'
  };

  isRecording = true;
  isPaused = false;
  recordingStartedAt = Date.now();
  pauseStartedAt = null;
  totalPausedMs = 0;
  resetCaptureStats();

  getOutOfTheWay();
  await new Promise((r) => setTimeout(r, 400));

  launchSegment();
  startStatsPolling();
  updateTrayMenu();
  broadcastState();
  return { ok: true, file: currentOutputFile, replayPaused: replayPausedForRecording };
}

async function pauseRecording() {
  if (!isRecording) return { ok: false, error: 'Not recording' };
  if (medal.recording) {
    isPaused = true;
    pauseStartedAt = Date.now();
    updateTrayMenu();
    broadcastState();
    showMainWindow();
    return { ok: true, isPaused: true };
  }
  if (usingGameCapture) {
    return { ok: false, error: 'Pause is not available during fullscreen game capture — use Stop' };
  }
  if (isPaused) return { ok: false, error: 'Already paused' };
  if (!ffmpegProcess || !session) return { ok: false, error: 'No active segment' };

  session.intent = 'pausing';
  const proc = ffmpegProcess;
  sendQuit(proc);
  await waitForProcessClose(proc);

  isPaused = true;
  pauseStartedAt = Date.now();
  updateTrayMenu();
  broadcastState();
  showMainWindow();
  return { ok: true, isPaused: true };
}

async function resumeRecording() {
  if (!isRecording) return { ok: false, error: 'Not recording' };
  if (!isPaused) return { ok: false, error: 'Not paused' };
  if (medal.recording) {
    if (pauseStartedAt) {
      totalPausedMs += Date.now() - pauseStartedAt;
      pauseStartedAt = null;
    }
    isPaused = false;
    updateTrayMenu();
    broadcastState();
    return { ok: true, isPaused: false };
  }
  if (!session) return { ok: false, error: 'No active session' };

  if (pauseStartedAt) {
    totalPausedMs += Date.now() - pauseStartedAt;
    pauseStartedAt = null;
  }

  nextSegmentPath(); // advances segmentIndex for segment-2, segment-3, ...
  isPaused = false;
  launchSegment();
  updateTrayMenu();
  broadcastState();
  return { ok: true, isPaused: false };
}

async function stopRecording() {
  if (!isRecording) return { ok: false, error: 'Not recording' };
  if (medal.recording) return stopMedalRecording();
  if (usingGameCapture) return stopGameCapture();
  if (!session) return { ok: false, error: 'Not recording' };

  const activeSession = session;

  if (!isPaused && ffmpegProcess) {
    activeSession.intent = 'stopping';
    const proc = ffmpegProcess;
    sendQuit(proc);
    await waitForProcessClose(proc);
  } else if (isPaused) {
    // Segment already finalized on pause; nothing to quit
  }

  // Ensure current segment is tracked if it finished with content
  try {
    const last = path.join(activeSession.folder, `segment-${activeSession.segmentIndex}.mp4`);
    if (fs.existsSync(last) && fs.statSync(last).size > 0 && !activeSession.segments.includes(last)) {
      activeSession.segments.push(last);
    }
  } catch (e) { /* ignore */ }

  let concatError = null;
  let finalSize = 0;
  try {
      if (activeSession.segments.length === 0) {
      concatError = 'No video was captured (0 bytes). Leave the game in exclusive fullscreen, turn Game Mode + Fullscreen capture ON, then press Ctrl+Shift+R.';
    } else {
      concatSegments(activeSession.segments, activeSession.finalFile);
      currentOutputFile = activeSession.finalFile;
      try {
        finalSize = fs.existsSync(currentOutputFile) ? fs.statSync(currentOutputFile).size : 0;
      } catch (e) { finalSize = 0; }
      if (finalSize < 8192) {
        concatError = 'Recording file is empty/too small. Keep Game Mode + Fullscreen capture ON, start the game fullscreen first, then Ctrl+Shift+R.';
        try { if (fs.existsSync(currentOutputFile)) fs.unlinkSync(currentOutputFile); } catch (e) { /* ignore */ }
      }
    }
  } catch (e) {
    concatError = e.message || String(e);
    console.error('Concat failed:', e);
  }

  rmSessionFolder(activeSession.folder);

  isRecording = false;
  isPaused = false;
  recordingStartedAt = null;
  pauseStartedAt = null;
  totalPausedMs = 0;
  session = null;
  ffmpegProcess = null;
  resetCaptureStats();
  stopStatsPolling();

  // Resume Instant Replay buffer if it was paused for this recording
  await resumeReplayAfterRecording();

  updateTrayMenu();
  broadcastState();
  restoreMainWindow();

  if (concatError) {
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: 'Recording failed',
      message: 'Nothing usable was saved.',
      detail: concatError,
      buttons: ['OK']
    });
    return { ok: false, error: concatError, file: currentOutputFile };
  }
  return { ok: true, file: currentOutputFile, fileSize: finalSize };
}

function broadcastState() {
  const payload = getStatePayload();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('recording-state', payload);
    mainWindow.webContents.send('instant-replay-state', payload.instantReplay);
  }
  if (tray) {
    if (isRecording) {
      const elapsed = Math.floor((payload.elapsedMs || 0) / 1000);
      const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
      const ss = String(elapsed % 60).padStart(2, '0');
      tray.setToolTip(
        isPaused
          ? `Ordinary Recorder — Paused ${mm}:${ss} · ${formatBytesShort(payload.fileSize)}`
          : `Ordinary Recorder — Recording ${mm}:${ss} · ${formatBytesShort(payload.fileSize)}`
      );
    } else if (instantReplayActive) {
      tray.setToolTip(`Ordinary Recorder — Replay buffer (${payload.instantReplay.minutes} min)`);
    } else {
      tray.setToolTip('Ordinary Recorder');
    }
  }
}

function updateTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: 'Show', click: () => mainWindow.show() },
    {
      label: isRecording ? 'Stop Recording' : 'Start Recording',
      click: () => {
        if (isRecording) stopRecording();
        else startRecording();
      }
    },
    {
      label: isPaused ? 'Resume' : 'Pause',
      enabled: isRecording,
      click: () => {
        if (isPaused) resumeRecording();
        else pauseRecording();
      }
    },
    { type: 'separator' },
    {
      label: instantReplayActive ? 'Instant Replay: ON' : 'Instant Replay: OFF',
      click: () => toggleInstantReplay(!settings.instantReplayEnabled)
    },
    {
      label: 'Save Replay Clip',
      enabled: Boolean(settings.instantReplayEnabled || medal.active),
      click: () => saveInstantReplay()
    },
    { label: 'Open recordings folder', click: () => shell.openPath(settings.outputFolder) },
    { type: 'separator' },
    { label: 'Quit', click: () => { app.isQuiting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
}

// ---------- Window / Tray ----------
function registerGlobalHotkeys() {
  try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }

  const bind = (acc, fn) => {
    if (!acc) return false;
    try {
      return Boolean(globalShortcut.register(acc, fn));
    } catch (e) {
      console.warn('Hotkey failed:', acc, e.message || e);
      return false;
    }
  };

  const recOk = bind(settings.hotkey, () => {
    if (isRecording) stopRecording();
    else startRecording();
  });
  const pauseOk = bind(settings.pauseHotkey, () => {
    if (!isRecording) return;
    if (isPaused) resumeRecording();
    else pauseRecording();
  });
  const clipOk = bind(settings.replayHotkey, () => {
    if (!settings.instantReplayEnabled && !medal.active) return;
    saveInstantReplay();
  });

  return {
    hotkey: recOk,
    pauseHotkey: pauseOk,
    replayHotkey: clipOk
  };
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 760,
    minWidth: 980,
    minHeight: 640,
    resizable: true,
    autoHideMenuBar: true,
    backgroundColor: '#080909',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: true
    }
  });
  mainWindow.loadFile('index.html');

  mainWindow.on('close', (e) => {
    if (!app.isQuiting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

function createTray() {
  const iconPath = path.join(__dirname, 'assets', 'icon.png');
  tray = new Tray(iconPath);
  updateTrayMenu();
  tray.setToolTip('Ordinary Recorder');
  tray.on('double-click', () => mainWindow.show());
}

// ---------- IPC ----------
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('save-settings', (e, newSettings) => {
  const prevFps = settings.instantReplayFps;
  const prevGame = settings.gameMode;
  const prevAudio = settings.recordAudio;
  const prevBufferMinutes = settings.instantReplayMinutes;
  const prevPtt = settings.pttEnabled;
  const prevHotkeys = {
    hotkey: settings.hotkey,
    pauseHotkey: settings.pauseHotkey,
    replayHotkey: settings.replayHotkey
  };
  settings = { ...settings, ...newSettings };

  if (settings.gameMode) {
    settings.instantReplayFps = Math.min(30, Number(settings.instantReplayFps) || 30);
    if (settings.instantReplayFps !== 15 && settings.instantReplayFps !== 30) {
      settings.instantReplayFps = 30;
    }
  }

  settings.instantReplayMinutes = Math.min(5, Math.max(1, Number(settings.instantReplayMinutes) || 5));
  const saveOpts = [0.5, 1, 2, 3, 4, 5];
  const saveMin = Number(settings.instantReplaySaveMinutes);
  settings.instantReplaySaveMinutes = saveOpts.includes(saveMin) ? saveMin : 2;
  const fpsOpts = [15, 30, 60];
  if (!fpsOpts.includes(Number(settings.instantReplayFps))) {
    settings.instantReplayFps = 30;
  } else {
    settings.instantReplayFps = Number(settings.instantReplayFps);
  }
  settings.fps = Number(settings.fps) === 60 ? 60 : 30;
  settings.exclusiveFullscreen = Boolean(settings.exclusiveFullscreen);
  settings.gameMode = Boolean(settings.gameMode);
  settings.amfRateControl = settings.amfRateControl === 'cqp' ? 'cqp' : 'vbr_peak';
  settings.audioSource = settings.audioSource === 'mic' ? 'mic' : 'system';
  settings.pttEnabled = settings.pttEnabled === true;
  settings.pttKey = PTT_KEYS[settings.pttKey] ? settings.pttKey : 'V';
  settings.hotkey = sanitizeAccelerator(settings.hotkey, defaultSettings.hotkey);
  settings.pauseHotkey = sanitizeAccelerator(settings.pauseHotkey, defaultSettings.pauseHotkey);
  settings.replayHotkey = sanitizeAccelerator(settings.replayHotkey, defaultSettings.replayHotkey);
  settings.settingsVersion = SETTINGS_VERSION;

  const hotkeyList = [settings.hotkey, settings.pauseHotkey, settings.replayHotkey];
  let hotkeyError = null;
  if (new Set(hotkeyList).size !== hotkeyList.length) {
    settings.hotkey = prevHotkeys.hotkey;
    settings.pauseHotkey = prevHotkeys.pauseHotkey;
    settings.replayHotkey = prevHotkeys.replayHotkey;
    hotkeyError = 'Each action needs a different shortcut';
  }

  // Re-resolve device when switching system/mic
  try {
    if (ffmpegCaps.available) {
      const devices = listDshowAudioDevices();
      const resolved = resolveAudioDevice(devices);
      if (resolved) settings.audioDevice = resolved;
    }
  } catch (e) { /* ignore */ }

  saveSettings(settings);
  startPttWatcher();
  sendCaptureAudioMode();
  const registered = registerGlobalHotkeys();
  if (!hotkeyError) {
    const failed = Object.entries(registered).filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) {
      settings.hotkey = prevHotkeys.hotkey;
      settings.pauseHotkey = prevHotkeys.pauseHotkey;
      settings.replayHotkey = prevHotkeys.replayHotkey;
      saveSettings(settings);
      registerGlobalHotkeys();
      hotkeyError = 'That shortcut is already used by Windows or another app';
    }
  }

  // Restart buffer if FPS / game mode / audio capture changed while idle
  const audioChanged = prevAudio !== settings.recordAudio;
  if (
    medal.active &&
    !isRecording &&
    audioChanged
  ) {
    setImmediate(async () => {
      try {
        await stopMedalEngine({ force: true });
        if (settings.instantReplayEnabled) await startMedalEngine();
      } catch (err) {
        console.warn('Failed to restart capture after audio change:', err.message || err);
      }
    });
  } else if (
    instantReplayActive &&
    !isRecording &&
    !medal.active &&
    (prevFps !== settings.instantReplayFps || prevGame !== settings.gameMode || prevBufferMinutes !== settings.instantReplayMinutes)
  ) {
    restartReplayProcess();
  }

  return { ...settings, hotkeyError };
});
ipcMain.handle('list-audio-devices', () => {
  if (!ffmpegCaps.available) return { devices: [], hint: 'FFmpeg not ready', audioSource: settings.audioSource };
  const devices = listDshowAudioDevices();
  return {
    devices,
    hint: getAudioSetupHint(devices),
    audioSource: settings.audioSource === 'mic' ? 'mic' : 'system',
    preferred: resolveAudioDevice(devices)
  };
});
ipcMain.handle('start-recording', async () => {
  try {
    const result = await startRecording();
    if (result && !result.ok) result.error = friendlyCaptureError(result.error);
    return result;
  } catch (e) {
    return { ok: false, error: friendlyCaptureError(e && e.message ? e.message : e) };
  }
});
ipcMain.handle('stop-recording', () => stopRecording());
ipcMain.handle('pause-recording', () => pauseRecording());
ipcMain.handle('resume-recording', () => resumeRecording());
ipcMain.handle('toggle-instant-replay', (e, enable) => toggleInstantReplay(enable));
ipcMain.handle('save-instant-replay', (e, saveMinutes) => saveInstantReplay(saveMinutes));
ipcMain.handle('get-instant-replay-state', () => getInstantReplayState());
ipcMain.handle('get-state', () => getStatePayload());
ipcMain.handle('choose-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] });
  if (result.canceled) return settings.outputFolder;
  settings.outputFolder = result.filePaths[0];
  saveSettings(settings);
  return settings.outputFolder;
});
ipcMain.handle('open-folder', () => shell.openPath(settings.outputFolder));
ipcMain.handle('list-recordings', () => {
  const folder = settings.outputFolder;
  const files = [];
  try {
    if (!fs.existsSync(folder)) return { folder, files };
    for (const name of fs.readdirSync(folder)) {
      if (!name || name.startsWith('.')) continue;
      if (!/\.(mp4|webm|mkv|mov)$/i.test(name)) continue;
      const full = path.join(folder, name);
      let st;
      try { st = fs.statSync(full); } catch (e) { continue; }
      if (!st.isFile()) continue;
      files.push({ name, path: full, size: st.size, mtime: st.mtimeMs });
    }
    files.sort((a, b) => b.mtime - a.mtime);
  } catch (e) {
    return { folder, files: [], error: String(e.message || e) };
  }
  return { folder, files: files.slice(0, 80) };
});
ipcMain.handle('open-recording', (_e, filePath) => {
  const resolved = path.resolve(String(filePath || ''));
  const root = path.resolve(settings.outputFolder);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false };
  shell.openPath(resolved);
  return { ok: true };
});
ipcMain.handle('show-recording', (_e, filePath) => {
  const resolved = path.resolve(String(filePath || ''));
  const root = path.resolve(settings.outputFolder);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false };
  shell.showItemInFolder(resolved);
  return { ok: true };
});
ipcMain.handle('set-hotkey-capture', (_e, enable) => {
  if (enable) {
    try { globalShortcut.unregisterAll(); } catch (e) { /* ignore */ }
    return { ok: true };
  }
  return { ok: true, registered: registerGlobalHotkeys() };
});

// ---------- App lifecycle ----------
app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return;

  createWindow();
  createTray();
  startPttWatcher();
  registerGlobalHotkeys();

  // Async probe — never block the UI thread with long sync waits / HEVC tests
  setTimeout(async () => {
    try {
      const caps = await probeFfmpegAsync();
      console.log('FFmpeg path:', caps.path, caps);
      showFfmpegWarning(caps);

      if (settings.instantReplayEnabled && !isRecording) {
        startReplayProcess({ clearBuffer: true });
      }
    } catch (e) {
      console.error('FFmpeg probe failed:', e);
    }
  }, app.isPackaged ? 1200 : 600);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep running in tray instead of fully quitting
  }
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopStatsPolling();
  stopPttWatcher();
  stopGameWatch();
  stopPowerSave();
  if (gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    try { gameCaptureWin.webContents.send('game-capture-stop'); } catch (e) { /* ignore */ }
  }
  if (ffmpegProcess) {
    try { ffmpegProcess.stdin.write('q'); } catch (e) {
      try { ffmpegProcess.kill(); } catch (e2) { /* ignore */ }
    }
  }
  if (replayProcess) {
    try { replayProcess.stdin.write('q'); } catch (e) {
      try { replayProcess.kill(); } catch (e2) { /* ignore */ }
    }
  }
});
