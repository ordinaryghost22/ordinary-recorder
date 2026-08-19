'use strict';

function createDebouncer(ms) {
  let last = 0;
  return function allow() {
    const now = Date.now();
    if (now - last < ms) return false;
    last = now;
    return true;
  };
}

function createJobQueue() {
  let chain = Promise.resolve();
  let pending = 0;
  return {
    get pending() { return pending; },
    get busy() { return pending > 0; },
    enqueue(fn) {
      pending += 1;
      const run = chain.then(
        () => fn(),
        () => fn()
      );
      chain = run.then(() => undefined, () => undefined);
      return run.finally(() => { pending = Math.max(0, pending - 1); });
    }
  };
}

function shouldRetestUnstableGame(game, now = Date.now(), retestAfterMs = 7 * 24 * 60 * 60 * 1000) {
  if (!game) return false;
  const last = Number(game.lastOkAt || game.lastTriedAt || game.addedAt) || 0;
  if (!last) return true;
  return (now - last) >= retestAfterMs;
}

function siblingOutputExists(hasSiblingMp4) {
  return Boolean(hasSiblingMp4);
}

function canRecoverCandidate({ size, hasSiblingMp4, minBytes = 8192 }) {
  if (hasSiblingMp4) return false;
  return Number(size) >= minBytes;
}

function sortReplayParts(names) {
  return names.slice().sort((a, b) => {
    const na = Number(String(a).match(/(\d+)/) && String(a).match(/(\d+)/)[1]);
    const nb = Number(String(b).match(/(\d+)/) && String(b).match(/(\d+)/)[1]);
    if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
    return String(a).localeCompare(String(b));
  });
}

module.exports = {
  createDebouncer,
  createJobQueue,
  shouldRetestUnstableGame,
  siblingOutputExists,
  canRecoverCandidate,
  sortReplayParts
};
