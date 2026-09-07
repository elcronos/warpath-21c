// js/engine/loop.js — the master game tick.
// Drives economy accrual, every queue system, autosave and the offline catch-up.
// Exports: startLoop, stopLoop, isRunning, tickOnce, forceSave, lastOfflineSummary,
//          hasCaughtUp
//
// Sibling systems (research.js, training.js, worldmap.js) are pulled in with
// dynamic import() so a missing or broken module degrades to "that subsystem is
// idle" instead of taking the whole game down. Contract:
//   research.tickResearch(now)
//   training.tickTraining(now)
//   training.tickHealing(now)
//   worldmap.tickMarches(now)
//   officers.reconcileSlots()

import { S, save, saveNow, touch, markDirty } from './state.js';
import { emit } from '../util/events.js';
import { formatNum, formatTime } from '../util/fmt.js';
import { TICK_MS, SAVE_TICK_MS, RES_ORDER, OFFLINE_CAP_HOURS } from '../data/balance.js';
import { accrue, computeCaps, productionRates } from './economy.js';
import { tickBuild } from './build.js';
import { getBonus, getPower, invalidateBonuses } from './bonus.js';

/** Below this many seconds away we just accrue normally, no "welcome back". */
const OFFLINE_MIN_SEC = 60;

/** A single tick longer than this is treated as a catch-up, not a live tick. */
const CATCHUP_SEC = 120;

/** How often the power score is refreshed even when nothing structural changed. */
const POWER_EVERY_MS = 10000;

/**
 * Safety stop for the segmented catch-up walk: a 12 h window can never contain
 * more than a few dozen queue completions, so this is pure paranoia.
 */
const MAX_CATCHUP_SEGMENTS = 400;

let running = false;
let timer = 0;
let lastTick = 0;
let lastSave = 0;
let lastPower = 0;
let offlineSummary = null;
let wiredVisibility = false;
let caughtUp = false;

/** @type {{tickResearch?:Function}|null} */
let research = null;
/** @type {{tickTraining?:Function, tickHealing?:Function}|null} */
let training = null;
/** @type {{tickMarches?:Function}|null} */
let worldmap = null;
/** @type {{reconcileSlots?:Function}|null} */
let officers = null;

/** Modules that already logged a failure, so we only warn once each. */
const warned = Object.create(null);

/** True while the loop is ticking. */
export function isRunning() {
  return running;
}

/** The summary produced by the most recent offline catch-up (or null). */
export function lastOfflineSummary() {
  return offlineSummary;
}

/**
 * True once the offline catch-up has run (or was deliberately skipped because
 * the gap was too short to matter).
 *
 * S.t is the ONLY record of when the player was last online. Until this returns
 * true, nothing outside the loop may stamp it to "now" — doing so would make
 * the absence look like zero seconds and delete all offline progress. The
 * lifecycle handlers in js/main.js gate their touch() call on this.
 * @returns {boolean}
 */
export function hasCaughtUp() {
  return caughtUp;
}

/** Flush the save immediately. */
export function forceSave() {
  touch(Date.now());
  return saveNow();
}

// ---------------------------------------------------------------------------
// Resilient invocation
// ---------------------------------------------------------------------------

/**
 * Call a subsystem tick without ever letting it stop the loop.
 * @param {string} name for the log
 * @param {any} mod
 * @param {string} fn method name
 * @param {number} now
 * @returns {number} whatever the system returned, coerced to a number (0 on failure)
 */
function safeTick(name, mod, fn, now) {
  if (!mod || typeof mod[fn] !== 'function') return 0;
  try {
    const r = mod[fn](now);
    return typeof r === 'number' && Number.isFinite(r) ? r : 0;
  } catch (err) {
    if (!warned[name + '.' + fn]) {
      warned[name + '.' + fn] = true;
      console.error('[loop] ' + name + '.' + fn + '() threw; that subsystem is skipped', err);
    }
    return 0;
  }
}

/** Load the sibling systems. Missing files are tolerated. */
async function loadSystems() {
  const jobs = [
    ['./research.js', (m) => { research = m; }],
    ['./training.js', (m) => { training = m; }],
    ['./worldmap.js', (m) => { worldmap = m; }],
    ['./officers.js', (m) => { officers = m; }]
  ];
  for (let i = 0; i < jobs.length; i++) {
    const [path, assign] = jobs[i];
    try {
      // eslint-disable-next-line no-await-in-loop
      const mod = await import(path);
      assign(mod);
      // worldmap.js accepts an injected bonus provider; hand it the real one.
      if (mod && typeof mod.setBonusProvider === 'function') mod.setBonusProvider(getBonus);
    } catch (err) {
      console.warn('[loop] ' + path + ' not available yet', err && err.message ? err.message : err);
    }
  }
}

