const appRoot = document.getElementById('appRoot');
const recordBtn = document.getElementById('recordBtn');
const recordBtnLabel = document.getElementById('recordBtnLabel');
const pauseBtn = document.getElementById('pauseBtn');
const pauseBtnLabel = document.getElementById('pauseBtnLabel');
const statusDot = document.getElementById('statusDot');
const statusTitle = document.getElementById('statusTitle');
const statusLine = document.getElementById('statusLine');
const liveStats = document.getElementById('liveStats');
const timerDisplay = document.getElementById('timerDisplay');
const sizeDisplay = document.getElementById('sizeDisplay');
const fpsDisplay = document.getElementById('fpsDisplay');
const fpsSep = document.getElementById('fpsSep');
const audioDisplay = document.getElementById('audioDisplay');
const audioSep = document.getElementById('audioSep');
const spaceSaving = document.getElementById('spaceSaving');
const recordAudio = document.getElementById('recordAudio');
const pttKeySelect = document.getElementById('pttKeySelect');
const pttLive = document.getElementById('pttLive');
const pttHint = document.getElementById('pttHint');
const folderBtn = document.getElementById('folderBtn');
const folderPath = document.getElementById('folderPath');
const openFolderBtn = document.getElementById('openFolderBtn');
const instantReplayToggle = document.getElementById('instantReplayToggle');
const replaySaveSelect = document.getElementById('replaySaveSelect');
const replayBufferSelect = document.getElementById('replayBufferSelect');
const fpsSelect = document.getElementById('fpsSelect');
const gameModeToggle = document.getElementById('gameModeToggle');
const exclusiveFullscreenToggle = document.getElementById('exclusiveFullscreenToggle');
const diskSpaceSelect = document.getElementById('diskSpaceSelect');
const unstableGamesList = document.getElementById('unstableGamesList');
const unstableGamesEmpty = document.getElementById('unstableGamesEmpty');
const diskBanner = document.getElementById('diskBanner');
const diskBannerText = document.getElementById('diskBannerText');
const appNotice = document.getElementById('appNotice');
const resolutionSelect = document.getElementById('resolutionSelect');
const encoderSelect = document.getElementById('encoderSelect');
const codecSelect = document.getElementById('codecSelect');
const encoderHint = document.getElementById('encoderHint');
const codecHint = document.getElementById('codecHint');
const codecSizeHint = document.getElementById('codecSizeHint');
const spaceSavingDesc = document.getElementById('spaceSavingDesc');
const replayRamHint = document.getElementById('replayRamHint');
const audioSourceSelect = document.getElementById('audioSourceSelect');
const audioDeviceSelect = document.getElementById('audioDeviceSelect');
const audioDeviceRow = document.getElementById('audioDeviceRow');
const audioHint = document.getElementById('audioHint');
const saveReplayBtn = document.getElementById('saveReplayBtn');
const saveReplayLabel = document.getElementById('saveReplayLabel');
const replayIndicator = document.getElementById('replayIndicator');
const replayIndicatorText = document.getElementById('replayIndicatorText');
const replayNote = document.getElementById('replayNote');
const hotkeyRecord = document.getElementById('hotkeyRecord');
const hotkeyPause = document.getElementById('hotkeyPause');
const hotkeyClip = document.getElementById('hotkeyClip');
const hotkeyBookmark = document.getElementById('hotkeyBookmark');
const audioMeters = document.getElementById('audioMeters');
const gameLevelFill = document.getElementById('gameLevelFill');
const micLevelFill = document.getElementById('micLevelFill');
const audioDiag = document.getElementById('audioDiag');
const testAudioBtn = document.getElementById('testAudioBtn');
const testAudioStatus = document.getElementById('testAudioStatus');
const testAudioPlayer = document.getElementById('testAudioPlayer');
const hotkeyReset = document.getElementById('hotkeyReset');
const hotkeyNote = document.getElementById('hotkeyNote');
const recKeyHint = document.getElementById('recKeyHint');
const clipKeyHint = document.getElementById('clipKeyHint');
const drawMouse = document.getElementById('drawMouse');
const clipsList = document.getElementById('clipsList');
const keysBar = document.getElementById('keysBar');

let tickTimer = null;
let baseElapsedMs = 0;
let tickStartedAt = null;
let isPausedUi = false;
let saveFlashTimer = null;
let listeningBind = null;
let activeView = 'recorder';
let wasRecording = false;
let clipFiles = [];
let trimTarget = null;
let hardwareInfo = null;
let currentHotkeys = {
  hotkey: 'CommandOrControl+Shift+R',
  pauseHotkey: 'CommandOrControl+Shift+P',
  replayHotkey: 'CommandOrControl+Shift+I',
  bookmarkHotkey: 'CommandOrControl+Shift+B'
};

