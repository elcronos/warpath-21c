// js/ui/map.js — World Map screen.
// Pan/pinch-zoom virtualised SVG of the 40x40 grid (only the visible window plus
// a margin is in the DOM), tile action sheet (Attack / Gather / Scout / Center),
// march composer with per-unit steppers + load meter + officer picker, animated
// march routes with ETA labels, a marches strip with recall, and the modal
// battle report driven by 'battle:result'.
// Exports: render, focusTile, openTileSheet, openBattleReport
// Registers itself as the 'map' screen via registerScreen('map', render).

import { h, svg, clear } from '../util/dom.js';
import { formatNum, formatTime, formatClock, clamp } from '../util/fmt.js';
import { on } from '../util/events.js';
import { S, save } from '../engine/state.js';
import { registerScreen } from './registry.js';
import { openModal, toast, icon, resColor } from './shell.js';
import { UNITS, CLASS_META } from '../data/units.js';
import { OFFICERS } from '../data/officers.js';
import { tileArt, svgNode, squareTile } from './svg.js';
import {
  MAP_W, MAP_H, ensureMap, tileAt, cityPos, distance,
  sendMarch, recallMarch, scoutTile, activeMarches, getMarchCapacity,
  getLoadCapacity, marchTravelSeconds, isExplored, markExplored, incomingRaids
} from '../engine/worldmap.js';

const TILE = 40;      // world px per tile at zoom 1
/** Inbound enemy raids are drawn in their own alarm colour. */
const RAID_COLOR = '#ff5c5c';
const MIN_Z = 0.45;
const MAX_Z = 2.4;
const MARGIN = 3;     // extra tile rings kept in the DOM around the viewport

const RES_NAME = { oil: 'Oil Field', steel: 'Steel Yard', rare: 'Rare Earth Seam', food: 'Farmland' };

// ---------------------------------------------------------------------------
// Tile helpers (engine tile shape:
//   { x, y, type:'empty'|'res'|'npc'|'ruins'|'city',
//     res:{kind,level,amount,max}, npc:{level,units,power},
//     ruins:{level}, city:{name}, owner })
// ---------------------------------------------------------------------------

function terrainFor(x, y) {
  return ((Math.imul(x + 1, 31) ^ Math.imul(y + 1, 17)) >>> 0) % 4;
}

/**
 * Adapt an engine tile to the {kind,res,level,terrain} shape ui/svg.js draws.
 * @param {object} t engine tile
 * @returns {{kind:string,res?:string,level:number,terrain:number}}
 */
function artTileOf(t) {
  const terrain = terrainFor(t.x, t.y);
  if (t.type === 'res') return { kind: 'resource', res: t.res.kind, level: t.res.level, terrain };
  if (t.type === 'npc') return { kind: 'npc', level: t.npc.level, terrain };
  if (t.type === 'ruins') return { kind: 'ruins', level: t.ruins.level, terrain };
  if (t.type === 'city') return { kind: 'city', level: S.player.hqLevel, terrain };
  return { kind: 'empty', level: 0, terrain };
}

/** Level shown on a tile, or 0. */
function tileLevel(t) {
  if (!t) return 0;
  if (t.type === 'res') return t.res ? t.res.level : 0;
  if (t.type === 'npc') return t.npc ? t.npc.level : 0;
  if (t.type === 'ruins') return t.ruins ? t.ruins.level : 0;
  if (t.type === 'city') return S.player.hqLevel;
  return 0;
}

/** Human title for a tile. */
function tileTitle(t) {
  if (!t) return 'Uncharted';
  if (!isExplored(t.x, t.y)) return 'Unscouted Sector';
  if (t.type === 'city') return ((t.city && t.city.name) || S.player.name) + "'s Base";
  if (t.type === 'res') return (RES_NAME[t.res.kind] || 'Node') + ' Lv.' + t.res.level;
  if (t.type === 'npc') return 'Enemy Camp Lv.' + t.npc.level;
  if (t.type === 'ruins') return 'Ruins Lv.' + t.ruins.level;
  return 'Open Ground';
}

/** Accent colour used for routes/markers relating to a tile. */
function tileColor(t) {
  if (!t) return '#6f7f92';
  if (t.type === 'city') return '#f0a500';
  if (t.type === 'npc') return '#e5484d';
  if (t.type === 'res') return resColor(t.res.kind);
  if (t.type === 'ruins') return '#8b7b62';
  return '#6f7f92';
}

// ---------------------------------------------------------------------------
// Symbol cache — every distinct art variant is defined once in <defs> and
// stamped with <use>, so 600 visible tiles cost 600 tiny elements.
// ---------------------------------------------------------------------------

const symbolIds = new Set();
let defsEl = null;

/** Cache key for an art tile — art depends on kind/res/terrain and the npc tint band. */
function variantKey(a) {
  const tint = a.kind === 'npc' ? Math.min(7, Math.floor((Math.max(1, a.level) - 1) / 4)) : 0;
  return a.kind + '-' + (a.res || 'x') + '-' + tint + '-' + a.terrain;
}

/** Define the art variant once in <defs> and return its symbol id. */
function symbolFor(artTile) {
  const id = 'wma-' + variantKey(artTile);
  if (symbolIds.has(id)) return id;
  if (!defsEl) return null;
  let parsed;
  try {
    parsed = svgNode(squareTile(artTile), { viewBox: '0 0 40 40' });
  } catch (err) {
    console.warn('[map] tile art failed', err);
    return null;
  }
  const sym = svg('symbol', { id, viewBox: '0 0 40 40' });
  while (parsed.firstChild) sym.appendChild(parsed.firstChild);
  defsEl.appendChild(sym);
  symbolIds.add(id);
  return id;
}

function useNode(artTile, x, y, opacity) {
  const id = symbolFor(artTile);
  if (!id) return null;
  const a = {
    x: x * TILE, y: y * TILE, width: TILE, height: TILE,
    href: '#' + id, xlinkHref: '#' + id
  };
  if (opacity !== undefined) a.opacity = opacity;
  return svg('use', a);
}

// ---------------------------------------------------------------------------
// Camera
// ---------------------------------------------------------------------------

const cam = { cx: MAP_W / 2, cy: MAP_H / 2, z: 1, init: false };

const refs = {
  root: null, frame: null, svgEl: null, layer: null, marchLayer: null,
  strip: null, slots: null, coord: null, w: 320, h: 320
};
// Empty window sentinel (x1 < x0): "nothing is currently painted".
const NO_WINDOW = { x0: 1, x1: 0, y0: 1, y1: 0 };
let rendered = { x0: 1, x1: 0, y0: 1, y1: 0 };
// Live tile nodes keyed by y * MAP_W + x, one <g> per tile, so a pan only has
// to add the row/column that entered the viewport and drop the one that left
// instead of rebuilding every visible tile on every frame.
const tileNodes = new Map();
let tilesStale = true;
let rafPending = false;

