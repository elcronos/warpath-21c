// js/engine/training.js — unit training queues, the field hospital, and army helpers.
// Exports: TRAIN_KIND, HEAL_KIND, SLOTS_PER_BUILDING, HEAL_COST_RATIO, HEAL_TIME_RATIO,
//          trainingQueue, healQueue, queueForBuilding, buildingForUnit, batchCapacity,
//          trainSpeedFactor, trainDuration, maxTrainable, trainUnits, cancelTraining,
//          speedUpCost, speedUpTraining, tickTraining,
//          woundedCapacity, totalWounded, healCost, healDuration, heal, cancelHeal,
//          tickHealing, enforceWoundedCapacity, addWounded,
//          totalArmyPower, armyCount, armyUpkeep, disband, getTrainableUnits, tickAll
//
// PERSISTENCE NOTE: state.migrate() only preserves S.queues.build / research / train,
// so BOTH training batches and hospital heal batches live in S.queues.train and are
// told apart by their `kind` field ('train' | 'heal'). Nothing else survives a reload.

import { uid, clamp } from '../util/fmt.js';
import { emit } from '../util/events.js';
import {
  S, addLog, ensureUnit, levelOf, markDirty
} from './state.js';
import { QUEUE, SPEEDUP, UPKEEP, POWER_WEIGHTS, RES_ORDER } from '../data/balance.js';
import { getEffect } from '../data/buildings.js';
import {
  UNITS, CLASSES, CLASS_META, getUnit, unitsByClass,
  trainCost, trainTime, missingUnitRequirements
} from '../data/units.js';
import { getBonus } from './bonus.js';

/** Queue entry discriminators stored in S.queues.train. */
export const TRAIN_KIND = 'train';
export const HEAL_KIND = 'heal';

/** Batches that may be stacked on ONE producing building (1 running + 1 waiting). */
export const SLOTS_PER_BUILDING = QUEUE.trainSlots + 1;

/** Healing costs this fraction of the unit's full training cost. */
export const HEAL_COST_RATIO = 0.25;

/** Healing takes this fraction of the unit's full training time. */
export const HEAL_TIME_RATIO = 0.35;

/** The hospital is its own "building lane" for queue purposes. */
const HOSPITAL = 'hospital';

// ---------------------------------------------------------------------------
// Small local resource helpers (kept local so this module has no dependency on
// the economy module's internals — S.res / S.cap are the shared contract).
// ---------------------------------------------------------------------------

function capFor(res) {
  if (res === 'gold') return Infinity;
  const c = Number(S.cap && S.cap[res]);
  return Number.isFinite(c) && c > 0 ? c : Infinity;
}

/** True when S.res covers every entry of `cost`. */
function affordable(cost) {
  for (const r in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, r)) continue;
    if ((Number(S.res[r]) || 0) < cost[r]) return false;
  }
  return true;
}

/** The first resource key in `cost` the player cannot pay. */
function missingResource(cost) {
  for (let i = 0; i < RES_ORDER.length; i++) {
    const r = RES_ORDER[i];
    if (cost[r] && (Number(S.res[r]) || 0) < cost[r]) return r;
  }
  if (cost.gold && (Number(S.res.gold) || 0) < cost.gold) return 'gold';
  return null;
}

function spend(cost) {
  for (const r in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, r)) continue;
    S.res[r] = Math.max(0, (Number(S.res[r]) || 0) - cost[r]);
  }
  emit('res:changed', S.res);
  markDirty();
}

function grant(cost) {
  for (const r in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, r)) continue;
    const amount = Number(cost[r]) || 0;
    if (amount <= 0) continue;
    const have = Math.max(0, Number(S.res[r]) || 0);
    const cap = capFor(r);
    // never trim an already-overfull stockpile, just refuse to add past cap
    const next = have >= cap ? have : Math.min(cap, have + amount);
    S.res[r] = r === 'gold' ? Math.round(next) : Math.round(next * 100) / 100;
  }
  emit('res:changed', S.res);
  markDirty();
}

function scaleCostObj(cost, factor) {
  const out = {};
  for (const r in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, r)) continue;
    const v = Math.floor((Number(cost[r]) || 0) * factor);
    if (v > 0) out[r] = v;
  }
  return out;
}

function fail(error, extra) {
  const out = { ok: false, error: String(error) };
  if (extra) Object.assign(out, extra);
  return out;
}

