// js/ui/army.js — Armed Forces screen: class tabs, unit roster, training dialog,
// live training queues, the field hospital and the army summary.
//
// This module ALSO hosts the small shared UI kit used by the other panel
// screens (research / officers / campaign / settings). It lives here rather
// than in a new module so those screens never import each other in a cycle:
// army.js imports nothing from its siblings.
//
// Exports: renderArmy,
//          injectStyle, bindLive, costRow, progressBar, statChip, sectionCard,
//          unitArt, unitArtNode, classColor

import { h, svg, clear, mount } from '../util/dom.js';
import { formatNum, formatTime, formatClock, roman, clamp } from '../util/fmt.js';
import { on } from '../util/events.js';
import { registerScreen } from './registry.js';
import { toast, openModal, confirmDialog, icon, resColor } from './shell.js';
import { S, levelOf } from '../engine/state.js';
import { RES_ORDER } from '../data/balance.js';
import { CLASSES, CLASS_META, UNITS, getUnit, trainCost } from '../data/units.js';
import { rect, poly, circ, path, ellipseShade, tierTint, PALETTE } from './svg-art.js';
import * as Train from '../engine/training.js';
import { netRates } from '../engine/economy.js';

// ---------------------------------------------------------------------------
// Shared kit
// ---------------------------------------------------------------------------

/**
 * Append a <style> block to <head> exactly once.
 * @param {string} id unique element id
 * @param {string} css
 */
export function injectStyle(id, css) {
  if (typeof document === 'undefined') return;
  if (document.getElementById(id)) return;
  const el = document.createElement('style');
  el.id = id;
  el.textContent = css;
  document.head.appendChild(el);
}

/**
 * Keep a screen alive: subscribe to events and/or run a timer, and tear both
 * down automatically as soon as the screen node leaves the document.
 * @param {Node} root the node returned by the screen renderer
 * @param {{events?:string[], onEvent?:Function, tick?:Function, ms?:number}} opts
 * @returns {() => void} manual stop
 */
export function bindLive(root, opts) {
  const o = opts || {};
  const unsubs = [];
  let timer = 0;
  let dead = false;
  const stop = () => {
    if (dead) return;
    dead = true;
    for (let i = 0; i < unsubs.length; i++) unsubs[i]();
    unsubs.length = 0;
    if (timer) {
      clearInterval(timer);
      timer = 0;
    }
  };
  const guard = (fn) => (payload) => {
    if (dead) return;
    if (!root || !root.isConnected) {
      stop();
      return;
    }
    try {
      fn(payload);
    } catch (err) {
      console.error('[ui] live handler failed', err);
    }
  };
  const events = Array.isArray(o.events) ? o.events : [];
  if (typeof o.onEvent === 'function') {
    for (let i = 0; i < events.length; i++) unsubs.push(on(events[i], guard(o.onEvent)));
  }
  if (typeof o.tick === 'function') {
    timer = setInterval(guard(o.tick), Math.max(200, o.ms || 1000));
  }
  return stop;
}

/**
 * A row of resource cost pills; pills the player cannot pay turn red.
 * @param {object} cost {oil,steel,rare,food,gold}
 * @param {{empty?:string}} [opts]
 * @returns {HTMLElement}
 */
export function costRow(cost, opts) {
  const o = opts || {};
  const items = [];
  const keys = RES_ORDER.concat(['gold']);
  for (let i = 0; i < keys.length; i++) {
    const r = keys[i];
    const v = Math.round(Number(cost && cost[r]) || 0);
    if (v <= 0) continue;
    const short = (Number(S.res[r]) || 0) < v;
    const pill = h('span.costpill' + (short ? '.is-short' : ''), [
      icon(r, { size: 13, color: resColor(r) }),
      h('span.mono', formatNum(v))
    ]);
    // Stashed so the screen's 500ms ticker can re-evaluate affordability in
    // place instead of rebuilding the DOM on every 'res:changed'.
    pill.costRef = { r, v };
    items.push(pill);
  }
  if (items.length === 0) items.push(h('span.muted.tiny', o.empty || 'No cost'));
  return h('div.costrow', items);
}

/**
 * A progress bar whose fill element is exposed as `node.fill`.
 * @param {number} pct 0..1
 * @param {string} [mod] extra class, e.g. 'bar--ok'
 * @returns {HTMLElement}
 */
