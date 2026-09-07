// js/ui/settings.js — Settings screen: commander name, game speed, sound cues,
// save export / import, hard reset, career statistics, activity log and credits.
// Exports: renderSettings, playClick

import { h, clear, mount } from '../util/dom.js';
import { formatNum, formatTime, clamp } from '../util/fmt.js';
import { registerScreen } from './registry.js';
import { toast, confirmDialog, openModal, icon } from './shell.js';
import {
  S, SAVE_KEY, BACKUP_KEY, snapshot, saveNow, applySnapshot, hardReset, markDirty
} from '../engine/state.js';
import { OFFLINE_CAP_HOURS } from '../data/balance.js';
import { powerBreakdown } from '../engine/bonus.js';
import { totalTechLevels } from '../engine/research.js';
import * as Train from '../engine/training.js';
import { injectStyle, bindLive, statChip, sectionCard, progressBar } from './army.js';

const CSS = `
.seg { display:flex; gap:4px; background:var(--panel-3); border:1px solid var(--line);
  border-radius:var(--r-pill); padding:3px; }
.seg__b { flex:1 1 0; min-height:44px; border:0; background:transparent; color:var(--text-dim);
  border-radius:var(--r-pill); font-size:13px; font-weight:700; cursor:pointer; }
.seg__b.is-on { background:var(--accent); color:#151007; }
.ta { width:100%; min-height:120px; resize:vertical; padding:var(--sp-2); font-family:var(--font-mono);
  font-size:11.5px; color:var(--text); background:var(--panel-3); border:1px solid var(--line);
  border-radius:var(--r-sm); }
.logline { display:flex; gap:var(--sp-2); padding:5px 0; border-bottom:1px solid var(--line-soft);
  font-size:12px; }
.logline:last-child { border-bottom:0; }
.logline__t { flex:none; width:52px; color:var(--muted); font-variant-numeric:tabular-nums; font-size:11px; }
.logline__x { flex:1 1 auto; min-width:0; }
.credits { font-size:12px; color:var(--muted); line-height:1.6; }
`;

// ---------------------------------------------------------------------------
// Sound cues — a tiny WebAudio blip so the SFX switch actually does something.
// ---------------------------------------------------------------------------

let audioCtx = null;

/**
 * Play a short UI click (no-op when SFX are off or WebAudio is unavailable).
 * @param {number} [freq=440]
 */
export function playClick(freq) {
  if (!S.settings || S.settings.sfx === false) return;
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext;
    if (!Ctor) return;
    if (!audioCtx) audioCtx = new Ctor();
    if (audioCtx.state === 'suspended' && audioCtx.resume) audioCtx.resume();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq || 440, now);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.09, now + 0.012);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.16);
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.start(now);
    osc.stop(now + 0.18);
  } catch (err) {
    // audio is a nicety; never let it break the UI
  }
}

// ---------------------------------------------------------------------------
// Save transport
// ---------------------------------------------------------------------------

function saveText() {
  return JSON.stringify(snapshot(), null, 2);
}

function dataUri(text) {
  return 'data:application/json;charset=utf-8,' + encodeURIComponent(text);
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes());
}

/**
 * Legacy selection copy. Works without the async Clipboard API and is the
 * fallback whenever the modern write is unavailable or rejected.
 * @param {HTMLTextAreaElement} [area]
 * @returns {boolean} whether the copy actually happened
 */
function execCommandCopy(area) {
  if (!area || !document.execCommand) return false;
  try {
    area.focus();
    area.select();
    return document.execCommand('copy') === true;
  } catch (err) {
    console.warn('[settings] execCommand copy failed', err);
    return false;
  }
}

function reportCopy(done) {
  toast(done ? 'Save copied to the clipboard.' : 'Select the text and copy it manually.', done ? 'ok' : 'warn');
}

/**
 * Copy the save text, reporting only what actually happened.
 * navigator.clipboard.writeText() is async and rejects (NotAllowedError) when
 * the document is unfocused or the permission is denied, so its promise must be
 * settled before the toast fires — and the execCommand fallback has to run on
 * rejection, not be skipped by an assumed success.
 * @param {string} text
 * @param {HTMLTextAreaElement} [area]
 */
function copyText(text, area) {
  if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
    let promise = null;
    try {
      promise = navigator.clipboard.writeText(text);
    } catch (err) {
      // Some browsers throw synchronously instead of rejecting; fall through.
      console.warn('[settings] clipboard write threw', err);
      promise = null;
    }
    if (promise && typeof promise.then === 'function') {
      promise.then(
        () => reportCopy(true),
        (err) => {
          console.warn('[settings] clipboard write rejected', err);
          reportCopy(execCommandCopy(area));
        }
      );
      return;
    }
  }
  reportCopy(execCommandCopy(area));
}

