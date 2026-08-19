'use strict';

const assert = require('assert');
const { createRecState, PHASES, ALLOWED } = require('../engine/rec-state');
const { createDiag, basenameSafe } = require('../engine/diag');
const { friendlyError, userFacing } = require('../engine/errors');
const {
  parseDurationSeconds,
  verifyOutputBasics,
  verifyFromFfmpegProbe,
  durationsSane
} = require('../engine/verify');
const {
  createDebouncer,
  createJobQueue,
  shouldRetestUnstableGame,
  canRecoverCandidate,
  sortReplayParts
} = require('../engine/guards');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      return result.then(
        () => { passed++; console.log('ok', name); },
        (e) => { failed++; console.error('FAIL', name, e.message || e); }
      );
    }
    passed++;
    console.log('ok', name);
  } catch (e) {
    failed++;
    console.error('FAIL', name, e.message || e);
  }
}

// ---- State Machine ----

test('state machine starts idle and blocks double start', () => {
  const rec = createRecState();
  assert.strictEqual(rec.phase, PHASES.IDLE);
  assert.ok(rec.canStart());
  assert.ok(rec.transition('starting'));
  assert.ok(!rec.canStart());
  assert.ok(rec.transition('starting')); // same-phase is a no-op
  assert.ok(rec.transition('recording'));
  assert.ok(!rec.transition('starting'));
});

test('stop cannot run twice; pause/resume are exclusive', () => {
  const rec = createRecState();
  rec.transition('starting');
  rec.transition('recording');
  assert.ok(rec.canPause());
  rec.transition('paused');
  assert.ok(!rec.canPause());
  assert.ok(rec.canResume());
  rec.transition('recording');
  assert.ok(rec.canStop());
  rec.transition('stopping');
  assert.ok(rec.isBusyStop());
  assert.ok(!rec.canStop());
  rec.transition('finalizing');
  rec.transition('completed');
  rec.transition('idle');
  assert.ok(rec.canStart());
});

test('error cannot skip to recording without recovery/idle', () => {
  const rec = createRecState();
  rec.transition('starting');
  rec.transition('error');
  assert.ok(!rec.transition('recording'));
  assert.ok(rec.transition('idle'));
});

test('allowed map has no contradictory self-start from recording', () => {
  assert.ok(!ALLOWED.recording.includes('starting'));
  assert.ok(!ALLOWED.stopping.includes('recording'));
  assert.ok(!ALLOWED.finalizing.includes('recording'));
});

test('force bypasses transition validation', () => {
  const rec = createRecState();
  assert.ok(rec.force('recording'));
  assert.strictEqual(rec.phase, 'recording');
  assert.ok(rec.force('idle'));
});

test('repeated start/stop cycle returns to idle correctly', () => {
  const rec = createRecState();
  for (let i = 0; i < 5; i++) {
    assert.ok(rec.canStart());
    rec.transition('starting');
    rec.transition('recording');
    rec.transition('stopping');
    rec.transition('finalizing');
    rec.transition('completed');
    rec.transition('idle');
  }
  assert.strictEqual(rec.phase, 'idle');
});

test('recovery flow from error state', () => {
  const rec = createRecState();
  rec.transition('starting');
  rec.transition('error');
  assert.ok(rec.canStart()); // error allows starting fresh
  assert.ok(rec.transition('recovering'));
  assert.ok(rec.transition('recovered'));
  assert.ok(rec.transition('idle'));
  assert.ok(rec.canStart());
});

test('error from recovering goes to error then idle', () => {
  const rec = createRecState();
  rec.force('recovering');
  assert.ok(rec.transition('error'));
  assert.ok(rec.transition('idle'));
});

test('isActive returns true during busy phases only', () => {
  const rec = createRecState();
  assert.ok(!rec.isActive());
  rec.transition('starting');
  assert.ok(rec.isActive());
  rec.transition('recording');
  assert.ok(rec.isActive());
  rec.transition('stopping');
  assert.ok(rec.isActive());
  rec.transition('finalizing');
  assert.ok(rec.isActive());
  rec.transition('completed');
  assert.ok(!rec.isActive());
});

test('onChange callback fires on every transition', () => {
  const log = [];
  const rec = createRecState((from, to, meta) => log.push({ from, to, meta }));
  rec.transition('starting');
  rec.transition('recording');
  rec.transition('stopping');
  assert.strictEqual(log.length, 3);
  assert.strictEqual(log[0].from, 'idle');
  assert.strictEqual(log[0].to, 'starting');
  assert.strictEqual(log[2].to, 'stopping');
});

test('cannot pause from stopping/finalizing/error states', () => {
  const rec = createRecState();
  rec.transition('starting');
  rec.transition('recording');
  rec.transition('stopping');
  assert.ok(!rec.canPause());
  rec.transition('error');
  assert.ok(!rec.canPause());
});

// ---- Error Messages ----