export function progressBar(pct, mod) {
  const fill = h('i.bar__fill', { style: { width: (clamp(Number(pct) || 0, 0, 1) * 100).toFixed(1) + '%' } });
  const bar = h('div.bar' + (mod ? '.' + mod : ''), fill);
  bar.fill = fill;
  return bar;
}

/**
 * Label + value stat block.
 * @param {string} label
 * @param {string|Node} value
 * @param {string} [cls]
 */
export function statChip(label, value, cls) {
  return h('div.stat' + (cls ? '.' + cls : ''), [
    h('div.stat__label', label),
    h('div.stat__value', value)
  ]);
}

/**
 * Standard panel with a head and a body.
 * @param {string} title
 * @param {string|Node|null} sub
 * @param {*} body
 * @param {*} [headExtra]
 */
export function sectionCard(title, sub, body, headExtra) {
  return h('section.panel', [
    h('div.panel__head', [
      h('div', [
        h('h2.panel__title', title),
        sub ? h('div.panel__sub', sub) : null
      ]),
      headExtra || null
    ]),
    h('div.panel__body', body)
  ]);
}

/** Themed colour of a unit class. */
export function classColor(cls) {
  const m = CLASS_META[cls];
  return m ? m.color : 'var(--accent)';
}

// ---------------------------------------------------------------------------
// Unit artwork — flat inline SVG, drawn in a 100x100 box, tinted by tier.
// ---------------------------------------------------------------------------

function artInfantry(t) {
  return ellipseShade(50, 88, 24, 6, 0.32)
    + poly('42,62 48,62 47,88 41,88', t.dark)
    + poly('52,62 58,62 59,88 53,88', t.dark)
    + rect(40, 38, 20, 26, t.body)
    + rect(40, 46, 20, 5, t.trim)
    + poly('36,40 40,38 40,64 36,62', t.dark)
    + poly('60,38 65,42 63,64 60,62', t.dark)
    + circ(50, 30, 8.5, t.light)
    + path('M39 28 a11 11 0 0 1 22 0 l0 3 -22 0 z', t.body)
    + rect(36, 30, 28, 3.2, t.dark)
    + '<g transform="rotate(-26 60 50)">'
    + rect(44, 49, 40, 3.6, '#232a1c')
    + rect(76, 46, 9, 6, '#333c28')
    + '</g>';
}

function artTank(t) {
  return ellipseShade(50, 88, 34, 7, 0.32)
    + rect(14, 64, 72, 16, '#1b1f26', 'rx="8"')
    + circ(26, 72, 6.5, t.dark) + circ(40, 72, 6.5, t.dark)
    + circ(54, 72, 6.5, t.dark) + circ(68, 72, 6.5, t.dark)
    + circ(26, 72, 2.6, t.trim) + circ(40, 72, 2.6, t.trim)
    + circ(54, 72, 2.6, t.trim) + circ(68, 72, 2.6, t.trim)
    + poly('12,62 20,50 80,50 88,62', t.body)
    + rect(12, 58, 76, 5, t.light)
    + poly('34,48 40,38 66,38 72,48', t.body)
    + rect(38, 34, 22, 5, t.trim)
    + rect(68, 40, 28, 4.6, t.dark)
    + rect(92, 37.5, 6, 9.5, t.dark)
    + rect(22, 52, 12, 3, t.dark);
}

function artAircraft(t) {
  return ellipseShade(50, 88, 28, 6, 0.28)
    + poly('50,8 57,34 57,60 50,68 43,60 43,34', t.body)
    + poly('46,34 6,56 6,63 46,50', t.light)
    + poly('54,34 94,56 94,63 54,50', t.light)
    + poly('46,60 28,72 28,77 46,68', t.dark)
    + poly('54,60 72,72 72,77 54,68', t.dark)
    + poly('50,56 53.5,78 46.5,78', t.trim)
    + rect(20, 56, 10, 4, t.dark)
    + rect(70, 56, 10, 4, t.dark)
    + circ(50, 24, 5.4, PALETTE.glass)
    + circ(50, 24, 5.4, 'none', 'stroke="' + PALETTE.glassDk + '" stroke-width="1.6"');
}

