// js/engine/worldmap.js — world map generation, tile selectors and the march system.
// Exports: MAP_W, MAP_H, CENTER, generateMap, ensureMap, regenerateMap,
//          tileIndex, tileAt, setTile, clearTile, tilesInRadius, nearestTile, allSpecialTiles,
//          cityPos, distance, visionRadius, isExplored, markExplored,
//          getMarchCapacity, activeMarches, getMarch, getLoadCapacity, getGatherRate,
//          marchTravelSeconds, sendMarch, recallMarch, tickMarches, scoutTile,
//          npcPower, npcLoot, setBonusProvider, getBonus,
//          incomingRaids, raidPower, tickRaids
//
// Depends on: ../util/{fmt,events}.js, ./state.js, ./combat.js and ./bonus.js
// (both namespace imports: every call site tolerates a missing export rather than
// throwing), plus ../data/{balance,units}.js.

import { mulberry32, clamp, formatNum } from '../util/fmt.js';
import { emit } from '../util/events.js';
import { S, ensureUnit, addLog, markDirty, findBuilding } from './state.js';
import * as combat from './combat.js';
import * as bonusMod from './bonus.js';
import {
  MARCH_SPEED, GATHER, COMBAT, HOSPITAL_RATIO, RES_ORDER, RAID, costAt
} from '../data/balance.js';
import { UNITS, unitKey, counter } from '../data/units.js';
import { protectedAmount } from './economy.js';

/** World grid dimensions. Tiles are stored flat, index = y * MAP_W + x. */
export const MAP_W = 40;
export const MAP_H = 40;

/** Where the player's city is planted. */
export const CENTER = { x: 20, y: 20 };

const MAX_DIST = Math.sqrt(CENTER.x * CENTER.x + CENTER.y * CENTER.y);
const RES_KINDS = ['oil', 'steel', 'rare', 'food'];
/** Baseline march speed (inf1) used to convert unit speed into seconds/tile. */
const BASE_UNIT_SPEED = 14;
/** Safety guard so a corrupt march can never spin tickMarches forever. */
const MAX_STAGE_STEPS = 24;

// ---------------------------------------------------------------------------
// Bonus access — soft dependency on the central engine/bonus.js
// ---------------------------------------------------------------------------

let bonusProvider = null;

/**
 * Override the bonus source (defaults to engine/bonus.js getBonus).
 * @param {(key:string)=>number|null} fn
 */
export function setBonusProvider(fn) {
  bonusProvider = typeof fn === 'function' ? fn : null;
}

/**
 * Additive fractional bonus for `key` (0.15 === +15%).
 * @param {string} key one of data/tech.js BONUS_KEYS
 * @returns {number}
 */
export function getBonus(key) {
  const fn = bonusProvider || bonusMod.getBonus;
  if (typeof fn !== 'function') return 0;
  const v = Number(fn(key));
  return Number.isFinite(v) ? v : 0;
}

/**
 * Sum of a BUILDING-EFFECT key across every standing building
 * ('march.slots', 'march.speed', 'map.vision', 'heal.capacity', ...).
 * @param {string} key
 * @returns {number}
 */
