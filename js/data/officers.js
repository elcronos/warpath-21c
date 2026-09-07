// js/data/officers.js — the 12 commanders, their passives, battle skills and the gacha pool.
// PURE DATA + pure helpers. Imports only ./balance.js.
// Exports: OFFICERS, OFFICER_KEYS, RARITY, RARITY_ORDER, SKILL_TRIGGERS, SKILL_KINDS,
//          RECRUIT_POOL, PITY_COUNT, DRAW_COST, FRAG_TABLE,
//          getOfficer, officersByRarity, officerBonus, officerSkill,
//          fragsToNextStar, maxLevelFor, officerXpForLevel

import { RARITY } from './balance.js';

export { RARITY };

/** Rarity order used for sorting, weakest first. */
export const RARITY_ORDER = ['R', 'SR', 'SSR'];

/** When a commander's battle skill fires. */
export const SKILL_TRIGGERS = ['battleStart', 'roundStart'];

/**
 * The closed enumeration of battle-skill effect kinds. engine/combat.js
 * switches on `skill.effect.kind`:
 *
 *  'damage'    +value damage multiplier for the owner's army (cls optional)
 *  'shield'    incoming damage reduced by value (0.15 = -15%)
 *  'heal'      restores value share of the army's starting HP pool
 *  'firstStrike' artillery in this army fires in phase 1 instead of phase 2
 *  'counterUp' the army's counter advantages are amplified by value
 *  'rend'      enemy defence reduced by value
 *  'focus'     +value damage, but only against `vs` class
 *
 * Every effect object: { kind, value, rounds, cls?:unitClass, vs?:unitClass }
 * `rounds` = how many combat rounds it lasts (0 = whole battle).
 */
export const SKILL_KINDS = ['damage', 'shield', 'heal', 'firstStrike', 'counterUp', 'rend', 'focus'];

/** Fragments needed to advance from star N to star N+1, by rarity. */
export const FRAG_TABLE = {
  R: [20, 40, 80],
  SR: [30, 60, 120, 240],
  SSR: [40, 80, 160, 320, 640]
};

/** Max star level per rarity (== FRAG_TABLE[rarity].length + 1). */
const MAX_STARS = { R: 4, SR: 5, SSR: 6 };

function off(o) {
  return {
    key: o.key,
    name: o.name,
    title: o.title,
    rarity: o.rarity,
    cls: o.cls,
    icon: 'off_' + o.key,
    portrait: 'portrait_' + o.key,
    desc: o.desc,
    /** passives: cumulative value = perLevel * level * starMult */
    passives: o.passives,
    skill: o.skill,
    maxStars: MAX_STARS[o.rarity],
    fragsToStar: FRAG_TABLE[o.rarity].slice(),
    maxLevel: RARITY[o.rarity].maxLevel
  };
}

/**
 * OFFICERS[key] = { key, name, title, rarity, cls, icon, portrait, desc,
 *                   passives:[{bonusKey, perLevel}],
 *                   skill:{ name, desc, trigger, effect:{kind,value,rounds,cls?,vs?} },
 *                   maxStars, fragsToStar:number[], maxLevel }
 * All `bonusKey` values are members of BONUS_KEYS in js/data/tech.js.
 */