/**
 * Mark every painted tile stale so the next draw() repaints from scratch.
 * Call whenever tile *content* changed (scouting, map regeneration, a battle),
 * as opposed to the camera merely moving.
 * The DOM is deliberately left alone until draw() actually runs, so a redraw
 * queued while the tab is backgrounded never leaves the player a blank map.
 */
function invalidateTiles() {
  tilesStale = true;
  rendered = { x0: NO_WINDOW.x0, x1: NO_WINDOW.x1, y0: NO_WINDOW.y0, y1: NO_WINDOW.y1 };
}

/**
 * Walk every tile inside rect `a` that is NOT inside rect `b`.
 * Rects are inclusive {x0,x1,y0,y1}; either may be empty (x1 < x0).
 * @param {{x0:number,x1:number,y0:number,y1:number}} a
 * @param {{x0:number,x1:number,y0:number,y1:number}} b
 * @param {(x:number,y:number)=>void} fn
 */
function forEachOutside(a, b, fn) {
  if (a.x1 < a.x0 || a.y1 < a.y0) return;
  const ox0 = Math.max(a.x0, b.x0);
  const ox1 = Math.min(a.x1, b.x1);
  const oy0 = Math.max(a.y0, b.y0);
  const oy1 = Math.min(a.y1, b.y1);
  if (b.x1 < b.x0 || b.y1 < b.y0 || ox1 < ox0 || oy1 < oy0) {
    for (let y = a.y0; y <= a.y1; y++) for (let x = a.x0; x <= a.x1; x++) fn(x, y);
    return;
  }
  for (let x = a.x0; x < ox0; x++) for (let y = a.y0; y <= a.y1; y++) fn(x, y);
  for (let x = ox1 + 1; x <= a.x1; x++) for (let y = a.y0; y <= a.y1; y++) fn(x, y);
  for (let x = ox0; x <= ox1; x++) {
    for (let y = a.y0; y < oy0; y++) fn(x, y);
    for (let y = oy1 + 1; y <= a.y1; y++) fn(x, y);
  }
}

function measure() {
  if (!refs.frame) return;
  const r = refs.frame.getBoundingClientRect();
  refs.w = Math.max(160, Math.round(r.width));
  refs.h = Math.max(160, Math.round(r.height));
  if (refs.svgEl) refs.svgEl.setAttribute('viewBox', '0 0 ' + refs.w + ' ' + refs.h);
}

function transformStr() {
  const s = TILE * cam.z;
  const tx = refs.w / 2 - cam.cx * s;
  const ty = refs.h / 2 - cam.cy * s;
  return 'translate(' + tx.toFixed(2) + ',' + ty.toFixed(2) + ') scale(' + cam.z.toFixed(4) + ')';
}

function screenToTile(px, py) {
  const s = TILE * cam.z;
  const tx = refs.w / 2 - cam.cx * s;
  const ty = refs.h / 2 - cam.cy * s;
  return { x: Math.floor((px - tx) / s), y: Math.floor((py - ty) / s) };
}

function scheduleDraw() {
  if (rafPending) return;
  rafPending = true;
  const run = () => {
    rafPending = false;
    draw();
  };
  // rAF is frozen in hidden tabs; fall back to a timer so a redraw queued while
  // the game is backgrounded is never lost.
  if (typeof requestAnimationFrame === 'function' && !document.hidden) requestAnimationFrame(run);
  else setTimeout(run, 40);
}

function draw() {
  if (!refs.layer || !refs.root || !refs.root.isConnected) return;
  cam.z = clamp(cam.z, MIN_Z, MAX_Z);
  cam.cx = clamp(cam.cx, -1, MAP_W + 1);
  cam.cy = clamp(cam.cy, -1, MAP_H + 1);

  const t = transformStr();
  refs.layer.setAttribute('transform', t);
  refs.marchLayer.setAttribute('transform', t);
  refs.layer.classList.toggle('is-far', cam.z < 0.72);

  const s = TILE * cam.z;
  const x0 = clamp(Math.floor(cam.cx - (refs.w / 2) / s) - MARGIN, 0, MAP_W - 1);
  const x1 = clamp(Math.ceil(cam.cx + (refs.w / 2) / s) + MARGIN, 0, MAP_W - 1);
  const y0 = clamp(Math.floor(cam.cy - (refs.h / 2) / s) - MARGIN, 0, MAP_H - 1);
  const y1 = clamp(Math.ceil(cam.cy + (refs.h / 2) / s) + MARGIN, 0, MAP_H - 1);

  if (tilesStale) {
    tilesStale = false;
    tileNodes.clear();
    clear(refs.layer);
  }

  if (x0 !== rendered.x0 || x1 !== rendered.x1 || y0 !== rendered.y0 || y1 !== rendered.y1) {
    const prev = rendered;
    const next = { x0, x1, y0, y1 };
    // Retire only what left the window...
    forEachOutside(prev, next, (x, y) => {
      const k = y * MAP_W + x;
      const g = tileNodes.get(k);
      if (!g) return;
      tileNodes.delete(k);
      if (g.parentNode) g.parentNode.removeChild(g);
    });
    // ...and paint only what entered it. Tiles never overlap, so append order
    // does not affect what the player sees.
    const f = document.createDocumentFragment();
    forEachOutside(next, prev, (x, y) => {
      const k = y * MAP_W + x;
      if (tileNodes.has(k)) return;
      const g = svg('g.wm-t');
      paintTile(g, x, y);
      tileNodes.set(k, g);
      f.appendChild(g);
    });
    if (f.childNodes.length) refs.layer.appendChild(f);
    rendered = next;
  }
  drawMarches();
  if (refs.coord) {
    refs.coord.textContent = 'X' + clamp(Math.round(cam.cx), 0, MAP_W) +
      ' Y' + clamp(Math.round(cam.cy), 0, MAP_H) + ' · ' + Math.round(cam.z * 100) + '%';
  }
}

function paintTile(frag, x, y) {
  const t = tileAt(x, y);
  if (!t) return;
  const seen = isExplored(x, y);
  const art = seen ? artTileOf(t) : { kind: 'empty', level: 0, terrain: terrainFor(x, y) };
  const node = useNode(art, x, y, seen ? undefined : 0.4);
  if (node) frag.appendChild(node);
  if (!seen) {
    frag.appendChild(svg('rect', {
      x: x * TILE, y: y * TILE, width: TILE, height: TILE,
      fill: '#080b10', opacity: 0.5
    }));
    return;
  }
  if (t.type === 'city') {
    frag.appendChild(svg('rect.wm-pulse', {
      x: x * TILE + 1.5, y: y * TILE + 1.5, width: TILE - 3, height: TILE - 3,
      rx: 4, fill: 'none', stroke: '#f0a500', 'stroke-width': 1.8
    }));
    frag.appendChild(tileLabel(x, y, 'BASE', '#f0a500'));
    return;
  }
  const lvl = tileLevel(t);
  if (lvl > 0) {
    frag.appendChild(tileLabel(x, y, 'Lv' + lvl, tileColor(t)));
  }
}