function artArtillery(t) {
  return ellipseShade(50, 88, 32, 7, 0.3)
    + '<g transform="rotate(-30 48 54)">'
    + rect(46, 50, 48, 6, t.dark)
    + rect(88, 46.5, 9, 13, t.body)
    + '</g>'
    + poly('24,50 60,50 66,66 18,66', t.body)
    + rect(18, 58, 52, 7, t.light)
    + poly('24,64 10,86 19,86 33,66', t.dark)
    + poly('56,64 70,86 61,86 49,66', t.dark)
    + circ(32, 68, 11.5, '#1b1f26') + circ(32, 68, 5, t.trim)
    + circ(58, 68, 11.5, '#1b1f26') + circ(58, 68, 5, t.trim)
    + rect(26, 44, 20, 8, t.trim);
}

/**
 * Raw SVG markup (no outer <svg>) for a unit key, in a 100x100 box.
 * @param {string} unitKey
 * @returns {string}
 */
export function unitArt(unitKey) {
  const u = UNITS[unitKey];
  if (!u) return '';
  const t = tierTint(u.tier);
  if (u.cls === 'tank') return artTank(t);
  if (u.cls === 'aircraft') return artAircraft(t);
  if (u.cls === 'artillery') return artArtillery(t);
  return artInfantry(t);
}

/**
 * A ready-to-mount <svg> of a unit.
 * @param {string} unitKey
 * @param {number} [size=64]
 * @returns {SVGElement}
 */
export function unitArtNode(unitKey, size) {
  return svg('svg.uart', {
    viewBox: '0 0 100 100',
    width: size || 64,
    height: size || 64,
    'aria-hidden': 'true',
    html: unitArt(unitKey)
  });
}

// ---------------------------------------------------------------------------
// Styles
// ---------------------------------------------------------------------------

// NOTE: the shared bits that other screens depend on (screen width reset,
// .costrow/.costpill used by research.js via costRow(), and the coarse-pointer
// 44px touch-target floor) now live in css/style.css. They must NOT be
// JS-injected from here: this sheet is only injected by renderArmy(), so any
// rule kept here is missing until the player opens the Army screen.
const KIT_CSS = `
.uart { display:block; }
.ugrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(150px,1fr)); gap:var(--sp-2); }
.uc { position:relative; display:flex; flex-direction:column; gap:6px; padding:var(--sp-2);
  background:var(--panel-2); border:1px solid var(--line); border-radius:var(--r-md); cursor:pointer;
  min-height:44px; text-align:left; }
.uc:active { transform:scale(.985); }
.uc.is-locked { opacity:.62; }
.uc__top { display:flex; align-items:center; gap:var(--sp-2); }
.uc__art { position:relative; width:52px; height:52px; flex:none; border-radius:var(--r-sm);
  background:rgba(0,0,0,.25); }
.uc__own { position:absolute; right:-4px; bottom:-4px; min-width:22px; padding:1px 5px;
  border-radius:var(--r-pill); background:var(--panel-3); border:1px solid var(--line);
  font-size:10.5px; font-weight:800; font-variant-numeric:tabular-nums; text-align:center; }
.uc__id { flex:1 1 auto; min-width:0; overflow:hidden; }
.uc__name { font-size:13px; font-weight:700; line-height:1.15; }
.uc__tier { font-size:10px; letter-spacing:.06em; text-transform:uppercase; color:var(--muted);
  white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
.uc__stats { display:grid; grid-template-columns:repeat(4,1fr); gap:2px; font-size:10.5px; }
.uc__stat { text-align:center; background:rgba(0,0,0,.22); border-radius:4px; padding:2px 0; }
.uc__stat b { display:block; font-size:11.5px; font-variant-numeric:tabular-nums; }
.uc__lock { font-size:10.5px; color:var(--warn); }
.qrow { display:flex; flex-direction:column; gap:6px; padding:var(--sp-2) 0;
  border-bottom:1px solid var(--line-soft); }
.qrow:last-child { border-bottom:0; }
.qrow__head { display:flex; align-items:center; gap:var(--sp-2); }
.qrow__t { flex:1 1 auto; min-width:0; font-size:13px; font-weight:600; }
.qrow__time { font-size:12px; font-variant-numeric:tabular-nums; color:var(--text-dim); }
.qrow__btns { display:flex; gap:6px; }
.stepper { display:flex; align-items:center; gap:var(--sp-2); }
.stepper .btn { min-width:44px; }
.stepper__val { flex:1 1 auto; text-align:center; font-size:22px; font-weight:800;
  font-variant-numeric:tabular-nums; }
.stat.is-bad .stat__value { color:var(--danger); }
.warnbox { display:flex; gap:var(--sp-2); align-items:flex-start; padding:var(--sp-2);
  border-radius:var(--r-sm); background:var(--danger-soft); border:1px solid rgba(229,72,77,.4);
  color:var(--danger); font-size:12px; }
`;

