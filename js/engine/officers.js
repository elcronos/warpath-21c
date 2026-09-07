// js/engine/officers.js — commander roster: gacha recruitment, fragments, stars,
// levelling, slot assignment, and the aggregated passive bonuses consumed by engine/bonus.js.
// Mutates S.officers and emits 'toast', 'log', 'state:changed', 'res:changed'.
// Exports: GARRISON_SLOT, XP_PER_GOLD, RESERVE_SHARE, marchSlot,
//          ensureOfficer, isOwned, ownedList, officerInfo,
//          recruit, addFragments, promoteStar, canPromote, levelUp, grantXp,
//          officerSlots, usedSlots, assign, unassign, unassignSlot, officerInSlot,
//          assignments, getOfficerBonuses, getOfficerBattleSkill, officerPower, rng

import { emit } from '../util/events.js';
import { mulberry32, clamp } from '../util/fmt.js';
import { S, levelOf, addLog, markDirty, save } from './state.js';
import { POWER_WEIGHTS } from '../data/balance.js';
import { getEffect } from '../data/buildings.js';
import {
  OFFICERS, OFFICER_KEYS, RARITY, getOfficer, officerBonus, officerSkill,
  fragsToNextStar, maxLevelFor, officerXpForLevel, starMult,
  RECRUIT_POOL, RECRUIT_WEIGHT_TOTAL, PITY_COUNT, DRAW_COST
} from '../data/officers.js';

/** The always-available base assignment slot. */
export const GARRISON_SLOT = 'garrison';

/** Gold -> officer XP conversion used by levelUp({gold}). */
export const XP_PER_GOLD = 25;

/** Share of their passives that owned-but-unassigned commanders contribute. */
export const RESERVE_SHARE = 0.25;

/**
 * Canonical slot name for a march's leader.
 * @param {string|number} marchId
 * @returns {string}
 */
export function marchSlot(marchId) {
  return 'march:' + String(marchId);
}

// ---------------------------------------------------------------------------
// Deterministic RNG
// ---------------------------------------------------------------------------
//
// state.migrate() rebuilds S.officers from a fixed shape and does NOT carry an
// arbitrary `rngSeed` across a reload, so the seed is DERIVED from fields that
// do persist (map.seed + created) and then cached on S.officers.rngSeed for the
// session. Because every draw also mixes in the persisted draw counter, the
// draw sequence is identical before and after a reload. If state.js later
// preserves officers.rngSeed, behaviour is unchanged.

/** Ensure S.officers exists and has its bookkeeping fields. */
function roster() {
  if (!S.officers || typeof S.officers !== 'object') {
    S.officers = { owned: {}, fragments: {}, pity: 0, draws: 0 };
  }
  const o = S.officers;
  if (!o.owned || typeof o.owned !== 'object') o.owned = {};
  if (!o.fragments || typeof o.fragments !== 'object') o.fragments = {};
  if (!Number.isFinite(Number(o.pity))) o.pity = 0;
  if (!Number.isFinite(Number(o.draws))) o.draws = 0;
  if (!Number.isFinite(Number(o.rngSeed)) || Number(o.rngSeed) <= 0) {
    const base = ((Math.floor(Number(S.map && S.map.seed) || 1) >>> 0) ^
      (Math.floor(Number(S.created) || 0) >>> 0)) >>> 0;
    o.rngSeed = base || 0x9e3779b9;
  }
  return o;
}

/**
 * A mulberry32 stream for draw number `n` (0-based). Deterministic across
 * reloads because both the seed and the draw counter are persisted.
 * @param {number} n
 * @returns {() => number}
 */
export function rng(n) {
  const o = roster();
  const seed = ((Number(o.rngSeed) >>> 0) + Math.imul(Math.floor(n) >>> 0, 0x9e3779b1)) >>> 0;
  return mulberry32(seed || 1);
}

// ---------------------------------------------------------------------------
// Roster access
// ---------------------------------------------------------------------------

/** True when the commander is on the roster. */
export function isOwned(key) {
  const o = roster();
  return !!o.owned[key];
}

/**
 * Get (creating if needed) an owned-officer record.
 * @param {string} key
 * @returns {{level:number,stars:number,xp:number,assigned:string|null}|null}
 */