function tileLabel(x, y, txt, color) {
  return svg('text.wm-lbl', {
    x: x * TILE + TILE / 2, y: y * TILE + TILE - 3.5,
    'text-anchor': 'middle', 'font-size': 9, 'font-weight': 700, fill: color
  }, txt);
}

/**
 * Centre the camera on a tile.
 * @param {number} x
 * @param {number} y
 * @param {number} [zoom]
 */
export function focusTile(x, y, zoom) {
  cam.cx = x + 0.5;
  cam.cy = y + 0.5;
  if (Number.isFinite(zoom)) cam.z = clamp(zoom, MIN_Z, MAX_Z);
  cam.init = true;
  invalidateTiles();
  scheduleDraw();
}

// ---------------------------------------------------------------------------
// Marches
// ---------------------------------------------------------------------------

function marchDueAt(m) {
  if (m.state === 'gathering') return Number(m.gatherUntil) || Number(m.arriveAt) || Date.now();
  return Number(m.arriveAt) || Date.now();
}

function marchLabel(m) {
  if (m.kind === 'return') return 'Returning';
  if (m.kind === 'attack') return m.state === 'moving' ? 'Assault' : 'In battle';
  if (m.kind === 'gather') return m.state === 'gathering' ? 'Gathering' : 'Gather march';
  return 'March';
}

function marchColor(m) {
  if (m.kind === 'attack') return '#e5484d';
  if (m.kind === 'gather') return '#4fd1c5';
  if (m.kind === 'return') return '#f0a500';
  return '#4a9df8';
}

function unitsTotal(units) {
  let n = 0;
  for (const k in units) n += Math.max(0, Math.floor(units[k]) || 0);
  return n;
}

function unitPowerOf(units) {
  let p = 0;
  for (const k in units) {
    const u = UNITS[k];
    if (u) p += u.power * (Math.max(0, Math.floor(units[k]) || 0));
  }
  return Math.round(p);
}

function availableOf(key) {
  const rec = S.army[key];
  return rec ? Math.max(0, Math.floor(rec.count) || 0) : 0;
}

function drawMarches() {
  if (!refs.marchLayer) return;
  clear(refs.marchLayer);
  const now = Date.now();
  const list = activeMarches();
  for (let i = 0; i < list.length; i++) {
    const m = list[i];
    if (!m || !m.from || !m.to) continue;
    const c = marchColor(m);
    const x0 = m.from.x * TILE + TILE / 2, y0 = m.from.y * TILE + TILE / 2;
    const x1 = m.to.x * TILE + TILE / 2, y1 = m.to.y * TILE + TILE / 2;
    let mx = x1, my = y1;
    if (m.state === 'moving') {
      const span = Math.max(1, (m.arriveAt || now) - (m.startAt || now));
      const f = clamp((now - (m.startAt || now)) / span, 0, 1);
      mx = x0 + (x1 - x0) * f;
      my = y0 + (y1 - y0) * f;
    }
    refs.marchLayer.appendChild(svg('line.wm-route', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: c, 'stroke-width': 2.2, 'stroke-dasharray': '7 5',
      'stroke-linecap': 'round', opacity: 0.8
    }));
    refs.marchLayer.appendChild(svg('circle', {
      cx: mx, cy: my, r: 6.5, fill: c, stroke: '#0d1117', 'stroke-width': 1.6
    }));
    const left = Math.max(0, Math.round((marchDueAt(m) - now) / 1000));
    refs.marchLayer.appendChild(svg('text.wm-eta', {
      x: mx, y: my - 11, 'text-anchor': 'middle', 'font-size': 10,
      'font-weight': 700, fill: c
    }, formatClock(left)));
  }
  drawRaids(now);
}

/** Inbound enemy raid columns, drawn in red heading for your city. */
function drawRaids(now) {
  const raids = incomingRaids();
  for (let i = 0; i < raids.length; i++) {
    const r = raids[i];
    if (!r || !r.from || !r.to) continue;
    const x0 = r.from.x * TILE + TILE / 2, y0 = r.from.y * TILE + TILE / 2;
    const x1 = r.to.x * TILE + TILE / 2, y1 = r.to.y * TILE + TILE / 2;
    const span = Math.max(1, (r.arriveAt || now) - (r.startAt || now));
    const f = clamp((now - (r.startAt || now)) / span, 0, 1);
    const mx = x0 + (x1 - x0) * f;
    const my = y0 + (y1 - y0) * f;
    refs.marchLayer.appendChild(svg('line.wm-route', {
      x1: x0, y1: y0, x2: x1, y2: y1,
      stroke: RAID_COLOR, 'stroke-width': 2.6, 'stroke-dasharray': '3 4',
      'stroke-linecap': 'round', opacity: 0.9
    }));
    refs.marchLayer.appendChild(svg('circle', {
      cx: mx, cy: my, r: 7, fill: RAID_COLOR, stroke: '#0d1117', 'stroke-width': 1.8
    }));
    const left = Math.max(0, Math.round(((r.arriveAt || now) - now) / 1000));
    refs.marchLayer.appendChild(svg('text.wm-eta', {
      x: mx, y: my - 12, 'text-anchor': 'middle', 'font-size': 10,
      'font-weight': 800, fill: RAID_COLOR
    }, 'RAID ' + formatClock(left)));
  }
}

/** A row in the marches strip for an inbound raid (no recall — it is not yours). */
function raidRow(r) {
  const eta = h('span.wm-eta-lbl.mono', '--:--');
  const row = h('div.wm-mrow', [
    h('span.wm-mdot', { style: { background: RAID_COLOR } }),
    h('div.wm-minfo', [
      h('div.wm-mtitle', 'INBOUND RAID → your city'),
      h('div.tiny.muted', formatNum(unitsTotal(r.units)) + ' Lv' + r.level +
        ' raiders from ' + r.from.x + ',' + r.from.y)
    ]),
    eta
  ]);
  row._eta = eta;
  row._raid = r;
  return row;
}

function marchRow(m) {
  const eta = h('span.wm-eta-lbl.mono', '--:--');
  const row = h('div.wm-mrow', [
    h('span.wm-mdot', { style: { background: marchColor(m) } }),
    h('div.wm-minfo', [
      h('div.wm-mtitle', marchLabel(m) + ' → ' + m.to.x + ',' + m.to.y),
      h('div.tiny.muted', formatNum(unitsTotal(m.units)) + ' troops' +
        (m.officer && OFFICERS[m.officer] ? ' · ' + OFFICERS[m.officer].name : ''))
    ]),
    eta,
    m.kind === 'return' ? null : h('button.btn.btn--ghost.btn--sm', {
      type: 'button',
      onclick: () => {
        const r = recallMarch(m.id);
        if (r && r.ok) toast('March recalled.', 'info');
        refreshMarches();
        scheduleDraw();
      }
    }, 'Recall')
  ]);
  row._eta = eta;
  row._m = m;
  return row;
}

