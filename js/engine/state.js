// js/engine/state.js — canonical live game state + persistence.
// LEAF MODULE: imports only from ../util/*. Never import js/data or other js/engine here (cycle risk).
// Exports: S, SAVE_KEY, SAVE_VERSION, BACKUP_KEY, PLOT_SLOTS, RES_KEYS, versionOf,
//          newGame, save, saveNow, load, hardReset, applySnapshot, migrate, snapshot,
//          findBuilding, buildingsOf, getBuilding, addBuilding, ensureUnit, addLog, touch, markDirty

import { uid, clamp } from '../util/fmt.js';
import { emit } from '../util/events.js';

export const SAVE_KEY = 'warpath_save_v1';
export const SAVE_VERSION = 1;

/**
 * Where a save written by a NEWER build is copied before this build touches it.
 * On a static host the HTML and the JS modules are cached independently, so a
 * player can very easily end up running an old bundle against a new save.
 */
export const BACKUP_KEY = SAVE_KEY + '.bak';

/** Resource keys in canonical display order. `gold` is premium and is NOT capped. */
export const RES_KEYS = ['oil', 'steel', 'rare', 'food'];

/**
 * Buildable plot grid: 8 x 8 slots. Coordinates are grid indices (0..7),
 * ui/base.js projects them into isometric screen space.
 * @type {{x:number,y:number,i:number}[]}
 */
export const PLOT_SLOTS = (() => {
  const out = [];
  let i = 0;
  for (let y = 0; y < 8; y++) {
    for (let x = 0; x < 8; x++) {
      out.push({ x, y, i: i++ });
    }
  }
  return out;
})();

/** Center-ish plot used for the HQ. */
const HQ_PLOT = { x: 3, y: 3 };

const START_RES = { oil: 5000, steel: 5000, rare: 5000, food: 5000, gold: 500 };
const START_CAP = { oil: 20000, steel: 20000, rare: 20000, food: 20000 };

/**
 * The live, mutable state object. Every module imports THIS reference and
 * mutates it in place; it is never reassigned (applySnapshot rewrites keys).
 */
export const S = blank();

function blank() {
  return {
    v: SAVE_VERSION,
    t: 0,
    created: 0,
    player: { name: 'Commander', hqLevel: 1, power: 0, xp: 0, vip: 0 },
    res: { oil: 0, steel: 0, rare: 0, food: 0, gold: 0 },
    cap: { oil: 0, steel: 0, rare: 0, food: 0 },
    buildings: [],
    queues: { build: [], research: [], train: [] },
    tech: {},
    army: {},
    officers: { owned: {}, fragments: {}, pity: 0, draws: 0 },
    map: { seed: 1, tiles: [], marches: [], raids: [], explored: {} },
    // cooldowns[stageId] = wall-clock ms before that stage may be run again
    campaign: { stage: 1, cleared: [], cooldowns: {}, repeats: {} },
    log: [],
    settings: { sfx: true, speed: 1 },
    stats: { battlesWon: 0, battlesLost: 0, unitsLost: 0, unitsKilled: 0 }
  };
}

/**
 * Reset S in place to a fresh game.
 * @param {{name?:string, seed?:number}} [opts]
 * @returns {typeof S}
 */
export function newGame(opts) {
  const o = opts || {};
  const fresh = blank();
  const now = Date.now();
  fresh.t = now;
  fresh.created = now;
  if (o.name) fresh.player.name = String(o.name).slice(0, 24);
  fresh.res = Object.assign({}, START_RES);
  fresh.cap = Object.assign({}, START_CAP);
  fresh.map.seed = (typeof o.seed === 'number' && Number.isFinite(o.seed))
    ? (Math.floor(Math.abs(o.seed)) >>> 0) || 1
    : ((now ^ Math.floor(Math.random() * 0x7fffffff)) >>> 0) || 1;
  fresh.buildings.push(makeBuilding('hq', 1, HQ_PLOT.x, HQ_PLOT.y));
  fresh.log.push({
    t: now,
    type: 'system',
    text: 'Command established. HQ online.',
    data: null
  });
  writeInto(S, fresh);
  markDirty();
  emit('state:changed', { reason: 'newGame' });
  emit('res:changed', S.res);
  return S;
}

