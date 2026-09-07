// js/engine/combat.js — the battle resolver used by the world map, campaign and PvE.
// Exports: resolveBattle, simulateBattle, applyBattleResult, makeForce, forcePower,
//          forceCount, forceLoad, battleSummary, hospitalCapacity, woundedTotal,
//          TARGET_PRIORITY, ATTACKER_WOUND_RATIO, SKILL_RECAST, WALL_ABSORB
//
// ---------------------------------------------------------------------------
// HOW A BATTLE WORKS
// ---------------------------------------------------------------------------
// A *force* is a plain object:
//   {
//     units:      { [unitKey]: count },        // required
//     officer:    officerKey | null,           // optional, drives the battle skill
//     officerStars: number,                    // optional (default: S.officers, else 1)
//     bonuses:    { atk:{cls:v}, def:{cls:v}, hp:{cls:v}, 'load.capacity':v },
//     isDefender: boolean,                     // set automatically by resolveBattle
//     wallLevel:  number,                      // defender only, adds a wall HP pool
//     atHome:     boolean,                     // defender fighting at its own city
//     name:       string                       // label used in the report text
//   }
// `bonuses` values are ADDITIVE FRACTIONS (0.15 === +15%), exactly the shape the
// tech/officer bonus tables produce. Three notations are accepted for each entry:
// flat ('atk.tank'), nested (bonuses.atk.tank) or grouped (bonuses.atkMult.tank).
//
// Each round has two phases:
//   phase 1 — infantry, tanks and aircraft of BOTH sides fire simultaneously
//             (damage is snapshotted, then applied, so nobody gets a free round)
//   phase 2 — artillery fires, at the survivors of phase 1
// A 'firstStrike' officer skill moves that army's artillery into phase 1.
//
// Damage for one attacking class:
//   raw   = sum(unit.atk * aliveCount) over that class's stacks
//   dmg   = raw * counter * counterUp * atkBonus * skillMult * artySupport * spread
//   dmg  *= COMBAT.defSoak / (COMBAT.defSoak + effectiveEnemyDef)
//   dmg  *= (1 - shield)                       // defender's shield skills
//   dmg  *= COMBAT.artilleryFragility          // when the target class is artillery
// Damage is subtracted from the target class's HP pools; a stack's alive count is
// always ceil(hpPool / effectiveUnitHp), so partial damage is remembered between
// rounds and no unit dies twice.
// ---------------------------------------------------------------------------

import { rngFrom, clamp, formatNum } from '../util/fmt.js';
import { emit } from '../util/events.js';
import { S, ensureUnit, addLog, markDirty, findBuilding } from './state.js';
import { UNITS, CLASSES, CLASS_META, counter } from '../data/units.js';
import { COMBAT, HOSPITAL_RATIO, RES_ORDER } from '../data/balance.js';
import { officerSkill, getOfficer } from '../data/officers.js';
import { getEffect } from '../data/buildings.js';

/** Attackers rarely recover their casualties: this share is wounded, the rest dead. */
export const ATTACKER_WOUND_RATIO = 0.1;

/** A 'roundStart' officer skill re-fires every this-many rounds. */
export const SKILL_RECAST = 3;

/** Share of an incoming damage packet a standing wall can soak. */
export const WALL_ABSORB = 0.5;

/** Hard ceiling on rounds, whatever the caller or COMBAT says. */
const HARD_MAX_ROUNDS = 20;

/** Minimum share of its defence a rended army keeps. */
const MIN_DEF_SHARE = 0.2;

/**
 * Preferred target of each class (the one it counters). Used as a tie-break;
 * the real choice is "highest counter multiplier among living enemy classes".
 */
export const TARGET_PRIORITY = {
  infantry: 'aircraft',
  tank: 'infantry',
  aircraft: 'tank',
  artillery: 'artillery'
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function n0(v) {
  const x = Number(v);
  return Number.isFinite(x) ? x : 0;
}

function intOf(v) {
  return Math.max(0, Math.floor(n0(v)));
}

/**
 * Read one additive bonus fraction out of a bonuses bag.
 * Accepts 'atk.tank', bonuses.atk.tank, bonuses.atkMult.tank or a scalar bonuses.atk.
 * @param {object} bonuses
 * @param {string} kind e.g. 'atk' | 'def' | 'hp' | 'load'
 * @param {string} sub e.g. 'tank' | 'capacity'
 * @returns {number}
 */
function bonusOf(bonuses, kind, sub) {
  if (!bonuses || typeof bonuses !== 'object') return 0;
  const flat = bonuses[kind + '.' + sub];
  if (typeof flat === 'number' && Number.isFinite(flat)) return flat;
  let grp = bonuses[kind];
  if (grp === undefined) grp = bonuses[kind + 'Mult'];
  if (typeof grp === 'number' && Number.isFinite(grp)) return grp;
  if (grp && typeof grp === 'object') {
    const v = grp[sub];
    if (typeof v === 'number' && Number.isFinite(v)) return v;
  }
  return 0;
}

/**
 * Build a normalised force object from a `{unitKey:count}` map.
 * @param {Object<string,number>} units
 * @param {object} [extra] officer, officerStars, bonuses, wallLevel, atHome, name
 * @returns {object} force
 */
export function makeForce(units, extra) {
  const e = extra || {};
  const clean = {};
  if (units && typeof units === 'object') {
    for (const k in units) {
      if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
      if (!UNITS[k]) continue;
      const c = intOf(units[k]);
      if (c > 0) clean[k] = c;
    }
  }
  return {
    units: clean,
    officer: typeof e.officer === 'string' ? e.officer : null,
    officerStars: e.officerStars,
    bonuses: e.bonuses || {},
    wallLevel: intOf(e.wallLevel),
    atHome: e.atHome,
    isDefender: !!e.isDefender,
    name: typeof e.name === 'string' ? e.name : ''
  };
}

/** Total headcount of a `{unitKey:count}` map. */
export function forceCount(units) {
  let n = 0;
  if (!units) return 0;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    n += intOf(units[k]);
  }
  return n;
}