function nowMs(now) {
  const n = Number(now);
  return Number.isFinite(n) && n > 0 ? n : Date.now();
}

// ---------------------------------------------------------------------------
// Queue access
// ---------------------------------------------------------------------------

function allEntries() {
  if (!Array.isArray(S.queues.train)) S.queues.train = [];
  return S.queues.train;
}

/** Every pending TRAINING batch, in insertion order. */
export function trainingQueue() {
  return allEntries().filter((e) => e && e.kind !== HEAL_KIND);
}

/** Every pending HOSPITAL batch, in insertion order. */
export function healQueue() {
  return allEntries().filter((e) => e && e.kind === HEAL_KIND);
}

/**
 * Pending batches on one producing building lane ('barracks', 'tank_factory',
 * 'hangar', 'artillery_range' or 'hospital'), in run order.
 * @param {string} building
 * @returns {object[]}
 */
export function queueForBuilding(building) {
  return allEntries().filter((e) => e && e.building === building);
}

/** The producing building that trains a unit key, or null. */
export function buildingForUnit(unitKey) {
  const u = getUnit(unitKey);
  if (!u) return null;
  const meta = CLASS_META[u.cls];
  return meta ? meta.building : null;
}

function entryById(id) {
  const list = allEntries();
  for (let i = 0; i < list.length; i++) {
    if (list[i] && list[i].id === id) return list[i];
  }
  return null;
}

/**
 * Re-anchor a lane after an insertion/removal/speed-up. The batch that is
 * ALREADY RUNNING keeps its own clock; everything behind it is chained.
 *
 * "Already running" means startAt <= now. A batch that was merely queued behind
 * another one carries a startAt in the FUTURE (it was chained by an earlier
 * reschedule); when the batch ahead of it is cancelled or rushed it is promoted
 * to the head and MUST be re-anchored to `now`, otherwise the lane would sit
 * idle until the timestamp of the slot that no longer exists — and because the
 * stamps are absolute and persisted in S.queues.train, that stall would survive
 * a reload. Timestamps that are missing or inverted are re-anchored too.
 *
 * @param {string} building
 * @param {number} now
 */
function reschedule(building, now) {
  const list = queueForBuilding(building);
  let cursor = now;
  for (let i = 0; i < list.length; i++) {
    const e = list[i];
    const ms = Math.max(1000, Math.round(e.secs * 1000));
    if (i === 0) {
      if (!e.startAt || !e.endAt || e.endAt < e.startAt || e.startAt > now) {
        e.startAt = now;
        e.endAt = now + ms;
      }
      cursor = e.endAt;
    } else {
      e.startAt = cursor;
      e.endAt = cursor + ms;
      cursor = e.endAt;
    }
  }
  markDirty();
}

function removeEntry(entry) {
  const list = allEntries();
  const i = list.indexOf(entry);
  if (i >= 0) list.splice(i, 1);
}

// ---------------------------------------------------------------------------
// Training
// ---------------------------------------------------------------------------

/**
 * Largest batch a producing building may take in one order.
 * Scales with the building's own level AND the HQ level.
 * @param {string} building 'barracks' | 'tank_factory' | 'hangar' | 'artillery_range'
 * @returns {number} 0 when the building is not built
 */
export function batchCapacity(building) {
  const lv = levelOf(building);
  if (lv < 1) return 0;
  const hq = Math.max(1, Number(S.player.hqLevel) || 1);
  return Math.min(QUEUE.maxBatch, Math.round(20 + 8 * lv + 8 * hq));
}

/**
 * Multiplier applied to raw training seconds. getBonus('train.speed') already
 * folds in tech, officers AND the producing building's own effect.
 * @returns {number} in (0, 1]
 */
export function trainSpeedFactor() {
  const bonus = Number(getBonus('train.speed')) || 0;
  return 1 / (1 + Math.max(0, bonus));
}

/**
 * Real training duration in seconds for `count` units of `unitKey`.
 * @param {string} unitKey
 * @param {number} count
 * @returns {number} integer seconds (>= 1)
 */
export function trainDuration(unitKey, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const raw = trainTime(unitKey, n);
  if (!raw) return 0;
  return Math.max(1, Math.round(raw * trainSpeedFactor()));
}

/**
 * How many of a unit could be ordered right now, and what is holding it back.
 * @param {string} unitKey
 * @returns {{max:number, byCap:number, byRes:number, limitedBy:'capacity'|'resources'|'none'}}
 */
