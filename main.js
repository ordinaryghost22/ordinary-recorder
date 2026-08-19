const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, dialog, shell, desktopCapturer, powerSaveBlocker, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { pathToFileURL } = require('url');
const { spawn, spawnSync, execSync } = require('child_process');
const { createRecState } = require('./engine/rec-state');
const { createDiag } = require('./engine/diag');
const { friendlyError, userFacing } = require('./engine/errors');
const { verifyOutputBasics, verifyFromFfmpegProbe, parseDurationSeconds } = require('./engine/verify');
const { createDebouncer, createJobQueue, shouldRetestUnstableGame, canRecoverCandidate } = require('./engine/guards');

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
app.commandLine.appendSwitch('enable-features',
  'WebRtcAllowWgcScreenCapturer,WebRtcAllowWgcWindowCapturer,AllowWgcScreenCapturer,AllowWgcWindowCapturer,WebCodecs'
);
app.commandLine.appendSwitch('allow-file-access-from-files');

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
let loopbackWin = null;
let loopbackStream = null;
let loopbackFile = null;
let loopbackBytes = 0;
let loopbackReady = false;

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
  sourceName: null,
  rawFormat: 'h264',
  workFile: null,
  partialVideo: null,
  partialAudio: null,
  partialMeta: null,
  partialFdV: null,
  partialFdA: null
};

let powerSaveId = null;
let lastAudioPeak = 0;
let lastMediaTickAt = 0;
let captureUnhealthy = false;
let captureRecoverTries = 0;
let gameWatchTimer = null;
let desktopGameWatchTimer = null;
let retargetingCapture = false;
let switchingToGame = false;
let recordingHandoff = null;

/** Probed once at startup — used to pick capture/encoder paths and warn the user. */
let ffmpegCaps = {
  path: 'ffmpeg',
  available: false,
  hasDdagrab: false,
  hasH264Amf: false,
  hasHevcAmf: false,
  hasAv1Amf: false,
  hasH264Nvenc: false,
  hasHevcNvenc: false,
  hasAv1Nvenc: false,
  hasH264Qsv: false,
  hasHevcQsv: false,
  hasAv1Qsv: false,
  hasWasapi: false
};

/** GPU / RAM / CPU snapshot + the encoder that was actually selected. */
let hardwareInfo = {
  ready: false,
  gpus: [],
  vendor: 'unknown',
  gpuName: 'Unknown GPU',
  vramBytes: 0,
  ramBytes: os.totalmem(),
  cpuCores: Math.max(1, os.cpus().length),
  cpuModel: (os.cpus()[0] && os.cpus()[0].model) || 'CPU',
  discrete: false,
  tier: 'mid',
  encoder: null,
  reason: 'Not probed yet'
};

// ---------- Settings (persisted to a plain JSON file next to the exe) ----------
const settingsPath = path.join(app.getPath('userData'), 'settings.json');

const REPLAY_SEGMENT_SECONDS = 10;

const SETTINGS_VERSION = 11;

const defaultSettings = {
  settingsVersion: SETTINGS_VERSION,
  fps: 30,
  gameMode: true,
  exclusiveFullscreen: true,
  spaceSaving: true,
  amfRateControl: 'vbr_peak',
  encoder: 'auto',
  videoCodec: 'h264',
  outputResolution: 'native',
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
  bookmarkHotkey: 'CommandOrControl+Shift+B',
  instantReplayEnabled: true,
  instantReplayMinutes: 5,
  instantReplaySaveMinutes: 2,
  instantReplayFps: 30,
  wizardCompleted: false,
  hardwareProfile: null,
  diskSpaceLimitMb: 500,
  knownUnstableGames: [],
  audioFallbackNoticeShown: false
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
      if (!Number.isFinite(ver) || ver < 9) {
        // Existing installs already finished first-run; only brand-new profiles see the wizard
        loaded.wizardCompleted = true;
        loaded.encoder = loaded.encoder || 'auto';
        loaded.videoCodec = loaded.videoCodec === 'hevc' || loaded.videoCodec === 'av1' ? loaded.videoCodec : 'h264';
        loaded.outputResolution = ['native', '1440', '1080', '720'].includes(loaded.outputResolution)
          ? loaded.outputResolution
          : 'native';
        migrated = true;
      }
      if (!Number.isFinite(ver) || ver < 10) {
        loaded.diskSpaceLimitMb = Number(loaded.diskSpaceLimitMb) > 0 ? Number(loaded.diskSpaceLimitMb) : 500;
        loaded.knownUnstableGames = Array.isArray(loaded.knownUnstableGames) ? loaded.knownUnstableGames : [];
        migrated = true;
      }
      if (!Number.isFinite(ver) || ver < 11) {
        loaded.bookmarkHotkey = loaded.bookmarkHotkey || 'CommandOrControl+Shift+B';
        migrated = true;
      }
      if (migrated) loaded.settingsVersion = SETTINGS_VERSION;
      loaded.encoder = ['auto', 'nvenc', 'amf', 'qsv', 'x264'].includes(loaded.encoder) ? loaded.encoder : 'auto';
      loaded.videoCodec = ['h264', 'hevc', 'av1'].includes(loaded.videoCodec) ? loaded.videoCodec : 'h264';
      loaded.outputResolution = ['native', '1440', '1080', '720'].includes(loaded.outputResolution)
        ? loaded.outputResolution
        : 'native';
      loaded.wizardCompleted = loaded.wizardCompleted === true;
      loaded.instantReplayMinutes = Math.min(5, Math.max(1, Number(loaded.instantReplayMinutes) || 5));
      const saveOpts = [0.5, 1, 2, 3, 4, 5];
      const saveMin = Number(loaded.instantReplaySaveMinutes);
      loaded.instantReplaySaveMinutes = saveOpts.includes(saveMin) ? saveMin : 2;
      const fpsOpts = [15, 30, 60, 144];
      loaded.instantReplayFps = fpsOpts.includes(Number(loaded.instantReplayFps))
        ? Number(loaded.instantReplayFps)
        : 30;
      loaded.exclusiveFullscreen = Boolean(loaded.exclusiveFullscreen);
      loaded.gameMode = loaded.gameMode !== false;
      loaded.amfRateControl = loaded.amfRateControl === 'cqp' ? 'cqp' : 'vbr_peak';
      loaded.audioSource = loaded.audioSource === 'mic' ? 'mic' : 'system';
      loaded.pttEnabled = loaded.pttEnabled === true;
      loaded.pttKey = PTT_KEYS[loaded.pttKey] ? loaded.pttKey : 'V';
      loaded.fps = [30, 60, 144].includes(Number(loaded.fps)) ? Number(loaded.fps) : 30;
      loaded.diskSpaceLimitMb = Math.min(4096, Math.max(200, Number(loaded.diskSpaceLimitMb) || 500));
      loaded.knownUnstableGames = sanitizeKnownGames(loaded.knownUnstableGames);
      loaded.hotkey = sanitizeAccelerator(loaded.hotkey, defaultSettings.hotkey);
      loaded.pauseHotkey = sanitizeAccelerator(loaded.pauseHotkey, defaultSettings.pauseHotkey);
      loaded.replayHotkey = sanitizeAccelerator(loaded.replayHotkey, defaultSettings.replayHotkey);
      loaded.bookmarkHotkey = sanitizeAccelerator(loaded.bookmarkHotkey, defaultSettings.bookmarkHotkey);
      if (migrated) {
        try { fs.writeFileSync(settingsPath, JSON.stringify(loaded, null, 2)); } catch (e) { /* ignore */ }
      }
      return loaded;
    }
  } catch (e) { /* fall through to defaults */ }
  return { ...defaultSettings };
}

function saveSettings(next) {
  try {
    fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2));
  } catch (e) {
    diag.error('STORAGE', 'Could not save settings', { err: e.message || String(e) });
  }
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
let lastDiskFreeBytes = null;
let lastDiskWarning = null;
let lastAppNotice = null;
let diskPollTimer = null;
let diskStopInFlight = false;
let medalSpillAt = 0;
let quittingClean = false;
let lastLoopbackPeak = 0;
let lastMicPeak = 0;
let audioWatchTimer = null;
let lastAudioDeviceSnapshot = '';
let audioSwitchInFlight = false;
let replayBookmarks = [];
let lastReplaySave = { ok: null, at: 0, error: null, file: null };
let replayBufferStartedAt = 0;
const hotkeyDebounce = {
  rec: createDebouncer(400),
  pause: createDebouncer(350),
  clip: createDebouncer(450),
  mark: createDebouncer(180)
};
const replaySaveQueue = createJobQueue();
let audioProbe = {
  devices: [],
  wasapiListed: false,
  wasapiWorks: null,
  stereoMix: null,
  virtualCable: null,
  loopbackKind: 'none',
  hint: '',
  warning: false,
  at: 0
};

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
    } catch (e) {
      console.warn('Could not resolve exe dir for ffmpeg search:', e.message || e);
    }
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

function pickMicrophoneDevice(devices) {
  const list = Array.isArray(devices) && devices.length ? devices : listDshowAudioDevices();
  return list.find((d) => isMicrophoneDevice(d)) || null;
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

function classifyAudioDevice(name) {
  const n = String(name || '');
  if (/cable output|vb-audio|virtual-audio-capturer/i.test(n)) return 'vb-cable';
  if (/stereo mix|what u hear|wave out mix/i.test(n)) return 'stereo-mix';
  if (isMicrophoneDevice(n)) return 'mic';
  return 'other';
}

function probeWasapiLoopback() {
  if (!ffmpegCaps.available || !ffmpegCaps.hasWasapi) return false;
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) return false;
  const attempts = [
    ['-f', 'wasapi', '-i', 'loopback'],
    ['-f', 'wasapi', '-loopback', '1', '-i', 'default']
  ];
  for (const extra of attempts) {
    try {
      runFfmpegArgv(ffmpegPath, [
        '-hide_banner', '-nostdin', '-loglevel', 'error',
        ...extra,
        '-t', '0.3', '-f', 'null', '-'
      ], 8000);
      return true;
    } catch (e) {
      const err = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
      if (/frame=\s*[1-9]|size=\s*[1-9]/i.test(err)) return true;
      console.warn('WASAPI loopback probe failed:', extra.join(' '), err.slice(0, 180));
    }
  }
  return false;
}

function refreshAudioProbe({ testWasapi = false } = {}) {
  const devices = ffmpegCaps.available ? listDshowAudioDevices() : [];
  const stereoMix = devices.find((d) => classifyAudioDevice(d) === 'stereo-mix') || null;
  const virtualCable = devices.find((d) => classifyAudioDevice(d) === 'vb-cable') || null;
  const wasapiListed = Boolean(ffmpegCaps.hasWasapi);
  if (testWasapi || audioProbe.wasapiWorks == null) {
    audioProbe.wasapiWorks = probeWasapiLoopback();
  }
  let loopbackKind = 'none';
  if (audioProbe.wasapiWorks) loopbackKind = 'wasapi';
  else if (virtualCable) loopbackKind = 'vb-cable';
  else if (stereoMix) loopbackKind = 'stereo-mix';
  const warning = settings.recordAudio && settings.audioSource !== 'mic' && loopbackKind !== 'wasapi';
  let hint;
  if (!settings.recordAudio) {
    hint = 'Game audio is off.';
  } else if (settings.audioSource === 'mic') {
    hint = 'Microphone only — what you hear is not recorded.';
  } else if (loopbackKind === 'wasapi') {
    hint = 'Game sound is captured automatically from your speakers or headphones. Press Test Audio to confirm.';
  } else if (loopbackKind === 'vb-cable') {
    hint = `Couldn't use the normal Windows audio path. Using ${virtualCable} as a backup. Press Test Audio — if it's silent, that backup device isn't receiving game sound.`;
  } else if (loopbackKind === 'stereo-mix') {
    hint = `Couldn't use the normal Windows audio path. Using ${stereoMix} as a backup. Press Test Audio to confirm.`;
  } else {
    hint = 'Couldn\'t capture what you hear. On this PC the normal Windows path failed, and there is no Stereo Mix or virtual cable to fall back to. Enable Stereo Mix in Sound settings (Recording tab → Show Disabled Devices) or install VB-Audio Virtual Cable, then press Test Audio.';
  }
  audioProbe = {
    devices,
    wasapiListed,
    wasapiWorks: Boolean(audioProbe.wasapiWorks),
    stereoMix,
    virtualCable,
    loopbackKind,
    hint,
    warning,
    preferred: resolveAudioDevice(devices),
    at: Date.now()
  };
  return audioProbe;
}

function getAudioSetupHint(devices) {
  if (!audioProbe.at || devices) {
    if (devices && (!audioProbe.devices || audioProbe.devices.join('|') !== devices.join('|'))) {
      audioProbe.devices = devices.slice();
    }
    refreshAudioProbe({ testWasapi: audioProbe.wasapiWorks == null });
  }
  return audioProbe.hint;
}

function maybeExplainAudioFallback() {
  if (!settings.recordAudio || settings.audioSource === 'mic') return;
  const p = audioProbe.at ? audioProbe : refreshAudioProbe();
  if (p.loopbackKind === 'wasapi') return;
  if (settings.audioFallbackNoticeShown) return;
  settings.audioFallbackNoticeShown = true;
  saveSettings(settings);
  const backup = p.virtualCable || p.stereoMix;
  dialog.showMessageBox(mainWindow || undefined, {
    type: 'warning',
    title: 'Check game audio',
    message: 'Game sound is usually captured automatically. This PC needs a backup.',
    detail: backup
      ? `Test Audio in Settings should still work using ${backup}. Only if that test is silent do you need to change anything.`
      : 'Press Test Audio in Settings. If you hear nothing, enable Stereo Mix (Sound → Recording → Show Disabled Devices) or install VB-Audio Virtual Cable, then test again.',
    buttons: ['OK']
  }).catch(() => {});
}

function describeAudioRoute() {
  const p = audioProbe.at ? audioProbe : refreshAudioProbe();
  const parts = [
    `kind=${p.loopbackKind}`,
    `wasapi listed/works=${p.wasapiListed}/${p.wasapiWorks}`,
    `stereo mix=${p.stereoMix || '(none)'}`,
    `virtual cable=${p.virtualCable || '(none)'}`,
    `device=${settings.audioDevice || '(auto)'}`,
    `source=${settings.audioSource}`
  ];
  return parts.join('  ');
}

function audioDeviceSnapshot(devices) {
  return (devices || []).slice().sort().join('|');
}

function applyAudioDeviceChange(reason, nextDevice) {
  if (!session || audioSwitchInFlight) return false;
  audioSwitchInFlight = true;
  appendDiagnosticsLine(`Audio: ${reason}${nextDevice ? ` → ${nextDevice}` : ' (dropped)'}`);
  if (nextDevice) {
    session.audioDevice = nextDevice;
    session.audioDropped = false;
    settings.audioDevice = nextDevice;
    saveSettings(settings);
    notifyUser(`Audio device changed — now using ${nextDevice}`);
  } else {
    session.audioDevice = null;
    session.micDevice = null;
    session.audioDropped = true;
    session.audioOpened = false;
    notifyUser('Audio source dropped — recording continues without that device');
  }
  restartCurrentSegment();
  return true;
}

function checkAudioDeviceGuard() {
  if (!isRecording && !usingGameCapture && !medal.active && !loopbackReady) return;
  if (isPaused || audioSwitchInFlight) return;
  let devices = [];
  try { devices = ffmpegCaps.available ? listDshowAudioDevices() : []; } catch (e) { return; }
  const snap = audioDeviceSnapshot(devices);
  if (snap === lastAudioDeviceSnapshot) return;
  const prev = lastAudioDeviceSnapshot;
  lastAudioDeviceSnapshot = snap;
  if (!prev) return;

  appendDiagnosticsLine(`Audio devices changed (${devices.length} inputs)`);

  if (session && session.audioDevice && !devices.includes(session.audioDevice)) {
    const next = resolveAudioDevice(devices);
    if (next && next !== session.audioDevice) {
      applyAudioDeviceChange(`lost ${session.audioDevice}`, next);
      return;
    }
    applyAudioDeviceChange(`lost ${session.audioDevice}`, null);
    return;
  }

  if (session && session.micDevice && !devices.includes(session.micDevice)) {
    const mic = pickMicrophoneDevice(devices);
    session.micDevice = mic;
    appendDiagnosticsLine(`Audio: mic lost, ${mic ? `now ${mic}` : 'no replacement'}`);
    notifyUser(mic ? `Microphone changed — now using ${mic}` : 'Microphone unplugged — game audio continues');
    if (mic) restartCurrentSegment();
  }
}

function startAudioDevicePolling() {
  if (audioWatchTimer) return;
  try {
    lastAudioDeviceSnapshot = audioDeviceSnapshot(ffmpegCaps.available ? listDshowAudioDevices() : []);
  } catch (e) {
    lastAudioDeviceSnapshot = '';
  }
  audioWatchTimer = setInterval(() => {
    try { checkAudioDeviceGuard(); } catch (e) {
      diag.warn('AUDIO', 'Device watch failed', { err: e.message || String(e) });
    }
  }, 4000);
}

function stopAudioDevicePolling() {
  if (audioWatchTimer) {
    clearInterval(audioWatchTimer);
    audioWatchTimer = null;
  }
}

function testAudioCapture() {
  refreshAudioProbe({ testWasapi: true });
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) return { ok: false, error: 'FFmpeg not found' };
  const out = path.join(app.getPath('userData'), 'audio-test.m4a');
  const args = ['-hide_banner', '-y', '-nostdin'];
  const wantSystem = settings.audioSource !== 'mic' && settings.recordAudio !== false;
  const mic = pickMicrophoneDevice(audioProbe.devices);
  try {
    if (wantSystem && audioProbe.wasapiWorks) {
      args.push('-f', 'wasapi', '-i', 'loopback');
      if (mic) {
        args.push('-f', 'dshow', '-audio_buffer_size', '80', '-i', `audio=${mic}`);
        args.push('-filter_complex', '[0:a][1:a]amix=inputs=2:duration=shortest:dropout_transition=0[a]', '-map', '[a]');
      }
    } else {
      const dev = settings.audioSource === 'mic'
        ? (mic || resolveAudioDevice(audioProbe.devices))
        : resolveAudioDevice(audioProbe.devices);
      if (!dev) {
        return { ok: false, error: audioProbe.hint || 'No audio device to test', probe: audioProbe };
      }
      args.push('-f', 'dshow', '-audio_buffer_size', '80', '-i', `audio=${dev}`);
    }
    args.push('-t', '3', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', out);
    runFfmpegArgv(ffmpegPath, args, 20000);
    if (!fs.existsSync(out) || fs.statSync(out).size < 1024) {
      throw new Error('Test clip was empty');
    }
    appendDiagnosticsLine(`Audio test ok (${describeAudioRoute()})`);
    return { ok: true, url: pathToFileURL(out).href, probe: audioProbe, hint: audioProbe.hint };
  } catch (e) {
    const err = String((e && e.stderr) || (e && e.message) || e).slice(0, 240);
    appendDiagnosticsLine(`Audio test failed: ${err}`);
    return { ok: false, error: err || 'Audio test failed', probe: audioProbe, hint: audioProbe.hint };
  }
}

