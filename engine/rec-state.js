'use strict';

const PHASES = {
  IDLE: 'idle',
  STARTING: 'starting',
  RECORDING: 'recording',
  PAUSED: 'paused',
  STOPPING: 'stopping',
  FINALIZING: 'finalizing',
  COMPLETED: 'completed',
  ERROR: 'error',
  RECOVERING: 'recovering',
  RECOVERED: 'recovered'
};

const ALLOWED = {
  idle: ['starting', 'recovering'],
  starting: ['recording', 'stopping', 'error', 'idle'],
  recording: ['paused', 'stopping', 'error'],
  paused: ['recording', 'stopping', 'error'],
  stopping: ['finalizing', 'error'],
  finalizing: ['completed', 'error'],
  completed: ['idle'],
  error: ['idle', 'recovering', 'stopping'],
  recovering: ['recovered', 'error', 'idle'],
  recovered: ['idle']
};

const ACTIVE = new Set(['starting', 'recording', 'paused', 'stopping', 'finalizing']);

function createRecState(onChange) {
  let phase = PHASES.IDLE;

  function can(next) {
    return (ALLOWED[phase] || []).includes(next);
  }

  function transition(next, meta) {
    if (phase === next) return true;
    if (!can(next)) return false;
    const prev = phase;
    phase = next;
    if (typeof onChange === 'function') onChange(prev, next, meta || {});
    return true;
  }

  function force(next, meta) {
    const prev = phase;
    phase = next;
    if (typeof onChange === 'function') onChange(prev, next, { ...(meta || {}), forced: true });
    return true;
  }

  return {
    PHASES,
    get phase() { return phase; },
    can,
    transition,
    force,
    isActive() { return ACTIVE.has(phase); },
    canStart() {
      return phase === PHASES.IDLE || phase === PHASES.COMPLETED || phase === PHASES.ERROR || phase === PHASES.RECOVERED;
    },
    canStop() {
      return phase === PHASES.RECORDING || phase === PHASES.PAUSED || phase === PHASES.STARTING;
    },
    canPause() { return phase === PHASES.RECORDING; },
    canResume() { return phase === PHASES.PAUSED; },
    isBusyStop() {
      return phase === PHASES.STOPPING || phase === PHASES.FINALIZING;
    }
  };
}

module.exports = { PHASES, ALLOWED, createRecState };