export function maxTrainable(unitKey) {
  const u = getUnit(unitKey);
  if (!u) return { max: 0, byCap: 0, byRes: 0, limitedBy: 'none' };
  const byCap = batchCapacity(buildingForUnit(unitKey) || '');
  let byRes = Infinity;
  for (const r in u.cost) {
    if (!Object.prototype.hasOwnProperty.call(u.cost, r)) continue;
    const per = Number(u.cost[r]) || 0;
    if (per <= 0) continue;
    byRes = Math.min(byRes, Math.floor((Number(S.res[r]) || 0) / per));
  }
  if (!Number.isFinite(byRes)) byRes = byCap;
  const max = Math.max(0, Math.min(byCap, byRes));
  return {
    max,
    byCap,
    byRes,
    limitedBy: max === 0 ? (byCap === 0 ? 'capacity' : 'resources')
      : (byRes < byCap ? 'resources' : 'capacity')
  };
}

/**
 * Order a training batch.
 * @param {string} unitKey e.g. 'tank3'
 * @param {number} count
 * @param {number} [now]
 * @returns {{ok:true, entry:object}|{ok:false, error:string, missing?:Array, need?:string}}
 */
export function trainUnits(unitKey, count, now) {
  const t = nowMs(now);
  const u = getUnit(unitKey);
  if (!u) return fail('Unknown unit "' + unitKey + '".');

  const n = Math.floor(Number(count) || 0);
  if (n < 1) return fail('Order at least one unit.');

  const building = buildingForUnit(unitKey);
  if (!building) return fail('That unit has no production building.');

  // 1. building level + doctrine tech gates
  const missing = missingUnitRequirements(unitKey, S.player.hqLevel, S.buildings, S.tech);
  if (missing.length > 0) {
    return fail(missing.map(reqText).join(', '), { missing });
  }

  // 2. lane depth
  const lane = queueForBuilding(building);
  if (lane.length >= SLOTS_PER_BUILDING) {
    return fail(labelFor(building) + ' queue is full.');
  }

  // 3. batch size vs building capacity
  const cap = batchCapacity(building);
  if (n > cap) {
    return fail(labelFor(building) + ' can only take ' + cap + ' units per batch.', { cap });
  }

  // 4. resources
  const cost = trainCost(unitKey, n);
  if (!affordable(cost)) {
    const need = missingResource(cost);
    return fail('Not enough ' + resLabel(need) + '.', { need, cost });
  }
  spend(cost);

  const secs = trainDuration(unitKey, n);
  const entry = {
    id: uid('tq'),
    kind: TRAIN_KIND,
    key: unitKey,
    cls: u.cls,
    building,
    count: n,
    secs,
    cost,
    startAt: 0,
    endAt: 0
  };
  allEntries().push(entry);
  reschedule(building, t);

  addLog('train', 'Training ' + n + ' x ' + u.name + '.', { key: unitKey, count: n });
  emit('state:changed', { reason: 'train:queued' });
  return { ok: true, entry };
}

function reqText(m) {
  return (m.name || m.key) + ' Lv.' + m.need;
}

/**
 * Cancel a queued/running batch. Refunds 50% of the resources paid.
 * @param {string} id entry id
 * @param {number} [now]
 * @returns {{ok:true, refund:object, entry:object}|{ok:false,error:string}}
 */
export function cancelTraining(id, now) {
  const t = nowMs(now);
  const entry = entryById(id);
  if (!entry) return fail('That batch is no longer in the queue.');
  if (entry.kind === HEAL_KIND) return cancelHeal(id, t);

  const refund = scaleCostObj(entry.cost || {}, 0.5);
  removeEntry(entry);
  grant(refund);
  reschedule(entry.building, t);

  const u = getUnit(entry.key);
  addLog('train', 'Cancelled ' + entry.count + ' x ' + (u ? u.name : entry.key) + ' (50% refunded).',
    { key: entry.key, count: entry.count });
  emit('toast', { msg: 'Batch cancelled, half the materials recovered.', kind: 'warn' });
  emit('state:changed', { reason: 'train:cancelled' });
  return { ok: true, refund, entry };
}

/** Full duration of a training batch in seconds (drives the free-finish rule). */
function batchTotalSec(entry) {
  if (!entry) return 0;
  return Math.max(1, (Number(entry.endAt) - Number(entry.startAt)) / 1000);
}