export function ensureOfficer(key) {
  if (!getOfficer(key)) return null;
  const o = roster();
  if (!o.owned[key]) o.owned[key] = { level: 1, stars: 1, xp: 0, assigned: null };
  const rec = o.owned[key];
  rec.level = clamp(Math.floor(Number(rec.level) || 1), 1, maxLevelFor(key));
  rec.stars = clamp(Math.floor(Number(rec.stars) || 1), 1, OFFICERS[key].maxStars);
  rec.xp = Math.max(0, Math.floor(Number(rec.xp) || 0));
  if (typeof rec.assigned !== 'string' || !rec.assigned) rec.assigned = null;
  return rec;
}

/** Fragments held for a commander. */
function frags(key) {
  const o = roster();
  const v = Number(o.fragments[key]);
  return Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
}

/**
 * Full UI record for one commander (owned or not).
 * @param {string} key
 * @returns {object|null}
 */
export function officerInfo(key) {
  const def = getOfficer(key);
  if (!def) return null;
  const o = roster();
  const rec = o.owned[key] || null;
  const level = rec ? rec.level : 0;
  const stars = rec ? rec.stars : 0;
  const need = rec ? fragsToNextStar(key, stars) : 0;
  return {
    key: def.key,
    name: def.name,
    title: def.title,
    rarity: def.rarity,
    rarityMeta: RARITY[def.rarity],
    cls: def.cls,
    icon: def.icon,
    portrait: def.portrait,
    desc: def.desc,
    owned: !!rec,
    level,
    maxLevel: def.maxLevel,
    xp: rec ? rec.xp : 0,
    xpToNext: rec && level < def.maxLevel ? officerXpForLevel(level) : 0,
    stars,
    maxStars: def.maxStars,
    starMult: rec ? starMult(stars) : 1,
    fragments: frags(key),
    fragsToNextStar: need,
    canPromote: !!rec && need > 0 && frags(key) >= need,
    assigned: rec ? rec.assigned : null,
    bonuses: rec ? officerBonus(key, level, stars) : {},
    skill: rec ? officerSkill(key, stars) : officerSkill(key, 1),
    power: rec ? officerPower(key) : 0
  };
}

/**
 * Every commander, owned first, then by rarity (best first).
 * @param {{ownedOnly?:boolean}} [opts]
 * @returns {object[]}
 */
export function ownedList(opts) {
  const ownedOnly = !!(opts && opts.ownedOnly);
  const list = OFFICER_KEYS.map(officerInfo).filter(Boolean)
    .filter((i) => (ownedOnly ? i.owned : true));
  const rank = { SSR: 3, SR: 2, R: 1 };
  list.sort((a, b) => {
    if (a.owned !== b.owned) return a.owned ? -1 : 1;
    if (rank[b.rarity] !== rank[a.rarity]) return rank[b.rarity] - rank[a.rarity];
    if (b.stars !== a.stars) return b.stars - a.stars;
    return b.level - a.level;
  });
  return list;
}

/**
 * Power contribution of one owned commander (mirrors POWER_WEIGHTS).
 * @param {string} key
 * @returns {number}
 */
export function officerPower(key) {
  const def = getOfficer(key);
  const o = roster();
  const rec = def ? o.owned[key] : null;
  if (!rec) return 0;
  const w = POWER_WEIGHTS;
  const stars = Math.max(1, rec.stars);
  const base = w.officerBase +
    rec.level * w.officerPerLevel +
    Math.pow(stars - 1, w.officerStarExp) * w.officerPerStar;
  const mult = (w.officerRarity && w.officerRarity[def.rarity]) || 1;
  return Math.round(base * mult);
}

// ---------------------------------------------------------------------------
// Recruitment (gacha)
// ---------------------------------------------------------------------------

/**
 * Roll one rarity bucket from RECRUIT_POOL.
 * @param {() => number} rand
 * @returns {object} a RECRUIT_POOL entry
 */
function rollRarity(rand) {
  let r = rand() * RECRUIT_WEIGHT_TOTAL;
  for (let i = 0; i < RECRUIT_POOL.length; i++) {
    r -= RECRUIT_POOL[i].weight;
    if (r <= 0) return RECRUIT_POOL[i];
  }
  return RECRUIT_POOL[0];
}