// ---------------------------------------------------------------------------
// Army screen
// ---------------------------------------------------------------------------

let activeClass = 'infantry';

function nowMs() {
  return Date.now();
}

function unitCard(entry, group) {
  const u = entry.unit;
  const slot = S.army[u.key] || { count: 0, wounded: 0 };
  const owned = Math.max(0, Math.floor(Number(slot.count) || 0));
  const hurt = Math.max(0, Math.floor(Number(slot.wounded) || 0));

  const card = h('button.uc' + (entry.unlocked ? '' : '.is-locked'), {
    type: 'button',
    onclick: () => openTrainDialog(u.key)
  }, [
    h('div.uc__top', [
      h('div.uc__art', [
        unitArtNode(u.key, 52),
        h('span.uc__own', { title: formatNum(owned) + ' in service' }, formatNum(owned))
      ]),
      h('div.uc__id', [
        h('div.uc__name', u.name),
        h('div.uc__tier', CLASS_META[u.cls].short + ' · TIER ' + roman(u.tier)),
        hurt > 0 ? h('div.tiny.bad', formatNum(hurt) + ' wounded') : null
      ])
    ]),
    h('div.uc__stats', [
      h('div.uc__stat', [h('b', formatNum(u.atk)), 'ATK']),
      h('div.uc__stat', [h('b', formatNum(u.def)), 'DEF']),
      h('div.uc__stat', [h('b', formatNum(u.hp)), 'HP']),
      h('div.uc__stat', [h('b', formatNum(u.power)), 'PWR'])
    ]),
    entry.unlocked
      ? costRow(entry.cost)
      : h('div.uc__lock', [icon('warn', { size: 12 }), ' ' + entry.reason])
  ]);
  return card;
}

function classTabs(onPick) {
  const tabs = h('div.tabs');
  for (let i = 0; i < CLASSES.length; i++) {
    const cls = CLASSES[i];
    const meta = CLASS_META[cls];
    const btn = h('button.tab' + (cls === activeClass ? '.is-active' : ''), {
      type: 'button',
      onclick: () => {
        activeClass = cls;
        onPick();
      }
    }, meta.name);
    tabs.appendChild(btn);
  }
  return tabs;
}

function queueRow(entry, redraw) {
  const t = nowMs();
  const u = getUnit(entry.key);
  const name = u ? u.name : entry.key;
  const isHeal = entry.kind === Train.HEAL_KIND;
  const total = Math.max(1, Math.round((entry.endAt - entry.startAt) / 1000));
  const remain = Math.max(0, Math.ceil((entry.endAt - t) / 1000));
  const started = entry.startAt > 0 && entry.startAt <= t;
  const pct = started ? clamp(1 - remain / total, 0, 1) : 0;
  const gold = Train.speedUpCost(entry.id, t);

  const bar = progressBar(pct, isHeal ? 'bar--ok' : '');
  const timeEl = h('span.qrow__time', started ? formatClock(remain) : 'Queued · ' + formatClock(total));

  const row = h('div.qrow', [
    h('div.qrow__head', [
      h('span.qrow__t', (isHeal ? 'Treating ' : '') + entry.count + ' x ' + name),
      timeEl
    ]),
    bar,
    h('div.qrow__btns', [
      started
        ? h('button.btn.btn--sm.btn--primary', {
          type: 'button',
          onclick: () => {
            const r = Train.speedUpTraining(entry.id, Date.now());
            if (!r.ok) toast(r.error || 'Cannot speed up.', 'warn');
            else if (r.gold > 0) toast('Finished for ' + r.gold + ' gold.', 'ok');
            redraw();
          }
        }, gold > 0 ? 'Rush · ' + gold + 'g' : 'Finish now')
        : null,
      h('button.btn.btn--sm.btn--ghost', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog(
            isHeal ? 'Abort treatment?' : 'Cancel batch?',
            isHeal
              ? 'The wounded return to their beds and half the supplies are recovered.'
              : 'Half the materials are recovered.',
            { okLabel: 'Confirm', danger: true }
          );
          if (!ok) return;
          const r = isHeal ? Train.cancelHeal(entry.id, Date.now()) : Train.cancelTraining(entry.id, Date.now());
          if (!r.ok) toast(r.error || 'Nothing to cancel.', 'warn');
          redraw();
        }
      }, 'Cancel')
    ])
  ]);
  row.tickRefs = { entry, bar, timeEl, total };
  return row;
}