function refreshMarches() {
  if (!refs.strip || !refs.root || !refs.root.isConnected) return;
  const list = activeMarches();
  const raids = incomingRaids();
  clear(refs.strip);
  if (refs.slots) refs.slots.textContent = list.length + ' / ' + getMarchCapacity() + ' slots';
  const raidRows = [];
  for (let i = 0; i < raids.length; i++) {
    const rr = raidRow(raids[i]);
    raidRows.push(rr);
    refs.strip.appendChild(rr);
  }
  if (list.length === 0 && raids.length === 0) {
    refs.strip.appendChild(h('div.wm-empty.tiny.muted',
      'No marches in the field. Tap a tile to deploy.'));
    refs.strip._rows = [];
    return;
  }
  const rows = raidRows;
  for (let i = 0; i < list.length; i++) {
    const r = marchRow(list[i]);
    rows.push(r);
    refs.strip.appendChild(r);
  }
  refs.strip._rows = rows;
  tickCountdowns();
}

function tickCountdowns() {
  const rows = refs.strip && refs.strip._rows;
  if (!rows) return;
  const now = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const due = rows[i]._raid
      ? (Number(rows[i]._raid.arriveAt) || now)
      : marchDueAt(rows[i]._m);
    rows[i]._eta.textContent = formatClock(Math.max(0, Math.round((due - now) / 1000)));
  }
}

// ---------------------------------------------------------------------------
// Small UI atoms
// ---------------------------------------------------------------------------

function statGrid(pairs, cols) {
  return h('div.wm-sumgrid' + (cols === 2 ? '.wm-sumgrid--2' : ''), pairs.map((p) => h('div.wm-sumcell', [
    h('div.tiny.muted.upper', p[0]),
    h('div.wm-sumval', p[1])
  ])));
}

function meter(frac, color) {
  const v = Number.isFinite(frac) ? clamp(frac, 0, 1) : 0;
  return h('div.bar', h('div.bar__fill', {
    style: { width: (v * 100).toFixed(1) + '%', background: color }
  }));
}

function winColor(p) {
  return p >= 0.7 ? 'var(--ok)' : p >= 0.45 ? 'var(--warn)' : 'var(--danger)';
}

// ---------------------------------------------------------------------------
// March composer
// ---------------------------------------------------------------------------

function stepperRow(key, sel, onChange) {
  const u = UNITS[key];
  const avail = availableOf(key);
  const meta = CLASS_META[u.cls];
  const input = h('input.input.wm-num', {
    type: 'text', inputmode: 'numeric', value: '0', 'aria-label': u.name + ' count'
  });
  const commit = (n) => {
    const v = clamp(Math.floor(Number(n) || 0), 0, avail);
    sel[key] = v;
    input.value = String(v);
    onChange();
  };
  input.addEventListener('input', () => {
    const raw = input.value.replace(/[^0-9]/g, '');
    sel[key] = clamp(Math.floor(Number(raw) || 0), 0, avail);
    onChange();
  });
  input.addEventListener('blur', () => commit(sel[key]));
  const step = (dir) => {
    const cur = sel[key] || 0;
    const mag = cur >= 500 ? 100 : cur >= 100 ? 25 : cur >= 20 ? 5 : 1;
    commit(cur + dir * mag);
  };
  return h('div.wm-urow', [
    h('span.wm-udot', { style: { background: meta ? meta.color : '#8a97a6' } }),
    h('div.wm-uinfo', [
      h('div.wm-uname', u.name),
      h('div.tiny.muted', (meta ? meta.short : u.cls) + ' T' + u.tier + ' · ' + formatNum(avail) + ' ready')
    ]),
    h('button.btn.btn--ghost.wm-step', { type: 'button', 'aria-label': 'Fewer ' + u.name, onclick: () => step(-1) }, '−'),
    input,
    h('button.btn.btn--ghost.wm-step', { type: 'button', 'aria-label': 'More ' + u.name, onclick: () => step(1) }, '+'),
    h('button.btn.btn--ghost.btn--sm.wm-max', { type: 'button', onclick: () => commit(avail) }, 'Max')
  ]);
}

function officerPicker(state, onChange) {
  const wrap = h('div.wm-offs');
  const owned = Object.keys(S.officers.owned || {}).filter((k) => OFFICERS[k]);
  const make = (key) => {
    const o = key ? OFFICERS[key] : null;
    const chip = h('button.wm-off', {
      type: 'button',
      onclick: () => {
        state.officer = key;
        for (let i = 0; i < wrap.children.length; i++) wrap.children[i].classList.remove('is-on');
        chip.classList.add('is-on');
        onChange();
      }
    }, [
      h('span.wm-off__ini', o ? initials(o.name) : '—'),
      h('span.wm-off__nm.tiny', o ? o.name : 'No leader')
    ]);
    if (state.officer === key) chip.classList.add('is-on');
    return chip;
  };
  wrap.appendChild(make(null));
  for (let i = 0; i < owned.length; i++) wrap.appendChild(make(owned[i]));
  if (owned.length === 0) {
    wrap.appendChild(h('span.tiny.muted.wm-nooff', 'Recruit officers to lead marches.'));
  }
  return wrap;
}