function effectTotal(key) {
  if (typeof bonusMod.getEffectTotal !== 'function') return 0;
  const v = Number(bonusMod.getEffectTotal(key));
  return Number.isFinite(v) ? v : 0;
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Flat index for a coordinate, or -1 when out of bounds. */
export function tileIndex(x, y) {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  if (!(ix >= 0 && ix < MAP_W && iy >= 0 && iy < MAP_H)) return -1;
  return iy * MAP_W + ix;
}

/** Euclidean tile distance. */
export function distance(ax, ay, bx, by) {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** The player's city coordinate (falls back to CENTER if the tile is missing). */
export function cityPos() {
  const tiles = S.map.tiles;
  if (Array.isArray(tiles)) {
    for (let i = 0; i < tiles.length; i++) {
      const t = tiles[i];
      if (t && t.type === 'city' && t.owner === 'player') return { x: t.x, y: t.y };
    }
  }
  return { x: CENTER.x, y: CENTER.y };
}

/** Power of an NPC unit map. */
export function npcPower(units) {
  let p = 0;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    const u = UNITS[k];
    if (u) p += u.power * (Math.floor(units[k]) || 0);
  }
  return Math.round(p);
}

/** Resource haul a level-`level` NPC base drops when destroyed. */
export function npcLoot(level) {
  const l = clamp(Math.floor(Number(level) || 1), 1, 30);
  return {
    oil: costAt(700, 1.26, l),
    steel: costAt(700, 1.26, l),
    rare: costAt(90, 1.3, l),
    food: costAt(500, 1.26, l)
  };
}

/** Build the garrison of a level-`level` NPC base. Deterministic given `rand`. */
function npcGarrison(level, rand) {
  const l = clamp(Math.floor(level), 1, 30);
  const tier = clamp(Math.ceil(l / 4), 1, 8);
  // Headcount grows geometrically with level; ±15% jitter keeps bases distinct.
  const head = Math.max(6, Math.round(14 * Math.pow(1.19, l - 1) * (0.85 + rand() * 0.3)));
  const mix = { infantry: 1, tank: 0, aircraft: 0, artillery: 0 };
  if (l >= 5) { mix.infantry = 0.6; mix.tank = 0.4; }
  if (l >= 12) { mix.infantry = 0.45; mix.tank = 0.32; mix.aircraft = 0.23; }
  if (l >= 18) { mix.infantry = 0.34; mix.tank = 0.28; mix.aircraft = 0.22; mix.artillery = 0.16; }
  const units = {};
  for (const cls in mix) {
    const share = mix[cls];
    if (share <= 0) continue;
    const n = Math.max(1, Math.round(head * share));
    units[unitKey(cls, tier)] = n;
  }
  return units;
}

/**
 * Generate the 40x40 world deterministically from `seed` and write it into
 * S.map (tiles + seed + explored). Empty tiles are stored as the number 0 so
 * the save stays small; special tiles are stored as full objects.
 * @param {number} seed
 * @returns {Array} the flat tile array (also assigned to S.map.tiles)
 */
export function generateMap(seed) {
  const s = (Math.floor(Math.abs(Number(seed) || 1)) >>> 0) || 1;
  const rand = mulberry32(s);
  const tiles = new Array(MAP_W * MAP_H).fill(0);

  for (let y = 0; y < MAP_H; y++) {
    for (let x = 0; x < MAP_W; x++) {
      const d = distance(x, y, CENTER.x, CENTER.y);
      if (d <= 2.2) continue;                       // keep the city's doorstep clear
      const norm = clamp(d / MAX_DIST, 0, 1);
      const r = rand();
      const pRes = 0.07 + 0.13 * norm;
      const pNpc = 0.025 + 0.10 * norm;
      const pRuin = 0.018 + 0.012 * norm;
      if (r < pRes) {
        const kind = RES_KINDS[Math.floor(rand() * RES_KINDS.length) % RES_KINDS.length];
        const level = clamp(1 + Math.floor(norm * 5.4 + rand() * 1.6), 1, 6);
        tiles[y * MAP_W + x] = makeResTile(x, y, kind, level);
      } else if (r < pRes + pNpc) {
        const level = clamp(Math.round(1 + norm * 29 * (0.75 + rand() * 0.5)), 1, 30);
        const units = npcGarrison(level, rand);
        tiles[y * MAP_W + x] = {
          x, y, type: 'npc',
          npc: { level, units, power: npcPower(units) }
        };
      } else if (r < pRes + pNpc + pRuin) {
        tiles[y * MAP_W + x] = { x, y, type: 'ruins', ruins: { level: clamp(1 + Math.floor(norm * 5), 1, 6) } };
      }
    }
  }

  // The city itself.
  tiles[CENTER.y * MAP_W + CENTER.x] = {
    x: CENTER.x, y: CENTER.y, type: 'city', owner: 'player',
    city: { name: S.player && S.player.name ? S.player.name : 'Commander' }
  };

  // Guarantee an early-game economy: one low-level node of each kind close by,
  // plus two easy NPC camps to farm. Placed on a deterministic spiral.
  const near = [];
  for (let ring = 3; ring <= 7 && near.length < 40; ring++) {
    for (let a = 0; a < 24; a++) {
      const ang = (a / 24) * Math.PI * 2 + ring;
      const x = CENTER.x + Math.round(Math.cos(ang) * ring);
      const y = CENTER.y + Math.round(Math.sin(ang) * ring);
      const i = tileIndex(x, y);
      if (i < 0) continue;
      if (near.indexOf(i) === -1) near.push(i);
    }
  }
  let cursor = 0;
  for (let k = 0; k < RES_KINDS.length; k++) {
    const i = near[cursor++ % near.length];
    const x = i % MAP_W;
    const y = Math.floor(i / MAP_W);
    tiles[i] = makeResTile(x, y, RES_KINDS[k], k < 2 ? 2 : 1);
  }
  for (let k = 0; k < 2; k++) {
    const i = near[(cursor++ * 5) % near.length];
    if (tiles[i] && tiles[i].type === 'city') continue;
    const x = i % MAP_W;
    const y = Math.floor(i / MAP_W);
    const level = k + 1;
    const units = npcGarrison(level, rand);
    tiles[i] = { x, y, type: 'npc', npc: { level, units, power: npcPower(units) } };
  }

  S.map.seed = s;
  S.map.tiles = tiles;
  if (!S.map.explored || typeof S.map.explored !== 'object' || Array.isArray(S.map.explored)) {
    S.map.explored = {};
  }
  revealAround(CENTER.x, CENTER.y, visionRadius());
  markDirty();
  emit('state:changed', { reason: 'map:generated' });
  return tiles;
}

function makeResTile(x, y, kind, level) {
  const amount = Math.round(GATHER.nodeBase * Math.pow(GATHER.nodeMult, level - 1));
  return { x, y, type: 'res', res: { kind, level, amount, max: amount } };
}

/** Generate the map if S.map.tiles is empty/corrupt. Safe to call every boot. */
export function ensureMap() {
  const t = S.map.tiles;
  if (!Array.isArray(t) || t.length !== MAP_W * MAP_H) {
    return generateMap(S.map.seed || 1);
  }
  if (!S.map.explored || typeof S.map.explored !== 'object' || Array.isArray(S.map.explored)) {
    S.map.explored = {};
  }
  if (!Array.isArray(S.map.marches)) S.map.marches = [];
  return t;
}

/** Wipe and rebuild the world from a new seed (keeps marches home first). */
export function regenerateMap(seed) {
  const list = activeMarches().slice();
  for (let i = 0; i < list.length; i++) returnUnitsHome(list[i].units);
  S.map.marches = [];
  S.map.explored = {};
  return generateMap(seed === undefined ? S.map.seed : seed);
}

// ---------------------------------------------------------------------------
// Selectors
// ---------------------------------------------------------------------------

/**
 * Tile at a coordinate. Special tiles are returned BY REFERENCE (mutating
 * `res.amount` mutates the save); empty tiles come back as a fresh descriptor.
 * @returns {{x:number,y:number,type:string,res?:object,npc?:object,owner?:string}|null} null when out of bounds
 */
export function tileAt(x, y) {
  const i = tileIndex(x, y);
  if (i < 0) return null;
  const t = ensureMap()[i];
  if (t && typeof t === 'object') return t;
  return { x: Math.floor(x), y: Math.floor(y), type: 'empty' };
}

/** Overwrite a tile slot (pass null/0 for empty). */
export function setTile(x, y, tile) {
  const i = tileIndex(x, y);
  if (i < 0) return false;
  ensureMap()[i] = tile && typeof tile === 'object' ? tile : 0;
  markDirty();
  return true;
}

/** Make a tile empty. */
export function clearTile(x, y) {
  return setTile(x, y, 0);
}

/**
 * Every tile whose centre is within `r` tiles of (x,y), nearest first.
 * @returns {object[]} live tile objects / empty descriptors
 */
export function tilesInRadius(x, y, r) {
  const out = [];
  const rad = Math.max(0, Number(r) || 0);
  const x0 = Math.max(0, Math.floor(x - rad));
  const x1 = Math.min(MAP_W - 1, Math.ceil(x + rad));
  const y0 = Math.max(0, Math.floor(y - rad));
  const y1 = Math.min(MAP_H - 1, Math.ceil(y + rad));
  for (let ty = y0; ty <= y1; ty++) {
    for (let tx = x0; tx <= x1; tx++) {
      const d = distance(tx, ty, x, y);
      if (d > rad) continue;
      const t = tileAt(tx, ty);
      if (t) { t._d = d; out.push(t); }
    }
  }
  out.sort((a, b) => a._d - b._d);
  for (let i = 0; i < out.length; i++) delete out[i]._d;
  return out;
}

/** All non-empty tiles (city, resource nodes, NPC bases, ruins). */
export function allSpecialTiles() {
  const tiles = ensureMap();
  const out = [];
  for (let i = 0; i < tiles.length; i++) {
    if (tiles[i] && typeof tiles[i] === 'object') out.push(tiles[i]);
  }
  return out;
}

/**
 * Closest tile satisfying `pred`, searched outward from `from` (default: the city).
 * @param {(tile:object)=>boolean} pred
 * @param {{x:number,y:number}} [from]
 * @returns {object|null}
 */
export function nearestTile(pred, from) {
  if (typeof pred !== 'function') return null;
  const origin = from || cityPos();
  let best = null;
  let bestD = Infinity;
  const list = allSpecialTiles();
  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    let ok = false;
    try { ok = !!pred(t); } catch (err) { ok = false; }
    if (!ok) continue;
    const d = distance(t.x, t.y, origin.x, origin.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  return best;
}

/** Current world-map vision radius (radar + a small base). */
export function visionRadius() {
  return Math.max(5, Math.round(5 + effectTotal('map.vision')));
}

/** Has the player seen this tile? */
export function isExplored(x, y) {
  return !!S.map.explored[Math.floor(x) + ',' + Math.floor(y)];
}

/** Mark a tile explored. */
export function markExplored(x, y) {
  const i = tileIndex(x, y);
  if (i < 0) return;
  S.map.explored[Math.floor(x) + ',' + Math.floor(y)] = 1;
  markDirty();
}

function revealAround(x, y, r) {
  const rad = Math.max(0, r);
  for (let ty = Math.max(0, Math.floor(y - rad)); ty <= Math.min(MAP_H - 1, Math.ceil(y + rad)); ty++) {
    for (let tx = Math.max(0, Math.floor(x - rad)); tx <= Math.min(MAP_W - 1, Math.ceil(x + rad)); tx++) {
      if (distance(tx, ty, x, y) <= rad) markExplored(tx, ty);
    }
  }
}

function revealPath(from, to) {
  const steps = Math.max(1, Math.ceil(distance(from.x, from.y, to.x, to.y)));
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    revealAround(Math.round(from.x + (to.x - from.x) * f), Math.round(from.y + (to.y - from.y) * f), 1);
  }
}

// ---------------------------------------------------------------------------
// March maths
// ---------------------------------------------------------------------------

/** Concurrent march slots: HQ + Radar effects, clamped to a sane range. */
export function getMarchCapacity() {
  return clamp(Math.floor(effectTotal('march.slots')) || 1, 1, 8);
}

/** Live marches. */
export function activeMarches() {
  if (!Array.isArray(S.map.marches)) S.map.marches = [];
  return S.map.marches;
}

/** March by id. */
export function getMarch(id) {
  const list = activeMarches();
  for (let i = 0; i < list.length; i++) if (list[i].id === id) return list[i];
  return null;
}

/** Total units in a {unitKey:count} map. */
function totalUnits(units) {
  let n = 0;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    n += Math.max(0, Math.floor(units[k]) || 0);
  }
  return n;
}