/** Nominal power of a `{unitKey:count}` map. */
export function forcePower(units) {
  let p = 0;
  if (!units) return 0;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    const u = UNITS[k];
    if (u) p += u.power * intOf(units[k]);
  }
  return Math.round(p);
}

/**
 * Carry capacity of a `{unitKey:count}` map, including a load.capacity bonus.
 * @param {Object<string,number>} units
 * @param {object} [bonuses]
 * @returns {number}
 */
export function forceLoad(units, bonuses) {
  let l = 0;
  if (units) {
    for (const k in units) {
      if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
      const u = UNITS[k];
      if (u) l += u.load * intOf(units[k]);
    }
  }
  return Math.floor(l * (1 + Math.max(-0.9, bonusOf(bonuses, 'load', 'capacity'))));
}

// ---------------------------------------------------------------------------
// Side construction
// ---------------------------------------------------------------------------

function buildSide(force, isDefender, fallbackName) {
  const f = force && typeof force === 'object' ? force : { units: {} };
  const bonuses = f.bonuses || {};
  const stacks = [];
  const byClass = {};
  for (let i = 0; i < CLASSES.length; i++) byClass[CLASSES[i]] = [];

  const src = f.units && typeof f.units === 'object' ? f.units : {};
  const keys = Object.keys(src).filter((k) => UNITS[k] && intOf(src[k]) > 0);
  // Deterministic ordering: class order, then tier.
  keys.sort((a, b) => {
    const ua = UNITS[a];
    const ub = UNITS[b];
    const ca = CLASSES.indexOf(ua.cls) - CLASSES.indexOf(ub.cls);
    return ca !== 0 ? ca : ua.tier - ub.tier;
  });

  let startHp = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i];
    const u = UNITS[key];
    const count = intOf(src[key]);
    const hpMult = 1 + Math.max(-0.9, bonusOf(bonuses, 'hp', u.cls));
    const unitHp = Math.max(1, u.hp * hpMult);
    const st = {
      key,
      cls: u.cls,
      tier: u.tier,
      unit: u,
      start: count,
      count,
      unitHp,
      hpPool: unitHp * count,
      startHpPool: unitHp * count
    };
    stacks.push(st);
    byClass[u.cls].push(st);
    startHp += st.startHpPool;
  }

  const wallHp = (!isDefender || !f.wallLevel)
    ? 0
    : Math.max(0, n0(getEffect('wall', intOf(f.wallLevel))['wall.hp']));
  const wallDef = (!isDefender || !f.wallLevel)
    ? 0
    : Math.max(0, n0(getEffect('wall', intOf(f.wallLevel))['wall.defense']));

  const atHome = (typeof f.atHome === 'boolean')
    ? f.atHome
    : (isDefender && intOf(f.wallLevel) > 0);

  return {
    force: f,
    isDefender: !!isDefender,
    name: f.name || fallbackName,
    bonuses,
    stacks,
    byClass,
    startHp,
    startWallHp: wallHp,
    wallHp,
    wallDef,
    atHome: !!atHome,
    officer: typeof f.officer === 'string' ? f.officer : null,
    officerStars: resolveStars(f),
    effects: [],
    firedBattleStart: false,
    routed: false
  };
}

function resolveStars(f) {
  const explicit = Math.floor(n0(f.officerStars));
  if (explicit >= 1) return explicit;
  const key = typeof f.officer === 'string' ? f.officer : null;
  if (key && S.officers && S.officers.owned && S.officers.owned[key]) {
    return Math.max(1, Math.floor(n0(S.officers.owned[key].stars)) || 1);
  }
  return 1;
}

/** Living headcount of a side. */
function aliveCount(side) {
  let n = 0;
  for (let i = 0; i < side.stacks.length; i++) n += side.stacks[i].count;
  return n;
}

/** Living HP pool of a side (walls excluded). */
function aliveHp(side) {
  let h = 0;
  for (let i = 0; i < side.stacks.length; i++) h += Math.max(0, side.stacks[i].hpPool);
  return h;
}