function poolFor(rarity) {
  for (let i = 0; i < RECRUIT_POOL.length; i++) {
    if (RECRUIT_POOL[i].rarity === rarity) return RECRUIT_POOL[i];
  }
  return RECRUIT_POOL[0];
}

/** Perform exactly one draw, applying and updating the pity counter. */
function drawOnce() {
  const o = roster();
  const n = Math.floor(Number(o.draws) || 0);
  const rand = rng(n);
  const forced = (Number(o.pity) || 0) + 1 >= PITY_COUNT;
  const entry = forced ? poolFor('SSR') : rollRarity(rand);
  const keys = entry.keys && entry.keys.length ? entry.keys : OFFICER_KEYS;
  const key = keys[Math.floor(rand() * keys.length) % keys.length];

  o.draws = n + 1;
  if (entry.rarity === 'SSR') o.pity = 0;
  else o.pity = (Number(o.pity) || 0) + 1;

  const already = isOwned(key);
  const result = {
    key,
    name: OFFICERS[key].name,
    rarity: entry.rarity,
    isNew: !already,
    fragments: 0,
    pityForced: forced
  };
  if (already) {
    const amount = Math.max(1, Math.floor(Number(entry.fragsIfOwned) || 1));
    addFragments(key, amount, true);
    result.fragments = amount;
  } else {
    ensureOfficer(key);
  }
  return result;
}

/**
 * Recruit commanders with gold. `n` of 10 uses the discounted ten-pull.
 * @param {number} [n=1] 1 or 10
 * @returns {{ok:boolean, reason:string, gold:number, results:object[]}}
 */
export function recruit(n) {
  const count = Math.floor(Number(n) || 1) >= DRAW_COST.tenCount ? DRAW_COST.tenCount : 1;
  const cost = count === DRAW_COST.tenCount ? DRAW_COST.ten : DRAW_COST.single;
  if ((Number(S.res.gold) || 0) < cost) {
    emit('toast', { text: 'Not enough gold (' + cost + ' needed).', kind: 'warn' });
    return { ok: false, reason: 'Not enough gold.', gold: cost, results: [] };
  }
  S.res.gold = (Number(S.res.gold) || 0) - cost;
  emit('res:changed', S.res);

  const results = [];
  for (let i = 0; i < count; i++) results.push(drawOnce());

  const newOnes = results.filter((r) => r.isNew);
  const best = results.reduce((a, r) => {
    const rank = { R: 1, SR: 2, SSR: 3 };
    return !a || rank[r.rarity] > rank[a.rarity] ? r : a;
  }, null);
  addLog('officer', 'Recruited ' + count + ' commander' + (count === 1 ? '' : 's') +
    (newOnes.length ? ' — new: ' + newOnes.map((r) => r.name).join(', ') : ' — fragments only'), {
    results
  });
  if (best) {
    emit('toast', {
      text: best.isNew ? best.rarity + ' — ' + best.name + ' joins your staff!'
        : best.rarity + ' — ' + best.name + ' fragments acquired.',
      kind: best.rarity === 'SSR' ? 'ok' : 'info'
    });
  }
  markDirty();
  emit('state:changed', { reason: 'officer:recruit', count });
  save();
  return { ok: true, reason: 'Recruited.', gold: cost, results };
}

// ---------------------------------------------------------------------------
// Fragments & promotion
// ---------------------------------------------------------------------------

/**
 * Grant fragments for a commander.
 * @param {string} key
 * @param {number} amount
 * @param {boolean} [quiet] suppress the toast/state emit (used inside batches)
 * @returns {number} the new fragment total
 */
export function addFragments(key, amount, quiet) {
  if (!getOfficer(key)) return 0;
  const o = roster();
  const add = Math.max(0, Math.floor(Number(amount) || 0));
  if (add === 0) return frags(key);
  o.fragments[key] = frags(key) + add;
  markDirty();
  if (!quiet) {
    emit('toast', { text: '+' + add + ' ' + OFFICERS[key].name + ' fragments', kind: 'info' });
    emit('state:changed', { reason: 'officer:fragments', key });
    save();
  }
  return o.fragments[key];
}

/**
 * Can this commander be promoted right now?
 * @param {string} key
 * @returns {{ok:boolean, reason:string, need:number, have:number}}
 */