/**
 * Carry capacity of a force, including the 'load.capacity' bonus.
 * @param {Object<string,number>} units
 * @returns {number}
 */
export function getLoadCapacity(units) {
  let load = 0;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    const u = UNITS[k];
    if (u) load += u.load * Math.max(0, Math.floor(units[k]) || 0);
  }
  return Math.floor(load * (1 + Math.max(-0.9, getBonus('load.capacity'))));
}

/**
 * Resource units gathered per second by this force.
 * @param {Object<string,number>} units
 * @returns {number}
 */
export function getGatherRate(units) {
  const load = getLoadCapacity(units);
  const perHour = load * GATHER.perLoadPerHour;
  return Math.max(0.01, (perHour / 3600) * (1 + Math.max(-0.9, getBonus('gather.speed'))));
}

/** Speed of the slowest unit in the force (governs the whole column). */
function slowestSpeed(units) {
  let slow = Infinity;
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    if ((Math.floor(units[k]) || 0) <= 0) continue;
    const u = UNITS[k];
    if (u && u.speed < slow) slow = u.speed;
  }
  return Number.isFinite(slow) ? slow : BASE_UNIT_SPEED;
}

/**
 * One-way travel time in seconds.
 * @param {number} dist tiles
 * @param {Object<string,number>} units
 * @param {boolean} [isReturn] apply MARCH_SPEED.returnMult
 * @returns {number} integer seconds
 */
export function marchTravelSeconds(dist, units, isReturn) {
  const speed = slowestSpeed(units);
  const perTile = MARCH_SPEED.secPerTile * MARCH_SPEED.slowestUnitWeight * (BASE_UNIT_SPEED / Math.max(1, speed));
  let sec = Math.max(0, dist) * perTile;
  sec /= (1 + Math.max(-0.75, getBonus('march.speed')));
  if (isReturn) sec *= MARCH_SPEED.returnMult;
  return Math.round(clamp(sec, MARCH_SPEED.minSec, MARCH_SPEED.maxSec));
}

// ---------------------------------------------------------------------------
// Sending / recalling
// ---------------------------------------------------------------------------

/**
 * Dispatch a march. Units are deducted from S.army immediately.
 * @param {{toX:number,toY:number,kind:'gather'|'attack',units:Object<string,number>,officer?:string|null}} opts
 * @returns {{ok:boolean, march?:object, reason?:string}}
 */
export function sendMarch(opts) {
  const o = opts || {};
  const kind = o.kind === 'attack' ? 'attack' : 'gather';
  const tile = tileAt(o.toX, o.toY);
  if (!tile) return fail('That tile is off the map.');
  if (tile.type === 'city') return fail('You cannot march on your own city.');
  if (kind === 'attack' && tile.type !== 'npc') return fail('There is nothing to attack there.');
  if (kind === 'gather' && tile.type !== 'res' && tile.type !== 'ruins') {
    return fail('There is nothing to gather there.');
  }
  if (tile.type === 'res' && tile.res.amount <= 0) return fail('That node is exhausted.');

  const units = {};
  let count = 0;
  const src = o.units || {};
  for (const k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    const n = Math.max(0, Math.floor(Number(src[k]) || 0));
    if (n <= 0) continue;
    if (!UNITS[k]) return fail('Unknown unit "' + k + '".');
    const have = S.army[k] ? S.army[k].count : 0;
    if (n > have) return fail('Not enough ' + UNITS[k].name + ' (have ' + have + ', need ' + n + ').');
    units[k] = n;
    count += n;
  }
  if (count <= 0) return fail('Select at least one unit.');
  if (activeMarches().length >= getMarchCapacity()) return fail('All march slots are busy.');

  for (const k in units) S.army[k].count -= units[k];

  const from = cityPos();
  const now = Date.now();
  const dist = distance(from.x, from.y, tile.x, tile.y);
  const travel = marchTravelSeconds(dist, units, false);
  const march = {
    id: 'm_' + now.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36),
    from: { x: from.x, y: from.y },
    to: { x: tile.x, y: tile.y },
    units,
    kind,
    state: 'moving',
    startAt: now,
    arriveAt: now + travel * 1000,
    officer: typeof o.officer === 'string' ? o.officer : null,
    payload: { loot: emptyLoot(), dist, travelSec: travel, target: tile.type, report: null }
  };
  activeMarches().push(march);
  markDirty();
  addLog('march', (kind === 'attack' ? 'Attack force' : 'Gather column') + ' of ' + formatNum(count) +
    ' units marching to (' + tile.x + ',' + tile.y + ').', { id: march.id });
  emit('state:changed', { reason: 'march:sent' });
  return { ok: true, march };
}

