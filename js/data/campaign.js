// js/data/campaign.js — the 20-stage PvE campaign: enemy compositions and rewards.
// PURE DATA + pure helpers. Imports only ./balance.js, ./units.js.
// Exports: CAMPAIGN, CAMPAIGN_IDS, STAGE_COUNT, REPEAT,
//          getStage, nextStage, stageEnemyPower, isStageUnlocked, stageReward,
//          stageCooldownSec

import { UNITS } from './units.js';

/** Number of campaign stages. */
export const STAGE_COUNT = 20;

/**
 * Re-running a stage you already cleared is deliberately a poor way to farm:
 * the purse shrinks to `share` of the first-clear repeat value and the sector
 * has to be re-garrisoned before you can hit it again. Without this a player
 * can tap stage 1 forever and every other resource system stops mattering.
 */
export const REPEAT = {
  /** Fraction of the listed purse a repeat clear pays. */
  share: 0.25,
  /** Base cooldown after a clear, seconds. */
  cooldownSec: 1800,
  /** Extra cooldown seconds per stage id (deeper sectors take longer to re-arm). */
  cooldownPerStage: 60,
  /** Cooldown ceiling, seconds. */
  cooldownMaxSec: 7200
};

/**
 * Per-stage authoring table. `comp` gives the share of the stage's total
 * enemy headcount assigned to each class; a class only appears once the
 * player can realistically have counters for it:
 *   tanks from stage 4, aircraft from stage 9, artillery from stage 13.
 * Enemy tier ramps 1 -> 8 across the 20 stages; headcount ramps geometrically
 * (x1.26 per stage), so total enemy power grows ~x2.2 every two stages.
 */
const STAGE_META = [
  { name: 'Border Skirmish', desc: 'A militia roadblock on the northern approach. Clear it.', comp: { infantry: 1 } },
  { name: 'Rail Junction', desc: 'Raiders have seized the rail yard and are stripping it for scrap.', comp: { infantry: 1 } },
  { name: 'Fuel Depot', desc: 'A hostile squad is siphoning the depot dry. Take it back intact.', comp: { infantry: 1 } },
  { name: 'Broken Bridge', desc: 'Armoured cars hold the crossing. Punch through before they dig in.', comp: { infantry: 0.7, tank: 0.3 } },
  { name: 'Quarry Road', desc: 'A supply column with a light armour escort. Cut it apart.', comp: { infantry: 0.65, tank: 0.35 } },
  { name: 'Grain Silos', desc: 'They are burning the harvest. Save what is left of it.', comp: { infantry: 0.65, tank: 0.35 } },
  { name: 'Foundry District', desc: 'Street fighting among the blast furnaces. Expect armour in the alleys.', comp: { infantry: 0.6, tank: 0.4 } },
  { name: 'Highway 9', desc: 'A mechanised battalion is moving south. Stop it on the open road.', comp: { infantry: 0.55, tank: 0.45 } },
  { name: 'Airfield Perimeter', desc: 'Their fighters are scrambling. Bring anti-air or bring losses.', comp: { infantry: 0.45, tank: 0.35, aircraft: 0.2 } },
  { name: 'Radar Hill', desc: 'A fortified radar post with air cover. Blind them.', comp: { infantry: 0.45, tank: 0.3, aircraft: 0.25 } },
  { name: 'River Crossing', desc: 'They hold both banks and the sky above the water.', comp: { infantry: 0.4, tank: 0.35, aircraft: 0.25 } },
  { name: 'Mountain Pass', desc: 'A narrow, mined pass covered by gunships. No room to manoeuvre.', comp: { infantry: 0.4, tank: 0.3, aircraft: 0.3 } },
  { name: 'Siege Lines', desc: 'Dug-in guns shell your staging area. Silence the batteries.', comp: { infantry: 0.35, tank: 0.3, aircraft: 0.2, artillery: 0.15 } },
  { name: 'Industrial Belt', desc: 'A full combined-arms garrison behind concrete and wire.', comp: { infantry: 0.35, tank: 0.3, aircraft: 0.2, artillery: 0.15 } },
  { name: 'Coastal Battery', desc: 'Heavy guns and a fighter wing guard the landing beaches.', comp: { infantry: 0.3, tank: 0.3, aircraft: 0.25, artillery: 0.15 } },
  { name: 'Fortress Vega', desc: 'The first real fortress on the road inland. Prepared positions, layered fire.', comp: { infantry: 0.3, tank: 0.3, aircraft: 0.22, artillery: 0.18 } },
  { name: 'Steel Wastes', desc: 'An armoured graveyard where two armies already died. A third is waiting.', comp: { infantry: 0.25, tank: 0.35, aircraft: 0.22, artillery: 0.18 } },
  { name: 'Sky Fortress', desc: 'An airborne command node with an escort wing at full strength.', comp: { infantry: 0.25, tank: 0.25, aircraft: 0.32, artillery: 0.18 } },
  { name: 'Capital Outskirts', desc: 'The last belt of defences before the enemy capital. Everything they have left.', comp: { infantry: 0.25, tank: 0.3, aircraft: 0.25, artillery: 0.2 } },
  { name: 'Iron Citadel', desc: 'The citadel itself. Elite formations, massed guns, and no way around.', comp: { infantry: 0.22, tank: 0.3, aircraft: 0.26, artillery: 0.22 } }
];