/** Living headcount of one class. */
function classCount(side, cls) {
  const arr = side.byClass[cls] || [];
  let n = 0;
  for (let i = 0; i < arr.length; i++) n += arr[i].count;
  return n;
}

/** Snapshot of remaining units as a `{unitKey:count}` map. */
function remainingMap(side) {
  const out = {};
  for (let i = 0; i < side.stacks.length; i++) {
    const st = side.stacks[i];
    if (st.count > 0) out[st.key] = st.count;
  }
  return out;
}

/** Average per-unit defence of a class, weighted by living headcount. */
function classDefence(side, cls) {
  const arr = side.byClass[cls] || [];
  let sum = 0;
  let n = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].count <= 0) continue;
    sum += arr[i].unit.def * arr[i].count;
    n += arr[i].count;
  }
  if (n === 0) return 0;
  const base = sum / n;
  return base * (1 + Math.max(-0.9, bonusOf(side.bonuses, 'def', cls))) * (1 + side.wallDef);
}

// ---------------------------------------------------------------------------
// Officer battle skills
// ---------------------------------------------------------------------------

function effectActive(e, round) {
  return e.rounds === 0 || round <= e.until;
}

function skillDamageMult(side, round, atkCls, defCls) {
  let m = 1;
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (!effectActive(e, round)) continue;
    if (e.kind === 'damage' && (!e.cls || e.cls === atkCls)) m *= 1 + e.value;
    else if (e.kind === 'focus' && (!e.cls || e.cls === atkCls) && (!e.vs || e.vs === defCls)) m *= 1 + e.value;
  }
  return m;
}

function skillShieldMult(side, round) {
  let m = 1;
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (!effectActive(e, round)) continue;
    if (e.kind === 'shield') m *= Math.max(0.1, 1 - e.value);
  }
  return m;
}

function skillRend(side, round) {
  let r = 0;
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (!effectActive(e, round)) continue;
    if (e.kind === 'rend') r += e.value;
    if (typeof e.rend === 'number') r += e.rend;
  }
  return r;
}

function skillCounterUp(side, round) {
  let c = 0;
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (!effectActive(e, round)) continue;
    if (e.kind === 'counterUp') c += e.value;
  }
  return c;
}

function hasFirstStrike(side, round) {
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (effectActive(e, round) && e.kind === 'firstStrike') return true;
  }
  return false;
}

/** Restore `share` of the side's starting HP pool, never above each stack's start. */
function healSide(side, share) {
  let healed = 0;
  let pool = Math.max(0, share) * side.startHp;
  if (pool <= 0) return 0;
  for (let i = 0; i < side.stacks.length && pool > 0; i++) {
    const st = side.stacks[i];
    if (st.count <= 0) continue; // wiped stacks cannot be revived
    const room = st.startHpPool - st.hpPool;
    if (room <= 0) continue;
    const give = Math.min(room, pool);
    st.hpPool += give;
    pool -= give;
    healed += give;
    st.count = countFromHp(st);
  }
  return healed;
}

/**
 * Fire the side's officer skill if its trigger matches.
 * @returns {object|null} event
 */
function fireSkill(side, trigger, round) {
  if (!side.officer) return null;
  const sk = officerSkill(side.officer, side.officerStars);
  if (!sk || sk.trigger !== trigger) return null;
  if (trigger === 'battleStart') {
    if (side.firedBattleStart) return null;
    side.firedBattleStart = true;
  } else if (trigger === 'roundStart') {
    if ((round - 1) % SKILL_RECAST !== 0) return null;
  }
  const e = sk.effect;
  const rec = {
    kind: e.kind,
    value: n0(e.value),
    rounds: intOf(e.rounds),
    cls: e.cls || null,
    vs: e.vs || null,
    rend: typeof e.rend === 'number' ? e.rend : undefined,
    heal: typeof e.heal === 'number' ? e.heal : undefined,
    until: intOf(e.rounds) === 0 ? Infinity : round + intOf(e.rounds) - 1,
    from: round,
    source: side.officer
  };
  let healed = 0;
  if (e.kind === 'heal') healed = healSide(side, e.value);
  side.effects.push(rec);
  const off = getOfficer(side.officer);
  return {
    kind: 'skill',
    side: side.isDefender ? 'defender' : 'attacker',
    round,
    officer: side.officer,
    officerName: off ? off.name : side.officer,
    skill: sk.name,
    effect: { kind: rec.kind, value: rec.value, rounds: rec.rounds, cls: rec.cls, vs: rec.vs },
    healed: Math.round(healed),
    text: `${off ? off.name : side.officer} uses ${sk.name}.`
  };
}

