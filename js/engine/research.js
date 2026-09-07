// js/engine/research.js — the research system: one slot, prereq gating, gold speed-ups.
// Mutates S.queues.research / S.tech and emits 'research:done', 'res:changed', 'state:changed', 'toast'.
// Exports: RESEARCH_SLOTS, labLevel, getTechLevel, researchDuration, researchCost,
//          canResearch, startResearch, cancelResearch, speedUpResearch, tickResearch,
//          researchProgress, activeResearch, isResearching, techStatus, listBranch,
//          researchedLevels, totalTechLevels

import { emit } from '../util/events.js';
import { formatTime } from '../util/fmt.js';
import { S, levelOf, addLog, markDirty, save } from './state.js';
import { QUEUE, SPEEDUP, RES_ORDER } from '../data/balance.js';
import {
  TECH_KEYS, BRANCHES, getTech, getTechCost, getTechTime,
  maxTechLevel, missingTechRequirements, techsInBranch
} from '../data/tech.js';
// Namespace import: engine/bonus.js is written by a sibling module. A namespace
// import never hard-fails on a missing NAMED export, so a partially-built
// bonus.js degrades to "no bonus" instead of breaking the whole game.
import * as Bonus from './bonus.js';
import * as Economy from './economy.js';

/** Research runs in a single slot (QUEUE.researchSlots). */
export const RESEARCH_SLOTS = QUEUE.researchSlots;

// ---------------------------------------------------------------------------
// small local helpers
// ---------------------------------------------------------------------------

/**
 * Read a global bonus fraction through engine/bonus.js, defaulting to 0.
 * @param {string} key a BONUS_KEYS member
 * @returns {number}
 */
function bonus(key) {
  try {
    if (Bonus && typeof Bonus.getBonus === 'function') {
      const v = Number(Bonus.getBonus(key));
      return Number.isFinite(v) ? v : 0;
    }
  } catch (err) {
    console.warn('[research] getBonus failed for ' + key, err);
  }
  return 0;
}

/** Current Research Lab level (0 when it has not been built). */
export function labLevel() {
  return levelOf('lab');
}

/**
 * Researched level of a technology (0 = not researched).
 * @param {string} key
 * @returns {number}
 */
