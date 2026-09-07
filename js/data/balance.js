// js/data/balance.js — master tuning constants + pure level-scaling formulas.
// LEAF DATA MODULE: no imports at all. Every other js/data/*.js may import this.
// Exports: costAt, timeAt, prodAt, scaleAt, scaleCost, POWER_WEIGHTS, TICK_MS,
//          SAVE_TICK_MS, MARCH_SPEED, HOSPITAL_RATIO, OFFLINE_CAP_HOURS,
//          LIVE_REPORT_MIN_MS,
//          MAX_LEVEL, SPEEDUP, QUEUE, COMBAT, GATHER, UPKEEP, RES_ORDER, RARITY

/** Global level ceiling for buildings and (most) research. */
export const MAX_LEVEL = 30;

/** Main game loop period, milliseconds. */
export const TICK_MS = 1000;

/** How often the loop asks state.save() to flush, milliseconds. */
export const SAVE_TICK_MS = 5000;

/** Offline production/queue accrual is capped at this many hours. */
export const OFFLINE_CAP_HOURS = 12;

/**
 * A catch-up that happened during a LIVE session (the tab was frozen, e.g. an
 * app switch) only gets the full-screen "welcome back" report once the gap is
 * at least this long. Shorter ones are announced with a toast instead.
 */
export const LIVE_REPORT_MIN_MS = 15 * 60 * 1000;

/** Fraction of a battle's casualties that are WOUNDED (healable) instead of dead. */
export const HOSPITAL_RATIO = 0.35;

/** Canonical storable resource order (gold is premium, uncapped, not listed). */
export const RES_ORDER = ['oil', 'steel', 'rare', 'food'];

// ---------------------------------------------------------------------------
// Scaling formulas — every one is pure and defined for level 1..MAX_LEVEL.
// ---------------------------------------------------------------------------

/**
 * Geometric scale: value at `level` given a level-1 `base` and per-level `mult`.
 * scaleAt(100, 1.2, 1) === 100 ; scaleAt(100, 1.2, 3) === 144
 * @param {number} base value at level 1
 * @param {number} mult per-level multiplier (>= 1)
 * @param {number} level 1-based
 * @returns {number} unrounded
 */
export function scaleAt(base, mult, level) {
  const b = Number(base) || 0;
  const m = Number(mult) || 1;
  const l = Math.max(1, Math.floor(Number(level) || 1));
  return b * Math.pow(m, l - 1);
}

/**
 * Resource cost at a level. Rounded to a whole unit, always >= base when base > 0.
 * @param {number} base
 * @param {number} mult
 * @param {number} level
 * @returns {number} integer
 */
export function costAt(base, mult, level) {
  if (!base) return 0;
  return Math.max(1, Math.round(scaleAt(base, mult, level)));
}

/**
 * Duration in SECONDS at a level. Rounded to a whole second, min 1.
 * @param {number} base seconds at level 1
 * @param {number} mult
 * @param {number} level
 * @returns {number} integer seconds
 */
export function timeAt(base, mult, level) {
  if (!base) return 0;
  return Math.max(1, Math.round(scaleAt(base, mult, level)));
}

/**
 * Production PER HOUR at a level. Rounded to a whole unit.
 * @param {number} base per-hour at level 1
 * @param {number} mult
 * @param {number} level
 * @returns {number} integer per hour
 */
export function prodAt(base, mult, level) {
  if (!base) return 0;
  return Math.max(0, Math.round(scaleAt(base, mult, level)));
}

/**
 * Scale a whole cost object {oil,steel,rare,food} by mult^(level-1).
 * Missing/zero members are omitted from the result.
 * @param {{oil?:number,steel?:number,rare?:number,food?:number,gold?:number}} cost
 * @param {number} mult
 * @param {number} level
 * @returns {{oil?:number,steel?:number,rare?:number,food?:number,gold?:number}}
 */