function initials(name) {
  const parts = String(name).replace(/[^A-Za-z ]/g, '').trim().split(/\s+/);
  if (parts.length === 0) return '??';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/**
 * Open the force-selection sheet for a march.
 * @param {'attack'|'gather'} kind
 * @param {object} tile engine tile
 */
function openComposer(kind, tile) {
  const keys = Object.keys(UNITS).filter((k) => availableOf(k) > 0);
  if (keys.length === 0) {
    toast('No troops at home. Train units first.', 'warn');
    return;
  }
  if (activeMarches().length >= getMarchCapacity()) {
    toast('All march slots are busy.', 'warn');
    return;
  }
  const sel = {};
  const state = { officer: null };
  const summary = h('div.stack.wm-sum');
  const sendBtn = h('button.btn.btn--primary.wm-block', { type: 'button', disabled: true },
    kind === 'attack' ? 'Launch Assault' : 'Send Gather Column');

  const home = cityPos();
  const dist = distance(home.x, home.y, tile.x, tile.y);

  const update = () => {
    const total = unitsTotal(sel);
    clear(summary);
    if (total === 0) {
      summary.appendChild(h('div.tiny.muted', 'Select at least one unit.'));
      sendBtn.disabled = true;
      return;
    }
    sendBtn.disabled = false;
    const cap = getLoadCapacity(sel);
    const travel = marchTravelSeconds(dist, sel, false);
    const est = scoutTile(tile.x, tile.y, sel, { officer: state.officer });
    const rows = [
      ['Troops', formatNum(total)],
      ['Power', formatNum(unitPowerOf(sel))],
      ['March', formatTime(travel)]
    ];
    if (kind === 'attack') {
      const win = est && Number.isFinite(est.winChance) ? est.winChance : 0;
      rows.push(['Win chance', Math.round(win * 100) + '%']);
      summary.appendChild(statGrid(rows));
      summary.appendChild(meter(win, winColor(win)));
      summary.appendChild(h('div.tiny.muted',
        'Enemy power ' + formatNum((est && est.enemyPower) || 0) +
        ' vs your ' + formatNum((est && est.ownPower) || unitPowerOf(sel))));
    } else {
      const pool = tile.type === 'res' ? tile.res.amount : 0;
      const haul = pool > 0 ? Math.min(cap, pool) : cap;
      const gsec = est && Number.isFinite(est.gatherSec) ? est.gatherSec : 300;
      rows.push(['Capacity', formatNum(cap)]);
      rows.push(['Gather', formatTime(gsec)]);
      summary.appendChild(statGrid(rows));
      summary.appendChild(meter(cap > 0 ? haul / cap : 0, resColor(tile.type === 'res' ? tile.res.kind : 'steel')));
      summary.appendChild(h('div.tiny.muted', tile.type === 'res'
        ? ('Node holds ' + formatNum(pool) + ' ' + tile.res.kind + '. You can carry ' +
           formatNum(cap) + '. Round trip ≈ ' + formatTime(travel + gsec + marchTravelSeconds(dist, sel, true)))
        : ('Scavenging the ruins takes 5m. Round trip ≈ ' +
           formatTime(travel + 300 + marchTravelSeconds(dist, sel, true)))));
    }
  };

  const body = h('div.stack', [
    h('div.wm-target', [
      h('strong', tileTitle(tile)),
      h('span.tiny.muted', '  (' + tile.x + ', ' + tile.y + ') · ' + dist.toFixed(1) + ' tiles')
    ]),
    h('div.tiny.upper.muted', 'Select forces'),
    h('div.wm-units', keys.map((k) => stepperRow(k, sel, update))),
    h('div.tiny.upper.muted', 'Commander'),
    officerPicker(state, update),
    summary,
    h('div.wm-send', sendBtn)
  ]);

  const modal = openModal({
    title: kind === 'attack' ? 'Assault' : 'Gather',
    body,
    cls: 'wm-modal'
  });

  // The closing modal is hit-testable for ~180ms, so a double-tap would launch
  // two identical columns. Latch only on the path that actually closes, so a
  // rejected order (no free slot, exhausted node) leaves the button live.
  let sending = false;
  sendBtn.addEventListener('click', () => {
    if (sending) return;
    if (unitsTotal(sel) === 0) return;
    const res = sendMarch({ toX: tile.x, toY: tile.y, kind, units: sel, officer: state.officer });
    if (res && res.ok) {
      sending = true;
      toast((kind === 'attack' ? 'Assault' : 'Gather column') + ' launched.', 'ok');
      modal.close();
      refreshMarches();
      scheduleDraw();
    }
  });

  update();
}

// ---------------------------------------------------------------------------
// Tile action sheet
// ---------------------------------------------------------------------------

/**
 * Open the action sheet for a tile.
 * @param {object} tile engine tile object
 */
export function openTileSheet(tile) {
  if (!tile) return;
  const seen = isExplored(tile.x, tile.y);
  const home = cityPos();
  const dist = distance(home.x, home.y, tile.x, tile.y);
  const est = scoutTile(tile.x, tile.y, null, null);

  const rows = [
    ['Distance', dist.toFixed(1) + ' tiles'],
    ['March', formatTime((est && est.travelSec) || Math.round(dist * 6))]
  ];
  if (!seen) {
    rows.push(['Intel', 'Unknown']);
    rows.push(['Status', 'Unscouted']);
  } else if (tile.type === 'npc') {
    rows.push(['Enemy power', formatNum((est && est.enemyPower) || tile.npc.power || 0)]);
    rows.push(['Win chance', unitsTotal(homeArmyMap()) > 0
      ? Math.round(((est && est.winChance) || 0) * 100) + '% (full army)'
      : 'No troops']);
  } else if (tile.type === 'res') {
    rows.push(['Remaining', formatNum(tile.res.amount)]);
    rows.push(['Resource', RES_NAME[tile.res.kind] || tile.res.kind]);
  } else if (tile.type === 'ruins') {
    rows.push(['Scavenge', 'Lv.' + tile.ruins.level + ' cache']);
    rows.push(['Time', '5m on site']);
  } else if (tile.type === 'city') {
    rows.push(['HQ', 'Level ' + S.player.hqLevel]);
    rows.push(['Power', formatNum(S.player.power || 0)]);
  }

  const preview = tileArt(
    seen ? artTileOf(tile) : { kind: 'empty', level: 0, terrain: terrainFor(tile.x, tile.y) },
    52
  );

  const body = h('div.stack', [
    h('div.wm-sheethead', [
      h('div.wm-sheetico', preview),
      h('div', [
        h('div.wm-sheettitle', tileTitle(tile)),
        h('div.tiny.muted', 'Sector ' + tile.x + ', ' + tile.y)
      ])
    ]),
    statGrid(rows)
  ]);

  const actions = [];
  if (seen && tile.type === 'npc') {
    actions.push({
      label: 'Attack', kind: 'danger',
      onClick: () => setTimeout(() => openComposer('attack', tile), 60)
    });
  }
  if (seen && (tile.type === 'res' || tile.type === 'ruins')) {
    actions.push({
      label: 'Gather', kind: 'ok',
      onClick: () => setTimeout(() => openComposer('gather', tile), 60)
    });
  }
  if (!seen) {
    actions.push({
      label: 'Scout', kind: 'primary',
      onClick: (m) => {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) markExplored(tile.x + dx, tile.y + dy);
        }
        save();
        invalidateTiles();
        scheduleDraw();
        m.close();
        const fresh = tileAt(tile.x, tile.y);
        toast('Recon complete: ' + tileTitle(fresh), 'info');
        setTimeout(() => openTileSheet(fresh), 80);
        return false;
      },
      close: false
    });
  }
  actions.push({ label: 'Center', kind: 'ghost', onClick: () => focusTile(tile.x, tile.y) });

  openModal({ title: 'Sector ' + tile.x + ',' + tile.y, body, actions, cls: 'wm-modal' });
}