/** Actually open the encoder for a tiny encode — "-encoders" listing alone lies when AMF HW is missing. */
function encoderWorks(ffmpegPath, encoderName, timeoutMs = 12000) {
  try {
    execSync(
      `"${ffmpegPath}" -hide_banner -loglevel error -f lavfi -i color=c=black:s=256x256:d=0.2 -pix_fmt yuv420p -c:v ${encoderName} -f null -`,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
      }
    );
    return true;
  } catch (e) {
    const err = `${e.stderr || ''}${e.message || ''}`;
    // Some builds still write frames then exit non-zero on null muxer — treat as OK if no AMF create error
    if (/frame=\s*[1-9]/i.test(err) && !/CreateComponent\(AMF|Encoder not found|Cannot load AMF|No capable devices|MFX_ERR/i.test(err)) {
      return true;
    }
    console.warn(`Encoder probe failed for ${encoderName}:`, err.slice(0, 240));
    return false;
  }
}

const ENCODER_CAP_KEY = {
  h264_nvenc: 'hasH264Nvenc',
  hevc_nvenc: 'hasHevcNvenc',
  av1_nvenc: 'hasAv1Nvenc',
  h264_amf: 'hasH264Amf',
  hevc_amf: 'hasHevcAmf',
  av1_amf: 'hasAv1Amf',
  h264_qsv: 'hasH264Qsv',
  hevc_qsv: 'hasHevcQsv',
  av1_qsv: 'hasAv1Qsv',
  libx264: null
};

const ENCODER_LABELS = {
  h264_nvenc: 'NVIDIA NVENC H.264',
  hevc_nvenc: 'NVIDIA NVENC H.265',
  av1_nvenc: 'NVIDIA NVENC AV1',
  h264_amf: 'AMD AMF H.264',
  hevc_amf: 'AMD AMF H.265',
  av1_amf: 'AMD AMF AV1',
  h264_qsv: 'Intel Quick Sync H.264',
  hevc_qsv: 'Intel Quick Sync H.265',
  av1_qsv: 'Intel Quick Sync AV1',
  libx264: 'Software x264'
};

function encoderFamilyOf(name) {
  if (/nvenc/i.test(name)) return 'nvenc';
  if (/amf/i.test(name)) return 'amf';
  if (/qsv/i.test(name)) return 'qsv';
  return 'x264';
}

function encoderCodecOf(name) {
  if (/^av1_/i.test(name)) return 'av1';
  if (/^hevc_/i.test(name)) return 'hevc';
  return 'h264';
}

function gpuVendorFromName(name, pnp) {
  const n = String(name || '');
  const id = String(pnp || '').toUpperCase();
  if (/VEN_10DE/.test(id) || /nvidia|geforce|rtx|gtx|quadro/i.test(n)) return 'nvidia';
  if (/VEN_1002/.test(id) || /amd|radeon|firepro/i.test(n)) return 'amd';
  if (/VEN_8086/.test(id) || /intel|uhd|iris|arc\s*a?\d/i.test(n)) return 'intel';
  return 'unknown';
}

function isDiscreteGpu(name, vendor) {
  const n = String(name || '');
  if (vendor === 'nvidia' && /geforce|rtx|gtx|quadro/i.test(n)) return true;
  if (vendor === 'amd' && /radeon\s*rx|rx\s*\d|vega\s*(1[0-9]|2)|xt\b/i.test(n)) return true;
  if (vendor === 'intel' && /arc\s*a?\d/i.test(n)) return true;
  if (/uhd|iris|radeon graphics(?!\s*rx)|vega graphics/i.test(n)) return false;
  return vendor === 'nvidia' || vendor === 'amd';
}

function amdLooksHevcSafe(name) {
  return /rx\s*[4-9]\d{3}|radeon\s*rx|vega|navi|rdna|6900|6800|6700|6600|5700|5600|7800|7900|7600|7700|9070|9060/i.test(String(name || ''));
}

function nvidiaLooksAv1(name) {
  return /rtx\s*[45]\d{2,}|ada|blackwell|rtx\s*40|rtx\s*50/i.test(String(name || ''));
}

function intelLooksAv1(name) {
  return /arc\s*a?\d|ultra\s*[2579]/i.test(String(name || ''));
}

function queryGpusWmi() {
  const ps = [
    '$ErrorActionPreference = "SilentlyContinue"',
    '$gpus = Get-CimInstance Win32_VideoController | Where-Object { $_.Name -and $_.Name -notmatch "Remote Desktop|Meta" }',
    '$rows = @()',
    'foreach ($g in @($gpus)) {',
    '  $vram = 0',
    '  try { if ($g.AdapterRAM -and $g.AdapterRAM -gt 0) { $vram = [int64]$g.AdapterRAM } } catch {}',
    '  $rows += [pscustomobject]@{ Name = [string]$g.Name; AdapterRAM = $vram; PNPDeviceID = [string]$g.PNPDeviceID; DriverVersion = [string]$g.DriverVersion }',
    '}',
    'try {',
    '  Get-ChildItem "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}" -ErrorAction SilentlyContinue | ForEach-Object {',
    '    $qw = (Get-ItemProperty $_.PSPath -Name "HardwareInformation.qwMemorySize" -ErrorAction SilentlyContinue)."HardwareInformation.qwMemorySize"',
    '    $nm = (Get-ItemProperty $_.PSPath -Name DriverDesc -ErrorAction SilentlyContinue).DriverDesc',
    '    if ($qw -and $nm) {',
    '      foreach ($r in $rows) { if ($r.Name -eq $nm -and [int64]$qw -gt $r.AdapterRAM) { $r.AdapterRAM = [int64]$qw } }',
    '    }',
    '  }',
    '} catch {}',
    '$rows | ConvertTo-Json -Compress'
  ].join('; ');
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', ps], {
      encoding: 'utf8',
      timeout: 8000,
      windowsHide: true
    });
    const raw = String(r.stdout || '').trim();
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return list.map((g) => ({
      name: String(g.Name || '').trim(),
      vramBytes: Math.max(0, Number(g.AdapterRAM) || 0),
      pnp: String(g.PNPDeviceID || ''),
      driver: String(g.DriverVersion || ''),
      vendor: gpuVendorFromName(g.Name, g.PNPDeviceID)
    })).filter((g) => g.name);
  } catch (e) {
    console.warn('GPU WMI probe failed:', e.message || e);
    return [];
  }
}

function classifyHardwareTier(info) {
  const ramGB = info.ramBytes / (1024 ** 3);
  const vramGB = info.vramBytes / (1024 ** 3);
  if (
    ramGB >= 16 &&
    info.discrete &&
    (vramGB >= 6 || info.vendor === 'nvidia' || info.vendor === 'amd') &&
    info.cpuCores >= 6
  ) {
    return 'high';
  }
  if (
    ramGB < 10 ||
    info.cpuCores <= 4 ||
    (!info.discrete && ramGB < 16) ||
    (info.discrete && vramGB > 0 && vramGB < 3)
  ) {
    return 'low';
  }
  return 'mid';
}

function probeHardware() {
  const ramBytes = os.totalmem();
  const cpus = os.cpus() || [];
  const gpus = queryGpusWmi();
  const preferred = gpus.find((g) => g.vendor === 'nvidia')
    || gpus.find((g) => g.vendor === 'amd')
    || gpus.find((g) => g.vendor === 'intel')
    || gpus[0]
    || null;
  hardwareInfo.gpus = gpus;
  hardwareInfo.ramBytes = ramBytes;
  hardwareInfo.cpuCores = Math.max(1, cpus.length);
  hardwareInfo.cpuModel = (cpus[0] && cpus[0].model) || 'CPU';
  hardwareInfo.vendor = preferred ? preferred.vendor : 'unknown';
  hardwareInfo.gpuName = preferred ? preferred.name : 'Unknown GPU';
  hardwareInfo.vramBytes = preferred ? preferred.vramBytes : 0;
  hardwareInfo.discrete = preferred ? isDiscreteGpu(preferred.name, preferred.vendor) : false;
  hardwareInfo.tier = classifyHardwareTier(hardwareInfo);
  hardwareInfo.ready = true;
  return hardwareInfo;
}

function vendorEncoderChain(vendor, codec) {
  const c = codec === 'av1' || codec === 'hevc' ? codec : 'h264';
  const chains = {
    nvidia: {
      h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'],
      hevc: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'h264_nvenc', 'libx264'],
      av1: ['av1_nvenc', 'av1_amf', 'av1_qsv', 'hevc_nvenc', 'h264_nvenc', 'libx264']
    },
    amd: {
      h264: ['h264_amf', 'h264_nvenc', 'h264_qsv', 'libx264'],
      hevc: ['hevc_amf', 'hevc_nvenc', 'hevc_qsv', 'h264_amf', 'libx264'],
      av1: ['av1_amf', 'av1_nvenc', 'av1_qsv', 'hevc_amf', 'h264_amf', 'libx264']
    },
    intel: {
      h264: ['h264_qsv', 'h264_nvenc', 'h264_amf', 'libx264'],
      hevc: ['hevc_qsv', 'hevc_nvenc', 'hevc_amf', 'h264_qsv', 'libx264'],
      av1: ['av1_qsv', 'av1_nvenc', 'av1_amf', 'hevc_qsv', 'h264_qsv', 'libx264']
    },
    unknown: {
      h264: ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'],
      hevc: ['hevc_nvenc', 'hevc_amf', 'hevc_qsv', 'h264_nvenc', 'libx264'],
      av1: ['av1_nvenc', 'av1_amf', 'av1_qsv', 'hevc_nvenc', 'libx264']
    }
  };
  return (chains[vendor] || chains.unknown)[c];
}

function familyOverrideChain(family, codec) {
  const c = codec === 'av1' || codec === 'hevc' ? codec : 'h264';
  const map = {
    nvenc: { h264: ['h264_nvenc', 'libx264'], hevc: ['hevc_nvenc', 'h264_nvenc', 'libx264'], av1: ['av1_nvenc', 'hevc_nvenc', 'h264_nvenc', 'libx264'] },
    amf: { h264: ['h264_amf', 'libx264'], hevc: ['hevc_amf', 'h264_amf', 'libx264'], av1: ['av1_amf', 'hevc_amf', 'h264_amf', 'libx264'] },
    qsv: { h264: ['h264_qsv', 'libx264'], hevc: ['hevc_qsv', 'h264_qsv', 'libx264'], av1: ['av1_qsv', 'hevc_qsv', 'h264_qsv', 'libx264'] },
    x264: { h264: ['libx264'], hevc: ['libx264'], av1: ['libx264'] }
  };
  return (map[family] || map.x264)[c];
}

function encoderIsAvailable(name) {
  if (name === 'libx264') return true;
  const key = ENCODER_CAP_KEY[name];
  return Boolean(key && ffmpegCaps[key]);
}

function describeEncoder(name, reason) {
  return {
    ffmpegName: name,
    family: encoderFamilyOf(name),
    codec: encoderCodecOf(name),
    label: ENCODER_LABELS[name] || name,
    hardware: name !== 'libx264',
    reason
  };
}

function pickActiveEncoder({ hardware = true } = {}) {
  if (!hardware) {
    return describeEncoder('libx264', 'Software fallback (hardware encode disabled for this session)');
  }
  const codec = settings.videoCodec === 'hevc' || settings.videoCodec === 'av1' ? settings.videoCodec : 'h264';
  const override = settings.encoder || 'auto';
  const chain = override === 'auto'
    ? vendorEncoderChain(hardwareInfo.vendor || 'unknown', codec)
    : familyOverrideChain(override, codec);
  for (const name of chain) {
    if (encoderIsAvailable(name)) {
      const why = override === 'auto'
        ? `Auto: ${hardwareInfo.vendor || 'unknown'} GPU (${hardwareInfo.gpuName}) → ${ENCODER_LABELS[name] || name}`
        : `Manual override (${override}) → ${ENCODER_LABELS[name] || name}`;
      return describeEncoder(name, why);
    }
  }
  return describeEncoder('libx264', 'No working hardware encoder; using libx264');
}

function refreshSelectedEncoder() {
  hardwareInfo.encoder = pickActiveEncoder({ hardware: true });
  hardwareInfo.reason = hardwareInfo.encoder.reason;
  return hardwareInfo.encoder;
}

function captureBitrateBps({ forReplay = false } = {}) {
  const codec = (hardwareInfo.encoder && hardwareInfo.encoder.codec) || settings.videoCodec || 'h264';
  let bits = 8_000_000;
  if (forReplay) bits = 5_000_000;
  else if (settings.spaceSaving) bits = 8_000_000;
  else if (!settings.gameMode) bits = 10_000_000;
  else bits = 8_000_000;
  if (codec === 'hevc') bits = Math.round(bits * 0.65);
  if (codec === 'av1') bits = Math.round(bits * 0.5);
  return bits;
}

function estimateFileBytesPerMinute() {
  const video = captureBitrateBps({ forReplay: false });
  const audio = settings.recordAudio ? 160_000 : 0;
  return Math.round(((video + audio) / 8) * 60);
}

function capturePixelSize() {
  try {
    const disp = screen.getPrimaryDisplay();
    const w = (disp && disp.size && disp.size.width) || 1920;
    const h = (disp && disp.size && disp.size.height) || 1080;
    const r = settings.outputResolution;
    if (r === '720') return { width: Math.round(w * (720 / h)), height: 720 };
    if (r === '1080') return { width: Math.round(w * (1080 / h)), height: 1080 };
    if (r === '1440') return { width: Math.round(w * (1440 / h)), height: 1440 };
    return { width: w, height: h };
  } catch (e) {
    return { width: 1920, height: 1080 };
  }
}

function estimateReplayRamBytes({ minutes, fps } = {}) {
  const mins = Math.max(0.5, Number(minutes != null ? minutes : settings.instantReplayMinutes) || 5);
  const rate = Number(fps != null ? fps : effectiveFps()) || 30;
  const { width, height } = capturePixelSize();
  const encoded = (captureBitrateBps({ forReplay: true }) / 8) * mins * 60;
  const pcm = 48000 * 4 * mins * 60;
  const frameQueue = width * height * 4 * Math.min(rate, 8);
  return Math.round(encoded + pcm + frameQueue);
}

function maxReplayMinutesForRam() {
  const ramGB = hardwareInfo.ramBytes / (1024 ** 3);
  const fps = effectiveFps();
  const { height } = capturePixelSize();
  let cap = 5;
  if (ramGB < 10) {
    if (fps >= 144 && height >= 1080) cap = 1;
    else if (fps >= 60 && height >= 1080) cap = 2;
    else if (height >= 1080) cap = 3;
    else cap = 5;
  } else if (ramGB < 16) {
    if (fps >= 144) cap = 2;
    else if (fps >= 60 && height >= 1440) cap = 3;
    else if (fps >= 60) cap = 4;
    else cap = 5;
  }
  const budget = Math.max(256 * 1024 * 1024, hardwareInfo.ramBytes * 0.08);
  for (const m of [5, 4, 3, 2, 1]) {
    if (m > cap) continue;
    if (estimateReplayRamBytes({ minutes: m, fps }) <= budget) return m;
  }
  return 1;
}

function wizardDefaultsForTier(tier) {
  const hevcOk = Boolean(ffmpegCaps.hasHevcNvenc || ffmpegCaps.hasHevcAmf || ffmpegCaps.hasHevcQsv);
  const ramGB = hardwareInfo.ramBytes / (1024 ** 3);
  const vramGB = hardwareInfo.vramBytes / (1024 ** 3);
  if (tier === 'low') {
    return {
      fps: 30,
      outputResolution: '720',
      instantReplayMinutes: 2,
      instantReplaySaveMinutes: 1,
      videoCodec: 'h264',
      spaceSaving: true,
      encoder: 'auto'
    };
  }
  if (tier === 'high') {
    const fps = ramGB >= 32 && vramGB >= 8 ? 144 : 60;
    return {
      fps,
      outputResolution: vramGB >= 6 ? '1440' : '1080',
      instantReplayMinutes: 5,
      instantReplaySaveMinutes: 2,
      videoCodec: hevcOk ? 'hevc' : 'h264',
      spaceSaving: false,
      encoder: 'auto'
    };
  }
  return {
    fps: 60,
    outputResolution: '1080',
    instantReplayMinutes: 3,
    instantReplaySaveMinutes: 2,
    videoCodec: 'h264',
    spaceSaving: true,
    encoder: 'auto'
  };
}

function diagnosticsLogPath() {
  return path.join(app.getPath('userData'), 'diagnostics.log');
}

function writeDiagnosticsLog() {
  const enc = hardwareInfo.encoder || pickActiveEncoder({ hardware: true });
  const lines = [
    `Ordinary Recorder diagnostics  ${new Date().toISOString()}`,
    `app ${app.getVersion()}  settings v${settings.settingsVersion}`,
    '',
    '-- Hardware --',
    `GPU: ${hardwareInfo.gpuName} (${hardwareInfo.vendor}, ${hardwareInfo.discrete ? 'discrete' : 'integrated'})`,
    `VRAM: ${(hardwareInfo.vramBytes / (1024 ** 3)).toFixed(1)} GB`,
    `RAM: ${(hardwareInfo.ramBytes / (1024 ** 3)).toFixed(1)} GB`,
    `CPU: ${hardwareInfo.cpuModel} (${hardwareInfo.cpuCores} threads)`,
    `Tier: ${hardwareInfo.tier}`,
    `recPhase: ${typeof rec !== 'undefined' ? rec.phase : 'n/a'}`,
    `Other GPUs: ${hardwareInfo.gpus.map((g) => g.name).join(' | ') || '(none)'}`,
    '',
    '-- FFmpeg --',
    `path: ${ffmpegCaps.path}`,
    `available: ${ffmpegCaps.available}  ddagrab: ${ffmpegCaps.hasDdagrab}  wasapi: ${ffmpegCaps.hasWasapi}`,
    `nvenc h264/hevc/av1: ${ffmpegCaps.hasH264Nvenc}/${ffmpegCaps.hasHevcNvenc}/${ffmpegCaps.hasAv1Nvenc}`,
    `amf   h264/hevc/av1: ${ffmpegCaps.hasH264Amf}/${ffmpegCaps.hasHevcAmf}/${ffmpegCaps.hasAv1Amf}`,
    `qsv   h264/hevc/av1: ${ffmpegCaps.hasH264Qsv}/${ffmpegCaps.hasHevcQsv}/${ffmpegCaps.hasAv1Qsv}`,
    '',
    '-- Encoder selection --',
    `${enc.label}  (${enc.ffmpegName})`,
    enc.reason,
    `override=${settings.encoder}  codec=${settings.videoCodec}  fps=${settings.fps}  res=${settings.outputResolution}`,
    `replay cap: ${maxReplayMinutesForRam()} min  est RAM @ current buffer: ${(estimateReplayRamBytes() / (1024 ** 2)).toFixed(0)} MB`,
    '',
    '-- Audio --',
    describeAudioRoute(),
    audioProbe.hint || '',
    '',
    '-- Disk --',
    `reserve: ${settings.diskSpaceLimitMb || 500} MB  free now: ${lastDiskFreeBytes != null ? `${Math.round(lastDiskFreeBytes / (1024 * 1024))} MB` : 'n/a'}`,
    '',
    '-- Known unstable games (skip ddagrab) --',
    ...(settings.knownUnstableGames && settings.knownUnstableGames.length
      ? settings.knownUnstableGames.map((g) => `${g.exe || g.id}  (${g.title})`)
      : ['(none)']),
    ''
  ];
  try {
    fs.writeFileSync(diagnosticsLogPath(), lines.join('\n'), 'utf8');
    console.log(lines.join('\n'));
  } catch (e) {
    console.warn('Could not write diagnostics log:', e.message || e);
  }
}