function formatElapsed(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = unit === 0 ? 0 : value < 100 ? 1 : 0;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function showAppNotice(message) {
  if (!appNotice) return;
  const text = String(message || '').trim();
  if (!text) {
    appNotice.hidden = true;
    appNotice.textContent = '';
    return;
  }
  appNotice.hidden = false;
  appNotice.textContent = text;
  if (showAppNotice._t) clearTimeout(showAppNotice._t);
  showAppNotice._t = setTimeout(() => {
    if (appNotice) {
      appNotice.hidden = true;
      appNotice.textContent = '';
    }
  }, 8000);
}

function renderDiskBanner(state) {
  if (!diskBanner) return;
  const active = Boolean(state && (state.isRecording || (state.instantReplay && state.instantReplay.active)));
  const warn = state && state.diskWarning;
  if (!active || !warn) {
    diskBanner.hidden = true;
    return;
  }
  const free = formatBytes(state.diskFreeBytes || 0);
  const limit = formatBytes(state.diskLimitBytes || 0);
  diskBanner.hidden = false;
  if (diskBannerText) {
    diskBannerText.textContent = warn === 'critical'
      ? `Only ${free} left on the output drive. Recording will stop at ${limit} free.`
      : `${free} free on the output drive. Recording will stop automatically below ${limit}.`;
  }
}

function renderUnstableGames(list) {
  if (!unstableGamesList) return;
  const games = Array.isArray(list) ? list : [];
  unstableGamesList.querySelectorAll('.fallback-item').forEach((el) => el.remove());
  if (unstableGamesEmpty) unstableGamesEmpty.hidden = games.length > 0;
  for (const game of games) {
    const row = document.createElement('div');
    row.className = 'fallback-item';
    const copy = document.createElement('div');
    copy.className = 'fallback-name';
    copy.textContent = game.title || game.exe || game.id;
    if (game.exe && game.exe !== game.title) {
      const sub = document.createElement('span');
      sub.textContent = game.exe;
      copy.appendChild(sub);
    }
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn-quiet';
    btn.textContent = 'Remove';
    btn.addEventListener('click', async () => {
      if (!window.recorder.forgetUnstableGame) return;
      const result = await window.recorder.forgetUnstableGame(game.id || game.exe);
      renderUnstableGames(result && result.knownUnstableGames);
    });
    row.appendChild(copy);
    row.appendChild(btn);
    unstableGamesList.appendChild(row);
  }
}

function formatClock(sec) {
  const s = Math.max(0, Math.floor(Number(sec) || 0));
  const mm = String(Math.floor(s / 60)).padStart(2, '0');
  const ss = String(s % 60).padStart(2, '0');
  return `${mm}:${ss}`;
}

function gbLabel(bytes) {
  if (!bytes) return '—';
  return `${(Number(bytes) / (1024 ** 3)).toFixed(1)} GB`;
}

function applyReplayRamCap(maxMinutes, estimatedRamBytes) {
  const cap = Math.min(5, Math.max(1, Number(maxMinutes) || 5));
  if (replayBufferSelect) {
    Array.from(replayBufferSelect.options).forEach((opt) => {
      const m = Number(opt.value);
      opt.disabled = m > cap;
    });
    if (Number(replayBufferSelect.value) > cap) {
      replayBufferSelect.value = String(cap);
      syncSelectUI(replayBufferSelect);
    }
    const wrap = replayBufferSelect.closest('.select-wrap');
    if (wrap) {
      wrap.querySelectorAll('.select-option').forEach((el) => {
        const m = Number(el.dataset.value);
        el.hidden = m > cap;
        el.classList.toggle('is-disabled', m > cap);
      });
    }
  }
  if (replayRamHint) {
    const ram = estimatedRamBytes != null ? ` · ~${formatBytes(estimatedRamBytes)} RAM` : '';
    replayRamHint.textContent = `How much gameplay to keep rolling${ram}. Max ${cap} min on this PC.`;
  }
}

function applyHardware(hw) {
  if (!hw) return;
  hardwareInfo = hw;
  const enc = hw.encoder || {};
  if (encoderSelect && enc.families) {
    const items = enc.families.map((f) => ({
      value: f.value,
      label: f.available === false ? `${f.label} (unavailable)` : f.label
    }));
    setSelectOptions(encoderSelect, items, enc.encoder || 'auto');
  }
  if (codecSelect && enc.codecs) {
    const items = enc.codecs.filter((c) => c.available !== false).map((c) => ({
      value: c.value,
      label: c.label
    }));
    if (!items.length) items.push({ value: 'h264', label: 'H.264' });
    const selected = items.some((i) => i.value === enc.videoCodec) ? enc.videoCodec : items[0].value;
    setSelectOptions(codecSelect, items, selected);
  }
  if (encoderHint && enc.selected) {
    encoderHint.textContent = enc.selected.reason || enc.selected.label;
  }
  if (codecSizeHint && enc.sizeEstimate) {
    const s = enc.sizeEstimate;
    const h264 = formatBytes(s.h264BytesPerMin) + '/min';
    const hevc = formatBytes(s.hevcBytesPerMin) + '/min';
    const extra = enc.codecs && enc.codecs.some((c) => c.value === 'hevc')
      ? ` H.265 ≈ ${hevc} (about ${Math.max(1, Math.round((s.hevcBytesPerMin / Math.max(1, s.h264BytesPerMin)) * 100))}% of H.264).`
      : '';
    codecSizeHint.textContent = `H.264 ≈ ${h264}.${extra} Current: ${formatBytes(s.currentBytesPerMin)}/min.`;
  }
  if (spaceSavingDesc) {
    const codec = (enc.videoCodec || 'h264');
    if (codec === 'hevc') {
      spaceSavingDesc.textContent = 'H.265 is on. Smaller Files lowers bitrate further on top of HEVC.';
    } else if (codec === 'av1') {
      spaceSavingDesc.textContent = 'AV1 is on. Smaller Files lowers bitrate further.';
    } else {
      spaceSavingDesc.textContent = 'Lower H.264 bitrate. H.265 in Settings is the real space saver when your GPU supports it.';
    }
  }
  if (enc.replay) applyReplayRamCap(enc.replay.maxMinutes, enc.replay.estimatedRamBytes);
}

function fillWizard(hw) {
  const wizard = document.getElementById('hwWizard');
  if (!wizard || !hw) return;
  const gpu = document.getElementById('wizardGpu');
  const vram = document.getElementById('wizardVram');
  const ram = document.getElementById('wizardRam');
  const cpu = document.getElementById('wizardCpu');
  const lead = document.getElementById('wizardLead');
  const tierWrap = document.getElementById('wizardTierWrap');
  const tierEl = document.getElementById('wizardTier');
  const defaultsEl = document.getElementById('wizardDefaults');
  const accept = document.getElementById('wizardAccept');
  const customize = document.getElementById('wizardCustomize');
  if (gpu) gpu.textContent = hw.gpuName || 'Unknown GPU';
  if (vram) vram.textContent = gbLabel(hw.vramBytes);
  if (ram) ram.textContent = gbLabel(hw.ramBytes);
  if (cpu) cpu.textContent = `${hw.cpuCores || '?'} threads`;
  const tierName = hw.tier === 'low' ? 'Low' : hw.tier === 'high' ? 'High' : 'Mid';
  if (tierEl) tierEl.textContent = tierName;
  const d = hw.defaults || {};
  const res = d.outputResolution === 'native' ? 'native' : `${d.outputResolution}p`;
  if (defaultsEl) {
    defaultsEl.textContent = `Defaults: ${res} · ${d.fps || 30} fps · ${d.instantReplayMinutes || 2} min replay · ${(d.videoCodec || 'h264').toUpperCase()}`;
  }
  if (lead) {
    lead.textContent = hw.encodersProbed && hw.encoder && hw.encoder.selected
      ? `Using ${hw.encoder.selected.label}. Accept the defaults for this PC, or customize.`
      : 'Detecting encoders…';
  }
  if (tierWrap) tierWrap.hidden = false;
  const encReady = Boolean(hw.encodersProbed);
  if (accept) accept.disabled = !encReady;
  if (customize) customize.disabled = !encReady;
}

function showWizard(show) {
  const wizard = document.getElementById('hwWizard');
  if (!wizard) return;
  wizard.hidden = !show;
  document.body.classList.toggle('wizard-open', Boolean(show));
}

async function maybeShowWizard(hw) {
  if (hw && hw.wizardCompleted) {
    showWizard(false);
    return;
  }
  showWizard(true);
  fillWizard(hw || {});
}

function formatClipDate(ms) {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  });
}