function homeArmyMap() {
  const out = {};
  for (const k in S.army) {
    const n = availableOf(k);
    if (n > 0 && UNITS[k]) out[k] = n;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Battle report
// ---------------------------------------------------------------------------

function lossTotals(losses) {
  let dead = 0, wounded = 0, lost = 0;
  for (const k in losses) {
    const e = losses[k];
    if (!e) continue;
    dead += e.dead || 0;
    wounded += e.wounded || 0;
    lost += e.lost || 0;
  }
  return { dead, wounded, lost };
}

function lossRows(losses) {
  const out = [];
  for (const k in losses) {
    const e = losses[k];
    if (!e || !e.lost) continue;
    const u = UNITS[k];
    out.push(h('div.wm-lossrow', [
      h('span.wm-lossname', u ? u.name : k),
      h('span.mono.tiny', [
        h('span.bad', formatNum(e.dead) + ' dead'),
        '  ',
        h('span.dim', formatNum(e.wounded) + ' wounded')
      ])
    ]));
  }
  return out;
}

function plural(n, word) {
  const v = Math.max(0, Math.round(Number(n) || 0));
  return v + ' ' + word + (v === 1 ? '' : 's');
}

function countMap(map) {
  let n = 0;
  for (const k in map) n += Math.max(0, Math.floor(map[k]) || 0);
  return n;
}

/**
 * Show the modal battle report.
 * @param {object} payload the 'battle:result' payload ({win, report, tile, marchId})
 */
export function openBattleReport(payload) {
  const rep = payload && payload.report;
  if (!rep) return;
  // The player is usually the attacker, but a raid on the city puts them on the
  // defending side — every "mine / theirs" split below follows this.
  const side = payload.side === 'defender' ? 'defender' : 'attacker';
  const myLosses = (side === 'defender' ? rep.defenderLosses : rep.attackerLosses) || {};
  const theirLosses = (side === 'defender' ? rep.attackerLosses : rep.defenderLosses) || {};
  const win = payload.win !== undefined ? !!payload.win : rep.winner === side;
  const mine = lossTotals(myLosses);
  const theirs = lossTotals(theirLosses);
  const rounds = Array.isArray(rep.rounds) ? rep.rounds : [];

  const mineKey = side === 'defender' ? 'defender' : 'attacker';
  const theirsKey = side === 'defender' ? 'attacker' : 'defender';
  let prevA = countMap(rep[mineKey + 'Start'] || {});
  let prevD = countMap(rep[theirsKey + 'Start'] || {});
  const roundNodes = rounds.map((rd, i) => {
    const a = countMap(rd[mineKey + 'Remaining'] || {});
    const d = countMap(rd[theirsKey + 'Remaining'] || {});
    const aLost = Math.max(0, prevA - a);
    const dLost = Math.max(0, prevD - d);
    prevA = a; prevD = d;
    const evs = Array.isArray(rd.events) ? rd.events.length : 0;
    return h('div.wm-round', [
      h('span.wm-rn.mono', 'R' + (rd.n || i + 1)),
      h('span.tiny.bad', '-' + formatNum(aLost)),
      h('span.tiny.ok', '+' + formatNum(dLost)),
      h('span.tiny.muted.wm-rhp', 'HP ' + formatNum(rd[mineKey + 'Hp'] || 0) + ' / ' + formatNum(rd[theirsKey + 'Hp'] || 0)),
      evs ? h('span.tag.tag--accent.tiny', evs + ' skill' + (evs > 1 ? 's' : '')) : null
    ]);
  });

  const loot = rep.loot || null;
  const lootKeys = loot ? Object.keys(loot).filter((k) => (loot[k] || 0) > 0) : [];
  const lostMine = (rep.powerLost && rep.powerLost[side]) || 0;
  const lostTheirs = (rep.powerLost && rep.powerLost[side === 'defender' ? 'attacker' : 'defender']) || 0;
  const pd = lostTheirs - lostMine;

  const body = h('div.stack', [
    h('div.wm-verdict' + (win ? '.is-win' : '.is-loss'), [
      h('div.wm-vtitle', win ? 'VICTORY' : 'DEFEAT'),
      h('div.tiny.muted', (payload.tile ? 'Sector ' + payload.tile.x + ',' + payload.tile.y + ' · ' : '') +
        plural(rep.durationRounds || rounds.length, 'round') + ' · ' + (rep.reason || 'resolved'))
    ]),
    rep.summary ? h('p.tiny.dim.wm-summary', rep.summary) : null,
    statGrid([
      ['Lost', formatNum(mine.lost)],
      ['Killed', formatNum(theirs.lost)],
      ['Wounded', formatNum(mine.wounded)],
      ['Power Δ', (pd >= 0 ? '+' : '') + formatNum(pd)]
    ]),
    statGrid([
      ['Your power', formatNum((side === 'defender' ? rep.defenderStartPower : rep.attackerStartPower) || 0)],
      ['Enemy power', formatNum((side === 'defender' ? rep.attackerStartPower : rep.defenderStartPower) || 0)]
    ], 2),
    roundNodes.length ? h('div.wm-block2', [
      h('div.tiny.upper.muted', 'Round log'),
      h('div.wm-rounds', roundNodes)
    ]) : null,
    mine.lost ? h('div.wm-block2', [
      h('div.tiny.upper.muted', 'Casualties'),
      h('div.wm-losses', lossRows(myLosses))
    ]) : null,
    lootKeys.length ? h('div.wm-block2', [
      h('div.tiny.upper.muted', 'Spoils'),
      h('div.row.row--wrap', lootKeys.map((k) => h('span.tag', [
        icon(k, { size: 13, color: resColor(k) }),
        ' ' + formatNum(loot[k])
      ])))
    ]) : null
  ]);

  openModal({
    title: 'Battle Report',
    body,
    cls: 'wm-modal',
    actions: [{ label: 'Dismiss', kind: 'primary' }]
  });
}

// ---------------------------------------------------------------------------
// Pointer input: drag to pan, pinch/wheel to zoom, tap to open a tile.
// ---------------------------------------------------------------------------

const pointers = new Map();
let dragId = -1;
let dragInfo = null;
let pinch = null;

function zoomAround(px, py, nextZ) {
  const s0 = TILE * cam.z;
  const tx0 = refs.w / 2 - cam.cx * s0;
  const ty0 = refs.h / 2 - cam.cy * s0;
  const wx = (px - tx0) / s0;
  const wy = (py - ty0) / s0;
  cam.z = clamp(nextZ, MIN_Z, MAX_Z);
  const s1 = TILE * cam.z;
  cam.cx = (refs.w / 2 - (px - wx * s1)) / s1;
  cam.cy = (refs.h / 2 - (py - wy * s1)) / s1;
  invalidateTiles();
  scheduleDraw();
}

function wireInput(frame) {
  frame.addEventListener('pointerdown', (e) => {
    const r = frame.getBoundingClientRect();
    pointers.set(e.pointerId, { x: e.clientX - r.left, y: e.clientY - r.top });
    if (frame.setPointerCapture) {
      try { frame.setPointerCapture(e.pointerId); } catch (err) { /* not capturable */ }
    }
    if (pointers.size === 1) {
      dragId = e.pointerId;
      dragInfo = { moved: 0, t: Date.now() };
    } else if (pointers.size === 2) {
      const p = Array.from(pointers.values());
      pinch = { d: Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y), z: cam.z };
      dragId = -1;
    }
    e.preventDefault();
  });

  frame.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const r = frame.getBoundingClientRect();
    const prev = pointers.get(e.pointerId);
    const cur = { x: e.clientX - r.left, y: e.clientY - r.top };
    pointers.set(e.pointerId, cur);
    if (pointers.size >= 2 && pinch) {
      const p = Array.from(pointers.values());
      const d = Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y);
      if (d > 6 && pinch.d > 6) {
        zoomAround((p[0].x + p[1].x) / 2, (p[0].y + p[1].y) / 2, pinch.z * (d / pinch.d));
      }
      return;
    }
    if (dragId === e.pointerId && dragInfo) {
      const dx = cur.x - prev.x;
      const dy = cur.y - prev.y;
      dragInfo.moved += Math.abs(dx) + Math.abs(dy);
      const s = TILE * cam.z;
      cam.cx -= dx / s;
      cam.cy -= dy / s;
      scheduleDraw();
    }
  });

  frame.addEventListener('pointerup', (e) => {
    const r = frame.getBoundingClientRect();
    const info = dragId === e.pointerId ? dragInfo : null;
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinch = null;
    if (dragId === e.pointerId) {
      dragId = -1;
      dragInfo = null;
    }
    if (info && info.moved < 12 && Date.now() - info.t < 800) {
      const p = screenToTile(e.clientX - r.left, e.clientY - r.top);
      const t = tileAt(p.x, p.y);
      if (t) openTileSheet(t);
    }
  });

  frame.addEventListener('pointercancel', (e) => {
    pointers.delete(e.pointerId);
    pinch = null;
    dragId = -1;
    dragInfo = null;
  });

  frame.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = frame.getBoundingClientRect();
    zoomAround(e.clientX - r.left, e.clientY - r.top, cam.z * (e.deltaY < 0 ? 1.14 : 1 / 1.14));
  }, { passive: false });
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Render the world map screen.
 * @returns {HTMLElement}
 */