function encoderOptionsForUi() {
  const enc = hardwareInfo.encoder || pickActiveEncoder({ hardware: true });
  const codecs = [{ value: 'h264', label: 'H.264', available: true }];
  if (ffmpegCaps.hasHevcNvenc || ffmpegCaps.hasHevcAmf || ffmpegCaps.hasHevcQsv) {
    codecs.push({ value: 'hevc', label: 'H.265 (HEVC)', available: true });
  }
  if (ffmpegCaps.hasAv1Nvenc || ffmpegCaps.hasAv1Amf || ffmpegCaps.hasAv1Qsv) {
    codecs.push({ value: 'av1', label: 'AV1', available: true });
  }
  const withCodec = (codec) => {
    const prev = settings.videoCodec;
    settings.videoCodec = codec;
    const n = estimateFileBytesPerMinute();
    settings.videoCodec = prev;
    return n;
  };
  const h264Bytes = withCodec('h264');
  const hevcBytes = withCodec('hevc');
  const av1Bytes = withCodec('av1');
  return {
    selected: enc,
    encoder: settings.encoder || 'auto',
    videoCodec: settings.videoCodec || 'h264',
    families: [
      { value: 'auto', label: `Auto (${enc.label})` },
      { value: 'nvenc', label: 'NVIDIA NVENC', available: Boolean(ffmpegCaps.hasH264Nvenc || ffmpegCaps.hasHevcNvenc) },
      { value: 'amf', label: 'AMD AMF', available: Boolean(ffmpegCaps.hasH264Amf || ffmpegCaps.hasHevcAmf) },
      { value: 'qsv', label: 'Intel Quick Sync', available: Boolean(ffmpegCaps.hasH264Qsv || ffmpegCaps.hasHevcQsv) },
      { value: 'x264', label: 'Software (x264)', available: true }
    ],
    codecs,
    sizeEstimate: {
      h264BytesPerMin: h264Bytes,
      hevcBytesPerMin: hevcBytes,
      av1BytesPerMin: av1Bytes,
      currentBytesPerMin: estimateFileBytesPerMinute()
    },
    replay: {
      estimatedRamBytes: estimateReplayRamBytes(),
      maxMinutes: maxReplayMinutesForRam()
    }
  };
}

function getHardwareUiPayload() {
  refreshSelectedEncoder();
  return {
    ready: hardwareInfo.ready,
    vendor: hardwareInfo.vendor,
    gpuName: hardwareInfo.gpuName,
    vramBytes: hardwareInfo.vramBytes,
    ramBytes: hardwareInfo.ramBytes,
    cpuCores: hardwareInfo.cpuCores,
    cpuModel: hardwareInfo.cpuModel,
    discrete: hardwareInfo.discrete,
    tier: hardwareInfo.tier,
    wizardCompleted: Boolean(settings.wizardCompleted),
    profile: settings.hardwareProfile,
    defaults: wizardDefaultsForTier(hardwareInfo.tier),
    encoder: encoderOptionsForUi(),
    encodersProbed: Boolean(ffmpegCaps.available || ffmpegCaps.probeError),
    diagnosticsPath: diagnosticsLogPath()
  };
}

function scaleFilterForResolution() {
  const r = settings.outputResolution;
  if (r === '720') return 'scale=-2:720';
  if (r === '1080') return 'scale=-2:1080';
  if (r === '1440') return 'scale=-2:1440';
  return null;
}