/**
 * Gold needed to instantly finish a batch (0 when it is already free).
 * @param {string} id
 * @param {number} [now]
 * @returns {number}
 */
export function speedUpCost(id, now) {
  const entry = entryById(id);
  if (!entry) return 0;
  const remain = Math.max(0, Math.ceil((entry.endAt - nowMs(now)) / 1000));
  return SPEEDUP.goldFor(remain, batchTotalSec(entry));
}

/**
 * Finish a batch now, paying gold if it is not inside the free window.
 * @param {string} id
 * @param {number} [now]
 * @returns {{ok:true, gold:number}|{ok:false,error:string,need?:string}}
 */
export function speedUpTraining(id, now) {
  const t = nowMs(now);
  const entry = entryById(id);
  if (!entry) return fail('That batch is no longer in the queue.');
  if (entry.startAt > t) return fail('That batch has not started yet.');

  const remain = Math.max(0, Math.ceil((entry.endAt - t) / 1000));
  const gold = SPEEDUP.goldFor(remain, batchTotalSec(entry));
  if (gold > 0) {
    if ((Number(S.res.gold) || 0) < gold) return fail('Not enough gold.', { need: 'gold' });
    spend({ gold });
  }
  entry.endAt = t;
  const lane = entry.building;
  tickAll(t);
  reschedule(lane, t);
  emit('state:changed', { reason: 'train:speedup' });
  return { ok: true, gold };
}

/**
 * Complete every training batch whose timer has expired (also runs for the
 * whole offline gap, because endAt values are absolute wall-clock stamps).
 * @param {number} [now]
 * @returns {{key:string,count:number,cls:string}[]} completions, oldest first
 */
export function tickTraining(now) {
  const t = nowMs(now);
  const done = [];
  const lanes = {};
  let guard = 0;

  for (;;) {
    if (++guard > 500) break;
    const list = allEntries();
    let hit = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.kind === HEAL_KIND) continue;
      if (e.endAt > 0 && e.endAt <= t) {
        hit = e;
        break;
      }
    }
    if (!hit) break;

    removeEntry(hit);
    const slot = ensureUnit(hit.key);
    slot.count += hit.count;
    lanes[hit.building] = true;

    const u = getUnit(hit.key);
    const payload = {
      kind: TRAIN_KIND,
      key: hit.key,
      cls: hit.cls,
      count: hit.count,
      building: hit.building,
      name: u ? u.name : hit.key
    };
    done.push(payload);
    addLog('train', hit.count + ' x ' + payload.name + ' ready for duty.', payload);
    emit('train:done', payload);
  }

  if (done.length > 0) {
    for (const b in lanes) {
      if (Object.prototype.hasOwnProperty.call(lanes, b)) reschedule(b, t);
    }
    for (let i = 0; i < done.length; i++) {
      emit('toast', { msg: done[i].count + ' x ' + done[i].name + ' deployed.', kind: 'ok' });
    }
    markDirty();
    emit('state:changed', { reason: 'train:done' });
  }
  return done;
}

// ---------------------------------------------------------------------------
// Field hospital
// ---------------------------------------------------------------------------

/**
 * Total wounded beds available.
 * @param {number} [hospitalLevel] defaults to the built hospital's level
 * @returns {number} 0 when no hospital exists
 */
export function woundedCapacity(hospitalLevel) {
  const lv = hospitalLevel === undefined ? levelOf(HOSPITAL) : Math.floor(Number(hospitalLevel) || 0);
  if (lv < 1) return 0;
  const eff = getEffect(HOSPITAL, lv);
  return Math.max(0, Math.round(Number(eff['heal.capacity']) || 0));
}

/** Wounded lying in beds PLUS wounded already committed to a heal batch. */
export function totalWounded() {
  let n = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    n += Math.max(0, Math.floor(Number(S.army[k].wounded) || 0));
  }
  const q = healQueue();
  for (let i = 0; i < q.length; i++) n += Math.max(0, Math.floor(q[i].count) || 0);
  return n;
}

/**
 * Resource cost to heal `count` wounded of a unit.
 * @param {string} unitKey
 * @param {number} count
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function healCost(unitKey, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  return scaleCostObj(trainCost(unitKey, n), HEAL_COST_RATIO);
}

/**
 * Time in seconds to heal `count` wounded, after the 'heal.speed' bonus.
 * @param {string} unitKey
 * @param {number} count
 * @returns {number} integer seconds (>= 1)
 */