export const OFFICERS = {
  // ------------------------------------------------------------------- R (4)
  hastings: off({
    key: 'hastings', name: 'Col. Hastings', title: 'The Drillmaster',
    rarity: 'R', cls: 'infantry',
    desc: 'A career instructor who turns conscripts into riflemen in half the time.',
    passives: [
      { bonusKey: 'atk.infantry', perLevel: 0.002 },
      { bonusKey: 'train.speed', perLevel: 0.00133 }
    ],
    skill: {
      name: 'Fix Bayonets', trigger: 'battleStart',
      desc: 'Infantry open the battle with a furious charge: +18% damage for 3 rounds.',
      effect: { kind: 'damage', value: 0.18, rounds: 3, cls: 'infantry' }
    }
  }),
  kruger: off({
    key: 'kruger', name: 'Maj. Kruger', title: 'Steel Hand',
    rarity: 'R', cls: 'tank',
    desc: 'A workshop foreman turned tank commander. Keeps armour rolling.',
    passives: [
      { bonusKey: 'def.tank', perLevel: 0.002 },
      { bonusKey: 'hp.tank', perLevel: 0.00167 }
    ],
    skill: {
      name: 'Buttoned Up', trigger: 'battleStart',
      desc: 'Crews seal the hatches: the whole army takes 12% less damage for 4 rounds.',
      effect: { kind: 'shield', value: 0.12, rounds: 4 }
    }
  }),
  tanaka: off({
    key: 'tanaka', name: 'Lt. Tanaka', title: 'Cloud Runner',
    rarity: 'R', cls: 'aircraft',
    desc: 'A scout pilot with an uncanny eye for a target and for a supply dump.',
    passives: [
      { bonusKey: 'atk.aircraft', perLevel: 0.002 },
      { bonusKey: 'gather.speed', perLevel: 0.00167 }
    ],
    skill: {
      name: 'Strafing Run', trigger: 'roundStart',
      desc: 'A low pass on the armour columns: +20% aircraft damage vs tanks, 2 rounds.',
      effect: { kind: 'focus', value: 0.2, rounds: 2, cls: 'aircraft', vs: 'tank' }
    }
  }),
  rossi: off({
    key: 'rossi', name: 'Capt. Rossi', title: 'Range Officer',
    rarity: 'R', cls: 'artillery',
    desc: 'Never rushed, never wrong. His fire missions land exactly where promised.',
    passives: [
      { bonusKey: 'atk.artillery', perLevel: 0.00233 },
      { bonusKey: 'def.artillery', perLevel: 0.00133 }
    ],
    skill: {
      name: 'Ranging Shot', trigger: 'battleStart',
      desc: 'A registered target: enemy defence cut by 10% for the whole battle.',
      effect: { kind: 'rend', value: 0.1, rounds: 0 }
    }
  }),

  // ------------------------------------------------------------------ SR (5)
  petrova: off({
    key: 'petrova', name: 'Cmdr. Petrova', title: 'Iron Sister',
    rarity: 'SR', cls: 'infantry',
    desc: 'Held a rail junction for nine days with two companies and no artillery.',
    passives: [
      { bonusKey: 'def.infantry', perLevel: 0.003 },
      { bonusKey: 'hp.infantry', perLevel: 0.00267 },
      { bonusKey: 'heal.speed', perLevel: 0.002 }
    ],
    skill: {
      name: 'Hold the Line', trigger: 'battleStart',
      desc: 'Dug in and defiant: army takes 18% less damage for 5 rounds.',
      effect: { kind: 'shield', value: 0.18, rounds: 5 }
    }
  }),
  vega: off({
    key: 'vega', name: 'Col. Vega', title: 'Breakthrough',
    rarity: 'SR', cls: 'tank',
    desc: 'Believes every problem is solvable by putting armour through the middle of it.',
    passives: [
      { bonusKey: 'atk.tank', perLevel: 0.00333 },
      { bonusKey: 'march.speed', perLevel: 0.00167 }
    ],
    skill: {
      name: 'Wedge Formation', trigger: 'battleStart',
      desc: 'Armour leads the wedge: +26% tank damage for 4 rounds.',
      effect: { kind: 'damage', value: 0.26, rounds: 4, cls: 'tank' }
    }
  }),
  okonkwo: off({
    key: 'okonkwo', name: 'Maj. Okonkwo', title: 'Skyward',
    rarity: 'SR', cls: 'aircraft',
    desc: 'Wrote the low-level attack manual the rest of the air force flies by.',
    passives: [
      { bonusKey: 'atk.aircraft', perLevel: 0.00333 },
      { bonusKey: 'hp.aircraft', perLevel: 0.00233 }
    ],
    skill: {
      name: 'Hammer from Above', trigger: 'roundStart',
      desc: 'Sustained close support: +22% aircraft damage for 3 rounds.',
      effect: { kind: 'damage', value: 0.22, rounds: 3, cls: 'aircraft' }
    }
  }),
  lindqvist: off({
    key: 'lindqvist', name: 'Capt. Lindqvist', title: 'Counter-Battery',
    rarity: 'SR', cls: 'artillery',
    desc: 'Finds the enemy guns by sound alone, then removes them.',
    passives: [
      { bonusKey: 'atk.artillery', perLevel: 0.00367 },
      { bonusKey: 'hp.artillery', perLevel: 0.00233 }
    ],
    skill: {
      name: 'Time on Target', trigger: 'battleStart',
      desc: 'Every tube fires to land at once: guns shoot in the FIRST phase all battle.',
      effect: { kind: 'firstStrike', value: 1, rounds: 0 }
    }
  }),
  moreau: off({
    key: 'moreau', name: 'Dir. Moreau', title: 'Quartermaster General',
    rarity: 'SR', cls: 'infantry',
    desc: 'Never fired a shot; won three campaigns from behind a requisition desk.',
    passives: [
      { bonusKey: 'prod.oil', perLevel: 0.00267 },
      { bonusKey: 'prod.steel', perLevel: 0.00267 },
      { bonusKey: 'load.capacity', perLevel: 0.00233 },
      { bonusKey: 'build.speed', perLevel: 0.00167 }
    ],
    skill: {
      name: 'Full Magazines', trigger: 'battleStart',
      desc: 'An army that never runs short: +14% damage for the whole battle.',
      effect: { kind: 'damage', value: 0.14, rounds: 0 }
    }
  }),

  // ----------------------------------------------------------------- SSR (3)
  ironside: off({
    key: 'ironside', name: 'Gen. Ironside', title: 'The Anvil',
    rarity: 'SSR', cls: 'tank',
    desc: 'Legendary armour commander. Has never yielded ground he intended to keep.',
    passives: [
      { bonusKey: 'atk.tank', perLevel: 0.00433 },
      { bonusKey: 'def.tank', perLevel: 0.00367 },
      { bonusKey: 'hp.tank', perLevel: 0.00367 },
      { bonusKey: 'def.infantry', perLevel: 0.002 }
    ],
    skill: {
      name: 'Unbreakable', trigger: 'battleStart',
      desc: 'Armour absorbs the first blows: -22% damage taken for 5 rounds, then a 12% HP field repair.',
      effect: { kind: 'shield', value: 0.22, rounds: 5, heal: 0.12 }
    }
  }),
  valentine: off({
    key: 'valentine', name: 'Air Mshl. Valentine', title: 'Sky Sovereign',
    rarity: 'SSR', cls: 'aircraft',
    desc: 'Commands the sky the way other officers command a hill: absolutely.',
    passives: [
      { bonusKey: 'atk.aircraft', perLevel: 0.00467 },
      { bonusKey: 'def.aircraft', perLevel: 0.00333 },
      { bonusKey: 'hp.aircraft', perLevel: 0.00333 },
      { bonusKey: 'march.speed', perLevel: 0.00233 }
    ],
    skill: {
      name: 'Total Air Superiority', trigger: 'battleStart',
      desc: 'Counter advantages hit far harder: +30% to every favourable matchup, all battle.',
      effect: { kind: 'counterUp', value: 0.3, rounds: 0 }
    }
  }),
  zhao: off({
    key: 'zhao', name: 'Mshl. Zhao', title: 'The Grand Design',
    rarity: 'SSR', cls: 'infantry',
    desc: 'A strategist first and a soldier second. Wins battles before they are fought.',
    passives: [
      { bonusKey: 'atk.infantry', perLevel: 0.00433 },
      { bonusKey: 'hp.infantry', perLevel: 0.00333 },
      { bonusKey: 'research.speed', perLevel: 0.00267 },
      { bonusKey: 'train.speed', perLevel: 0.00233 }
    ],
    skill: {
      name: 'Grand Offensive', trigger: 'battleStart',
      desc: 'The whole plan comes together: +28% damage and enemy defence cut 12% for 6 rounds.',
      effect: { kind: 'damage', value: 0.28, rounds: 6, rend: 0.12 }
    }
  })
};