function fail(reason) {
  emit('toast', { type: 'error', text: reason });
  return { ok: false, reason };
}

function emptyLoot() {
  return { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 };
}

/**
 * Turn a march around right now. Partial gathering loot is kept.
 * @param {string} id
 * @returns {{ok:boolean, march?:object, reason?:string}}
 */
export function recallMarch(id) {
  const m = getMarch(id);
  if (!m) return { ok: false, reason: 'No such march.' };
  if (m.kind === 'return') return { ok: true, march: m };
  const now = Date.now();
  const home = cityPos();

  if (m.state === 'gathering') {
    // A scavenge pays nothing before its timer is up — say so rather than
    // sending the column home empty with no explanation.
    if (m.payload && m.payload.scavenge && now < (Number(m.gatherUntil) || 0)) {
      emit('toast', { msg: 'Scavenge abandoned — the cache is still intact.', kind: 'warn' });
      addLog('march', 'Scavenge abandoned — the ruins are untouched.', { id: m.id });
    }
    const gathered = harvest(m, now);
    if (gathered) depositIntoPayload(m, gathered);
  }
  let travelled = distance(m.to.x, m.to.y, home.x, home.y);
  if (m.state === 'moving') {
    const span = Math.max(1, m.arriveAt - m.startAt);
    const f = clamp((now - m.startAt) / span, 0, 1);
    travelled = distance(m.from.x, m.from.y, m.to.x, m.to.y) * f;
  }
  const travel = marchTravelSeconds(travelled, m.units, true);
  m.kind = 'return';
  m.state = 'moving';
  m.from = { x: m.to.x, y: m.to.y };
  m.to = { x: home.x, y: home.y };
  m.startAt = now;
  m.arriveAt = now + travel * 1000;
  markDirty();
  addLog('march', 'March recalled — returning home.', { id: m.id });
  emit('state:changed', { reason: 'march:recalled' });
  return { ok: true, march: m };
}

// ---------------------------------------------------------------------------
// Ticking
// ---------------------------------------------------------------------------

/**
 * Advance every march up to `now`. Safe for large offline gaps: each stage
 * transition is timestamped from the stage it completed, not from `now`.
 * @param {number} [now] wall clock ms
 * @returns {number} number of marches that completed a stage
 */
export function tickMarches(now) {
  ensureMap();
  const t = typeof now === 'number' ? now : Date.now();
  const list = activeMarches();
  let events = 0;
  for (let i = list.length - 1; i >= 0; i--) {
    const m = list[i];
    if (!m || typeof m !== 'object') { list.splice(i, 1); continue; }
    if (!m.units || totalUnits(m.units) <= 0) { list.splice(i, 1); continue; }
    let steps = 0;
    while (steps++ < MAX_STAGE_STEPS) {
      const due = stageDueAt(m);
      if (!Number.isFinite(due) || due > t) break;
      const finished = resolveStage(m, due);
      events++;
      if (finished) { list.splice(i, 1); break; }
    }
  }
  // Raids resolve after the marches, so troops that got home first defend.
  events += tickRaids(t);
  if (events > 0) {
    markDirty();
    emit('state:changed', { reason: 'march:tick' });
  }
  return events;
}

function stageDueAt(m) {
  if (m.state === 'gathering') return Number(m.gatherUntil) || Infinity;
  return Number(m.arriveAt) || Infinity;
}

/**
 * Resolve one completed stage of a march at time `at`.
 * @returns {boolean} true when the march is finished and must be removed
 */
function resolveStage(m, at) {
  if (m.kind === 'return') {
    finishReturn(m, at);
    return true;
  }
  if (m.kind === 'gather') {
    if (m.state === 'moving') return arriveGather(m, at);
    if (m.state === 'gathering') return finishGather(m, at);
    return true;
  }
  if (m.kind === 'attack') return arriveAttack(m, at);
  return true;
}

function arriveGather(m, at) {
  revealPath(m.from, m.to);
  const tile = tileAt(m.to.x, m.to.y);
  if (!tile || (tile.type !== 'res' && tile.type !== 'ruins')) {
    beginReturn(m, at, 'Nothing left to gather at (' + m.to.x + ',' + m.to.y + ').');
    return false;
  }
  const cap = getLoadCapacity(m.units);
  if (tile.type === 'ruins') {
    // Ruins are a fixed-time scavenge, not a rate-limited node.
    m.state = 'gathering';
    m.payload.scavenge = true;
    m.payload.gatherStart = at;
    m.gatherUntil = at + 300 * 1000;
    return false;
  }
  const take = Math.max(1, Math.min(tile.res.amount, cap));
  const rate = getGatherRate(m.units);
  const sec = clamp(Math.ceil(take / rate), 5, GATHER.maxSec);
  m.state = 'gathering';
  m.payload.scavenge = false;
  m.payload.gatherStart = at;
  m.payload.gatherTake = take;
  m.payload.gatherRate = rate;
  m.payload.kindRes = tile.res.kind;
  m.gatherUntil = at + sec * 1000;
  emit('march:arrived', { march: m, phase: 'gathering', tile });
  return false;
}

/** Pull what has been gathered so far out of the node. Returns a loot object or null. */
function harvest(m, at) {
  const tile = tileAt(m.to.x, m.to.y);
  if (!tile) return null;
  if (m.payload.scavenge) {
    if (tile.type !== 'ruins') return null;
    // Scavenging is all-or-nothing: recalling early abandons the dig and leaves
    // the ruin intact. Without this an instant recall banked the whole haul for
    // 0 of the 300 s. finishGather() calls us with at === m.gatherUntil, so the
    // completed path is unaffected.
    if (at < (Number(m.gatherUntil) || Infinity)) return null;
    const lv = (tile.ruins && tile.ruins.level) || 1;
    const raw = emptyLoot();
    raw.oil = costAt(600, 1.35, lv);
    raw.steel = costAt(600, 1.35, lv);
    raw.rare = costAt(120, 1.4, lv);
    raw.food = costAt(400, 1.35, lv);
    // The column can only carry what it can carry, same as an ordinary node.
    const cap = getLoadCapacity(m.units);
    const sum = RES_ORDER.reduce((n, k) => n + raw[k], 0) || 1;
    const scale = Math.min(1, cap / sum);
    const loot = emptyLoot();
    for (let i = 0; i < RES_ORDER.length; i++) {
      loot[RES_ORDER[i]] = Math.floor(raw[RES_ORDER[i]] * scale);
    }
    loot.gold = 5 * lv;
    clearTile(tile.x, tile.y);
    return loot;
  }
  if (tile.type !== 'res') return null;
  const start = Number(m.payload.gatherStart) || m.arriveAt || at;
  const rate = Number(m.payload.gatherRate) || getGatherRate(m.units);
  const elapsed = Math.max(0, (at - start) / 1000);
  const wanted = Math.min(Number(m.payload.gatherTake) || 0, Math.floor(elapsed * rate));
  const got = Math.max(0, Math.min(wanted, tile.res.amount));
  if (got <= 0) return null;
  tile.res.amount -= got;
  if (tile.res.amount <= 0) clearTile(tile.x, tile.y);
  const loot = emptyLoot();
  loot[tile.res.kind] = got;
  return loot;
}

