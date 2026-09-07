// js/engine/bonus.js — the single source of truth for every derived multiplier.
// Sums technology levels, ASSIGNED officer passives and building effects into one
// cached map, and computes the player's total power score.
// Exports: getBonus, getBonusPct, getAllBonuses, recomputeBonuses, invalidateBonuses,
//          getEffectTotal, getBuildingEffect, buildingLevels, getPower, powerBreakdown,
//          bonusSources
//
// Imports: engine/state.js + js/data/* only. Never import another js/engine/* module
// from here — economy.js, build.js, combat.js and friends all depend on this one.

import { S } from './state.js';
import { on } from '../util/events.js';
import { POWER_WEIGHTS } from '../data/balance.js';
import { BONUS_KEYS, TECH, getTechBonus } from '../data/tech.js';
import { BUILDINGS, getEffect } from '../data/buildings.js';
import { OFFICERS, officerBonus } from '../data/officers.js';
import { UNITS } from '../data/units.js';

/** Fast membership test for "is this key a real bonus key". */
const BONUS_SET = (() => {
  const s = Object.create(null);
  for (let i = 0; i < BONUS_KEYS.length; i++) s[BONUS_KEYS[i]] = true;
  return s;
})();

/**
 * Building-effect keys that must NOT be summed across buildings.
 * 'unlock.tier' is meaningful per factory only (barracks vs hangar vs ...).
 */
const EFFECT_SKIP_AGGREGATE = { 'unlock.tier': true };

/** Building-effect keys aggregated by MAX rather than SUM. */
const EFFECT_MAX_AGGREGATE = { 'trade.rate': true, 'map.vision': true };

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/** @type {{bonuses:Object<string,number>, effects:Object<string,number>, byBuilding:Object<string,Object<string,number>>, levels:Object<string,number>, stamp:number}|null} */
let cache = null;
let stamp = 0;

/** Drop the cached bonus map; the next read recomputes it. */
export function invalidateBonuses() {
  cache = null;
}

// Anything that changes buildings, tech or officers emits this.
on('state:changed', invalidateBonuses);

/**
 * Force a recompute and return the fresh bonus map.
 * @returns {Object<string,number>} bonusKey -> summed fraction
 */
export function recomputeBonuses() {
  cache = null;
  return getAllBonuses();
}

/** Build (or reuse) the whole derived map. */
function ensure() {
  if (cache) return cache;

  /** @type {Object<string,number>} */
  const bonuses = Object.create(null);
  for (let i = 0; i < BONUS_KEYS.length; i++) bonuses[BONUS_KEYS[i]] = 0;

  /** @type {Object<string,number>} */
  const effects = Object.create(null);
  /** @type {Object<string,Object<string,number>>} */
  const byBuilding = Object.create(null);
  /** @type {Object<string,number>} */
  const levels = Object.create(null);

  // ---- buildings -----------------------------------------------------
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    if (!b || typeof b.key !== 'string') continue;
    const lv = Math.floor(Number(b.level) || 0);
    if (lv > (levels[b.key] || 0)) levels[b.key] = lv;
    if (lv < 1 || !BUILDINGS[b.key]) continue;

    let eff = {};
    try {
      eff = getEffect(b.key, lv) || {};
    } catch (err) {
      console.warn('[bonus] effect() failed for ' + b.key, err);
      eff = {};
    }
    // keep the best (highest-level) instance's effects per building key
    const prev = byBuilding[b.key];
    if (!prev || lv >= (prev.__level || 0)) {
      const copy = Object.create(null);
      for (const k in eff) {
        if (Object.prototype.hasOwnProperty.call(eff, k)) copy[k] = num(eff[k]);
      }
      copy.__level = lv;
      byBuilding[b.key] = copy;
    }

    for (const k in eff) {
      if (!Object.prototype.hasOwnProperty.call(eff, k)) continue;
      const v = num(eff[k]);
      if (!v) continue;
      if (BONUS_SET[k]) bonuses[k] += v;
      if (EFFECT_SKIP_AGGREGATE[k]) continue;
      if (EFFECT_MAX_AGGREGATE[k]) {
        effects[k] = Math.max(effects[k] || 0, v);
      } else {
        effects[k] = (effects[k] || 0) + v;
      }
    }
  }

  // ---- technology ----------------------------------------------------
  const tech = S.tech && typeof S.tech === 'object' ? S.tech : {};
  for (const key in tech) {
    if (!Object.prototype.hasOwnProperty.call(tech, key)) continue;
    if (!TECH[key]) continue;
    const lv = Math.floor(Number(tech[key]) || 0);
    if (lv < 1) continue;
    let gained = {};
    try {
      gained = getTechBonus(key, lv) || {};
    } catch (err) {
      console.warn('[bonus] tech bonus failed for ' + key, err);
      gained = {};
    }
    for (const k in gained) {
      if (!Object.prototype.hasOwnProperty.call(gained, k)) continue;
      if (!BONUS_SET[k]) continue;
      bonuses[k] += num(gained[k]);
    }
  }

  // ---- officers (ASSIGNED only) --------------------------------------
  const owned = (S.officers && S.officers.owned) || {};
  for (const key in owned) {
    if (!Object.prototype.hasOwnProperty.call(owned, key)) continue;
    if (!OFFICERS[key]) continue;
    const o = owned[key];
    if (!o || !o.assigned) continue; // passives only apply while deployed
    let gained = {};
    try {
      gained = officerBonus(key, o.level, o.stars) || {};
    } catch (err) {
      console.warn('[bonus] officer bonus failed for ' + key, err);
      gained = {};
    }
    for (const k in gained) {
      if (!Object.prototype.hasOwnProperty.call(gained, k)) continue;
      if (!BONUS_SET[k]) continue;
      bonuses[k] += num(gained[k]);
    }
  }

  // round away float noise
  for (const k in bonuses) {
    bonuses[k] = Math.round(bonuses[k] * 100000) / 100000;
  }

  stamp += 1;
  cache = { bonuses, effects, byBuilding, levels, stamp };
  return cache;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