function stopTick() {
  if (tickTimer) {
    clearInterval(tickTimer);
    tickTimer = null;
  }
  tickStartedAt = null;
}

function currentElapsed() {
  if (isPausedUi || !tickStartedAt) return baseElapsedMs;
  return baseElapsedMs + (Date.now() - tickStartedAt);
}

function startTick() {
  stopTick();
  tickStartedAt = Date.now();
  tickTimer = setInterval(() => {
    timerDisplay.textContent = formatElapsed(currentElapsed());
  }, 500);
}

function formatSaveLabel(minutes) {
  const m = Number(minutes);
  if (m === 0.5) return 'Clip 30 Sec';
  if (m === 1) return 'Clip 1 Min';
  return `Clip ${m} Min`;
}

function setFolderPath(value) {
  document.querySelectorAll('[data-folder-path]').forEach((el) => {
    el.textContent = value || '';
  });
  if (folderPath && !folderPath.hasAttribute('data-folder-path')) {
    folderPath.textContent = value || '';
  }
}

function setHotkeyNotes(text, visible) {
  document.querySelectorAll('#hotkeyNote, .js-hotkey-note').forEach((el) => {
    el.textContent = text;
    if (el.id === 'hotkeyNote') {
      el.classList.toggle('is-active', visible ?? Boolean(listeningBind));
    }
  });
}

function showView(name) {
  activeView = name;
  document.querySelectorAll('[data-view]').forEach((el) => {
    el.hidden = el.dataset.view !== name;
  });
  document.querySelectorAll('[data-nav]').forEach((el) => {
    el.classList.toggle('active', el.dataset.nav === name);
  });
  if (name === 'clips') refreshClips();
}

function renderReplay(replay, isRecording) {
  const minutes = (replay && replay.saveMinutes) || 2;

  instantReplayToggle.checked = Boolean(replay && replay.enabled);
  instantReplayToggle.disabled = Boolean(isRecording);
  if (replaySaveSelect) {
    replaySaveSelect.disabled = Boolean(isRecording);
    if (replay && replay.saveMinutes != null) replaySaveSelect.value = String(replay.saveMinutes);
    syncSelectUI(replaySaveSelect);
  }
  if (replayBufferSelect) {
    replayBufferSelect.disabled = Boolean(isRecording);
    if (replay && replay.minutes != null) replayBufferSelect.value = String(replay.minutes);
    syncSelectUI(replayBufferSelect);
  }

  if (saveReplayBtn) saveReplayBtn.disabled = !replay || !replay.enabled;
  if (saveReplayLabel) saveReplayLabel.textContent = formatSaveLabel(minutes);

  if (replay && replay.active) {
    replayIndicator.hidden = false;
    const fillPct = replay.fillPercent != null ? replay.fillPercent : null;
    const fill = fillPct != null ? ` · ${fillPct}%` : '';
    const marks = replay.bookmarkCount ? ` · ${replay.bookmarkCount} mark${replay.bookmarkCount === 1 ? '' : 's'}` : '';
    const last = replay.lastSaveOk === false
      ? ' · last save failed'
      : (replay.lastSaveOk === true && replay.lastSaveAt
        ? ` · last save ok`
        : '');
    replayIndicatorText.textContent = `Buffer live${fill}${marks}${last}`;
  } else if (replay && replay.enabled && !replay.active) {
    replayIndicator.hidden = false;
    replayIndicatorText.textContent = 'Waiting for game…';
  } else {
    replayIndicator.hidden = true;
  }

  if (replayNote) replayNote.textContent = 'Stay in the game and press Ctrl+Shift+I to save a clip.';
  if (replay && (replay.maxMinutes || replay.estimatedRamBytes)) {
    applyReplayRamCap(replay.maxMinutes, replay.estimatedRamBytes);
  }
}

function updateFpsDisplay(state) {
  if (!fpsDisplay || !fpsSep) return;
  if (state && state.isRecording && state.captureFps != null) {
    const target = state.targetFps || 30;
    const live = Number(state.captureFps);
    fpsSep.hidden = false;
    fpsDisplay.hidden = false;
    fpsDisplay.textContent = `${live.toFixed(live >= 10 ? 0 : 1)} / ${target} fps`;
    fpsDisplay.classList.toggle('fps-low', live < target * 0.7);
  } else {
    fpsSep.hidden = true;
    fpsDisplay.hidden = true;
    fpsDisplay.textContent = '';
    fpsDisplay.classList.remove('fps-low');
  }
}

function updateAudioDisplay(state) {
  if (!audioDisplay || !audioSep) return;
  const show = Boolean(state && (state.isRecording || (state.instantReplay && state.instantReplay.active)));
  if (show) {
    audioSep.hidden = false;
    audioDisplay.hidden = false;
    if (state.audioLive) {
      audioDisplay.textContent = 'Audio';
      audioDisplay.classList.add('audio-live');
      audioDisplay.classList.remove('audio-off');
    } else if (state.hasAudio) {
      audioDisplay.textContent = 'Audio';
      audioDisplay.classList.remove('audio-live', 'audio-off');
    } else {
      audioDisplay.textContent = 'No audio';
      audioDisplay.classList.add('audio-off');
      audioDisplay.classList.remove('audio-live');
    }
  } else {
    audioSep.hidden = true;
    audioDisplay.hidden = true;
    audioDisplay.textContent = '';
    audioDisplay.classList.remove('audio-live', 'audio-off');
  }
  if (audioMeters) {
    const rec = Boolean(state && state.isRecording);
    audioMeters.hidden = !rec;
    if (rec) {
      const game = Math.max(0, Math.min(1, Number(state.loopbackPeak) || (state.audioLive ? Number(state.audioPeak) || 0 : 0)));
      const mic = Math.max(0, Math.min(1, Number(state.micPeak) || 0));
      if (gameLevelFill) gameLevelFill.style.width = `${Math.round(game * 100)}%`;
      if (micLevelFill) micLevelFill.style.width = `${Math.round(mic * 100)}%`;
    }
  }
}

function pttLabel(key) {
  if (key === 'Always') return 'Mic on';
  if (key === 'Mouse4') return 'Mouse 4';
  if (key === 'Mouse5') return 'Mouse 5';
  if (key === 'Grave') return '~';
  if (key === 'Alt') return 'Alt';
  return 'V';
}

function updatePttUi(state, settingsKey) {
  const pttOn = Boolean(state && state.pttEnabled);
  const key = pttOn
    ? ((state && state.pttKey) || settingsKey || 'V')
    : 'Always';
  if (pttHint) {
    if (key === 'Always') {
      pttHint.textContent = 'Mic on';
      if (keysBar) keysBar.hidden = true;
    } else {
      pttHint.innerHTML = `<kbd>${pttLabel(key)}</kbd> hold to talk`;
      if (keysBar) keysBar.hidden = false;
    }
    pttHint.classList.toggle('hot', Boolean(state && state.pttHeld));
  }
  if (pttLive) pttLive.hidden = !pttOn || !state || !state.pttHeld;
}