export function healDuration(unitKey, count) {
  const n = Math.max(1, Math.floor(Number(count) || 1));
  const raw = trainTime(unitKey, n) * HEAL_TIME_RATIO;
  if (raw <= 0) return 0;
  const bonus = Math.max(0, Number(getBonus('heal.speed')) || 0);
  return Math.max(1, Math.round(raw / (1 + bonus)));
}

/**
 * Send wounded units back through the hospital.
 * The wounded are removed from S.army[key].wounded immediately (they are in
 * theatre) and returned to `count` when the batch completes.
 * @param {string} unitKey
 * @param {number} count
 * @param {number} [now]
 * @returns {{ok:true, entry:object}|{ok:false,error:string,need?:string}}
 */
export function heal(unitKey, count, now) {
  const t = nowMs(now);
  const u = getUnit(unitKey);
  if (!u) return fail('Unknown unit "' + unitKey + '".');

  const hospitalLevel = levelOf(HOSPITAL);
  if (hospitalLevel < 1) return fail('Build a Field Hospital first.');

  const slot = ensureUnit(unitKey);
  const available = Math.max(0, Math.floor(Number(slot.wounded) || 0));
  const n = Math.min(Math.floor(Number(count) || 0), available);
  if (n < 1) return fail('No wounded ' + u.name + ' to treat.');

  const lane = queueForBuilding(HOSPITAL);
  if (lane.length >= SLOTS_PER_BUILDING) return fail('The hospital is already at work.');

  const cost = healCost(unitKey, n);
  if (!affordable(cost)) {
    const need = missingResource(cost);
    return fail('Not enough ' + resLabel(need) + '.', { need, cost });
  }
  spend(cost);
  slot.wounded = available - n;

  const entry = {
    id: uid('hl'),
    kind: HEAL_KIND,
    key: unitKey,
    cls: u.cls,
    building: HOSPITAL,
    count: n,
    secs: healDuration(unitKey, n),
    cost,
    startAt: 0,
    endAt: 0
  };
  allEntries().push(entry);
  reschedule(HOSPITAL, t);

  addLog('heal', 'Treating ' + n + ' x ' + u.name + '.', { key: unitKey, count: n });
  emit('state:changed', { reason: 'heal:queued' });
  return { ok: true, entry };
}

/**
 * Abort a heal batch: the wounded go back to their beds and half the
 * resources are recovered.
 * @param {string} id
 * @param {number} [now]
 * @returns {{ok:true, refund:object, entry:object}|{ok:false,error:string}}
 */
export function cancelHeal(id, now) {
  const t = nowMs(now);
  const entry = entryById(id);
  if (!entry || entry.kind !== HEAL_KIND) return fail('That treatment is no longer queued.');

  removeEntry(entry);
  const slot = ensureUnit(entry.key);
  slot.wounded += entry.count;
  const refund = scaleCostObj(entry.cost || {}, 0.5);
  grant(refund);
  reschedule(HOSPITAL, t);
  enforceWoundedCapacity(t);

  addLog('heal', 'Treatment of ' + entry.count + ' x ' + labelUnit(entry.key) + ' aborted.', {
    key: entry.key, count: entry.count
  });
  emit('state:changed', { reason: 'heal:cancelled' });
  return { ok: true, refund, entry };
}

/**
 * Complete every finished heal batch (offline-safe, same as tickTraining).
 * @param {number} [now]
 * @returns {{key:string,count:number,cls:string}[]}
 */
export function tickHealing(now) {
  const t = nowMs(now);
  const done = [];
  let guard = 0;

  for (;;) {
    if (++guard > 500) break;
    const list = allEntries();
    let hit = null;
    for (let i = 0; i < list.length; i++) {
      const e = list[i];
      if (!e || e.kind !== HEAL_KIND) continue;
      if (e.endAt > 0 && e.endAt <= t) {
        hit = e;
        break;
      }
    }
    if (!hit) break;

    removeEntry(hit);
    const slot = ensureUnit(hit.key);
    slot.count += hit.count;

    const payload = {
      kind: HEAL_KIND,
      key: hit.key,
      cls: hit.cls,
      count: hit.count,
      building: HOSPITAL,
      name: labelUnit(hit.key)
    };
    done.push(payload);
    addLog('heal', hit.count + ' x ' + payload.name + ' returned to the line.', payload);
    emit('train:done', payload);
  }

  if (done.length > 0) {
    reschedule(HOSPITAL, t);
    for (let i = 0; i < done.length; i++) {
      emit('toast', { msg: done[i].count + ' x ' + done[i].name + ' healed.', kind: 'ok' });
    }
    markDirty();
    emit('state:changed', { reason: 'heal:done' });
  }
  return done;
}