/** Expire finished effects; a shield carrying `heal` pays out as it drops. */
function expireEffects(side, round, events) {
  const keep = [];
  for (let i = 0; i < side.effects.length; i++) {
    const e = side.effects[i];
    if (e.rounds === 0 || round <= e.until) {
      keep.push(e);
      continue;
    }
    if (typeof e.heal === 'number' && e.heal > 0) {
      const healed = healSide(side, e.heal);
      if (healed > 0) {
        events.push({
          kind: 'heal',
          side: side.isDefender ? 'defender' : 'attacker',
          round,
          amount: Math.round(healed),
          source: e.source,
          text: `${side.name} field repairs restore ${formatNum(Math.round(healed))} HP.`
        });
      }
    }
  }
  side.effects = keep;
}

// ---------------------------------------------------------------------------
// Damage
// ---------------------------------------------------------------------------

function countFromHp(st) {
  if (st.hpPool <= 0) {
    st.hpPool = 0;
    return 0;
  }
  return Math.min(st.start, Math.max(1, Math.ceil(st.hpPool / st.unitHp - 1e-9)));
}

/**
 * Apply `amount` damage to one class of `side`, spread over its stacks by HP share.
 * @returns {{kills:Object<string,number>, total:number, wall:number, dealt:number}}
 */
function applyDamage(side, cls, amount, round) {
  const out = { kills: {}, total: 0, wall: 0, dealt: 0 };
  let dmg = Math.max(0, amount);
  if (dmg <= 0) return out;

  if (side.wallHp > 0) {
    const soak = Math.min(side.wallHp, dmg * WALL_ABSORB);
    side.wallHp -= soak;
    dmg -= soak;
    out.wall = soak;
  }
  if (dmg <= 0) return out;

  const arr = (side.byClass[cls] || []).filter((s) => s.count > 0);
  if (arr.length === 0) return out;

  // Up to 3 passes so damage that overkills one stack rolls onto the next.
  for (let pass = 0; pass < 3 && dmg > 1e-6; pass++) {
    const live = arr.filter((s) => s.hpPool > 0);
    if (live.length === 0) break;
    let pool = 0;
    for (let i = 0; i < live.length; i++) pool += live[i].hpPool;
    if (pool <= 0) break;
    const budget = dmg;
    let used = 0;
    for (let i = 0; i < live.length; i++) {
      const st = live[i];
      const want = budget * (st.hpPool / pool);
      const hit = Math.min(st.hpPool, want);
      st.hpPool -= hit;
      used += hit;
      const before = st.count;
      st.count = countFromHp(st);
      const killed = before - st.count;
      if (killed > 0) {
        out.kills[st.key] = (out.kills[st.key] || 0) + killed;
        out.total += killed;
      }
    }
    dmg -= used;
    out.dealt += used;
    if (used <= 1e-9) break;
  }
  return out;
}

/**
 * Which enemy class does `atkCls` shoot at this round?
 * Highest counter multiplier among living classes, tie-broken by TARGET_PRIORITY
 * then by the canonical class order — fully deterministic.
 */
function pickTarget(atkCls, foe) {
  let best = null;
  let bestMult = -1;
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = CLASSES[i];
    if (classCount(foe, cls) <= 0) continue;
    const m = counter(atkCls, cls);
    if (m > bestMult + 1e-9) {
      best = cls;
      bestMult = m;
    } else if (Math.abs(m - bestMult) <= 1e-9 && best !== null) {
      if (cls === TARGET_PRIORITY[atkCls] && best !== TARGET_PRIORITY[atkCls]) best = cls;
    }
  }
  return best;
}

/** Damage multiplier friendly artillery lends the rest of the army this round. */
function artillerySupport(side) {
  const arty = classCount(side, 'artillery');
  if (arty <= 0) return 1;
  const total = aliveCount(side);
  if (total <= 0) return 1;
  const share = clamp((arty / total) * 2, 0, 1);
  return 1 + COMBAT.artillerySupport * share;
}

/**
 * Compute (but do not apply) one class's attack for this round.
 * @returns {{cls:string, target:string, damage:number}|null}
 */
function planAttack(side, foe, cls, round, rng, variance) {
  const arr = side.byClass[cls] || [];
  let raw = 0;
  for (let i = 0; i < arr.length; i++) {
    if (arr[i].count > 0) raw += arr[i].unit.atk * arr[i].count;
  }
  if (raw <= 0) return null;
  const target = pickTarget(cls, foe);
  if (!target) return null;

  let mult = counter(cls, target);
  const up = skillCounterUp(side, round);
  if (up > 0 && mult > 1) mult = 1 + (mult - 1) * (1 + up);

  const atkBonus = 1 + Math.max(-0.9, bonusOf(side.bonuses, 'atk', cls));
  const skillMult = skillDamageMult(side, round, cls, target);
  const support = cls === 'artillery' ? 1 : artillerySupport(side);
  const spread = 1 + (rng() * 2 - 1) * variance;

  let dmg = raw * mult * atkBonus * skillMult * support * spread;

  const rend = clamp(skillRend(side, round), 0, 1 - MIN_DEF_SHARE);
  const def = classDefence(foe, target) * (1 - rend);
  dmg *= COMBAT.defSoak / (COMBAT.defSoak + Math.max(0, def));

  dmg *= skillShieldMult(foe, round);
  if (target === 'artillery') dmg *= COMBAT.artilleryFragility;

  return { cls, target, damage: Math.max(0, dmg) };
}