/**
 * Build a building record.
 * @param {string} key building key from js/data/buildings.js
 * @param {number} level
 * @param {number} x plot x
 * @param {number} y plot y
 * @returns {{id:string,key:string,level:number,x:number,y:number,state:string,doneAt:number,startedAt:number}}
 */
export function makeBuilding(key, level, x, y) {
  return {
    id: uid('b'),
    key: String(key),
    level: Math.max(0, Math.floor(level) || 0),
    x: Math.floor(x) || 0,
    y: Math.floor(y) || 0,
    state: 'idle',
    doneAt: 0,
    startedAt: 0
  };
}

/**
 * Append a building to S.buildings and return it.
 * @param {string} key
 * @param {number} level
 * @param {number} x
 * @param {number} y
 */
export function addBuilding(key, level, x, y) {
  const b = makeBuilding(key, level, x, y);
  S.buildings.push(b);
  markDirty();
  return b;
}

/** First building with the given key, or null. */
export function findBuilding(key) {
  for (let i = 0; i < S.buildings.length; i++) {
    if (S.buildings[i].key === key) return S.buildings[i];
  }
  return null;
}

/** All buildings with the given key. */
export function buildingsOf(key) {
  return S.buildings.filter((b) => b.key === key);
}

/** Building by id, or null. */
export function getBuilding(id) {
  for (let i = 0; i < S.buildings.length; i++) {
    if (S.buildings[i].id === id) return S.buildings[i];
  }
  return null;
}

/** Level of the first building with `key`, or 0 if not built. */
export function levelOf(key) {
  const b = findBuilding(key);
  return b ? b.level : 0;
}

/** Ensure S.army[key] exists; returns the entry. */
export function ensureUnit(key) {
  if (!S.army[key]) S.army[key] = { count: 0, wounded: 0 };
  return S.army[key];
}

/**
 * Push an entry onto the activity log (capped at 200) and emit 'log'.
 * @param {string} type
 * @param {string} text
 * @param {any} [data]
 */
export function addLog(type, text, data) {
  const entry = { t: Date.now(), type: String(type), text: String(text), data: data === undefined ? null : data };
  S.log.unshift(entry);
  if (S.log.length > 200) S.log.length = 200;
  markDirty();
  emit('log', entry);
  return entry;
}

/** Stamp the last-tick wall clock. */
export function touch(ms) {
  S.t = typeof ms === 'number' ? ms : Date.now();
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

let dirty = false;
let saveTimer = 0;
let lastSaveAt = 0;
/** True once a write has thrown; cleared by the next successful write. */
let saveFailed = false;
/** No save is attempted before this wall clock (back-off after a failure). */
let saveRetryAt = 0;
const SAVE_THROTTLE_MS = 2500;

/** Flag the state as needing a save; the throttled save() picks it up. */
export function markDirty() {
  dirty = true;
}

/** Deep-ish clone of S suitable for JSON. */
export function snapshot() {
  return JSON.parse(JSON.stringify(S));
}

function storage() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return localStorage;
  } catch (err) {
    return null;
  }
}

/**
 * Throttled save. Safe to call on every tick / every mutation.
 * Writes at most once per SAVE_THROTTLE_MS.
 * @param {boolean} [force] write immediately
 * @returns {boolean} true if a write happened synchronously
 */
export function save(force) {
  markDirty();
  const now = Date.now();
  if (force || (now >= saveRetryAt && now - lastSaveAt >= SAVE_THROTTLE_MS)) {
    return saveNow();
  }
  if (!saveTimer) {
    // The deferred write has to respect the failure back-off too, or it would
    // just re-throw on the ordinary 2.5s throttle instead of every 30s.
    const delay = Math.max(50, SAVE_THROTTLE_MS - (now - lastSaveAt), saveRetryAt - now);
    saveTimer = setTimeout(() => {
      saveTimer = 0;
      if (dirty) saveNow();
    }, delay);
  }
  return false;
}