function openExport() {
  const text = saveText();
  const area = h('textarea.ta', { readonly: true, spellcheck: 'false' }, text);
  openModal({
    title: 'Export save',
    body: h('div.stack', [
      h('p.modal__text.small', 'Your entire campaign as JSON (' + formatNum(text.length) + ' characters). '
        + 'Download the file or copy the text somewhere safe.'),
      h('a.btn.btn--primary.btn--block', {
        href: dataUri(text),
        download: 'warpath-save-' + stamp() + '.json'
      }, 'Download .json'),
      h('button.btn.btn--ghost.btn--block', {
        type: 'button',
        onclick: () => copyText(text, area)
      }, 'Copy to clipboard'),
      area
    ]),
    actions: [{ label: 'Close', kind: 'ghost' }]
  });
}

function openImport() {
  const area = h('textarea.ta', { spellcheck: 'false', placeholder: 'Paste an exported save here…' });
  const status = h('div.tiny.muted');
  openModal({
    title: 'Import save',
    body: h('div.stack', [
      h('div.warnbox', [icon('warn', { size: 16 }),
        h('span', 'Importing replaces your current campaign. Export it first if you want to keep it.')]),
      area,
      status
    ]),
    actions: [
      { label: 'Cancel', kind: 'ghost' },
      {
        label: 'Import',
        kind: 'primary',
        close: false,
        onClick: () => {
          const raw = String(area.value || '').trim();
          if (!raw) {
            status.textContent = 'Nothing pasted.';
            return false;
          }
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (err) {
            status.textContent = 'That is not valid JSON.';
            return false;
          }
          if (!data || typeof data !== 'object' || !data.player || !Array.isArray(data.buildings)) {
            status.textContent = 'That JSON is not a Warpath save (missing player / buildings).';
            return false;
          }
          applySnapshot(data);
          if (!saveNow()) {
            status.textContent = 'Imported into this session, but it could not be written to storage.';
            return false;
          }
          toast('Save imported — reloading.', 'ok');
          setTimeout(() => location.reload(), 500);
          return false;
        }
      }
    ]
  });
}

async function doHardReset() {
  const one = await confirmDialog('Wipe this campaign?',
    'Every building, technology, unit and commander is destroyed. This cannot be undone.',
    { okLabel: 'Continue', danger: true });
  if (!one) return;
  const two = await confirmDialog('Are you certain, Commander?',
    'Second and final confirmation. The save in "' + SAVE_KEY + '" will be deleted.',
    { okLabel: 'Delete everything', danger: true });
  if (!two) return;
  hardReset();
  toast('Campaign wiped. Starting over.', 'warn');
  setTimeout(() => location.reload(), 400);
}

// ---------------------------------------------------------------------------
// Panels
// ---------------------------------------------------------------------------

function profilePanel(redraw) {
  const input = h('input.input', {
    type: 'text', value: S.player.name || 'Commander', maxlength: '24',
    'aria-label': 'Commander name'
  });
  return sectionCard('Commander', 'Your callsign on every report', [
    h('label.field', [
      h('span.field__label', 'Name'),
      input
    ]),
    h('button.btn.btn--primary.btn--block', {
      type: 'button',
      onclick: () => {
        const name = String(input.value || '').trim().slice(0, 24);
        if (!name) {
          toast('A commander needs a name.', 'warn');
          return;
        }
        S.player.name = name;
        markDirty();
        const written = saveNow();
        playClick(660);
        toast(written ? 'Callsign set to ' + name + '.' : 'Callsign set, but it could not be saved.',
          written ? 'ok' : 'warn');
        redraw();
      }
    }, 'Save name')
  ]);
}

function segmented(values, current, onPick) {
  const seg = h('div.seg');
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    seg.appendChild(h('button.seg__b' + (v.value === current ? '.is-on' : ''), {
      type: 'button',
      onclick: () => onPick(v.value)
    }, v.label));
  }
  return seg;
}

