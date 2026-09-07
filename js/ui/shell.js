// js/ui/shell.js — app chrome: HUD, bottom nav, toasts, modals, inline SVG icon set.
// Exports: toast, openModal, closeModal, closeAllModals, confirmDialog, promptDialog,
//          hasOpenModal, renderHUD, updateHUD, openStoragePanel, renderNav, setActiveNav, icon,
//          ICON_KEYS, resColor

import { h, svg, clear, mount, qs } from '../util/dom.js';
import { formatNum, formatTime } from '../util/fmt.js';
import { on, emit } from '../util/events.js';
import { S, RES_KEYS } from '../engine/state.js';
import { SCREEN_ORDER, SCREEN_META } from './registry.js';
import { netRates, protectedAmount, timeToFull, speedMult } from '../engine/economy.js';

// ---------------------------------------------------------------------------
// Icons — every graphic in the game is inline SVG built here or in ui modules.
// ---------------------------------------------------------------------------

const PATHS = {
  // resources
  oil: 'M12 2c3.6 4.1 6 7.6 6 10.7A6 6 0 0 1 6 12.7C6 9.6 8.4 6.1 12 2Z',
  steel: 'M4 8h16l-2 4 2 4H4l2-4-2-4Z',
  rare: 'M12 2 4 9l8 13 8-13-8-7Zm0 3.2 5 4.3-5 8.1-5-8.1 5-4.3Z',
  food: 'M7 3c1.7 0 3 1.6 3 3.6V21H8V13H7c-1.7 0-3-1.4-3-3.3V3h1.5v6H7V3h1.5v6H10V3H7Zm10 0c2 0 3.5 2.3 3.5 5.2 0 2.4-1 4.3-2.5 4.9V21h-2V3Z',
  gold: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 3.2a6.8 6.8 0 1 1 0 13.6 6.8 6.8 0 0 1 0-13.6Zm.9 2.1h-1.8v1.1c-1.3.2-2.2 1-2.2 2.2 0 1.4 1 2 2.6 2.4 1.2.3 1.5.6 1.5 1.1 0 .5-.5.9-1.3.9-1 0-1.6-.4-1.7-1.2H8.2c.1 1.4 1 2.2 2.9 2.4v1.1h1.8v-1.1c1.5-.2 2.4-1.1 2.4-2.4 0-1.3-.8-2-2.6-2.4-1.2-.3-1.6-.6-1.6-1.1 0-.5.4-.8 1.2-.8.9 0 1.4.4 1.5 1.1h1.7c-.1-1.3-.9-2.1-2.6-2.3V7.3Z',
  // nav
  base: 'M3 21V10l9-7 9 7v11h-6v-6H9v6H3Z',
  map: 'M9 3 3 5.4V21l6-2.4 6 2.4 6-2.4V3l-6 2.4L9 3Zm0 2.3 6 2.4v11L9 16.3v-11Z',
  army: 'M12 2 4 5v6.2c0 5 3.4 9.4 8 10.8 4.6-1.4 8-5.8 8-10.8V5l-8-3Zm0 2.2 6 2.2v5c0 3.9-2.5 7.3-6 8.6-3.5-1.3-6-4.7-6-8.6v-5l6-2.2Zm-1 3.1v3.2H7.8v2.2H11v3.2h2v-3.2h3.2v-2.2H13V7.3h-2Z',
  research: 'M9 2v2h1v5.2L4.3 18.6A2.4 2.4 0 0 0 6.4 22h11.2a2.4 2.4 0 0 0 2.1-3.4L14 9.2V4h1V2H9Zm3 2h0v5.8l2.1 3.4h-4.2L12 9.8V4Zm-3.3 11h6.6l1.9 3.1c.2.4 0 .9-.5.9H7.3c-.5 0-.7-.5-.5-.9L8.7 15Z',
  officers: 'M12 2a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm0 2.2a2.3 2.3 0 1 1 0 4.6 2.3 2.3 0 0 1 0-4.6ZM4 21c0-4 3.6-7 8-7s8 3 8 7v1H4v-1Zm2.4-1.2h11.2C17.1 17.3 14.8 16 12 16s-5.1 1.3-5.6 3.8Z',
  campaign: 'M6 2v20l6-4 6 4V2H6Zm2.2 2.2h7.6v13.6L12 15.4l-3.8 2.4V4.2Z',
  settings: 'M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0 2a1.5 1.5 0 1 1 0 3 1.5 1.5 0 0 1 0-3ZM10.6 2l-.4 2.3-1.7 1-2.2-.8-1.4 2.4 1.7 1.5v2l-1.7 1.5 1.4 2.4 2.2-.8 1.7 1 .4 2.3h2.8l.4-2.3 1.7-1 2.2.8 1.4-2.4-1.7-1.5v-2l1.7-1.5-1.4-2.4-2.2.8-1.7-1L13.4 2h-2.8Z',
  // misc ui
  close: 'M5.3 4 4 5.3 10.7 12 4 18.7 5.3 20 12 13.3 18.7 20 20 18.7 13.3 12 20 5.3 18.7 4 12 10.7 5.3 4Z',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.2a7.8 7.8 0 1 1 0 15.6 7.8 7.8 0 0 1 0-15.6ZM11 6v7h6v-2h-4V6h-2Z',
  power: 'M13 2 4 14h6l-1 8 9-12h-6l1-8Z',
  check: 'M9.6 16.2 5.4 12l-1.4 1.4 5.6 5.6L20.4 8.2 19 6.8 9.6 16.2Z',
  plus: 'M11 5v6H5v2h6v6h2v-6h6v-2h-6V5h-2Z',
  hq: 'M3 21V9l9-6 9 6v12h-7v-5h-4v5H3Z',
  warn: 'M12 2 1 21h22L12 2Zm0 4.4L19.4 19H4.6L12 6.4ZM11 10v5h2v-5h-2Zm0 6v2h2v-2h-2Z',
  march: 'M2 12h14l-4-4 1.4-1.4L20 12l-6.6 5.4L12 16l4-4H2v0Z'
};