/** Immediate, unthrottled write to localStorage. */
export function saveNow() {
  const store = storage();
  if (!store) return false;
  try {
    S.v = SAVE_VERSION;
    store.setItem(SAVE_KEY, JSON.stringify(S));
    lastSaveAt = Date.now();
    dirty = false;
    saveFailed = false;
    saveRetryAt = 0;
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = 0;
    }
    return true;
  } catch (err) {
    console.warn('[state] save failed', err);
    // Back off: without this, lastSaveAt stays stale and save() re-stringifies
    // the whole state on every state:changed and every 5s loop flush.
    // `dirty` stays true on purpose, so a recovered store still gets the write.
    lastSaveAt = Date.now();
    saveRetryAt = lastSaveAt + 30000;
    if (!saveFailed) {
      saveFailed = true;
      emit('toast', {
        msg: 'Progress could not be saved — export your campaign from Settings.',
        kind: 'warn',
        ms: 6000
      });
    }
    return false;
  }
}

/**
 * Stash a save we could not read, so a fixed build (or the player) can still
 * get at the original bytes. Without this the next boot writes a fresh campaign
 * straight over them.
 * @param {Storage} store
 * @param {string} raw
 * @param {string} why
 */
function keepRaw(store, raw, why) {
  try {
    store.setItem(BACKUP_KEY, raw);
    console.warn('[state] unreadable save kept in ' + BACKUP_KEY + ' (' + why + ')');
  } catch (err) {
    console.warn('[state] could not back up the unreadable save', err);
  }
}

/**
 * Load the save into S in place.
 * @returns {boolean} true if a valid save was found and applied
 */
export function load() {
  const store = storage();
  if (!store) return false;
  let raw = null;
  try {
    raw = store.getItem(SAVE_KEY);
  } catch (err) {
    return false;
  }
  if (!raw) return false;
  let data = null;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('[state] corrupt save, ignoring', err);
    keepRaw(store, raw, 'parse');
    return false;
  }
  if (!data || typeof data !== 'object' || !data.player || !Array.isArray(data.buildings)) {
    console.warn('[state] save missing required fields, ignoring');
    keepRaw(store, raw, 'shape');
    return false;
  }
  // A save written by a newer build loses every field this build does not know
  // about, and the next saveNow() overwrites the original. Keep the raw text so
  // the newer build can pick it up again.
  if (versionOf(data) > SAVE_VERSION) {
    try {
      store.setItem(BACKUP_KEY, raw);
      console.warn('[state] newer save backed up to ' + BACKUP_KEY);
    } catch (err) {
      console.warn('[state] could not back up the newer save', err);
    }
  }
  applySnapshot(data);
  return true;
}

/**
 * Replace the contents of S with `data` (migrated + normalized) in place.
 * @param {object} data
 * @returns {typeof S}
 */
export function applySnapshot(data) {
  const migrated = migrate(data);
  writeInto(S, migrated);
  dirty = false;
  emit('state:changed', { reason: 'load' });
  emit('res:changed', S.res);
  return S;
}

/** Replace every own key of target with source's (keeps the same object identity). */
function writeInto(target, source) {
  for (const k in target) {
    if (Object.prototype.hasOwnProperty.call(target, k)) delete target[k];
  }
  for (const k in source) {
    if (Object.prototype.hasOwnProperty.call(source, k)) target[k] = source[k];
  }
  return target;
}

/**
 * The schema version a saved object claims. Anything missing or unreadable is
 * treated as the first version (saves predate the field only in that case).
 * @param {object} data
 * @returns {number} >= 1
 */
export function versionOf(data) {
  const v = Math.floor(num(data && data.v, 0));
  return v > 0 ? v : 1;
}

/**
 * Per-version upgrade steps. UPGRADES[n] takes a version-n object and returns a
 * version-(n+1) object; the chain runs in order for every version between the
 * save's and SAVE_VERSION. Empty today because only v1 exists — the point is
 * that a second schema has somewhere to go other than "silently drop the
 * fields the old code does not recognise".
 * @type {Object<number, (src:object)=>object>}
 */