function displayHotkey(acc) {
  return String(acc || '')
    .replace(/CommandOrControl/g, 'Ctrl')
    .replace(/Command/g, 'Ctrl')
    .replace(/\+/g, '+');
}

function hotkeyToKbd(acc) {
  const parts = displayHotkey(acc).split('+').filter(Boolean);
  return parts.map((p) => `<kbd>${p}</kbd>`).join('');
}

function hotkeyButtons(bind) {
  return document.querySelectorAll(`.hotkey-btn[data-bind="${bind}"]`);
}

function setHotkeyKeys(bind, acc) {
  hotkeyButtons(bind).forEach((btn) => {
    if (listeningBind === bind) return;
    const keys = btn.querySelector('.shortcut-keys, .hotkey-keys');
    if (keys) keys.innerHTML = hotkeyToKbd(acc);
  });
}

function applyHotkeys(h) {
  if (!h) return;
  currentHotkeys = {
    hotkey: h.hotkey || currentHotkeys.hotkey,
    pauseHotkey: h.pauseHotkey || currentHotkeys.pauseHotkey,
    replayHotkey: h.replayHotkey || currentHotkeys.replayHotkey,
    bookmarkHotkey: h.bookmarkHotkey || currentHotkeys.bookmarkHotkey
  };
  setHotkeyKeys('hotkey', currentHotkeys.hotkey);
  setHotkeyKeys('pauseHotkey', currentHotkeys.pauseHotkey);
  setHotkeyKeys('replayHotkey', currentHotkeys.replayHotkey);
  setHotkeyKeys('bookmarkHotkey', currentHotkeys.bookmarkHotkey);
  if (recKeyHint) recKeyHint.innerHTML = hotkeyToKbd(currentHotkeys.hotkey);
  if (clipKeyHint) clipKeyHint.innerHTML = hotkeyToKbd(currentHotkeys.replayHotkey);
}

function eventToAccelerator(e) {
  if (e.key === 'Escape' || e.key === 'Tab' || e.key === 'Dead') return null;
  const mods = [];
  if (e.ctrlKey || e.metaKey) mods.push('CommandOrControl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');

  let key = '';
  if (/^Key[A-Z]$/.test(e.code)) key = e.code.slice(3);
  else if (/^Digit[0-9]$/.test(e.code)) key = e.code.slice(5);
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(e.code)) key = e.code;
  else if (e.code === 'Space') key = 'Space';
  else if (e.code === 'Enter') key = 'Enter';
  else if (e.code === 'Backquote') key = '`';
  else if (e.code === 'Minus') key = '-';
  else if (e.code === 'Equal') key = '=';
  else if (e.code === 'BracketLeft') key = '[';
  else if (e.code === 'BracketRight') key = ']';
  else if (e.code === 'Backslash') key = '\\';
  else if (e.code === 'Semicolon') key = ';';
  else if (e.code === 'Quote') key = "'";
  else if (e.code === 'Comma') key = ',';
  else if (e.code === 'Period') key = '.';
  else if (e.code === 'Slash') key = '/';
  else return null;

  if (!key) return null;
  if (!mods.length && !/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && key !== 'Space') {
    mods.push('CommandOrControl');
  }
  return [...mods, key].join('+');
}

async function stopListening() {
  if (!listeningBind) return;
  hotkeyButtons(listeningBind).forEach((btn) => btn.classList.remove('listening'));
  listeningBind = null;
  try { await window.recorder.setHotkeyCapture(false); } catch (e) { /* ignore */ }
  applyHotkeys(currentHotkeys);
  setHotkeyNotes('Click a shortcut, then press the new keys. Esc cancels.');
}

async function startListening(bind) {
  if (listeningBind === bind) {
    await stopListening();
    return;
  }
  if (listeningBind) await stopListening();
  listeningBind = bind;
  hotkeyButtons(bind).forEach((btn) => {
    btn.classList.add('listening');
    const keys = btn.querySelector('.shortcut-keys, .hotkey-keys');
    if (keys) keys.innerHTML = '<span class="press-hint">Press keys…</span>';
  });
  setHotkeyNotes('Press keys… Esc to cancel.');
  try { await window.recorder.setHotkeyCapture(true); } catch (e) { /* ignore */ }
}

function setStatusCopy(title, line, { warning = false } = {}) {
  if (statusTitle) statusTitle.textContent = title;
  if (!statusLine) return;
  const text = /WECODECS/i.test(String(line || ''))
    ? 'Press Ctrl+Shift+R while the game is in front.'
    : (line || '');
  statusLine.textContent = text;
  statusLine.classList.toggle('has-warning', Boolean(warning) && !/WECODECS/i.test(String(line || '')));
}

async function refreshClips() {
  if (!clipsList || !window.recorder.listRecordings) return;
  let payload = { files: [] };
  try {
    payload = await window.recorder.listRecordings();
  } catch (e) {
    payload = { files: [] };
  }
  clipFiles = (payload && payload.files) || [];
  if (!clipFiles.length) {
    clipsList.innerHTML = '<div class="clips-empty">No recordings yet. Start recording to see clips here.</div>';
    return;
  }
  clipsList.innerHTML = clipFiles.map((file, index) => `
    <div class="clip-row" role="button" tabindex="0" data-index="${index}">
      <div class="clip-name">${escapeHtml(file.name)}</div>
      <div class="clip-meta">
        <span>${formatBytes(file.size)}</span>
        <span>${formatClipDate(file.mtime)}</span>
        <button type="button" class="clip-show" data-index="${index}">Show</button>
        <button type="button" class="clip-show clip-trim-btn" data-index="${index}">Trim</button>
      </div>
    </div>
  `).join('');
}

function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function syncSelectUI(select) {
  const wrap = select && select.closest('.select-wrap');
  if (!wrap) return;
  const valueEl = wrap.querySelector('.select-value');
  const opt = select.selectedOptions[0];
  if (valueEl && opt) valueEl.textContent = opt.textContent.trim();
  wrap.classList.toggle('is-disabled', Boolean(select.disabled));
  wrap.querySelectorAll('.select-option').forEach((el) => {
    el.classList.toggle('is-selected', el.dataset.value === select.value);
  });
}

function syncAllSelects() {
  document.querySelectorAll('.select-wrap select').forEach(syncSelectUI);
}