function finishGather(m, at) {
  const loot = harvest(m, at);
  if (loot) depositIntoPayload(m, loot);
  const total = RES_ORDER.reduce((n, k) => n + (m.payload.loot[k] || 0), 0) + (m.payload.loot.gold || 0);
  beginReturn(m, at, 'Gathering complete — ' + formatNum(total) + ' resources loaded.');
  return false;
}

function arriveAttack(m, at) {
  revealPath(m.from, m.to);
  const tile = tileAt(m.to.x, m.to.y);
  if (!tile || tile.type !== 'npc') {
    beginReturn(m, at, 'The enemy camp at (' + m.to.x + ',' + m.to.y + ') was already gone.');
    return false;
  }
  const result = runBattle(m.units, tile.npc.units, {
    officer: m.officer,
    attackerSide: 'player',
    context: 'worldmap',
    tile: { x: tile.x, y: tile.y, level: tile.npc.level }
  });
  applyBattleOutcome(m, result, at);

  emit('battle:result', {
    source: 'worldmap',
    marchId: m.id,
    tile: { x: tile.x, y: tile.y, level: tile.npc.level },
    win: result.win,
    report: result.report
  });
  S.stats[result.win ? 'battlesWon' : 'battlesLost'] += 1;
  S.stats.unitsLost += result.attackerLost;
  S.stats.unitsKilled += result.defenderLost;

  if (result.win) {
    const cap = getLoadCapacity(m.units);
    const raw = npcLoot(tile.npc.level);
    const sum = RES_ORDER.reduce((n, k) => n + raw[k], 0) || 1;
    const scale = Math.min(1, cap / sum);
    const loot = emptyLoot();
    for (let i = 0; i < RES_ORDER.length; i++) {
      loot[RES_ORDER[i]] = Math.floor(raw[RES_ORDER[i]] * scale * COMBAT.lootShare * 2);
    }
    loot.gold = Math.max(1, Math.floor(tile.npc.level / 2));
    depositIntoPayload(m, loot);
    // Cleared camps leave ruins behind that can still be scavenged once.
    setTile(tile.x, tile.y, { x: tile.x, y: tile.y, type: 'ruins', ruins: { level: clamp(Math.ceil(tile.npc.level / 5), 1, 6) } });
    addLog('battle', 'Victory at (' + tile.x + ',' + tile.y + ') — Lv' + tile.npc.level + ' camp destroyed.', { marchId: m.id });
  } else {
    // A repelled attack still thins the garrison out.
    if (totalUnits(result.defenderSurvivors) > 0) {
      tile.npc.units = result.defenderSurvivors;
      tile.npc.power = npcPower(tile.npc.units);
      addLog('battle', 'Defeat at (' + tile.x + ',' + tile.y + ') — the column falls back.', { marchId: m.id });
      // A camp that beats off an assault sends a punitive column at your city.
      scheduleRaid(tile, at);
    } else {
      clearTile(tile.x, tile.y);
      addLog('battle', 'Defeat at (' + tile.x + ',' + tile.y + ') — the column falls back.', { marchId: m.id });
    }
  }

  if (totalUnits(m.units) <= 0) {
    addLog('battle', 'The entire march was wiped out at (' + m.to.x + ',' + m.to.y + ').', { marchId: m.id });
    emit('march:arrived', { march: m, phase: 'destroyed', win: false });
    return true;
  }
  beginReturn(m, at, null);
  return false;
}

/**
 * Apply a battle result to the march: survivors stay in m.units, casualties are
 * split into dead and wounded (wounded ride home and land in the hospital pool).
 */
function applyBattleOutcome(m, result, at) {
  let lost = 0;
  let wounded = 0;
  const before = m.units;
  const after = {};
  for (const k in before) {
    if (!Object.prototype.hasOwnProperty.call(before, k)) continue;
    const had = Math.floor(before[k]) || 0;
    const left = clamp(Math.floor(Number(result.attackerSurvivors[k]) || 0), 0, had);
    after[k] = left;
    const casualties = had - left;
    if (casualties > 0) {
      // Prefer combat.js's own dead/wounded split when the report carries one.
      const detail = result.losses && result.losses[k];
      const w = detail && Number.isFinite(Number(detail.wounded))
        ? clamp(Math.floor(Number(detail.wounded)), 0, casualties)
        : Math.round(casualties * HOSPITAL_RATIO);
      m.payload.wounded = m.payload.wounded || {};
      m.payload.wounded[k] = (m.payload.wounded[k] || 0) + w;
      wounded += w;
      lost += casualties - w;
    }
  }
  for (const k in after) if (after[k] <= 0) delete after[k];
  m.units = after;
  m.payload.report = result.report;
  m.payload.battleAt = at;
  result.attackerLost = lost + wounded;
  result.wounded = wounded;
}

function beginReturn(m, at, note) {
  const home = cityPos();
  const dist = distance(m.to.x, m.to.y, home.x, home.y);
  const travel = marchTravelSeconds(dist, m.units, true);
  m.kind = 'return';
  m.state = 'moving';
  m.from = { x: m.to.x, y: m.to.y };
  m.to = { x: home.x, y: home.y };
  m.startAt = at;
  m.arriveAt = at + travel * 1000;
  m.gatherUntil = 0;
  if (note) addLog('march', note, { id: m.id });
}

function finishReturn(m, at) {
  returnUnitsHome(m.units);
  const wounded = m.payload && m.payload.wounded;
  if (wounded) {
    // Wounded only survive if the Hospital has a free bed; the rest are lost.
    let beds = hospitalBeds();
    let admitted = 0;
    let overflow = 0;
    for (const k in wounded) {
      if (!Object.prototype.hasOwnProperty.call(wounded, k)) continue;
      const n = Math.max(0, Math.floor(wounded[k]) || 0);
      if (n <= 0) continue;
      const admit = Math.max(0, Math.min(n, beds));
      beds -= admit;
      admitted += admit;
      overflow += n - admit;
      if (admit > 0) ensureUnit(k).wounded += admit;
    }
    if (admitted > 0 || overflow > 0) {
      addLog('battle', formatNum(admitted) + ' wounded admitted to the hospital' +
        (overflow > 0 ? ', ' + formatNum(overflow) + ' lost for lack of beds' : '') + '.', { id: m.id });
    }
  }
  const stored = depositLoot(m.payload ? m.payload.loot : null);
  const total = RES_ORDER.reduce((n, k) => n + (stored[k] || 0), 0);
  if (total > 0 || stored.gold > 0) {
    addLog('march', 'March returned with ' + formatNum(total) + ' resources' +
      (stored.gold ? ' and ' + formatNum(stored.gold) + ' gold' : '') + '.', { id: m.id });
  } else {
    addLog('march', 'March returned home.', { id: m.id });
  }
  emit('march:arrived', { march: m, phase: 'home', loot: stored, at });
  emit('res:changed', S.res);
}