function pushVendorEncoderArgs(args, { fps, forReplay, encoder }) {
  const gop = fps;
  const bits = captureBitrateBps({ forReplay });
  const maxrate = Math.round(bits * 1.25);
  const bufsize = Math.round(bits * 1.5);
  const name = encoder.ffmpegName;
  args.push('-c:v', name);
  if (encoder.family === 'nvenc') {
    args.push('-preset', 'p4', '-rc', 'vbr', '-b:v', String(bits), '-maxrate', String(maxrate), '-bufsize', String(bufsize), '-g', String(gop), '-bf', '0');
    if (encoder.codec !== 'av1') args.push('-tune', 'll');
    if (encoder.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (encoder.family === 'qsv') {
    args.push('-preset', 'veryfast', '-look_ahead', '0', '-b:v', String(bits), '-maxrate', String(maxrate), '-bufsize', String(bufsize), '-g', String(gop), '-bf', '0');
    if (encoder.codec === 'hevc') args.push('-tag:v', 'hvc1');
  } else if (encoder.family === 'amf') {
    args.push('-usage', 'transcoding', '-quality', 'speed', '-rc', 'vbr_peak', '-b:v', String(bits), '-maxrate', String(maxrate), '-bufsize', String(bufsize), '-g', String(gop), '-bf', '0');
    if (encoder.codec === 'hevc') args.push('-tag:v', 'hvc1');
  }
}

function webCodecsCodecParam() {
  const enc = pickActiveEncoder({ hardware: true });
  if (!enc.hardware) return 'h264';
  return enc.codec === 'av1' || enc.codec === 'hevc' ? enc.codec : 'h264';
}

function probeListedHwEncoders(ffmpegPath, listed) {
  const vendor = hardwareInfo.vendor || 'unknown';
  const gpuName = hardwareInfo.gpuName || '';
  const tryProbe = (name, timeoutMs) => {
    if (!new RegExp(`\\b${name}\\b`, 'i').test(listed)) return false;
    const key = ENCODER_CAP_KEY[name];
    if (!key) return false;
    ffmpegCaps[key] = encoderWorks(ffmpegPath, name, timeoutMs);
    return ffmpegCaps[key];
  };

  if (vendor === 'nvidia') {
    tryProbe('h264_nvenc', 10000);
  } else if (vendor === 'amd') {
    tryProbe('h264_amf', 12000);
  } else if (vendor === 'intel') {
    tryProbe('h264_qsv', 10000);
  } else if (!tryProbe('h264_nvenc', 8000) && !tryProbe('h264_amf', 8000)) {
    tryProbe('h264_qsv', 8000);
  }

  if (vendor === 'nvidia') {
    tryProbe('hevc_nvenc', 8000);
    if (nvidiaLooksAv1(gpuName)) tryProbe('av1_nvenc', 8000);
  } else if (vendor === 'amd') {
    if (amdLooksHevcSafe(gpuName)) tryProbe('hevc_amf', 7000);
    if (/rx\s*[79]\d{3}|9070|9060|rdna.?3|rdna.?4/i.test(gpuName)) tryProbe('av1_amf', 7000);
  } else if (vendor === 'intel') {
    tryProbe('hevc_qsv', 8000);
    if (intelLooksAv1(gpuName)) tryProbe('av1_qsv', 8000);
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
    hasAv1Amf: false,
    hasH264Nvenc: false,
    hasHevcNvenc: false,
    hasAv1Nvenc: false,
    hasH264Qsv: false,
    hasHevcQsv: false,
    hasAv1Qsv: false,
    hasWasapi: false,
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

  let listedEncoders = '';
  try {
    listedEncoders = runFfmpeg('-hide_banner -encoders', 30000);
  } catch (e) {
    listedEncoders = `${e.stdout || ''}${e.stderr || ''}`;
  }

  ffmpegCaps = caps;
  probeListedHwEncoders(ffmpegPath, listedEncoders);
  caps.hasH264Amf = Boolean(ffmpegCaps.hasH264Amf);
  caps.hasHevcAmf = Boolean(ffmpegCaps.hasHevcAmf);
  caps.hasAv1Amf = Boolean(ffmpegCaps.hasAv1Amf);
  caps.hasH264Nvenc = Boolean(ffmpegCaps.hasH264Nvenc);
  caps.hasHevcNvenc = Boolean(ffmpegCaps.hasHevcNvenc);
  caps.hasAv1Nvenc = Boolean(ffmpegCaps.hasAv1Nvenc);
  caps.hasH264Qsv = Boolean(ffmpegCaps.hasH264Qsv);
  caps.hasHevcQsv = Boolean(ffmpegCaps.hasHevcQsv);
  caps.hasAv1Qsv = Boolean(ffmpegCaps.hasAv1Qsv);

  try {
    const formats = runFfmpeg('-hide_banner -formats', 30000);
    caps.hasWasapi = /^\s*[D ]+E?\s+wasapi\s/im.test(formats) || /\bDE\s+wasapi\b/i.test(formats);
  } catch (e) {
    const out = `${e.stdout || ''}${e.stderr || ''}`;
    caps.hasWasapi = /\bwasapi\b/i.test(out);
  }
  refreshSelectedEncoder();
  console.log('Encoder caps:', {
    vendor: hardwareInfo.vendor,
    selected: hardwareInfo.encoder && hardwareInfo.encoder.ffmpegName,
    reason: hardwareInfo.reason,
    hasH264Amf: caps.hasH264Amf,
    hasH264Nvenc: caps.hasH264Nvenc,
    hasH264Qsv: caps.hasH264Qsv,
    hasHevcAmf: caps.hasHevcAmf,
    hasHevcNvenc: caps.hasHevcNvenc,
    hasHevcQsv: caps.hasHevcQsv,
    hasDdagrab: caps.hasDdagrab,
    hasWasapi: caps.hasWasapi
  });

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
    hasAv1Amf: false,
    hasH264Nvenc: false,
    hasHevcNvenc: false,
    hasAv1Nvenc: false,
    hasH264Qsv: false,
    hasHevcQsv: false,
    hasAv1Qsv: false,
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

  if (!caps.hasH264Amf && !caps.hasHevcAmf && !caps.hasH264Nvenc && !caps.hasH264Qsv) {
    console.warn('No hardware encoder — using libx264 software encode (higher CPU).');
  }
}

function getSelectedAudioDevice() {
  return settings.recordAudio ? settings.audioDevice : null;
}

function effectiveFps() {
  const f = Number(settings.fps);
  if (f === 144) return 144;
  if (f === 60) return 60;
  return 30;
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
      '-i', `ddagrab=framerate=${fps}:output_idx=0:draw_mouse=${mouse}:draw_border=0:dup_frames=1`
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
  const scale = scaleFilterForResolution();
  if (!(useDdagrab && ffmpegCaps.hasDdagrab)) return scale;
  const base = 'hwdownload,format=bgra,format=nv12';
  return scale ? `${base},${scale}` : base;
}

function cueFile(kind) {
  const names = {
    start: 'cue-start.wav',
    stop: 'cue-stop.wav',
    bookmark: 'cue-bookmark.wav',
    saved: 'cue-saved.wav',
    fail: 'cue-fail.wav'
  };
  const name = names[kind] || names.stop;
  if (app.isPackaged) return path.join(process.resourcesPath, 'assets', name);
  return path.join(__dirname, 'assets', name);
}

function playCue(kind) {
  const file = cueFile(kind);
  try {
    if (!fs.existsSync(file)) return;
  } catch (e) {
    return;
  }
  const quoted = file.replace(/'/g, "''");
  const proc = spawn(
    'powershell.exe',
    ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', `(New-Object System.Media.SoundPlayer '${quoted}').PlaySync()`],
    { windowsHide: true, detached: true, stdio: 'ignore' }
  );
  try { proc.unref(); } catch (e) { /* ignore */ }
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
  const picked = pickActiveEncoder({ hardware: useAmf });

  if (useAmf && picked.family === 'amf' && picked.codec === 'h264' && ffmpegCaps.hasH264Amf) {
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
    return;
  }

  if (useAmf && picked.hardware && picked.ffmpegName !== 'libx264') {
    pushVendorEncoderArgs(args, { fps, forReplay, encoder: picked });
    return;
  }

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

// ---------- Build the ffmpeg args ----------
function buildArgs(outputFile, { useDdagrab, useAmf, audioDevice, micDevice, useWasapi }) {
  const fps = effectiveFps();
  const args = [];
  const game = Boolean(settings.gameMode);
  const wasapi = Boolean(useWasapi && ffmpegCaps.hasWasapi);
  const mixMic = Boolean(
    !wasapi &&
    audioDevice &&
    micDevice &&
    micDevice !== audioDevice
  );
  const mixWasapiMic = Boolean(wasapi && micDevice);

  pushDesktopCaptureArgs(args, { fps, useDdagrab });

  const wantAudio = wasapi || Boolean(audioDevice);
  if (wasapi) {
    args.push(
      '-thread_queue_size', game ? '1024' : '256',
      '-f', 'wasapi',
      '-i', 'loopback'
    );
    if (mixWasapiMic) {
      args.push(
        '-thread_queue_size', '256',
        '-f', 'dshow',
        '-audio_buffer_size', '80',
        '-i', `audio=${micDevice}`
      );
    }
  } else if (audioDevice) {
    args.push(
      '-thread_queue_size', game ? '1024' : '256',
      '-f', 'dshow',
      '-audio_buffer_size', '80',
      '-i', `audio=${audioDevice}`
    );
    if (mixMic) {
      args.push(
        '-thread_queue_size', '256',
        '-f', 'dshow',
        '-audio_buffer_size', '80',
        '-i', `audio=${micDevice}`
      );
    }
  }

  const vf = videoFilterForCapture(useDdagrab, { useAmf });
  if (mixWasapiMic || mixMic) {
    const videoChain = vf || 'null';
    const a1 = mixWasapiMic ? '1' : '1';
    const a2 = '2';
    args.push(
      '-filter_complex',
      `[0:v]${videoChain}[v];[${a1}:a]aresample=48000:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo[a1];[${a2}:a]aresample=48000:async=1000,aformat=sample_fmts=fltp:channel_layouts=stereo[a2];[a1][a2]amix=inputs=2:duration=longest:dropout_transition=2[a]`
    );
    args.push('-map', '[v]', '-map', '[a]');
  } else {
    if (vf) args.push('-filter:v', vf);
    if (wantAudio && game) {
      args.push('-af', 'aresample=async=1000:first_pts=0');
    }
  }

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
    '-f', 'matroska',
    '-y', outputFile
  );
  return args;
}

function isExclusiveFullscreenCaptureFailure(msg) {
  return /Selected output not supported|Failed to configure output pad on Parsed_ddagrab|887a0026|887a0027|AcquireNextFrame failed/i.test(String(msg || ''));
}

function isDdagrabFailure(msg) {
  // Do NOT match mere mentions of "ddagrab" — normal startup logs include the filter name.
  return /No such filter.*ddagrab|Unknown (input )?filter.*ddagrab|Filter not found.*ddagrab|Error .*ddagrab|ddagrab.*fail|Cannot load.*ddagrab|Failed to.*Desktop Duplication|DXGI_ERROR|AcquireNextFrame failed|887a0026|887a0027|Selected output not supported/i.test(msg);
}

function isAmfFailure(msg) {
  // Do NOT match mere "h264_amf" in Stream mapping / encoder banner lines.
  return /CreateComponent\(AMF|Cannot load AMF|Error initializing.*(h264_amf|hevc_amf|AMF)|Encoder not found|Failed to open (encoder|codec).*(h264_amf|hevc_amf)|(h264_amf|hevc_amf).*failed with error|Error while opening encoder/i.test(msg);
}

function isNvencFailure(msg) {
  return /No NVENC capable devices|OpenEncodeSessionEx|incompatible with nvenc|Failed to open (encoder|codec).*nvenc|nvenc.*failed with error|Error initializing.*nvenc/i.test(String(msg || ''));
}

function isQsvFailure(msg) {
  return /libmfx|MFX_ERR|Failed to open (encoder|codec).*qsv|Error initializing.*qsv|qsv.*failed with error|Cannot load.*libmfx/i.test(String(msg || ''));
}

function isSelectedHwFailure(msg) {
  return isAmfFailure(msg) || isNvencFailure(msg) || isQsvFailure(msg);
}

function isAmfHwFormatFailure(msg) {
  return /Impossible to convert|No matching formats|Unsupported pixel format|Could not get .* format|Error reinitializing filters|Error while filtering|Function not implemented|surfaces are not supported|Failed to inject frame into filter network|Error while processing the decoded data/i.test(msg);
}

function isAudioFailure(msg) {
  return /Could not find audio only device|IAudioClient|Error opening input.*dshow|Could not run graph|audio device.*not found|Cannot open.*dshow|Unknown input format.*wasapi|wasapi.*(error|fail)|Failed to (open|init).*wasapi|device.*disconnected|The device is not plugged|No such device/i.test(msg);
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
  lastLoopbackPeak = 0;
  lastMicPeak = 0;
  lastMediaTickAt = 0;
  captureUnhealthy = false;
  captureRecoverTries = 0;
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
  if (/\bframe=\s*[1-9]|\bfps=\s*[\d.]/.test(msg)) lastMediaTickAt = Date.now();
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
  return userFacing(err, 'CAPTURE');
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
  const instantReplay = getInstantReplayState();
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
    hasAudio: Boolean(
      medal.hasAudio ||
      loopbackReady ||
      (session && !session.audioDropped && (session.audioOpened || session.audioDevice || session.useWasapi || session.useLoopback))
    ),
    audioLive: Boolean(
      lastAudioPeak > 0.004 ||
      lastLoopbackPeak > 0.004 ||
      lastMicPeak > 0.004
    ),
    loopbackPeak: lastLoopbackPeak,
    micPeak: lastMicPeak,
    audioRoute: audioProbe.loopbackKind || null,
    audioWarning: Boolean(audioProbe.warning),
    audioHint: audioProbe.hint || '',
    hotkey: settings.hotkey,
    pauseHotkey: settings.pauseHotkey,
    replayHotkey: settings.replayHotkey,
    bookmarkHotkey: settings.bookmarkHotkey,
    instantReplay,
    captureTarget: !isRecording ? null : (usingGameCapture || medal.recording ? 'game' : 'desktop'),
    encoder: (hardwareInfo.encoder && hardwareInfo.encoder.label) || null,
    diskFreeBytes: lastDiskFreeBytes,
    diskLimitBytes: diskSpaceLimitBytes(),
    diskWarning: lastDiskWarning,
    bufferFillPercent: (instantReplay && instantReplay.fillPercent) || 0,
    lastReplaySaveOk: lastReplaySave.ok,
    lastReplaySaveAt: lastReplaySave.at,
    lastReplaySaveError: lastReplaySave.error,
    recPhase: rec.phase,
    captureHealthy: Boolean(isRecording && !isPaused && !captureUnhealthy),
    notice: lastAppNotice
  };
}

function startStatsPolling() {
  stopStatsPolling();
  startAudioDevicePolling();
  let lastSize = 0;
  let stalledChecks = 0;
  statsInterval = setInterval(() => {
    if (!isRecording) {
      stopStatsPolling();
      return;
    }
    const size = getSessionFileSize();
    const mediaFresh = lastMediaTickAt && (Date.now() - lastMediaTickAt) < 4000;
    if (!isPaused) {
      if (size <= lastSize + 2048 && !mediaFresh) stalledChecks += 1;
      else stalledChecks = 0;
      lastSize = size;
      captureUnhealthy = stalledChecks >= 3;
      if (stalledChecks === 3) {
        diag.warn('CAPTURE', 'No frames or file growth for ~6s');
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('recording-state', {
            ...getStatePayload(),
            warning: 'Capture looks empty — if a game is exclusive fullscreen, press the hotkey while that game is in front'
          });
        }
      }
      if (stalledChecks === 5 && captureRecoverTries < 1 && session && !usingGameCapture && !medal.recording) {
        captureRecoverTries += 1;
        diag.warn('CAPTURE', 'Restarting encoder after stall');
        restartCurrentSegment({ keepPartial: true });
        stalledChecks = 0;
        lastSize = getSessionFileSize();
      } else if (stalledChecks === 8 && captureRecoverTries < 2 && session && !usingGameCapture && !medal.recording && settings.exclusiveFullscreen !== false) {
        captureRecoverTries += 1;
        diag.warn('CAPTURE', 'Stall continues — switching to game capture');
        switchDesktopRecordingToGame().catch((e) => diag.error('CAPTURE', 'WGC fallback failed', { err: e.message || String(e) }));
      } else if (stalledChecks >= 12 && rec.canStop()) {
        diag.critical('CAPTURE', 'Capture stayed empty — stopping to preserve what we have');
        notifyFriendly('No video was captured (0 bytes).', 'CAPTURE');
        stopRecording().catch((e) => diag.error('CAPTURE', 'Stop after stall failed', { err: e.message || String(e) }));
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
  stopAudioDevicePolling();
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

function runFfmpegAsync(ffmpegPath, argv, timeoutMs = 300000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(ffmpegPath, argv, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d.toString(); });
    const timer = setTimeout(() => {
      try { proc.kill(); } catch (e) { /* ignore */ }
      reject(new Error(`ffmpeg timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stderr);
      else { const e = new Error(`ffmpeg exited ${code}`); e.stderr = stderr; reject(e); }
    });
    proc.on('error', (err) => { clearTimeout(timer); reject(err); });
  });
}

async function concatSegments(segments, outputFile, listDir) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!segments.length) throw new Error('No segments to concatenate');

  if (segments.length === 1) {
    await runFfmpegAsync(ffmpegPath, [
      '-hide_banner', '-y', '-i', segments[0], '-c', 'copy', '-movflags', '+faststart', outputFile
    ], 180000);
    return;
  }

  const dir = listDir || (session && session.folder) || path.dirname(outputFile);
  const listFile = path.join(dir, 'segments-list.txt');
  const body = segments.map((s) => `file '${escapeConcatPath(s)}'`).join('\n');
  fs.writeFileSync(listFile, body, 'utf8');

  try {
    await runFfmpegAsync(ffmpegPath, [
      '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c', 'copy', '-movflags', '+faststart', outputFile
    ]);
  } catch (e) {
    console.warn('concat copy failed, remuxing:', e.message || e);
    await runFfmpegAsync(ffmpegPath, [
      '-hide_banner', '-y', '-f', 'concat', '-safe', '0', '-i', listFile,
      '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', outputFile
    ]);
  }
}

async function muxLoopbackAudio(videoFile, audioFile, outputFile) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) throw new Error('FFmpeg missing');
  const dest = videoFile === outputFile ? `${outputFile}.with-audio.mp4` : outputFile;
  try {
    await runFfmpegAsync(ffmpegPath, [
      '-hide_banner', '-y', '-i', videoFile, '-i', audioFile,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'copy', '-c:a', 'aac',
      '-b:a', '192k', '-ac', '2', '-ar', '48000', '-shortest',
      '-movflags', '+faststart', dest
    ]);
  } catch (e) {
    await runFfmpegAsync(ffmpegPath, [
      '-hide_banner', '-y', '-i', videoFile, '-i', audioFile,
      '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23',
      '-c:a', 'aac', '-b:a', '192k', '-ac', '2', '-ar', '48000', '-shortest',
      '-movflags', '+faststart', dest
    ]);
  }
  if (dest !== outputFile) {
    try { if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile); } catch (e) { /* ignore */ }
    fs.renameSync(dest, outputFile);
  }
}

function closeLoopbackWindow() {
  if (loopbackWin && !loopbackWin.isDestroyed()) {
    try { loopbackWin.close(); } catch (e) { /* ignore */ }
  }
  loopbackWin = null;
}

async function startLoopbackCapture(sessionFolder) {
  await stopLoopbackCapture();
  if (!settings.recordAudio) return { ok: false, error: 'audio off' };

  const sources = await listCaptureSources();
  const screen = sources.find((s) => s.id.startsWith('screen:')) || sources[0];
  if (!screen) return { ok: false, error: 'No screen for audio' };

  if (!fs.existsSync(sessionFolder)) fs.mkdirSync(sessionFolder, { recursive: true });
  loopbackFile = path.join(sessionFolder, 'loopback.webm');
  loopbackBytes = 0;
  loopbackReady = false;
  loopbackStream = fs.createWriteStream(loopbackFile);

  const audio = '1';
  const ptt = settings.pttEnabled === true ? '1' : '0';
  const url = `file://${path.join(__dirname, 'game-capture.html').replace(/\\/g, '/')}?mode=audio&sourceId=${encodeURIComponent(screen.id)}&screenId=${encodeURIComponent(screen.id)}&fps=30&audio=${audio}&ptt=${ptt}`;

  loopbackWin = new BrowserWindow({
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
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  configureCaptureSession(loopbackWin, screen);

  const ready = new Promise((resolve) => {
    const t = setTimeout(() => {
      cleanupReady();
      resolve({ ok: false, error: 'Desktop audio timed out' });
    }, 12000);
    const onStarted = (_e, info) => {
      clearTimeout(t);
      cleanupReady();
      resolve({ ok: true, info });
    };
    const onFailed = (_e, msg) => {
      clearTimeout(t);
      cleanupReady();
      resolve({ ok: false, error: msg || 'Desktop audio failed' });
    };
    function cleanupReady() {
      ipcMain.removeListener('loopback-started', onStarted);
      ipcMain.removeListener('loopback-failed', onFailed);
    }
    ipcMain.once('loopback-started', onStarted);
    ipcMain.once('loopback-failed', onFailed);
  });

  loopbackWin.loadURL(url);
  const result = await ready;
  if (!result.ok) {
    await stopLoopbackCapture();
    return result;
  }
  loopbackReady = true;
  if (session) {
    session.useLoopback = true;
    session.audioOpened = Boolean(result.info && (result.info.loopback || result.info.mic || result.info.audio));
  }
  medal.hasLoopback = Boolean(result.info && result.info.loopback);
  medal.hasMic = Boolean(result.info && result.info.mic);
  medal.hasAudio = Boolean(result.info && result.info.audio);
  console.log('Desktop loopback audio:', result.info);
  return { ok: true, info: result.info };
}

async function stopLoopbackCapture() {
  const file = loopbackFile;
  if (loopbackWin && !loopbackWin.isDestroyed()) {
    const stopped = new Promise((resolve) => {
      const t = setTimeout(resolve, 2500);
      ipcMain.once('loopback-stopped', () => {
        clearTimeout(t);
        resolve();
      });
    });
    try { loopbackWin.webContents.send('game-capture-stop'); } catch (e) { /* ignore */ }
    await stopped;
  }
  closeLoopbackWindow();
  await new Promise((r) => setTimeout(r, 150));
  try {
    if (loopbackStream) {
      await new Promise((resolve) => loopbackStream.end(() => resolve()));
    }
  } catch (e) { /* ignore */ }
  loopbackStream = null;
  loopbackReady = false;
  loopbackBackpressure = false;
  loopbackFile = file && fs.existsSync(file) && fs.statSync(file).size > 2048 ? file : null;
  return loopbackFile;
}

let loopbackBackpressure = false;
ipcMain.on('loopback-audio-chunk', (_e, buf) => {
  if (!loopbackStream || !buf || loopbackBackpressure) return;
  try {
    const data = Buffer.from(buf);
    loopbackBytes += data.length;
    const ok = loopbackStream.write(data);
    if (!ok) {
      loopbackBackpressure = true;
      loopbackStream.once('drain', () => { loopbackBackpressure = false; });
    }
  } catch (e) {
    diag.warn('AUDIO', 'Loopback write failed', { err: e.message || String(e) });
  }
});

function nextSegmentPath() {
  session.segmentIndex += 1;
  return path.join(session.folder, `segment-${session.segmentIndex}.mkv`);
}

function currentSegmentPath() {
  return path.join(session.folder, `segment-${session.segmentIndex}.mkv`);
}

function existingSegmentPath(folder, index) {
  const mkv = path.join(folder, `segment-${index}.mkv`);
  const mp4 = path.join(folder, `segment-${index}.mp4`);
  try {
    if (fs.existsSync(mkv) && fs.statSync(mkv).size > 0) return mkv;
  } catch (e) { /* ignore */ }
  try {
    if (fs.existsSync(mp4) && fs.statSync(mp4).size > 0) return mp4;
  } catch (e) { /* ignore */ }
  return null;
}

function sanitizeKnownGames(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const g of list) {
    if (!g || typeof g !== 'object') continue;
    const id = String(g.id || g.exe || g.title || '').trim().toLowerCase();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      title: String(g.title || id).slice(0, 120),
      exe: g.exe ? String(g.exe).slice(0, 80) : '',
      method: g.method === 'wgc' || g.method === 'ddagrab' ? g.method : 'wgc',
      failCount: Math.min(99, Math.max(0, Number(g.failCount) || 1)),
      lastTriedAt: Number(g.lastTriedAt) || Number(g.addedAt) || Date.now(),
      lastOkAt: Number(g.lastOkAt) || 0,
      addedAt: Number(g.addedAt) || Date.now()
    });
    if (out.length >= 40) break;
  }
  return out;
}

function diskSpaceLimitBytes() {
  return Math.min(4096, Math.max(200, Number(settings.diskSpaceLimitMb) || 500)) * 1024 * 1024;
}

function diskSpaceWarnBytes() {
  const hard = diskSpaceLimitBytes();
  return Math.max(hard * 3, hard + 1024 * 1024 * 1024);
}

function appendDiagnosticsRaw(line) {
  console.log(line);
  try { fs.appendFileSync(diagnosticsLogPath(), `${line}\n`, 'utf8'); } catch (e) { /* keep running if log disk fails */ }
}

function appendDiagnosticsLine(line) {
  appendDiagnosticsRaw(`${new Date().toISOString()}  ${line}`);
}

const diag = createDiag({ appendLine: appendDiagnosticsRaw });
const rec = createRecState((from, to, meta) => {
  diag.info('STATE', `${from} → ${to}`, meta);
});

function recToIdle(reason) {
  if (rec.phase !== 'idle' && rec.phase !== 'error') rec.transition('error', { reason });
  if (rec.phase === 'error') rec.transition('idle', { reason });
  else if (rec.phase === 'completed' || rec.phase === 'recovered') rec.transition('idle', { reason });
}

function notifyFriendly(raw, category) {
  const f = friendlyError(raw, category);
  notifyUser(f.hint ? `${f.message} ${f.hint}` : f.message);
  return f;
}

function notifyUser(message) {
  lastAppNotice = { message: String(message || ''), at: Date.now() };
  try {
    if (tray && !tray.isDestroyed()) {
      tray.displayBalloon({ title: 'Ordinary Recorder', content: lastAppNotice.message });
    }
  } catch (e) { /* ignore */ }
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('app-notice', lastAppNotice);
    mainWindow.webContents.send('recording-state', getStatePayload());
  }
}

function getFreeDiskBytesWmi(dir) {
  const drive = String(path.resolve(dir || settings.outputFolder || 'C:\\')).slice(0, 2);
  if (!/^[A-Za-z]:$/.test(drive)) return null;
  try {
    const r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-Command', `(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${drive}'").FreeSpace`],
      { encoding: 'utf8', timeout: 4000, windowsHide: true }
    );
    const n = Number(String(r.stdout || '').trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  } catch (e) {
    return null;
  }
}

function getFreeDiskBytes(dir) {
  const target = dir || settings.outputFolder || app.getPath('videos');
  try {
    if (typeof fs.statfsSync === 'function') {
      const st = fs.statfsSync(target);
      const bsize = Number(st.bsize || st.blockSize || 0);
      const bavail = Number(st.bavail != null ? st.bavail : st.bfree);
      if (bsize > 0 && bavail >= 0) return bsize * bavail;
    }
  } catch (e) { /* fall through */ }
  return getFreeDiskBytesWmi(target);
}

function remuxCopyToMp4(inputFile, outputFile) {
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) throw new Error('FFmpeg not found');
  const extra = [];
  if (settings.videoCodec === 'hevc' || /\.hevc$/i.test(inputFile)) extra.push('-tag:v', 'hvc1');
  try {
    runFfmpegArgv(ffmpegPath, [
      '-hide_banner', '-y', '-i', inputFile,
      '-c', 'copy', ...extra, '-movflags', '+faststart', outputFile
    ], 180000);
  } catch (e) {
    runFfmpegArgv(ffmpegPath, [
      '-hide_banner', '-y', '-err_detect', 'ignore_err', '-i', inputFile,
      '-c', 'copy', ...extra, '-movflags', '+faststart', outputFile
    ], 180000);
  }
  if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 8192) {
    throw new Error('Remux produced an empty file');
  }
}

function verifyFinalFile(filePath, { wantAudio = false } = {}) {
  let exists = false;
  let size = 0;
  try {
    exists = fs.existsSync(filePath);
    if (exists) size = fs.statSync(filePath).size;
  } catch (e) {
    return { ok: false, reason: 'stat-failed' };
  }
  const basic = verifyOutputBasics({ exists, size });
  if (!basic.ok) return basic;
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) return { ok: true, size, duration: 0, skippedProbe: true };
  let text = '';
  try {
    runFfmpegArgv(ffmpegPath, ['-hide_banner', '-i', filePath], 25000);
  } catch (e) {
    text = `${e.stderr || ''}${e.stdout || ''}${e.message || ''}`;
  }
  return { ...verifyFromFfmpegProbe(text, { wantAudio }), size };
}

function recoverOneContainer(inputFile, outputFile) {
  remuxCopyToMp4(inputFile, outputFile);
  const v = verifyFinalFile(outputFile);
  if (!v.ok) {
    diag.error('RECOVERY', 'Remux failed verification — keeping source', { file: inputFile, reason: v.reason });
    try {
      if (fs.existsSync(outputFile) && fs.statSync(outputFile).size < 8192) fs.unlinkSync(outputFile);
    } catch (e) { /* keep both */ }
    throw new Error(v.reason || 'verify failed');
  }
  try { fs.unlinkSync(inputFile); } catch (e) {
    diag.warn('RECOVERY', 'Could not remove source after verified remux', { file: inputFile });
  }
}

function mp4Beside(filePath) {
  return String(filePath).replace(/\.(mkv|webm|ts|partial\.mkv)$/i, '.mp4');
}

function recoveredOutputName(kind) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return path.join(settings.outputFolder, `recovered-${kind}-${timestamp}.mp4`);
}

function siblingMp4Exists(filePath) {
  const mp4 = mp4Beside(filePath);
  try {
    return mp4 !== filePath && fs.existsSync(mp4) && fs.statSync(mp4).size >= 8192;
  } catch (e) {
    return false;
  }
}

function closeMedalPartialFiles() {
  try { if (medal.partialFdV != null) fs.closeSync(medal.partialFdV); } catch (e) { /* ignore */ }
  try { if (medal.partialFdA != null) fs.closeSync(medal.partialFdA); } catch (e) { /* ignore */ }
  medal.partialFdV = null;
  medal.partialFdA = null;
}

function deleteMedalPartialFiles() {
  closeMedalPartialFiles();
  for (const p of [medal.partialVideo, medal.partialAudio, medal.partialMeta, medal.workFile]) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
  medal.partialVideo = null;
  medal.partialAudio = null;
  medal.partialMeta = null;
  medal.workFile = null;
}

function openMedalPartialFiles(base) {
  closeMedalPartialFiles();
  const ext = medal.rawFormat === 'hevc' ? '.hevc' : '.h264';
  medal.partialVideo = `${base}${ext}`;
  medal.partialAudio = `${base}.pcm`;
  medal.partialMeta = `${base}.json`;
  try {
    fs.writeFileSync(medal.partialMeta, JSON.stringify({
      fps: medal.fps || 30,
      audioRate: medal.audioRate || 48000,
      rawFormat: medal.rawFormat || 'h264',
      startedAt: Date.now()
    }), 'utf8');
    medal.partialFdV = fs.openSync(medal.partialVideo, 'a');
    medal.partialFdA = fs.openSync(medal.partialAudio, 'a');
  } catch (e) {
    console.warn('Could not open crash-safe spill files:', e.message || e);
  }
}

function appendMedalPartial(kind, buf) {
  try {
    if (kind === 'video' && medal.partialFdV != null) fs.writeSync(medal.partialFdV, buf);
    if (kind === 'audio' && medal.partialFdA != null) fs.writeSync(medal.partialFdA, buf);
  } catch (e) { /* ignore */ }
}

function processNameForHwnd(hwnd) {
  if (!hwnd) return '';
  const id = String(hwnd).replace(/[^\d]/g, '');
  if (!id) return '';
  try {
    const r = spawnSync('powershell.exe', ['-NoProfile', '-Command', [
      '$ErrorActionPreference="SilentlyContinue"',
      'Add-Type @"',
      'using System;',
      'using System.Runtime.InteropServices;',
      'public static class OrdPid {',
      '  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);',
      '}',
      '"@',
      `$pid = [uint32]0`,
      `[void][OrdPid]::GetWindowThreadProcessId([IntPtr]${id}, [ref]$pid)`,
      'if ($pid -gt 0) { (Get-Process -Id $pid).ProcessName }'
    ].join('; ')], { encoding: 'utf8', timeout: 2500, windowsHide: true });
    return String(r.stdout || '').trim().slice(0, 80);
  } catch (e) {
    return '';
  }
}

function foregroundGameIdentity() {
  const tops = queryTopWindows();
  const fg = tops.find((w) => (
    w.foreground &&
    isGameLikeWindow(w.title) &&
    !isFolderWindow(w.title)
  ));
  if (!fg) return null;
  const exe = processNameForHwnd(fg.hwnd);
  const id = (exe || String(fg.title || '').toLowerCase()).trim().toLowerCase();
  if (!id) return null;
  return { id, title: fg.title, exe };
}

function isKnownUnstableGame(ident) {
  if (!ident) return false;
  const games = settings.knownUnstableGames || [];
  const exe = String(ident.exe || '').toLowerCase();
  const id = String(ident.id || '').toLowerCase();
  const title = String(ident.title || '').toLowerCase();
  return games.some((g) => {
    let match = false;
    if (exe && g.exe && String(g.exe).toLowerCase() === exe) match = true;
    if (id && g.id && g.id === id) match = true;
    if (title && g.title && title.includes(String(g.title).toLowerCase()) && String(g.title).length > 3) match = true;
    if (!match) return false;
    if (shouldRetestUnstableGame(g)) {
      diag.info('GAME_PROFILE', 'Retesting ddagrab after cooldown', { game: g.exe || g.id });
      return false;
    }
    return true;
  });
}

function rememberUnstableGame(ident, reason) {
  const info = ident || foregroundGameIdentity();
  if (!info || !info.id) return;
  const games = settings.knownUnstableGames || [];
  const existing = games.find((g) => (info.exe && g.exe && String(g.exe).toLowerCase() === String(info.exe).toLowerCase()) || g.id === info.id);
  if (existing) {
    existing.failCount = Math.min(99, (Number(existing.failCount) || 1) + 1);
    existing.lastTriedAt = Date.now();
    existing.method = 'wgc';
    settings.knownUnstableGames = sanitizeKnownGames(games);
    saveSettings(settings);
    diag.warn('GAME_PROFILE', 'Updated capture fallback', { game: info.exe || info.title, reason });
    return;
  }
  settings.knownUnstableGames = sanitizeKnownGames([
    ...games,
    {
      id: info.id,
      title: info.title,
      exe: info.exe || '',
      method: 'wgc',
      failCount: 1,
      lastTriedAt: Date.now(),
      addedAt: Date.now()
    }
  ]);
  saveSettings(settings);
  diag.warn('GAME_PROFILE', `Skip ddagrab for ${info.exe || info.title}`, { reason });
}

function forgetUnstableGame(id) {
  const key = String(id || '').toLowerCase();
  settings.knownUnstableGames = (settings.knownUnstableGames || []).filter((g) => g.id !== key && String(g.exe || '').toLowerCase() !== key);
  saveSettings(settings);
  appendDiagnosticsLine(`Capture fallback cleared: ${key}`);
  return { ok: true, knownUnstableGames: settings.knownUnstableGames };
}

function recoverAnnexbPair(videoFile, audioFile, metaFile, outputFile) {
  let fps = 30;
  let audioRate = 48000;
  let raw = /\.hevc$/i.test(videoFile) ? 'hevc' : 'h264';
  try {
    if (metaFile && fs.existsSync(metaFile)) {
      const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
      fps = Number(meta.fps) || fps;
      audioRate = Number(meta.audioRate) || audioRate;
      if (meta.rawFormat === 'hevc') raw = 'hevc';
    }
  } catch (e) { /* ignore */ }
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  const hasAudio = audioFile && fs.existsSync(audioFile) && fs.statSync(audioFile).size > 2048;
  const argv = ['-hide_banner', '-y', '-fflags', '+genpts', '-r', String(fps), '-f', raw, '-i', videoFile];
  if (hasAudio) argv.push('-f', 's16le', '-ar', String(audioRate), '-ac', '2', '-i', audioFile, '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-af', 'apad', '-shortest');
  else argv.push('-c:v', 'copy', '-an');
  argv.push('-f', 'matroska', outputFile.replace(/\.mp4$/i, '.mkv'));
  const mkv = outputFile.replace(/\.mp4$/i, '.mkv');
  runFfmpegArgv(ffmpegPath, argv, 180000);
  remuxCopyToMp4(mkv, outputFile);
  try { fs.unlinkSync(mkv); } catch (e) { /* ignore */ }
  for (const p of [videoFile, audioFile, metaFile]) {
    try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (e) { /* ignore */ }
  }
}

async function recoverCrashedRecordings() {
  const recovered = [];
  const folder = settings.outputFolder;
  if (!folder || !fs.existsSync(folder) || !ffmpegCaps.available) return recovered;

  const consider = [];
  try {
    for (const name of fs.readdirSync(folder)) {
      if (!name || name.startsWith('.')) continue;
      const full = path.join(folder, name);
      consider.push({ name, full });
    }
  } catch (e) {
    return recovered;
  }

  for (const item of consider) {
    try {
      const st = fs.statSync(item.full);
      if (!st.isFile() || st.size < 8192) continue;
      if (siblingMp4Exists(item.full)) {
        if (/\.(mkv|partial\.mkv)$/i.test(item.name)) {
          try { fs.unlinkSync(item.full); } catch (e) { /* ignore */ }
        }
        continue;
      }
      if (/\.partial\.(h264|hevc)$/i.test(item.name)) {
        const base = item.full.replace(/\.partial\.(h264|hevc)$/i, '.partial');
        const out = recoveredOutputName('recording');
        recoverAnnexbPair(
          item.full,
          `${base}.pcm`,
          `${base}.json`,
          out
        );
        recovered.push(out);
        continue;
      }
      if (/\.(mkv)$/i.test(item.name) || (/^recording-.*\.webm$/i.test(item.name))) {
        const out = mp4Beside(item.full);
        recoverOneContainer(item.full, out);
        recovered.push(out);
      }
    } catch (e) {
      console.warn('Could not recover', item.name, e.message || e);
    }
  }

  try {
    for (const name of fs.readdirSync(folder)) {
      if (!name.startsWith('.session-')) continue;
      const dir = path.join(folder, name);
      let st;
      try { st = fs.statSync(dir); } catch (e) { continue; }
      if (!st.isDirectory()) continue;
      const segs = fs.readdirSync(dir)
        .filter((n) => /^segment-\d+\.(mkv|mp4)$/i.test(n))
        .map((n) => path.join(dir, n))
        .filter((p) => {
          try { return fs.statSync(p).size > 1024; } catch (e) { return false; }
        })
        .sort();
      let recoveredOk = false;
      if (segs.length) {
        const out = recoveredOutputName('recording');
        try {
          await concatSegments(segs, out, dir);
          const v = verifyFinalFile(out);
          if (!v.ok) throw new Error(v.reason || 'verify failed');
          recovered.push(out);
          recoveredOk = true;
        } catch (e) {
          diag.warn('RECOVERY', 'Session concat failed, trying largest segment', { err: e.message || String(e) });
          try {
            const biggest = segs.slice().sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
            recoverOneContainer(biggest, out);
            recovered.push(out);
            recoveredOk = true;
          } catch (e2) {
            diag.error('RECOVERY', 'Session remux failed — keeping folder', { err: e2.message || String(e2) });
          }
        }
      }
      if (recoveredOk || !segs.length) rmSessionFolder(dir);
    }
  } catch (e) {
    console.warn('Session folder recovery failed:', e.message || e);
  }

  try {
    const bufDir = getReplayBufferDir();
    if (fs.existsSync(bufDir)) {
      const snap = path.join(bufDir, 'medal-snapshot.mkv');
      if (fs.existsSync(snap) && fs.statSync(snap).size >= 8192) {
        const out = recoveredOutputName('replay');
        recoverOneContainer(snap, out);
        recovered.push(out);
      }
      const parts = fs.readdirSync(bufDir)
        .filter((n) => /^buffer_\d+\.(mkv|ts|mp4)$/i.test(n))
        .map((n) => path.join(bufDir, n))
        .filter((p) => {
          try { return fs.statSync(p).size > 1024; } catch (e) { return false; }
        });
      if (parts.length >= 2 || (parts.length === 1 && fs.statSync(parts[0]).size > 64 * 1024)) {
        const out = recoveredOutputName('replay');
        try {
          const ordered = parts.slice().sort((a, b) => {
            try { return fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs; } catch (e) { return String(a).localeCompare(String(b)); }
          });
          await concatSegments(ordered, out, bufDir);
          const v = verifyFinalFile(out);
          if (!v.ok) throw new Error(v.reason || 'verify failed');
          recovered.push(out);
          for (const p of ordered) {
            try { fs.unlinkSync(p); } catch (e) { /* keep leftover if delete fails */ }
          }
        } catch (e) {
          diag.warn('RECOVERY', 'Replay concat failed, remuxing largest segment', { err: e.message || String(e) });
          try {
            const biggest = parts.slice().sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0];
            recoverOneContainer(biggest, out);
            recovered.push(out);
          } catch (e2) {
            console.warn('Replay remux failed:', e2.message || e2);
          }
        }
      }
    }
  } catch (e) {
    console.warn('Replay buffer recovery failed:', e.message || e);
  }

  return recovered.filter((p) => {
    try { return fs.existsSync(p) && fs.statSync(p).size >= 8192; } catch (e) { return false; }
  });
}

function maybeSpillMedalSnapshot() {
  const now = Date.now();
  if (now - medalSpillAt < 8000) return;
  medalSpillAt = now;
  const video = medal.recording ? medal.sessionVideo : medal.video;
  const audio = medal.recording ? medal.sessionAudio : medal.audio;
  if (!video || !video.length) return;
  setImmediate(() => {
    try {
      const dest = medal.recording && medal.workFile
        ? medal.workFile
        : path.join(getReplayBufferDir(), 'medal-snapshot.mkv');
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      muxMedalMp4(video, audio, dest, medal.fps || 30);
    } catch (e) {
      console.warn('Medal snapshot spill failed:', e.message || e);
    }
  });
}

async function checkDiskSpaceGuard() {
  const free = getFreeDiskBytes();
  if (free == null) return;
  lastDiskFreeBytes = free;
  const active = isRecording || instantReplayActive || medal.active || Boolean(replayProcess);
  if (!active) {
    if (lastDiskWarning) {
      lastDiskWarning = null;
      broadcastState();
    }
    return;
  }
  const hard = diskSpaceLimitBytes();
  const warn = diskSpaceWarnBytes();
  let level = null;
  if (free <= hard) level = 'critical';
  else if (free <= warn) level = 'low';
  if (level !== lastDiskWarning) {
    lastDiskWarning = level;
    broadcastState();
  }
  if (level !== 'critical' || diskStopInFlight) return;
  diskStopInFlight = true;
  try {
    if (isRecording) {
      notifyUser('Recording stopped — disk space low');
      await stopRecording();
    } else if (settings.instantReplayEnabled && (instantReplayActive || replayProcess || medal.active)) {
      try { await saveInstantReplay(); } catch (e) { /* recover leftover mkv on next launch if save fails */ }
      try { await toggleInstantReplay(false); } catch (e) { /* ignore */ }
      notifyUser('Replay buffer stopped — disk space low');
    }
  } catch (e) {
    console.error('Disk-space stop failed:', e);
  } finally {
    diskStopInFlight = false;
    lastDiskWarning = null;
    broadcastState();
  }
}

function startDiskSpacePolling() {
  if (diskPollTimer) return;
  checkDiskSpaceGuard().catch((e) => console.warn('disk guard:', e.message || e));
  diskPollTimer = setInterval(() => {
    checkDiskSpaceGuard().catch((e) => console.warn('disk guard:', e.message || e));
  }, 8000);
}

function launchSegment() {
  if (!session) return;

  const outputFile = currentSegmentPath();
  const args = buildArgs(outputFile, {
    useDdagrab: session.useDdagrab,
    useAmf: session.useAmf,
    audioDevice: session.audioDevice,
    micDevice: session.micDevice,
    useWasapi: session.useWasapi && ffmpegCaps.hasWasapi
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
    diag.error('ENCODER', 'ffmpeg spawn error', { err: err.message || String(err) });
  });

  ffmpegProcess.stderr.on('data', (data) => {
    const msg = data.toString();
    stderrBuf += msg;
    handleFfmpegProgress(msg);
    if (session && /Audio:\s*aac|Stream #1:0.*Audio/i.test(msg)) {
      session.audioOpened = true;
    }

    // Keep console quieter — only log real problems
    if (/error|fail|invalid|could not/i.test(msg)) console.error(msg);

    if (fallbackStage > 0 || !isRecording || isPaused || !session || session.intent !== 'running') return;

    if (session.useWasapi && isAudioFailure(msg)) {
      fallbackStage = 1;
      console.warn('WASAPI loopback failed; retrying DirectShow audio.');
      appendDiagnosticsLine('Audio: WASAPI failed, falling back to DirectShow');
      session.useWasapi = false;
      try {
        const devices = listDshowAudioDevices();
        const next = resolveAudioDevice(devices);
        session.audioDevice = next;
        if (next) settings.audioDevice = next;
        session.micDevice = session.micDevice || pickMicrophoneDevice(devices);
        notifyUser(next
          ? `Game audio switched to ${next}`
          : 'Game audio may be silent — press Test Audio in Settings');
      } catch (e) { /* ignore */ }
      restartCurrentSegment();
      return;
    }

    if (session.audioDevice && isAudioFailure(msg)) {
      fallbackStage = 1;
      try {
        const devices = listDshowAudioDevices();
        const next = resolveAudioDevice(devices);
        if (next && next !== session.audioDevice) {
          console.warn('Audio device failed; switching to', next);
          applyAudioDeviceChange(`ffmpeg lost ${session.audioDevice}`, next);
          return;
        }
      } catch (e) { /* ignore */ }
      console.warn('Audio device failed; retrying without audio.');
      appendDiagnosticsLine(`Audio: dropped ${session.audioDevice} after ffmpeg error`);
      session.audioDevice = null;
      session.micDevice = null;
      session.audioDropped = true;
      session.audioOpened = false;
      notifyUser('Audio source dropped — recording continues without that device');
      restartCurrentSegment();
      return;
    }

    if (session.useDdagrab && isExclusiveFullscreenCaptureFailure(msg)) {
      fallbackStage = 1;
      console.warn('Fullscreen blocked desktop duplication; switching to game capture.');
      rememberUnstableGame(foregroundGameIdentity(), 'ddagrab exclusive-fullscreen failure');
      try { sendQuit(ffmpegProcess); } catch (e) { /* ignore */ }
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

    if (session.useAmf && isSelectedHwFailure(msg)) {
      fallbackStage = 1;
      // gameMode: first retry AMF with nv12 download if hw passthrough failed
      if (
        isAmfFailure(msg) &&
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
      console.warn('Hardware encoder failed; falling back to libx264.');
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
      if (session.useAmf && isSelectedHwFailure(msg)) {
        if (
          isAmfFailure(msg) &&
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
        session.micDevice = null;
        session.audioDropped = true;
        session.audioOpened = false;
        launchSegment();
        return;
      }
    }

    if (intent === 'pausing' || intent === 'stopping' || intent === 'switching') {
      if (outputFile && fs.existsSync(outputFile) && !session.segments.includes(outputFile)) {
        try {
          if (fs.statSync(outputFile).size > 0) session.segments.push(outputFile);
        } catch (e) { /* ignore */ }
      }
      return;
    }

  // Unexpected exit while supposedly recording
    if (isRecording && !isPaused && intent === 'running') {
      const failMsg = stderrBuf || '';
      if (isExclusiveFullscreenCaptureFailure(failMsg) && !usingGameCapture) {
        console.warn('Desktop duplication blocked by fullscreen. Switching to game capture.');
        rememberUnstableGame(foregroundGameIdentity(), 'ddagrab exited — switching to WGC');
        switchDesktopRecordingToGame().catch((e) => console.error('game capture fallback failed:', e));
        return;
      }
      console.error('ffmpeg exited unexpectedly while recording, code=', code);
      diag.critical('ENCODER', 'FFmpeg quit while recording — keeping session files', { code, tail: String(failMsg).slice(-240) });
      isRecording = false;
      isPaused = false;
      recordingStartedAt = null;
      pauseStartedAt = null;
      totalPausedMs = 0;
      resetCaptureStats();
      stopStatsPolling();
      rec.force('error', { via: 'ffmpeg-exit', code });
      session = null;
      ffmpegProcess = null;
      recToIdle('ffmpeg-exit');
      restoreMainWindow();
      broadcastState();
      const f = friendlyError(failMsg || `ffmpeg exit ${code}`, 'ENCODER');
      dialog.showMessageBox(mainWindow || undefined, {
        type: 'error',
        title: f.title,
        message: f.message,
        detail: f.hint || f.detail,
        buttons: ['OK']
      });
    }
  });
}

function restartCurrentSegment({ keepPartial = false } = {}) {
  if (!session || !ffmpegProcess) {
    launchSegment();
    return;
  }
  session.intent = 'restarting';
  const proc = ffmpegProcess;
  ffmpegProcess = null;
  try { proc.removeAllListeners('close'); } catch (e) { /* ignore */ }
  const onDone = () => {
    try {
      const p = currentSegmentPath();
      if (keepPartial && p && fs.existsSync(p) && fs.statSync(p).size > 1024) {
        if (!session.segments.includes(p)) session.segments.push(p);
        nextSegmentPath();
      } else if (p && fs.existsSync(p)) {
        fs.unlinkSync(p);
      }
    } catch (e) { /* ignore */ }
    launchSegment();
    audioSwitchInFlight = false;
  };
  try {
    proc.on('close', onDone);
    proc.kill();
  } catch (e) {
    onDone();
  }
}

// ---------- Instant Replay (rolling segment buffer) ----------
// Uses MPEG-TS segments (.ts) — far more reliable with ffmpeg's segment muxer
// than MP4, and concat -c copy into a final .mp4 works consistently.
function getReplayBufferDir() {
  return path.join(settings.outputFolder, '.replay-buffer');
}

function getReplayWrapCount() {
  const cap = maxReplayMinutesForRam();
  const minutes = Math.min(cap, Math.max(1, Number(settings.instantReplayMinutes) || 5));
  return Math.ceil((minutes * 60) / REPLAY_SEGMENT_SECONDS);
}

function replayBufferOriginMs() {
  if (medal.active) {
    return Date.now() - (medalVideoSeconds() * 1000);
  }
  const files = listReplayBufferFilesDetailed();
  const spanMs = Math.max(0, files.length * REPLAY_SEGMENT_SECONDS * 1000);
  if (spanMs > 0) return Date.now() - spanMs;
  return replayBufferStartedAt || Date.now();
}

function pruneReplayBookmarks() {
  const origin = replayBufferOriginMs();
  replayBookmarks = (replayBookmarks || []).filter((b) => Number(b.at) >= origin - 2000);
  return replayBookmarks;
}

function markReplayBookmark() {
  const live = Boolean(settings.instantReplayEnabled && (medal.active || instantReplayActive || replayProcess));
  if (!live) {
    playCue('fail');
    return { ok: false, error: 'Instant Replay is not active' };
  }
  pruneReplayBookmarks();
  const origin = replayBufferOriginMs();
  replayBookmarks.push({
    at: Date.now(),
    relMs: Math.max(0, Date.now() - origin)
  });
  playCue('bookmark');
  broadcastState();
  return { ok: true, count: replayBookmarks.length, relMs: replayBookmarks[replayBookmarks.length - 1].relMs };
}

function bookmarksInRange(saveMinutes, endedAt) {
  const end = Number(endedAt) || Date.now();
  const span = Math.max(30, Math.round(Number(saveMinutes) * 60)) * 1000;
  const start = end - span;
  return pruneReplayBookmarks()
    .filter((b) => b.at >= start && b.at <= end)
    .map((b, i) => ({
      index: i + 1,
      at: b.at,
      bufferRelMs: b.relMs != null ? Number(b.relMs) : Math.max(0, b.at - replayBufferOriginMs()),
      seconds: Math.max(0, (b.at - start) / 1000)
    }));
}

function writeReplayBookmarkSidecar(outputFile, marks, saveMinutes) {
  const payload = {
    type: 'ordinary-recorder-bookmarks',
    file: path.basename(outputFile),
    saveMinutes,
    createdAt: new Date().toISOString(),
    bookmarks: marks.map((m) => ({
      index: m.index,
      seconds: Number(Number(m.seconds).toFixed(3))
    }))
  };
  const jsonPath = outputFile.replace(/\.[^.]+$/i, '.json');
  fs.writeFileSync(jsonPath, JSON.stringify(payload, null, 2), 'utf8');
  return jsonPath;
}

function embedReplayChapters(outputFile, marks) {
  if (!marks.length) return false;
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) return false;
  const meta = path.join(path.dirname(outputFile), `.chapters-${Date.now()}.txt`);
  const tmp = `${outputFile}.chapters.mp4`;
  const lines = [';FFMETADATA1'];
  for (const m of marks) {
    const start = Math.max(0, Math.round(m.seconds * 1000));
    const end = start + 1000;
    lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${end}`, `title=Bookmark ${m.index}`, '');
  }
  try {
    fs.writeFileSync(meta, lines.join('\n'), 'utf8');
    runFfmpegArgv(ffmpegPath, [
      '-hide_banner', '-y', '-i', outputFile, '-i', meta,
      '-map_metadata', '1', '-codec', 'copy', tmp
    ], 120000);
    if (fs.existsSync(tmp) && fs.statSync(tmp).size >= 8192) {
      try { fs.unlinkSync(outputFile); } catch (e) { /* ignore */ }
      fs.renameSync(tmp, outputFile);
      return true;
    }
  } catch (e) {
    console.warn('Chapter embed failed:', e.message || e);
  } finally {
    try { if (fs.existsSync(meta)) fs.unlinkSync(meta); } catch (e) { /* ignore */ }
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch (e) { /* ignore */ }
  }
  return false;
}

function attachReplayBookmarks(outputFile, saveMinutes, endedAt) {
  const marks = bookmarksInRange(saveMinutes, endedAt);
  if (!marks.length) return { sidecar: null, bookmarks: [] };
  let sidecar = null;
  try { sidecar = writeReplayBookmarkSidecar(outputFile, marks, saveMinutes); } catch (e) {
    console.warn('Bookmark sidecar failed:', e.message || e);
  }
  return { sidecar, bookmarks: marks };
}

async function waitReplayFilesStable(tries = 6) {
  let prev = '';
  for (let i = 0; i < tries; i++) {
    const cur = listReplayBufferFilesDetailed().map((f) => `${f.name}:${f.size}`).join('|');
    if (cur && cur === prev) return;
    prev = cur;
    await new Promise((r) => setTimeout(r, 120));
  }
}

function getInstantReplayState() {
  const files = listReplayBufferFilesDetailed();
  const medalSeconds = medalVideoSeconds();
  const medalOn = Boolean(medal.active);
  const maxMinutes = maxReplayMinutesForRam();
  const minutes = Math.min(maxMinutes, Math.min(5, Number(settings.instantReplayMinutes) || 5));
  const wrap = getReplayWrapCount();
  const capacitySec = minutes * 60;
  const bufferSeconds = medalOn ? medalSeconds : files.length * REPLAY_SEGMENT_SECONDS;
  const fillPercent = capacitySec > 0 ? Math.max(0, Math.min(100, Math.round((bufferSeconds / capacitySec) * 100))) : 0;
  pruneReplayBookmarks();
  return {
    enabled: Boolean(settings.instantReplayEnabled),
    active: Boolean(settings.instantReplayEnabled && (medalOn || instantReplayActive || replayProcess)),
    minutes,
    maxMinutes,
    estimatedRamBytes: estimateReplayRamBytes({ minutes }),
    saveMinutes: Number(settings.instantReplaySaveMinutes) || 2,
    fps: Number(settings.instantReplayFps) || 30,
    pausedForRecording: replayPausedForRecording,
    bufferDir: getReplayBufferDir(),
    bufferFiles: medalOn ? medal.video.length : files.length,
    bufferSeconds,
    wrapCount: wrap,
    fillPercent,
    lastSaveOk: lastReplaySave.ok,
    lastSaveAt: lastReplaySave.at,
    lastSaveError: lastReplaySave.error,
    lastSaveFile: lastReplaySave.file,
    bookmarkCount: replayBookmarks.length
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
    '-segment_format', 'matroska',
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
    .filter((name) => /^buffer_\d+\.(ts|mp4|mkv)$/i.test(name))
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

function replaySaveNeedCount(saveMinutes) {
  const seconds = Math.max(30, Math.round(Number(saveMinutes) * 60)) || 300;
  return Math.max(1, Math.ceil(seconds / REPLAY_SEGMENT_SECONDS));
}

function copyReplayFileToStaging(src, staging, index) {
  const dest = path.join(staging, `part_${String(index).padStart(3, '0')}${path.extname(src)}`);
  fs.copyFileSync(src, dest);
  return dest;
}

/** Closed rolling files only — never the segment ffmpeg is still writing. */
function closedReplaySegments(files) {
  if (!files.length) return [];
  if (replayProcess && files.length >= 1) return files.slice(0, -1);
  return files;
}

function replayFileIsUsable(file) {
  return Boolean(file && file.size >= 8 * 1024);
}

/**
 * Copy fully-written buffer files before ffmpeg can wrap onto them.
 * Does not touch concatSegments / segment_format / live mux.
 */
function stageClosedReplaySegments(saveMinutes, staging) {
  const need = replaySaveNeedCount(saveMinutes);
  const live = listReplayBufferFilesDetailed();
  const closed = closedReplaySegments(live).filter(replayFileIsUsable);
  const newest = live.length ? live[live.length - 1] : null;
  const wrapping = Boolean(replayProcess && newest && !replayFileIsUsable(newest));
  const windowFiles = closed.slice(-need);
  const staged = windowFiles.map((f, i) => copyReplayFileToStaging(f.full, staging, i));
  return {
    staged,
    need,
    writing: newest,
    wrapping
  };
}

/** Take only the last N minutes (by mtime order / segment count). Skip wrap stubs. */
function selectReplaySegmentsForSave(saveMinutes) {
  let all = listReplayBufferFilesDetailed();
  if (!all.length) return [];
  if (replayProcess && all.length >= 1) {
    all = all.slice(0, -1);
  } else if (all.length >= 2) {
    const newest = all[all.length - 1];
    const prev = all[all.length - 2];
    if (newest.size < Math.max(8 * 1024, prev.size * 0.15)) {
      all = all.slice(0, -1);
    }
  }
  const seconds = Math.max(30, Math.round(Number(saveMinutes) * 60)) || 300;
  const need = Math.max(1, Math.ceil(seconds / REPLAY_SEGMENT_SECONDS));
  return all.slice(-need).map((f) => f.full);
}

function clearReplayBufferFiles() {
  const dir = getReplayBufferDir();
  if (!fs.existsSync(dir)) return;
  for (const name of fs.readdirSync(dir)) {
    if (/^buffer_\d+\.(ts|mp4|mkv)$/i.test(name) || name === 'replay-concat.txt' || name === 'medal-snapshot.mkv') {
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
  if (clearBuffer) {
    clearReplayBufferFiles();
    replayBookmarks = [];
    replayBufferStartedAt = Date.now();
  } else if (!replayBufferStartedAt) {
    replayBufferStartedAt = Date.now();
  }

  replayUseDdagrab = ffmpegCaps.hasDdagrab;
  replayUseAmf = pickActiveEncoder({ hardware: true }).hardware;

  // Matroska segments — crash-recoverable rolling buffer (remuxed to mp4 on save / launch)
  const pattern = path.join(dir, 'buffer_%03d.mkv');
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
    if (replayUseAmf && isSelectedHwFailure(msg)) {
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
      if (replayUseAmf && isSelectedHwFailure(msg)) {
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
  const exclusiveFail = /Selected output not supported|887a0026|887a0027|Failed to configure output pad|AcquireNextFrame/i.test(String(reason || ''));
  if (exclusiveFail) {
    console.warn('Instant Replay waiting — exclusive fullscreen blocks desktop duplication.');
    setTimeout(() => {
      if (!settings.instantReplayEnabled || isRecording || replayProcess || replayPausedForRecording) return;
      startReplayProcess({ clearBuffer: false });
    }, 15000);
    broadcastState();
    updateTrayMenu();
    return;
  }
  const lostDisplay = /ddagrab|exit-1|exit-224/i.test(String(reason || ''));
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
  return replaySaveQueue.enqueue(() => saveInstantReplayNow(saveMinutesOverride));
}

async function saveInstantReplayNow(saveMinutesOverride) {
  if (lastDiskFreeBytes != null && lastDiskFreeBytes <= diskSpaceLimitBytes()) {
    lastReplaySave = { ok: false, at: Date.now(), error: 'disk', file: null };
    playCue('fail');
    return { ok: false, error: userFacing('Disk space is too low', 'STORAGE') };
  }
  if (replayPausedForRecording && isRecording && !medal.active) {
    diag.warn('REPLAY', 'Save while recording uses leftover buffer, not live capture');
  }
  if (!settings.instantReplayEnabled && !medal.active && !instantReplayActive && !replayProcess) {
    playCue('fail');
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

  const saveRequestedAt = Date.now();

  if (!fs.existsSync(settings.outputFolder)) {
    fs.mkdirSync(settings.outputFolder, { recursive: true });
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = saveMinutes < 1 ? '30s' : `${saveMinutes}min`;
  const outputFile = path.join(settings.outputFolder, `replay-${label}-${timestamp}.mp4`);
  const dir = getReplayBufferDir();
  const staging = path.join(dir, `.save-staging-${Date.now()}`);
  fs.mkdirSync(staging, { recursive: true });

  const failSave = (detail) => {
    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e2) { /* ignore */ }
    if (settings.instantReplayEnabled) startReplayProcess({ clearBuffer: false });
    lastReplaySave = { ok: false, at: Date.now(), error: detail, file: null };
    playCue('fail');
    return { ok: false, error: detail };
  };

  let staged = [];
  try {
    // Copy closed segments first so wrap cannot clobber the save window.
    const pre = stageClosedReplaySegments(saveMinutes, staging);
    staged = pre.staged;
    const writingPath = pre.writing && pre.writing.full;

    if (replayProcess) {
      const proc = replayProcess;
      if (typeof proc._setReplayIntent === 'function') proc._setReplayIntent('save');
      sendQuit(proc);
      await waitForProcessClose(proc, 25000);
      replayProcess = null;
      instantReplayActive = false;
      await new Promise((r) => setTimeout(r, 250));
      await waitReplayFilesStable(4);
    }

    if (writingPath && fs.existsSync(writingPath)) {
      let size = 0;
      try { size = fs.statSync(writingPath).size; } catch (e) { size = 0; }
      if (size >= 8 * 1024) {
        staged.push(copyReplayFileToStaging(writingPath, staging, staged.length));
      }
      // Truncated wrap stub: skip it (shift to last fully-written boundary)
    }

    if (staged.length > pre.need) staged = staged.slice(-pre.need);

    if (!staged.length) {
      return failSave('Replay buffer is empty — leave Instant Replay ON for at least ~15–30 seconds, then try again');
    }

    await concatSegments(staged, outputFile, staging);

    const verified = verifyFinalFile(outputFile);
    if (!verified.ok) {
      throw new Error('Save produced an empty file');
    }

    try { fs.rmSync(staging, { recursive: true, force: true }); } catch (e) { /* ignore */ }

    const marks = attachReplayBookmarks(outputFile, saveMinutes, saveRequestedAt);

    if (settings.instantReplayEnabled && !isRecording) {
      startReplayProcess({ clearBuffer: false });
    }

    lastReplaySave = { ok: true, at: Date.now(), error: null, file: outputFile };
    playCue('saved');
    broadcastState();
    return { ok: true, file: outputFile, segments: staged.length, saveMinutes, bookmarks: marks.bookmarks };
  } catch (e) {
    const detail = (e.stderr && String(e.stderr).slice(-300)) || e.message || String(e);
    return failSave(`Save failed: ${detail}`);
  }
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
    const raw = medal.rawFormat === 'hevc' ? 'hevc' : 'h264';
    const isMp4 = /\.mp4$/i.test(outputFile);
    const tail = isMp4 ? `-movflags +faststart "${outputFile}"` : `-f matroska "${outputFile}"`;
    const cmd = hasAudio
      ? `"${ffmpegPath}" -hide_banner -y -fflags +genpts -r ${rate} -f ${raw} -i "${vfile}" -f s16le -ar ${audioRate} -ac 2 -i "${afile}" -c:v copy -c:a aac -b:a 192k -af apad -shortest ${tail}`
      : `"${ffmpegPath}" -hide_banner -y -fflags +genpts -r ${rate} -f ${raw} -i "${vfile}" -c:v copy -an ${tail}`;
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
  medal.rawFormat = webCodecsCodecParam() === 'hevc' ? 'hevc' : 'h264';
  const audio = settings.recordAudio ? '1' : '0';
  const ptt = settings.pttEnabled === true ? '1' : '0';
  const bitrate = captureBitrateBps({ forReplay: true });
  const pixels = capturePixelSize();
  const url = `file://${path.join(__dirname, 'game-capture.html').replace(/\\/g, '/')}?mode=medal&sourceId=${encodeURIComponent(source.id)}&screenId=${encodeURIComponent(screenId)}&fps=${fps}&audio=${audio}&ptt=${ptt}&bitrate=${bitrate}&codec=${encodeURIComponent(medal.rawFormat)}&hw=1&maxWidth=${pixels.width}&maxHeight=${pixels.height}`;

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
  medal.rawFormat = /hvc1|hev1|hevc/i.test(String((result.info && result.info.codec) || '')) ? 'hevc' : 'h264';
  medal.startedAt = Date.now();
  medal.video = [];
  medal.audio = [];
  instantReplayActive = Boolean(settings.instantReplayEnabled);
  startPowerSave();
  startGameWatch();
  sendCaptureAudioMode();
  broadcastState();
  updateTrayMenu();
  if (settings.recordAudio && !medal.hasLoopback) maybeExplainAudioFallback();
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
  closeMedalPartialFiles();
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
  if (rec.phase === 'starting') rec.transition('recording', { via: 'medal' });
  else if (rec.canStart()) {
    rec.transition('starting', { via: 'medal' });
    rec.transition('recording', { via: 'medal' });
  }
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
  playCue('start');
  medal.workFile = path.join(settings.outputFolder, `recording-${timestamp}.partial.mkv`);
  openMedalPartialFiles(path.join(settings.outputFolder, `recording-${timestamp}.partial`));
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
  closeMedalPartialFiles();
  const out = currentOutputFile;
  const work = medal.workFile || out.replace(/\.mp4$/i, '.partial.mkv');
  let error = null;
  let finalSize = 0;
  try {
    muxMedalMp4(video, audio, work, medal.fps || 30);
    remuxCopyToMp4(work, out);
    try { if (fs.existsSync(work)) fs.unlinkSync(work); } catch (e) { /* ignore */ }
    deleteMedalPartialFiles();
    finalSize = fs.existsSync(out) ? fs.statSync(out).size : 0;
  } catch (e) {
    error = e.message || String(e);
    try {
      if (work && fs.existsSync(work) && fs.statSync(work).size >= 8192) {
        remuxCopyToMp4(work, out);
        error = null;
        finalSize = fs.statSync(out).size;
        try { fs.unlinkSync(work); } catch (e2) { /* ignore */ }
        deleteMedalPartialFiles();
      }
    } catch (e2) {
      error = e2.message || String(e2);
    }
  }

  isPaused = false;
  recordingStartedAt = null;
  await resumeReplayAfterRecording();
  if (settings.instantReplayEnabled && medal.active) instantReplayActive = true;
  if (!settings.instantReplayEnabled) await stopMedalEngine({ force: true });
  if (error) recToIdle('medal-stop-failed');
  else {
    rec.transition('finalizing', { via: 'medal' });
    rec.transition('completed', { via: 'medal' });
    rec.transition('idle', { via: 'medal' });
  }
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
    lastReplaySave = { ok: false, at: Date.now(), error: 'empty', file: null };
    playCue('fail');
    return { ok: false, error: 'Replay buffer is empty — leave Instant Replay ON for ~15 seconds, then clip' };
  }
  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const label = saveMinutes < 1 ? '30s' : `${saveMinutes}min`;
  const outputFile = path.join(settings.outputFolder, `replay-${label}-${timestamp}.mp4`);
  const saveEndedAt = Date.now();
  try {
    muxMedalMp4(video, audio, outputFile, medal.fps || 30);
  } catch (e) {
    lastReplaySave = { ok: false, at: Date.now(), error: e.message || String(e), file: null };
    playCue('fail');
    return { ok: false, error: `Save failed: ${e.message || e}` };
  }
  const marks = attachReplayBookmarks(outputFile, saveMinutes, saveEndedAt);
  lastReplaySave = { ok: true, at: Date.now(), error: null, file: outputFile };
  playCue('saved');
  broadcastState();
  return { ok: true, file: outputFile, segments: video.length, saveMinutes, bookmarks: marks.bookmarks };
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

/** Exclusive / borderless-fullscreen games are not on the desktop compositor. */
function findExclusiveGameWindow(sources) {
  if (settings.exclusiveFullscreen === false) return null;
  const windows = sources.filter((s) => s.id.startsWith('window:'));
  const usableWindows = windows.filter((s) => s.name && !SKIP_CAPTURE_WINDOWS.test(s.name) && !isFolderWindow(s.name));
  const gameWindows = usableWindows.filter((s) => isGameLikeWindow(s.name));
  const tops = queryTopWindows();
  const fg = tops.find((w) => (
    w.foreground &&
    isGameLikeWindow(w.title) &&
    !isFolderWindow(w.title) &&
    isRectFullscreen(w)
  ));
  if (!fg) return null;
  const hit = matchSourceToWindow(gameWindows.length ? gameWindows : usableWindows, fg.hwnd, fg.title);
  if (!hit) return null;
  lastGameSourceId = hit.id;
  console.log('Capture target (fullscreen game):', hit.name, hit.id, fg.width, 'x', fg.height);
  return hit;
}

function pickGameCaptureSource(sources, _currentId) {
  const game = findExclusiveGameWindow(sources);
  if (game) return game;
  const screens = sources.filter((s) => s.id.startsWith('screen:'));
  if (screens[0]) {
    console.log('Capture target (full desktop):', screens[0].name, screens[0].id);
    return screens[0];
  }
  const windows = sources.filter((s) => s.id.startsWith('window:'));
  return windows.find((s) => s.name && !SKIP_CAPTURE_WINDOWS.test(s.name) && !isFolderWindow(s.name)) || windows[0] || null;
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

function startDesktopGameWatch() {
  stopDesktopGameWatch();
  desktopGameWatchTimer = setInterval(() => {
    maybeSwitchDesktopToGame().catch((e) => console.warn('desktop game watch failed:', e.message || e));
  }, 2500);
}

function stopDesktopGameWatch() {
  if (!desktopGameWatchTimer) return;
  clearInterval(desktopGameWatchTimer);
  desktopGameWatchTimer = null;
}

async function maybeSwitchDesktopToGame() {
  if (switchingToGame || usingGameCapture || medal.recording) return;
  if (!isRecording || isPaused || !session) return;
  if (settings.exclusiveFullscreen === false) return;
  let sources;
  try {
    sources = await listCaptureSources();
  } catch (e) {
    return;
  }
  if (!findExclusiveGameWindow(sources)) return;
  console.log('Fullscreen game opened during desktop recording — switching capture.');
  await switchDesktopRecordingToGame();
}

async function switchDesktopRecordingToGame() {
  if (switchingToGame || usingGameCapture) return { ok: false, error: 'already switching' };
  if (!isRecording || !session) return { ok: false, error: 'not recording' };
  switchingToGame = true;
  stopDesktopGameWatch();
  const active = session;
  try {
    active.intent = 'switching';
    if (ffmpegProcess) {
      const proc = ffmpegProcess;
      sendQuit(proc);
      await waitForProcessClose(proc);
    }
    try {
      const last = existingSegmentPath(active.folder, active.segmentIndex);
      if (last && !active.segments.includes(last)) {
        active.segments.push(last);
      }
    } catch (e) { /* ignore */ }

    const audioFile = await stopLoopbackCapture();
    let prefixSegments = active.segments.slice();
    if (prefixSegments.length) {
      try {
        const prefix = path.join(active.folder, 'desktop-prefix.mp4');
        await concatSegments(prefixSegments, prefix, active.folder);
        if (audioFile && fs.existsSync(audioFile) && fs.statSync(audioFile).size > 2048) {
          await muxLoopbackAudio(prefix, audioFile, prefix);
        }
        prefixSegments = [prefix];
      } catch (e) {
        console.warn('Could not mux desktop audio before game switch:', e.message || e);
      }
    }

    recordingHandoff = {
      folder: active.folder,
      segments: prefixSegments,
      finalFile: active.finalFile,
      startedAt: recordingStartedAt,
      totalPausedMs
    };
    session = null;
    ffmpegProcess = null;

    const result = await startGameCapture({ continueSession: true });
    if (result && result.ok) return result;

    try {
      if (recordingHandoff && recordingHandoff.segments.length) {
        await concatSegments(recordingHandoff.segments, recordingHandoff.finalFile, recordingHandoff.folder);
        currentOutputFile = recordingHandoff.finalFile;
      }
      if (recordingHandoff && recordingHandoff.folder) rmSessionFolder(recordingHandoff.folder);
    } catch (e) { /* ignore */ }
    recordingHandoff = null;
    isRecording = false;
    isPaused = false;
    stopStatsPolling();
    restoreMainWindow();
    broadcastState();
    updateTrayMenu();
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'error',
      title: 'Could not capture fullscreen',
      message: 'Stay in the game and press Ctrl+Shift+R again.',
      detail: (result && result.error) || 'If it still fails, set the game to Windowed Borderless.',
      buttons: ['OK']
    });
    return result || { ok: false, error: 'Game capture failed' };
  } finally {
    switchingToGame = false;
  }
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
      const enc = pickActiveEncoder({ hardware: true });
      if (enc.hardware && enc.ffmpegName !== 'libx264') {
        run(`-hide_banner -y -i "${webmPath}" -c:v ${enc.ffmpegName} -b:v 6M -c:a aac -b:a 160k -movflags +faststart "${mp4Path}"`);
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

async function startGameCapture(opts = {}) {
  const continueSession = Boolean(opts.continueSession);
  // Clicking Start focuses this app — hide first so the game can become foreground
  getOutOfTheWay();
  await new Promise((r) => setTimeout(r, continueSession ? 400 : 700));

  const sources = await listCaptureSources();
  console.log(
    'Visible capture windows:',
    sources.filter((s) => s.id.startsWith('window:') && s.name).map((s) => s.name).join(' | ') || '(none)'
  );
  const source = pickGameCaptureSource(sources, medal.sourceId || lastGameSourceId);
  if (!source) {
    restoreMainWindow();
    return { ok: false, error: 'No screen to capture. Open the game or app, then press Ctrl+Shift+R.' };
  }
  lastGameSourceId = source.id;
  console.log('Game capture source:', source.name, source.id);

  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  // Chromium MediaRecorder/WebCodecs write WebM (EBML / Matroska family). That is the
  // crash-safe container this engine can actually mux; leftover .webm is remuxed to .mp4 on launch.
  gameCaptureFile = path.join(settings.outputFolder, `recording-${timestamp}.webm`);
  currentOutputFile = path.join(settings.outputFolder, `recording-${timestamp}.mp4`);
  gameCaptureBytes = 0;
  gameCaptureStream = fs.createWriteStream(gameCaptureFile);
  usingGameCapture = true;

  // Fullscreen WGC path — fps/resolution follow settings; codec matches the desktop encoder
  const fps = Math.min(144, Math.max(15, effectiveFps()));
  const audio = settings.recordAudio ? '1' : '0';
  const quality = settings.spaceSaving ? 'light' : 'full';
  const pixels = capturePixelSize();
  const codec = webCodecsCodecParam();
  const hw = pickActiveEncoder({ hardware: true }).hardware ? '1' : '0';
  const bitrate = captureBitrateBps({ forReplay: false });
  const url = `file://${path.join(__dirname, 'game-capture.html').replace(/\\/g, '/')}?mode=record&sourceId=${encodeURIComponent(source.id)}&screenId=${encodeURIComponent(screenFallbackId(sources))}&fps=${fps}&audio=${audio}&quality=${quality}&codec=${encodeURIComponent(codec)}&hw=${hw}&bitrate=${bitrate}&maxWidth=${pixels.width}&maxHeight=${pixels.height}`;

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
      medal.hasLoopback = Boolean(info && info.loopback);
      medal.hasMic = Boolean(info && info.mic);
      resolve({ ok: true, source: source.name, loopback: medal.hasLoopback });
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
  if (rec.phase === 'starting') rec.transition('recording', { via: 'wgc' });
  else if (rec.canStart()) {
    rec.transition('starting', { via: 'wgc' });
    rec.transition('recording', { via: 'wgc' });
  }
  if (!continueSession) {
    recordingStartedAt = Date.now();
    pauseStartedAt = null;
    totalPausedMs = 0;
    playCue('start');
  } else if (recordingHandoff) {
    recordingStartedAt = recordingHandoff.startedAt || recordingStartedAt;
    totalPausedMs = recordingHandoff.totalPausedMs || 0;
  }
  session = null;

  getOutOfTheWay();
  startStatsPolling();
  updateTrayMenu();
  broadcastState();
  appendDiagnosticsLine(`Audio: Chromium/WGC capture (${describeAudioRoute()})`);
  if (settings.recordAudio && !medal.hasLoopback) maybeExplainAudioFallback();
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

  const handoff = recordingHandoff;
  recordingHandoff = null;
  if (!error && handoff && handoff.segments && handoff.segments.length) {
    try {
      const parts = handoff.segments.slice();
      if (currentOutputFile && fs.existsSync(currentOutputFile) && fs.statSync(currentOutputFile).size >= 8192) {
        parts.push(currentOutputFile);
      }
      await concatSegments(parts, handoff.finalFile, handoff.folder);
      const merged = handoff.finalFile;
      if (currentOutputFile && currentOutputFile !== merged && fs.existsSync(currentOutputFile)) {
        try { fs.unlinkSync(currentOutputFile); } catch (e) { /* keep extra file */ }
      }
      currentOutputFile = merged;
      finalSize = fs.existsSync(merged) ? fs.statSync(merged).size : finalSize;
    } catch (e) {
      console.warn('Could not join desktop + game into one file:', e.message || e);
    }
    try { rmSessionFolder(handoff.folder); } catch (e) { /* ignore */ }
  } else if (error && handoff && handoff.segments && handoff.segments.length) {
    try {
      await concatSegments(handoff.segments, handoff.finalFile, handoff.folder);
      currentOutputFile = handoff.finalFile;
      finalSize = fs.existsSync(handoff.finalFile) ? fs.statSync(handoff.finalFile).size : 0;
      error = null;
    } catch (e) {
      console.warn('Could not save desktop footage after game switch:', e.message || e);
    }
    try { rmSessionFolder(handoff.folder); } catch (e) { /* ignore */ }
  } else if (handoff && handoff.folder) {
    try { rmSessionFolder(handoff.folder); } catch (e) { /* ignore */ }
  }

  isRecording = false;
  isPaused = false;
  recordingStartedAt = null;
  stopStatsPolling();
  await resumeReplayAfterRecording();
  if (error) recToIdle('wgc-stop-failed');
  else {
    rec.transition('finalizing', { via: 'wgc' });
    rec.transition('completed', { via: 'wgc' });
    rec.transition('idle', { via: 'wgc' });
  }
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
      appendMedalPartial('video', item.buf);
    }
    pruneMedalRing();
    maybeSpillMedalSnapshot();
  } catch (e) {
    console.error('medal video chunk failed:', e);
  }
});

ipcMain.on('medal-audio-chunk', (_e, buf) => {
  if (!medal.active) return;
  try {
    const item = { buf: Buffer.from(buf) };
    medal.audio.push(item);
    if (medal.recording && !isPaused) {
      medal.sessionAudio.push(item);
      appendMedalPartial('audio', item.buf);
    }
  } catch (e) {
    console.error('medal audio chunk failed:', e);
  }
});

ipcMain.on('medal-capture-stats', (_e, info) => {
  if (!info) return;
  if (typeof info.captureFps === 'number' && info.captureFps > 0) liveCaptureFps = Number(info.captureFps);
  if (typeof info.audioPeak === 'number') lastAudioPeak = info.audioPeak;
  if (typeof info.loopbackPeak === 'number') lastLoopbackPeak = info.loopbackPeak;
  if (typeof info.micPeak === 'number') lastMicPeak = info.micPeak;
  if (typeof info.hasLoopback === 'boolean') medal.hasLoopback = info.hasLoopback;
  if (typeof info.hasMic === 'boolean') medal.hasMic = info.hasMic;
  if (info.audioLive != null) medal.hasAudio = Boolean(info.audioLive);
  if (info.audioDropped) {
    appendDiagnosticsLine(`Audio: Chromium track ended (${info.audioDropped})`);
    if (info.audioDropped === 'loopback') {
      lastLoopbackPeak = 0;
      medal.hasLoopback = false;
      notifyUser('Game audio source dropped');
    } else if (info.audioDropped === 'mic') {
      lastMicPeak = 0;
      medal.hasMic = false;
      notifyUser('Microphone unplugged');
    }
  }
  if (isRecording) pushCaptureStatsToUi();
});

// Wire chunk IPC once
let gameCaptureBackpressure = false;
ipcMain.on('game-capture-chunk', (_e, buf) => {
  if (!usingGameCapture || !gameCaptureStream || gameCaptureBackpressure) return;
  try {
    const data = Buffer.from(buf);
    gameCaptureBytes += data.length;
    const ok = gameCaptureStream.write(data);
    if (!ok) {
      gameCaptureBackpressure = true;
      gameCaptureStream.once('drain', () => { gameCaptureBackpressure = false; });
    }
  } catch (e) {
    diag.warn('CAPTURE', 'Game capture write failed', { err: e.message || String(e) });
  }
});

// ---------- Recording control ----------
async function startRecording() {
  if (isRecording || rec.isActive()) {
    return { ok: false, error: userFacing('Already recording', 'CAPTURE') };
  }
  if (!rec.canStart() || !rec.transition('starting', { via: 'startRecording' })) {
    return { ok: false, error: userFacing('Already recording', 'CAPTURE') };
  }

  const failStart = (err) => {
    recToIdle(String(err || 'start-failed'));
    return { ok: false, error: userFacing(err, 'CAPTURE') };
  };

  const free = getFreeDiskBytes();
  if (free != null && free <= diskSpaceLimitBytes()) {
    return failStart('Disk space is too low');
  }

  // If startup probe hasn't finished / failed transiently, retry once now
  if (!ffmpegCaps.available) {
    probeFfmpeg();
  }

  if (!ffmpegCaps.available) {
    showFfmpegWarning(ffmpegCaps);
    return failStart('FFmpeg not found. Put ffmpeg.exe in the ffmpeg/ folder or install it and add to PATH.');
  }

  // Instant Replay holds DXGI — release it before a live recording
  if (instantReplayActive || replayProcess) {
    await pauseReplayForRecording();
  }
  replayPausedForRecording = true;

  const flagged = settings.exclusiveFullscreen !== false ? foregroundGameIdentity() : null;
  if (flagged && isKnownUnstableGame(flagged)) {
    appendDiagnosticsLine(`Capture: skipping ddagrab for known-unstable ${flagged.exe || flagged.title}`);
    const gameCap = await startGameCapture();
    if (gameCap.ok) return gameCap;
    console.warn('Known-unstable game capture failed, trying desktop:', gameCap.error);
  }

  // Fullscreen games need WGC window capture. Everything else (desktop, browsers,
  // other software, windowed/borderless games) is recorded as the whole screen.
  let exclusiveGame = false;
  try {
    exclusiveGame = Boolean(findExclusiveGameWindow(await listCaptureSources()));
  } catch (e) { /* ignore */ }
  if (exclusiveGame) {
    const gameCap = await startGameCapture();
    if (gameCap.ok) return gameCap;
    console.warn('Fullscreen game capture failed, trying full desktop:', gameCap.error);
  }

  if (!fs.existsSync(settings.outputFolder)) fs.mkdirSync(settings.outputFolder, { recursive: true });

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const sessionFolder = path.join(settings.outputFolder, `.session-${timestamp}`);
  fs.mkdirSync(sessionFolder, { recursive: true });

  currentOutputFile = path.join(settings.outputFolder, `recording-${timestamp}.mp4`);

  let useDdagrab = ffmpegCaps.hasDdagrab;
  let useAmf = pickActiveEncoder({ hardware: true }).hardware;
  if (settings.gameMode) useDdagrab = ffmpegCaps.hasDdagrab; // never prefer GDI for games

  session = {
    folder: sessionFolder,
    finalFile: currentOutputFile,
    segmentIndex: 1,
    segments: [],
    useDdagrab,
    useAmf,
    forceAmfDownload: false,
    audioDevice: null,
    micDevice: null,
    useWasapi: false,
    useLoopback: Boolean(settings.recordAudio),
    audioOpened: false,
    audioDropped: false,
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

  let loopback = { ok: false };
  if (settings.recordAudio) {
    refreshAudioProbe({ testWasapi: audioProbe.wasapiWorks == null });
    const devices = ffmpegCaps.available ? listDshowAudioDevices() : [];
    const micDevice = (
      settings.audioSource !== 'mic' &&
      settings.pttEnabled !== true
    ) ? pickMicrophoneDevice(devices) : (
      settings.audioSource === 'mic' ? pickMicrophoneDevice(devices) : null
    );

    if (settings.audioSource === 'mic') {
      const micOnly = micDevice || pickMicrophoneDevice(devices);
      session.useWasapi = false;
      session.useLoopback = false;
      session.audioDevice = micOnly;
      session.micDevice = null;
      appendDiagnosticsLine(`Audio: microphone only (${micOnly || 'none'})`);
      if (!micOnly) notifyUser('No microphone found — recording will be silent');
    } else if (audioProbe.wasapiWorks) {
      session.useWasapi = true;
      session.useLoopback = false;
      session.audioDevice = null;
      session.micDevice = micDevice;
      appendDiagnosticsLine(`Audio: using WASAPI loopback (${describeAudioRoute()})`);
    } else {
      try {
        loopback = await startLoopbackCapture(sessionFolder);
      } catch (e) {
        loopback = { ok: false, error: e.message || String(e) };
      }
      if (loopback.ok) {
        console.log('Recording desktop audio from speakers/headphones (loopback).');
        appendDiagnosticsLine(`Audio: Chromium loopback (${describeAudioRoute()})`);
      } else {
        console.warn('Loopback audio failed, trying DirectShow:', loopback.error);
        let audioDevice = getSelectedAudioDevice() || resolveAudioDevice(devices);
        if (audioDevice && audioDevice !== settings.audioDevice) {
          settings.audioDevice = audioDevice;
          saveSettings(settings);
        }
        session.audioDevice = audioDevice;
        session.micDevice = (
          settings.audioSource !== 'mic' &&
          settings.pttEnabled !== true &&
          audioDevice &&
          !isMicrophoneDevice(audioDevice)
        ) ? pickMicrophoneDevice(devices) : micDevice;
        session.useLoopback = false;
        session.useWasapi = Boolean(settings.audioSource !== 'mic' && ffmpegCaps.hasWasapi);
        appendDiagnosticsLine(`Audio: DirectShow fallback device=${audioDevice || '(none)'} (${describeAudioRoute()})`);
        maybeExplainAudioFallback();
        if (!audioDevice && !session.useWasapi) {
          notifyUser('No game audio source — recording will be silent');
          maybeExplainAudioFallback();
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.webContents.send('recording-state', {
              ...getStatePayload(),
              warning: audioProbe.hint
            });
          }
        }
      }
    }
  }

  launchSegment();
  if (!rec.transition('recording', { via: 'desktop' })) rec.force('recording', { via: 'desktop' });
  startDesktopGameWatch();
  startStatsPolling();
  updateTrayMenu();
  broadcastState();
  playCue('start');
  return { ok: true, file: currentOutputFile, replayPaused: replayPausedForRecording };
}

async function pauseRecording() {
  if (!isRecording) return { ok: false, error: 'Not recording' };
  if (rec.isBusyStop()) return { ok: false, error: 'Already stopping' };
  if (!rec.canPause() && rec.phase !== 'recording') return { ok: false, error: 'Not recording' };
  stopDesktopGameWatch();
  if (medal.recording) {
    isPaused = true;
    pauseStartedAt = Date.now();
    rec.transition('paused', { via: 'pause-medal' });
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
  try { if (loopbackWin && !loopbackWin.isDestroyed()) loopbackWin.webContents.send('loopback-control', 'pause'); } catch (e) { /* ignore */ }
  const proc = ffmpegProcess;
  sendQuit(proc);
  await waitForProcessClose(proc);

  isPaused = true;
  pauseStartedAt = Date.now();
  rec.transition('paused', { via: 'pause' });
  updateTrayMenu();
  broadcastState();
  showMainWindow();
  return { ok: true, isPaused: true };
}

async function resumeRecording() {
  if (!isRecording) return { ok: false, error: 'Not recording' };
  if (!isPaused) return { ok: false, error: 'Not paused' };
  if (rec.isBusyStop()) return { ok: false, error: 'Already stopping' };
  if (medal.recording) {
    if (pauseStartedAt) {
      totalPausedMs += Date.now() - pauseStartedAt;
      pauseStartedAt = null;
    }
    isPaused = false;
    rec.transition('recording', { via: 'resume-medal' });
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
  rec.transition('recording', { via: 'resume' });
  try { if (loopbackWin && !loopbackWin.isDestroyed()) loopbackWin.webContents.send('loopback-control', 'resume'); } catch (e) { /* ignore */ }
  launchSegment();
  startDesktopGameWatch();
  updateTrayMenu();
  broadcastState();
  return { ok: true, isPaused: false };
}

async function stopRecording() {
  if (rec.isBusyStop()) return { ok: false, error: 'Already stopping' };
  if (!isRecording && !rec.canStop()) return { ok: false, error: 'Not recording' };
  rec.transition('stopping', { via: 'stopRecording' });
  stopDesktopGameWatch();
  playCue('stop');
  if (medal.recording) return stopMedalRecording();
  if (usingGameCapture) return stopGameCapture();
  if (!session) {
    recToIdle('no-session');
    return { ok: false, error: 'Not recording' };
  }

  const activeSession = session;

  if (!isPaused && ffmpegProcess) {
    activeSession.intent = 'stopping';
    const proc = ffmpegProcess;
    sendQuit(proc);
    await waitForProcessClose(proc);
  } else if (isPaused) {
    // Segment already finalized on pause; nothing to quit
  }

  const audioFile = await stopLoopbackCapture();

  // Ensure current segment is tracked if it finished with content
  try {
    const last = session && existingSegmentPath(activeSession.folder, activeSession.segmentIndex);
    if (last && !activeSession.segments.includes(last)) {
      activeSession.segments.push(last);
    }
  } catch (e) {
    diag.warn('STORAGE', 'Could not track final segment', { err: e.message || String(e) });
  }

  rec.transition('finalizing', { via: 'desktop-mux' });
  let concatError = null;
  let finalSize = 0;
  try {
    if (activeSession.segments.length === 0) {
      concatError = 'No video was captured (0 bytes). Leave the game in exclusive fullscreen, turn Game Mode + Fullscreen capture ON, then press Ctrl+Shift+R.';
    } else {
      await concatSegments(activeSession.segments, activeSession.finalFile);
      currentOutputFile = activeSession.finalFile;
      if (audioFile && fs.existsSync(audioFile) && fs.statSync(audioFile).size > 2048) {
        try {
          await muxLoopbackAudio(currentOutputFile, audioFile, currentOutputFile);
        } catch (e) {
          diag.warn('AUDIO', 'Could not mux desktop audio', { err: e.message || String(e) });
        }
      }
      const verified = verifyFinalFile(currentOutputFile, {
        wantAudio: Boolean(settings.recordAudio && !activeSession.audioDropped && (audioFile || activeSession.useWasapi || activeSession.audioOpened))
      });
      finalSize = verified.size || 0;
      if (!verified.ok) {
        concatError = verified.reason === 'no-audio'
          ? 'Recording saved but audio is missing.'
          : 'Recording file is empty/too small. Keep Game Mode + Fullscreen capture ON, start the game fullscreen first, then Ctrl+Shift+R.';
        if (verified.reason !== 'no-audio') {
          try { if (fs.existsSync(currentOutputFile) && fs.statSync(currentOutputFile).size < 8192) fs.unlinkSync(currentOutputFile); } catch (e) { /* keep */ }
        } else {
          concatError = null;
        }
      }
    }
  } catch (e) {
    concatError = e.message || String(e);
    diag.error('STORAGE', 'Concat failed', { err: concatError });
  }

  if (!concatError) rmSessionFolder(activeSession.folder);
  else diag.warn('STORAGE', 'Keeping session folder after failed finalize', { folder: activeSession.folder });

  isRecording = false;
  isPaused = false;
  recordingStartedAt = null;
  pauseStartedAt = null;
  totalPausedMs = 0;
  session = null;
  ffmpegProcess = null;
  resetCaptureStats();
  stopStatsPolling();

  await resumeReplayAfterRecording();

  if (concatError) recToIdle('finalize-failed');
  else {
    rec.transition('completed', { via: 'desktop-mux' });
    rec.transition('idle', { via: 'desktop-mux' });
  }

  updateTrayMenu();
  broadcastState();
  restoreMainWindow();

  if (concatError) {
    const f = friendlyError(concatError, 'CAPTURE');
    dialog.showMessageBox(mainWindow || undefined, {
      type: 'warning',
      title: f.title,
      message: f.message,
      detail: f.hint || concatError,
      buttons: ['OK']
    });
    return { ok: false, error: userFacing(concatError, 'CAPTURE'), file: currentOutputFile };
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
    if (!hotkeyDebounce.rec()) return;
    diag.info('HOTKEY', 'record');
    if (isRecording || rec.canStop()) stopRecording();
    else startRecording();
  });
  const pauseOk = bind(settings.pauseHotkey, () => {
    if (!hotkeyDebounce.pause()) return;
    if (!isRecording) return;
    diag.info('HOTKEY', 'pause');
    if (isPaused) resumeRecording();
    else pauseRecording();
  });
  const clipOk = bind(settings.replayHotkey, () => {
    if (!hotkeyDebounce.clip()) return;
    if (!settings.instantReplayEnabled && !medal.active) return;
    diag.info('HOTKEY', 'replay-save');
    saveInstantReplay();
  });
  const markOk = bind(settings.bookmarkHotkey, () => {
    if (!hotkeyDebounce.mark()) return;
    markReplayBookmark();
  });

  return {
    hotkey: recOk,
    pauseHotkey: pauseOk,
    replayHotkey: clipOk,
    bookmarkHotkey: markOk
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

function resolveLibraryFile(filePath) {
  const resolved = path.resolve(String(filePath || ''));
  const root = path.resolve(settings.outputFolder);
  const rel = path.relative(root, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
  try {
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  } catch (e) {
    return null;
  }
  return resolved;
}

function probeRecordingFile(filePath) {
  const resolved = resolveLibraryFile(filePath);
  if (!resolved) return { ok: false, error: 'That file is not in your recordings folder' };
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  let duration = 0;
  try {
    runFfmpegArgv(ffmpegPath, ['-hide_banner', '-i', resolved], 25000);
  } catch (e) {
    duration = parseDurationSeconds(`${e.stderr || ''}${e.stdout || ''}${e.message || ''}`);
  }
  if (!duration) {
    try { duration = 0; } catch (e) { /* ignore */ }
  }
  return {
    ok: true,
    path: resolved,
    url: pathToFileURL(resolved).href,
    duration,
    name: path.basename(resolved)
  };
}

function formatTrimStamp(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}m${ss}s`;
}

function trimRecordingFile({ filePath, startSec, endSec, precise }) {
  const resolved = resolveLibraryFile(filePath);
  if (!resolved) return { ok: false, error: 'That file is not in your recordings folder' };
  const ffmpegPath = ffmpegCaps.path || getFfmpegPath();
  if (!ffmpegPath) return { ok: false, error: 'FFmpeg not found' };

  const start = Math.max(0, Number(startSec) || 0);
  let end = Math.max(start + 0.2, Number(endSec) || 0);
  const probed = probeRecordingFile(resolved);
  if (probed.ok && probed.duration && end > probed.duration) end = probed.duration;
  if (end - start < 0.2) return { ok: false, error: 'Trim range is too short' };

  const ext = path.extname(resolved) || '.mp4';
  const base = path.basename(resolved, ext);
  const outName = `${base}-trim-${formatTrimStamp(start)}-${formatTrimStamp(end)}${ext === '.webm' ? '.mp4' : ext}`;
  const outputFile = path.join(settings.outputFolder, outName);
  if (fs.existsSync(outputFile)) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const alt = path.join(settings.outputFolder, `${base}-trim-${stamp}.mp4`);
    return trimToPath(ffmpegPath, resolved, alt, start, end, Boolean(precise));
  }
  return trimToPath(ffmpegPath, resolved, outputFile, start, end, Boolean(precise));
}

function trimToPath(ffmpegPath, inputFile, outputFile, start, end, precise) {
  const duration = Math.max(0.2, end - start);
  try {
    if (!precise) {
      runFfmpegArgv(ffmpegPath, [
        '-hide_banner', '-y',
        '-ss', start.toFixed(3),
        '-to', end.toFixed(3),
        '-i', inputFile,
        '-c', 'copy',
        '-avoid_negative_ts', 'make_zero',
        '-movflags', '+faststart',
        outputFile
      ], 180000);
    } else {
      const args = ['-hide_banner', '-y', '-i', inputFile, '-ss', start.toFixed(3), '-t', duration.toFixed(3)];
      pushStableVideoEncoderArgs(args, { fps: effectiveFps(), useAmf: pickActiveEncoder({ hardware: true }).hardware, forReplay: false });
      args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-ar', '48000', '-movflags', '+faststart', outputFile);
      runFfmpegArgv(ffmpegPath, args, 300000);
    }
  } catch (e) {
    if (!precise) {
      try {
        return trimToPath(ffmpegPath, inputFile, outputFile, start, end, true);
      } catch (e2) {
        return { ok: false, error: e2.message || String(e2) };
      }
    }
    return { ok: false, error: e.message || String(e) };
  }
  try {
    if (!fs.existsSync(outputFile) || fs.statSync(outputFile).size < 8192) {
      return { ok: false, error: 'Trim produced an empty file' };
    }
  } catch (e) {
    return { ok: false, error: 'Trim did not write a file' };
  }
  return { ok: true, file: outputFile, name: path.basename(outputFile) };
}

function applyWizardChoices(overrides) {
  const defaults = wizardDefaultsForTier(hardwareInfo.tier);
  const next = { ...defaults, ...(overrides || {}) };
  settings.fps = Number(next.fps) === 144 || Number(next.fps) === 60 ? Number(next.fps) : 30;
  settings.outputResolution = ['native', '1440', '1080', '720'].includes(next.outputResolution)
    ? next.outputResolution
    : defaults.outputResolution;
  settings.videoCodec = ['h264', 'hevc', 'av1'].includes(next.videoCodec) ? next.videoCodec : 'h264';
  settings.encoder = ['auto', 'nvenc', 'amf', 'qsv', 'x264'].includes(next.encoder) ? next.encoder : 'auto';
  settings.spaceSaving = next.spaceSaving !== false;
  settings.instantReplayMinutes = Math.min(
    maxReplayMinutesForRam(),
    Math.min(5, Math.max(1, Number(next.instantReplayMinutes) || defaults.instantReplayMinutes))
  );
  settings.instantReplaySaveMinutes = [0.5, 1, 2, 3, 4, 5].includes(Number(next.instantReplaySaveMinutes))
    ? Number(next.instantReplaySaveMinutes)
    : defaults.instantReplaySaveMinutes;
  settings.wizardCompleted = true;
  settings.hardwareProfile = {
    tier: hardwareInfo.tier,
    gpuName: hardwareInfo.gpuName,
    vendor: hardwareInfo.vendor,
    vramBytes: hardwareInfo.vramBytes,
    ramBytes: hardwareInfo.ramBytes,
    cpuCores: hardwareInfo.cpuCores,
    cpuModel: hardwareInfo.cpuModel,
    discrete: hardwareInfo.discrete,
    defaults: {
      fps: settings.fps,
      outputResolution: settings.outputResolution,
      instantReplayMinutes: settings.instantReplayMinutes,
      videoCodec: settings.videoCodec
    },
    detectedAt: Date.now()
  };
  saveSettings(settings);
  refreshSelectedEncoder();
  writeDiagnosticsLog();
  if (settings.instantReplayEnabled && !isRecording && !replayProcess) {
    startReplayProcess({ clearBuffer: true });
  }
  return { ok: true, settings, hardware: getHardwareUiPayload() };
}

// ---------- IPC ----------
ipcMain.handle('get-settings', () => settings);
ipcMain.handle('get-hardware', () => getHardwareUiPayload());
ipcMain.handle('complete-wizard', (_e, payload) => {
  const customize = Boolean(payload && payload.customize);
  return applyWizardChoices(customize ? (payload.settings || {}) : null);
});
ipcMain.handle('probe-recording', (_e, filePath) => probeRecordingFile(filePath));
ipcMain.handle('trim-recording', (_e, opts) => {
  try {
    return trimRecordingFile(opts || {});
  } catch (e) {
    return { ok: false, error: e.message || String(e) };
  }
});
ipcMain.handle('save-settings', (e, newSettings) => {
  const prevFps = settings.instantReplayFps;
  const prevGame = settings.gameMode;
  const prevAudio = settings.recordAudio;
  const prevBufferMinutes = settings.instantReplayMinutes;
  const prevPtt = settings.pttEnabled;
  const prevEncoder = settings.encoder;
  const prevCodec = settings.videoCodec;
  const prevRes = settings.outputResolution;
  const prevRecordFps = settings.fps;
  const prevHotkeys = {
    hotkey: settings.hotkey,
    pauseHotkey: settings.pauseHotkey,
    replayHotkey: settings.replayHotkey,
    bookmarkHotkey: settings.bookmarkHotkey
  };
  settings = { ...settings, ...newSettings };

  if (settings.gameMode) {
    settings.instantReplayFps = Math.min(30, Number(settings.instantReplayFps) || 30);
    if (settings.instantReplayFps !== 15 && settings.instantReplayFps !== 30) {
      settings.instantReplayFps = 30;
    }
  }

  settings.encoder = ['auto', 'nvenc', 'amf', 'qsv', 'x264'].includes(settings.encoder) ? settings.encoder : 'auto';
  settings.videoCodec = ['h264', 'hevc', 'av1'].includes(settings.videoCodec) ? settings.videoCodec : 'h264';
  settings.outputResolution = ['native', '1440', '1080', '720'].includes(settings.outputResolution)
    ? settings.outputResolution
    : 'native';
  const recFps = Number(settings.fps);
  settings.fps = recFps === 144 || recFps === 60 ? recFps : 30;
  settings.diskSpaceLimitMb = Math.min(4096, Math.max(200, Number(settings.diskSpaceLimitMb) || 500));
  settings.knownUnstableGames = sanitizeKnownGames(settings.knownUnstableGames);
  settings.instantReplayMinutes = Math.min(maxReplayMinutesForRam(), Math.min(5, Math.max(1, Number(settings.instantReplayMinutes) || 5)));
  const saveOpts = [0.5, 1, 2, 3, 4, 5];
  const saveMin = Number(settings.instantReplaySaveMinutes);
  settings.instantReplaySaveMinutes = saveOpts.includes(saveMin) ? saveMin : 2;
  const fpsOpts = [15, 30, 60];
  if (!fpsOpts.includes(Number(settings.instantReplayFps))) {
    settings.instantReplayFps = 30;
  } else {
    settings.instantReplayFps = Number(settings.instantReplayFps);
  }
  settings.exclusiveFullscreen = Boolean(settings.exclusiveFullscreen);
  settings.gameMode = Boolean(settings.gameMode);
  settings.amfRateControl = settings.amfRateControl === 'cqp' ? 'cqp' : 'vbr_peak';
  settings.audioSource = settings.audioSource === 'mic' ? 'mic' : 'system';
  settings.pttEnabled = settings.pttEnabled === true;
  settings.pttKey = PTT_KEYS[settings.pttKey] ? settings.pttKey : 'V';
  settings.hotkey = sanitizeAccelerator(settings.hotkey, defaultSettings.hotkey);
  settings.pauseHotkey = sanitizeAccelerator(settings.pauseHotkey, defaultSettings.pauseHotkey);
  settings.replayHotkey = sanitizeAccelerator(settings.replayHotkey, defaultSettings.replayHotkey);
  settings.bookmarkHotkey = sanitizeAccelerator(settings.bookmarkHotkey, defaultSettings.bookmarkHotkey);
  settings.settingsVersion = SETTINGS_VERSION;

  const hotkeyList = [settings.hotkey, settings.pauseHotkey, settings.replayHotkey, settings.bookmarkHotkey];
  let hotkeyError = null;
  if (new Set(hotkeyList).size !== hotkeyList.length) {
    settings.hotkey = prevHotkeys.hotkey;
    settings.pauseHotkey = prevHotkeys.pauseHotkey;
    settings.replayHotkey = prevHotkeys.replayHotkey;
    settings.bookmarkHotkey = prevHotkeys.bookmarkHotkey;
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
  refreshSelectedEncoder();
  startPttWatcher();
  sendCaptureAudioMode();
  const registered = registerGlobalHotkeys();
  if (!hotkeyError) {
    const failed = Object.entries(registered).filter(([, ok]) => !ok).map(([k]) => k);
    if (failed.length) {
      settings.hotkey = prevHotkeys.hotkey;
      settings.pauseHotkey = prevHotkeys.pauseHotkey;
      settings.replayHotkey = prevHotkeys.replayHotkey;
      settings.bookmarkHotkey = prevHotkeys.bookmarkHotkey;
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
    (
      prevFps !== settings.instantReplayFps ||
      prevGame !== settings.gameMode ||
      prevBufferMinutes !== settings.instantReplayMinutes ||
      prevEncoder !== settings.encoder ||
      prevCodec !== settings.videoCodec ||
      prevRes !== settings.outputResolution ||
      prevRecordFps !== settings.fps
    )
  ) {
    restartReplayProcess();
  }

  return { ...settings, hotkeyError, hardware: getHardwareUiPayload() };
});
ipcMain.handle('list-audio-devices', () => {
  const probe = refreshAudioProbe({ testWasapi: audioProbe.wasapiWorks == null });
  if (!ffmpegCaps.available) {
    return { devices: [], hint: 'FFmpeg not ready', audioSource: settings.audioSource, probe };
  }
  return {
    devices: probe.devices,
    hint: probe.hint,
    warning: probe.warning,
    showDevicePicker: Boolean(
      settings.recordAudio &&
      settings.audioSource !== 'mic' &&
      !probe.wasapiWorks
    ),
    audioSource: settings.audioSource === 'mic' ? 'mic' : 'system',
    preferred: probe.preferred,
    loopbackKind: probe.loopbackKind,
    wasapiWorks: probe.wasapiWorks,
    stereoMix: probe.stereoMix,
    virtualCable: probe.virtualCable,
    probe
  };
});
ipcMain.handle('test-audio', () => testAudioCapture());
ipcMain.handle('mark-replay-bookmark', () => markReplayBookmark());
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
ipcMain.handle('get-diagnostics', () => ({
  recPhase: rec.phase,
  captureHealthy: Boolean(isRecording && !isPaused && !captureUnhealthy),
  encoder: (hardwareInfo.encoder && hardwareInfo.encoder.label) || null,
  ddagrab: Boolean(ffmpegCaps.hasDdagrab),
  wasapi: Boolean(ffmpegCaps.hasWasapi),
  audioRoute: audioProbe.loopbackKind || null,
  diskFreeBytes: lastDiskFreeBytes,
  diskLimitBytes: diskSpaceLimitBytes(),
  replay: getInstantReplayState(),
  recent: diag.recent(),
  log: diag.snapshot()
}));
ipcMain.handle('forget-unstable-game', (_e, id) => forgetUnstableGame(id));
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
      if (/\.partial\./i.test(name) || /\.mkv$/i.test(name)) continue;
      if (!/\.(mp4|webm|mov)$/i.test(name)) continue;
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

  try { probeHardware(); } catch (e) { console.warn('Hardware probe failed:', e.message || e); }

  createWindow();
  createTray();
  startPttWatcher();
  registerGlobalHotkeys();

  // Async probe — never block the UI thread with long sync waits / HEVC tests
  setTimeout(async () => {
    try {
      const caps = await probeFfmpegAsync();
      refreshSelectedEncoder();
      writeDiagnosticsLog();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hardware-ready', getHardwareUiPayload());
      }
      console.log('FFmpeg path:', caps.path, caps);
      showFfmpegWarning(caps);

      try {
        refreshAudioProbe({ testWasapi: true });
        appendDiagnosticsLine(`Audio probe: ${describeAudioRoute()}`);
        writeDiagnosticsLog();
        maybeExplainAudioFallback();
      } catch (audioErr) {
        console.warn('Audio probe failed:', audioErr.message || audioErr);
      }

      try {
        rec.transition('recovering', { via: 'startup' });
        const recovered = await recoverCrashedRecordings();
        rec.transition('recovered', { via: 'startup' });
        rec.transition('idle', { via: 'startup' });
        if (recovered.length) {
          const msg = recovered.length === 1
            ? 'Recovered recording from last session'
            : `Recovered ${recovered.length} recordings from last session`;
          notifyUser(msg);
          diag.info('RECOVERY', msg, { count: recovered.length });
        }
      } catch (recErr) {
        recToIdle('recovery-failed');
        diag.error('RECOVERY', 'Crash recovery failed', { err: recErr.message || String(recErr) });
      }

      startDiskSpacePolling();

      if (settings.instantReplayEnabled && !isRecording && settings.wizardCompleted) {
        startReplayProcess({ clearBuffer: true });
      }
    } catch (e) {
      console.error('FFmpeg probe failed:', e);
      startDiskSpacePolling();
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('hardware-ready', getHardwareUiPayload());
      }
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

app.on('before-quit', (e) => {
  if (quittingClean) return;
  const needsStop = isRecording || rec.isActive() || replaySaveQueue.busy;
  if (!needsStop) return;
  e.preventDefault();
  quittingClean = true;
  const quitTimeout = setTimeout(() => {
    diag.warn('SYSTEM', 'Clean quit timed out after 8s — force exiting');
    app.exit(0);
  }, 8000);
  Promise.resolve()
    .then(() => (isRecording || rec.isActive() ? stopRecording() : null))
    .catch((err) => diag.warn('SYSTEM', 'Clean stop on quit failed', { err: err && err.message }))
    .finally(() => {
      clearTimeout(quitTimeout);
      app.quit();
    });
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopStatsPolling();
  stopPttWatcher();
  stopGameWatch();
  stopPowerSave();
  stopAudioDevicePolling();
  if (gameCaptureWin && !gameCaptureWin.isDestroyed()) {
    try { gameCaptureWin.webContents.send('game-capture-stop'); } catch (e) { /* ignore */ }
  }
  const killProc = (proc) => {
    if (!proc) return;
    try { proc.stdin.write('q'); } catch (e) {
      try { proc.kill(); } catch (e2) { /* ignore */ }
    }
  };
  killProc(ffmpegProcess);
  killProc(replayProcess);
  closeMedalPartialFiles();
});
