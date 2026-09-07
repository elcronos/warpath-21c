// js/ui/base.js — BASE screen: pseudo-isometric plot grid, build/upgrade sheet,
// build picker, live construction timers and production tickers.
// Exports: render, openBuildingSheet, openBuildPicker, closeSheet, focusPlot, BASE_VIEW
// Registers itself with the router via registerScreen('base', render).

import { h, svg, clear } from '../util/dom.js';
import { formatNum, formatTime, formatClock, clamp, pct } from '../util/fmt.js';
import { on, emit } from '../util/events.js';
import {
  S, PLOT_SLOTS, RES_KEYS, addBuilding, addLog, save, markDirty
} from '../engine/state.js';
import { registerScreen } from './registry.js';
import { icon, toast, resColor } from './shell.js';
import {
  BUILDINGS, BUILDING_KEYS, getCost, getBuildTime, getPlaceCost, maxCopies, countBuilt,
  getProduction, getCapacity, getEffect, missingRequirements, MAX_LEVEL
} from '../data/buildings.js';
import { QUEUE, SPEEDUP } from '../data/balance.js';

// ---------------------------------------------------------------------------
// Sibling modules. These are static namespace imports: ui/svg.js, engine/build.js
// and engine/bonus.js are all leaf-ward of this screen (none of them import any
// ui/* module), so there is no cycle and no load race — the artwork and the real
// construction queue are available on the very first render.
//
// The local fallbacks further down are kept as a safety net only; with the real
// engine bound they never fire.
// ---------------------------------------------------------------------------

import * as ART from './svg.js';       // building artwork
import * as BUILDX from '../engine/build.js'; // construction queue
import * as BONUSX from '../engine/bonus.js'; // getBonus(key)

/** First function found on a module among candidate export names. */
function pickFn(mod, names) {
  if (!mod) return null;
  for (let i = 0; i < names.length; i++) {
    if (typeof mod[names[i]] === 'function') return mod[names[i]];
  }
  return null;
}