function closeAllSelects() {
  document.querySelectorAll('.select-wrap.is-open').forEach((wrap) => {
    wrap.classList.remove('is-open');
    const trigger = wrap.querySelector('.select-trigger');
    const menu = wrap.querySelector('.select-menu');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (menu) menu.hidden = true;
  });
}

function initCustomSelects() {
  document.querySelectorAll('.select-wrap').forEach((wrap) => {
    const select = wrap.querySelector('select');
    const trigger = wrap.querySelector('.select-trigger');
    const menu = wrap.querySelector('.select-menu');
    if (!select || !trigger || !menu) return;

    trigger.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (select.disabled) return;
      const open = wrap.classList.contains('is-open');
      closeAllSelects();
      if (!open) {
        wrap.classList.add('is-open');
        trigger.setAttribute('aria-expanded', 'true');
        menu.hidden = false;
      }
    });

    menu.addEventListener('click', (e) => e.stopPropagation());

    menu.querySelectorAll('.select-option').forEach((optBtn) => {
      optBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        select.value = optBtn.dataset.value;
        select.dispatchEvent(new Event('change', { bubbles: true }));
        syncSelectUI(select);
        closeAllSelects();
      });
    });

    select.addEventListener('change', () => syncSelectUI(select));
    syncSelectUI(select);
  });

  document.addEventListener('click', () => closeAllSelects());
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeAllSelects();
  });
}

function bindSelectOptionClicks(select, menu) {
  menu.querySelectorAll('.select-option').forEach((optBtn) => {
    optBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      select.value = optBtn.dataset.value;
      select.dispatchEvent(new Event('change', { bubbles: true }));
      syncSelectUI(select);
      closeAllSelects();
    });
  });
}

function setSelectOptions(select, items, selectedValue) {
  if (!select) return;
  const wrap = select.closest('.select-wrap');
  const menu = wrap && wrap.querySelector('.select-menu');
  select.innerHTML = '';
  if (menu) menu.innerHTML = '';
  for (const item of items) {
    const opt = document.createElement('option');
    opt.value = item.value;
    opt.textContent = item.label;
    select.appendChild(opt);
    if (menu) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'select-option';
      btn.setAttribute('role', 'option');
      btn.dataset.value = item.value;
      btn.textContent = item.label;
      menu.appendChild(btn);
    }
  }
  const values = items.map((i) => i.value);
  if (selectedValue && values.includes(selectedValue)) select.value = selectedValue;
  else if (items[0]) select.value = items[0].value;
  if (menu) bindSelectOptionClicks(select, menu);
  syncSelectUI(select);
}

async function loadAudioDevices(preferred) {
  if (!audioDeviceSelect || !window.recorder.listAudioDevices) return;
  let payload = { devices: [], hint: '', preferred: null, audioSource: 'system' };
  try {
    payload = await window.recorder.listAudioDevices();
  } catch (e) {
    payload = { devices: [], hint: 'Could not list audio devices.' };
  }
  const devices = payload.devices || [];
  const items = devices.length
    ? devices.map((name) => ({ value: name, label: name }))
    : [{ value: '', label: 'No audio device found' }];
  const selected = preferred || payload.preferred || '';
  setSelectOptions(audioDeviceSelect, items, selected);
  if (audioDeviceRow) {
    audioDeviceRow.hidden = payload.showDevicePicker !== true;
  }
  if (audioHint) {
    audioHint.textContent = payload.hint || 'Game sound is captured automatically from your speakers or headphones.';
  }
  if (audioDiag) {
    const warn = Boolean(payload.warning || (payload.probe && payload.probe.warning));
    audioDiag.hidden = !warn;
    if (warn) audioDiag.textContent = payload.hint || (payload.probe && payload.probe.hint) || '';
  }
}

async function init() {
  initCustomSelects();
  const settings = await window.recorder.getSettings();
  spaceSaving.checked = settings.spaceSaving;
  recordAudio.checked = settings.recordAudio;
  if (pttKeySelect) {
    pttKeySelect.value = settings.pttEnabled ? (settings.pttKey || 'V') : 'Always';
  }
  if (drawMouse) drawMouse.checked = settings.drawMouse !== false;
  setFolderPath(settings.outputFolder);
  instantReplayToggle.checked = Boolean(settings.instantReplayEnabled);
  if (replaySaveSelect) replaySaveSelect.value = String(settings.instantReplaySaveMinutes || 2);
  if (replayBufferSelect) replayBufferSelect.value = String(settings.instantReplayMinutes || 5);
  if (fpsSelect) fpsSelect.value = String([30, 60, 144].includes(Number(settings.fps)) ? Number(settings.fps) : 30);
  if (resolutionSelect) resolutionSelect.value = settings.outputResolution || 'native';
  if (encoderSelect) encoderSelect.value = settings.encoder || 'auto';
  if (codecSelect) codecSelect.value = settings.videoCodec || 'h264';
  if (diskSpaceSelect) diskSpaceSelect.value = String(settings.diskSpaceLimitMb || 500);
  if (gameModeToggle) gameModeToggle.checked = settings.gameMode !== false;
  if (exclusiveFullscreenToggle) exclusiveFullscreenToggle.checked = Boolean(settings.exclusiveFullscreen);
  renderUnstableGames(settings.knownUnstableGames);
  if (audioSourceSelect) audioSourceSelect.value = settings.audioSource === 'mic' ? 'mic' : 'system';
  applyHotkeys(settings);
  syncAllSelects();
  await loadAudioDevices(settings.audioDevice);

  try {
    const hw = await window.recorder.getHardware();
    applyHardware(hw);
    await maybeShowWizard(hw);
  } catch (e) {
    showWizard(false);
  }

  const state = await window.recorder.getState();
  render(state);
}