/**
 * Wounded beyond the hospital's capacity die. Cheapest (lowest tier) casualties
 * are written off first so the expensive survivors keep the beds.
 * Units already inside a heal batch are never touched.
 * @returns {{lost:number, byUnit:Object<string,number>}}
 */
export function enforceWoundedCapacity() {
  const cap = woundedCapacity();
  const out = { lost: 0, byUnit: {} };
  let total = totalWounded();
  if (total <= cap) return out;

  // lowest tier first, then lowest class order
  const keys = Object.keys(S.army)
    .filter((k) => UNITS[k] && (Number(S.army[k].wounded) || 0) > 0)
    .sort((a, b) => {
      const ua = UNITS[a];
      const ub = UNITS[b];
      if (ua.tier !== ub.tier) return ua.tier - ub.tier;
      return CLASSES.indexOf(ua.cls) - CLASSES.indexOf(ub.cls);
    });

  for (let i = 0; i < keys.length && total > cap; i++) {
    const k = keys[i];
    const slot = S.army[k];
    const have = Math.max(0, Math.floor(Number(slot.wounded) || 0));
    const drop = Math.min(have, total - cap);
    if (drop <= 0) continue;
    slot.wounded = have - drop;
    total -= drop;
    out.lost += drop;
    out.byUnit[k] = (out.byUnit[k] || 0) + drop;
  }

  if (out.lost > 0) {
    S.stats.unitsLost += out.lost;
    markDirty();
    addLog('heal', out.lost + ' wounded died — no hospital beds free.', out.byUnit);
    emit('toast', { msg: out.lost + ' wounded lost: hospital full.', kind: 'danger' });
    emit('state:changed', { reason: 'heal:overflow' });
  }
  return out;
}

/**
 * Move `count` active troops into the wounded pool (battle casualties taken at
 * home, hospital admissions, etc). Overflow past hospital capacity is resolved
 * immediately.
 *
 * `S.army[key].count` and `.wounded` are DISJOINT pools everywhere in the
 * engine: engine/combat.js's applyBattleResult subtracts casualties from
 * `.count` before adding them to `.wounded`, and heal() moves them back the
 * other way. So this must debit `.count` too — adding to `.wounded` alone would
 * mint a free unit every time the casualty was healed.
 *
 * Pass {detached:true} when the units were already removed from `.count`
 * (e.g. a world-map march whose troops were detached at launch).
 *
 * @param {string} unitKey
 * @param {number} count
 * @param {{detached?:boolean}} [opts]
 * @returns {number} the number actually bedded down
 */
export function addWounded(unitKey, count, opts) {
  const n = Math.max(0, Math.floor(Number(count) || 0));
  if (!UNITS[unitKey] || n === 0) return 0;
  const slot = ensureUnit(unitKey);
  const detached = !!(opts && opts.detached);
  // Can only wound troops that are actually standing (unless already detached).
  const take = detached ? n : Math.min(n, Math.max(0, Math.floor(slot.count) || 0));
  if (take === 0) return 0;
  if (!detached) slot.count = Math.max(0, Math.floor(slot.count) - take);
  const before = slot.wounded;
  slot.wounded = before + take;
  markDirty();
  enforceWoundedCapacity();
  return Math.max(0, slot.wounded - before);
}

// ---------------------------------------------------------------------------
// Army helpers
// ---------------------------------------------------------------------------

/**
 * Combat power of the standing army. Wounded troops still count, discounted by
 * POWER_WEIGHTS.wounded.
 * @returns {number} integer
 */
export function totalArmyPower() {
  let p = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const slot = S.army[k];
    const live = Math.max(0, Math.floor(Number(slot.count) || 0));
    const hurt = Math.max(0, Math.floor(Number(slot.wounded) || 0));
    p += u.power * POWER_WEIGHTS.unit * live;
    p += u.power * POWER_WEIGHTS.wounded * hurt;
  }
  return Math.round(p);
}

/**
 * Head count.
 * @param {boolean} [includeWounded=false]
 * @returns {number}
 */