// ---------------------------------------------------------------------------
// Structural change detection
// ---------------------------------------------------------------------------

/**
 * A cheap fingerprint of everything a screen would want to re-render for.
 * @returns {number}
 */
function signature() {
  let n = 0;
  n += (S.buildings ? S.buildings.length : 0) * 1;
  const q = S.queues || {};
  n += (q.build ? q.build.length : 0) * 7;
  n += (q.research ? q.research.length : 0) * 13;
  n += (q.train ? q.train.length : 0) * 17;
  n += (S.map && S.map.marches ? S.map.marches.length : 0) * 23;
  n += (S.campaign && S.campaign.cleared ? S.campaign.cleared.length : 0) * 29;

  const blds = S.buildings || [];
  for (let i = 0; i < blds.length; i++) n += (blds[i].level || 0) * 31;

  const tech = S.tech || {};
  for (const k in tech) {
    if (Object.prototype.hasOwnProperty.call(tech, k)) n += (tech[k] || 0) * 37;
  }
  const army = S.army || {};
  for (const k in army) {
    if (!Object.prototype.hasOwnProperty.call(army, k)) continue;
    const e = army[k] || {};
    n += (e.count || 0) * 3 + (e.wounded || 0) * 5;
  }
  const own = (S.officers && S.officers.owned) || {};
  for (const k in own) {
    if (!Object.prototype.hasOwnProperty.call(own, k)) continue;
    const o = own[k] || {};
    n += (o.level || 0) * 41 + (o.stars || 0) * 43 + (o.assigned ? 47 : 0);
  }
  return n;
}

// ---------------------------------------------------------------------------
// Queue systems
// ---------------------------------------------------------------------------

/**
 * Settle every queue at wall-clock `at`. Queue jobs carry absolute timestamps,
 * so this completes everything whose deadline has passed.
 * @param {number} at
 * @returns {number} number of jobs reported complete
 */
function runQueueTicks(at) {
  let completed = 0;
  try {
    completed += tickBuild(at);
  } catch (err) {
    console.error('[loop] build.tickBuild failed', err);
  }
  completed += safeTick('research', research, 'tickResearch', at);
  completed += safeTick('training', training, 'tickTraining', at);
  completed += safeTick('training', training, 'tickHealing', at);
  completed += safeTick('worldmap', worldmap, 'tickMarches', at);
  // A march that just finished was spliced out of S.map.marches; free the
  // command slot its leader was holding (returns a boolean, so it never
  // inflates `completed`).
  safeTick('officers', officers, 'reconcileSlots', at);
  return completed;
}

/**
 * The earliest queue deadline strictly after `after` and no later than `until`,
 * or 0 when the window contains none.
 *
 * These are the instants at which the economy changes shape during an absence:
 * a refinery finishing raises production, a warehouse finishing raises the cap,
 * a training batch finishing raises food upkeep, a march arriving deposits loot.
 * @param {number} after
 * @param {number} until
 * @returns {number}
 */
function nextBoundary(after, until) {
  let best = 0;
  const consider = (raw) => {
    const t = Number(raw) || 0;
    if (t > after && t <= until && (best === 0 || t < best)) best = t;
  };
  const q = S.queues || {};
  const lists = [q.build, q.research, q.train];
  for (let i = 0; i < lists.length; i++) {
    const list = Array.isArray(lists[i]) ? lists[i] : [];
    for (let j = 0; j < list.length; j++) {
      if (!list[j]) continue;
      consider(list[j].endAt);
      consider(list[j].doneAt);
    }
  }
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    if (blds[i] && blds[i].state === 'building') consider(blds[i].doneAt);
  }
  const marches = (S.map && Array.isArray(S.map.marches)) ? S.map.marches : [];
  for (let i = 0; i < marches.length; i++) {
    if (!marches[i]) continue;
    consider(marches[i].arriveAt);
    consider(marches[i].gatherUntil);
  }
  // An inbound enemy raid is a boundary too: it can take resources off the pile.
  const raids = (S.map && Array.isArray(S.map.raids)) ? S.map.raids : [];
  for (let i = 0; i < raids.length; i++) {
    if (raids[i]) consider(raids[i].arriveAt);
  }
  return best;
}