function openTrainDialog(unitKey) {
  const u = getUnit(unitKey);
  if (!u) return;
  const missing = Train.buildingForUnit(unitKey)
    ? Train.maxTrainable(unitKey)
    : { max: 0, byCap: 0, byRes: 0, limitedBy: 'capacity' };
  const buildingKey = Train.buildingForUnit(unitKey);
  const buildingLevel = levelOf(buildingKey || '');

  const check = Train.getTrainableUnits()
    .reduce((acc, g) => acc.concat(g.units), [])
    .filter((e) => e.key === unitKey)[0];

  if (check && !check.unlocked) {
    openModal({
      title: u.name,
      body: h('div.stack', [
        h('div.center', unitArtNode(unitKey, 110)),
        h('p.modal__text', u.desc),
        h('div.warnbox', [icon('warn', { size: 16 }), h('span', 'Locked — ' + check.reason)])
      ]),
      actions: [{ label: 'Close', kind: 'ghost' }]
    });
    return;
  }

  const cap = Math.max(0, Math.floor(missing.byCap));
  let count = Math.max(1, Math.min(missing.max > 0 ? missing.max : 1, 10));

  const valEl = h('div.stepper__val', String(count));
  const costEl = h('div');
  const timeEl = h('div.muted.small');
  const noteEl = h('div.tiny.muted');
  const trainBtn = h('button.btn.btn--primary.btn--block', { type: 'button' }, 'Train');

  function sync() {
    count = clamp(Math.floor(count), 1, Math.max(1, cap));
    valEl.textContent = String(count);
    const cost = trainCost(unitKey, count);
    clear(costEl);
    mount(costRow(cost), costEl);
    timeEl.textContent = 'Build time ' + formatTime(Train.trainDuration(unitKey, count));
    const affordable = Train.maxTrainable(unitKey).max >= count;
    noteEl.textContent = 'Batch limit ' + formatNum(cap) + ' · you can afford '
      + formatNum(Math.max(0, Math.min(cap, Train.maxTrainable(unitKey).byRes))) + '.';
    trainBtn.disabled = !affordable;
    trainBtn.classList.toggle('is-disabled', !affordable);
    trainBtn.textContent = affordable ? 'Train ' + formatNum(count) : 'Not enough resources';
  }

  const step = (d) => () => {
    count += d;
    sync();
  };

  const slot = S.army[unitKey] || { count: 0, wounded: 0 };

  const handle = openModal({
    title: u.name,
    cls: 'modal--train',
    body: h('div.stack', [
      h('div.row', [
        h('div', unitArtNode(unitKey, 84)),
        h('div.stack', { style: { gap: '4px' } }, [
          h('div.small.muted', CLASS_META[u.cls].name + ' · Tier ' + roman(u.tier)),
          h('div.small', u.desc),
          h('div.tiny.muted', (buildingKey ? CLASS_META[u.cls].name + ' line, ' : '')
            + 'facility level ' + buildingLevel)
        ])
      ]),
      h('div.grid.grid--4', [
        statChip('ATK', formatNum(u.atk)),
        statChip('DEF', formatNum(u.def)),
        statChip('HP', formatNum(u.hp)),
        statChip('LOAD', formatNum(u.load))
      ]),
      h('div.row', [
        h('span.tag', 'Beats ' + (CLASS_META[u.cls].beats ? CLASS_META[CLASS_META[u.cls].beats].name : 'nobody')),
        h('span.tag', 'Upkeep ' + u.upkeep + ' food/h'),
        h('span.tag.tag--lvl', 'Own ' + formatNum(slot.count || 0))
      ]),
      h('div.sep'),
      h('div.stepper', [
        h('button.btn.btn--ghost', { type: 'button', onclick: step(-10) }, '−10'),
        h('button.btn.btn--ghost', { type: 'button', onclick: step(-1) }, '−'),
        valEl,
        h('button.btn.btn--ghost', { type: 'button', onclick: step(1) }, '+'),
        h('button.btn.btn--ghost', { type: 'button', onclick: step(10) }, '+10')
      ]),
      h('div.btn-row', [
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            count = 1;
            sync();
          }
        }, 'Min'),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            count = Math.max(1, Train.maxTrainable(unitKey).max);
            sync();
          }
        }, 'Max affordable'),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            count = Math.max(1, cap);
            sync();
          }
        }, 'Full batch')
      ]),
      costEl,
      timeEl,
      noteEl,
      trainBtn,
      (slot.count || 0) > 0
        ? h('button.btn.btn--sm.btn--ghost.btn--block', {
          type: 'button',
          onclick: async () => {
            const ok = await confirmDialog('Stand down troops?',
              'Remove ' + formatNum(count) + ' x ' + u.name + ' from the roster. No refund.',
              { okLabel: 'Stand down', danger: true });
            if (!ok) return;
            const r = Train.disband(unitKey, count);
            if (!r.ok) toast(r.error || 'Nothing to stand down.', 'warn');
            else toast('Stood down ' + formatNum(r.removed) + ' units.', 'warn');
            handle.close();
          }
        }, 'Stand down ' + formatNum(count))
        : null
    ]),
    actions: [{ label: 'Close', kind: 'ghost' }]
  });

  let training = false;
  trainBtn.addEventListener('click', () => {
    // The closing modal is hit-testable for ~180ms, so a double-tap would queue
    // two batches and pay twice. Latch only on the path that actually closes.
    if (training) return;
    const r = Train.trainUnits(unitKey, count, Date.now());
    if (!r.ok) {
      toast(r.error || 'Cannot train.', 'warn');
      sync();
      return;
    }
    training = true;
    toast('Training ' + formatNum(count) + ' x ' + u.name + '.', 'ok');
    handle.close();
  });

  sync();
}