/** Fragment rewards handed out on first clear, by stage id. */
const FRAG_REWARDS = {
  2: { officerKey: 'hastings', n: 6 },
  4: { officerKey: 'kruger', n: 6 },
  6: { officerKey: 'tanaka', n: 8 },
  8: { officerKey: 'rossi', n: 8 },
  10: { officerKey: 'petrova', n: 10 },
  12: { officerKey: 'vega', n: 10 },
  14: { officerKey: 'okonkwo', n: 12 },
  16: { officerKey: 'lindqvist', n: 12 },
  18: { officerKey: 'moreau', n: 14 },
  19: { officerKey: 'zhao', n: 16 },
  20: { officerKey: 'ironside', n: 20 }
};

/** Officers awarded outright the first time a milestone stage is cleared. */
const OFFICER_REWARDS = { 5: 'hastings', 10: 'kruger', 15: 'petrova', 20: 'valentine' };

const PREFIX = { infantry: 'inf', tank: 'tank', aircraft: 'air', artillery: 'arty' };

/** Enemy unit tier used at stage `id` (1..8). */
function tierFor(id) {
  return Math.max(1, Math.min(8, Math.ceil(id * 0.4)));
}

/** Total enemy headcount at stage `id`. */
function headcountFor(id) {
  return Math.max(6, Math.round(10 * Math.pow(1.26, id - 1)));
}

function buildEnemy(id) {
  const meta = STAGE_META[id - 1];
  const tier = tierFor(id);
  const total = headcountFor(id);
  const out = [];
  // Classes that make up the bulk of the garrison field the stage tier; a
  // token detachment (< 20% of the force) fields one tier below, which keeps
  // the newly-introduced class survivable when the player first meets it.
  const entries = Object.keys(meta.comp);

  for (let i = 0; i < entries.length; i++) {
    const cls = entries[i];
    const share = meta.comp[cls];
    const t = Math.max(1, tier - (share < 0.2 ? 1 : 0));
    const key = PREFIX[cls] + t;
    const count = Math.max(1, Math.round(total * share));
    out.push({ unitKey: key, count });
  }
  return out;
}

function buildRewards(id) {
  const scale = Math.pow(1.34, id - 1);
  return {
    res: {
      oil: Math.round(600 * scale),
      steel: Math.round(600 * scale),
      rare: Math.round(80 * scale),
      food: Math.round(500 * scale)
    },
    gold: 0,
    frags: null
  };
}

function buildFirstClear(id) {
  const scale = Math.pow(1.34, id - 1);
  return {
    res: {
      oil: Math.round(1800 * scale),
      steel: Math.round(1800 * scale),
      rare: Math.round(240 * scale),
      food: Math.round(1400 * scale)
    },
    gold: 60 + id * 20,
    frags: FRAG_REWARDS[id] || null,
    officer: OFFICER_REWARDS[id] || null,
    xp: Math.round(200 * Math.pow(1.22, id - 1))
  };
}