export function canPromote(key) {
  const def = getOfficer(key);
  if (!def) return { ok: false, reason: 'Unknown commander.', need: 0, have: 0 };
  const o = roster();
  const rec = o.owned[key];
  if (!rec) return { ok: false, reason: 'Not recruited yet.', need: 0, have: frags(key) };
  const need = fragsToNextStar(key, rec.stars);
  const have = frags(key);
  if (need <= 0) return { ok: false, reason: 'Already at maximum stars.', need: 0, have };
  if (have < need) {
    return { ok: false, reason: (need - have) + ' more fragments needed.', need, have };
  }
  return { ok: true, reason: 'Ready.', need, have };
}

/**
 * Spend fragments to add one star.
 * @param {string} key
 * @returns {{ok:boolean, reason:string, stars?:number}}
 */
export function promoteStar(key) {
  const check = canPromote(key);
  if (!check.ok) {
    emit('toast', { text: check.reason, kind: 'warn' });
    return { ok: false, reason: check.reason };
  }
  const o = roster();
  const rec = ensureOfficer(key);
  o.fragments[key] = frags(key) - check.need;
  rec.stars = Math.min(OFFICERS[key].maxStars, rec.stars + 1);
  addLog('officer', OFFICERS[key].name + ' promoted to ' + rec.stars + '★', { key, stars: rec.stars });
  emit('toast', { text: OFFICERS[key].name + ' is now ' + rec.stars + '★', kind: 'ok' });
  markDirty();
  emit('state:changed', { reason: 'officer:promote', key });
  save();
  return { ok: true, reason: 'Promoted.', stars: rec.stars };
}

// ---------------------------------------------------------------------------
// Levelling
// ---------------------------------------------------------------------------

/** Officer XP rate multiplier from the Officer Academy. */
function xpRate() {
  const lvl = levelOf('academy');
  if (lvl < 1) return 1;
  const eff = getEffect('academy', lvl);
  return 1 + (Number(eff['officer.xpRate']) || 0);
}

/**
 * Add raw XP to a commander, consuming it into levels.
 * @param {string} key
 * @param {number} xp
 * @returns {{ok:boolean, reason:string, level:number, gained:number, xp:number}}
 */
export function grantXp(key, xp) {
  const def = getOfficer(key);
  if (!def) return { ok: false, reason: 'Unknown commander.', level: 0, gained: 0, xp: 0 };
  const rec = ensureOfficer(key);
  if (!rec) return { ok: false, reason: 'Not recruited yet.', level: 0, gained: 0, xp: 0 };
  const add = Math.max(0, Math.round((Number(xp) || 0) * xpRate()));
  if (add <= 0) return { ok: false, reason: 'No XP to apply.', level: rec.level, gained: 0, xp: rec.xp };

  const before = rec.level;
  rec.xp += add;
  while (rec.level < def.maxLevel) {
    const need = officerXpForLevel(rec.level);
    if (rec.xp < need) break;
    rec.xp -= need;
    rec.level += 1;
  }
  if (rec.level >= def.maxLevel) {
    rec.level = def.maxLevel;
    rec.xp = 0;
  }
  return {
    ok: true,
    reason: 'Applied.',
    level: rec.level,
    gained: rec.level - before,
    xp: rec.xp
  };
}

/**
 * Level a commander using XP items or gold.
 *   levelUp('zhao', 500)            -> 500 XP
 *   levelUp('zhao', { xp: 500 })    -> 500 XP
 *   levelUp('zhao', { gold: 100 })  -> 100 gold worth of XP (XP_PER_GOLD each)
 * @param {string} key
 * @param {number|{xp?:number, gold?:number}} src
 * @returns {{ok:boolean, reason:string, level?:number, gained?:number, spentGold?:number}}
 */
