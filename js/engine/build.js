// js/engine/build.js — construction: placement, upgrades, the build queue,
// cancellation, gold speed-ups and per-tick completion.
// Exports: buildTimeFor, costFor, placeCostFor, copyLimit, copiesBuilt, plotFree,
//          freePlots, resolvePlot, isUnderConstruction, jobFor, mainSlots, slotUsage,
//          slotFor, hasSlotFor, slotCheck, canPlace, canUpgrade, startBuild, startUpgrade,
//          cancelBuild, speedUpCost, speedUp, tickBuild, queueInfo, nextLevelPreview
//
// Queue rules: QUEUE.buildSlots main slot(s) (+ any 'queue.build' building effect)
// plus ONE always-free "quick" slot that only accepts jobs of <= QUEUE.freeFinishSec.

import {
  S, PLOT_SLOTS, addBuilding, getBuilding as getBuildingById,
  addLog, markDirty
} from './state.js';
import { emit } from '../util/events.js';
import { formatTime } from '../util/fmt.js';
import { QUEUE, SPEEDUP, MAX_LEVEL } from '../data/balance.js';
import {
  BUILDINGS, getBuilding as getBuildingDef, getCost, getBuildTime, missingRequirements,
  getPlaceCost, maxCopies, countBuilt
} from '../data/buildings.js';
import { getBonus, getEffectTotal, invalidateBonuses } from './bonus.js';
import {
  canAfford, missingResources, spend, refund, computeCaps, speedMult
} from './economy.js';

// ---------------------------------------------------------------------------
// Costs & timings
// ---------------------------------------------------------------------------

/**
 * Real construction time in seconds for `key` -> `level`, after build.speed
 * bonuses and the settings speed multiplier.
 * @param {string} key
 * @param {number} level target level
 * @returns {number} integer seconds, min 1
 */
export function buildTimeFor(key, level) {
  const base = getBuildTime(key, level);
  if (!base) return 0;
  const mult = Math.max(0.1, 1 + getBonus('build.speed'));
  return Math.max(1, Math.round(base / mult / speedMult()));
}

/**
 * Resource cost for `key` -> `level`.
 * @param {string} key
 * @param {number} level
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function costFor(key, level) {
  return getCost(key, level);
}

/**
 * Resource cost of placing ONE MORE copy of `key` right now (escalates with
 * the number already standing).
 * @param {string} key
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function placeCostFor(key) {
  return getPlaceCost(key, copiesBuilt(key));
}

/** How many copies of `key` are on the plot grid (including ones being built). */
export function copiesBuilt(key) {
  return countBuilt(key, S.buildings);
}

/** How many copies of `key` the current HQ level allows (Infinity when free). */
export function copyLimit(key) {
  return maxCopies(key, hqLevel());
}

/**
 * Everything the UI needs to render the "next level" panel of a building.
 * @param {string} key
 * @param {number} currentLevel
 * @returns {{key:string, level:number, cost:object, seconds:number, maxed:boolean, missing:Array}}
 */
export function nextLevelPreview(key, currentLevel) {
  const def = BUILDINGS[key];
  const cur = Math.max(0, Math.floor(Number(currentLevel) || 0));
  const level = cur + 1;
  const maxed = !def || level > (def.maxLevel || MAX_LEVEL);
  return {
    key,
    level,
    cost: maxed ? {} : getCost(key, level),
    seconds: maxed ? 0 : buildTimeFor(key, level),
    maxed,
    missing: maxed ? [] : missingRequirements(key, level, hqLevel(), S.buildings)
  };
}

function hqLevel() {
  let lv = Math.floor(Number(S.player && S.player.hqLevel) || 0);
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    if (blds[i] && blds[i].key === 'hq') lv = Math.max(lv, Math.floor(Number(blds[i].level) || 0));
  }
  return Math.max(1, lv);
}

// ---------------------------------------------------------------------------
// Plots
// ---------------------------------------------------------------------------

/**
 * Normalize any plot reference into {x,y}.
 * Accepts a PLOT_SLOTS index, "x,y", {x,y} or a slot object.
 * @param {number|string|{x:number,y:number}} plot
 * @returns {{x:number,y:number}|null}
 */