/** Every available icon key. */
export const ICON_KEYS = Object.keys(PATHS);

const RES_COLOR = {
  oil: '#8f7cff',
  steel: '#9fb3c8',
  rare: '#4fd1c5',
  food: '#7bd66a',
  gold: '#f0a500'
};

/** Themed colour for a resource key. */
export function resColor(key) {
  return RES_COLOR[key] || 'currentColor';
}

/**
 * Build an inline SVG icon.
 * @param {string} name key from ICON_KEYS
 * @param {{size?:number, color?:string, cls?:string}} [opts]
 * @returns {SVGElement}
 */
export function icon(name, opts) {
  const o = opts || {};
  const size = o.size || 22;
  const d = PATHS[name] || PATHS.warn;
  return svg('svg', {
    class: 'ico' + (o.cls ? ' ' + o.cls : ''),
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: o.color || 'currentColor',
    'aria-hidden': 'true',
    focusable: 'false'
  }, svg('path', { d }));
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------

function toastLayer() {
  let layer = qs('#toasts');
  if (!layer) {
    layer = h('div#toasts.toast-layer', { role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(layer);
  }
  return layer;
}

/**
 * Show a transient toast.
 * @param {string} msg
 * @param {'info'|'ok'|'warn'|'danger'} [kind='info']
 * @param {number} [ms=2600]
 */
export function toast(msg, kind = 'info', ms = 2600) {
  const layer = toastLayer();
  const node = h('div.toast.toast--' + kind, [
    h('span.toast__dot'),
    h('span.toast__msg', String(msg))
  ]);
  layer.appendChild(node);
  // Force a style flush so the CSS transition runs. (Deliberately not
  // requestAnimationFrame: rAF is paused in background tabs, which would leave
  // the toast invisible forever.)
  void node.offsetWidth;
  node.classList.add('is-in');
  const kill = () => {
    if (!node.parentNode) return;
    node.classList.remove('is-in');
    setTimeout(() => {
      if (node.parentNode) node.parentNode.removeChild(node);
    }, 220);
  };
  const timer = setTimeout(kill, Math.max(600, ms));
  node.addEventListener('click', () => {
    clearTimeout(timer);
    kill();
  });
  while (layer.children.length > 4) layer.removeChild(layer.firstChild);
  return node;
}

// Anything anywhere can `emit('toast', 'msg')` or `emit('toast', {msg, kind})`.
on('toast', (p) => {
  if (!p) return;
  if (typeof p === 'string') toast(p);
  else toast(p.msg || p.text || '', p.kind || 'info', p.ms);
});

// ---------------------------------------------------------------------------
// Modals
// ---------------------------------------------------------------------------

const openModals = [];

/**
 * Open a modal sheet. Closes on backdrop tap, the X button, or Escape.
 * Action entries may pass `ref`, a callback receiving the created button so the
 * caller can keep the pinned footer control live (enable/disable, label swaps).
 * @param {{title?:string, body?:Node|string|Array, actions?:Array<{label:string,kind?:string,onClick?:Function,close?:boolean,disabled?:boolean,ref?:Function}>, dismissible?:boolean, cls?:string, onClose?:Function}} cfg
 * @returns {{el:HTMLElement, close:()=>void}}
 */
export function openModal(cfg) {
  const c = cfg || {};
  const dismissible = c.dismissible !== false;

  const bodyNode = h('div.modal__body', c.body || '');
  const actionRow = h('div.modal__actions');

  const box = h('div.modal' + (c.cls ? '.' + c.cls : ''), {
    role: 'dialog',
    'aria-modal': 'true',
    onclick: (e) => e.stopPropagation()
  }, [
    h('div.modal__head', [
      h('h2.modal__title', c.title || ''),
      dismissible
        ? h('button.modal__x', { type: 'button', 'aria-label': 'Close', onclick: () => handle.close() }, icon('close', { size: 18 }))
        : null
    ]),
    bodyNode,
    actionRow
  ]);

  const backdrop = h('div.modal-backdrop', {
    onclick: () => {
      if (dismissible) handle.close();
    }
  }, box);

  const handle = {
    el: box,
    backdrop,
    body: bodyNode,
    close() {
      const i = openModals.indexOf(handle);
      if (i >= 0) openModals.splice(i, 1);
      backdrop.classList.remove('is-in');
      // The backdrop stays in the DOM for the fade-out; without this it keeps
      // hit-testing, so the second half of a double-tap re-fires the action.
      backdrop.style.pointerEvents = 'none';
      setTimeout(() => {
        if (backdrop.parentNode) backdrop.parentNode.removeChild(backdrop);
      }, 180);
      if (openModals.length === 0) document.body.classList.remove('modal-open');
      if (typeof c.onClose === 'function') c.onClose();
    },
    setBody(node) {
      clear(bodyNode);
      mount(node, bodyNode);
    }
  };

  const actions = Array.isArray(c.actions) ? c.actions : [];
  if (actions.length === 0) actionRow.remove();
  for (const a of actions) {
    if (!a) continue;
    const btn = h('button.btn' + (a.kind ? '.btn--' + a.kind : ''), {
      type: 'button',
      disabled: !!a.disabled,
      onclick: () => {
        let keepOpen = false;
        if (typeof a.onClick === 'function') keepOpen = a.onClick(handle) === false;
        if (a.close !== false && !keepOpen) handle.close();
      }
    }, a.label || 'OK');
    if (typeof a.ref === 'function') a.ref(btn);
    actionRow.appendChild(btn);
  }

  document.body.appendChild(backdrop);
  document.body.classList.add('modal-open');
  openModals.push(handle);
  void backdrop.offsetWidth;
  backdrop.classList.add('is-in');
  return handle;
}

/** Close the topmost modal. */
export function closeModal() {
  const top = openModals[openModals.length - 1];
  if (top) top.close();
}

/** True while at least one modal is on screen. */
export function hasOpenModal() {
  return openModals.length > 0;
}

/** Close every open modal. */
export function closeAllModals() {
  while (openModals.length) openModals[openModals.length - 1].close();
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && openModals.length) closeModal();
});

/**
 * Yes/no dialog.
 * @param {string} title
 * @param {string} msg
 * @param {{okLabel?:string, cancelLabel?:string, danger?:boolean}} [opts]
 * @returns {Promise<boolean>}
 */
export function confirmDialog(title, msg, opts) {
  const o = opts || {};
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    openModal({
      title: title || 'Confirm',
      body: h('p.modal__text', msg || ''),
      onClose: () => finish(false),
      actions: [
        { label: o.cancelLabel || 'Cancel', kind: 'ghost', onClick: () => finish(false) },
        { label: o.okLabel || 'Confirm', kind: o.danger ? 'danger' : 'primary', onClick: () => finish(true) }
      ]
    });
  });
}