export function scaleCost(cost, mult, level) {
  const out = {};
  if (!cost) return out;
  for (const k in cost) {
    if (!Object.prototype.hasOwnProperty.call(cost, k)) continue;
    const v = costAt(cost[k], mult, level);
    if (v > 0) out[k] = v;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Power score weights — engine/power.js multiplies these in.
// power = buildings + tech + army + officers
// ---------------------------------------------------------------------------

export const POWER_WEIGHTS = {
  /** per building: weight * level^exp */
  building: 9,
  buildingExp: 1.55,
  /** the HQ counts extra */
  hqBonus: 2.2,
  /** per researched tech level: weight * level^exp */
  tech: 14,
  techExp: 1.35,
  /** per living unit: unit.power * this */
  unit: 1,
  /** wounded units still count, but at a discount */
  wounded: 0.35,
  /** per owned officer: base + level*perLevel + (stars-1)^exp * perStar */
  officerBase: 80,
  officerPerLevel: 9,
  officerPerStar: 140,
  officerStarExp: 1.4,
  /** rarity multiplier applied to the officer term */
  officerRarity: { R: 1, SR: 1.6, SSR: 2.4 }
};

// ---------------------------------------------------------------------------
// Marching / world map
// ---------------------------------------------------------------------------

export const MARCH_SPEED = {
  /** Base seconds spent per map tile of distance (before march.speed bonus). */
  secPerTile: 6,
  /** No march ever resolves faster than this. */
  minSec: 20,
  /** Longest one-way march, seconds (clamped so nothing gets lost forever). */
  maxSec: 7200,
  /** Return legs are slightly quicker than outbound legs. */
  returnMult: 0.9,
  /** A march's speed is the SLOWEST unit in it, scaled by this. */
  slowestUnitWeight: 1
};

/** Gathering tuning: how fast a march strips a resource node. */
export const GATHER = {
  /** Base resource units gathered per hour per point of army load capacity. */
  perLoadPerHour: 45,
  /** Node yield = base * mult^(nodeLevel-1). */
  nodeBase: 6000,
  nodeMult: 1.85,
  /** Hard cap on one gathering trip, seconds. */
  maxSec: 14400
};

/** Army food upkeep + starvation attrition. */
export const UPKEEP = {
  /** Multiplier on each unit's `upkeep` (food/hour). */
  mult: 1,
  /** When food hits 0 the army loses this fraction of its count per hour. */
  starveRatePerHour: 0.04,
  /** Starvation never takes a stack below this many units. */
  starveFloor: 1
};

/** Build/research/training queue rules. */
export const QUEUE = {
  /** Main construction slot + one always-free "quick" slot. */
  buildSlots: 1,
  freeBuildSlots: 1,
  researchSlots: 1,
  trainSlots: 1,
  /**
   * The free "finish now" help only trims the TAIL of a job: a job may be
   * finished for free once it has <= this many seconds left AND its total
   * duration was longer than this. Short jobs (level-1 buildings, the first
   * techs, small training batches) must therefore actually be waited out or
   * rushed with gold — otherwise the whole early game has no build timers.
   */
  freeFinishSec: 300,
  /** Gold cost to speed up: ceil(secondsRemaining / secPerGold), min 1. */
  secPerGold: 60,
  /** Minimum gold charged for any speed-up. */
  minGold: 1,
  /** Max units queued in one training batch. */
  maxBatch: 500
};

/**
 * Gold speed-up helpers grouped for convenience.
 *
 * Both helpers take the seconds REMAINING and the job's TOTAL duration. The
 * free finish is a tail-trim, not a bypass: it applies only to jobs that were
 * longer than QUEUE.freeFinishSec to begin with. When `totalSec` is omitted the
 * remaining time is used as the total, which makes the answer conservative
 * (never free) rather than accidentally generous.
 */
export const SPEEDUP = {
  /**
   * Gold needed to instantly finish a job.
   * @param {number} remainSec seconds left
   * @param {number} [totalSec] the job's full duration in seconds
   * @returns {number} integer gold (0 when the finish is free)
   */
  goldFor(remainSec, totalSec) {
    const s = Math.max(0, Math.floor(Number(remainSec) || 0));
    if (SPEEDUP.isFree(s, totalSec)) return 0;
    if (s <= 0) return 0;
    return Math.max(QUEUE.minGold, Math.ceil(s / QUEUE.secPerGold));
  },
  /**
   * True when the remaining time can be finished for free.
   * @param {number} remainSec
   * @param {number} [totalSec]
   * @returns {boolean}
   */
  isFree(remainSec, totalSec) {
    const s = Math.max(0, Number(remainSec) || 0);
    const t = Number(totalSec);
    const job = (Number.isFinite(t) && t > 0) ? t : s;
    if (job <= QUEUE.freeFinishSec) return false;
    return s <= QUEUE.freeFinishSec;
  }
};

/**
 * NPC retaliation raids. A world-map camp that beats off one of your assaults
 * sends a column at your city; this is the one battle where the player is the
 * DEFENDER, so the Perimeter Wall and Warehouse protection matter.
 */
export const RAID = {
  /** Share of the surviving garrison that marches on your city. */
  forceShare: 0.45,
  /**
   * Hard ceiling on the column, as a share of the player's TOTAL army power
   * (troops at home and in the field). A punitive raid must be a real threat
   * without being an extinction event after one lost assault.
   */
  powerCap: 0.5,
  /** A camp below this level never bothers to retaliate. */
  minCampLevel: 3,
  /** Extra seconds the camp spends mustering before it sets off. */
  musterSec: 120,
  /** At most this many raids may be inbound at once. */
  maxInbound: 2,
  /** Share of your UNPROTECTED resources a successful raid carries off. */
  lootShare: 0.25,
  /** Gold the raiders drop when you beat them, per camp level. */
  goldPerLevel: 2
};

/** Combat resolver tuning (engine/combat.js). */
export const COMBAT = {
  /** Max rounds before the fight is scored on remaining HP. */
  maxRounds: 12,
  /** Damage = atk * counter * bonuses / (def + defSoak) * spread. */
  defSoak: 40,
  /** Random damage spread per round: [1-var, 1+var]. */
  variance: 0.12,
  /** Artillery always fires in the second (support) phase. */
  artilleryPhase: 2,
  /** Flat damage bonus artillery grants to the rest of the army, per round. */
  artillerySupport: 0.25,
  /** Damage multiplier taken by artillery from every attacker class. */
  artilleryFragility: 2,
  /** Winner keeps this share of the loser's carried/looted resources. */
  lootShare: 0.5,
  /** Retreat threshold: an army that has lost this HP share breaks off. */
  routAt: 0.75
};

/** Officer rarity metadata shared by data/officers.js and the UI. */
export const RARITY = {
  R: { key: 'R', name: 'Rare', color: '#5b8dd6', order: 1, statMult: 1, maxLevel: 40 },
  SR: { key: 'SR', name: 'Super Rare', color: '#a874e8', order: 2, statMult: 1.35, maxLevel: 50 },
  SSR: { key: 'SSR', name: 'Legendary', color: '#f0a500', order: 3, statMult: 1.8, maxLevel: 60 }
};
