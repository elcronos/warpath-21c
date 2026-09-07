// js/engine/economy.js — resource production, storage caps, army upkeep,
// spending / granting, real-time accrual and offline catch-up.
// Exports: speedMult, productionRates, productionRate, computeCaps, getCaps,
//          protectedAmount, foodUpkeep, netRates, accrue, canAfford, missingResources,
//          spend, refund, grant, capacityFor, isFull, timeToFull, applyOffline
//
// Imports engine/state.js + engine/bonus.js + js/data/*. Nothing in js/engine
// may import this module *and* be imported by it (build.js imports economy.js).

import { S, markDirty, addLog } from './state.js';
import { emit } from '../util/events.js';
import { clamp } from '../util/fmt.js';
import { getBonus, getEffectTotal } from './bonus.js';
import {
  RES_ORDER, UPKEEP, OFFLINE_CAP_HOURS
} from '../data/balance.js';
import { BUILDINGS, getProduction, getCapacity } from '../data/buildings.js';
import { UNITS } from '../data/units.js';

/** Every key that can appear in a cost/grant object. */
const ALL_RES = RES_ORDER.concat(['gold']);

/** Fractional gold carried between ticks so S.res.gold stays a whole number. */
let goldCarry = 0;

/**
 * The player's chosen time dilation (Settings -> speed), clamped to 1..4.
 * Applied to resource accrual AND to newly-created build jobs (see build.js).
 * @returns {number}
 */
export function speedMult() {
  const v = Number(S.settings && S.settings.speed);
  return Number.isFinite(v) ? clamp(v, 1, 4) : 1;
}

// ---------------------------------------------------------------------------
// Production
// ---------------------------------------------------------------------------

/**
 * Per-hour output of every resource, after prod.* bonuses.
 * `gold` comes from the Trade Centre's 'trade.gold' effect.
 * @returns {{oil:number, steel:number, rare:number, food:number, gold:number}}
 */
export function productionRates() {
  const raw = { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    if (!b || !BUILDINGS[b.key]) continue;
    const lv = Math.floor(Number(b.level) || 0);
    if (lv < 1) continue;
    const p = getProduction(b.key, lv);
    if (p && typeof raw[p.res] === 'number') raw[p.res] += p.perHour;
  }
  const out = { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };
  for (let i = 0; i < RES_ORDER.length; i++) {
    const k = RES_ORDER[i];
    out[k] = Math.max(0, raw[k] * (1 + getBonus('prod.' + k)));
  }
  out.gold = Math.max(0, getEffectTotal('trade.gold'));
  return out;
}

/**
 * Per-hour output of one resource.
 * @param {string} res
 * @returns {number}
 */
export function productionRate(res) {
  const r = productionRates();
  return typeof r[res] === 'number' ? r[res] : 0;
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

/**
 * Recompute S.cap from HQ + Warehouse capacity and the cap.storage bonus.
 * @returns {{oil:number, steel:number, rare:number, food:number}} the live S.cap
 */
export function computeCaps() {
  const acc = { oil: 0, steel: 0, rare: 0, food: 0 };
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    if (!b || !BUILDINGS[b.key]) continue;
    const lv = Math.floor(Number(b.level) || 0);
    if (lv < 1) continue;
    const c = getCapacity(b.key, lv);
    acc.oil += c.oil;
    acc.steel += c.steel;
    acc.rare += c.rare;
    acc.food += c.food;
  }
  const mult = 1 + getBonus('cap.storage');
  for (let i = 0; i < RES_ORDER.length; i++) {
    const k = RES_ORDER[i];
    S.cap[k] = Math.max(1000, Math.round(acc[k] * mult));
  }
  return S.cap;
}

/** Current caps (recomputed on the spot). */
export function getCaps() {
  return computeCaps();
}

/** Cap for one resource; `gold` is uncapped and reports Infinity. */
export function capacityFor(res) {
  if (res === 'gold') return Infinity;
  computeCaps();
  return S.cap[res] || 0;
}

/**
 * How much of each resource is safe from raiders (Warehouse protection).
 * @returns {number} a flat amount applied per resource
 */
export function protectedAmount() {
  let total = 0;
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    if (!b || !BUILDINGS[b.key]) continue;
    const lv = Math.floor(Number(b.level) || 0);
    if (lv < 1) continue;
    total += getCapacity(b.key, lv).protected;
  }
  return Math.round(total);
}