// ---------------------------------------------------------------------------
// Public reads
// ---------------------------------------------------------------------------

/**
 * The summed value of a bonus key, as an additive fraction (0.25 === +25%).
 * Unknown keys return 0, so callers can always do `1 + getBonus(k)`.
 * @param {string} key one of BONUS_KEYS
 * @returns {number}
 */
export function getBonus(key) {
  const c = ensure();
  const v = c.bonuses[key];
  return typeof v === 'number' ? v : 0;
}

/** `1 + getBonus(key)`, floored at 0.05 so nothing can ever go negative-multiplier. */
export function getBonusPct(key) {
  return Math.max(0.05, 1 + getBonus(key));
}

/** A defensive copy of the whole bonus map. */
export function getAllBonuses() {
  const c = ensure();
  const out = {};
  for (let i = 0; i < BONUS_KEYS.length; i++) out[BONUS_KEYS[i]] = c.bonuses[BONUS_KEYS[i]] || 0;
  return out;
}

/**
 * Total value of a BUILDING EFFECT key across every built building
 * (e.g. 'march.slots', 'heal.capacity', 'queue.build', 'officer.slots', 'wall.hp').
 * 'unlock.tier' is deliberately excluded — use getBuildingEffect() for that.
 * @param {string} key
 * @returns {number}
 */
export function getEffectTotal(key) {
  const c = ensure();
  const v = c.effects[key];
  return typeof v === 'number' ? v : 0;
}

/**
 * One specific building's effect value at its current level.
 * @param {string} buildingKey e.g. 'hangar'
 * @param {string} effectKey e.g. 'unlock.tier'
 * @returns {number} 0 when the building is not built
 */
export function getBuildingEffect(buildingKey, effectKey) {
  const c = ensure();
  const m = c.byBuilding[buildingKey];
  if (!m) return 0;
  const v = m[effectKey];
  return typeof v === 'number' ? v : 0;
}

/**
 * {buildingKey: highestLevel} for every building the player owns
 * (level 0 = under construction, never built before).
 * @returns {Object<string,number>}
 */
export function buildingLevels() {
  const c = ensure();
  const out = {};
  for (const k in c.levels) {
    if (Object.prototype.hasOwnProperty.call(c.levels, k)) out[k] = c.levels[k];
  }
  return out;
}