export function getTechLevel(key) {
  const v = Number(S.tech[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/** Sum of every researched tech level. */
export function totalTechLevels() {
  let n = 0;
  for (let i = 0; i < TECH_KEYS.length; i++) n += getTechLevel(TECH_KEYS[i]);
  return n;
}

/** A shallow {techKey: level} copy of everything researched. */
export function researchedLevels() {
  const out = {};
  for (let i = 0; i < TECH_KEYS.length; i++) {
    const l = getTechLevel(TECH_KEYS[i]);
    if (l > 0) out[TECH_KEYS[i]] = l;
  }
  return out;
}

/** True when the player can pay `cost` right now. */
function canAfford(cost) {
  for (const k in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
    if ((Number(S.res[k]) || 0) < cost[k]) return false;
  }
  return true;
}

/** The first resource in `cost` the player cannot pay, or null. */
function shortfall(cost) {
  for (let i = 0; i < RES_ORDER.length; i++) {
    const k = RES_ORDER[i];
    const need = Number(cost[k]) || 0;
    if (need > 0 && (Number(S.res[k]) || 0) < need) {
      return { res: k, need, have: Math.floor(Number(S.res[k]) || 0) };
    }
  }
  return null;
}

// Resource writes go through engine/economy.js so this module obeys exactly the
// same rounding and storage-cap policy as everything else. Namespace import for
// the same reason as Bonus above: a missing named export degrades to the local
// fallback instead of breaking the whole game.

/** Deduct `cost` from S.res (assumes canAfford). */
function spend(cost) {
  if (typeof Economy.spend === 'function' && Economy.spend(cost)) return;
  for (const k in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
    S.res[k] = round2(Math.max(0, (Number(S.res[k]) || 0) - cost[k]));
  }
  markDirty();
  emit('res:changed', S.res);
}

/**
 * Give `cost` back.
 *
 * Refunds are clamped to the storage caps. Without the clamp a player could sit
 * at cap, start a research order (the spend drops them below cap), let
 * production refill the headroom and then cancel — landing permanently above
 * S.cap, which accrue() never trims back down.
 */
function refund(cost) {
  if (typeof Economy.grant === 'function') {
    Economy.grant(cost);
    return;
  }
  for (const k in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
    const cap = k === 'gold' ? Infinity : (Number(S.cap && S.cap[k]) || Infinity);
    const have = Math.max(0, Number(S.res[k]) || 0);
    // never trim an already-overfull stockpile, just refuse to add past cap
    S.res[k] = have >= cap ? have : round2(Math.min(cap, have + (Number(cost[k]) || 0)));
  }
  markDirty();
  emit('res:changed', S.res);
}

function round2(v) {
  return Math.round(v * 100) / 100;
}

// ---------------------------------------------------------------------------
// Costs & durations
// ---------------------------------------------------------------------------

/**
 * Resource cost of researching the NEXT level of `key`
 * (or an explicit `level` when given).
 * @param {string} key
 * @param {number} [level]
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number}}
 */
export function researchCost(key, level) {
  const t = getTech(key);
  if (!t) return {};
  const lv = Math.max(1, Math.floor(Number(level) || (getTechLevel(key) + 1)));
  return getTechCost(key, lv);
}

/**
 * Effective research duration in SECONDS after the 'research.speed' bonus.
 * Reduction model: t = base / (1 + speed) — +100% speed halves the time.
 * @param {string} key
 * @param {number} [level] target level (defaults to the next one)
 * @returns {number} whole seconds, minimum 1
 */
export function researchDuration(key, level) {
  const t = getTech(key);
  if (!t) return 0;
  const lv = Math.max(1, Math.floor(Number(level) || (getTechLevel(key) + 1)));
  const base = getTechTime(key, lv);
  const speed = Math.max(-0.9, bonus('research.speed'));
  return Math.max(1, Math.round(base / (1 + speed)));
}

// ---------------------------------------------------------------------------
// Queue access
// ---------------------------------------------------------------------------

function queue() {
  if (!Array.isArray(S.queues.research)) S.queues.research = [];
  return S.queues.research;
}

/**
 * The research order currently in progress, or null.
 * @returns {{key:string,toLevel:number,startAt:number,endAt:number,dur:number,cost:object}|null}
 */
export function activeResearch() {
  const q = queue();
  return q.length > 0 && q[0] && typeof q[0].key === 'string' ? q[0] : null;
}

/** True when the research slot is busy. */
export function isResearching() {
  return !!activeResearch();
}

// ---------------------------------------------------------------------------
// Eligibility
// ---------------------------------------------------------------------------

/**
 * Can the next level of `key` be started right now?
 * @param {string} key
 * @returns {{ok:boolean, reason:string, key:string, level:number, cost:object,
 *            time:number, missing:Array, short:object|null}}
 */
export function canResearch(key) {
  const t = getTech(key);
  const level = t ? getTechLevel(key) + 1 : 0;
  const out = {
    ok: false, reason: '', key: String(key), level,
    cost: {}, time: 0, missing: [], short: null
  };
  if (!t) {
    out.reason = 'Unknown technology.';
    return out;
  }
  if (level > maxTechLevel(key)) {
    out.reason = t.name + ' is at maximum level.';
    return out;
  }
  out.cost = getTechCost(key, level);
  out.time = researchDuration(key, level);

  if (isResearching()) {
    out.reason = 'The lab is already busy.';
    return out;
  }
  const lab = labLevel();
  if (lab < 1) {
    out.reason = 'Build a Research Lab first.';
    out.missing = [{ type: 'lab', key: 'lab', name: 'Research Lab', need: 1, have: 0 }];
    return out;
  }
  const missing = missingTechRequirements(key, level, lab, S.tech);
  if (missing.length > 0) {
    out.missing = missing;
    const m = missing[0];
    out.reason = m.type === 'lab'
      ? 'Research Lab level ' + m.need + ' required.'
      : m.name + ' level ' + m.need + ' required.';
    return out;
  }
  const short = shortfall(out.cost);
  if (short) {
    out.short = short;
    out.reason = 'Not enough ' + short.res + '.';
    return out;
  }
  out.ok = true;
  out.reason = 'Ready.';
  return out;
}

/**
 * Full UI-facing status of one technology.
 * @param {string} key
 * @returns {object|null}
 */
export function techStatus(key) {
  const t = getTech(key);
  if (!t) return null;
  const level = getTechLevel(key);
  const maxed = level >= t.maxLevel;
  const check = maxed
    ? { ok: false, reason: 'Maxed', level, cost: {}, time: 0, missing: [], short: null }
    : canResearch(key);
  const act = activeResearch();
  return {
    key: t.key,
    name: t.name,
    branch: t.branch,
    desc: t.desc,
    icon: t.icon,
    level,
    maxLevel: t.maxLevel,
    maxed,
    nextLevel: maxed ? t.maxLevel : level + 1,
    cost: check.cost,
    time: check.time,
    can: check.ok,
    reason: check.reason,
    missing: check.missing,
    short: check.short,
    inProgress: !!(act && act.key === t.key),
    bonusNow: level > 0 ? t.bonus(level) : {},
    bonusNext: maxed ? {} : t.bonus(level + 1)
  };
}

/**
 * Every technology of a branch, as techStatus() records.
 * @param {string} branch one of BRANCHES
 * @returns {object[]}
 */
export function listBranch(branch) {
  if (BRANCHES.indexOf(branch) < 0) return [];
  return techsInBranch(branch).map((t) => techStatus(t.key)).filter(Boolean);
}

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

/**
 * Begin researching the next level of `key`.
 * @param {string} key
 * @returns {{ok:boolean, reason:string, entry?:object}}
 */
export function startResearch(key) {
  const check = canResearch(key);
  if (!check.ok) {
    emit('toast', { text: check.reason, kind: 'warn' });
    return { ok: false, reason: check.reason };
  }
  const t = getTech(key);
  const now = Date.now();
  const dur = check.time;
  spend(check.cost);
  const entry = {
    key: t.key,
    toLevel: check.level,
    startAt: now,
    endAt: now + dur * 1000,
    dur,
    cost: check.cost
  };
  queue().push(entry);
  addLog('research', 'Research started: ' + t.name + ' Lv.' + check.level + ' (' + formatTime(dur) + ')', {
    key: t.key, level: check.level
  });
  emit('toast', { text: t.name + ' Lv.' + check.level + ' — ' + formatTime(dur), kind: 'ok' });
  markDirty();
  emit('state:changed', { reason: 'research:start', key: t.key });
  save();
  return { ok: true, reason: 'Started.', entry };
}

/**
 * Cancel the running research. The full resource cost is refunded (no
 * partial-progress penalty — this game does not punish experimenting).
 * @returns {{ok:boolean, reason:string, refunded?:object}}
 */
export function cancelResearch() {
  const act = activeResearch();
  if (!act) return { ok: false, reason: 'Nothing is being researched.' };
  queue().shift();
  const back = act.cost || {};
  refund(back);
  const t = getTech(act.key);
  addLog('research', 'Research cancelled: ' + ((t && t.name) || act.key), { key: act.key });
  emit('toast', { text: 'Research cancelled — resources refunded.', kind: 'warn' });
  markDirty();
  emit('state:changed', { reason: 'research:cancel', key: act.key });
  save();
  return { ok: true, reason: 'Cancelled.', refunded: back };
}

/** Full duration of a research order in seconds (drives the free-finish rule). */
function researchTotalSec(act) {
  if (!act) return 0;
  const dur = Number(act.dur);
  if (Number.isFinite(dur) && dur > 0) return dur;
  return Math.max(1, (Number(act.endAt) - Number(act.startAt)) / 1000);
}

/**
 * Finish the running research early.
 * Under QUEUE.freeFinishSec remaining it is free; otherwise it costs gold
 * (SPEEDUP.goldFor) and `useGold` must be true.
 * @param {boolean} [useGold=true] pass false to only take the free finish
 * @returns {{ok:boolean, reason:string, gold?:number, free?:boolean}}
 */
export function speedUpResearch(useGold) {
  const act = activeResearch();
  if (!act) return { ok: false, reason: 'Nothing is being researched.' };
  const now = Date.now();
  const remaining = Math.max(0, Math.ceil((act.endAt - now) / 1000));
  const total = researchTotalSec(act);
  const free = SPEEDUP.isFree(remaining, total);
  const gold = SPEEDUP.goldFor(remaining, total);

  if (!free) {
    if (useGold === false) {
      return { ok: false, reason: formatTime(remaining) + ' left — costs ' + gold + ' gold.' };
    }
    if ((Number(S.res.gold) || 0) < gold) {
      emit('toast', { text: 'Not enough gold (' + gold + ' needed).', kind: 'warn' });
      return { ok: false, reason: 'Not enough gold.', gold };
    }
    S.res.gold = (Number(S.res.gold) || 0) - gold;
    emit('res:changed', S.res);
  }
  act.endAt = now;
  const done = tickResearch(now);
  markDirty();
  save();
  return {
    ok: done.length > 0,
    reason: done.length > 0 ? 'Completed.' : 'Could not complete.',
    gold: free ? 0 : gold,
    free
  };
}

/**
 * Advance the research queue. Safe to call every tick and after an offline gap
 * (an order whose endAt is far in the past simply completes).
 * @param {number} [now=Date.now()] wall clock ms
 * @returns {object[]} the orders that completed on this call
 */
export function tickResearch(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const q = queue();
  const done = [];
  while (q.length > 0) {
    const entry = q[0];
    if (!entry || typeof entry.key !== 'string' || !getTech(entry.key)) {
      q.shift();
      continue;
    }
    if (!(Number(entry.endAt) <= t)) break;
    q.shift();
    const def = getTech(entry.key);
    const target = Math.max(1, Math.min(Math.floor(Number(entry.toLevel) || 1), def.maxLevel));
    if (getTechLevel(entry.key) < target) S.tech[entry.key] = target;
    done.push(entry);
    addLog('research', 'Research complete: ' + def.name + ' Lv.' + target, {
      key: entry.key, level: target
    });
    emit('research:done', {
      key: entry.key,
      name: def.name,
      branch: def.branch,
      level: target,
      bonus: def.bonus(target)
    });
    emit('toast', { text: def.name + ' Lv.' + target + ' complete.', kind: 'ok' });
  }
  if (done.length > 0) {
    markDirty();
    emit('state:changed', { reason: 'research:done', count: done.length });
  }
  return done;
}

/**
 * Progress of the running research for the UI / HUD.
 * @param {number} [now=Date.now()]
 * @returns {{active:boolean, key?:string, name?:string, branch?:string, icon?:string,
 *            level?:number, startAt?:number, endAt?:number, total?:number,
 *            remaining?:number, elapsed?:number, pct?:number,
 *            free?:boolean, gold?:number}}
 */
export function researchProgress(now) {
  const act = activeResearch();
  if (!act) return { active: false };
  const t = typeof now === 'number' ? now : Date.now();
  const total = Math.max(1, Math.floor(Number(act.dur) || Math.ceil((act.endAt - act.startAt) / 1000)));
  const remaining = Math.max(0, Math.ceil((act.endAt - t) / 1000));
  const elapsed = Math.max(0, total - remaining);
  const def = getTech(act.key) || { name: act.key, branch: '', icon: 'tech_economy' };
  return {
    active: true,
    key: act.key,
    name: def.name,
    branch: def.branch,
    icon: def.icon,
    level: act.toLevel,
    startAt: act.startAt,
    endAt: act.endAt,
    total,
    remaining,
    elapsed,
    pct: Math.max(0, Math.min(1, elapsed / total)),
    free: SPEEDUP.isFree(remaining, total),
    gold: SPEEDUP.goldFor(remaining, total)
  };
}