export function render() {
  ensureStyles();
  try {
    ensureMap();
  } catch (err) {
    console.warn('[map] ensureMap failed', err);
  }
  if (!cam.init) {
    const c = cityPos();
    cam.cx = c.x + 0.5;
    cam.cy = c.y + 0.5;
    cam.init = true;
  }
  invalidateTiles();
  symbolIds.clear();

  defsEl = svg('defs');
  const layer = svg('g.wm-lay');
  const marchLayer = svg('g.wm-marches');
  const svgEl = svg('svg.wm-svg', {
    viewBox: '0 0 320 320', width: '100%', height: '100%',
    'aria-label': 'World map'
  }, [defsEl, layer, marchLayer]);

  const frame = h('div.wm-frame', svgEl);
  const coord = h('div.wm-coord.tiny.mono');
  const strip = h('div.wm-strip');
  const slots = h('span.panel__sub');

  const zoomPad = h('div.wm-zoom', [
    h('button.wm-zbtn', { type: 'button', 'aria-label': 'Zoom in', onclick: () => zoomAround(refs.w / 2, refs.h / 2, cam.z * 1.3) }, '+'),
    h('button.wm-zbtn', { type: 'button', 'aria-label': 'Zoom out', onclick: () => zoomAround(refs.w / 2, refs.h / 2, cam.z / 1.3) }, '−'),
    h('button.wm-zbtn', {
      type: 'button', 'aria-label': 'Centre on base',
      onclick: () => { const c = cityPos(); focusTile(c.x, c.y, 1); }
    }, icon('hq', { size: 18 }))
  ]);

  const root = h('section.stack.wm', [
    h('section.panel', [
      h('div.panel__head', [h('h2.panel__title', 'Marches'), slots]),
      strip
    ]),
    h('div.wm-stage', [frame, zoomPad, coord]),
    h('div.wm-legend', [
      legendChip('#f0a500', 'Your base'),
      legendChip('#e5484d', 'Enemy camp'),
      legendChip('#4fd1c5', 'Resource node'),
      legendChip('#8b7b62', 'Ruins'),
      legendChip('#1b232e', 'Unscouted')
    ]),
    h('p.tiny.muted.wm-hint', 'Drag to pan, pinch or use +/− to zoom, tap a tile for orders.')
  ]);

  refs.root = root;
  refs.frame = frame;
  refs.svgEl = svgEl;
  refs.layer = layer;
  refs.marchLayer = marchLayer;
  refs.strip = strip;
  refs.slots = slots;
  refs.coord = coord;

  wireInput(frame);
  refreshMarches();
  setTimeout(() => {
    if (!root.isConnected) return;
    measure();
    draw();
  }, 0);
  startTicker();
  return root;
}

function legendChip(color, txt) {
  return h('span.wm-lg', [
    h('span.wm-lgdot', { style: { background: color } }),
    h('span.tiny', txt)
  ]);
}

let ticker = 0;
function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => {
    if (!refs.root || !refs.root.isConnected) return;
    tickCountdowns();
    drawMarches();
  }, 1000);
}

let resizeWired = false;
function wireResize() {
  if (resizeWired) return;
  resizeWired = true;
  const relayout = () => {
    if (!refs.root || !refs.root.isConnected) return;
    measure();
    invalidateTiles();
    scheduleDraw();
  };
  window.addEventListener('resize', relayout);
  window.addEventListener('orientationchange', relayout);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) relayout();
  });
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

on('march:arrived', (p) => {
  if (!refs.root || !refs.root.isConnected) return;
  invalidateTiles();
  refreshMarches();
  scheduleDraw();
  if (p && p.phase === 'home' && p.loot) {
    const parts = [];
    for (const k in p.loot) if (p.loot[k] > 0) parts.push(formatNum(p.loot[k]) + ' ' + k);
    if (parts.length) toast('March home: ' + parts.join(', '), 'ok');
  }
});

on('state:changed', (p) => {
  if (!refs.root || !refs.root.isConnected) return;
  const reason = p && p.reason;
  if (reason === 'map:generated') {
    invalidateTiles();
    symbolIds.clear();
    if (defsEl) clear(defsEl);
    scheduleDraw();
  }
  refreshMarches();
});

on('battle:result', (p) => {
  if (!p || !p.report) return;
  if (p.source !== 'worldmap' && p.source !== 'raid' && !p.marchId) return;
  invalidateTiles();
  scheduleDraw();
  openBattleReport(p);
});

// ---------------------------------------------------------------------------
// Styles — injected once (this module owns no file in css/).
// ---------------------------------------------------------------------------