/** True when a resource sits at (or above) its cap. */
export function isFull(res) {
  if (res === 'gold') return false;
  return (S.res[res] || 0) >= capacityFor(res);
}

/**
 * Seconds until a resource hits its cap at the current net rate.
 * @param {string} res
 * @returns {number} Infinity when it never will
 */
export function timeToFull(res) {
  if (res === 'gold') return Infinity;
  const cap = capacityFor(res);
  const have = S.res[res] || 0;
  if (have >= cap) return 0;
  const rate = netRates()[res] * speedMult();
  if (!(rate > 0)) return Infinity;
  return ((cap - have) / rate) * 3600;
}

// ---------------------------------------------------------------------------
// Upkeep
// ---------------------------------------------------------------------------

/**
 * Food consumed per hour by the standing army.
 * Wounded troops still eat, at half rate.
 * @returns {number}
 */
export function foodUpkeep() {
  let total = 0;
  const ar = S.army && typeof S.army === 'object' ? S.army : {};
  for (const k in ar) {
    if (!Object.prototype.hasOwnProperty.call(ar, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const e = ar[k] || {};
    const alive = Math.max(0, Math.floor(Number(e.count) || 0));
    const hurt = Math.max(0, Math.floor(Number(e.wounded) || 0));
    total += u.upkeep * (alive + hurt * 0.5);
  }
  return Math.round(total * UPKEEP.mult * 100) / 100;
}

/**
 * Production minus upkeep, per hour. Only food can go negative.
 * @returns {{oil:number, steel:number, rare:number, food:number, gold:number, upkeep:number}}
 */
export function netRates() {
  const p = productionRates();
  const upkeep = foodUpkeep();
  return {
    oil: p.oil,
    steel: p.steel,
    rare: p.rare,
    food: p.food - upkeep,
    gold: p.gold,
    upkeep
  };
}

// ---------------------------------------------------------------------------
// Accrual
// ---------------------------------------------------------------------------

/**
 * Advance the economy by `dtSeconds` of game time.
 * Resources are clamped to their cap (already-overfull stockpiles simply stop
 * growing rather than being trimmed). A food deficit drains the larder and then
 * starves the army.
 *
 * @param {number} dtSeconds
 * @param {{silent?:boolean, applySpeed?:boolean}} [opts]
 * @returns {{gained:Object<string,number>, starved:number, hours:number}}
 */
export function accrue(dtSeconds, opts) {
  const o = opts || {};
  let dt = Number(dtSeconds);
  if (!Number.isFinite(dt) || dt <= 0) {
    return { gained: { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 }, starved: 0, hours: 0 };
  }
  if (o.applySpeed !== false) dt *= speedMult();

  const hours = dt / 3600;
  computeCaps();

  const rates = productionRates();
  const upkeep = foodUpkeep();
  const gained = { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };

  // --- the three non-food resources ------------------------------------
  for (let i = 0; i < RES_ORDER.length; i++) {
    const k = RES_ORDER[i];
    if (k === 'food') continue;
    const cap = S.cap[k] || 0;
    const have = Math.max(0, Number(S.res[k]) || 0);
    if (have >= cap) {
      S.res[k] = round2(have);
      continue;
    }
    const next = Math.min(cap, have + rates[k] * hours);
    gained[k] = next - have;
    S.res[k] = round2(next);
  }

  // --- food + starvation ------------------------------------------------
  const cap = S.cap.food || 0;
  let food = Math.max(0, Number(S.res.food) || 0);
  const net = rates.food - upkeep;
  let starved = 0;

  if (net >= 0) {
    if (food < cap) {
      const next = Math.min(cap, food + net * hours);
      gained.food = next - food;
      food = next;
    }
  } else {
    const drain = -net;
    const hoursUntilEmpty = food / drain;
    if (hours <= hoursUntilEmpty) {
      const next = food - drain * hours;
      gained.food = next - food;
      food = next;
    } else {
      gained.food = -food;
      food = 0;
      starved = starve(hours - hoursUntilEmpty);
    }
  }
  S.res.food = round2(Math.max(0, food));

  // --- gold (integer, fractional part carried between ticks) ------------
  if (rates.gold > 0) {
    goldCarry += rates.gold * hours;
    const whole = Math.floor(goldCarry);
    if (whole > 0) {
      goldCarry -= whole;
      S.res.gold = Math.max(0, Math.round((Number(S.res.gold) || 0) + whole));
      gained.gold = whole;
    }
  }

  markDirty();
  if (!o.silent) emit('res:changed', S.res);
  return { gained, starved, hours };
}

/**
 * Fractional troop-loss carried between ticks, exactly like `goldCarry`.
 * A one-second live tick asks for ~1e-5 of the army; without a carry every such
 * slice floors to zero and a starving army never actually loses anybody.
 */
let starveCarry = 0;

/**
 * Apply starvation attrition for `hoursStarving` hours.
 *
 * Both pools are drained. foodUpkeep() bills for the wounded (at half rate), so
 * attrition MUST be able to reach them: if only `.count` could shrink, an army
 * of casualties would pin food at 0 with a permanently negative net rate that
 * nothing could ever resolve. `UPKEEP.starveFloor` protects the standing
 * remnant of each stack only — wounded can starve out completely.
 *
 * The loss fraction is exponential (1 - e^-rate*h) rather than linear, so one
 * offline pass over N hours costs the same as N hours of compounding live
 * ticks; a linear slice would make being away measurably harsher.
 *
 * @param {number} hoursStarving
 * @returns {number} units lost
 */
function starve(hoursStarving) {
  const hours = Math.max(0, Number(hoursStarving) || 0);
  const frac = Math.min(0.9, 1 - Math.exp(-UPKEEP.starveRatePerHour * hours));
  if (frac <= 0) return 0;

  // Every pool that may be drained, with the head count that is at risk.
  const pools = [];
  let eligible = 0;
  const ar = S.army || {};
  for (const k in ar) {
    if (!Object.prototype.hasOwnProperty.call(ar, k)) continue;
    if (!UNITS[k]) continue;
    const e = ar[k];
    const count = Math.max(0, Math.floor(Number(e.count) || 0));
    const hurt = Math.max(0, Math.floor(Number(e.wounded) || 0));
    const standing = Math.max(0, count - UPKEEP.starveFloor);
    if (standing > 0) {
      pools.push({ slot: e, field: 'count', pool: standing });
      eligible += standing;
    }
    if (hurt > 0) {
      pools.push({ slot: e, field: 'wounded', pool: hurt });
      eligible += hurt;
    }
  }
  if (eligible <= 0) {
    starveCarry = 0;
    return 0;
  }

  const wanted = eligible * frac + starveCarry;
  let budget = Math.floor(wanted);
  starveCarry = wanted - budget;
  if (budget <= 0) return 0;
  budget = Math.min(budget, eligible);

  // Proportional first pass, then hand the rounding remainder out in order.
  let lost = 0;
  let left = budget;
  for (let i = 0; i < pools.length && left > 0; i++) {
    const p = pools[i];
    const share = Math.min(p.pool, Math.floor(budget * (p.pool / eligible)), left);
    if (share <= 0) continue;
    p.slot[p.field] = Math.max(0, Math.floor(Number(p.slot[p.field]) || 0) - share);
    p.pool -= share;
    left -= share;
    lost += share;
  }
  for (let i = 0; i < pools.length && left > 0; i++) {
    const p = pools[i];
    const share = Math.min(p.pool, left);
    if (share <= 0) continue;
    p.slot[p.field] = Math.max(0, Math.floor(Number(p.slot[p.field]) || 0) - share);
    p.pool -= share;
    left -= share;
    lost += share;
  }

  if (lost > 0) {
    S.stats.unitsLost += lost;
    addLog('warn', 'Rations exhausted — ' + lost + ' troops deserted.', { starved: lost });
    emit('toast', { msg: 'Out of food! ' + lost + ' troops lost.', kind: 'bad' });
  }
  return lost;
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Spending
// ---------------------------------------------------------------------------

/**
 * Can the player pay this cost right now?
 * @param {{oil?:number,steel?:number,rare?:number,food?:number,gold?:number}} cost
 * @returns {boolean}
 */
export function canAfford(cost) {
  return missingResources(cost).length === 0;
}

/**
 * Which parts of a cost the player cannot cover.
 * @param {object} cost
 * @returns {{res:string, need:number, have:number, short:number}[]}
 */
export function missingResources(cost) {
  const out = [];
  if (!cost || typeof cost !== 'object') return out;
  for (let i = 0; i < ALL_RES.length; i++) {
    const k = ALL_RES[i];
    const need = Math.max(0, Number(cost[k]) || 0);
    if (need <= 0) continue;
    const have = Math.max(0, Number(S.res[k]) || 0);
    if (have + 1e-6 < need) out.push({ res: k, need, have, short: need - have });
  }
  return out;
}

/**
 * Deduct a cost. All-or-nothing.
 * @param {object} cost
 * @returns {boolean} false when unaffordable (nothing was deducted)
 */
export function spend(cost) {
  if (!canAfford(cost)) return false;
  for (let i = 0; i < ALL_RES.length; i++) {
    const k = ALL_RES[i];
    const need = Math.max(0, Number(cost[k]) || 0);
    if (need <= 0) continue;
    S.res[k] = round2(Math.max(0, (Number(S.res[k]) || 0) - need));
  }
  markDirty();
  emit('res:changed', S.res);
  return true;
}

/**
 * Add resources.
 * @param {object} res {oil,steel,rare,food,gold}
 * @param {{overflow?:boolean, silent?:boolean}} [opts] overflow=true ignores storage caps
 * @returns {Object<string,number>} what was actually added
 */
export function grant(res, opts) {
  const o = opts || {};
  const added = { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };
  if (!res || typeof res !== 'object') return added;
  computeCaps();
  for (let i = 0; i < ALL_RES.length; i++) {
    const k = ALL_RES[i];
    const amount = Number(res[k]) || 0;
    if (amount === 0) continue;
    const have = Math.max(0, Number(S.res[k]) || 0);
    let next = have + amount;
    if (k !== 'gold' && !o.overflow) {
      const cap = S.cap[k] || 0;
      // never trim an already-overfull stockpile, just refuse to add past cap
      if (have < cap) next = Math.min(next, cap);
      else next = have;
    }
    next = Math.max(0, next);
    added[k] = next - have;
    S.res[k] = k === 'gold' ? Math.round(next) : round2(next);
  }
  markDirty();
  if (!o.silent) emit('res:changed', S.res);
  return added;
}

/**
 * Give back a fraction of a cost (used by cancelBuild).
 * @param {object} cost
 * @param {number} [ratio=0.5]
 * @returns {Object<string,number>} the refunded amounts
 */
export function refund(cost, ratio) {
  const r = Number.isFinite(Number(ratio)) ? Number(ratio) : 0.5;
  const back = {};
  if (cost && typeof cost === 'object') {
    for (let i = 0; i < ALL_RES.length; i++) {
      const k = ALL_RES[i];
      const v = Math.max(0, Number(cost[k]) || 0);
      if (v > 0) back[k] = Math.floor(v * r);
    }
  }
  grant(back, { overflow: true });
  return back;
}

// ---------------------------------------------------------------------------
// Offline catch-up
// ---------------------------------------------------------------------------

/**
 * Apply the resources produced while the game was closed, capped at
 * OFFLINE_CAP_HOURS. Queue jobs (build/research/train/marches) resolve on their
 * own because they store absolute wall-clock timestamps.
 *
 * @param {number} elapsedMs real milliseconds since the last tick
 * @returns {{
 *   elapsedMs:number, appliedMs:number, seconds:number, hours:number,
 *   capped:boolean, capHours:number,
 *   gained:{oil:number,steel:number,rare:number,food:number,gold:number},
 *   starved:number, rates:object, any:boolean
 * }} summary for the welcome-back modal
 */
export function applyOffline(elapsedMs) {
  const capMs = OFFLINE_CAP_HOURS * 3600 * 1000;
  const raw = Math.max(0, Number(elapsedMs) || 0);
  const applied = Math.min(raw, capMs);
  const rates = productionRates();

  const r = accrue(applied / 1000, { silent: true });

  const gained = {
    oil: Math.floor(r.gained.oil || 0),
    steel: Math.floor(r.gained.steel || 0),
    rare: Math.floor(r.gained.rare || 0),
    food: Math.floor(r.gained.food || 0),
    gold: Math.floor(r.gained.gold || 0)
  };
  const any = gained.oil > 0 || gained.steel > 0 || gained.rare > 0
    || gained.food !== 0 || gained.gold > 0 || r.starved > 0;

  emit('res:changed', S.res);
  return {
    elapsedMs: raw,
    appliedMs: applied,
    seconds: applied / 1000,
    hours: applied / 3600000,
    capped: raw > capMs,
    capHours: OFFLINE_CAP_HOURS,
    gained,
    starved: r.starved,
    rates,
    any
  };
}