/** Free hospital beds right now (0 when there is no hospital). */
function hospitalBeds() {
  let cap = 0;
  let used = 0;
  if (typeof combat.hospitalCapacity === 'function') {
    cap = Math.max(0, Math.floor(Number(combat.hospitalCapacity()) || 0));
  } else {
    cap = Math.max(0, Math.floor(effectTotal('heal.capacity')));
  }
  if (typeof combat.woundedTotal === 'function') {
    used = Math.max(0, Math.floor(Number(combat.woundedTotal()) || 0));
  } else {
    for (const k in S.army) {
      if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
      used += Math.max(0, Math.floor(S.army[k].wounded) || 0);
    }
  }
  return Math.max(0, cap - used);
}

function returnUnitsHome(units) {
  for (const k in units) {
    if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
    const n = Math.max(0, Math.floor(units[k]) || 0);
    if (n > 0) ensureUnit(k).count += n;
  }
}

function depositIntoPayload(m, loot) {
  if (!m.payload.loot) m.payload.loot = emptyLoot();
  for (const k in loot) {
    if (!Object.prototype.hasOwnProperty.call(loot, k)) continue;
    m.payload.loot[k] = (m.payload.loot[k] || 0) + (Math.floor(loot[k]) || 0);
  }
}

/** Credit loot to S.res, honouring storage caps (gold is uncapped). */
function depositLoot(loot) {
  const stored = emptyLoot();
  if (!loot) return stored;
  for (let i = 0; i < RES_ORDER.length; i++) {
    const k = RES_ORDER[i];
    const want = Math.max(0, Math.floor(loot[k]) || 0);
    if (want <= 0) continue;
    const cap = Number(S.cap[k]);
    const room = Number.isFinite(cap) && cap > 0 ? Math.max(0, cap - S.res[k]) : want;
    const got = Math.min(want, room);
    S.res[k] += got;
    stored[k] = got;
  }
  const gold = Math.max(0, Math.floor(loot.gold) || 0);
  if (gold > 0) { S.res.gold += gold; stored.gold = gold; }
  markDirty();
  return stored;
}

// ---------------------------------------------------------------------------
// Combat adapter — every call into engine/combat.js is shape-tolerant, and a
// missing export or a thrown error aborts the attack instead of losing units.
// ---------------------------------------------------------------------------

/**
 * @param {Object<string,number>} atk
 * @param {Object<string,number>} def
 * @param {object} opts
 * @returns {{win:boolean, attackerSurvivors:object, defenderSurvivors:object,
 *            attackerLost:number, defenderLost:number, report:object}}
 */
function runBattle(atk, def, opts) {
  if (typeof combat.resolveBattle === 'function') {
    try {
      const raw = combat.resolveBattle(
        playerForce(atk, opts.officer || null, 'Expedition'),
        { units: shallowCopy(def), officer: null, name: opts.enemyName || 'Enemy Camp', isDefender: true },
        { kind: 'worldmap', label: opts.label || '', seed: opts.seed }
      );
      const norm = normalizeBattle(raw, atk, def);
      if (norm) return norm;
    } catch (err) {
      console.warn('[worldmap] combat.resolveBattle threw', err);
    }
  }
  return abortedBattle(atk, def);
}

/** Wrap a player force with the current tech/officer/building bonuses. */
function playerForce(units, officer, name) {
  const bonuses = {};
  if (typeof bonusMod.getAllBonuses === 'function') {
    const all = bonusMod.getAllBonuses();
    for (const k in all) {
      if (Object.prototype.hasOwnProperty.call(all, k)) bonuses[k] = all[k];
    }
  } else {
    const cls = ['infantry', 'tank', 'aircraft', 'artillery'];
    for (let i = 0; i < cls.length; i++) {
      bonuses['atk.' + cls[i]] = getBonus('atk.' + cls[i]);
      bonuses['def.' + cls[i]] = getBonus('def.' + cls[i]);
      bonuses['hp.' + cls[i]] = getBonus('hp.' + cls[i]);
    }
  }
  const owned = S.officers && S.officers.owned ? S.officers.owned[officer] : null;
  return {
    units: shallowCopy(units),
    officer: officer || null,
    officerStars: owned ? owned.stars : 1,
    bonuses,
    isDefender: false,
    name: name || 'Expedition'
  };
}

function shallowCopy(o) {
  const out = {};
  for (const k in o) if (Object.prototype.hasOwnProperty.call(o, k)) out[k] = o[k];
  return out;
}

/** Accept several plausible result shapes from combat.js. */
function normalizeBattle(raw, atk, def) {
  if (!raw || typeof raw !== 'object') return null;
  const aSurv = pickUnitMap(raw, 'attackerSurvivors', raw.attacker);
  const dSurv = pickUnitMap(raw, 'defenderSurvivors', raw.defender);
  if (!aSurv || !dSurv) return null;
  let win = raw.win;
  if (typeof win !== 'boolean') {
    const w = raw.winner || raw.victor;
    if (typeof w === 'string') win = /^(a|attacker|player|left)$/i.test(w);
    else win = totalUnits(aSurv) > 0 && totalUnits(dSurv) === 0;
  }
  return {
    win: !!win,
    attackerSurvivors: aSurv,
    defenderSurvivors: dSurv,
    attackerLost: Math.max(0, totalUnits(atk) - totalUnits(aSurv)),
    defenderLost: Math.max(0, totalUnits(def) - totalUnits(dSurv)),
    losses: (raw.attackerLosses && typeof raw.attackerLosses === 'object') ? raw.attackerLosses : null,
    report: raw.report || raw
  };
}

/** Extract a {unitKey:count} map from a report field, or null when unusable. */
function pickUnitMap(raw, name, side) {
  const cands = [raw[name], side && side.survivors, side && side.remaining, side && side.units];
  for (let i = 0; i < cands.length; i++) {
    if (isUnitMap(cands[i])) return normalizeUnitMap(cands[i]);
  }
  return null;
}

function isUnitMap(v) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    if (!UNITS[k] || typeof v[k] !== 'number') return false;
  }
  return true;
}

function normalizeUnitMap(v) {
  const out = {};
  for (const k in v) {
    if (!Object.prototype.hasOwnProperty.call(v, k)) continue;
    const n = Math.max(0, Math.floor(v[k]) || 0);
    if (n > 0) out[k] = n;
  }
  return out;
}

/**
 * Used only if engine/combat.js could not resolve the fight (missing export or
 * a thrown error). The attack is treated as called off: nobody dies, nothing is
 * looted, and the column turns around — never a silent unit wipe.
 */