/** All 12 officer keys, R first then SR then SSR. */
export const OFFICER_KEYS = Object.keys(OFFICERS);

/** @param {string} key @returns {object|null} */
export function getOfficer(key) {
  return OFFICERS[key] || null;
}

/** Every officer of a rarity. */
export function officersByRarity(rarity) {
  return OFFICER_KEYS.map((k) => OFFICERS[k]).filter((o) => o.rarity === rarity);
}

/** Level ceiling for an officer. */
export function maxLevelFor(key) {
  const o = OFFICERS[key];
  return o ? o.maxLevel : 0;
}

/**
 * XP needed to go from `level` to `level + 1`.
 * @param {number} level
 * @returns {number}
 */
export function officerXpForLevel(level) {
  const l = Math.max(1, Math.floor(Number(level) || 1));
  return Math.round(120 * Math.pow(1.13, l - 1));
}

/**
 * Fragments needed to reach the next star, or 0 when already max star.
 * @param {string} key
 * @param {number} stars current star count (1-based)
 * @returns {number}
 */
export function fragsToNextStar(key, stars) {
  const o = OFFICERS[key];
  if (!o) return 0;
  const s = Math.max(1, Math.floor(Number(stars) || 1));
  if (s >= o.maxStars) return 0;
  return o.fragsToStar[s - 1] || 0;
}