// ---------------------------------------------------------------------------
// resolveBattle
// ---------------------------------------------------------------------------

/**
 * Resolve one battle. Fully deterministic for a given `opts.seed`.
 *
 * @param {object} attackerForce see the force shape at the top of this file
 * @param {object} defenderForce
 * @param {object} [opts]
 *   seed:number|string   RNG seed (default 1)
 *   maxRounds:number     capped at 20 (default COMBAT.maxRounds)
 *   variance:number      damage spread, 0..0.5 (default COMBAT.variance)
 *   loot:{oil,steel,rare,food}  resources the attacker can carry off on a win
 *   lootShare:number     share of `loot` taken (default COMBAT.lootShare)
 *   kind:string          free-form label copied into the report ('campaign', 'map', ...)
 *   label:string         human title copied into the report
 * @returns {object} battle report
 */
export function resolveBattle(attackerForce, defenderForce, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const seed = (o.seed === undefined || o.seed === null) ? 1 : o.seed;
  const rng = rngFrom(seed);
  const variance = clamp(
    typeof o.variance === 'number' ? o.variance : COMBAT.variance, 0, 0.5
  );
  const maxRounds = Math.min(
    HARD_MAX_ROUNDS,
    Math.max(1, Math.floor(n0(o.maxRounds) || COMBAT.maxRounds))
  );

  const A = buildSide(attackerForce, false, 'Attacker');
  const D = buildSide(defenderForce, true, 'Defender');
  A.force.isDefender = false;
  D.force.isDefender = true;

  const attackerStart = startMap(A);
  const defenderStart = startMap(D);

  const report = {
    kind: typeof o.kind === 'string' ? o.kind : 'battle',
    label: typeof o.label === 'string' ? o.label : '',
    seed,
    at: Date.now(),
    attackerName: A.name,
    defenderName: D.name,
    attackerOfficer: A.officer,
    defenderOfficer: D.officer,
    attackerStart,
    defenderStart,
    attackerStartPower: forcePower(attackerStart),
    defenderStartPower: forcePower(defenderStart),
    winner: 'draw',
    reason: 'rounds',
    rounds: [],
    durationRounds: 0,
    attackerLosses: {},
    defenderLosses: {},
    attackerSurvivors: {},
    defenderSurvivors: {},
    attackerRemaining: {},
    defenderRemaining: {},
    powerLost: { attacker: 0, defender: 0 },
    wallDamage: 0,
    loot: emptyLoot(),
    summary: ''
  };

  const aliveA = aliveCount(A);
  const aliveD = aliveCount(D);
  if (aliveA <= 0 || aliveD <= 0) {
    report.winner = aliveA <= 0 && aliveD <= 0 ? 'draw' : (aliveA <= 0 ? 'defender' : 'attacker');
    report.reason = 'empty';
    finish(report, A, D, o);
    return report;
  }

  // battleStart skills
  const openEvents = [];
  const sa = fireSkill(A, 'battleStart', 1);
  if (sa) openEvents.push(sa);
  const sd = fireSkill(D, 'battleStart', 1);
  if (sd) openEvents.push(sd);

  let round = 1;
  for (; round <= maxRounds; round++) {
    const events = round === 1 ? openEvents.slice() : [];

    const ra = fireSkill(A, 'roundStart', round);
    if (ra) events.push(ra);
    const rd = fireSkill(D, 'roundStart', round);
    if (rd) events.push(rd);

    const aFirst = hasFirstStrike(A, round);
    const dFirst = hasFirstStrike(D, round);

    runPhase(1, A, D, round, rng, variance, events, aFirst, dFirst);
    if (aliveCount(A) > 0 && aliveCount(D) > 0) {
      runPhase(2, A, D, round, rng, variance, events, aFirst, dFirst);
    }

    expireEffects(A, round, events);
    expireEffects(D, round, events);

    report.rounds.push({
      n: round,
      events,
      attackerRemaining: remainingMap(A),
      defenderRemaining: remainingMap(D),
      attackerHp: Math.round(aliveHp(A)),
      defenderHp: Math.round(aliveHp(D)),
      attackerWallHp: Math.round(A.wallHp),
      defenderWallHp: Math.round(D.wallHp)
    });
    report.durationRounds = round;

    const aLeft = aliveCount(A);
    const dLeft = aliveCount(D);
    if (aLeft <= 0 || dLeft <= 0) {
      report.winner = aLeft <= 0 && dLeft <= 0 ? 'draw' : (aLeft <= 0 ? 'defender' : 'attacker');
      report.reason = 'wipe';
      break;
    }

    const aLost = A.startHp > 0 ? 1 - aliveHp(A) / A.startHp : 1;
    const dLost = D.startHp > 0 ? 1 - aliveHp(D) / D.startHp : 1;
    const aRout = aLost >= COMBAT.routAt;
    const dRout = dLost >= COMBAT.routAt;
    if (aRout || dRout) {
      if (aRout && dRout) {
        report.winner = aLost <= dLost ? 'attacker' : 'defender';
      } else if (aRout) {
        report.winner = 'defender';
      } else {
        report.winner = 'attacker';
      }
      report.reason = 'rout';
      const loserSide = report.winner === 'attacker' ? D : A;
      loserSide.routed = true;
      events.push({
        kind: 'rout',
        side: report.winner === 'attacker' ? 'defender' : 'attacker',
        round,
        text: `${loserSide.name} breaks off and withdraws.`
      });
      break;
    }
  }

  if (report.reason === 'rounds') {
    const aShare = A.startHp > 0 ? aliveHp(A) / A.startHp : 0;
    const dShare = D.startHp > 0 ? aliveHp(D) / D.startHp : 0;
    if (Math.abs(aShare - dShare) < 1e-6) report.winner = 'defender';
    else report.winner = aShare > dShare ? 'attacker' : 'defender';
  }

  finish(report, A, D, o);
  return report;
}