function abortedBattle(atk, def) {
  console.error('[worldmap] combat.resolveBattle unavailable — attack aborted.');
  return {
    win: false,
    attackerSurvivors: normalizeUnitMap(atk),
    defenderSurvivors: normalizeUnitMap(def),
    attackerLost: 0,
    defenderLost: 0,
    losses: null,
    report: { aborted: true, attacker: shallowCopy(atk), defender: shallowCopy(def) }
  };
}


// ---------------------------------------------------------------------------
// Scouting
// ---------------------------------------------------------------------------

/**
 * Estimate the outcome of attacking a tile.
 * @param {number} x
 * @param {number} y
 * @param {Object<string,number>} [units] force to test (default: the whole home army)
 * @param {{officer?:string}} [opts] optional leading officer, used for the estimate
 * @returns {{ok:boolean, reason?:string, tile?:object, type?:string, enemyPower?:number,
 *            ownPower?:number, winChance?:number, travelSec?:number, capacity?:number}}
 */
export function scoutTile(x, y, units, opts) {
  const tile = tileAt(x, y);
  if (!tile) return { ok: false, reason: 'Off the map.' };
  const force = units && totalUnits(units) > 0 ? normalizeUnitMap(units) : homeArmy();
  const home = cityPos();
  const dist = distance(home.x, home.y, tile.x, tile.y);
  const base = {
    ok: true,
    tile,
    type: tile.type,
    ownPower: npcPower(force),
    capacity: getLoadCapacity(force),
    travelSec: marchTravelSeconds(dist, totalUnits(force) ? force : { inf1: 1 }, false),
    dist: Math.round(dist * 10) / 10
  };
  if (tile.type !== 'npc') {
    base.enemyPower = 0;
    base.winChance = 1;
    if (tile.type === 'res') {
      base.gatherSec = Math.min(GATHER.maxSec, Math.ceil(Math.min(tile.res.amount, base.capacity) / getGatherRate(force)));
    }
    return base;
  }
  base.enemyPower = tile.npc.power || npcPower(tile.npc.units);
  base.winChance = estimateWinChance(force, tile.npc.units, opts && opts.officer);
  return base;
}

function homeArmy() {
  const out = {};
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    const n = Math.max(0, Math.floor(S.army[k].count) || 0);
    if (n > 0 && UNITS[k]) out[k] = n;
  }
  return out;
}

function estimateWinChance(atk, def, officer) {
  if (totalUnits(atk) <= 0) return 0;
  if (totalUnits(def) <= 0) return 1;
  if (typeof combat.simulateBattle === 'function') {
    try {
      const raw = combat.simulateBattle(
        playerForce(atk, officer || null, 'Expedition'),
        { units: shallowCopy(def), officer: null, name: 'Enemy Camp', isDefender: true },
        { samples: 16, kind: 'scout' }
      );
      if (typeof raw === 'number' && Number.isFinite(raw)) return clamp(raw > 1 ? raw / 100 : raw, 0, 1);
      if (raw && typeof raw === 'object') {
        const v = [raw.winChance, raw.chance, raw.pWin, raw.winRate].find((n) => typeof n === 'number' && Number.isFinite(n));
        if (typeof v === 'number') return clamp(v > 1 ? v / 100 : v, 0, 1);
        if (typeof raw.win === 'boolean') return raw.win ? 0.85 : 0.15;
      }
    } catch (err) {
      console.warn('[worldmap] combat.simulateBattle failed, estimating locally', err);
    }
  }
  // Local estimate: effective-power ratio through a logistic curve.
  const a = effectivePower(atk, def);
  const d = effectivePower(def, atk);
  const ratio = a / Math.max(1, d);
  return clamp(1 / (1 + Math.exp(-3.2 * (ratio - 1))), 0.01, 0.99);
}