/**
 * Replay a closed window of real time, SEGMENTED at every queue completion
 * inside it.
 *
 * Accruing the whole window in one go (from the pre-absence snapshot of
 * production, caps and upkeep) under-credits everything that finished during
 * the absence: a refinery that had 60 seconds left would produce nothing for
 * 12 hours, a finished Warehouse would not raise the cap the stockpile is
 * clamped against, and returning march loot would land in an already-full
 * store. So instead we walk the boundaries: accrue up to the next completion,
 * settle the queues at that instant (which changes the rates), and continue.
 *
 * The credited window is capped at OFFLINE_CAP_HOURS; anything that finished
 * before the cap window opens is settled first, so its output is credited for
 * the whole of the credited window.
 *
 * @param {number} fromMs start of the absence (S.t)
 * @param {number} toMs now
 * @returns {{elapsedMs:number, appliedMs:number, seconds:number, hours:number,
 *   capped:boolean, capHours:number, gained:object, starved:number,
 *   rates:object, any:boolean}} the welcome-back summary
 */
function catchUpWindow(fromMs, toMs) {
  const capMs = OFFLINE_CAP_HOURS * 3600 * 1000;
  const raw = Math.max(0, toMs - fromMs);
  const applied = Math.min(raw, capMs);
  const rates = productionRates();

  const total = { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };
  let starved = 0;
  const add = (r) => {
    if (!r || !r.gained) return;
    for (const k in total) {
      if (Object.prototype.hasOwnProperty.call(total, k)) total[k] += Number(r.gained[k]) || 0;
    }
    starved += Number(r.starved) || 0;
  };

  let cursor = toMs - applied;
  // Everything that finished before the credited window even opens.
  runQueueTicks(cursor);

  let guard = 0;
  for (;;) {
    if (++guard > MAX_CATCHUP_SEGMENTS) break;
    const b = nextBoundary(cursor, toMs);
    if (!b) break;
    if (b > cursor) add(accrue((b - cursor) / 1000, { silent: true }));
    cursor = b;
    runQueueTicks(b);
  }
  if (toMs > cursor) add(accrue((toMs - cursor) / 1000, { silent: true }));
  runQueueTicks(toMs);

  const gained = {
    oil: Math.floor(total.oil),
    steel: Math.floor(total.steel),
    rare: Math.floor(total.rare),
    food: Math.floor(total.food),
    gold: Math.floor(total.gold)
  };
  computeCaps();
  emit('res:changed', S.res);

  return {
    elapsedMs: raw,
    appliedMs: applied,
    seconds: applied / 1000,
    hours: applied / 3600000,
    capped: raw > capMs,
    capHours: OFFLINE_CAP_HOURS,
    gained,
    starved,
    rates,
    any: gained.oil > 0 || gained.steel > 0 || gained.rare > 0
      || gained.food !== 0 || gained.gold > 0 || starved > 0
  };
}

// ---------------------------------------------------------------------------
// The tick
// ---------------------------------------------------------------------------

/**
 * Run one iteration of the game loop.
 * Safe to call manually (tests, debugging, forced catch-up).
 * @param {number} [nowMs]
 * @returns {{dt:number, completed:number, changed:boolean}}
 */