function optionsPanel(redraw) {
  const sfxOn = S.settings.sfx !== false;
  const speed = clamp(Math.floor(Number(S.settings.speed) || 1), 1, 4);

  const sw = h('div.switch' + (sfxOn ? '.is-on' : ''), {
    role: 'switch',
    tabindex: '0',
    'aria-checked': sfxOn ? 'true' : 'false',
    onclick: () => {
      S.settings.sfx = !sfxOn;
      markDirty();
      saveNow();
      if (S.settings.sfx) playClick(880);
      redraw();
    }
  }, [h('span.switch__track'), h('span.switch__knob')]);

  return sectionCard('Options', 'Tuning for how the game runs', [
    h('div.list', [
      h('div.list__item', [
        h('div.list__main', [
          h('div.list__title', 'Sound cues'),
          h('div.list__sub', 'Short blips on confirmations and toggles.')
        ]),
        sw
      ])
    ]),
    h('h4.upper.small.muted', 'Game speed'),
    segmented([
      { value: 1, label: '1x' },
      { value: 2, label: '2x' },
      { value: 3, label: '3x' },
      { value: 4, label: '4x' }
    ], speed, (v) => {
      S.settings.speed = v;
      markDirty();
      const written = saveNow();
      playClick(520 + v * 60);
      toast(written ? 'Game speed set to ' + v + 'x.' : 'Speed set, but it could not be saved.',
        written ? 'ok' : 'warn');
      redraw();
    }),
    h('div.tiny.muted', 'Speed multiplies resource accrual and new construction jobs. '
      + 'Offline progress is credited for up to ' + OFFLINE_CAP_HOURS + ' hours away.')
  ]);
}

function statsPanel() {
  const p = powerBreakdown();
  const st = S.stats || {};
  const created = Number(S.created) || Date.now();
  const ageSec = Math.max(0, Math.floor((Date.now() - created) / 1000));
  const built = (Array.isArray(S.buildings) ? S.buildings : []).filter((b) => b && b.level > 0).length;
  const cleared = Array.isArray(S.campaign.cleared) ? S.campaign.cleared.length : 0;
  const officers = Object.keys((S.officers && S.officers.owned) || {}).length;
  const totalPower = Math.max(1, p.total);

  const bars = [
    { label: 'Buildings', v: p.buildings, c: '' },
    { label: 'Technology', v: p.tech, c: 'bar--ok' },
    { label: 'Army', v: p.army, c: 'bar--danger' },
    { label: 'Commanders', v: p.officers, c: 'bar--hp' }
  ];

  return sectionCard('Career', 'Since ' + new Date(created).toLocaleDateString(), [
    h('div.grid.grid--3', [
      statChip('Power', formatNum(p.total)),
      statChip('HQ', 'Lv.' + S.player.hqLevel),
      statChip('Age', formatTime(ageSec))
    ]),
    h('div.grid.grid--3', [
      statChip('Battles won', formatNum(st.battlesWon || 0)),
      statChip('Battles lost', formatNum(st.battlesLost || 0)),
      statChip('Stages', cleared + ' / 20')
    ]),
    h('div.grid.grid--3', [
      statChip('Units killed', formatNum(st.unitsKilled || 0)),
      statChip('Units lost', formatNum(st.unitsLost || 0)),
      statChip('Troops', formatNum(Train.armyCount(true)))
    ]),
    h('div.grid.grid--3', [
      statChip('Buildings', formatNum(built)),
      statChip('Tech levels', formatNum(totalTechLevels())),
      statChip('Commanders', formatNum(officers))
    ]),
    h('h4.upper.small.muted', 'Power breakdown'),
    h('div.stack', { style: { gap: '6px' } }, bars.map((b) => h('div.stack', { style: { gap: '2px' } }, [
      h('div.row--between.row', [
        h('span.tiny.muted', b.label),
        h('span.tiny.mono', formatNum(b.v))
      ]),
      progressBar(b.v / totalPower, b.c)
    ])))
  ]);
}

function logPanel() {
  const entries = (Array.isArray(S.log) ? S.log : []).slice(0, 40);
  const rows = entries.map((e) => {
    const d = new Date(Number(e.t) || Date.now());
    const p = (n) => (n < 10 ? '0' + n : String(n));
    return h('div.logline', [
      h('span.logline__t', p(d.getHours()) + ':' + p(d.getMinutes())),
      h('span.logline__x', String(e.text || ''))
    ]);
  });
  return sectionCard('Activity Log', entries.length + ' recent entries',
    rows.length ? h('div', rows) : h('p.muted.small', 'Nothing has happened yet.'));
}

/** The raw text of an unreadable save load() stashed, or '' when there is none. */
function backupText() {
  try {
    if (typeof localStorage === 'undefined') return '';
    return String(localStorage.getItem(BACKUP_KEY) || '');
  } catch (err) {
    return '';
  }
}