function hospitalPanel(redraw) {
  const level = levelOf('hospital');
  const cap = Train.woundedCapacity();
  const used = Train.totalWounded();
  const queue = Train.healQueue();

  if (level < 1) {
    return sectionCard('Field Hospital', 'Not built',
      h('p.muted.small', 'Without a Field Hospital every casualty is permanent. '
        + 'Build one from the base screen to recover wounded troops.'));
  }

  const wounded = Object.keys(S.army)
    .filter((k) => UNITS[k] && (Number(S.army[k].wounded) || 0) > 0)
    .sort((a, b) => UNITS[b].tier - UNITS[a].tier);

  const rows = wounded.map((k) => {
    const u = UNITS[k];
    const n = Math.floor(Number(S.army[k].wounded) || 0);
    return h('div.list__item', [
      h('div', { style: { width: '38px', flex: 'none' } }, unitArtNode(k, 38)),
      h('div.list__main', [
        h('div.list__title', u.name),
        h('div.list__sub', formatNum(n) + ' wounded · ' + formatTime(Train.healDuration(k, n)))
      ]),
      h('button.btn.btn--sm.btn--ok', {
        type: 'button',
        onclick: () => {
          const r = Train.heal(k, n, Date.now());
          if (!r.ok) toast(r.error || 'Cannot treat.', 'warn');
          redraw();
        }
      }, 'Treat')
    ]);
  });

  const body = [
    h('div.grid.grid--3', [
      statChip('Beds', formatNum(cap)),
      statChip('Occupied', formatNum(used)),
      statChip('Hospital', 'Lv.' + level)
    ]),
    progressBar(cap > 0 ? used / cap : 0, used >= cap && cap > 0 ? 'bar--danger' : 'bar--ok'),
    queue.length
      ? h('div.stack', queue.map((e) => queueRow(e, redraw)))
      : null,
    rows.length
      ? h('div.list', rows)
      : h('p.muted.small', 'No wounded in the beds. Keep it that way.')
  ];

  const healAll = rows.length
    ? h('button.btn.btn--sm.btn--ok', {
      type: 'button',
      onclick: () => {
        let sent = 0;
        for (let i = 0; i < wounded.length; i++) {
          const k = wounded[i];
          const n = Math.floor(Number(S.army[k].wounded) || 0);
          if (n <= 0) continue;
          const r = Train.heal(k, n, Date.now());
          if (r.ok) sent += 1;
          else if (sent === 0 && i === 0) toast(r.error || 'Cannot treat.', 'warn');
          if (Train.healQueue().length >= Train.SLOTS_PER_BUILDING) break;
        }
        if (sent > 0) toast(sent + ' treatment order' + (sent === 1 ? '' : 's') + ' placed.', 'ok');
        redraw();
      }
    }, 'Treat all')
    : null;

  return sectionCard('Field Hospital', 'Wounded recover instead of dying', body, healAll);
}