/**
 * Single-line text prompt.
 * @param {string} title
 * @param {string} label
 * @param {string} [value]
 * @returns {Promise<string|null>}
 */
export function promptDialog(title, label, value) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    const input = h('input.input', { type: 'text', value: value || '', maxlength: '24' });
    openModal({
      title: title || '',
      body: h('label.field', [h('span.field__label', label || ''), input]),
      onClose: () => finish(null),
      actions: [
        { label: 'Cancel', kind: 'ghost', onClick: () => finish(null) },
        { label: 'Save', kind: 'primary', onClick: () => finish(input.value.trim()) }
      ]
    });
    setTimeout(() => input.focus(), 60);
  });
}

// ---------------------------------------------------------------------------
// HUD
// ---------------------------------------------------------------------------

const hudRefs = {
  root: null,
  chips: {},
  hq: null,
  power: null
};

const RES_LABEL = { oil: 'Oil', steel: 'Steel', rare: 'Rare Earth', food: 'Food', gold: 'Gold' };

// A chip is red at 100% but that is already too late, so warn from 85% up.
const NEAR_FULL = 0.85;

function resChip(key) {
  const val = h('span.chip__val', '0');
  const fill = key === 'gold' ? null : h('span.chip__fill');
  const node = h('button.chip.chip--' + key, {
    type: 'button',
    dataset: { res: key },
    'aria-label': RES_LABEL[key] || key,
    onclick: () => openStoragePanel()
  }, [
    icon(key, { size: 16, color: resColor(key) }),
    val,
    fill ? h('span.chip__meter', fill) : null
  ]);
  hudRefs.chips[key] = { node, val, fill };
  return node;
}