export function tickOnce(nowMs) {
  const now = typeof nowMs === 'number' ? nowMs : Date.now();
  if (!lastTick) lastTick = now;

  const prev = lastTick;
  let dt = (now - lastTick) / 1000;
  if (!Number.isFinite(dt) || dt < 0) dt = 0;
  lastTick = now;

  const before = signature();
  let completed = 0;
  let longGap = false;

  // --- economy -------------------------------------------------------
  try {
    if (dt > CATCHUP_SEC) {
      // The tab was frozen/backgrounded for a long stretch: treat it as
      // offline, segmented at every queue completion inside the gap.
      longGap = true;
      const summary = catchUpWindow(prev, now);
      // Came from a visible-again tick, not from boot: js/main.js reports a
      // short one as a toast rather than a full-screen modal.
      summary.live = true;
      offlineSummary = summary;
      if (summary.any) emit('offline:summary', summary);
    } else if (dt > 0) {
      accrue(dt);
    }
  } catch (err) {
    console.error('[loop] economy catch-up failed', err);
    longGap = false;
  }

  // --- queue systems --------------------------------------------------
  // (already settled up to `now` when the long-gap branch ran)
  if (!longGap) completed += runQueueTicks(now);

  // --- bookkeeping ----------------------------------------------------
  touch(now);
  const changed = signature() !== before;

  if (changed) {
    invalidateBonuses();
    computeCaps();
    getPower();
    lastPower = now;
    markDirty();
    emit('state:changed', { reason: 'tick' });
  } else if (now - lastPower >= POWER_EVERY_MS) {
    lastPower = now;
    try {
      getPower();
    } catch (err) {
      console.error('[loop] getPower failed', err);
    }
  }

  emit('res:changed', S.res);

  if (now - lastSave >= SAVE_TICK_MS) {
    lastSave = now;
    try {
      save();
    } catch (err) {
      console.error('[loop] save failed', err);
    }
  }

  return { dt, completed, changed };
}

// ---------------------------------------------------------------------------
// Offline catch-up
// ---------------------------------------------------------------------------

/**
 * Apply everything that happened while the game was closed and announce it.
 * @param {number} now
 */
function runOfflineCatchUp(now) {
  const last = Number(S.t) || 0;
  const elapsed = last > 0 ? now - last : 0;

  if (elapsed < OFFLINE_MIN_SEC * 1000) {
    // Short gap — fold it into the very first live tick instead.
    lastTick = last > 0 ? Math.min(now, last) : now;
    caughtUp = true;
    return;
  }

  let summary = null;
  try {
    // Walks the absence boundary by boundary, so a refinery, warehouse or
    // training batch that finished during the gap contributes to the rest of it.
    summary = catchUpWindow(last, now);
  } catch (err) {
    console.error('[loop] offline window failed', err);
  }
  lastTick = now;
  touch(now);
  caughtUp = true;

  if (!summary) return;
  offlineSummary = summary;
  emit('offline:summary', summary);

  if (summary.any) {
    const bits = [];
    for (let i = 0; i < RES_ORDER.length; i++) {
      const k = RES_ORDER[i];
      if (summary.gained[k] > 0) bits.push('+' + formatNum(summary.gained[k]) + ' ' + k);
    }
    if (summary.gained.gold > 0) bits.push('+' + formatNum(summary.gained.gold) + ' gold');
    const msg = bits.length
      ? 'Away ' + formatTime(summary.elapsedMs / 1000) + ': ' + bits.join(', ')
      : 'Away ' + formatTime(summary.elapsedMs / 1000) + '.';
    emit('toast', { msg, kind: summary.starved > 0 ? 'bad' : 'ok', ms: 4200 });
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/**
 * Start the game loop. Idempotent. Runs the offline catch-up on first start.
 * @returns {Promise<void>}
 */
export async function startLoop() {
  if (running) return;
  running = true;

  await loadSystems();

  const now = Date.now();
  lastSave = now;
  lastPower = 0;

  try {
    computeCaps();
    invalidateBonuses();
    getPower();
  } catch (err) {
    console.error('[loop] initial derive failed', err);
  }

  try {
    runOfflineCatchUp(now);
  } catch (err) {
    console.error('[loop] offline catch-up failed', err);
    lastTick = now;
    // The absence is unrecoverable at this point; stop blocking S.t writes.
    caughtUp = true;
  }

  if (!lastTick) lastTick = now;
  markDirty();
  emit('state:changed', { reason: 'loop:start' });

  timer = setInterval(() => {
    if (!running) return;
    try {
      tickOnce(Date.now());
    } catch (err) {
      console.error('[loop] tick failed', err);
    }
  }, TICK_MS);

  // Coming back to a backgrounded tab: catch up immediately rather than
  // waiting for the throttled interval to fire.
  if (!wiredVisibility && typeof document !== 'undefined' && document.addEventListener) {
    wiredVisibility = true;
    document.addEventListener('visibilitychange', () => {
      if (running && document.visibilityState === 'visible') {
        try {
          tickOnce(Date.now());
        } catch (err) {
          console.error('[loop] visibility tick failed', err);
        }
      }
    });
  }
}

/** Stop the loop and flush the save. */
export function stopLoop() {
  if (!running) return;
  running = false;
  if (timer) {
    clearInterval(timer);
    timer = 0;
  }
  forceSave();
}