const CSS = `
.wm .panel { margin-bottom:0; }
.wm-strip { display:flex; flex-direction:column; max-height:172px; overflow-y:auto; }
.wm-mrow { display:flex; align-items:center; gap:var(--sp-2); padding:6px var(--sp-3);
  border-bottom:1px solid var(--line-soft); }
.wm-mrow:last-child { border-bottom:0; }
.wm-mrow .btn { min-height:44px; }
.wm-mdot { width:10px; height:10px; border-radius:50%; flex:0 0 auto; }
.wm-minfo { flex:1 1 auto; min-width:0; }
.wm-mtitle { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wm-eta-lbl { font-size:12.5px; color:var(--text-dim); }
.wm-empty { padding:var(--sp-3); }
.wm-stage { position:relative; border:1px solid var(--line); border-radius:var(--r-md);
  overflow:hidden; background:#0a0e14; box-shadow:var(--shadow-1); }
.wm-frame { position:relative; width:100%; height:min(56vh, 520px); min-height:280px;
  touch-action:none; cursor:grab; user-select:none; -webkit-user-select:none; }
.wm-frame:active { cursor:grabbing; }
.wm-svg { display:block; width:100%; height:100%; }
.wm-eta { paint-order:stroke; stroke:rgba(0,0,0,.75); stroke-width:3px; stroke-linejoin:round; }
.wm-lbl { paint-order:stroke; stroke:rgba(0,0,0,.72); stroke-width:2.4px; stroke-linejoin:round;
  pointer-events:none; }
.wm-lay.is-far .wm-lbl { display:none; }
.wm-lay, .wm-marches { pointer-events:none; }
.wm-route { animation:wmdash 1s linear infinite; }
@keyframes wmdash { to { stroke-dashoffset:-12; } }
.wm-pulse { animation:wmpulse 2.2s ease-in-out infinite; }
@keyframes wmpulse { 0%,100% { opacity:.9; } 50% { opacity:.25; } }
.wm-zoom { position:absolute; right:8px; bottom:8px; display:flex; flex-direction:column; gap:6px; }
.wm-zbtn { width:44px; height:44px; border-radius:var(--r-md); border:1px solid var(--line);
  background:rgba(22,28,38,.92); color:var(--text); font-size:20px; font-weight:700;
  display:flex; align-items:center; justify-content:center; cursor:pointer; }
.wm-zbtn:active { background:var(--panel-3); }
.wm-coord { position:absolute; left:8px; top:8px; padding:4px 9px; border-radius:var(--r-pill);
  background:rgba(8,11,16,.75); color:var(--text-dim); pointer-events:none; }
.wm-legend { display:flex; flex-wrap:wrap; gap:var(--sp-2) var(--sp-3); padding:0 2px; }
.wm-lg { display:inline-flex; align-items:center; gap:6px; color:var(--muted); }
.wm-lgdot { width:10px; height:10px; border-radius:2px; border:1px solid rgba(255,255,255,.12); }
.wm-hint { margin:0; }
.wm-sheethead { display:flex; align-items:center; gap:var(--sp-3); }
.wm-sheetico { width:52px; height:52px; flex:0 0 auto; border-radius:var(--r-sm); overflow:hidden;
  background:#0a0e14; }
.wm-mini { display:block; }
.wm-sheettitle { font-size:15px; font-weight:700; }
.wm-sumgrid { display:grid; grid-template-columns:repeat(2, minmax(0,1fr)); gap:var(--sp-2); }
.wm-sumcell { background:var(--panel-2); border:1px solid var(--line-soft);
  border-radius:var(--r-sm); padding:7px 10px; }
.wm-sumval { font-size:14px; font-weight:700; font-variant-numeric:tabular-nums; }
.wm-units { display:flex; flex-direction:column; max-height:236px; overflow-y:auto;
  border:1px solid var(--line-soft); border-radius:var(--r-sm); }
.wm-urow { display:flex; align-items:center; gap:5px; padding:5px 7px;
  border-bottom:1px solid var(--line-soft); }
.wm-urow:last-child { border-bottom:0; }
.wm-urow .btn { min-height:44px; }
.wm-udot { width:8px; height:8px; border-radius:50%; flex:0 0 auto; }
.wm-uinfo { flex:1 1 auto; min-width:0; }
.wm-uname { font-size:13px; font-weight:600; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.wm-step { width:44px; min-width:44px; height:44px; padding:0; font-size:19px; line-height:1; }
.wm-max { min-width:48px; }
.wm-num { width:58px; height:44px; text-align:center; padding:0 4px;
  font-family:var(--font-mono); font-variant-numeric:tabular-nums; }
.wm-offs { display:flex; gap:var(--sp-2); overflow-x:auto; padding-bottom:2px; }
.wm-off { flex:0 0 auto; display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:2px; min-width:66px; min-height:56px; padding:6px; border-radius:var(--r-sm);
  border:1px solid var(--line); background:var(--panel-2); color:var(--text-dim); cursor:pointer; }
.wm-off.is-on { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }
.wm-off__ini { font-weight:800; font-size:14px; }
.wm-off__nm { max-width:72px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.wm-nooff { padding:8px 2px; }
.wm-send { margin-top:2px; }
.wm-block2 { display:flex; flex-direction:column; gap:6px; }
.wm-block { width:100%; }
.wm-target { font-size:14px; }
.wm-summary { margin:0; }
.wm-verdict { border-radius:var(--r-md); padding:var(--sp-3); text-align:center;
  border:1px solid var(--line); background:var(--panel-2); }
.wm-verdict.is-win { border-color:rgba(53,194,106,.5); background:var(--ok-soft); }
.wm-verdict.is-loss { border-color:rgba(229,72,77,.5); background:var(--danger-soft); }
.wm-vtitle { font-size:18px; font-weight:800; letter-spacing:.16em; }
.wm-verdict.is-win .wm-vtitle { color:var(--ok); }
.wm-verdict.is-loss .wm-vtitle { color:var(--danger); }
.wm-rounds { max-height:198px; overflow-y:auto; border:1px solid var(--line-soft);
  border-radius:var(--r-sm); padding:4px 8px; }
.wm-round { display:flex; align-items:center; gap:8px; padding:4px 0;
  border-bottom:1px dashed var(--line-soft); }
.wm-round:last-child { border-bottom:0; }
.wm-rn { min-width:26px; color:var(--muted); font-size:11px; }
.wm-rhp { margin-left:auto; white-space:nowrap; }
.wm-losses { display:flex; flex-direction:column; }
.wm-lossrow { display:flex; justify-content:space-between; align-items:center; gap:8px;
  font-size:12.5px; padding:3px 0; border-bottom:1px dashed var(--line-soft); }
.wm-lossrow:last-child { border-bottom:0; }
.wm-lossname { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
@media (min-width:700px) {
  .wm-frame { height:min(62vh, 640px); }
  .wm-sumgrid { grid-template-columns:repeat(4, minmax(0,1fr)); }
  .wm-sumgrid--2 { grid-template-columns:repeat(2, minmax(0,1fr)); }
}
`;

let stylesDone = false;
function ensureStyles() {
  wireResize();
  if (stylesDone || document.getElementById('wm-style')) {
    stylesDone = true;
    return;
  }
  const st = document.createElement('style');
  st.id = 'wm-style';
  st.textContent = CSS;
  document.head.appendChild(st);
  stylesDone = true;
}

registerScreen('map', render);