function startMap(side) {
  const out = {};
  for (let i = 0; i < side.stacks.length; i++) {
    const st = side.stacks[i];
    if (st.start > 0) out[st.key] = st.start;
  }
  return out;
}

function emptyLoot() {
  const out = {};
  for (let i = 0; i < RES_ORDER.length; i++) out[RES_ORDER[i]] = 0;
  return out;
}

/**
 * Run one firing phase. Both sides plan simultaneously, then damage is applied,
 * so neither side benefits from being resolved first.
 */
function runPhase(phase, A, D, round, rng, variance, events, aFirst, dFirst) {
  const plans = [];
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = CLASSES[i];
    if (classPhase(cls, aFirst) === phase && classCount(A, cls) > 0) {
      const p = planAttack(A, D, cls, round, rng, variance);
      if (p) plans.push({ side: A, foe: D, from: 'attacker', plan: p });
    }
  }
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = CLASSES[i];
    if (classPhase(cls, dFirst) === phase && classCount(D, cls) > 0) {
      const p = planAttack(D, A, cls, round, rng, variance);
      if (p) plans.push({ side: D, foe: A, from: 'defender', plan: p });
    }
  }
  for (let i = 0; i < plans.length; i++) {
    const e = plans[i];
    if (classCount(e.foe, e.plan.target) <= 0) {
      // its target died in this same phase: retarget or skip
      const alt = pickTarget(e.plan.cls, e.foe);
      if (!alt) continue;
      e.plan.target = alt;
    }
    const res = applyDamage(e.foe, e.plan.target, e.plan.damage, round);
    events.push({
      kind: 'attack',
      side: e.from,
      round,
      phase,
      from: e.plan.cls,
      to: e.plan.target,
      counter: counter(e.plan.cls, e.plan.target),
      damage: Math.round(e.plan.damage),
      wallAbsorbed: Math.round(res.wall),
      kills: res.kills,
      killed: res.total,
      text: `${e.side.name} ${CLASS_META[e.plan.cls].name} hit ${CLASS_META[e.plan.target].name}`
        + ` for ${formatNum(Math.round(e.plan.damage))}`
        + (res.total > 0 ? ` — ${formatNum(res.total)} lost.` : '.')
    });
  }
}

function classPhase(cls, firstStrike) {
  if (cls !== 'artillery') return 1;
  return firstStrike ? 1 : COMBAT.artilleryPhase;
}

/** Fill in losses, survivors, power and loot once the fighting is over. */
function finish(report, A, D, o) {
  report.attackerLosses = lossesFor(A);
  report.defenderLosses = lossesFor(D);
  report.attackerSurvivors = remainingMap(A);
  report.defenderSurvivors = remainingMap(D);
  report.attackerRemaining = report.attackerSurvivors;
  report.defenderRemaining = report.defenderSurvivors;
  report.attackerAtHome = A.atHome;
  report.defenderAtHome = D.atHome;
  report.powerLost = {
    attacker: lossPower(report.attackerLosses),
    defender: lossPower(report.defenderLosses)
  };
  report.attackerHpShare = A.startHp > 0 ? round4(aliveHp(A) / A.startHp) : 0;
  report.defenderHpShare = D.startHp > 0 ? round4(aliveHp(D) / D.startHp) : 0;
  report.wallDamage = Math.round(D.startWallHp - D.wallHp);
  report.wallHpLeft = Math.round(D.wallHp);
  report.wallDestroyed = D.startWallHp > 0 && D.wallHp <= 0;

  report.loot = computeLoot(report, A, o);
  report.summary = battleSummary(report);
  return report;
}

function lossesFor(side) {
  const out = {};
  const woundRatio = side.isDefender && side.atHome ? HOSPITAL_RATIO : ATTACKER_WOUND_RATIO;
  for (let i = 0; i < side.stacks.length; i++) {
    const st = side.stacks[i];
    const lost = Math.max(0, st.start - st.count);
    if (lost <= 0) continue;
    const wounded = Math.min(lost, Math.floor(lost * woundRatio));
    out[st.key] = { dead: lost - wounded, wounded, lost };
  }
  return out;
}