export function levelUp(key, src) {
  const def = getOfficer(key);
  if (!def) return { ok: false, reason: 'Unknown commander.' };
  const rec = ensureOfficer(key);
  if (!rec) return { ok: false, reason: 'Not recruited yet.' };
  if (rec.level >= def.maxLevel) {
    emit('toast', { text: def.name + ' is at maximum level.', kind: 'warn' });
    return { ok: false, reason: 'Already at maximum level.' };
  }

  let xp = 0;
  let spentGold = 0;
  if (typeof src === 'number') {
    xp = Math.max(0, Math.floor(src));
  } else if (src && typeof src === 'object') {
    xp = Math.max(0, Math.floor(Number(src.xp) || 0));
    const gold = Math.max(0, Math.floor(Number(src.gold) || 0));
    if (gold > 0) {
      if ((Number(S.res.gold) || 0) < gold) {
        emit('toast', { text: 'Not enough gold.', kind: 'warn' });
        return { ok: false, reason: 'Not enough gold.' };
      }
      S.res.gold = (Number(S.res.gold) || 0) - gold;
      spentGold = gold;
      xp += gold * XP_PER_GOLD;
      emit('res:changed', S.res);
    }
  }
  if (xp <= 0) return { ok: false, reason: 'Nothing to spend.' };

  const res = grantXp(key, xp);
  if (res.gained > 0) {
    addLog('officer', def.name + ' reached level ' + res.level, { key, level: res.level });
    emit('toast', { text: def.name + ' → Lv.' + res.level, kind: 'ok' });
  }
  markDirty();
  emit('state:changed', { reason: 'officer:level', key });
  save();
  return { ok: true, reason: 'Applied.', level: res.level, gained: res.gained, spentGold };
}

// ---------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------

/**
 * How many commanders may be assigned at once.
 * One garrison slot always exists; the Officer Academy adds more.
 * @returns {number}
 */
export function officerSlots() {
  const lvl = levelOf('academy');
  if (lvl < 1) return 1;
  const eff = getEffect('academy', lvl);
  return Math.max(1, Math.floor(Number(eff['officer.slots']) || 1));
}

/** Commanders currently holding a slot. */
export function usedSlots() {
  const o = roster();
  let n = 0;
  for (const k in o.owned) {
    if (!Object.prototype.hasOwnProperty.call(o.owned, k)) continue;
    if (o.owned[k] && typeof o.owned[k].assigned === 'string' && o.owned[k].assigned) n += 1;
  }
  return n;
}

/**
 * {slotName: officerKey} for every filled slot.
 * @returns {Object<string,string>}
 */
export function assignments() {
  const o = roster();
  const out = {};
  for (const k in o.owned) {
    if (!Object.prototype.hasOwnProperty.call(o.owned, k)) continue;
    const rec = o.owned[k];
    if (rec && typeof rec.assigned === 'string' && rec.assigned) out[rec.assigned] = k;
  }
  return out;
}

/**
 * Which commander holds `slotName`, or null.
 * @param {string} slotName
 * @returns {string|null}
 */
export function officerInSlot(slotName) {
  return assignments()[String(slotName)] || null;
}

/**
 * Assign a commander to a slot ('garrison' or marchSlot(id)).
 * Any commander already in that slot is displaced.
 * @param {string} key
 * @param {string} slotName
 * @returns {{ok:boolean, reason:string, displaced?:string}}
 */
export function assign(key, slotName) {
  const def = getOfficer(key);
  if (!def) return { ok: false, reason: 'Unknown commander.' };
  const slot = String(slotName || '').trim();
  if (!slot) return { ok: false, reason: 'No slot given.' };
  const o = roster();
  const rec = o.owned[key];
  if (!rec) {
    emit('toast', { text: def.name + ' has not been recruited.', kind: 'warn' });
    return { ok: false, reason: 'Not recruited yet.' };
  }
  if (rec.assigned === slot) return { ok: true, reason: 'Already assigned.' };

  const current = officerInSlot(slot);
  const willUse = usedSlots() + (rec.assigned ? 0 : 1) - (current && current !== key ? 1 : 0);
  if (willUse > officerSlots()) {
    emit('toast', { text: 'No free command slots — upgrade the Officer Academy.', kind: 'warn' });
    return { ok: false, reason: 'No free command slots.' };
  }
  let displaced;
  if (current && current !== key) {
    o.owned[current].assigned = null;
    displaced = current;
  }
  rec.assigned = slot;
  markDirty();
  emit('state:changed', { reason: 'officer:assign', key, slot });
  save();
  return { ok: true, reason: 'Assigned.', displaced };
}

/**
 * Remove a commander from whatever slot they hold.
 * @param {string} key
 * @returns {{ok:boolean, reason:string, slot?:string}}
 */