/**
 * Storage sheet: the touch-reachable way to read amount / cap / rate, since a
 * `title` tooltip never fires on a touch device.
 */
export function openStoragePanel() {
  const rates = netRates();
  const mult = speedMult();
  const prot = protectedAmount();
  const rows = RES_KEYS.map((key) => {
    const amount = S.res[key] || 0;
    const cap = S.cap[key] || 0;
    const ratio = cap > 0 ? amount / cap : 0;
    const rate = (rates[key] || 0) * mult;
    const full = cap > 0 && amount >= cap;
    const near = !full && ratio >= NEAR_FULL;
    const secs = timeToFull(key);
    let note;
    if (full) note = 'FULL — production is being lost';
    else if (rate < 0) note = formatNum(rate) + '/h — draining';
    else if (!(rate > 0)) note = 'No production';
    else if (Number.isFinite(secs)) note = '+' + formatNum(rate) + '/h — full in ' + formatTime(secs);
    else note = '+' + formatNum(rate) + '/h';
    return h('div.storrow' + (full ? '.is-full' : near ? '.is-near' : ''), [
      icon(key, { size: 18, color: resColor(key) }),
      h('div.storrow__main', [
        h('div.storrow__top', [
          h('span.storrow__name', RES_LABEL[key] || key),
          h('span.storrow__num', formatNum(amount) + ' / ' + formatNum(cap))
        ]),
        h('div.storrow__bar', h('i', {
          style: { width: Math.round(Math.min(1, ratio) * 100) + '%' }
        })),
        h('div.storrow__note', note)
      ])
    ]);
  });
  return openModal({
    title: 'Storage',
    body: h('div.stack', [
      h('div.stack', { style: { gap: '0' } }, rows),
      h('div.sep'),
      h('p.modal__text.small',
        'Warehouses protect ' + formatNum(prot) + ' of each resource from raids. ' +
        'Production stops once a stockpile is full — spend or expand storage before then.'),
      h('div.storrow', [
        icon('gold', { size: 18, color: resColor('gold') }),
        h('div.storrow__main', [
          h('div.storrow__top', [
            h('span.storrow__name', 'Gold'),
            h('span.storrow__num', formatNum(S.res.gold || 0))
          ]),
          h('div.storrow__note', 'Premium currency — never capped.')
        ])
      ])
    ]),
    actions: [{ label: 'Close', kind: 'ghost' }]
  });
}