function render(state) {
  const replay = state.instantReplay || {};

  if (state.isRecording) {
    statusDot.classList.toggle('recording', !state.isPaused);
    statusDot.classList.toggle('paused', Boolean(state.isPaused));
    statusDot.classList.remove('replay');
    statusLine.classList.toggle('paused', Boolean(state.isPaused));
    statusLine.classList.remove('replay');
    recordBtn.classList.add('recording');
    recordBtnLabel.textContent = 'Stop Recording';

    pauseBtn.hidden = false;
    pauseBtn.disabled = false;
    pauseBtnLabel.textContent = state.isPaused ? 'Resume' : 'Pause';
    pauseBtn.classList.toggle('paused', Boolean(state.isPaused));

    if (appRoot) {
      appRoot.classList.add('is-recording');
      appRoot.classList.toggle('is-paused', Boolean(state.isPaused));
    }

    if (state.warning) {
      setStatusCopy(state.isPaused ? 'Paused' : 'Recording', state.warning, { warning: true });
    } else if (state.diskWarning === 'low' || state.diskWarning === 'critical') {
      const free = formatBytes(state.diskFreeBytes || 0);
      setStatusCopy(
        state.isPaused ? 'Paused' : 'Recording',
        `Disk space low — ${free} free. Recording will stop before the drive fills up.`,
        { warning: true }
      );
    } else {
      const recLine = state.isPaused
        ? 'Recording paused'
        : (state.captureTarget === 'game' ? 'Recording fullscreen game' : 'Recording whole desktop');
      setStatusCopy(state.isPaused ? 'Paused' : 'Recording', recLine);
    }

    liveStats.hidden = false;
    sizeDisplay.textContent = formatBytes(state.fileSize || 0);
    updateFpsDisplay(state);
    updateAudioDisplay(state);

    baseElapsedMs = state.elapsedMs || 0;
    isPausedUi = Boolean(state.isPaused);
    timerDisplay.textContent = formatElapsed(baseElapsedMs);

    if (state.isPaused) {
      stopTick();
    } else {
      startTick();
    }
  } else {
    statusDot.classList.remove('recording', 'paused');
    statusLine.classList.remove('paused');
    recordBtn.classList.remove('recording');
    recordBtnLabel.textContent = 'Start Recording';

    pauseBtn.hidden = true;
    pauseBtn.disabled = true;
    pauseBtnLabel.textContent = 'Pause';
    pauseBtn.classList.remove('paused');

    if (appRoot) appRoot.classList.remove('is-recording', 'is-paused');

    stopTick();
    isPausedUi = false;
    baseElapsedMs = 0;
    liveStats.hidden = true;
    timerDisplay.textContent = '00:00';
    sizeDisplay.textContent = '0 B';
    updateFpsDisplay(null);
    updateAudioDisplay(state);

    if (replay.active) {
      statusDot.classList.add('replay');
      statusLine.classList.add('replay');
      setStatusCopy('Ready to record', 'Replay buffer is live. Start to record the whole desktop.');
    } else {
      statusDot.classList.remove('replay');
      statusLine.classList.remove('replay');
      setStatusCopy(
        'Ready to record',
        state.file ? 'Clip saved' : 'Ready. Start to record the whole desktop — games and any software.'
      );
    }

    if (wasRecording && activeView === 'clips') refreshClips();
    if (wasRecording) showAppNotice('Recording saved');
  }

  if (!wasRecording && state.isRecording) {
    showAppNotice('Recording started');
  }
  wasRecording = Boolean(state.isRecording);

  renderDiskBanner(state);
  renderReplay(replay, state.isRecording);
  updatePttUi(state);
  applyHotkeys({
    hotkey: state.hotkey || currentHotkeys.hotkey,
    pauseHotkey: state.pauseHotkey || currentHotkeys.pauseHotkey,
    replayHotkey: state.replayHotkey || currentHotkeys.replayHotkey,
    bookmarkHotkey: state.bookmarkHotkey || currentHotkeys.bookmarkHotkey
  });
}

recordBtn.addEventListener('click', async () => {
  const state = await window.recorder.getState();
  const result = state.isRecording ? await window.recorder.stop() : await window.recorder.start();
  if (!result.ok) {
    render(await window.recorder.getState());
    const err = result.error || 'Could not start recording.';
    setStatusCopy('Ready to record', err, { warning: true });
    return;
  }
  render(await window.recorder.getState());
});

pauseBtn.addEventListener('click', async () => {
  const state = await window.recorder.getState();
  if (!state.isRecording) return;
  const result = state.isPaused ? await window.recorder.resume() : await window.recorder.pause();
  if (!result.ok) {
    setStatusCopy(statusTitle ? statusTitle.textContent : 'Recording', result.error, { warning: true });
    statusLine.textContent = result.error;
    return;
  }
  render(await window.recorder.getState());
});

instantReplayToggle.addEventListener('change', async () => {
  const result = await window.recorder.toggleInstantReplay(instantReplayToggle.checked);
  if (!result.ok) {
    instantReplayToggle.checked = !instantReplayToggle.checked;
    setStatusCopy('Ready to record', result.error, { warning: true });
    statusLine.textContent = result.error;
    return;
  }
  render(await window.recorder.getState());
});

replaySaveSelect.addEventListener('change', async () => {
  await window.recorder.saveSettings({ instantReplaySaveMinutes: Number(replaySaveSelect.value) });
  if (saveReplayLabel) saveReplayLabel.textContent = formatSaveLabel(replaySaveSelect.value);
});

if (replayBufferSelect) {
  replayBufferSelect.addEventListener('change', async () => {
    const saved = await window.recorder.saveSettings({ instantReplayMinutes: Number(replayBufferSelect.value) });
    if (saved && saved.hardware) applyHardware(saved.hardware);
  });
}

saveReplayBtn.addEventListener('click', async () => {
  if (saveReplayBtn.disabled) return;
  const saveMinutes = Number(replaySaveSelect.value);
  saveReplayBtn.disabled = true;
  saveReplayLabel.textContent = 'Saving...';
  const result = await window.recorder.saveReplay(saveMinutes);
  if (!result.ok) {
    setStatusCopy(statusTitle ? statusTitle.textContent : 'Recorder', result.error, { warning: true });
    statusLine.textContent = result.error;
    saveReplayLabel.textContent = formatSaveLabel(saveMinutes);
    const state = await window.recorder.getState();
    renderReplay(state.instantReplay, state.isRecording);
    return;
  }

  saveReplayBtn.classList.add('saved');
  saveReplayLabel.textContent = 'Clip saved';
  showAppNotice('Clip saved');
  setStatusCopy('Ready to record', `Clip saved: ${result.file}`);
  statusLine.textContent = `Clip saved: ${result.file}`;
  if (saveFlashTimer) clearTimeout(saveFlashTimer);
  saveFlashTimer = setTimeout(async () => {
    saveReplayBtn.classList.remove('saved');
    const state = await window.recorder.getState();
    render(state);
  }, 2200);
  refreshClips();
});

spaceSaving.addEventListener('change', async () => {
  const saved = await window.recorder.saveSettings({ spaceSaving: spaceSaving.checked });
  if (saved && saved.hardware) applyHardware(saved.hardware);
});

recordAudio.addEventListener('change', () => {
  window.recorder.saveSettings({ recordAudio: recordAudio.checked });
});

if (drawMouse) {
  drawMouse.addEventListener('change', () => {
    window.recorder.saveSettings({ drawMouse: drawMouse.checked });
  });
}

if (fpsSelect) {
  fpsSelect.addEventListener('change', async () => {
    const raw = Number(fpsSelect.value);
    const fps = raw === 144 || raw === 60 ? raw : 30;
    const saved = await window.recorder.saveSettings({ fps, instantReplayFps: Math.min(30, fps) });
    syncSelectUI(fpsSelect);
    if (saved && saved.hardware) applyHardware(saved.hardware);
  });
}