function summaryPanel() {
  const power = Train.totalArmyPower();
  const head = Train.armyCount(true);
  const upkeep = Train.armyUpkeep();
  const net = netRates();
  const deficit = net.food < 0;

  return sectionCard('Armed Forces', 'Standing army overview', [
    h('div.grid.grid--3', [
      statChip('Army power', formatNum(power)),
      statChip('Troops', formatNum(head)),
      statChip('Food upkeep', formatNum(upkeep) + '/h')
    ]),
    h('div.grid.grid--2', [
      statChip('Net food', (net.food >= 0 ? '+' : '') + formatNum(net.food) + '/h', deficit ? 'is-bad' : ''),
      statChip('Wounded', formatNum(Train.totalWounded()))
    ]),
    deficit
      ? h('div.warnbox', [
        icon('warn', { size: 16 }),
        h('span', 'Food deficit: ' + formatNum(-net.food) + '/h. When the larder empties your '
          + 'troops start to desert. Build farms or stand troops down.')
      ])
      : null
  ]);
}

/**
 * Render the Army screen.
 * @returns {HTMLElement}
 */
export function renderArmy() {
  injectStyle('warpath-ui-kit', KIT_CSS);

  const root = h('div.stack.screen-army');

  function redraw() {
    clear(root);
    const groups = Train.getTrainableUnits();
    const group = groups.filter((g) => g.cls === activeClass)[0] || groups[0];
    if (group) activeClass = group.cls;

    const lane = group ? Train.queueForBuilding(group.building) : [];

    mount([
      summaryPanel(),
      classTabs(redraw),
      group
        ? sectionCard(
          group.name,
          group.buildingName + ' Lv.' + group.buildingLevel + ' · batch limit '
            + formatNum(group.capacity),
          [
            lane.length
              ? h('div.stack', lane.map((e) => queueRow(e, redraw)))
              : h('p.muted.small', 'No batches in production.'),
            h('div.sep'),
            h('div.ugrid', group.units.map((entry) => unitCard(entry, group)))
          ]
        )
        : null,
      hospitalPanel(redraw)
    ], root);
  }

  redraw();

  bindLive(root, {
    // NOT 'res:changed': the loop emits it every second, and a full teardown
    // that often drops taps mid-gesture and resets the tab strip's scroll.
    // Affordability is patched in place by the ticker below instead.
    events: ['state:changed', 'train:done'],
    onEvent: redraw,
    tick: () => {
      const t = Date.now();
      const pills = root.querySelectorAll('.costpill');
      for (let i = 0; i < pills.length; i++) {
        const ref = pills[i].costRef;
        if (!ref) continue;
        pills[i].classList.toggle('is-short', (Number(S.res[ref.r]) || 0) < ref.v);
      }
      const rows = root.querySelectorAll('.qrow');
      for (let i = 0; i < rows.length; i++) {
        const refs = rows[i].tickRefs;
        if (!refs) continue;
        const remain = Math.max(0, Math.ceil((refs.entry.endAt - t) / 1000));
        const started = refs.entry.startAt > 0 && refs.entry.startAt <= t;
        refs.timeEl.textContent = started ? formatClock(remain) : 'Queued · ' + formatClock(refs.total);
        refs.bar.fill.style.width = (started ? clamp(1 - remain / refs.total, 0, 1) * 100 : 0).toFixed(1) + '%';
      }
    },
    ms: 500
  });

  return root;
}

registerScreen('army', renderArmy);