/** Central bonus lookup; 0 when engine/bonus.js is not loaded. */
function bonus(key) {
  const fn = pickFn(BONUSX, ['getBonus', 'bonus']);
  if (!fn) return 0;
  try {
    const v = Number(fn(key));
    return Number.isFinite(v) ? v : 0;
  } catch (err) {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

const TILE_W = 128;
const TILE_H = 64;
const VB = { x: -540, y: -150, w: 1080, h: 690 };
const RING_R = 22;
const RING_C = 2 * Math.PI * RING_R;

/** Pan/zoom, kept module-level so re-renders never lose the camera. */
export const BASE_VIEW = { scale: 1.5, tx: 0, ty: -88, ready: false };

function worldPos(x, y) {
  return { sx: (x - y) * (TILE_W / 2), sy: (x + y) * (TILE_H / 2) };
}

// ---------------------------------------------------------------------------
// Styles (this module owns no CSS file, so it injects its own once)
// ---------------------------------------------------------------------------

const CSS = `
.base { display:flex; flex-direction:column; gap:var(--sp-3); }
.base-map {
  position:relative; height:clamp(260px,46vh,520px);
  border:1px solid var(--line); border-radius:var(--r-lg); overflow:hidden;
  background:radial-gradient(120% 90% at 50% 8%, #1a2433 0%, #101722 55%, #0a0e15 100%);
  box-shadow:var(--shadow-1);
}
.base-map__svg { display:block; width:100%; height:100%; touch-action:none; user-select:none; -webkit-user-select:none; }
.base-map__hint {
  position:absolute; left:8px; bottom:8px; font-size:10px; letter-spacing:.08em;
  text-transform:uppercase; color:var(--muted); background:rgba(0,0,0,.4);
  padding:3px 7px; border-radius:var(--r-pill); pointer-events:none;
}
.base-map__zoom { position:absolute; right:8px; bottom:8px; display:flex; flex-direction:column; gap:6px; }
.base-map__zoom .btn { min-height:44px; min-width:44px; height:44px; width:44px; padding:0; font-size:19px; line-height:1; opacity:.92; }
.plot { cursor:pointer; }
.plot__tile { fill:rgba(90,120,155,.10); stroke:rgba(150,180,215,.28); stroke-width:1.5; }
.plot--empty .plot__tile { fill:rgba(80,110,145,.06); stroke:rgba(140,170,205,.35); stroke-dasharray:8 7; }
.plot--sel .plot__tile { fill:var(--accent-soft); stroke:var(--accent); stroke-width:2.5; }
.plot__badge { fill:#0b0f16; stroke:var(--accent); stroke-width:2; }
.plot__badgetxt { fill:var(--accent); font:700 15px var(--font-mono,monospace); text-anchor:middle; }
.plot__label { fill:var(--text-dim); font:600 13px var(--font,sans-serif); text-anchor:middle;
  stroke:#05080d; stroke-width:3; paint-order:stroke; }
.plot__time { fill:var(--accent); font:700 14px var(--font-mono,monospace); text-anchor:middle;
  stroke:#05080d; stroke-width:3.5; paint-order:stroke; }
.ring__bg { fill:none; stroke:rgba(0,0,0,.55); stroke-width:5; }
.ring__fg { fill:none; stroke:var(--accent); stroke-width:5; stroke-linecap:round;
  transform:rotate(-90deg); transform-origin:center; transform-box:fill-box; }
.floaty { font:700 17px var(--font-mono,monospace); text-anchor:middle;
  stroke:#05080d; stroke-width:3.5; paint-order:stroke; animation:floatUp 1.6s ease-out forwards; }
@keyframes floatUp { 0%{opacity:0;transform:translateY(0)} 12%{opacity:1} 100%{opacity:0;transform:translateY(-46px)} }
.bsheet { position:fixed; inset:0; z-index:60; display:flex; flex-direction:column; justify-content:flex-end; }
.bsheet__bd { position:absolute; inset:0; background:rgba(3,6,10,.6); }
.bsheet__box {
  position:relative; width:100%; max-width:var(--maxw); margin:0 auto;
  background:linear-gradient(180deg,var(--panel-2) 0%, var(--panel) 100%);
  border-top:1px solid var(--line); border-radius:var(--r-lg) var(--r-lg) 0 0;
  box-shadow:var(--shadow-3); max-height:86vh; overflow:auto;
  padding:var(--sp-3) var(--sp-3) calc(var(--sp-4) + var(--safe-b));
  transform:translateY(14px); opacity:0; transition:transform .18s ease, opacity .18s ease;
}
.bsheet.is-in .bsheet__box { transform:translateY(0); opacity:1; }
.bsheet__grab { width:42px; height:4px; border-radius:2px; background:var(--line); margin:0 auto var(--sp-3); }
.bsheet__head { display:flex; align-items:center; gap:var(--sp-3); margin-bottom:var(--sp-3); }
.bsheet__art { width:58px; height:58px; flex:none; border-radius:var(--r-md);
  background:rgba(0,0,0,.28); border:1px solid var(--line-soft); }
.bsheet__x { margin-left:auto; flex:none; width:44px; height:44px; display:inline-flex;
  align-items:center; justify-content:center; background:transparent; border:0; padding:0;
  border-radius:var(--r-sm); color:var(--muted); cursor:pointer; }
.bsheet__x:active { background:rgba(255,255,255,.06); }
.statrow { display:flex; align-items:center; gap:var(--sp-2); padding:7px 0; border-bottom:1px solid var(--line-soft); font-size:12.5px; }
.statrow:last-child { border-bottom:0; }
.statrow__l { color:var(--muted); flex:1 1 auto; min-width:0; }
.statrow__v { font-variant-numeric:tabular-nums; font-weight:700; }
.statrow__n { color:var(--ok); font-variant-numeric:tabular-nums; font-weight:700; }
.picker { display:flex; flex-direction:column; gap:var(--sp-2); }
.pick { display:flex; align-items:center; gap:var(--sp-3); padding:9px 10px; text-align:left;
  background:var(--panel-2); border:1px solid var(--line); border-radius:var(--r-md); cursor:pointer; }
.pick:active { border-color:var(--accent-dark); }
.pick.is-locked { opacity:.55; }
.pick__art { width:44px; height:44px; flex:none; }
.pick__b { flex:1 1 auto; min-width:0; }
.pick__n { font-size:13.5px; font-weight:700; }
`;

function injectCSS() {
  if (document.getElementById('base-css')) return;
  const st = document.createElement('style');
  st.id = 'base-css';
  st.textContent = CSS;
  document.head.appendChild(st);
}

// ---------------------------------------------------------------------------
// Building artwork
// ---------------------------------------------------------------------------

const CAT_COLOR = {
  core: '#f0a500', economy: '#4fd1c5', military: '#e07a5f', support: '#6aa9f0'
};

/** Compact 24x24 emblem glyphs used by the built-in fallback art. */
const EMBLEM = {
  hq: 'M3 21V9l9-6 9 6v12h-7v-5h-4v5H3Z',
  oil_well: 'M11 2h2v7l7 4v9h-2v-8l-5-3v10h-2V11l-5 3v8H4v-9l7-4V2Z',
  steel_mill: 'M3 21V10l5 3V10l5 3V6l3-4h2l1 19H3Z',
  rare_mine: 'M12 2 4 9l8 13 8-13-8-7Z',
  farm: 'M3 21v-8l5-4 5 4v8H3Zm12 0V6h5v15h-5Z',
  warehouse: 'M3 21V9l9-5 9 5v12H3Zm3-3h12v-6H6v6Z',
  trade_center: 'M4 20V8h6V4h10v16H4Zm3-3h3v-3H7v3Zm6 0h4v-3h-4v3Zm0-6h4V8h-4v3Z',
  barracks: 'M2 20v-7a10 10 0 0 1 20 0v7H2Zm4-3h4v-6H6v6Zm8 0h4v-6h-4v6Z',
  tank_factory: 'M2 19v-5h3l2-4h10l2 4h3v5H2Zm3-9V6h6v4H5Z',
  hangar: 'M2 21V13A10 10 0 0 1 22 13v8H2Zm5-2h10v-6a5 5 0 0 0-10 0v6Z',
  artillery_range: 'M3 20v-4h3l11-9 2 3-9 7v3H3Zm14-14 4 3-2 2-4-3 2-2Z',
  wall: 'M2 21V9h4V5h4v4h4V5h4v4h4v12H2Z',
  lab: 'M9 2h6v2h-1v5l5 9a2 2 0 0 1-2 3H7a2 2 0 0 1-2-3l5-9V4H9V2Z',
  hospital: 'M4 4h16v16H4V4Zm7 3v3H8v4h3v3h4v-3h3v-4h-3V7h-4Z',
  academy: 'M12 3 2 8l10 5 10-5-10-5Zm-6 8v4c0 2 3 4 6 4s6-2 6-4v-4l-6 3-6-3Z',
  radar: 'M12 3a9 9 0 1 0 9 9h-9V3Zm-2 .3A9 9 0 0 0 3.3 10H10V3.3Z'
};

function svgTextNode(str) {
  const g = svg('g');
  try {
    g.innerHTML = String(str);
  } catch (err) {
    return null;
  }
  return g.childNodes.length ? g : null;
}

/**
 * Ask ui/svg.js for the artwork of a building, falling back to the local
 * silhouettes. The returned node is positioned/sized by the caller.
 * @param {string} key
 * @param {number} level
 * @param {number} size square edge in viewBox units
 * @param {number} px left edge
 * @param {number} py top edge
 * @returns {SVGElement}
 */
function buildingArt(key, level, size, px, py) {
  const fn = pickFn(ART, ['buildingArt', 'buildingSvg', 'buildingIcon', 'artFor', 'building']);
  if (fn) {
    // NB: `level` is deliberately NOT forwarded to ui/svg.js. getArt() stamps its
    // own level badge into the 100x100 art box when given one, and this screen
    // already draws a badge (.plot__badge) positioned in plot space — passing it
    // through renders two overlapping "Lv" pips on every building.
    const attempts = [[key, { size }], [key, undefined, size], [key]];
    for (let i = 0; i < attempts.length; i++) {
      let out = null;
      try {
        out = fn.apply(null, attempts[i]);
      } catch (err) {
        out = null;
      }
      const node = (out && out.nodeType === 1) ? out : (typeof out === 'string' ? svgTextNode(out) : null);
      if (!node) continue;
      if (node.tagName && String(node.tagName).toLowerCase() === 'svg') {
        node.setAttribute('x', px);
        node.setAttribute('y', py);
        node.setAttribute('width', size);
        node.setAttribute('height', size);
        return node;
      }
      return svg('svg', {
        x: px, y: py, width: size, height: size,
        viewBox: '0 0 100 100', overflow: 'visible'
      }, node);
    }
  }
  return fallbackArt(key, level, size, px, py);
}

/** Local, always-available building silhouette drawn in a 0..100 box. */
function fallbackArt(key, level, size, px, py) {
  const def = BUILDINGS[key];
  const color = CAT_COLOR[(def && def.category) || 'support'] || '#8fa3b8';
  const tier = Math.min(3, Math.floor((Math.max(1, level) - 1) / 10)); // 0..2 visual tiers
  const roofH = 16 + tier * 3;
  const parts = [
    svg('ellipse', { cx: 50, cy: 92, rx: 40, ry: 9, fill: 'rgba(0,0,0,.45)' }),
    svg('path', { d: 'M12 88 L12 44 L50 26 L88 44 L88 88 Z', fill: '#1b2432', stroke: '#0a0e14', 'stroke-width': 2 }),
    svg('path', { d: 'M12 44 L50 26 L88 44 L50 ' + (44 + roofH) + ' Z', fill: color, opacity: '.85' }),
    svg('path', { d: 'M50 ' + (44 + roofH) + ' L88 44 L88 88 L50 100 Z', fill: '#111823', opacity: '.55' }),
    svg('rect', { x: 22, y: 60, width: 14, height: 12, rx: 2, fill: 'rgba(255,220,150,.35)' }),
    svg('rect', { x: 64, y: 60, width: 14, height: 12, rx: 2, fill: 'rgba(255,220,150,.22)' })
  ];
  const glyph = EMBLEM[key];
  if (glyph) {
    parts.push(svg('svg', { x: 34, y: 34, width: 32, height: 32, viewBox: '0 0 24 24' },
      svg('path', { d: glyph, fill: '#0c1119', opacity: '.85' })));
  }
  return svg('svg', { x: px, y: py, width: size, height: size, viewBox: '0 0 100 100', overflow: 'visible' }, parts);
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

function plotKey(x, y) { return x + ',' + y; }

function occupancy() {
  const map = Object.create(null);
  for (let i = 0; i < S.buildings.length; i++) {
    const b = S.buildings[i];
    map[plotKey(b.x, b.y)] = b;
  }
  return map;
}

/** Main construction slots (base + 'queue.build' building effects). */
function mainSlots() {
  let extra = 0;
  for (let i = 0; i < S.buildings.length; i++) {
    const b = S.buildings[i];
    if (b.state === 'building') continue;
    const e = getEffect(b.key, b.level);
    if (e && e['queue.build']) extra += e['queue.build'];
  }
  return QUEUE.buildSlots + Math.floor(extra);
}

/**
 * Can a job of `seconds` start right now? The reserve ("quick") crew only takes
 * short jobs, so this is NOT a plain queue-length check — it asks the engine,
 * and mirrors engine/build.js pickSlot() exactly in the local fallback.
 * @param {number} seconds duration of the job that wants a slot
 * @returns {boolean}
 */
function slotsFreeFor(seconds) {
  const fn = pickFn(BUILDX, ['hasSlotFor']);
  if (fn) {
    try { return !!fn(seconds); } catch (err) { /* fall through to the local rule */ }
  }
  const q = S.queues.build || [];
  let main = 0;
  let quick = 0;
  for (let i = 0; i < q.length; i++) {
    if (q[i] && q[i].slot === 'quick') quick += 1; else main += 1;
  }
  if (main < mainSlots()) return true;
  return quick < QUEUE.freeBuildSlots && seconds <= QUEUE.freeFinishSec;
}

/** Why no crew is available for a job of `seconds`. */
function noSlotReason(seconds) {
  const q = S.queues.build || [];
  let quick = 0;
  for (let i = 0; i < q.length; i++) if (q[i] && q[i].slot === 'quick') quick += 1;
  return (quick < QUEUE.freeBuildSlots)
    ? 'The reserve crew only takes jobs under ' + formatTime(QUEUE.freeFinishSec) + '.'
    : 'All construction crews are busy.';
}

/** Copies of `key` already standing, and how many the HQ allows. */
function copyStatus(key) {
  const built = countBuilt(key, S.buildings);
  const max = maxCopies(key, S.player.hqLevel);
  return { built, max, atLimit: built >= max };
}

function queueItemFor(b) {
  const q = S.queues.build || [];
  for (let i = 0; i < q.length; i++) {
    if (q[i] && q[i].bid === b.id) return q[i];
  }
  return null;
}

function remainingSec(b) {
  const item = queueItemFor(b);
  const end = (item && item.endAt) || b.doneAt || 0;
  return Math.max(0, Math.ceil((end - Date.now()) / 1000));
}

function progressOf(b) {
  const item = queueItemFor(b);
  const start = (item && item.startAt) || b.startedAt || 0;
  const end = (item && item.endAt) || b.doneAt || 0;
  if (!(end > start)) return 1;
  return clamp((Date.now() - start) / (end - start), 0, 1);
}

/**
 * Construction time in seconds, exactly as engine/build.js computes it —
 * build.speed bonuses AND the settings speed multiplier, so the number on the
 * button is the number the queue will use.
 */
function effBuildTime(key, level) {
  const fn = pickFn(BUILDX, ['buildTimeFor']);
  if (fn) {
    try {
      const v = Number(fn(key, level));
      if (Number.isFinite(v) && v > 0) return v;
    } catch (err) { /* fall through */ }
  }
  const base = getBuildTime(key, level);
  const b = bonus('build.speed');
  const speed = clamp(Number(S.settings && S.settings.speed) || 1, 1, 4);
  return Math.max(1, Math.round(base / (1 + (b || 0)) / speed));
}

function canAfford(cost) {
  for (let i = 0; i < RES_KEYS.length; i++) {
    const k = RES_KEYS[i];
    if ((cost[k] || 0) > (S.res[k] || 0)) return false;
  }
  return true;
}

function uniqueTaken(key) {
  const def = BUILDINGS[key];
  if (!def || !def.unique) return false;
  for (let i = 0; i < S.buildings.length; i++) if (S.buildings[i].key === key) return true;
  return false;
}

// ---------------------------------------------------------------------------
// Engine actions (engine/build.js when present, local fallback otherwise)
// ---------------------------------------------------------------------------

function tryEngine(names, attempts) {
  const fn = pickFn(BUILDX, names);
  if (!fn) return { handled: false };
  for (let i = 0; i < attempts.length; i++) {
    let out;
    try {
      out = fn.apply(null, attempts[i]);
    } catch (err) {
      continue;
    }
    if (out === false) return { handled: true, ok: false, reason: 'Not possible right now.' };
    if (out && typeof out === 'object' && out.ok === false) {
      return { handled: true, ok: false, reason: out.reason || out.error || 'Not possible right now.' };
    }
    return { handled: true, ok: true, result: out };
  }
  return { handled: false };
}

function payCost(cost) {
  for (let i = 0; i < RES_KEYS.length; i++) {
    const k = RES_KEYS[i];
    if (cost[k]) S.res[k] = Math.max(0, (S.res[k] || 0) - cost[k]);
  }
  emit('res:changed', S.res);
}

function pushQueue(b, toLevel, sec) {
  const now = Date.now();
  const end = now + sec * 1000;
  b.state = 'building';
  b.startedAt = now;
  b.doneAt = end;
  S.queues.build.push({ bid: b.id, key: b.key, toLevel, startAt: now, endAt: end });
  markDirty();
  emit('state:changed', { reason: 'build:start' });
  save();
}

/**
 * Start a brand-new building on an empty plot.
 * @param {string} key
 * @param {number} x
 * @param {number} y
 * @returns {{ok:boolean, reason?:string}}
 */
function startBuild(key, x, y) {
  // engine/build.js signature is startBuild(plot, buildingKey) — plot first.
  const eng = tryEngine(
    ['startBuild', 'buildNew', 'placeBuilding', 'enqueueBuild', 'startConstruction'],
    [[{ x, y }, key], [key, x, y], [{ key, x, y }]]
  );
  if (eng.handled) return { ok: eng.ok, reason: eng.reason };

  const seconds = effBuildTime(key, 1);
  if (!slotsFreeFor(seconds)) return { ok: false, reason: noSlotReason(seconds) };
  const status = copyStatus(key);
  if (status.atLimit) {
    return { ok: false, reason: 'You may only run ' + status.max + ' of these at HQ Lv' + S.player.hqLevel + '.' };
  }
  const cost = getPlaceCost(key, status.built);
  if (!canAfford(cost)) return { ok: false, reason: 'Not enough resources.' };
  payCost(cost);
  const b = addBuilding(key, 0, x, y);
  pushQueue(b, 1, seconds);
  addLog('build', 'Construction started: ' + (BUILDINGS[key] ? BUILDINGS[key].name : key) + '.', { key, x, y });
  return { ok: true };
}

/**
 * Upgrade an existing building by one level.
 * @param {object} b building record from S.buildings
 * @returns {{ok:boolean, reason?:string}}
 */
function startUpgrade(b) {
  const eng = tryEngine(
    ['startUpgrade', 'upgradeBuilding', 'enqueueUpgrade', 'upgrade'],
    [[b.id], [b], [b.key, b.id], [{ id: b.id }]]
  );
  if (eng.handled) return { ok: eng.ok, reason: eng.reason };

  const target = b.level + 1;
  const def = BUILDINGS[b.key];
  if (!def) return { ok: false, reason: 'Unknown building.' };
  if (target > (def.maxLevel || MAX_LEVEL)) return { ok: false, reason: 'Already at maximum level.' };
  const upSeconds = effBuildTime(b.key, target);
  if (!slotsFreeFor(upSeconds)) return { ok: false, reason: noSlotReason(upSeconds) };
  if (missingRequirements(b.key, target, S.player.hqLevel, S.buildings).length) {
    return { ok: false, reason: 'Requirements not met.' };
  }
  const cost = getCost(b.key, target);
  if (!canAfford(cost)) return { ok: false, reason: 'Not enough resources.' };
  payCost(cost);
  pushQueue(b, target, upSeconds);
  addLog('build', def.name + ' upgrading to level ' + target + '.', { key: b.key, level: target });
  return { ok: true };
}

/**
 * Spend gold (or nothing, under the free-finish threshold) to finish a build.
 * @param {object} b
 * @returns {{ok:boolean, reason?:string}}
 */
function speedUp(b) {
  const sec = remainingSec(b);
  const item0 = queueItemFor(b);
  const totalSec = item0
    ? Math.max(1, (item0.endAt - item0.startAt) / 1000)
    : Math.max(1, ((b.doneAt || 0) - (b.startedAt || 0)) / 1000);
  // engine/build.js signature is speedUp(buildingId, useGold). The player has
  // already confirmed by pressing the (gold-priced) button, so useGold is true.
  const eng = tryEngine(
    ['speedUp', 'speedUpBuild', 'rushBuild', 'finishBuild', 'finishNow'],
    [[b.id, true], [b, true], [queueItemFor(b)], [{ id: b.id }]]
  );
  if (eng.handled) return { ok: eng.ok, reason: eng.reason };

  const gold = SPEEDUP.goldFor(sec, totalSec);
  if (gold > (S.res.gold || 0)) return { ok: false, reason: 'Not enough gold (' + formatNum(gold) + ' needed).' };
  if (gold > 0) {
    S.res.gold -= gold;
    emit('res:changed', S.res);
  }
  const now = Date.now();
  b.doneAt = now;
  const item = queueItemFor(b);
  if (item) item.endAt = now;
  markDirty();
  emit('state:changed', { reason: 'build:speedup' });
  save();
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Render — SVG plot grid
// ---------------------------------------------------------------------------

const refs = {
  root: null, svgEl: null, world: null, plots: null, floats: null,
  queueBox: null, sheet: null, timers: []
};
let selectedPlot = null; // "x,y"
let redrawPending = false;

function scheduleRedraw() {
  if (redrawPending) return;
  redrawPending = true;
  setTimeout(() => {
    redrawPending = false;
    if (refs.root && refs.root.isConnected) {
      drawPlots();
      renderQueueStrip();
    }
  }, 0);
}

function applyTransform() {
  if (!refs.world) return;
  const v = BASE_VIEW;
  const maxX = 620 * v.scale;
  const maxY = 520 * v.scale;
  v.tx = clamp(v.tx, -maxX, maxX);
  v.ty = clamp(v.ty, -maxY, maxY);
  refs.world.setAttribute('transform', 'translate(' + v.tx.toFixed(2) + ' ' + v.ty.toFixed(2) + ') scale(' + v.scale.toFixed(4) + ')');
}

/** Screen point -> viewBox units (the svg uses preserveAspectRatio slice). */
function toVB(clientX, clientY) {
  const r = refs.svgEl.getBoundingClientRect();
  const f = Math.max(r.width / VB.w, r.height / VB.h) || 1;
  const ox = (r.width - VB.w * f) / 2;
  const oy = (r.height - VB.h * f) / 2;
  return {
    x: VB.x + (clientX - r.left - ox) / f,
    y: VB.y + (clientY - r.top - oy) / f,
    f
  };
}

function zoomAt(clientX, clientY, factor) {
  const v = BASE_VIEW;
  const before = toVB(clientX, clientY);
  const wx = (before.x - v.tx) / v.scale;
  const wy = (before.y - v.ty) / v.scale;
  v.scale = clamp(v.scale * factor, 0.6, 3);
  v.tx = before.x - wx * v.scale;
  v.ty = before.y - wy * v.scale;
  applyTransform();
}

function drawPlots() {
  if (!refs.plots) return;
  clear(refs.plots);
  refs.timers = [];
  const occ = occupancy();

  for (let i = 0; i < PLOT_SLOTS.length; i++) {
    const slot = PLOT_SLOTS[i];
    const b = occ[plotKey(slot.x, slot.y)] || null;
    const p = worldPos(slot.x, slot.y);
    const g = svg('g.plot', {
      transform: 'translate(' + p.sx + ' ' + p.sy + ')',
      dataset: { plot: plotKey(slot.x, slot.y) }
    });
    if (!b) g.classList.add('plot--empty');
    if (selectedPlot === plotKey(slot.x, slot.y)) g.classList.add('plot--sel');

    g.appendChild(svg('path.plot__tile', {
      d: 'M0 ' + (-TILE_H / 2) + ' L' + (TILE_W / 2) + ' 0 L0 ' + (TILE_H / 2) + ' L' + (-TILE_W / 2) + ' 0 Z'
    }));

    if (!b) {
      g.appendChild(svg('circle', { cx: 0, cy: 0, r: 15, fill: 'rgba(240,165,0,.10)', stroke: 'rgba(240,165,0,.45)', 'stroke-width': 1.5 }));
      g.appendChild(svg('path', {
        d: 'M-8 0 H8 M0 -8 V8',
        stroke: 'var(--accent)', 'stroke-width': 2.5, 'stroke-linecap': 'round'
      }));
    } else {
      const def = BUILDINGS[b.key];
      const building = b.state === 'building';
      const art = buildingArt(b.key, Math.max(1, b.level), 92, -46, -92);
      if (building) art.setAttribute('opacity', '.45');
      g.appendChild(art);

      if (building) {
        const ringBg = svg('circle.ring__bg', { cx: 0, cy: -50, r: RING_R });
        const ringFg = svg('circle.ring__fg', {
          cx: 0, cy: -50, r: RING_R,
          'stroke-dasharray': RING_C.toFixed(2),
          'stroke-dashoffset': RING_C.toFixed(2)
        });
        const tnode = svg('text.plot__time', { x: 0, y: 30 }, '');
        g.appendChild(ringBg);
        g.appendChild(ringFg);
        g.appendChild(tnode);
        refs.timers.push({ b, ring: ringFg, label: tnode });
      } else {
        g.appendChild(svg('circle.plot__badge', { cx: 36, cy: 6, r: 14 }));
        g.appendChild(svg('text.plot__badgetxt', { x: 36, y: 11 }, String(b.level)));
        g.appendChild(svg('text.plot__label', { x: 0, y: 30 }, def ? def.name : b.key));
      }
    }
    refs.plots.appendChild(g);
  }
  tickTimers();
}

function tickTimers() {
  for (let i = 0; i < refs.timers.length; i++) {
    const t = refs.timers[i];
    const p = progressOf(t.b);
    t.ring.setAttribute('stroke-dashoffset', (RING_C * (1 - p)).toFixed(2));
    const rem = remainingSec(t.b);
    t.label.textContent = rem > 0 ? formatClock(rem) : 'DONE';
  }
}

// ---------------------------------------------------------------------------
// Production tickers (floating +N)
// ---------------------------------------------------------------------------

const PRODUCER_OF = { oil: 'oil_well', steel: 'steel_mill', rare: 'rare_mine', food: 'farm' };
let lastRes = null;
let accum = { oil: 0, steel: 0, rare: 0, food: 0 };
let accumSince = Date.now();

function noteResChange() {
  if (!lastRes) {
    lastRes = { oil: S.res.oil, steel: S.res.steel, rare: S.res.rare, food: S.res.food };
    return;
  }
  for (let i = 0; i < RES_KEYS.length; i++) {
    const k = RES_KEYS[i];
    const d = (S.res[k] || 0) - (lastRes[k] || 0);
    if (d > 0) accum[k] += d;
    lastRes[k] = S.res[k] || 0;
  }
}

function flushFloaters() {
  if (!refs.floats || !refs.root || !refs.root.isConnected) {
    // Not on screen: drop what accumulated so returning never dumps a huge tick.
    accum = { oil: 0, steel: 0, rare: 0, food: 0 };
    accumSince = Date.now();
    return;
  }
  if (Date.now() - accumSince < 2500) return;
  accumSince = Date.now();
  const occ = occupancy();
  let slot = 0;
  for (let i = 0; i < RES_KEYS.length; i++) {
    const k = RES_KEYS[i];
    const amount = Math.floor(accum[k]);
    accum[k] = 0;
    if (amount < 1) continue;
    let pos = { sx: 0, sy: 0 };
    const want = PRODUCER_OF[k];
    let found = null;
    for (const pk in occ) {
      if (occ[pk].key === want && occ[pk].state !== 'building') { found = occ[pk]; break; }
    }
    if (found) pos = worldPos(found.x, found.y);
    else pos = { sx: -140 + slot * 96, sy: 0 };
    slot++;
    const node = svg('text.floaty', {
      x: pos.sx, y: pos.sy - 96, fill: resColor(k)
    }, '+' + formatNum(amount));
    refs.floats.appendChild(node);
    setTimeout(() => { if (node.parentNode) node.parentNode.removeChild(node); }, 1700);
  }
}

// ---------------------------------------------------------------------------
// Bottom sheet
// ---------------------------------------------------------------------------

/** Close any open bottom sheet. */
export function closeSheet() {
  const s = refs.sheet;
  refs.sheet = null;
  if (!s) return;
  s.classList.remove('is-in');
  // Stays in the DOM for the fade-out; keep it out of hit-testing so the second
  // half of a double-tap cannot re-fire whatever is underneath the finger.
  s.style.pointerEvents = 'none';
  setTimeout(() => { if (s.parentNode) s.parentNode.removeChild(s); }, 190);
}

function openSheet(title, bodyNode) {
  closeSheet();
  injectCSS();
  const box = h('div.bsheet__box', { onclick: (e) => e.stopPropagation() }, [
    h('div.bsheet__grab'),
    bodyNode
  ]);
  const wrap = h('div.bsheet', { role: 'dialog', 'aria-label': title || 'Details' }, [
    h('div.bsheet__bd', { onclick: () => closeSheet() }),
    box
  ]);
  (refs.root || document.body).appendChild(wrap);
  refs.sheet = wrap;
  void wrap.offsetWidth;
  wrap.classList.add('is-in');
  return wrap;
}

const EFFECT_LABEL = {
  'queue.build': 'Construction slots', 'queue.train': 'Training slots', 'queue.research': 'Research slots',
  'train.speed': 'Training speed', 'build.speed': 'Construction speed', 'research.speed': 'Research speed',
  'heal.capacity': 'Hospital beds', 'heal.speed': 'Healing speed', 'march.slots': 'March slots',
  'march.speed': 'March speed', 'map.vision': 'Map vision', 'wall.hp': 'Wall HP',
  'wall.defense': 'Wall defence', 'officer.slots': 'Officer slots', 'officer.xpRate': 'Officer XP rate',
  'trade.rate': 'Trade efficiency', 'trade.gold': 'Gold per hour', 'unlock.tier': 'Max unit tier'
};
const PERCENT_EFFECTS = /(\.speed|xpRate|defense|trade\.rate)$/;

function fmtEffect(k, v) {
  if (PERCENT_EFFECTS.test(k)) return (v >= 0 ? '+' : '') + pct(v, 1);
  return formatNum(v, 0);
}

const RES_NAME = { oil: 'Oil', steel: 'Steel', rare: 'Rare Earth', food: 'Food' };

/** Rows of {label, cur, next} describing a level step. */
function statRows(key, level) {
  const rows = [];
  const next = level + 1;
  const prod = getProduction(key, level);
  const prodN = getProduction(key, next);
  if (prod || prodN) {
    const res = (prod || prodN).res;
    rows.push({
      label: RES_NAME[res] + ' output',
      cur: prod ? formatNum(prod.perHour) + '/h' : '—',
      next: prodN ? formatNum(prodN.perHour) + '/h' : null
    });
  }
  const cap = getCapacity(key, level);
  const capN = getCapacity(key, next);
  const capKeys = ['oil', 'steel', 'rare', 'food'];
  const capSame = capKeys.every((k) => cap[k] === cap.oil) && cap.oil > 0;
  if (capSame) {
    rows.push({ label: 'Storage (each)', cur: formatNum(cap.oil), next: formatNum(capN.oil) });
  } else {
    for (let i = 0; i < capKeys.length; i++) {
      const k = capKeys[i];
      if (!cap[k] && !capN[k]) continue;
      rows.push({ label: RES_NAME[k] + ' storage', cur: formatNum(cap[k]), next: formatNum(capN[k]) });
    }
  }
  if (cap.protected || capN.protected) {
    rows.push({ label: 'Protected', cur: formatNum(cap.protected), next: formatNum(capN.protected) });
  }
  const eff = getEffect(key, level);
  const effN = getEffect(key, next);
  const seen = Object.create(null);
  const keys = Object.keys(eff).concat(Object.keys(effN));
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (seen[k]) continue;
    seen[k] = 1;
    const a = eff[k] || 0;
    const bv = effN[k] || 0;
    if (!a && !bv) continue;
    rows.push({ label: EFFECT_LABEL[k] || k, cur: fmtEffect(k, a), next: fmtEffect(k, bv) });
  }
  return rows;
}

function costList(cost, short) {
  const items = [];
  for (let i = 0; i < RES_KEYS.length; i++) {
    const k = RES_KEYS[i];
    const need = cost[k] || 0;
    if (!need) continue;
    const lacking = need > (S.res[k] || 0);
    items.push(h('span.cost' + (lacking ? '.is-short' : ''), [
      icon(k, { size: 13, color: lacking ? 'var(--danger)' : resColor(k) }),
      formatNum(need)
    ]));
  }
  if (!items.length) items.push(h('span.cost.muted', 'Free'));
  return h('div.cost-list', { title: short ? 'Insufficient resources' : '' }, items);
}

const SCREEN_ACTION = {
  barracks: { label: 'Train Infantry', hash: 'army' },
  tank_factory: { label: 'Train Vehicles', hash: 'army' },
  hangar: { label: 'Train Aircraft', hash: 'army' },
  artillery_range: { label: 'Train Artillery', hash: 'army' },
  lab: { label: 'Research', hash: 'research' },
  hospital: { label: 'Heal Wounded', hash: 'army' },
  academy: { label: 'Officers', hash: 'officers' },
  radar: { label: 'World Map', hash: 'map' }
};

/**
 * Open the detail sheet for one placed building.
 * @param {object} b record from S.buildings
 */
export function openBuildingSheet(b) {
  const def = BUILDINGS[b.key];
  if (!def) return;
  const maxLv = def.maxLevel || MAX_LEVEL;
  const building = b.state === 'building';
  const target = Math.min(maxLv, b.level + 1);
  const atMax = b.level >= maxLv;
  const missing = atMax ? [] : missingRequirements(b.key, target, S.player.hqLevel, S.buildings);
  const cost = atMax ? {} : getCost(b.key, target);
  const afford = canAfford(cost);
  const upSeconds = atMax ? 0 : effBuildTime(b.key, target);
  const slotsFree = atMax ? false : slotsFreeFor(upSeconds);

  const head = h('div.bsheet__head', [
    svg('svg.bsheet__art', { viewBox: '0 0 100 100', width: 58, height: 58 },
      buildingArt(b.key, Math.max(1, b.level), 100, 0, 0)),
    h('div', [
      h('div.card__title', def.name),
      h('div.row', { style: 'gap:6px;margin-top:3px' }, [
        h('span.tag.tag--accent.tag--lvl', building ? 'Level ' + b.level + ' → ' + (b.level + 1) : 'Level ' + b.level + ' / ' + maxLv),
        h('span.tag', def.category.toUpperCase())
      ])
    ]),
    h('button.bsheet__x', { type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('close', { size: 18 }))
  ]);

  const rows = statRows(b.key, Math.max(1, b.level));
  const stats = h('div.stack', { style: 'gap:0' }, rows.length ? rows.map((r) => h('div.statrow', [
    h('span.statrow__l', r.label),
    h('span.statrow__v', String(r.cur)),
    (!atMax && r.next !== null && r.next !== undefined && String(r.next) !== String(r.cur))
      ? h('span.statrow__n', '→ ' + r.next) : null
  ])) : h('p.muted.small', def.desc));

  const body = h('div.stack', [head, h('p.small.muted', def.desc), stats]);

  if (building) {
    const rem = remainingSec(b);
    const bar = h('div.bar__fill', { style: 'width:' + (progressOf(b) * 100).toFixed(1) + '%' });
    const remLbl = h('span.mono.small', formatTime(rem));
    body.appendChild(h('div.stack', { style: 'gap:6px' }, [
      h('div.row.row--between', [h('span.small.muted.upper', 'Under construction'), remLbl]),
      h('div.bar.bar--lg', bar)
    ]));
    const job = queueItemFor(b);
    const totalSec = job
      ? Math.max(1, (job.endAt - job.startAt) / 1000)
      : Math.max(1, ((b.doneAt || 0) - (b.startedAt || 0)) / 1000);
    const gold = SPEEDUP.goldFor(rem, totalSec);
    body.appendChild(h('div.btn-row', [
      h('button.btn.btn--primary', {
        type: 'button',
        onclick: () => {
          const r = speedUp(b);
          if (!r.ok) { toast(r.reason || 'Cannot speed up.', 'warn'); return; }
          toast(gold > 0 ? 'Rushed for ' + formatNum(gold) + ' gold.' : 'Construction completed.', 'ok');
          closeSheet();
          scheduleRedraw();
        }
      }, gold > 0 ? [icon('gold', { size: 15, color: '#21160a' }), 'Speed Up ' + formatNum(gold)] : [icon('check', { size: 16, color: '#21160a' }), 'Finish Free'])
    ]));
    const tick = setInterval(() => {
      if (!refs.sheet || !refs.sheet.isConnected) { clearInterval(tick); return; }
      const rr = remainingSec(b);
      remLbl.textContent = formatTime(rr);
      bar.style.width = (progressOf(b) * 100).toFixed(1) + '%';
    }, 500);
  } else if (atMax) {
    body.appendChild(h('div.tag.tag--ok', 'Maximum level reached'));
  } else {
    const time = upSeconds;
    body.appendChild(h('div.stack', { style: 'gap:8px' }, [
      h('div.row.row--between', [
        h('span.small.muted.upper', 'Upgrade to Lv ' + target),
        h('span.small.mono.dim', [icon('clock', { size: 13, color: 'var(--muted)' }), ' ' + formatTime(time)])
      ]),
      costList(cost, !afford),
      missing.length ? h('div.stack', { style: 'gap:3px' }, missing.map((m) => h('div.small.bad', [
        icon('warn', { size: 13, color: 'var(--danger)' }), ' Requires ' + m.name + ' Lv ' + m.need + ' (have ' + m.have + ')'
      ]))) : null,
      !slotsFree ? h('div.small.muted', noSlotReason(time)) : null
    ]));
    body.appendChild(h('div.btn-row', [
      h('button.btn.btn--primary.btn--block', {
        type: 'button',
        disabled: !!missing.length || !afford || !slotsFree,
        onclick: () => {
          const r = startUpgrade(b);
          if (!r.ok) { toast(r.reason || 'Upgrade failed.', 'warn'); return; }
          toast(def.name + ' upgrading to Lv ' + target + '.', 'ok');
          closeSheet();
          scheduleRedraw();
        }
      }, 'Upgrade')
    ]));
  }

  const act = SCREEN_ACTION[b.key];
  if (act && !building) {
    body.appendChild(h('button.btn.btn--ghost.btn--block', {
      type: 'button',
      onclick: () => { closeSheet(); location.hash = '#' + act.hash; }
    }, act.label));
  }

  openSheet(def.name, body);
}

/**
 * Open the "what can I build here" picker for an empty plot.
 * @param {number} x
 * @param {number} y
 */
export function openBuildPicker(x, y) {
  const list = h('div.picker');
  let anyBuildable = false;
  for (let i = 0; i < BUILDING_KEYS.length; i++) {
    const key = BUILDING_KEYS[i];
    const def = BUILDINGS[key];
    if (!def || key === 'hq') continue;
    if (uniqueTaken(key)) continue;
    const missing = missingRequirements(key, 1, S.player.hqLevel, S.buildings);
    const status = copyStatus(key);
    // Extra copies of a producer get progressively dearer, so the price shown
    // here is the price of THIS copy, not the level-1 table value.
    const cost = getPlaceCost(key, status.built);
    const afford = canAfford(cost);
    const time = effBuildTime(key, 1);
    const slotsFree = slotsFreeFor(time);
    const locked = missing.length > 0 || status.atLimit;
    if (!locked) anyBuildable = true;
    const limitText = Number.isFinite(status.max) && status.max > 1
      ? status.built + ' / ' + status.max + ' built'
      : null;
    const lockText = missing.length
      ? 'Needs ' + missing.map((m) => m.name + ' Lv ' + m.need).join(', ')
      : 'Limit ' + status.max + ' at HQ Lv ' + S.player.hqLevel + ' — upgrade instead';
    const row = h('button.pick' + (locked ? '.is-locked' : ''), {
      type: 'button',
      onclick: () => {
        if (locked) { toast(lockText + '.', 'warn'); return; }
        if (!slotsFree) { toast(noSlotReason(time), 'warn'); return; }
        if (!afford) { toast('Not enough resources.', 'warn'); return; }
        const r = startBuild(key, x, y);
        if (!r.ok) { toast(r.reason || 'Cannot build here.', 'warn'); return; }
        toast('Construction started: ' + def.name + '.', 'ok');
        closeSheet();
        scheduleRedraw();
      }
    }, [
      svg('svg.pick__art', { viewBox: '0 0 100 100', width: 44, height: 44 }, buildingArt(key, 1, 100, 0, 0)),
      h('div.pick__b', [
        h('div.pick__n', def.name),
        locked
          ? h('div.small.bad', lockText)
          : h('div.row', { style: 'gap:10px;flex-wrap:wrap' }, [
            costList(cost, !afford),
            h('span.small.mono.muted', formatTime(time)),
            limitText ? h('span.small.muted', limitText) : null,
            !slotsFree ? h('span.small.muted', 'no crew free') : null
          ])
      ]),
      locked ? icon('warn', { size: 18, color: 'var(--danger)' }) : icon('plus', { size: 18, color: 'var(--accent)' })
    ]);
    list.appendChild(row);
  }

  const body = h('div.stack', [
    h('div.bsheet__head', [
      h('div', [
        h('div.card__title', 'Build on plot ' + (x + 1) + '-' + (y + 1)),
        h('div.small.muted', anyBuildable
          ? 'Pick a facility to construct.'
          : 'Nothing can be built here yet — raise your HQ level.')
      ]),
      h('button.bsheet__x', { type: 'button', 'aria-label': 'Close', onclick: () => closeSheet() }, icon('close', { size: 18 }))
    ]),
    list
  ]);
  openSheet('Build', body);
}

// ---------------------------------------------------------------------------
// Tap handling
// ---------------------------------------------------------------------------

function handleTap(pk) {
  selectedPlot = pk;
  // drawPlots() alone truncates refs.timers to the plot rings, which freezes
  // the construction strip's clock until the next 'state:changed'.
  drawPlots();
  renderQueueStrip();
  const parts = pk.split(',');
  const x = Number(parts[0]);
  const y = Number(parts[1]);
  const b = occupancy()[pk];
  if (b) openBuildingSheet(b);
  else openBuildPicker(x, y);
}

/** Centre the camera on a plot (used by the queue strip). */
export function focusPlot(x, y) {
  const p = worldPos(x, y);
  BASE_VIEW.tx = -p.sx * BASE_VIEW.scale;
  BASE_VIEW.ty = (VB.y + VB.h / 2) - p.sy * BASE_VIEW.scale;
  applyTransform();
}

function wirePointer(el) {
  const pts = new Map();
  let mode = '';
  let startDist = 0;
  let startScale = 1;
  let last = null;
  let downPt = null;
  let downAt = 0;
  let moved = false;
  let downTarget = null;

  const unitsPerPx = () => {
    const r = el.getBoundingClientRect();
    const f = Math.max(r.width / VB.w, r.height / VB.h) || 1;
    return 1 / f;
  };

  el.addEventListener('pointerdown', (e) => {
    // Pointer capture is best-effort: it throws NotFoundError if the pointer is
    // already gone by the time the handler runs (fast taps, synthetic events,
    // some assistive tech). Panning still works without it, so never let it
    // escape into the global error handler. ui/map.js guards this the same way.
    if (el.setPointerCapture) {
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable — carry on */ }
    }
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 1) {
      mode = 'pan';
      last = { x: e.clientX, y: e.clientY };
      downPt = { x: e.clientX, y: e.clientY };
      downAt = Date.now();
      moved = false;
      downTarget = e.target;
    } else if (pts.size === 2) {
      mode = 'pinch';
      const a = Array.from(pts.values());
      startDist = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      startScale = BASE_VIEW.scale;
    }
  });

  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (mode === 'pinch' && pts.size >= 2) {
      const a = Array.from(pts.values());
      const d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y) || 1;
      const midX = (a[0].x + a[1].x) / 2;
      const midY = (a[0].y + a[1].y) / 2;
      const want = clamp(startScale * (d / startDist), 0.6, 3);
      zoomAt(midX, midY, want / BASE_VIEW.scale);
      moved = true;
      return;
    }
    if (mode === 'pan' && last) {
      const upp = unitsPerPx();
      if (downPt && Math.hypot(e.clientX - downPt.x, e.clientY - downPt.y) > 8) moved = true;
      if (moved) {
        BASE_VIEW.tx += (e.clientX - last.x) * upp;
        BASE_VIEW.ty += (e.clientY - last.y) * upp;
        applyTransform();
      }
      last = { x: e.clientX, y: e.clientY };
    }
  });

  const end = (e) => {
    pts.delete(e.pointerId);
    if (pts.size === 0) {
      if (mode === 'pan' && !moved && Date.now() - downAt < 600 && downTarget) {
        let node = downTarget;
        while (node && node !== el) {
          if (node.getAttribute && node.getAttribute('data-plot')) {
            handleTap(node.getAttribute('data-plot'));
            break;
          }
          node = node.parentNode;
        }
      }
      mode = '';
      last = null;
      downPt = null;
      downTarget = null;
    } else if (pts.size === 1) {
      mode = 'pan';
      const a = Array.from(pts.values())[0];
      last = { x: a.x, y: a.y };
      moved = true;
    }
  };
  el.addEventListener('pointerup', end);
  el.addEventListener('pointercancel', end);

  el.addEventListener('wheel', (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY < 0 ? 1.12 : 1 / 1.12);
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// Construction queue strip
// ---------------------------------------------------------------------------

function renderQueueStrip() {
  if (!refs.queueBox) return;
  clear(refs.queueBox);
  const active = S.buildings.filter((b) => b.state === 'building');
  const slots = mainSlots() + QUEUE.freeBuildSlots;
  refs.queueBox.appendChild(h('div.panel__head', [
    h('span.panel__title', 'Construction'),
    h('span.spacer'),
    h('span.tag' + (active.length >= slots ? '.tag--danger' : '.tag--ok'), active.length + ' / ' + slots)
  ]));
  refs.queueBox.appendChild(h('div.tiny.muted', {
    style: 'padding:0 var(--sp-3)'
  }, 'The reserve crew (2nd slot) only takes jobs under ' + formatTime(QUEUE.freeFinishSec) + '.'));
  const body = h('div.panel__body.stack', { style: 'gap:8px' });
  if (!active.length) {
    body.appendChild(h('p.small.muted', 'No active construction. Tap an empty plot to build, or a facility to upgrade.'));
  } else {
    for (let i = 0; i < active.length; i++) {
      const b = active[i];
      const def = BUILDINGS[b.key];
      const fill = h('div.bar__fill', { style: 'width:' + (progressOf(b) * 100).toFixed(1) + '%' });
      const lbl = h('span.small.mono.accent', formatClock(remainingSec(b)));
      body.appendChild(h('div.card.card--tap', {
        onclick: () => { focusPlot(b.x, b.y); openBuildingSheet(b); }
      }, [
        h('div.row.row--between', [
          h('span.small', (def ? def.name : b.key) + ' → Lv ' + (b.level + 1)),
          lbl
        ]),
        h('div.bar', fill)
      ]));
      refs.timers.push({ b, ring: null, label: null, bar: fill, clock: lbl });
    }
  }
  refs.queueBox.appendChild(body);
}

function tickAll() {
  if (!refs.root || !refs.root.isConnected) {
    flushFloaters();
    return;
  }
  for (let i = 0; i < refs.timers.length; i++) {
    const t = refs.timers[i];
    const p = progressOf(t.b);
    const rem = remainingSec(t.b);
    if (t.ring) t.ring.setAttribute('stroke-dashoffset', (RING_C * (1 - p)).toFixed(2));
    if (t.label) t.label.textContent = rem > 0 ? formatClock(rem) : 'DONE';
    if (t.bar) t.bar.style.width = (p * 100).toFixed(1) + '%';
    if (t.clock) t.clock.textContent = rem > 0 ? formatClock(rem) : 'DONE';
  }
  flushFloaters();
}

let intervalId = 0;
function startTicker() {
  if (intervalId) return;
  intervalId = setInterval(tickAll, 500);
}

// ---------------------------------------------------------------------------
// Screen render
// ---------------------------------------------------------------------------

/**
 * Build the base screen. Called by the router on every navigation to #base.
 * @returns {HTMLElement}
 */
export function render() {
  injectCSS();
  refs.timers = [];
  refs.sheet = null;

  refs.plots = svg('g');
  refs.floats = svg('g');
  refs.world = svg('g', [gridBackdrop(), refs.plots, refs.floats]);
  refs.svgEl = svg('svg.base-map__svg', {
    viewBox: VB.x + ' ' + VB.y + ' ' + VB.w + ' ' + VB.h,
    preserveAspectRatio: 'xMidYMid slice',
    role: 'img',
    'aria-label': 'Base plot grid'
  }, refs.world);

  const zoomBtns = h('div.base-map__zoom', [
    h('button.btn.btn--sm', {
      type: 'button', 'aria-label': 'Zoom in',
      onclick: () => {
        const r = refs.svgEl.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1.25);
      }
    }, '+'),
    h('button.btn.btn--sm', {
      type: 'button', 'aria-label': 'Zoom out',
      onclick: () => {
        const r = refs.svgEl.getBoundingClientRect();
        zoomAt(r.left + r.width / 2, r.top + r.height / 2, 1 / 1.25);
      }
    }, '−')
  ]);

  const map = h('div.base-map', [
    refs.svgEl,
    h('div.base-map__hint', 'Drag to pan · pinch to zoom'),
    zoomBtns
  ]);

  refs.queueBox = h('section.panel');

  const root = h('section.base', [map, refs.queueBox]);
  refs.root = root;

  wirePointer(refs.svgEl);
  applyTransform();
  drawPlots();
  renderQueueStrip();
  startTicker();
  return root;
}

/** Static ground plate behind the plots. */
function gridBackdrop() {
  const g = svg('g', { opacity: '.9' });
  const corners = [
    worldPos(-0.9, -0.9), worldPos(7.9, -0.9), worldPos(7.9, 7.9), worldPos(-0.9, 7.9)
  ];
  g.appendChild(svg('path', {
    d: 'M' + corners.map((c) => c.sx + ' ' + c.sy).join(' L') + ' Z',
    fill: 'rgba(40,58,78,.45)', stroke: 'rgba(120,150,185,.25)', 'stroke-width': 2
  }));
  g.appendChild(svg('path', {
    d: 'M' + corners.map((c) => c.sx + ' ' + (c.sy + 14)).join(' L') + ' Z',
    fill: 'rgba(12,18,26,.7)'
  }));
  return g;
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

on('res:changed', noteResChange);
on('build:done', () => {
  selectedPlot = null;
  scheduleRedraw();
});
on('state:changed', () => scheduleRedraw());
on('screen:change', (p) => {
  if (!p || p.name !== 'base') closeSheet();
});

registerScreen('base', render);

export default render;