if (resolutionSelect) {
  resolutionSelect.addEventListener('change', async () => {
    const saved = await window.recorder.saveSettings({ outputResolution: resolutionSelect.value });
    syncSelectUI(resolutionSelect);
    if (saved && saved.hardware) applyHardware(saved.hardware);
  });
}

if (encoderSelect) {
  encoderSelect.addEventListener('change', async () => {
    const saved = await window.recorder.saveSettings({ encoder: encoderSelect.value });
    syncSelectUI(encoderSelect);
    if (saved && saved.hardware) applyHardware(saved.hardware);
  });
}

if (codecSelect) {
  codecSelect.addEventListener('change', async () => {
    const saved = await window.recorder.saveSettings({ videoCodec: codecSelect.value });
    syncSelectUI(codecSelect);
    if (saved && saved.hardware) applyHardware(saved.hardware);
  });
}

if (gameModeToggle) {
  gameModeToggle.addEventListener('change', () => {
    window.recorder.saveSettings({ gameMode: gameModeToggle.checked });
  });
}

if (exclusiveFullscreenToggle) {
  exclusiveFullscreenToggle.addEventListener('change', () => {
    window.recorder.saveSettings({ exclusiveFullscreen: exclusiveFullscreenToggle.checked });
  });
}

if (diskSpaceSelect) {
  diskSpaceSelect.addEventListener('change', () => {
    window.recorder.saveSettings({ diskSpaceLimitMb: Number(diskSpaceSelect.value) || 500 });
    syncSelectUI(diskSpaceSelect);
  });
}

if (audioSourceSelect) {
  audioSourceSelect.addEventListener('change', async () => {
    const audioSource = audioSourceSelect.value === 'mic' ? 'mic' : 'system';
    await window.recorder.saveSettings({ audioSource });
    syncSelectUI(audioSourceSelect);
    await loadAudioDevices();
    if (audioDeviceSelect && audioDeviceSelect.value) {
      window.recorder.saveSettings({ audioDevice: audioDeviceSelect.value });
    }
  });
}

if (audioDeviceSelect) {
  audioDeviceSelect.addEventListener('change', () => {
    if (!audioDeviceSelect.value) return;
    window.recorder.saveSettings({ audioDevice: audioDeviceSelect.value });
    syncSelectUI(audioDeviceSelect);
  });
}

if (pttKeySelect) {
  pttKeySelect.addEventListener('change', () => {
    const always = pttKeySelect.value === 'Always';
    const payload = { pttEnabled: !always };
    if (!always) payload.pttKey = pttKeySelect.value;
    window.recorder.saveSettings(payload);
    syncSelectUI(pttKeySelect);
    updatePttUi({
      pttEnabled: !always,
      pttKey: always ? 'Always' : pttKeySelect.value,
      pttHeld: false
    }, pttKeySelect.value);
  });
}

async function chooseFolder() {
  const folder = await window.recorder.chooseFolder();
  setFolderPath(folder);
  if (activeView === 'clips') refreshClips();
}

if (folderBtn) folderBtn.addEventListener('click', chooseFolder);
document.querySelectorAll('.js-folder-btn').forEach((btn) => {
  btn.addEventListener('click', chooseFolder);
});

if (testAudioBtn) {
  testAudioBtn.addEventListener('click', async () => {
    testAudioBtn.disabled = true;
    if (testAudioStatus) testAudioStatus.textContent = 'Recording 3 seconds… play something.';
    if (testAudioPlayer) {
      testAudioPlayer.hidden = true;
      testAudioPlayer.removeAttribute('src');
    }
    try {
      const result = await window.recorder.testAudio();
      if (!result || !result.ok) {
        if (testAudioStatus) testAudioStatus.textContent = (result && result.error) || 'Audio test failed.';
        if (audioDiag && result && result.hint) {
          audioDiag.hidden = false;
          audioDiag.textContent = result.hint;
        }
        return;
      }
      if (testAudioStatus) testAudioStatus.textContent = result.hint || 'Playing back the test clip.';
      if (testAudioPlayer && result.url) {
        testAudioPlayer.hidden = false;
        testAudioPlayer.src = result.url;
        try { await testAudioPlayer.play(); } catch (e) { /* user gesture already happened */ }
      }
    } finally {
      testAudioBtn.disabled = false;
    }
  });
}

if (openFolderBtn) openFolderBtn.addEventListener('click', () => window.recorder.openFolder());
document.querySelectorAll('.js-open-folder').forEach((btn) => {
  btn.addEventListener('click', () => window.recorder.openFolder());
});

document.querySelectorAll('.hotkey-btn[data-bind]').forEach((btn) => {
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    startListening(btn.dataset.bind);
  });
});

async function resetHotkeys() {
  await stopListening();
  const saved = await window.recorder.saveSettings({
    hotkey: 'CommandOrControl+Shift+R',
    pauseHotkey: 'CommandOrControl+Shift+P',
    replayHotkey: 'CommandOrControl+Shift+I',
    bookmarkHotkey: 'CommandOrControl+Shift+B'
  });
  applyHotkeys(saved);
  setHotkeyNotes('Hotkeys reset to Ctrl+Shift+R / P / I / B.', true);
}

if (hotkeyReset) hotkeyReset.addEventListener('click', resetHotkeys);
document.querySelectorAll('.js-hotkey-reset').forEach((btn) => {
  btn.addEventListener('click', resetHotkeys);
});

document.querySelectorAll('[data-nav]').forEach((btn) => {
  btn.addEventListener('click', () => showView(btn.dataset.nav));
});

if (clipsList) {
  clipsList.addEventListener('click', async (e) => {
    const showBtn = e.target.closest('.clip-show');
    if (showBtn && showBtn.classList.contains('clip-trim-btn')) {
      e.stopPropagation();
      const file = clipFiles[Number(showBtn.dataset.index)];
      if (file) openTrimPanel(file);
      return;
    }
    if (showBtn) {
      e.stopPropagation();
      const file = clipFiles[Number(showBtn.dataset.index)];
      if (file) await window.recorder.showRecording(file.path);
      return;
    }
    const row = e.target.closest('.clip-row');
    const file = row && clipFiles[Number(row.dataset.index)];
    if (file) await window.recorder.openRecording(file.path);
  });
  clipsList.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('.clip-row');
    const file = row && clipFiles[Number(row.dataset.index)];
    if (!file) return;
    e.preventDefault();
    window.recorder.openRecording(file.path);
  });
}