/** Power of `atk` weighted by how well it counters `def`. */
function effectivePower(atk, def) {
  let total = 0;
  const defWeights = {};
  let defTotal = 0;
  for (const k in def) {
    if (!Object.prototype.hasOwnProperty.call(def, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const w = u.hp * (Math.floor(def[k]) || 0);
    defWeights[u.cls] = (defWeights[u.cls] || 0) + w;
    defTotal += w;
  }
  for (const k in atk) {
    if (!Object.prototype.hasOwnProperty.call(atk, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    let c = 1;
    if (defTotal > 0) {
      c = 0;
      for (const cls in defWeights) c += counter(u.cls, cls) * (defWeights[cls] / defTotal);
    }
    const atkBonus = 1 + Math.max(-0.9, getBonus('atk.' + u.cls));
    total += u.power * (Math.floor(atk[k]) || 0) * c * atkBonus;
  }
  return total;
}


// ---------------------------------------------------------------------------
// Retaliation raids — the one battle where the PLAYER is the defender.
//
// A world-map camp that repels one of your assaults musters part of its
// garrison and marches on your city. On arrival the raid fights your standing
// home army behind the Perimeter Wall (wall HP + wall defence) and, if it wins,
// carries off a share of everything the Warehouse does not protect.
// ---------------------------------------------------------------------------

/** Live incoming raids (always an array). */
export function incomingRaids() {
  if (!S.map || typeof S.map !== 'object') return [];
  if (!Array.isArray(S.map.raids)) S.map.raids = [];
  return S.map.raids;
}

/** Nominal power of a raid column. */
export function raidPower(raid) {
  return raid ? npcPower(raid.units) : 0;
}

/** Current Perimeter Wall level (0 when none is built). */
function wallLevel() {
  const w = findBuilding('wall');
  return w ? Math.max(0, Math.floor(Number(w.level) || 0)) : 0;
}

/**
 * Nominal power of everything the player owns — troops at home AND troops out
 * on marches (they will be back to defend the city sooner or later).
 * @returns {number}
 */
function playerArmyPower() {
  let p = 0;
  for (const k in S.army) {
    if (!Object.prototype.hasOwnProperty.call(S.army, k)) continue;
    const u = UNITS[k];
    if (!u) continue;
    const rec = S.army[k];
    p += u.power * Math.max(0, Math.floor(Number(rec.count) || 0));
    p += u.power * Math.max(0, Math.floor(Number(rec.wounded) || 0)) * 0.35;
  }
  const list = activeMarches();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.units) continue;
    for (const k in m.units) {
      if (!Object.prototype.hasOwnProperty.call(m.units, k)) continue;
      const u = UNITS[k];
      if (u) p += u.power * Math.max(0, Math.floor(Number(m.units[k]) || 0));
    }
  }
  return p;
}

/** The officer assigned to base garrison duty, or null. */
function garrisonOfficer() {
  const owned = (S.officers && S.officers.owned) || {};
  for (const k in owned) {
    if (!Object.prototype.hasOwnProperty.call(owned, k)) continue;
    if (owned[k] && owned[k].assigned === 'garrison') return k;
  }
  return null;
}

/**
 * Muster a retaliation column from the camp that just won.
 * @param {object} tile the npc tile (already updated with its survivors)
 * @param {number} at wall-clock ms of the failed assault
 * @returns {object|null} the raid, or null when the camp does not retaliate
 */
function scheduleRaid(tile, at) {
  if (!tile || tile.type !== 'npc' || !tile.npc) return null;
  const level = Math.max(1, Math.floor(Number(tile.npc.level) || 1));
  if (level < RAID.minCampLevel) return null;
  const raids = incomingRaids();
  if (raids.length >= RAID.maxInbound) return null;
  for (let i = 0; i < raids.length; i++) {
    // one camp only ever has one column on the road
    if (raids[i] && raids[i].from && raids[i].from.x === tile.x && raids[i].from.y === tile.y) return null;
  }

  const units = {};
  let count = 0;
  const src = tile.npc.units || {};
  for (const k in src) {
    if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
    if (!UNITS[k]) continue;
    const have = Math.max(0, Math.floor(Number(src[k]) || 0));
    const take = Math.floor(have * RAID.forceShare);
    if (take > 0) { units[k] = take; count += take; }
  }
  if (count <= 0) return null;

  // Cap the column against the player's whole army so a single lost assault
  // cannot snowball into losing everything at home.
  const cap = playerArmyPower() * RAID.powerCap;
  const raw = npcPower(units);
  if (cap <= 0) return null;
  if (raw > cap) {
    const f = cap / raw;
    count = 0;
    for (const k in units) {
      if (!Object.prototype.hasOwnProperty.call(units, k)) continue;
      const n = Math.floor(units[k] * f);
      if (n > 0) { units[k] = n; count += n; } else { delete units[k]; }
    }
    if (count <= 0) return null;
  }

  // The raiders leave the camp, so beating them is also a way to thin it out.
  for (const k in units) {
    tile.npc.units[k] = Math.max(0, (Math.floor(tile.npc.units[k]) || 0) - units[k]);
    if (tile.npc.units[k] <= 0) delete tile.npc.units[k];
  }
  if (totalUnits(tile.npc.units) <= 0) clearTile(tile.x, tile.y);
  else tile.npc.power = npcPower(tile.npc.units);

  const home = cityPos();
  const dist = distance(tile.x, tile.y, home.x, home.y);
  const travel = marchTravelSeconds(dist, units, false) + RAID.musterSec;
  const raid = {
    id: 'r_' + at.toString(36) + '_' + Math.floor(Math.random() * 1e6).toString(36),
    from: { x: tile.x, y: tile.y },
    to: { x: home.x, y: home.y },
    level,
    units,
    startAt: at,
    arriveAt: at + travel * 1000
  };
  raids.push(raid);
  markDirty();
  addLog('battle', 'Enemy column spotted leaving (' + tile.x + ',' + tile.y + ') — ' +
    formatNum(count) + ' raiders will hit your city in ' + Math.round(travel / 60) + ' min.',
  { raidId: raid.id });
  emit('toast', { type: 'warn', kind: 'warn', text: 'Raid inbound: ' + formatNum(count) + ' enemy troops.' });
  emit('state:changed', { reason: 'raid:inbound' });
  return raid;
}

/**
 * Resolve every raid whose arrival time has passed.
 * @param {number} [now]
 * @returns {number} raids resolved
 */
export function tickRaids(now) {
  const t = typeof now === 'number' ? now : Date.now();
  const raids = incomingRaids();
  let done = 0;
  for (let i = raids.length - 1; i >= 0; i--) {
    const r = raids[i];
    if (!r || typeof r !== 'object' || totalUnits(r.units) <= 0) { raids.splice(i, 1); continue; }
    const due = Number(r.arriveAt);
    if (!Number.isFinite(due) || due > t) continue;
    raids.splice(i, 1);
    resolveRaid(r, due);
    done += 1;
  }
  if (done > 0) {
    markDirty();
    emit('state:changed', { reason: 'raid:resolved' });
  }
  return done;
}

/** Fight one raid at the city gates and apply everything it changes. */
function resolveRaid(raid, at) {
  const defenders = homeArmy();
  const wall = wallLevel();
  const bonuses = (typeof bonusMod.getAllBonuses === 'function') ? bonusMod.getAllBonuses() : {};
  const officer = garrisonOfficer();
  const owned = (S.officers && S.officers.owned) || {};

  const attacker = combat.makeForce(raid.units, {
    name: 'Lv' + raid.level + ' Raiders',
    isDefender: false
  });
  const defender = combat.makeForce(defenders, {
    name: (S.player.name || 'Your city'),
    officer,
    officerStars: officer && owned[officer] ? owned[officer].stars : 1,
    bonuses,
    isDefender: true,
    wallLevel: wall,
    atHome: true
  });

  const report = combat.resolveBattle(attacker, defender, {
    kind: 'raid',
    label: 'Raid on ' + (S.player.name || 'your city'),
    seed: raid.id
  });
  combat.applyBattleResult(report, 'defender', {
    removeFromArmy: true,
    hospital: true,
    log: false,
    emit: false
  });

  const lost = { oil: 0, steel: 0, rare: 0, food: 0 };
  const held = report.winner === 'defender';
  if (!held) {
    const safe = protectedAmount();
    for (let i = 0; i < RES_ORDER.length; i++) {
      const k = RES_ORDER[i];
      const exposed = Math.max(0, Math.floor(S.res[k]) - safe);
      const taken = Math.floor(exposed * RAID.lootShare);
      if (taken > 0) { S.res[k] -= taken; lost[k] = taken; }
    }
    const sum = RES_ORDER.reduce((n, k) => n + lost[k], 0);
    addLog('battle', 'The raid broke through' +
      (wall > 0 ? ' the Lv' + wall + ' wall' : ' — you have no wall') + '. ' +
      (sum > 0 ? formatNum(sum) + ' resources looted.' : 'Nothing was left to loot.'),
    { raidId: raid.id });
    emit('toast', { type: 'error', kind: 'danger', text: 'Your city was raided!' });
    emit('res:changed', S.res);
  } else {
    const gold = Math.max(1, RAID.goldPerLevel * raid.level);
    S.res.gold = (Number(S.res.gold) || 0) + gold;
    addLog('battle', 'The raid was thrown back' +
      (wall > 0 ? ' at the Lv' + wall + ' wall' : ' in the streets') + '. Salvage: ' +
      gold + ' gold.', { raidId: raid.id });
    emit('toast', { type: 'ok', kind: 'ok', text: 'Raid repelled — +' + gold + ' gold.' });
    emit('res:changed', S.res);
  }

  emit('battle:result', {
    source: 'raid',
    side: 'defender',
    raidId: raid.id,
    tile: { x: raid.from.x, y: raid.from.y, level: raid.level },
    win: held,
    looted: lost,
    report
  });
  return report;
}