/**
 * Where a given bonus comes from — for tooltips.
 * @param {string} key
 * @returns {{from:string, label:string, value:number}[]}
 */
export function bonusSources(key) {
  const out = [];
  if (!BONUS_SET[key]) return out;

  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    const lv = Math.floor(Number(b && b.level) || 0);
    if (lv < 1 || !BUILDINGS[b.key]) continue;
    const v = num((getEffect(b.key, lv) || {})[key]);
    if (v) out.push({ from: 'building', label: BUILDINGS[b.key].name + ' Lv' + lv, value: v });
  }

  const tech = S.tech || {};
  for (const tk in tech) {
    if (!Object.prototype.hasOwnProperty.call(tech, tk) || !TECH[tk]) continue;
    const lv = Math.floor(Number(tech[tk]) || 0);
    if (lv < 1) continue;
    const v = num((getTechBonus(tk, lv) || {})[key]);
    if (v) out.push({ from: 'tech', label: TECH[tk].name + ' Lv' + lv, value: v });
  }

  const owned = (S.officers && S.officers.owned) || {};
  for (const ok in owned) {
    if (!Object.prototype.hasOwnProperty.call(owned, ok) || !OFFICERS[ok]) continue;
    const o = owned[ok];
    if (!o || !o.assigned) continue;
    const v = num((officerBonus(ok, o.level, o.stars) || {})[key]);
    if (v) out.push({ from: 'officer', label: OFFICERS[ok].name, value: v });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Power score
// ---------------------------------------------------------------------------

/**
 * Full power breakdown. Also the implementation behind getPower().
 * @returns {{buildings:number, tech:number, army:number, officers:number, total:number}}
 */
export function powerBreakdown() {
  const W = POWER_WEIGHTS;

  let buildings = 0;
  const blds = Array.isArray(S.buildings) ? S.buildings : [];
  for (let i = 0; i < blds.length; i++) {
    const b = blds[i];
    if (!b || !BUILDINGS[b.key]) continue;
    const lv = Math.floor(Number(b.level) || 0);
    if (lv < 1) continue;
    let p = W.building * Math.pow(lv, W.buildingExp);
    if (b.key === 'hq') p *= W.hqBonus;
    buildings += p;
  }

  let tech = 0;
  const tk = S.tech && typeof S.tech === 'object' ? S.tech : {};
  for (const k in tk) {
    if (!Object.prototype.hasOwnProperty.call(tk, k) || !TECH[k]) continue;
    const lv = Math.floor(Number(tk[k]) || 0);
    if (lv < 1) continue;
    tech += W.tech * Math.pow(lv, W.techExp);
  }

  let army = 0;
  const ar = S.army && typeof S.army === 'object' ? S.army : {};
  for (const k in ar) {
    if (!Object.prototype.hasOwnProperty.call(ar, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const e = ar[k] || {};
    const alive = Math.max(0, Math.floor(Number(e.count) || 0));
    const hurt = Math.max(0, Math.floor(Number(e.wounded) || 0));
    army += u.power * alive * W.unit + u.power * hurt * W.wounded;
  }

  let officers = 0;
  const owned = (S.officers && S.officers.owned) || {};
  for (const k in owned) {
    if (!Object.prototype.hasOwnProperty.call(owned, k)) continue;
    const def = OFFICERS[k];
    if (!def) continue;
    const o = owned[k] || {};
    const level = Math.max(1, Math.floor(Number(o.level) || 1));
    const stars = Math.max(1, Math.floor(Number(o.stars) || 1));
    const rarityMult = W.officerRarity[def.rarity] || 1;
    const base = W.officerBase
      + level * W.officerPerLevel
      + Math.pow(Math.max(0, stars - 1), W.officerStarExp) * W.officerPerStar;
    officers += base * rarityMult;
  }

  buildings = Math.round(buildings);
  tech = Math.round(tech);
  army = Math.round(army);
  officers = Math.round(officers);

  return { buildings, tech, army, officers, total: buildings + tech + army + officers };
}

/**
 * Total power. Writes the result into S.player.power as a side effect so the
 * HUD and the save file always agree with the live calculation.
 * @returns {number}
 */
export function getPower() {
  const p = powerBreakdown();
  S.player.power = p.total;
  return p.total;
}