test('friendly encoder errors are not ffmpeg exit codes', () => {
  const f = friendlyError('ffmpeg exited with code 1: AMF CreateComponent failed', 'ENCODER');
  assert.ok(!/exited with code/i.test(f.message));
  assert.match(f.message, /hardware encoder/i);
  const u = userFacing('FFmpeg not found. Put ffmpeg.exe in ffmpeg/');
  assert.match(u, /FFmpeg/i);
});

test('ddagrab failure gives capture error', () => {
  const f = friendlyError('ddagrab: AcquireNextFrame failed 887a0026');
  assert.strictEqual(f.category, 'CAPTURE');
  assert.match(f.title, /display/i);
});

test('disk space error gives storage category', () => {
  const f = friendlyError('Disk space low ENOSPC');
  assert.strictEqual(f.category, 'STORAGE');
});

test('replay buffer empty gives replay category', () => {
  const f = friendlyError('Replay buffer is empty');
  assert.strictEqual(f.category, 'REPLAY');
});

test('recovery error preserves source files', () => {
  const f = friendlyError('Could not recover: mux failed', 'RECOVERY');
  assert.strictEqual(f.category, 'RECOVERY');
  assert.match(f.hint, /left on disk/i);
});

test('audio failure error is non-fatal', () => {
  const f = friendlyError('WASAPI loopback failed error');
  assert.strictEqual(f.category, 'AUDIO');
  assert.match(f.message, /continue/i);
});

test('already recording gives clear message', () => {
  const f = friendlyError('already recording');
  assert.match(f.title, /already/i);
});

test('unknown error gives generic but helpful message', () => {
  const f = friendlyError('something completely unexpected happened');
  assert.ok(f.title);
  assert.ok(f.message);
  assert.ok(f.detail);
});

// ---- Verification ----

test('verify rejects missing/empty and no-video probes', () => {
  assert.strictEqual(verifyOutputBasics({ exists: false, size: 0 }).ok, false);
  assert.strictEqual(verifyOutputBasics({ exists: true, size: 100 }).ok, false);
  assert.ok(verifyOutputBasics({ exists: true, size: 90000 }).ok);
  const probe = [
    'Duration: 00:00:12.40, start: 0.000000, bitrate: 8000 kb/s',
    'Stream #0:0: Video: h264 (High), yuv420p, 1920x1080, 60 fps',
    'Stream #0:1: Audio: aac, 48000 Hz, stereo'
  ].join('\n');
  const v = verifyFromFfmpegProbe(probe, { wantAudio: true });
  assert.ok(v.ok);
  assert.strictEqual(v.width, 1920);
  assert.ok(verifyFromFfmpegProbe('Duration: 00:00:01.00', { wantAudio: false }).ok === false);
});

test('verify rejects bad fps and insane duration', () => {
  const badFps = 'Duration: 00:00:05.00\nStream #0:0: Video: h264, 320x240, 0.5 fps';
  assert.strictEqual(verifyFromFfmpegProbe(badFps).ok, false);

  const insane = 'Duration: 999:00:00.00\nStream #0:0: Video: h264, 320x240, 30 fps';
  assert.strictEqual(verifyFromFfmpegProbe(insane).ok, false);
});

test('verify accepts audio-only missing when not requested', () => {
  const noAudio = 'Duration: 00:00:10.00\nStream #0:0: Video: h264, 1920x1080, 60 fps';
  assert.ok(verifyFromFfmpegProbe(noAudio, { wantAudio: false }).ok);
  assert.strictEqual(verifyFromFfmpegProbe(noAudio, { wantAudio: true }).ok, false);
});

test('duration parser and a/v sanity', () => {
  assert.ok(Math.abs(parseDurationSeconds('Duration: 01:02:03.50') - 3723.5) < 0.01);
  assert.ok(durationsSane(60, 60.4));
  assert.ok(!durationsSane(60, 90));
  assert.ok(durationsSane(10, 0)); // no audio is fine
  assert.ok(!durationsSane(0, 10)); // no video is not
});

// ---- Diagnostics ----

test('diag scrubs long paths and keeps categories', () => {
  const lines = [];
  const d = createDiag({ appendLine: (l) => lines.push(l) });
  d.error('CAPTURE', 'lost display', { file: 'C:\\\\Users\\\\PC\\\\Videos\\\\recording.mkv', fps: 0 });
  assert.ok(lines[0].includes('ERROR'));
  assert.ok(lines[0].includes('CAPTURE'));
  assert.ok(!lines[0].includes('Users\\\\PC'));
  assert.strictEqual(basenameSafe('C:/Users/PC/Videos/file.mkv'), 'file.mkv');
});