export function armyCount(includeWounded) {
  let n = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    n += Math.max(0, Math.floor(Number(S.army[k].count) || 0));
    if (includeWounded) n += Math.max(0, Math.floor(Number(S.army[k].wounded) || 0));
  }
  return n;
}

/**
 * Food consumed per hour by the standing army (wounded eat at half rate).
 * @returns {number} food per hour, rounded
 */
export function armyUpkeep() {
  let food = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const slot = S.army[k];
    const live = Math.max(0, Math.floor(Number(slot.count) || 0));
    const hurt = Math.max(0, Math.floor(Number(slot.wounded) || 0));
    food += u.upkeep * (live + hurt * 0.5);
  }
  return Math.round(food * UPKEEP.mult);
}

/**
 * Permanently remove units from the roster (no refund — they are stood down).
 * @param {string} unitKey
 * @param {number} count
 * @param {{wounded?:boolean}} [opts] disband wounded instead of live troops
 * @returns {{ok:true, removed:number}|{ok:false,error:string}}
 */
export function disband(unitKey, count, opts) {
  const u = getUnit(unitKey);
  if (!u) return fail('Unknown unit "' + unitKey + '".');
  const field = (opts && opts.wounded) ? 'wounded' : 'count';
  const slot = ensureUnit(unitKey);
  const have = Math.max(0, Math.floor(Number(slot[field]) || 0));
  const n = clamp(Math.floor(Number(count) || 0), 0, have);
  if (n < 1) return fail('Nothing to stand down.');
  slot[field] = have - n;
  markDirty();
  addLog('army', 'Stood down ' + n + ' x ' + u.name + '.', { key: unitKey, count: n });
  emit('state:changed', { reason: 'army:disband' });
  return { ok: true, removed: n };
}

/**
 * Every unit grouped by class, each flagged unlocked or with the reason why not.
 * Shape:
 * [{ cls, name, short, color, building, buildingLevel, capacity, queue:[...],
 *    units:[{ key, unit, unlocked, missing:[{type,key,name,need,have}], reason,
 *             cost, seconds, maxBatch, affordable }] }]
 * @returns {object[]}
 */
export function getTrainableUnits() {
  const out = [];
  for (let c = 0; c < CLASSES.length; c++) {
    const cls = CLASSES[c];
    const meta = CLASS_META[cls];
    const building = meta.building;
    const buildingLevel = levelOf(building);
    const group = {
      cls,
      name: meta.name,
      short: meta.short,
      color: meta.color,
      desc: meta.desc,
      building,
      buildingName: labelFor(building),
      buildingLevel,
      capacity: batchCapacity(building),
      queue: queueForBuilding(building),
      units: []
    };
    const list = unitsByClass(cls);
    for (let i = 0; i < list.length; i++) {
      const u = list[i];
      const missing = missingUnitRequirements(u.key, S.player.hqLevel, S.buildings, S.tech);
      const cost = trainCost(u.key, 1);
      group.units.push({
        key: u.key,
        unit: u,
        unlocked: missing.length === 0,
        missing,
        reason: missing.length === 0 ? '' : missing.map(reqText).join(' · '),
        cost,
        seconds: trainDuration(u.key, 1),
        maxBatch: missing.length === 0 ? maxTrainable(u.key).max : 0,
        affordable: affordable(cost)
      });
    }
    out.push(group);
  }
  return out;
}

/**
 * Run both timers. engine/loop.js should call this once per tick and once on
 * load (with the current wall clock) to settle offline progress.
 * @param {number} [now]
 * @returns {{trained:object[], healed:object[]}}
 */
export function tickAll(now) {
  const t = nowMs(now);
  const trained = tickTraining(t);
  const healed = tickHealing(t);
  return { trained, healed };
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const BUILDING_LABELS = {
  barracks: 'Barracks',
  tank_factory: 'Tank Factory',
  hangar: 'Aircraft Hangar',
  artillery_range: 'Artillery Range',
  hospital: 'Field Hospital'
};

function labelFor(key) {
  return BUILDING_LABELS[key] || key;
}

function labelUnit(key) {
  const u = UNITS[key];
  return u ? u.name : key;
}

const RES_LABELS = { oil: 'oil', steel: 'steel', rare: 'rare earth', food: 'food', gold: 'gold' };

function resLabel(key) {
  return RES_LABELS[key] || 'resources';
}