/**
 * Build the top HUD into #hud and keep it live via events.
 * Safe to call more than once (it rebuilds).
 * @returns {HTMLElement|null}
 */
export function renderHUD() {
  const host = qs('#hud');
  if (!host) return null;
  hudRefs.chips = {};
  hudRefs.hq = h('span.hud__hqval', String(S.player.hqLevel));
  hudRefs.power = h('span.hud__powerval', '0');

  const root = h('div.hud__inner', [
    h('div.hud__idbar', [
      h('div.hud__hq', [icon('hq', { size: 16 }), h('span.hud__hqlbl', 'HQ'), hudRefs.hq]),
      h('div.hud__name', S.player.name),
      h('div.hud__power', [icon('power', { size: 15, color: 'var(--accent)' }), hudRefs.power])
    ]),
    h('div.hud__chips', [
      RES_KEYS.map(resChip),
      resChip('gold')
    ])
  ]);

  hudRefs.root = root;
  clear(host);
  host.appendChild(root);
  updateHUD();
  return root;
}

/** Refresh HUD numbers from S. */
export function updateHUD() {
  if (!hudRefs.root) return;
  for (const key in hudRefs.chips) {
    const ref = hudRefs.chips[key];
    const amount = S.res[key] || 0;
    ref.val.textContent = formatNum(amount);
    if (key !== 'gold') {
      const cap = S.cap[key] || 0;
      const ratio = cap > 0 ? amount / cap : 0;
      const full = cap > 0 && amount >= cap;
      const near = !full && ratio >= NEAR_FULL;
      ref.node.classList.toggle('is-full', full);
      ref.node.classList.toggle('is-near', near);
      const text = cap > 0 ? formatNum(amount) + ' / ' + formatNum(cap) : formatNum(amount);
      // Kept for desktop hover, but the tappable chip + storage sheet is the
      // real affordance: `title` never surfaces on touch.
      ref.node.title = text;
      ref.node.setAttribute('aria-label', (RES_LABEL[key] || key) + ' ' + text + '. Open storage details.');
      if (ref.fill) ref.fill.style.width = Math.round(Math.min(1, ratio) * 100) + '%';
    }
  }
  if (hudRefs.hq) hudRefs.hq.textContent = String(S.player.hqLevel);
  if (hudRefs.power) hudRefs.power.textContent = formatNum(S.player.power || 0);
}

on('res:changed', updateHUD);
on('state:changed', updateHUD);

// ---------------------------------------------------------------------------
// Bottom nav
// ---------------------------------------------------------------------------

const navRefs = { buttons: {} };

/**
 * Build the bottom navigation into #nav.
 * @returns {HTMLElement|null}
 */
export function renderNav() {
  const host = qs('#nav');
  if (!host) return null;
  navRefs.buttons = {};
  const inner = h('div.nav__inner');
  for (const name of SCREEN_ORDER) {
    const meta = SCREEN_META[name] || { label: name };
    const btn = h('a.nav__btn', {
      href: '#' + name,
      dataset: { screen: name },
      'aria-label': meta.title || meta.label
    }, [
      h('span.nav__ico', icon(name, { size: 22 })),
      h('span.nav__lbl', meta.label)
    ]);
    navRefs.buttons[name] = btn;
    inner.appendChild(btn);
  }
  clear(host);
  host.appendChild(inner);
  return inner;
}

/**
 * Mark one nav tab active.
 * @param {string} name
 */
export function setActiveNav(name) {
  for (const k in navRefs.buttons) {
    navRefs.buttons[k].classList.toggle('is-active', k === name);
  }
}

on('screen:change', (p) => {
  if (p && p.name) setActiveNav(p.name);
  // Modals are appended to <body>, not to #view, so the router's clear(#view)
  // does not take them down. Without this a sheet opened on one screen (the
  // recruit results, a battle report, a stage briefing) stays stacked on top of
  // the next screen and swallows its taps.
  closeAllModals();
});

/** Convenience re-export so ui modules can fire toasts without importing events. */
export function notify(msg, kind) {
  emit('toast', { msg, kind: kind || 'info' });
}