function lossPower(losses) {
  let p = 0;
  for (const k in losses) {
    if (!Object.prototype.hasOwnProperty.call(losses, k)) continue;
    const u = UNITS[k];
    if (u) p += u.power * losses[k].lost;
  }
  return Math.round(p);
}

function computeLoot(report, A, o) {
  const loot = emptyLoot();
  if (report.winner !== 'attacker') return loot;
  const src = o && o.loot && typeof o.loot === 'object' ? o.loot : null;
  if (!src) return loot;
  const share = clamp(
    typeof o.lootShare === 'number' ? o.lootShare : COMBAT.lootShare, 0, 1
  );
  let want = 0;
  const raw = {};
  for (let i = 0; i < RES_ORDER.length; i++) {
    const r = RES_ORDER[i];
    const v = Math.max(0, Math.floor(n0(src[r]) * share));
    raw[r] = v;
    want += v;
  }
  if (want <= 0) return loot;
  const cap = forceLoad(report.attackerSurvivors, A.bonuses);
  const scale = want > cap ? cap / want : 1;
  for (let i = 0; i < RES_ORDER.length; i++) {
    const r = RES_ORDER[i];
    loot[r] = Math.max(0, Math.floor(raw[r] * scale));
  }
  return loot;
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

/**
 * One-line human summary of a report.
 * @param {object} report
 * @returns {string}
 */
export function battleSummary(report) {
  if (!report) return '';
  const aLost = totalLost(report.attackerLosses);
  const dLost = totalLost(report.defenderLosses);
  const verb = report.winner === 'attacker'
    ? 'Victory'
    : report.winner === 'defender' ? 'Defeat' : 'Stalemate';
  return `${verb} after ${report.durationRounds} round${report.durationRounds === 1 ? '' : 's'}`
    + ` — lost ${formatNum(aLost)}, killed ${formatNum(dLost)}.`;
}

function totalLost(losses) {
  let n = 0;
  if (!losses) return 0;
  for (const k in losses) {
    if (!Object.prototype.hasOwnProperty.call(losses, k)) continue;
    n += losses[k].lost;
  }
  return n;
}

// ---------------------------------------------------------------------------
// simulateBattle — scout / estimate
// ---------------------------------------------------------------------------

/**
 * Estimate the attacker's win probability by replaying the battle with
 * different seeds. Cheap enough to call from the UI (default 24 runs).
 *
 * @param {object} attackerForce
 * @param {object} defenderForce
 * @param {object} [opts] same as resolveBattle, plus `samples` (1..200)
 * @returns {{winRate:number, wins:number, losses:number, draws:number,
 *            samples:number, avgRounds:number, avgAttackerLoss:number,
 *            avgDefenderLoss:number, sample:object, verdict:string}}
 */
export function simulateBattle(attackerForce, defenderForce, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const samples = clamp(Math.floor(n0(o.samples) || 24), 1, 200);
  const baseSeed = (o.seed === undefined || o.seed === null) ? 1 : o.seed;
  let wins = 0;
  let draws = 0;
  let rounds = 0;
  let aLossPct = 0;
  let dLossPct = 0;
  let first = null;

  const aTotal = forceCount(attackerForce && attackerForce.units);
  const dTotal = forceCount(defenderForce && defenderForce.units);

  for (let i = 0; i < samples; i++) {
    const r = resolveBattle(attackerForce, defenderForce, Object.assign({}, o, {
      seed: String(baseSeed) + ':' + i
    }));
    if (i === 0) first = r;
    if (r.winner === 'attacker') wins++;
    else if (r.winner === 'draw') draws++;
    rounds += r.durationRounds;
    aLossPct += aTotal > 0 ? totalLost(r.attackerLosses) / aTotal : 0;
    dLossPct += dTotal > 0 ? totalLost(r.defenderLosses) / dTotal : 0;
  }

  const winRate = wins / samples;
  return {
    samples,
    wins,
    draws,
    losses: samples - wins - draws,
    winRate: round4(winRate),
    avgRounds: round4(rounds / samples),
    avgAttackerLoss: round4(aLossPct / samples),
    avgDefenderLoss: round4(dLossPct / samples),
    sample: first,
    verdict: verdictFor(winRate)
  };
}

function verdictFor(p) {
  if (p >= 0.95) return 'Overwhelming';
  if (p >= 0.75) return 'Favourable';
  if (p >= 0.45) return 'Close';
  if (p >= 0.15) return 'Risky';
  return 'Hopeless';
}

// ---------------------------------------------------------------------------
// applyBattleResult — write a report back into S
// ---------------------------------------------------------------------------

/**
 * Total wounded currently occupying hospital beds.
 *
 * This is `S.army[k].wounded` PLUS every casualty already committed to a heal
 * batch: engine/training.js's heal() moves the wounded OUT of `.wounded` and
 * into the queue entry for the duration of the treatment, but they are still
 * lying in a bed. Counting only `.wounded` would let a player launder beds free
 * by ordering a treatment, and casualties that the capacity rule says should
 * die would survive. Kept in lock-step with training.totalWounded().
 *
 * Read straight off S.queues.train (heal batches are the entries with
 * kind === 'heal') so this module keeps no dependency on training.js.
 *
 * @returns {number}
 */
export function woundedTotal() {
  let n = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    n += intOf(S.army[k].wounded);
  }
  const q = S.queues && Array.isArray(S.queues.train) ? S.queues.train : [];
  for (let i = 0; i < q.length; i++) {
    const e = q[i];
    if (e && e.kind === 'heal') n += Math.max(0, intOf(e.count));
  }
  return n;
}

