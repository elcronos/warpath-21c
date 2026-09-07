// js/main.js — bootstrap, hash router, screen mounting.
// Exports: boot, navigate, currentScreen, renderCurrent, refresh
// NOTE: screens register themselves in js/ui/registry.js (registerScreen), never here,
// so ui modules never import main.js.

import { h, clear, qs, mount } from './util/dom.js';
import { emit, on } from './util/events.js';
import { formatNum, formatTime } from './util/fmt.js';
import { S, BACKUP_KEY, load, newGame, save, saveNow, touch } from './engine/state.js';
import { reconcileSlots } from './engine/officers.js';
import { LIVE_REPORT_MIN_MS } from './data/balance.js';
import { SCREEN_ORDER, SCREEN_META, getScreen, hasScreen } from './ui/registry.js';
import { renderHUD, renderNav, setActiveNav, icon, toast, openModal, hasOpenModal, resColor } from './ui/shell.js';

const DEFAULT_SCREEN = 'base';
let active = '';
let booted = false;
/** engine/loop.js once it has been dynamically imported (null before that). */
let loopModule = null;

/** @returns {string} the currently mounted screen name. */
export function currentScreen() {
  return active;
}

function screenFromHash() {
  const raw = (location.hash || '').replace(/^#\/?/, '').split('?')[0].trim();
  return SCREEN_ORDER.indexOf(raw) >= 0 ? raw : DEFAULT_SCREEN;
}

/**
 * Navigate to a screen (updates the hash, which drives the router).
 * @param {string} name
 */
export function navigate(name) {
  const target = SCREEN_ORDER.indexOf(name) >= 0 ? name : DEFAULT_SCREEN;
  if (screenFromHash() === target && active === target) {
    renderCurrent();
    return;
  }
  if (location.hash.replace(/^#\/?/, '') === target) route();
  else location.hash = '#' + target;
}

/** Placeholder shown when a screen module has not registered (yet). */
function pendingScreen(name) {
  const meta = SCREEN_META[name] || { title: name };
  return h('section.panel.panel--empty', [
    h('div.empty__ico', icon(name, { size: 44, color: 'var(--muted)' })),
    h('h2.empty__title', meta.title || name),
    h('p.empty__text', 'This sector is coming online.')
  ]);
}

/** Re-render whatever screen is currently active. */
export function renderCurrent() {
  const view = qs('#view');
  if (!view) return;
  const name = active || screenFromHash();
  let node;
  try {
    node = hasScreen(name) ? getScreen(name)() : pendingScreen(name);
  } catch (err) {
    console.error('[main] screen "' + name + '" failed to render', err);
    node = h('section.panel.panel--empty', [
      h('h2.empty__title', 'Render error'),
      h('p.empty__text', String((err && err.message) || err))
    ]);
  }
  clear(view);
  view.scrollTop = 0;            // harmless; keeps working if #view ever becomes a scroller
  mount(node, view);
  view.setAttribute('data-screen', name);
  window.scrollTo(0, 0);         // #view never overflows: html/body is the scroller
}

function route() {
  const name = screenFromHash();
  const changed = name !== active;
  active = name;
  document.body.setAttribute('data-screen', name);
  setActiveNav(name);
  renderCurrent();
  if (changed) emit('screen:change', { name });
}

/** Force a full chrome + screen refresh (used after loads/resets). */
export function refresh() {
  renderHUD();
  renderNav();
  setActiveNav(active || screenFromHash());
  renderCurrent();
}

/**
 * "Welcome back" report. engine/loop.js emits 'offline:summary' once, on the
 * first tick after a session gap; nothing else consumes it, so the bootstrap
 * owns this piece of app-level chrome.
 * @param {object} sum the offline catch-up summary
 */
function showOfflineReport(sum) {
  if (!sum || !sum.any) return;
  // A live catch-up is usually just a two-minute app switch. The resources are
  // already credited either way, so a short one only earns a toast — a modal
  // would land on top of whatever sheet the player left open.
  if (sum.live && sum.elapsedMs < LIVE_REPORT_MIN_MS) {
    emit('toast', {
      msg: 'Away ' + formatTime(sum.elapsedMs / 1000) + '.',
      kind: sum.starved > 0 ? 'bad' : 'ok',
      ms: 3200
    });
    return;
  }
  const rows = [];
  for (const k of ['oil', 'steel', 'rare', 'food', 'gold']) {
    const v = sum.gained[k];
    if (!v) continue;
    rows.push(h('div.offline__row', [
      h('span.offline__ico', icon(k, { size: 18, color: resColor(k) })),
      h('span.offline__name', k === 'rare' ? 'rare earth' : k),
      h('span.offline__val', {
        class: 'offline__val ' + (v < 0 ? 'is-neg' : 'is-pos')
      }, (v > 0 ? '+' : '') + formatNum(v))
    ]));
  }
  const body = h('div.offline', [
    h('p.offline__lead', 'Your base kept running for ' + formatTime(sum.elapsedMs / 1000) + '.'),
    rows.length ? h('div.offline__grid', rows) : h('p.empty__text', 'Nothing accumulated.'),
    sum.capped
      ? h('p.offline__note', 'Offline output is capped at ' + sum.capHours + ' hours.')
      : null,
    sum.starved > 0
      ? h('p.offline__note.is-bad', formatNum(sum.starved) + ' troops were lost to starvation — build more farms.')
      : null
  ]);
  // openModal stacks with no dedupe, so never drop this on top of a sheet the
  // player is already working in — the resources are credited either way.
  if (hasOpenModal()) {
    emit('toast', {
      msg: 'Away ' + formatTime(sum.elapsedMs / 1000) + ' — production credited.',
      kind: sum.starved > 0 ? 'bad' : 'ok',
      ms: 4200
    });
    return;
  }
  openModal({ title: 'Welcome back, Commander', body, actions: [{ label: 'Resume command', kind: 'primary' }] });
}

/**
 * Persist on the way out.
 *
 * S.t is the last-tick wall clock and the ONLY record of when the player was
 * last online; engine/loop.js reads it in runOfflineCatchUp(). startSystems()
 * is asynchronous (two dynamic imports before the loop even starts), so these
 * handlers can fire BEFORE the catch-up has run — a screen lock or an app
 * switch while the modules load. Stamping S.t to "now" in that window would
 * make the absence look like zero seconds and silently delete every hour of
 * offline progress, so the touch() is gated on the loop reporting that it has
 * caught up. Saving itself is always safe: it just re-commits the old stamp.
 */
function persistNow() {
  if (loopModule && typeof loopModule.hasCaughtUp === 'function' && loopModule.hasCaughtUp()) {
    touch(Date.now());
  }
  saveNow();
}

function wireLifecycle() {
  window.addEventListener('hashchange', route);

  on('offline:summary', showOfflineReport);

  window.addEventListener('beforeunload', persistNow);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') persistNow();
  });

  // Screens that mutate a lot of state can just emit 'state:changed'.
  on('state:changed', () => save());

  window.addEventListener('error', (e) => {
    console.error('[main] uncaught', e && e.error);
  });

  // 'error' does not fire for a rejected promise; without this, async failures
  // in timers/UI handlers vanish silently.
  window.addEventListener('unhandledrejection', (e) => {
    console.error('[main] unhandled rejection', e && e.reason);
  });
}

// ---------------------------------------------------------------------------
// Boot splash handshake. index.html installs __warpathBootReady /
// __warpathBootFailed (a classic, non-module script, so it runs even when the
// module graph does not) plus a watchdog timer. These two calls are the only
// way #boot is ever taken down, so both the success and the failure path have
// to go through them.
// ---------------------------------------------------------------------------

function dropSplash() {
  const splash = qs('#boot');
  if (splash && splash.parentNode) splash.parentNode.removeChild(splash);
}

function splashReady() {
  if (typeof window.__warpathBootReady === 'function') window.__warpathBootReady();
  else dropSplash();
}

function splashFailed(err) {
  console.error('[main] boot failed', err);
  const msg = String((err && err.message) || err || 'Unknown error');
  if (typeof window.__warpathBootFailed === 'function') window.__warpathBootFailed(msg);
  else dropSplash();
}

/** True when load() stashed an unreadable save we can still offer to recover. */
function hasUnreadableBackup() {
  try {
    return !!(typeof localStorage !== 'undefined' && localStorage.getItem(BACKUP_KEY));
  } catch (err) {
    return false;
  }
}

async function bootSequence() {
  const loaded = load();
  if (!loaded) {
    newGame({ seed: Date.now() });
    if (hasUnreadableBackup()) {
      toast('Previous save could not be read; a copy was kept — see Settings.', 'warn', 6000);
    } else {
      toast('New campaign started. Build your base, Commander.', 'ok', 3400);
    }
  }
  // Repair a save whose officer still holds the slot of a march that ended in
  // an earlier session; the loop keeps it reconciled from here on.
  reconcileSlots();

  renderHUD();
  renderNav();
  wireLifecycle();
  // Persist immediately so a fresh game survives a reload even if the player
  // closes the tab before the first autosave tick.
  //
  // Do NOT touch() here. S.t is the last-tick wall clock and it is the ONLY
  // record of when the player was last online; engine/loop.js reads it in
  // runOfflineCatchUp() to work out how long the game was closed. Stamping it
  // to "now" before startSystems() runs would make every session look like a
  // zero-second absence and silently delete all offline progress.
  // newGame() already stamps t itself, so a fresh save is still correct.
  saveNow();

  if (!location.hash) {
    active = DEFAULT_SCREEN;
    document.body.setAttribute('data-screen', DEFAULT_SCREEN);
    setActiveNav(DEFAULT_SCREEN);
    renderCurrent();
    emit('screen:change', { name: DEFAULT_SCREEN });
  } else {
    route();
  }

  await startSystems();
}

async function startSystems() {
  // These two modules are supplied by later feature work. Import them
  // defensively so the shell still boots (and says so) if either is absent.
  // Both requests are kicked off together — awaiting them in sequence adds a
  // whole extra round trip to the boot waterfall on a slow link — and each is
  // settled with its own .catch so one missing module still degrades gracefully.
  const uiJob = import('./ui/index.js').catch((err) => {
    console.warn('[main] ui/index.js not available yet', err);
    return null;
  });
  const loopJob = import('./engine/loop.js').catch((err) => {
    console.warn('[main] engine/loop.js not available yet', err);
    return null;
  });
  const [, mod] = await Promise.all([uiJob, loopJob]);
  if (mod) {
    loopModule = mod;
    if (typeof mod.startLoop === 'function') mod.startLoop();
    else console.warn('[main] engine/loop.js has no startLoop export');
  }
  // Screens registered during the import above may need a repaint.
  renderCurrent();
}

/**
 * Boot the game once. Idempotent.
 * Never rejects: a failure is reported on screen instead of leaving the opaque
 * #boot overlay in place with no explanation.
 */
export async function boot() {
  if (booted) return;
  booted = true;

  try {
    await bootSequence();
  } catch (err) {
    splashFailed(err);
    return;
  }

  splashReady();

  // Expose a tiny debug handle; harmless and very useful offline.
  window.WARPATH = { S, navigate, refresh, save, saveNow };
}

// The static module graph has executed, so the module layer is definitely
// alive. index.html swaps its short "did anything start?" watchdog for the
// longer "is it still downloading?" budget on this call.
if (typeof window.__warpathBootAlive === 'function') window.__warpathBootAlive();

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { boot().catch(splashFailed); }, { once: true });
} else {
  boot().catch(splashFailed);
}