export function unassign(key) {
  const o = roster();
  const rec = o.owned[key];
  if (!rec || !rec.assigned) return { ok: false, reason: 'Not assigned.' };
  const slot = rec.assigned;
  rec.assigned = null;
  markDirty();
  emit('state:changed', { reason: 'officer:unassign', key, slot });
  save();
  return { ok: true, reason: 'Unassigned.', slot };
}

/**
 * Empty a slot by name (used when a march ends).
 * @param {string} slotName
 * @returns {{ok:boolean, reason:string, key?:string}}
 */
export function unassignSlot(slotName) {
  const key = officerInSlot(slotName);
  if (!key) return { ok: false, reason: 'Slot is empty.' };
  const res = unassign(key);
  return { ok: res.ok, reason: res.reason, key };
}

/**
 * Drop assignments pointing at marches that no longer exist.
 *
 * Marches are spliced out of S.map.marches from several places in
 * engine/worldmap.js and none of them can free the slot themselves, so a
 * returned column would otherwise hold its commander (and their full,
 * non-reserve passives) forever. Idempotent and O(owned) — the loop calls it
 * every tick, and js/main.js calls it once on boot so an already-corrupt save
 * repairs itself without a migration. A returning march is still in
 * S.map.marches, so an in-flight leader stays assigned.
 * @returns {boolean} true when something was released
 */
export function reconcileSlots() {
  const o = roster();
  const live = Object.create(null);
  const ms = (S.map && Array.isArray(S.map.marches)) ? S.map.marches : [];
  for (let i = 0; i < ms.length; i++) {
    if (ms[i] && ms[i].id) live[marchSlot(ms[i].id)] = true;
  }
  let changed = false;
  for (const k in o.owned) {
    if (!Object.prototype.hasOwnProperty.call(o.owned, k)) continue;
    const rec = o.owned[k];
    if (!rec || typeof rec.assigned !== 'string' || !rec.assigned) continue;
    if (rec.assigned === GARRISON_SLOT || live[rec.assigned]) continue;
    rec.assigned = null;
    changed = true;
  }
  // One event for the whole batch: unassign() would save() per officer, and
  // this runs inside the tick. bonus.js recomputes off 'state:changed'.
  if (changed) { markDirty(); emit('state:changed', { reason: 'officer:reconcile' }); }
  return changed;
}

// ---------------------------------------------------------------------------
// Aggregated output for engine/bonus.js and engine/combat.js
// ---------------------------------------------------------------------------

/**
 * Sum of every owned commander's passives, as a {bonusKey: fraction} map.
 * Assigned commanders contribute in full; unassigned ones contribute
 * RESERVE_SHARE of their passives (they are still on the staff).
 * @param {{assignedOnly?:boolean, slot?:string}} [opts]
 *        assignedOnly: ignore the reserve share entirely.
 *        slot: only count the commander in this slot (plus the garrison).
 * @returns {Object<string,number>}
 */
export function getOfficerBonuses(opts) {
  const o = roster();
  const assignedOnly = !!(opts && opts.assignedOnly);
  const onlySlot = opts && typeof opts.slot === 'string' ? opts.slot : null;
  const out = {};
  for (const key in o.owned) {
    if (!Object.prototype.hasOwnProperty.call(o.owned, key)) continue;
    if (!getOfficer(key)) continue;
    const rec = o.owned[key];
    if (!rec) continue;
    const isAssigned = typeof rec.assigned === 'string' && !!rec.assigned;
    if (onlySlot && rec.assigned !== onlySlot && rec.assigned !== GARRISON_SLOT) continue;
    let share;
    if (isAssigned) share = 1;
    else if (assignedOnly || onlySlot) continue;
    else share = RESERVE_SHARE;

    const b = officerBonus(key, rec.level, rec.stars);
    for (const bk in b) {
      if (!Object.prototype.hasOwnProperty.call(b, bk)) continue;
      out[bk] = Math.round(((out[bk] || 0) + b[bk] * share) * 10000) / 10000;
    }
  }
  return out;
}

/**
 * The star-scaled battle skill of an OWNED commander (null when not recruited).
 * engine/combat.js reads `.effect.kind` and applies it to the owning army.
 * @param {string} key
 * @returns {{name:string,desc:string,trigger:string,effect:object}|null}
 */
export function getOfficerBattleSkill(key) {
  const o = roster();
  const rec = o.owned[key];
  if (!rec) return null;
  return officerSkill(key, rec.stars);
}