/**
 * Star multiplier applied to every passive: +15% per star above the first.
 * @param {number} stars
 * @returns {number}
 */
export function starMult(stars) {
  const s = Math.max(1, Math.floor(Number(stars) || 1));
  return 1 + 0.15 * (s - 1);
}

/**
 * The bonuses an owned officer contributes, as a {bonusKey: value} map.
 *   value = perLevel * level * starMult(stars)
 * Rarity is already baked into perLevel and into the level/star ceilings, so
 * RARITY[].statMult is deliberately NOT applied here (it would triple-count).
 * A fully invested SSR lands around +45% on its headline stat.
 * @param {string} key
 * @param {number} level
 * @param {number} stars
 * @returns {Object<string,number>}
 */
export function officerBonus(key, level, stars) {
  const o = OFFICERS[key];
  const out = {};
  if (!o) return out;
  const l = Math.max(1, Math.min(Math.floor(Number(level) || 1), o.maxLevel));
  const mult = starMult(stars);
  for (let i = 0; i < o.passives.length; i++) {
    const p = o.passives[i];
    const v = p.perLevel * l * mult;
    out[p.bonusKey] = Math.round(((out[p.bonusKey] || 0) + v) * 10000) / 10000;
  }
  return out;
}

/**
 * The battle skill of an officer, scaled by stars (+10% effect per extra star).
 * @param {string} key
 * @param {number} stars
 * @returns {{name:string,desc:string,trigger:string,effect:object}|null}
 */
export function officerSkill(key, stars) {
  const o = OFFICERS[key];
  if (!o) return null;
  const scale = 1 + 0.1 * (Math.max(1, Math.floor(Number(stars) || 1)) - 1);
  const e = o.skill.effect;
  const eff = { kind: e.kind, value: round4(e.value * scale), rounds: e.rounds };
  if (e.cls) eff.cls = e.cls;
  if (e.vs) eff.vs = e.vs;
  if (typeof e.heal === 'number') eff.heal = round4(e.heal * scale);
  if (typeof e.rend === 'number') eff.rend = round4(e.rend * scale);
  return { name: o.skill.name, desc: o.skill.desc, trigger: o.skill.trigger, effect: eff };
}

function round4(v) {
  return Math.round(v * 10000) / 10000;
}

// ---------------------------------------------------------------------------
// Recruitment (gold draw)
// ---------------------------------------------------------------------------

/** Gold per draw. A ten-pull costs 10x single minus one free draw. */
export const DRAW_COST = { single: 300, ten: 2700, tenCount: 10 };

/**
 * Weighted rarity table. `weight` values are relative; engine normalises.
 * A draw first rolls a rarity, then picks uniformly from that rarity's keys.
 * Non-officer consolation is handled by 'frag' entries (fragments of a random
 * officer of that rarity) which the engine grants when the officer is owned.
 */
export const RECRUIT_POOL = [
  { rarity: 'R', weight: 700, keys: officersByRarity('R').map((o) => o.key), fragsIfOwned: 5 },
  { rarity: 'SR', weight: 260, keys: officersByRarity('SR').map((o) => o.key), fragsIfOwned: 10 },
  { rarity: 'SSR', weight: 40, keys: officersByRarity('SSR').map((o) => o.key), fragsIfOwned: 20 }
];

/** Draws without an SSR after which the next draw is a guaranteed SSR. */
export const PITY_COUNT = 60;

/** Total of every RECRUIT_POOL weight (convenience for the engine). */
export const RECRUIT_WEIGHT_TOTAL = RECRUIT_POOL.reduce((n, e) => n + e.weight, 0);