/**
 * CAMPAIGN[i] = {
 *   id, name, desc, tier, recommendedPower,
 *   enemy:[{unitKey, count}],
 *   rewards:{ res:{oil,steel,rare,food}, gold, frags },       // every clear
 *   firstClear:{ res, gold, frags:{officerKey,n}|null,
 *                officer:string|null, xp }                     // once only
 * }
 * Stages must be cleared in order: stage N unlocks when N-1 is in S.campaign.cleared.
 */
export const CAMPAIGN = (() => {
  const out = [];
  for (let id = 1; id <= STAGE_COUNT; id++) {
    const meta = STAGE_META[id - 1];
    const enemy = buildEnemy(id);
    let power = 0;
    for (let i = 0; i < enemy.length; i++) {
      const u = UNITS[enemy[i].unitKey];
      if (u) power += u.power * enemy[i].count;
    }
    out.push({
      id,
      name: meta.name,
      desc: meta.desc,
      tier: tierFor(id),
      enemy,
      recommendedPower: Math.round(power * 1.15),
      enemyPower: Math.round(power),
      rewards: buildRewards(id),
      firstClear: buildFirstClear(id)
    });
  }
  return out;
})();

/** Stage ids 1..20. */
export const CAMPAIGN_IDS = CAMPAIGN.map((s) => s.id);

/** @param {number} id @returns {object|null} */
export function getStage(id) {
  const i = Math.floor(Number(id) || 0);
  return CAMPAIGN[i - 1] || null;
}

/** The stage after `id`, or null at the end of the campaign. */
export function nextStage(id) {
  return getStage((Math.floor(Number(id) || 0)) + 1);
}

/** Raw enemy power of a stage (sum of unit power * count). */
export function stageEnemyPower(id) {
  const s = getStage(id);
  return s ? s.enemyPower : 0;
}

/**
 * Stage N is playable once N-1 has been cleared (stage 1 is always open).
 * @param {number} id
 * @param {number[]} cleared S.campaign.cleared
 * @returns {boolean}
 */
export function isStageUnlocked(id, cleared) {
  const n = Math.floor(Number(id) || 0);
  if (n <= 1) return n === 1;
  if (!Array.isArray(cleared)) return false;
  return cleared.indexOf(n - 1) !== -1;
}

/**
 * How long a stage is out of action after you clear it, in seconds.
 * @param {number} id
 * @returns {number}
 */
export function stageCooldownSec(id) {
  const n = Math.max(1, Math.floor(Number(id) || 1));
  return Math.min(
    REPEAT.cooldownMaxSec,
    REPEAT.cooldownSec + REPEAT.cooldownPerStage * (n - 1)
  );
}

/**
 * The reward payload for clearing a stage.
 * @param {number} id
 * @param {boolean} first true when this is the first clear
 * @returns {{res:object, gold:number, frags:object|null, officer?:string|null, xp?:number}}
 */
export function stageReward(id, first) {
  const s = getStage(id);
  if (!s) return { res: { oil: 0, steel: 0, rare: 0, food: 0 }, gold: 0, frags: null };
  if (!first) {
    // A fresh object every time: callers must never be able to mutate the table.
    return {
      res: {
        oil: Math.round(s.rewards.res.oil * REPEAT.share),
        steel: Math.round(s.rewards.res.steel * REPEAT.share),
        rare: Math.round(s.rewards.res.rare * REPEAT.share),
        food: Math.round(s.rewards.res.food * REPEAT.share)
      },
      gold: Math.round((s.rewards.gold || 0) * REPEAT.share),
      frags: null
    };
  }
  return {
    res: {
      oil: s.rewards.res.oil + s.firstClear.res.oil,
      steel: s.rewards.res.steel + s.firstClear.res.steel,
      rare: s.rewards.res.rare + s.firstClear.res.rare,
      food: s.rewards.res.food + s.firstClear.res.food
    },
    gold: s.rewards.gold + s.firstClear.gold,
    frags: s.firstClear.frags,
    officer: s.firstClear.officer,
    xp: s.firstClear.xp
  };
}