const UPGRADES = {};

/**
 * Normalize/upgrade an arbitrary saved object to the current shape.
 * Always returns a complete, safe state object (never mutates the input).
 *
 * A save from a NEWER build cannot be upgraded (this code does not know its
 * fields); it is normalized on a best-effort basis and everything unrecognised
 * is lost, so load() copies the raw text to BACKUP_KEY before that happens.
 *
 * @param {object} data
 * @returns {object}
 */
export function migrate(data) {
  const base = blank();
  let src = (data && typeof data === 'object') ? data : {};
  const out = base;

  const from = versionOf(src);
  if (from > SAVE_VERSION) {
    console.warn('[state] save is version ' + from + ' but this build only understands '
      + SAVE_VERSION + '; unknown fields will be dropped');
  } else if (from < SAVE_VERSION) {
    // Work on a copy: migrate() must never mutate its input.
    try {
      src = JSON.parse(JSON.stringify(src));
    } catch (err) {
      src = Object.assign({}, src);
    }
    for (let v = from; v < SAVE_VERSION; v++) {
      const step = UPGRADES[v];
      if (typeof step !== 'function') continue;
      const next = step(src);
      if (next && typeof next === 'object') src = next;
    }
  }

  out.v = SAVE_VERSION;
  out.created = num(src.created, Date.now());
  out.t = num(src.t, out.created);

  const p = src.player || {};
  out.player.name = typeof p.name === 'string' && p.name ? p.name.slice(0, 24) : 'Commander';
  out.player.hqLevel = clamp(Math.floor(num(p.hqLevel, 1)), 1, 30);
  out.player.power = Math.max(0, Math.floor(num(p.power, 0)));
  out.player.xp = Math.max(0, Math.floor(num(p.xp, 0)));
  out.player.vip = Math.max(0, Math.floor(num(p.vip, 0)));

  const r = src.res || {};
  out.res.oil = Math.max(0, num(r.oil, START_RES.oil));
  out.res.steel = Math.max(0, num(r.steel, START_RES.steel));
  out.res.rare = Math.max(0, num(r.rare, START_RES.rare));
  out.res.food = Math.max(0, num(r.food, START_RES.food));
  out.res.gold = Math.max(0, num(r.gold, START_RES.gold));

  const c = src.cap || {};
  out.cap.oil = Math.max(0, num(c.oil, START_CAP.oil));
  out.cap.steel = Math.max(0, num(c.steel, START_CAP.steel));
  out.cap.rare = Math.max(0, num(c.rare, START_CAP.rare));
  out.cap.food = Math.max(0, num(c.food, START_CAP.food));

  out.buildings = Array.isArray(src.buildings)
    ? src.buildings.filter((b) => b && typeof b.key === 'string').map((b) => ({
      id: typeof b.id === 'string' && b.id ? b.id : uid('b'),
      key: b.key,
      level: Math.max(0, Math.floor(num(b.level, 1))),
      x: Math.floor(num(b.x, 0)),
      y: Math.floor(num(b.y, 0)),
      state: b.state === 'building' ? 'building' : 'idle',
      doneAt: Math.max(0, num(b.doneAt, 0)),
      startedAt: Math.max(0, num(b.startedAt, 0))
    }))
    : [];
  if (out.buildings.length === 0) {
    out.buildings.push(makeBuilding('hq', out.player.hqLevel, HQ_PLOT.x, HQ_PLOT.y));
  }

  const q = src.queues || {};
  out.queues.build = Array.isArray(q.build) ? q.build.filter(isObj) : [];
  out.queues.research = Array.isArray(q.research) ? q.research.filter(isObj) : [];
  out.queues.train = Array.isArray(q.train) ? q.train.filter(isObj) : [];

  out.tech = plainMapOfNumbers(src.tech);

  out.army = {};
  if (src.army && typeof src.army === 'object') {
    for (const k in src.army) {
      if (!Object.prototype.hasOwnProperty.call(src.army, k)) continue;
      const u = src.army[k];
      if (!u || typeof u !== 'object') continue;
      out.army[k] = {
        count: Math.max(0, Math.floor(num(u.count, 0))),
        wounded: Math.max(0, Math.floor(num(u.wounded, 0)))
      };
    }
  }

  const of = src.officers || {};
  out.officers.owned = {};
  if (of.owned && typeof of.owned === 'object') {
    for (const k in of.owned) {
      if (!Object.prototype.hasOwnProperty.call(of.owned, k)) continue;
      const o = of.owned[k];
      if (!o || typeof o !== 'object') continue;
      out.officers.owned[k] = {
        level: Math.max(1, Math.floor(num(o.level, 1))),
        stars: Math.max(1, Math.floor(num(o.stars, 1))),
        xp: Math.max(0, Math.floor(num(o.xp, 0))),
        assigned: typeof o.assigned === 'string' ? o.assigned : null
      };
    }
  }
  out.officers.fragments = plainMapOfNumbers(of.fragments);
  out.officers.pity = Math.max(0, Math.floor(num(of.pity, 0)));
  out.officers.draws = Math.max(0, Math.floor(num(of.draws, 0)));

  const m = src.map || {};
  out.map.seed = (Math.floor(Math.abs(num(m.seed, 1))) >>> 0) || 1;
  out.map.tiles = Array.isArray(m.tiles) ? m.tiles : [];
  out.map.marches = Array.isArray(m.marches) ? m.marches.filter(isObj) : [];
  out.map.raids = Array.isArray(m.raids) ? m.raids.filter(isObj) : [];
  out.map.explored = (m.explored && typeof m.explored === 'object' && !Array.isArray(m.explored)) ? m.explored : {};

  const cp = src.campaign || {};
  out.campaign.stage = Math.max(1, Math.floor(num(cp.stage, 1)));
  out.campaign.cleared = Array.isArray(cp.cleared) ? cp.cleared.slice(0, 200) : [];
  out.campaign.cooldowns = plainMapOfNumbers(cp.cooldowns);
  out.campaign.repeats = plainMapOfNumbers(cp.repeats);

  out.log = Array.isArray(src.log)
    ? src.log.filter(isObj).slice(0, 200).map((e) => ({
      t: num(e.t, 0),
      type: typeof e.type === 'string' ? e.type : 'info',
      text: typeof e.text === 'string' ? e.text : '',
      data: e.data === undefined ? null : e.data
    }))
    : [];

  const st = src.settings || {};
  out.settings.sfx = st.sfx !== false;
  out.settings.speed = clamp(num(st.speed, 1), 1, 4);

  const sx = src.stats || {};
  out.stats.battlesWon = Math.max(0, Math.floor(num(sx.battlesWon, 0)));
  out.stats.battlesLost = Math.max(0, Math.floor(num(sx.battlesLost, 0)));
  out.stats.unitsLost = Math.max(0, Math.floor(num(sx.unitsLost, 0)));
  out.stats.unitsKilled = Math.max(0, Math.floor(num(sx.unitsKilled, 0)));

  // keep hqLevel in sync with the actual HQ building
  const hq = out.buildings.find((b) => b.key === 'hq');
  if (hq) out.player.hqLevel = clamp(hq.level, 1, 30);

  return out;
}

function num(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function isObj(v) {
  return !!v && typeof v === 'object';
}

function plainMapOfNumbers(src) {
  const out = {};
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const k in src) {
      if (!Object.prototype.hasOwnProperty.call(src, k)) continue;
      const n = Number(src[k]);
      if (Number.isFinite(n) && n > 0) out[k] = Math.floor(n);
    }
  }
  return out;
}

/**
 * Wipe the save and start a brand new game in place.
 * @returns {typeof S}
 */
export function hardReset() {
  const store = storage();
  if (store) {
    try {
      store.removeItem(SAVE_KEY);
      store.removeItem(BACKUP_KEY);
    } catch (err) {
      console.warn('[state] could not clear save', err);
    }
  }
  newGame();
  saveNow();
  return S;
}