window.addEventListener('keydown', async (e) => {
  if (!listeningBind) return;
  e.preventDefault();
  e.stopPropagation();
  if (e.key === 'Escape') {
    await stopListening();
    return;
  }
  if (e.repeat || e.key === 'Control' || e.key === 'Shift' || e.key === 'Alt' || e.key === 'Meta') return;
  const acc = eventToAccelerator(e);
  if (!acc) return;
  const bind = listeningBind;
  const payload = { [bind]: acc };
  const saved = await window.recorder.saveSettings(payload);
  await stopListening();
  applyHotkeys(saved);
  if (saved && saved.hotkeyError) {
    setStatusCopy('Hotkeys', saved.hotkeyError, { warning: true });
    statusLine.textContent = saved.hotkeyError;
    setHotkeyNotes(saved.hotkeyError, true);
  } else {
    setHotkeyNotes(`Saved: ${displayHotkey(acc)}`, true);
  }
}, true);

window.addEventListener('blur', () => {
  if (listeningBind) stopListening();
});

window.recorder.onStateChange((state) => {
  // Cap UI re-renders to 2x/sec while recording (meters/stats)
  if (state && state.isRecording) {
    const now = Date.now();
    if (window._recUiAt && now - window._recUiAt < 500) {
      window._recUiPending = state;
      if (!window._recUiTimer) {
        window._recUiTimer = setTimeout(() => {
          window._recUiTimer = null;
          window._recUiAt = Date.now();
          const s = window._recUiPending;
          window._recUiPending = null;
          if (s) render(s);
        }, 500);
      }
      return;
    }
    window._recUiAt = now;
  }
  render(state);
});
if (window.recorder.onNotice) {
  window.recorder.onNotice((payload) => {
    const msg = payload && payload.message ? payload.message : payload;
    showAppNotice(msg);
    if (String(msg || '').toLowerCase().includes('recovered')) refreshClips();
  });
}
if (window.recorder.onHardwareReady) {
  window.recorder.onHardwareReady((hw) => {
    applyHardware(hw);
    maybeShowWizard(hw);
  });
}

const wizardAccept = document.getElementById('wizardAccept');
const wizardCustomize = document.getElementById('wizardCustomize');
if (wizardAccept) {
  wizardAccept.addEventListener('click', async () => {
    wizardAccept.disabled = true;
    const result = await window.recorder.completeWizard({ customize: false });
    if (result && result.hardware) applyHardware(result.hardware);
    if (result && result.settings) {
      if (fpsSelect) fpsSelect.value = String(result.settings.fps || 30);
      if (resolutionSelect) resolutionSelect.value = result.settings.outputResolution || 'native';
      if (codecSelect) codecSelect.value = result.settings.videoCodec || 'h264';
      if (replayBufferSelect) replayBufferSelect.value = String(result.settings.instantReplayMinutes || 3);
      if (spaceSaving) spaceSaving.checked = result.settings.spaceSaving !== false;
      syncAllSelects();
    }
    showWizard(false);
    render(await window.recorder.getState());
  });
}
if (wizardCustomize) {
  wizardCustomize.addEventListener('click', async () => {
    wizardCustomize.disabled = true;
    const result = await window.recorder.completeWizard({ customize: true, settings: {} });
    if (result && result.hardware) applyHardware(result.hardware);
    showWizard(false);
    showView('settings');
  });
}

const trimPanel = document.getElementById('trimPanel');
const trimVideo = document.getElementById('trimVideo');
const trimStart = document.getElementById('trimStart');
const trimEnd = document.getElementById('trimEnd');
const trimStartLabel = document.getElementById('trimStartLabel');
const trimEndLabel = document.getElementById('trimEndLabel');
const trimFileName = document.getElementById('trimFileName');
const trimExport = document.getElementById('trimExport');
const trimCancel = document.getElementById('trimCancel');
const trimPrecise = document.getElementById('trimPrecise');

function syncTrimLabels() {
  if (!trimStart || !trimEnd) return;
  let a = Number(trimStart.value);
  let b = Number(trimEnd.value);
  if (a > b) {
    const t = a; a = b; b = t;
    trimStart.value = String(a);
    trimEnd.value = String(b);
  }
  if (trimStartLabel) trimStartLabel.textContent = formatClock(a);
  if (trimEndLabel) trimEndLabel.textContent = formatClock(b);
}

async function openTrimPanel(file) {
  if (!trimPanel || !window.recorder.probeRecording) return;
  trimTarget = file;
  trimPanel.hidden = false;
  if (trimFileName) trimFileName.textContent = `Loading ${file.name}…`;
  const probed = await window.recorder.probeRecording(file.path);
  if (!probed || !probed.ok) {
    if (trimFileName) trimFileName.textContent = (probed && probed.error) || 'Could not open that clip.';
    return;
  }
  trimTarget = { ...file, duration: probed.duration, url: probed.url };
  const dur = Math.max(1, Number(probed.duration) || 1);
  if (trimStart) { trimStart.min = '0'; trimStart.max = String(dur); trimStart.value = '0'; }
  if (trimEnd) { trimEnd.min = '0'; trimEnd.max = String(dur); trimEnd.value = String(dur); }
  if (trimFileName) trimFileName.textContent = probed.name;
  if (trimVideo) {
    trimVideo.src = probed.url;
    trimVideo.load();
  }
  syncTrimLabels();
}

if (trimStart) trimStart.addEventListener('input', () => {
  syncTrimLabels();
  if (trimVideo) trimVideo.currentTime = Number(trimStart.value) || 0;
});
if (trimEnd) trimEnd.addEventListener('input', () => {
  syncTrimLabels();
  if (trimVideo) trimVideo.currentTime = Number(trimEnd.value) || 0;
});
if (trimCancel) {
  trimCancel.addEventListener('click', () => {
    trimPanel.hidden = true;
    if (trimVideo) trimVideo.removeAttribute('src');
    trimTarget = null;
  });
}
if (trimExport) {
  trimExport.addEventListener('click', async () => {
    if (!trimTarget) return;
    trimExport.disabled = true;
    trimExport.textContent = 'Exporting…';
    const startSec = Math.min(Number(trimStart.value), Number(trimEnd.value));
    const endSec = Math.max(Number(trimStart.value), Number(trimEnd.value));
    const result = await window.recorder.trimRecording({
      filePath: trimTarget.path,
      startSec,
      endSec,
      precise: Boolean(trimPrecise && trimPrecise.checked)
    });
    trimExport.disabled = false;
    trimExport.textContent = 'Export Trimmed Clip';
    if (!result || !result.ok) {
      if (trimFileName) trimFileName.textContent = (result && result.error) || 'Trim failed.';
      return;
    }
    if (trimFileName) trimFileName.textContent = `Saved ${result.name}`;
    refreshClips();
  });
}

init();
