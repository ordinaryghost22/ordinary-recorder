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
const audioSourceSelect = document.getElementById('audioSourceSelect');
const audioDeviceSelect = document.getElementById('audioDeviceSelect');
const audioHint = document.getElementById('audioHint');
const saveReplayBtn = document.getElementById('saveReplayBtn');
const saveReplayLabel = document.getElementById('saveReplayLabel');
const replayIndicator = document.getElementById('replayIndicator');
const replayIndicatorText = document.getElementById('replayIndicatorText');
const replayNote = document.getElementById('replayNote');
const hotkeyRecord = document.getElementById('hotkeyRecord');
const hotkeyPause = document.getElementById('hotkeyPause');
const hotkeyClip = document.getElementById('hotkeyClip');
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
let currentHotkeys = {
  hotkey: 'CommandOrControl+Shift+R',
  pauseHotkey: 'CommandOrControl+Shift+P',
  replayHotkey: 'CommandOrControl+Shift+I'
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
  }, 250);
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
    const filled = replay.bufferSeconds
      ? ` · ~${Math.min(replay.bufferSeconds, (replay.minutes || 5) * 60)}s buffered`
      : '';
    replayIndicatorText.textContent = `Buffer live${filled}`;
  } else if (replay && replay.enabled && !replay.active) {
    replayIndicator.hidden = false;
    replayIndicatorText.textContent = 'Waiting for game…';
  } else {
    replayIndicator.hidden = true;
  }

  if (replayNote) replayNote.textContent = 'Stay in the game and press Ctrl+Shift+I to save a clip.';
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
  if (state && (state.isRecording || (state.instantReplay && state.instantReplay.active))) {
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
    replayHotkey: h.replayHotkey || currentHotkeys.replayHotkey
  };
  setHotkeyKeys('hotkey', currentHotkeys.hotkey);
  setHotkeyKeys('pauseHotkey', currentHotkeys.pauseHotkey);
  setHotkeyKeys('replayHotkey', currentHotkeys.replayHotkey);
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
  if (audioHint) {
    audioHint.textContent = payload.hint || 'If game sound is missing, install VB-Audio Cable or enable Stereo Mix.';
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
  if (fpsSelect) fpsSelect.value = String(Number(settings.fps) === 60 ? 60 : 30);
  if (gameModeToggle) gameModeToggle.checked = settings.gameMode !== false;
  if (exclusiveFullscreenToggle) exclusiveFullscreenToggle.checked = Boolean(settings.exclusiveFullscreen);
  if (audioSourceSelect) audioSourceSelect.value = settings.audioSource === 'mic' ? 'mic' : 'system';
  applyHotkeys(settings);
  syncAllSelects();
  await loadAudioDevices(settings.audioDevice);

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
    } else {
      setStatusCopy(state.isPaused ? 'Paused' : 'Recording', state.isPaused ? 'Recording paused' : '');
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
      setStatusCopy('Ready to record', 'Replay buffer is live. Press the button to start.');
    } else {
      statusDot.classList.remove('replay');
      statusLine.classList.remove('replay');
      setStatusCopy(
        'Ready to record',
        state.file ? 'Clip saved' : 'Everything is set. Press the button to start.'
      );
    }

    if (wasRecording && activeView === 'clips') refreshClips();
  }
  wasRecording = Boolean(state.isRecording);

  renderReplay(replay, state.isRecording);
  updatePttUi(state);
  applyHotkeys({
    hotkey: state.hotkey || currentHotkeys.hotkey,
    pauseHotkey: state.pauseHotkey || currentHotkeys.pauseHotkey,
    replayHotkey: state.replayHotkey || currentHotkeys.replayHotkey
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
    await window.recorder.saveSettings({ instantReplayMinutes: Number(replayBufferSelect.value) });
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

spaceSaving.addEventListener('change', () => {
  window.recorder.saveSettings({ spaceSaving: spaceSaving.checked });
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
  fpsSelect.addEventListener('change', () => {
    const fps = Number(fpsSelect.value) === 60 ? 60 : 30;
    window.recorder.saveSettings({ fps, instantReplayFps: Math.min(30, fps) });
    syncSelectUI(fpsSelect);
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
    replayHotkey: 'CommandOrControl+Shift+I'
  });
  applyHotkeys(saved);
  setHotkeyNotes('Hotkeys reset to Ctrl+Shift+R / P / I.', true);
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

window.recorder.onStateChange((state) => render(state));

init();