export function resolvePlot(plot) {
  if (plot === null || plot === undefined) return null;
  if (typeof plot === 'number' && Number.isFinite(plot)) {
    const slot = PLOT_SLOTS[Math.floor(plot)];
    return slot ? { x: slot.x, y: slot.y } : null;
  }
  if (typeof plot === 'string') {
    const parts = plot.split(/[,:x_ ]+/).filter((s) => s !== '');
    if (parts.length >= 2) {
      const x = Math.floor(Number(parts[0]));
      const y = Math.floor(Number(parts[1]));
      if (Number.isFinite(x) && Number.isFinite(y)) return inGrid(x, y) ? { x, y } : null;
    }
    const idx = Math.floor(Number(plot));
    if (Number.isFinite(idx) && PLOT_SLOTS[idx]) return { x: PLOT_SLOTS[idx].x, y: PLOT_SLOTS[idx].y };
    return null;
  }
  if (typeof plot === 'object') {
    const x = Math.floor(Number(plot.x));
    const y = Math.floor(Number(plot.y));
    if (Number.isFinite(x) && Number.isFinite(y) && inGrid(x, y)) return { x, y };
  }
  return null;
}

function inGrid(x, y) {
  for (let i = 0; i < PLOT_SLOTS.length; i++) {
    if (PLOT_SLOTS[i].x === x && PLOT_SLOTS[i].y === y) return true;
  }
  return false;
}

/** Is nothing standing on this plot? */
export function plotFree(x, y) {
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    if (blds[i] && blds[i].x === x && blds[i].y === y) return false;
  }
  return true;
}

/** Every empty plot, in grid order. */
export function freePlots() {
  return PLOT_SLOTS.filter((p) => plotFree(p.x, p.y)).map((p) => ({ x: p.x, y: p.y, i: p.i }));
}

// ---------------------------------------------------------------------------
// Queue bookkeeping
// ---------------------------------------------------------------------------

function queue() {
  if (!S.queues || !Array.isArray(S.queues.build)) {
    if (!S.queues) S.queues = { build: [], research: [], train: [] };
    S.queues.build = [];
  }
  return S.queues.build;
}

/** Number of main construction slots (base + any 'queue.build' building effect). */
export function mainSlots() {
  return Math.max(1, QUEUE.buildSlots + Math.floor(getEffectTotal('queue.build')));
}

/**
 * Current slot occupancy.
 * @returns {{main:number, mainMax:number, quick:number, quickMax:number, quickLimitSec:number}}
 */
export function slotUsage() {
  const q = queue();
  let main = 0;
  let quick = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] && q[i].slot === 'quick') quick += 1;
    else main += 1;
  }
  return {
    main,
    mainMax: mainSlots(),
    quick,
    quickMax: QUEUE.freeBuildSlots,
    quickLimitSec: QUEUE.freeFinishSec
  };
}

/**
 * Which slot a job of `durationSec` could take, or null when the queue is full.
 * @param {number} durationSec
 * @returns {'main'|'quick'|null}
 */
function pickSlot(durationSec) {
  const u = slotUsage();
  if (u.main < u.mainMax) return 'main';
  if (u.quick < u.quickMax && durationSec <= QUEUE.freeFinishSec) return 'quick';
  return null;
}

/**
 * Public form of pickSlot: which slot a job of `durationSec` would take.
 * @param {number} durationSec
 * @returns {'main'|'quick'|null}
 */
export function slotFor(durationSec) {
  return pickSlot(durationSec);
}

/** True when a job of `durationSec` can start right now. */
export function hasSlotFor(durationSec) {
  return pickSlot(durationSec) !== null;
}

/**
 * Slot availability WITH the reason, so the UI can say why a button is dead
 * instead of pretending there are always two crews.
 * @param {number} durationSec
 * @returns {{ok:boolean, slot:'main'|'quick'|null, reason:string}}
 */
export function slotCheck(durationSec) {
  const slot = pickSlot(durationSec);
  if (slot) return { ok: true, slot, reason: '' };
  const u = slotUsage();
  const reason = (u.quick < u.quickMax)
    ? 'The reserve crew only takes jobs under ' + formatTime(QUEUE.freeFinishSec) + '.'
    : 'All construction crews are busy.';
  return { ok: false, slot: null, reason };
}

/** Full duration of a queued job in seconds (used by the free-finish rule). */
function jobTotalSec(job) {
  if (!job) return 0;
  return Math.max(1, (Number(job.endAt) - Number(job.startAt)) / 1000);
}