/** Hospital bed capacity from the built Field Hospital (0 when not built). */
export function hospitalCapacity() {
  const h = findBuilding('hospital');
  if (!h || h.level < 1) return 0;
  return Math.max(0, Math.floor(n0(getEffect('hospital', h.level)['heal.capacity'])));
}

/**
 * Write a battle report back into the live state.
 *
 * @param {object} report from resolveBattle
 * @param {'attacker'|'defender'} side which side the PLAYER was
 * @param {object} [opts]
 *   removeFromArmy:boolean  subtract casualties from S.army (default true).
 *                           Pass FALSE when the units were already detached from
 *                           S.army at march launch — then use report.<side>Survivors
 *                           to return the survivors yourself.
 *   hospital:boolean        route wounded into hospital beds (default true)
 *   log:boolean             push an activity-log entry (default true)
 *   emit:boolean            emit 'battle:result' (default true)
 *   text:string             override the log line
 * @returns {{won:boolean, dead:number, wounded:number, overflow:number,
 *            killed:number, beds:number, losses:object}}
 */
export function applyBattleResult(report, side, opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const mine = side === 'defender' ? 'defender' : 'attacker';
  const theirs = mine === 'attacker' ? 'defender' : 'attacker';
  const result = {
    won: false, dead: 0, wounded: 0, overflow: 0, killed: 0, beds: 0, losses: {}
  };
  if (!report || typeof report !== 'object') return result;

  const losses = (mine === 'attacker' ? report.attackerLosses : report.defenderLosses) || {};
  const theirLosses = (theirs === 'attacker' ? report.attackerLosses : report.defenderLosses) || {};
  result.losses = losses;
  result.won = report.winner === mine;

  const removeFromArmy = o.removeFromArmy !== false;
  const useHospital = o.hospital !== false;

  const cap = useHospital ? hospitalCapacity() : 0;
  let beds = Math.max(0, cap - woundedTotal());
  result.beds = beds;

  for (const key in losses) {
    if (!Object.prototype.hasOwnProperty.call(losses, key)) continue;
    const l = losses[key];
    let dead = intOf(l.dead);
    let wounded = intOf(l.wounded);
    const entry = ensureUnit(key);

    if (removeFromArmy) {
      // The stack may be smaller than the report claims (state drifted between
      // the fight and the write-back): never remove or wound more than exists.
      const total = Math.min(intOf(entry.count), dead + wounded);
      entry.count = Math.max(0, intOf(entry.count) - (dead + wounded));
      wounded = Math.min(wounded, total);
      dead = Math.max(0, total - wounded);
    }

    if (useHospital && wounded > 0) {
      const admit = Math.min(wounded, beds);
      beds -= admit;
      entry.wounded = intOf(entry.wounded) + admit;
      result.wounded += admit;
      result.overflow += wounded - admit;
      result.dead += dead + (wounded - admit);
    } else {
      result.overflow += wounded;
      result.dead += dead + wounded;
    }
  }

  for (const key in theirLosses) {
    if (!Object.prototype.hasOwnProperty.call(theirLosses, key)) continue;
    result.killed += intOf(theirLosses[key].lost);
  }

  S.stats.unitsLost = intOf(S.stats.unitsLost) + result.dead + result.wounded;
  S.stats.unitsKilled = intOf(S.stats.unitsKilled) + result.killed;
  if (report.winner === mine) S.stats.battlesWon = intOf(S.stats.battlesWon) + 1;
  else if (report.winner !== 'draw') S.stats.battlesLost = intOf(S.stats.battlesLost) + 1;

  markDirty();

  if (o.log !== false) {
    const text = typeof o.text === 'string' && o.text
      ? o.text
      : `${report.label ? report.label + ': ' : ''}`
        + `${result.won ? 'Victory' : (report.winner === 'draw' ? 'Stalemate' : 'Defeat')}`
        + ` — ${formatNum(result.killed)} enemy destroyed,`
        + ` ${formatNum(result.dead)} lost, ${formatNum(result.wounded)} wounded.`;
    addLog('battle', text, {
      winner: report.winner,
      side: mine,
      rounds: report.durationRounds,
      killed: result.killed,
      dead: result.dead,
      wounded: result.wounded
    });
  }

  if (o.emit !== false) {
    emit('battle:result', { report, side: mine, applied: result });
  }

  return result;
}
