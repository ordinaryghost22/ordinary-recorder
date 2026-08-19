'use strict';

function parseDurationSeconds(text) {
  const m = String(text || '').match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!m) return 0;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

function parseFps(text) {
  const m = String(text || '').match(/,\s*([\d.]+)\s*fps/i);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : 0;
}

function parseVideoSize(text) {
  const m = String(text || '').match(/Video:.*?(\d{2,5})x(\d{2,5})/);
  if (!m) return { width: 0, height: 0 };
  return { width: Number(m[1]) || 0, height: Number(m[2]) || 0 };
}

function hasVideoStream(text) {
  return /Stream #0:\d+.*Video:/i.test(String(text || '')) || /Video:\s*[a-z0-9]/i.test(String(text || ''));
}

function hasAudioStream(text) {
  return /Stream #0:\d+.*Audio:/i.test(String(text || '')) || /Audio:\s*[a-z0-9]/i.test(String(text || ''));
}

function verifyOutputBasics({ exists, size, minBytes = 8192 }) {
  if (!exists) return { ok: false, reason: 'missing' };
  if (!(Number(size) >= minBytes)) return { ok: false, reason: 'empty', size: Number(size) || 0 };
  return { ok: true, size: Number(size) };
}

function verifyFromFfmpegProbe(text, { wantAudio = false, minDuration = 0.15, maxDurationHours = 12 } = {}) {
  const duration = parseDurationSeconds(text);
  const fps = parseFps(text);
  const dim = parseVideoSize(text);
  const video = hasVideoStream(text);
  const audio = hasAudioStream(text);

  if (!video) return { ok: false, reason: 'no-video', duration, fps, ...dim, audio };
  if (duration > 0 && duration < minDuration) return { ok: false, reason: 'too-short', duration, fps, ...dim, audio };
  if (duration > maxDurationHours * 3600) return { ok: false, reason: 'bad-duration', duration, fps, ...dim, audio };
  if (wantAudio && !audio) return { ok: false, reason: 'no-audio', duration, fps, ...dim, audio };
  if (fps && (fps < 1 || fps > 240)) return { ok: false, reason: 'bad-fps', duration, fps, ...dim, audio };
  return { ok: true, duration, fps, ...dim, video: true, audio };
}

function durationsSane(videoSec, audioSec, slop = 1.5) {
  const v = Number(videoSec) || 0;
  const a = Number(audioSec) || 0;
  if (v <= 0) return false;
  if (a <= 0) return true;
  return Math.abs(v - a) <= Math.max(slop, v * 0.08);
}

module.exports = {
  parseDurationSeconds,
  parseFps,
  parseVideoSize,
  hasVideoStream,
  hasAudioStream,
  verifyOutputBasics,
  verifyFromFfmpegProbe,
  durationsSane
};