/** The queue job for a building id, or null. */
export function jobFor(bid) {
  const q = queue();
  for (let i = 0; i < q.length; i++) {
    if (q[i] && q[i].bid === bid) return q[i];
  }
  return null;
}

/** Is this building currently being built or upgraded? */
export function isUnderConstruction(bid) {
  return !!jobFor(bid);
}

/**
 * Snapshot of the whole build queue for the UI.
 * @param {number} [now]
 * @returns {{jobs:Array, slots:object}}
 */
export function queueInfo(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const jobs = queue().map((j) => {
    const def = BUILDINGS[j.key];
    const total = Math.max(1, (j.endAt - j.startAt) / 1000);
    const remain = Math.max(0, (j.endAt - t) / 1000);
    return {
      bid: j.bid,
      key: j.key,
      name: def ? def.name : j.key,
      toLevel: j.toLevel,
      slot: j.slot || 'main',
      startAt: j.startAt,
      endAt: j.endAt,
      remainSec: remain,
      totalSec: total,
      progress: Math.max(0, Math.min(1, 1 - remain / total)),
      goldToFinish: SPEEDUP.goldFor(remain, total),
      free: SPEEDUP.isFree(remain, total)
    };
  });
  return { jobs, slots: slotUsage() };
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * May a new `key` be placed on `plot`?
 * @param {string} key
 * @param {number|string|object} plot
 * @returns {{ok:boolean, reason?:string, cost?:object, seconds?:number, missing?:Array, plot?:{x:number,y:number}}}
 */
export function canPlace(key, plot) {
  const def = getBuildingDef(key);
  if (!def) return { ok: false, reason: 'Unknown building.' };

  const p = resolvePlot(plot);
  if (!p) return { ok: false, reason: 'That plot is off the grid.' };
  if (!plotFree(p.x, p.y)) return { ok: false, reason: 'That plot is occupied.' };

  if (def.unique) {
    const blds = Array.isArray(S.buildings) ? S.buildings : [];
    for (let i = 0; i < blds.length; i++) {
      if (blds[i] && blds[i].key === key) {
        return { ok: false, reason: def.name + ' can only be built once.' };
      }
    }
  }

  const missing = missingRequirements(key, 1, hqLevel(), S.buildings);
  if (missing.length) {
    return { ok: false, reason: requirementText(missing), missing };
  }

  const have = copiesBuilt(key);
  const limit = copyLimit(key);
  if (have >= limit) {
    return {
      ok: false,
      reason: 'You may only run ' + limit + ' ' + def.name +
        (limit === 1 ? '' : 's') + ' at HQ Lv' + hqLevel() + ' — upgrade the ones you have.'
    };
  }

  const cost = getPlaceCost(key, have);
  const seconds = buildTimeFor(key, 1);
  if (!canAfford(cost)) {
    return { ok: false, reason: shortfallText(cost), cost, seconds, plot: p };
  }
  const slot = slotCheck(seconds);
  if (!slot.ok) {
    return { ok: false, reason: slot.reason, cost, seconds, plot: p };
  }
  return { ok: true, cost, seconds, plot: p, missing: [] };
}

/**
 * May this building be upgraded one level?
 * @param {string} bid building id
 * @returns {{ok:boolean, reason?:string, cost?:object, seconds?:number, toLevel?:number, missing?:Array}}
 */
export function canUpgrade(bid) {
  const b = getBuildingById(bid);
  if (!b) return { ok: false, reason: 'No such building.' };
  const def = getBuildingDef(b.key);
  if (!def) return { ok: false, reason: 'Unknown building.' };
  if (isUnderConstruction(bid) || b.state === 'building') {
    return { ok: false, reason: 'Already under construction.' };
  }
  const toLevel = Math.max(1, Math.floor(Number(b.level) || 0) + 1);
  const max = def.maxLevel || MAX_LEVEL;
  if (toLevel > max) return { ok: false, reason: def.name + ' is at maximum level.' };

  const missing = missingRequirements(b.key, toLevel, hqLevel(), S.buildings);
  if (missing.length) return { ok: false, reason: requirementText(missing), missing, toLevel };

  const cost = getCost(b.key, toLevel);
  const seconds = buildTimeFor(b.key, toLevel);
  if (!canAfford(cost)) return { ok: false, reason: shortfallText(cost), cost, seconds, toLevel };
  const slot = slotCheck(seconds);
  if (!slot.ok) {
    return { ok: false, reason: slot.reason, cost, seconds, toLevel };
  }
  return { ok: true, cost, seconds, toLevel, missing: [] };
}

function requirementText(missing) {
  return 'Requires ' + missing.map((m) => m.name + ' Lv' + m.need).join(', ') + '.';
}

function shortfallText(cost) {
  const short = missingResources(cost);
  if (!short.length) return 'Not enough resources.';
  return 'Need more ' + short.map((s) => s.res).join(', ') + '.';
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Place a brand-new building on a plot. The record is created at level 0 and
 * becomes level 1 when the job completes.
 *
 * @param {number|string|{x:number,y:number}} plotKeyOrId PLOT_SLOTS index, "x,y" or {x,y}
 * @param {string} buildingKey
 * @returns {{ok:boolean, reason?:string, id?:string, endAt?:number, seconds?:number}}
 */
export function startBuild(plotKeyOrId, buildingKey) {
  const check = canPlace(buildingKey, plotKeyOrId);
  if (!check.ok) return { ok: false, reason: check.reason };

  if (!spend(check.cost)) return { ok: false, reason: 'Not enough resources.' };

  const now = Date.now();
  const seconds = check.seconds;
  const slot = pickSlot(seconds) || 'main';
  const b = addBuilding(buildingKey, 0, check.plot.x, check.plot.y);
  b.state = 'building';
  b.startedAt = now;
  b.doneAt = now + seconds * 1000;

  queue().push({
    bid: b.id,
    key: buildingKey,
    toLevel: 1,
    startAt: now,
    endAt: b.doneAt,
    slot,
    // the escalating copy price is not recomputable later, so remember it
    cost: check.cost
  });

  const def = BUILDINGS[buildingKey];
  addLog('build', 'Construction started: ' + def.name + ' (' + formatTime(seconds) + ')', {
    key: buildingKey, level: 1
  });
  markDirty();
  emit('state:changed', { reason: 'build:start', key: buildingKey });
  return { ok: true, id: b.id, endAt: b.doneAt, seconds };
}

/**
 * Upgrade an existing building by one level.
 * @param {string} buildingId
 * @returns {{ok:boolean, reason?:string, id?:string, endAt?:number, seconds?:number, toLevel?:number}}
 */
export function startUpgrade(buildingId) {
  const check = canUpgrade(buildingId);
  if (!check.ok) return { ok: false, reason: check.reason };

  const b = getBuildingById(buildingId);
  if (!b) return { ok: false, reason: 'No such building.' };
  if (!spend(check.cost)) return { ok: false, reason: 'Not enough resources.' };

  const now = Date.now();
  const seconds = check.seconds;
  const slot = pickSlot(seconds) || 'main';
  b.state = 'building';
  b.startedAt = now;
  b.doneAt = now + seconds * 1000;

  queue().push({
    bid: b.id,
    key: b.key,
    toLevel: check.toLevel,
    startAt: now,
    endAt: b.doneAt,
    slot,
    cost: check.cost
  });

  const def = BUILDINGS[b.key];
  addLog('build', 'Upgrading ' + def.name + ' to Lv' + check.toLevel + ' (' + formatTime(seconds) + ')', {
    key: b.key, level: check.toLevel
  });
  markDirty();
  emit('state:changed', { reason: 'build:start', key: b.key });
  return { ok: true, id: b.id, endAt: b.doneAt, seconds, toLevel: check.toLevel };
}

/**
 * Cancel a running job. Refunds 50% of the spent cost. A cancelled level-1
 * construction removes the (never finished) building from the plot.
 * @param {string} buildingId
 * @returns {{ok:boolean, reason?:string, refunded?:object, removed?:boolean}}
 */
export function cancelBuild(buildingId) {
  const q = queue();
  let idx = -1;
  for (let i = 0; i < q.length; i++) {
    if (q[i] && q[i].bid === buildingId) { idx = i; break; }
  }
  if (idx < 0) return { ok: false, reason: 'Nothing to cancel.' };

  const job = q[idx];
  q.splice(idx, 1);

  const paid = (job.cost && typeof job.cost === 'object') ? job.cost : getCost(job.key, job.toLevel);
  const refunded = refund(paid, 0.5);
  const b = getBuildingById(buildingId);
  let removed = false;

  if (b) {
    if (job.toLevel <= 1) {
      const at = S.buildings.indexOf(b);
      if (at >= 0) S.buildings.splice(at, 1);
      removed = true;
    } else {
      b.state = 'idle';
      b.doneAt = 0;
      b.startedAt = 0;
    }
  }

  const def = BUILDINGS[job.key];
  addLog('build', 'Cancelled ' + (def ? def.name : job.key) + ' — half the materials recovered.', {
    key: job.key, level: job.toLevel
  });
  markDirty();
  invalidateBonuses();
  emit('state:changed', { reason: 'build:cancel', key: job.key });
  emit('toast', { msg: 'Construction cancelled.', kind: 'info' });
  return { ok: true, refunded, removed };
}

/**
 * Gold needed to finish a job right now (0 when it is already free).
 * @param {string} buildingId
 * @param {number} [now]
 * @returns {{gold:number, free:boolean, remainSec:number}}
 */
export function speedUpCost(buildingId, now) {
  const job = jobFor(buildingId);
  if (!job) return { gold: 0, free: false, remainSec: 0 };
  const t = typeof now === 'number' ? now : Date.now();
  const remain = Math.max(0, (job.endAt - t) / 1000);
  const total = jobTotalSec(job);
  return {
    gold: SPEEDUP.goldFor(remain, total),
    free: SPEEDUP.isFree(remain, total),
    remainSec: remain,
    totalSec: total
  };
}

/**
 * Finish a job early. Under QUEUE.freeFinishSec remaining it is free;
 * otherwise `useGold` must be true and the gold is charged.
 * @param {string} buildingId
 * @param {boolean} [useGold=false]
 * @returns {{ok:boolean, reason?:string, gold?:number}}
 */
export function speedUp(buildingId, useGold) {
  const job = jobFor(buildingId);
  if (!job) return { ok: false, reason: 'Nothing to speed up.' };

  const now = Date.now();
  const remain = Math.max(0, (job.endAt - now) / 1000);
  const total = jobTotalSec(job);

  if (SPEEDUP.isFree(remain, total)) {
    job.endAt = now;
    tickBuild(now);
    return { ok: true, gold: 0 };
  }
  const gold = SPEEDUP.goldFor(remain, total);
  if (!useGold) {
    return { ok: false, reason: 'Costs ' + gold + ' gold.', gold };
  }
  if (!spend({ gold })) return { ok: false, reason: 'Not enough gold.', gold };

  job.endAt = now;
  tickBuild(now);
  return { ok: true, gold };
}

// ---------------------------------------------------------------------------
// Tick
// ---------------------------------------------------------------------------

/**
 * Complete every construction job whose timer has elapsed.
 * @param {number} [now] wall-clock ms
 * @returns {number} how many jobs completed
 */
export function tickBuild(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const q = queue();
  if (q.length === 0) return 0;

  let done = 0;
  for (let i = q.length - 1; i >= 0; i--) {
    const job = q[i];
    if (!job || typeof job.endAt !== 'number') { q.splice(i, 1); continue; }
    if (job.endAt > t) continue;

    q.splice(i, 1);
    const b = getBuildingById(job.bid);
    if (!b) continue;

    b.level = Math.max(Math.floor(Number(b.level) || 0), Math.floor(job.toLevel) || 1);
    b.state = 'idle';
    b.doneAt = 0;
    b.startedAt = 0;
    if (b.key === 'hq') S.player.hqLevel = b.level;

    const def = BUILDINGS[b.key];
    const name = def ? def.name : b.key;
    invalidateBonuses();
    addLog('build', name + ' reached Lv' + b.level + '.', { key: b.key, level: b.level, id: b.id });
    emit('build:done', { id: b.id, bid: b.id, key: b.key, name, level: b.level });
    emit('toast', { msg: name + ' Lv' + b.level + ' complete.', kind: 'ok' });
    done += 1;
  }

  if (done > 0) {
    invalidateBonuses();
    computeCaps();
    markDirty();
    emit('state:changed', { reason: 'build:done' });
    emit('res:changed', S.res);
  }
  return done;
}