/**
 * Recovery row for a save load() could not read. It is the only way to reach
 * BACKUP_KEY from inside the game, so it only appears when there is one.
 * @param {Function} redraw
 */
function recoveryRow(redraw) {
  const raw = backupText();
  if (!raw) return null;
  const status = h('div.tiny.muted', 'A previous save could not be read and was kept aside ('
    + formatNum(raw.length) + ' characters). Download it before you try anything else.');
  return h('div.stack', [
    h('div.sep'),
    h('h4.upper.small.muted', 'Recover unreadable save'),
    h('a.btn.btn--ghost.btn--block', {
      href: dataUri(raw),
      download: 'warpath-unreadable-' + stamp() + '.json'
    }, 'Download .json'),
    h('div.btn-row', [
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => {
          let data = null;
          try {
            data = JSON.parse(raw);
          } catch (err) {
            status.textContent = 'The kept copy is not valid JSON, so it cannot be restored. '
              + 'Download it and keep it safe.';
            return;
          }
          if (!data || typeof data !== 'object' || !data.player || !Array.isArray(data.buildings)) {
            status.textContent = 'The kept copy is not a Warpath save (missing player / buildings).';
            return;
          }
          applySnapshot(data);
          if (!saveNow()) {
            status.textContent = 'Restored into this session, but it could not be written to storage.';
            return;
          }
          toast('Save recovered — reloading.', 'ok');
          setTimeout(() => location.reload(), 500);
        }
      }, 'Try to restore'),
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: async () => {
          const okDrop = await confirmDialog('Discard the kept copy?',
            'The unreadable save in "' + BACKUP_KEY + '" is deleted for good. Download it first if you want it.',
            { okLabel: 'Discard', danger: true });
          if (!okDrop) return;
          try {
            localStorage.removeItem(BACKUP_KEY);
          } catch (err) {
            console.warn('[settings] could not discard the backup', err);
          }
          toast('Kept copy discarded.', 'warn');
          redraw();
        }
      }, 'Discard backup')
    ]),
    status
  ]);
}

function dataPanel(redraw) {
  return sectionCard('Save Data', 'Stored locally in "' + SAVE_KEY + '"', [
    h('div.btn-row', [
      h('button.btn.btn--ghost', { type: 'button', onclick: openExport }, 'Export'),
      h('button.btn.btn--ghost', { type: 'button', onclick: openImport }, 'Import'),
      h('button.btn.btn--ghost', {
        type: 'button',
        onclick: () => {
          const written = saveNow();
          playClick(720);
          toast(written ? 'Progress saved.' : 'Could not write to storage — export your campaign.',
            written ? 'ok' : 'warn');
        }
      }, 'Save now')
    ]),
    recoveryRow(redraw),
    h('div.sep'),
    h('button.btn.btn--danger.btn--block', { type: 'button', onclick: doHardReset }, 'Wipe campaign'),
    h('div.tiny.muted', 'Everything runs offline in your browser. Clearing site data for this '
      + 'page also deletes the save, so export before you clean up.')
  ]);
}

function creditsPanel() {
  return sectionCard('Credits', 'Warpath Command', [
    h('p.credits', 'An offline, single-player homage to the mobile 4X strategy genre. '
      + 'Built as a static page: vanilla ES modules, no build step, no network requests, '
      + 'and every graphic on screen is inline SVG generated in JavaScript.'),
    h('p.credits', 'Counter triangle: armour beats infantry, infantry beats aircraft, '
      + 'aircraft beats armour. Artillery supports everything, fires last and dies fast.'),
    h('div.row', [
      h('span.tag', 'Vanilla JS'),
      h('span.tag', 'Inline SVG'),
      h('span.tag', 'localStorage'),
      h('span.tag', 'Offline first')
    ])
  ]);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Render the Settings screen.
 * @returns {HTMLElement}
 */
export function renderSettings() {
  injectStyle('warpath-ui-settings', CSS);
  const root = h('div.stack.screen-settings');

  function redraw() {
    clear(root);
    mount([
      profilePanel(redraw),
      optionsPanel(redraw),
      statsPanel(),
      dataPanel(redraw),
      logPanel(),
      creditsPanel()
    ], root);
  }

  redraw();
  // Only the stats/log blocks need refreshing; a full redraw would steal focus
  // from the name field, so it is driven by an explicit timer instead.
  bindLive(root, {
    tick: () => {
      const panels = root.querySelectorAll('.panel');
      if (panels.length < 5) return;
      const fresh = logPanel();
      root.replaceChild(fresh, panels[4]);
    },
    ms: 5000
  });
  return root;
}

registerScreen('settings', renderSettings);