test('diag severity levels are preserved', () => {
  const lines = [];
  const d = createDiag({ appendLine: (l) => lines.push(l) });
  d.info('SYSTEM', 'started');
  d.warn('AUDIO', 'device missing');
  d.error('ENCODER', 'failed');
  d.critical('CAPTURE', 'dead');
  assert.ok(lines[0].includes('INFO'));
  assert.ok(lines[1].includes('WARNING'));
  assert.ok(lines[2].includes('ERROR'));
  assert.ok(lines[3].includes('CRITICAL'));
});

test('diag caps memory buffer at maxMemory', () => {
  const d = createDiag({ maxMemory: 5 });
  for (let i = 0; i < 10; i++) d.info('SYSTEM', `msg-${i}`);
  assert.strictEqual(d.recent().length, 5);
  assert.match(d.recent()[0].message, /msg-5/);
});

test('diag unknown category defaults to SYSTEM', () => {
  const lines = [];
  const d = createDiag({ appendLine: (l) => lines.push(l) });
  d.info('UNKNOWN_CAT', 'test');
  assert.ok(lines[0].includes('SYSTEM'));
});

test('diag snapshot returns formatted log', () => {
  const d = createDiag({});
  d.info('CAPTURE', 'frame received');
  const snap = d.snapshot();
  assert.ok(snap.includes('CAPTURE'));
  assert.ok(snap.includes('frame received'));
});

// ---- Guards ----

test('debouncer drops repeated hotkey fires', () => {
  const allow = createDebouncer(1000);
  assert.strictEqual(allow(), true);
  assert.strictEqual(allow(), false);
});

test('job queue serializes concurrent replay saves', async () => {
  const q = createJobQueue();
  const order = [];
  const a = q.enqueue(async () => {
    await new Promise((r) => setTimeout(r, 30));
    order.push('a');
    return 'A';
  });
  const b = q.enqueue(async () => {
    order.push('b');
    return 'B';
  });
  const ra = await a;
  const rb = await b;
  assert.deepStrictEqual(order, ['a', 'b']);
  assert.strictEqual(ra, 'A');
  assert.strictEqual(rb, 'B');
});

test('job queue reports pending count correctly', async () => {
  const q = createJobQueue();
  assert.strictEqual(q.pending, 0);
  assert.strictEqual(q.busy, false);
  const p = q.enqueue(async () => {
    assert.strictEqual(q.pending, 1);
    assert.strictEqual(q.busy, true);
  });
  await p;
  assert.strictEqual(q.pending, 0);
});

test('job queue continues after a failed job', async () => {
  const q = createJobQueue();
  let caught = false;
  try {
    await q.enqueue(async () => { throw new Error('boom'); });
  } catch (e) {
    caught = true;
  }
  assert.ok(caught);
  const result = await q.enqueue(async () => 'ok');
  assert.strictEqual(result, 'ok');
});

test('recovery candidate is skipped when sibling mp4 exists', () => {
  assert.strictEqual(canRecoverCandidate({ size: 99999, hasSiblingMp4: true }), false);
  assert.strictEqual(canRecoverCandidate({ size: 100, hasSiblingMp4: false }), false);
  assert.strictEqual(canRecoverCandidate({ size: 99999, hasSiblingMp4: false }), true);
});

test('recovery candidate respects custom minBytes', () => {
  assert.strictEqual(canRecoverCandidate({ size: 5000, hasSiblingMp4: false, minBytes: 4096 }), true);
  assert.strictEqual(canRecoverCandidate({ size: 5000, hasSiblingMp4: false, minBytes: 10000 }), false);
});

test('unstable game retest after cooldown, not immediately', () => {
  const now = 1_000_000;
  assert.strictEqual(shouldRetestUnstableGame({ addedAt: now - 1000 }, now, 7 * 86400000), false);
  assert.strictEqual(shouldRetestUnstableGame({ addedAt: now - 8 * 86400000 }, now, 7 * 86400000), true);
});

test('unstable game retest returns true when no timestamp', () => {
  assert.strictEqual(shouldRetestUnstableGame({}, Date.now()), true);
});

test('unstable game retest returns false for null game', () => {
  assert.strictEqual(shouldRetestUnstableGame(null), false);
});

test('replay parts sort by segment index not lexicographic wrap', () => {
  assert.deepStrictEqual(
    sortReplayParts(['buffer_010.mkv', 'buffer_002.mkv', 'buffer_001.mkv']),
    ['buffer_001.mkv', 'buffer_002.mkv', 'buffer_010.mkv']
  );
});

test('replay parts sort handles non-numeric names gracefully', () => {
  const sorted = sortReplayParts(['z.mkv', 'a.mkv', 'buffer_003.mkv']);
  assert.strictEqual(sorted.length, 3);
  assert.strictEqual(sorted[0], 'a.mkv');
});

// ---- Run async tests ----
Promise.resolve().then(() => {
  console.log(`\n${passed} passed, ${failed} failed.`);
  if (failed > 0) {
    console.error('SOME TESTS FAILED');
    process.exit(1);
  } else {
    console.log('All reliability tests passed.');
  }
});
