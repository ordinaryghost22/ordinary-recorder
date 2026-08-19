'use strict';

const LEVELS = {
  INFO: 'INFO',
  WARNING: 'WARNING',
  ERROR: 'ERROR',
  CRITICAL: 'CRITICAL'
};

const CATEGORIES = [
  'CAPTURE', 'ENCODER', 'AUDIO', 'REPLAY', 'STORAGE',
  'RECOVERY', 'HOTKEY', 'GAME_PROFILE', 'SYSTEM', 'STATE'
];

function basenameSafe(value) {
  if (typeof value !== 'string') return value;
  const cleaned = value.replace(/\\/g, '/');
  const parts = cleaned.split('/');
  if (parts.length <= 2) return value;
  return parts[parts.length - 1];
}

function scrubMeta(meta) {
  if (!meta || typeof meta !== 'object') return undefined;
  const out = {};
  for (const [k, v] of Object.entries(meta)) {
    if (v == null) continue;
    if (typeof v === 'string' && /path|file|folder|dir/i.test(k)) out[k] = basenameSafe(v);
    else out[k] = v;
  }
  return out;
}

function formatLine(entry) {
  const meta = entry.meta ? `  ${JSON.stringify(entry.meta)}` : '';
  return `${entry.ts}  ${entry.level}  ${entry.category}  ${entry.message}${meta}`;
}

function createDiag({ appendLine, maxMemory = 250 } = {}) {
  const recent = [];

  function log(category, level, message, meta) {
    const cat = CATEGORIES.includes(category) ? category : 'SYSTEM';
    const lvl = LEVELS[level] || LEVELS.INFO;
    const entry = {
      ts: new Date().toISOString(),
      category: cat,
      level: lvl,
      message: String(message || ''),
      meta: scrubMeta(meta)
    };
    recent.push(entry);
    if (recent.length > maxMemory) recent.shift();
    const line = formatLine(entry);
    if (typeof appendLine === 'function') {
      try { appendLine(line); } catch (e) { console.error(line); }
    } else {
      console.log(line);
    }
    return entry;
  }

  return {
    LEVELS,
    CATEGORIES,
    log,
    info: (c, m, meta) => log(c, 'INFO', m, meta),
    warn: (c, m, meta) => log(c, 'WARNING', m, meta),
    error: (c, m, meta) => log(c, 'ERROR', m, meta),
    critical: (c, m, meta) => log(c, 'CRITICAL', m, meta),
    recent: () => recent.slice(),
    snapshot() {
      return recent.slice(-80).map(formatLine).join('\n');
    }
  };
}

module.exports = { LEVELS, CATEGORIES, createDiag, basenameSafe, scrubMeta, formatLine };
