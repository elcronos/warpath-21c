// js/util/events.js — tiny synchronous pub/sub bus.
// Exports: on, off, once, emit, clearAll, EVENTS

/** Canonical event names used across the app. */
export const EVENTS = {
  STATE_CHANGED: 'state:changed',
  RES_CHANGED: 'res:changed',
  BUILD_DONE: 'build:done',
  RESEARCH_DONE: 'research:done',
  TRAIN_DONE: 'train:done',
  MARCH_ARRIVED: 'march:arrived',
  BATTLE_RESULT: 'battle:result',
  SCREEN_CHANGE: 'screen:change',
  TOAST: 'toast',
  LOG: 'log'
};

/** @type {Map<string, Function[]>} */
const listeners = new Map();

/**
 * Subscribe to an event.
 * @param {string} evt
 * @param {(payload:any)=>void} fn
 * @returns {()=>void} unsubscribe function
 */
export function on(evt, fn) {
  if (typeof fn !== 'function') return () => {};
  let arr = listeners.get(evt);
  if (!arr) {
    arr = [];
    listeners.set(evt, arr);
  }
  arr.push(fn);
  return () => off(evt, fn);
}

/**
 * Unsubscribe. With no fn, removes every listener for evt.
 * @param {string} evt
 * @param {Function} [fn]
 */
export function off(evt, fn) {
  if (fn === undefined) {
    listeners.delete(evt);
    return;
  }
  const arr = listeners.get(evt);
  if (!arr) return;
  const i = arr.indexOf(fn);
  if (i >= 0) arr.splice(i, 1);
  if (arr.length === 0) listeners.delete(evt);
}

/**
 * Subscribe for exactly one emission.
 * @param {string} evt
 * @param {(payload:any)=>void} fn
 * @returns {()=>void} unsubscribe function
 */
export function once(evt, fn) {
  const wrap = (payload) => {
    off(evt, wrap);
    fn(payload);
  };
  return on(evt, wrap);
}

/**
 * Emit an event. Listener errors are caught and logged so one bad
 * subscriber never breaks the game loop.
 * @param {string} evt
 * @param {any} [payload]
 */
export function emit(evt, payload) {
  const arr = listeners.get(evt);
  if (!arr || arr.length === 0) return;
  const snapshot = arr.slice();
  for (let i = 0; i < snapshot.length; i++) {
    try {
      snapshot[i](payload);
    } catch (err) {
      console.error('[events] listener failed for "' + evt + '"', err);
    }
  }
}

/** Remove every listener on every event. */
export function clearAll() {
  listeners.clear();
}
