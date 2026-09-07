// js/ui/campaign.js — Campaign screen: the 20-stage operations path, a
// pre-battle staging sheet (unit selection + commander + win estimate), the
// battle itself via engine/combat.resolveBattle, an animated battle report and
// reward payout.
// Exports: renderCampaign

import { h, svg, clear, mount } from '../util/dom.js';
import { formatNum, formatTime, clamp, uid } from '../util/fmt.js';
import { registerScreen } from './registry.js';
import { toast, openModal, icon, resColor } from './shell.js';
import { S, addLog, markDirty, save } from '../engine/state.js';
import {
  CAMPAIGN, REPEAT, getStage, isStageUnlocked, stageReward, stageCooldownSec
} from '../data/campaign.js';
import { UNITS, CLASS_META, CLASSES } from '../data/units.js';
import { OFFICERS } from '../data/officers.js';
import { RES_ORDER } from '../data/balance.js';
import { resolveBattle, simulateBattle, makeForce, applyBattleResult, forcePower, forceCount } from '../engine/combat.js';
import { getAllBonuses } from '../engine/bonus.js';
import { grant } from '../engine/economy.js';
import * as Off from '../engine/officers.js';
import * as Train from '../engine/training.js';
import {
  injectStyle, bindLive, statChip, sectionCard, progressBar, unitArtNode, classColor
} from './army.js';
import { officerPortraitNode, rarityColor, starRow } from './officers.js';

const CSS = `
.path { position:relative; display:flex; flex-direction:column; gap:var(--sp-2); }
.path::before { content:''; position:absolute; left:21px; top:8px; bottom:8px; width:2px;
  background:linear-gradient(180deg, var(--line), transparent); }
.stage { position:relative; display:flex; gap:var(--sp-3); padding:var(--sp-3);
  background:var(--panel-2); border:1px solid var(--line); border-radius:var(--r-md);
  text-align:left; width:100%; cursor:pointer; }
.stage:active { transform:scale(.99); }
.stage.is-locked { opacity:.5; cursor:default; }
.stage.is-clear { border-color:rgba(53,194,106,.4); }
.tag--warn { background:var(--warn-soft); border-color:rgba(242,163,60,.4); color:var(--warn); }
.stage.is-cooling { opacity:.62; cursor:default; }
.stage.is-cooling .stage__no { border-color:var(--warn, #f0a500); color:var(--warn, #f0a500); }
.stage__no { width:30px; height:30px; flex:none; border-radius:50%; display:flex;
  align-items:center; justify-content:center; font-weight:800; font-size:13px;
  background:var(--panel-3); border:2px solid var(--line); z-index:1; }
.stage.is-clear .stage__no { background:var(--ok-soft); border-color:var(--ok); color:var(--ok); }
.stage.is-open .stage__no { border-color:var(--accent); color:var(--accent); }
.stage__main { flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:5px; }
.stage__name { font-size:14px; font-weight:700; }
.stage__desc { font-size:11.5px; color:var(--muted); }
.enemyrow { display:flex; flex-wrap:wrap; gap:4px; }
.enemychip { display:inline-flex; align-items:center; gap:3px; padding:2px 6px 2px 2px;
  border-radius:var(--r-pill); background:rgba(0,0,0,.28); border:1px solid var(--line-soft);
  font-size:11px; font-variant-numeric:tabular-nums; }
.pickrow { display:flex; align-items:center; flex-wrap:wrap; gap:var(--sp-2); padding:8px 0;
  border-bottom:1px solid var(--line-soft); }
.pickrow:last-child { border-bottom:0; }
.pickrow__main { flex:1 1 120px; min-width:0; }
.pickrow__ctl { display:flex; align-items:center; gap:5px; flex:none; margin-left:auto; }
.pickrow__step { width:44px; min-width:44px; height:44px; padding:0; font-size:19px; line-height:1; }
.pickrow__n { width:58px; height:44px; text-align:center; padding:0 4px;
  font-variant-numeric:tabular-nums; font-weight:700; }
.pickrow__slider { flex:1 1 100%; min-width:0; }
.pickrow__range {
  -webkit-appearance:none; appearance:none; display:block; width:100%; height:44px;
  background:transparent; margin:0; cursor:pointer;
}
.pickrow__range:focus { outline:none; }
.pickrow__range:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.pickrow__range::-webkit-slider-runnable-track { height:8px; border-radius:var(--r-pill);
  background:var(--panel-3); border:1px solid var(--line-soft); }
.pickrow__range::-webkit-slider-thumb { -webkit-appearance:none; appearance:none;
  width:26px; height:26px; margin-top:-10px; border-radius:50%;
  background:var(--accent); border:2px solid #21160a; box-shadow:0 1px 3px rgba(0,0,0,.5); }
.pickrow__range::-moz-range-track { height:8px; border-radius:var(--r-pill);
  background:var(--panel-3); border:1px solid var(--line-soft); }
.pickrow__range::-moz-range-thumb { width:26px; height:26px; border-radius:50%;
  background:var(--accent); border:2px solid #21160a; box-shadow:0 1px 3px rgba(0,0,0,.5); }
.offpick { display:flex; gap:var(--sp-2); overflow-x:auto; padding-bottom:4px; }
.offpick__i { flex:none; width:66px; text-align:center; border:2px solid var(--line);
  border-radius:var(--r-sm); padding:3px; background:var(--panel-2); cursor:pointer; }
.offpick__i.is-on { border-color:var(--accent); }
.repround { border-left:2px solid var(--line); padding:4px 0 4px var(--sp-3); margin-left:6px;
  animation:repin .28s ease forwards; }
@keyframes repin { from { opacity:0; transform:translateX(-6px); } to { opacity:1; transform:none; } }
.repround__h { font-size:11px; letter-spacing:.08em; text-transform:uppercase; color:var(--muted); }
.repev { font-size:12px; color:var(--text-dim); }
.repev.is-att { color:var(--accent); }
.repev.is-def { color:var(--info); }
.repbanner { text-align:center; padding:var(--sp-3); border-radius:var(--r-md); font-weight:800;
  letter-spacing:.1em; text-transform:uppercase; }
.repbanner.is-win { background:var(--ok-soft); color:var(--ok); border:1px solid rgba(53,194,106,.45); }
.repbanner.is-lose { background:var(--danger-soft); color:var(--danger); border:1px solid rgba(229,72,77,.45); }
@media (prefers-reduced-motion: reduce) { .repround { animation:none; } }
`;

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function armyPower() {
  return Train.totalArmyPower();
}

function enemyUnits(stage) {
  const out = {};
  for (let i = 0; i < stage.enemy.length; i++) {
    const e = stage.enemy[i];
    out[e.unitKey] = (out[e.unitKey] || 0) + e.count;
  }
  return out;
}

function enemyChips(stage, size) {
  return h('div.enemyrow', stage.enemy.map((e) => {
    const u = UNITS[e.unitKey];
    return h('span.enemychip', [
      unitArtNode(e.unitKey, size || 22),
      h('span', formatNum(e.count)),
      h('span.tiny.muted', u ? CLASS_META[u.cls].short : '')
    ]);
  }));
}

function rewardChips(rw) {
  const items = [];
  for (let i = 0; i < RES_ORDER.length; i++) {
    const r = RES_ORDER[i];
    const v = Math.round(Number(rw.res && rw.res[r]) || 0);
    if (v <= 0) continue;
    items.push(h('span.costpill', [icon(r, { size: 12, color: resColor(r) }), h('span.mono', formatNum(v))]));
  }
  if (rw.gold > 0) {
    items.push(h('span.costpill', [icon('gold', { size: 12, color: resColor('gold') }), h('span.mono', formatNum(rw.gold))]));
  }
  if (rw.frags) {
    const def = OFFICERS[rw.frags.officerKey];
    items.push(h('span.costpill', (def ? def.name : rw.frags.officerKey) + ' x' + rw.frags.n));
  }
  if (rw.officer && OFFICERS[rw.officer]) {
    items.push(h('span.costpill', { style: { color: 'var(--accent)' } }, 'Commander: ' + OFFICERS[rw.officer].name));
  }
  return h('div.costrow', items);
}

function isCleared(id) {
  const list = Array.isArray(S.campaign.cleared) ? S.campaign.cleared : [];
  return list.indexOf(id) !== -1;
}

function cooldownMap() {
  if (!S.campaign.cooldowns || typeof S.campaign.cooldowns !== 'object') S.campaign.cooldowns = {};
  return S.campaign.cooldowns;
}

/**
 * Seconds before `id` can be run again (0 when it is ready).
 * @param {number} id
 * @returns {number}
 */
function cooldownLeft(id) {
  const until = Number(cooldownMap()[id]) || 0;
  return Math.max(0, Math.ceil((until - Date.now()) / 1000));
}

/** Put a stage out of action for its cooldown and count the run. */
function startCooldown(id) {
  const sec = stageCooldownSec(id);
  cooldownMap()[id] = Date.now() + sec * 1000;
  if (!S.campaign.repeats || typeof S.campaign.repeats !== 'object') S.campaign.repeats = {};
  S.campaign.repeats[id] = (Math.floor(Number(S.campaign.repeats[id])) || 0) + 1;
}

/**
 * Record a stage clear. There is no campaign engine module, so the campaign
 * slice of the state is written here through state.js's own helpers.
 * @param {number} id
 */
function markCleared(id) {
  startCooldown(id);
  if (!Array.isArray(S.campaign.cleared)) S.campaign.cleared = [];
  if (S.campaign.cleared.indexOf(id) === -1) S.campaign.cleared.push(id);
  S.campaign.stage = Math.max(Math.floor(Number(S.campaign.stage) || 1), Math.min(CAMPAIGN.length, id + 1));
  markDirty();
  save(true);
}

function payReward(stage, first, leaderKey) {
  const rw = stageReward(stage.id, first);
  // Only the one-off first-clear purse ignores storage caps; repeat runs are
  // capped like every other income, so a full warehouse ends the farm.
  grant(Object.assign({}, rw.res, { gold: rw.gold || 0 }), { overflow: !!first });
  const lines = [];
  for (let i = 0; i < RES_ORDER.length; i++) {
    const r = RES_ORDER[i];
    if (rw.res[r] > 0) lines.push(formatNum(rw.res[r]) + ' ' + r);
  }
  if (rw.gold > 0) lines.push(rw.gold + ' gold');
  if (first && rw.frags && OFFICERS[rw.frags.officerKey]) {
    Off.addFragments(rw.frags.officerKey, rw.frags.n, true);
    lines.push(rw.frags.n + ' ' + OFFICERS[rw.frags.officerKey].name + ' fragments');
  }
  if (first && rw.officer && OFFICERS[rw.officer]) {
    const already = Off.isOwned(rw.officer);
    Off.ensureOfficer(rw.officer);
    if (!already) lines.push('Commander ' + OFFICERS[rw.officer].name + ' joins you');
  }
  if (first && rw.xp > 0) {
    const target = leaderKey && Off.isOwned(leaderKey)
      ? leaderKey
      : Off.officerInSlot(Off.GARRISON_SLOT);
    if (target) {
      Off.grantXp(target, rw.xp);
      lines.push(formatNum(rw.xp) + ' XP for ' + OFFICERS[target].name);
    }
  }
  addLog('campaign', 'Stage ' + stage.id + ' cleared: ' + lines.join(', ') + '.', { stage: stage.id });
  markDirty();
  save(true);
  return lines;
}

// ---------------------------------------------------------------------------
// Battle report
// ---------------------------------------------------------------------------

function lossList(losses) {
  const rows = [];
  for (const k in losses) {
    if (!Object.prototype.hasOwnProperty.call(losses, k)) continue;
    const u = UNITS[k];
    const l = losses[k];
    rows.push(h('div.pickrow', [
      h('div', { style: { width: '30px', flex: 'none' } }, unitArtNode(k, 30)),
      h('div.pickrow__main', [
        h('div.list__title', u ? u.name : k),
        h('div.list__sub', formatNum(l.dead) + ' destroyed · ' + formatNum(l.wounded) + ' wounded')
      ]),
      h('div.pickrow__n.bad', '-' + formatNum(l.lost))
    ]));
  }
  if (rows.length === 0) rows.push(h('div.tiny.muted', 'No losses.'));
  return h('div.stack', { style: { gap: '0' } }, rows);
}

function showReport(report, stage, onDone) {
  const won = report.winner === 'attacker';
  const roundsHost = h('div.stack', { style: { gap: '6px' } });
  const tailHost = h('div.stack');
  let timer = 0;
  let i = 0;
  let finished = false;

  // .stack has no overflow; the real scroll container is .modal__body, handed
  // back by openModal as handle.body. Without this the animated rounds (and the
  // losses/salvage tail) play out below the fold on a phone.
  function followBottom() {
    const sc = handle && handle.body;
    if (sc) sc.scrollTop = sc.scrollHeight;
  }

  const body = h('div.stack', [
    h('div.repbanner' + (won ? '.is-win' : '.is-lose'), won ? 'Victory' : (report.winner === 'draw' ? 'Stalemate' : 'Defeat')),
    h('div.grid.grid--3', [
      statChip('Rounds', String(report.durationRounds)),
      statChip('Enemy power', formatNum(report.defenderStartPower)),
      statChip('Your power', formatNum(report.attackerStartPower))
    ]),
    roundsHost,
    tailHost
  ]);

  function renderTail() {
    clear(tailHost);
    const lootItems = [];
    for (let r = 0; r < RES_ORDER.length; r++) {
      const k = RES_ORDER[r];
      if (report.loot && report.loot[k] > 0) {
        lootItems.push(h('span.costpill', [icon(k, { size: 12, color: resColor(k) }),
          h('span.mono', formatNum(report.loot[k]))]));
      }
    }
    mount([
      h('div.sep'),
      h('h4.upper.small.muted', 'Your losses'),
      lossList(report.attackerLosses),
      h('h4.upper.small.muted', 'Enemy losses'),
      lossList(report.defenderLosses),
      lootItems.length ? h('h4.upper.small.muted', 'Salvage') : null,
      lootItems.length ? h('div.costrow', lootItems) : null,
      h('div.tiny.muted', 'Power destroyed: ' + formatNum(report.powerLost.defender)
        + ' · power lost: ' + formatNum(report.powerLost.attacker))
    ], tailHost);
  }

  function step() {
    if (i >= report.rounds.length) {
      finished = true;
      renderTail();
      followBottom();
      return;
    }
    const r = report.rounds[i];
    i += 1;
    const evs = (r.events || []).filter((e) => e && e.text);
    roundsHost.appendChild(h('div.repround', [
      h('div.repround__h', 'Round ' + r.n),
      h('div.stack', { style: { gap: '2px' } },
        evs.map((e) => h('div.repev' + (e.side === 'attacker' ? '.is-att' : e.side === 'defender' ? '.is-def' : ''),
          e.text)))
    ]));
    followBottom();
    timer = setTimeout(step, 620);
  }

  const handle = openModal({
    title: stage ? 'Stage ' + stage.id + ' — ' + stage.name : 'Battle Report',
    cls: 'modal--report',
    body,
    dismissible: false,
    onClose: () => {
      if (timer) clearTimeout(timer);
      if (typeof onDone === 'function') onDone();
    },
    actions: [
      {
        label: 'Skip',
        kind: 'ghost',
        close: false,
        onClick: () => {
          if (finished) return false;
          if (timer) clearTimeout(timer);
          while (i < report.rounds.length) {
            const r = report.rounds[i];
            i += 1;
            const evs = (r.events || []).filter((e) => e && e.text);
            roundsHost.appendChild(h('div.repround', [
              h('div.repround__h', 'Round ' + r.n),
              h('div.stack', { style: { gap: '2px' } },
                evs.map((e) => h('div.repev' + (e.side === 'attacker' ? '.is-att' : e.side === 'defender' ? '.is-def' : ''), e.text)))
            ]));
          }
          finished = true;
          renderTail();
          followBottom();
          return false;
        }
      },
      { label: 'Done', kind: 'primary' }
    ]
  });

  step();
  return handle;
}

// ---------------------------------------------------------------------------
// Pre-battle staging
// ---------------------------------------------------------------------------

function openStaging(stage, redraw) {
  const owned = Object.keys(S.army)
    .filter((k) => UNITS[k] && (Number(S.army[k].count) || 0) > 0)
    .sort((a, b) => {
      const ua = UNITS[a];
      const ub = UNITS[b];
      if (ua.cls !== ub.cls) return CLASSES.indexOf(ua.cls) - CLASSES.indexOf(ub.cls);
      return ub.tier - ua.tier;
    });

  const picked = {};
  for (let i = 0; i < owned.length; i++) picked[owned[i]] = Math.floor(Number(S.army[owned[i]].count) || 0);

  let leader = Off.officerInSlot(Off.GARRISON_SLOT) || null;
  const ownedOfficers = Off.ownedList({ ownedOnly: true });
  if (!leader && ownedOfficers.length) leader = ownedOfficers[0].key;

  const enemy = enemyUnits(stage);
  const estEl = h('div.stack', { style: { gap: '6px' } });
  // The Engage button lives in the modal's pinned footer (see `actions` below),
  // never at the bottom of the scrolling body where it would sit off-screen.
  let fightBtn = null;
  const rows = [];
  let estTimer = 0;

  function myForce() {
    return makeForce(picked, {
      officer: leader,
      officerStars: leader && S.officers.owned[leader] ? S.officers.owned[leader].stars : 1,
      bonuses: getAllBonuses(),
      name: S.player.name || 'Task Force'
    });
  }

  function enemyForce() {
    return makeForce(enemy, { name: stage.name, isDefender: true });
  }

  function setFightEnabled(on) {
    if (!fightBtn) return;
    fightBtn.disabled = !on;
    fightBtn.classList.toggle('is-disabled', !on);
  }

  function updateEstimate() {
    const total = forceCount(picked);
    clear(estEl);
    if (total <= 0) {
      mount(h('div.warnbox', [icon('warn', { size: 16 }), h('span', 'Select at least one unit.')]), estEl);
      setFightEnabled(false);
      return;
    }
    const sim = simulateBattle(myForce(), enemyForce(), {
      samples: 16, seed: 'campaign:' + stage.id, kind: 'campaign', label: stage.name
    });
    setFightEnabled(true);
    const good = sim.winRate >= 0.6;
    mount([
      h('div.grid.grid--3', [
        statChip('Your power', formatNum(forcePower(picked))),
        statChip('Enemy power', formatNum(stage.enemyPower)),
        statChip('Troops', formatNum(total))
      ]),
      h('div.row', [
        h('span.tag' + (good ? '.tag--ok' : '.tag--danger'), sim.verdict),
        h('span.tag', 'Win chance ' + Math.round(sim.winRate * 100) + '%'),
        h('span.tag', 'Est. losses ' + Math.round(sim.avgAttackerLoss * 100) + '%')
      ]),
      progressBar(sim.winRate, good ? 'bar--ok' : 'bar--danger')
    ], estEl);
  }

  function scheduleEstimate() {
    if (estTimer) clearTimeout(estTimer);
    estTimer = setTimeout(updateEstimate, 140);
  }

  for (let i = 0; i < owned.length; i++) {
    const key = owned[i];
    const u = UNITS[key];
    const have = Math.floor(Number(S.army[key].count) || 0);
    // Three ways in, all touch-sized: -/+ steppers (44px), a typed count and a
    // coarse slider. The slider alone is not an adequate touch target.
    const nEl = h('input.input.pickrow__n', {
      type: 'text', inputmode: 'numeric', value: String(picked[key]),
      'aria-label': u.name + ' count'
    });
    const range = h('input.pickrow__range', {
      type: 'range', min: '0', max: String(have), step: '1', value: String(picked[key]),
      'aria-label': u.name + ' slider'
    });
    // `silent` skips the estimate re-run so bulk Send all / Clear only sims once.
    const setCount = (v, silent) => {
      picked[key] = clamp(Math.floor(Number(v) || 0), 0, have);
      range.value = String(picked[key]);
      nEl.value = String(picked[key]);
      if (!silent) scheduleEstimate();
    };
    range.addEventListener('input', () => setCount(range.value));
    nEl.addEventListener('input', () => {
      const raw = nEl.value.replace(/[^0-9]/g, '');
      picked[key] = clamp(Math.floor(Number(raw) || 0), 0, have);
      range.value = String(picked[key]);
      scheduleEstimate();
    });
    nEl.addEventListener('blur', () => setCount(picked[key]));
    const bump = (dir) => {
      const cur = picked[key] || 0;
      const mag = cur >= 500 ? 100 : cur >= 100 ? 25 : cur >= 20 ? 5 : 1;
      setCount(cur + dir * mag);
    };
    rows.push(h('div.pickrow', [
      h('div', { style: { width: '34px', flex: 'none' } }, unitArtNode(key, 34)),
      h('div.pickrow__main', [
        h('div.list__title', { style: { color: classColor(u.cls) } }, u.name),
        h('div.tiny.muted', formatNum(have) + ' ready')
      ]),
      h('div.pickrow__ctl', [
        h('button.btn.btn--ghost.pickrow__step', {
          type: 'button', 'aria-label': 'Fewer ' + u.name, onclick: () => bump(-1)
        }, '\u2212'),
        nEl,
        h('button.btn.btn--ghost.pickrow__step', {
          type: 'button', 'aria-label': 'More ' + u.name, onclick: () => bump(1)
        }, '+')
      ]),
      h('div.pickrow__slider', range)
    ]));
    rows[rows.length - 1].setRange = (v) => setCount(v, true);
  }

  const offPick = h('div.offpick', [
    h('div.offpick__i' + (leader ? '' : '.is-on'), {
      role: 'button',
      tabindex: '0',
      onclick: () => {
        leader = null;
        syncOfficers();
        scheduleEstimate();
      }
    }, [
      svg('svg', { viewBox: '0 0 100 100', width: 58, height: 58, 'aria-hidden': 'true' },
        svg('path', { d: 'M20 80 L50 20 L80 80 Z', fill: '#1e2733' })),
      h('div.tiny.muted', 'No leader')
    ])
  ].concat(ownedOfficers.map((info) => h('div.offpick__i' + (leader === info.key ? '.is-on' : ''), {
    dataset: { off: info.key },
    role: 'button',
    tabindex: '0',
    onclick: () => {
      leader = info.key;
      syncOfficers();
      scheduleEstimate();
    }
  }, [
    officerPortraitNode(info.key, 58),
    h('div.tiny', { style: { color: rarityColor(info.rarity) } }, info.name.split(' ').slice(-1)[0]),
    starRow(info.stars, info.maxStars, 8)
  ]))));

  function syncOfficers() {
    const kids = offPick.children;
    for (let i = 0; i < kids.length; i++) {
      const k = kids[i].dataset ? kids[i].dataset.off : null;
      kids[i].classList.toggle('is-on', (k || null) === leader);
    }
  }

  const first = !isCleared(stage.id);
  const rw = stageReward(stage.id, first);

  const handle = openModal({
    title: 'Stage ' + stage.id + ' — ' + stage.name,
    cls: 'modal--staging',
    body: h('div.stack', [
      h('p.modal__text.small', stage.desc),
      h('h4.upper.small.muted', 'Enemy garrison'),
      enemyChips(stage, 26),
      h('h4.upper.small.muted', 'Rewards' + (first ? ' (first clear)' : '')),
      rewardChips(rw),
      h('div.sep'),
      h('h4.upper.small.muted', 'Commander'),
      offPick,
      h('h4.upper.small.muted', 'Task force'),
      h('div.btn-row', [
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            for (let i = 0; i < rows.length; i++) rows[i].setRange(Number.MAX_SAFE_INTEGER);
            updateEstimate();
          }
        }, 'Send all'),
        h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            for (let i = 0; i < rows.length; i++) rows[i].setRange(0);
            updateEstimate();
          }
        }, 'Clear')
      ]),
      rows.length ? h('div.stack', { style: { gap: '0' } }, rows)
        : h('div.warnbox', [icon('warn', { size: 16 }), h('span', 'You have no troops. Train some in the Army screen.')]),
      h('div.sep'),
      estEl
    ]),
    onClose: () => {
      if (estTimer) clearTimeout(estTimer);
    },
    actions: [
      { label: 'Withdraw', kind: 'ghost' },
      {
        label: 'Engage',
        kind: 'primary',
        close: false,
        ref: (btn) => { fightBtn = btn; },
        onClick: () => { engage(); }
      }
    ]
  });

  function engage() {
    if (forceCount(picked) <= 0) {
      toast('Select at least one unit.', 'warn');
      return;
    }
    const wait = cooldownLeft(stage.id);
    if (wait > 0) {
      toast('That sector is still being re-garrisoned — ' + formatTime(wait) + '.', 'warn');
      handle.close();
      redraw();
      return;
    }
    const report = resolveBattle(myForce(), enemyForce(), {
      seed: uid('battle') + ':' + stage.id,
      kind: 'campaign',
      label: 'Stage ' + stage.id + ' ' + stage.name
    });
    applyBattleResult(report, 'attacker', { removeFromArmy: true, hospital: true });
    handle.close();

    const wasFirst = !isCleared(stage.id);
    let lines = [];
    if (report.winner === 'attacker') {
      lines = payReward(stage, wasFirst, leader);
      markCleared(stage.id);
    }

    showReport(report, stage, () => {
      if (report.winner === 'attacker') {
        toast(lines.length ? 'Rewards: ' + lines.join(', ') : 'Stage cleared.', 'ok', 4200);
      } else {
        toast('The assault failed. Reinforce and try again.', 'danger', 3600);
      }
      redraw();
    });
  }

  updateEstimate();
  return handle;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

function stageCard(stage, redraw) {
  const cleared = isCleared(stage.id);
  const unlocked = isStageUnlocked(stage.id, S.campaign.cleared);
  const wait = cooldownLeft(stage.id);
  const power = armyPower();
  const strong = power >= stage.recommendedPower;
  const first = !cleared;
  const rw = stageReward(stage.id, first);
  const ready = unlocked && wait <= 0;

  const cls = '.stage' + (cleared ? '.is-clear' : unlocked ? '.is-open' : '.is-locked')
    + (wait > 0 ? '.is-cooling' : '');
  const card = h('button' + cls, {
    type: 'button',
    disabled: !ready,
    onclick: () => {
      if (!ready) return;
      openStaging(stage, redraw);
    }
  }, [
    h('div.stage__no', cleared
      ? icon('check', { size: 16, color: 'var(--ok)' })
      : String(stage.id)),
    h('div.stage__main', [
      h('div.row--between.row', [
        h('span.stage__name', stage.name),
        wait > 0
          ? h('span.tag.tag--warn.stage__cd', 'RE-ARMING ' + formatTime(wait))
          : h('span.tag' + (strong ? '.tag--ok' : '.tag--danger'),
            'PWR ' + formatNum(stage.recommendedPower))
      ]),
      h('div.stage__desc', unlocked
        ? (wait > 0
          ? 'The sector is being re-garrisoned. Available again in ' + formatTime(wait) + '.'
          : stage.desc)
        : 'Clear stage ' + (stage.id - 1) + ' to unlock.'),
      unlocked ? enemyChips(stage) : null,
      unlocked ? rewardChips(rw) : null,
      (unlocked && cleared)
        ? h('div.tiny.muted', 'Repeat clears pay ' + Math.round(REPEAT.share * 100)
          + '% of the listed purse, storage caps apply, and the sector locks for '
          + formatTime(stageCooldownSec(stage.id)) + '.')
        : null
    ])
  ]);
  if (wait > 0) card._cooldownStage = stage.id;
  return card;
}

/**
 * Render the Campaign screen.
 * @returns {HTMLElement}
 */
export function renderCampaign() {
  injectStyle('warpath-ui-campaign', CSS);
  const root = h('div.stack.screen-campaign');

  function redraw() {
    clear(root);
    const cleared = Array.isArray(S.campaign.cleared) ? S.campaign.cleared.length : 0;
    const nextId = Math.min(CAMPAIGN.length, cleared + 1);
    const next = getStage(nextId);

    mount([
      sectionCard('Operations', 'Twenty stages, one front line', [
        h('div.grid.grid--3', [
          statChip('Cleared', cleared + ' / ' + CAMPAIGN.length),
          statChip('Army power', formatNum(armyPower())),
          statChip('Next target', next ? formatNum(next.recommendedPower) : '—')
        ]),
        progressBar(cleared / CAMPAIGN.length, 'bar--ok'),
        h('div.tiny.muted', 'Battles use your standing army. Losses are permanent unless the '
          + 'Field Hospital has free beds — wounded troops can be treated there.')
      ]),
      h('section.panel', h('div.panel__body',
        h('div.path', CAMPAIGN.map((s) => stageCard(s, redraw)))))
    ], root);
  }

  redraw();
  bindLive(root, { events: ['state:changed', 'battle:result'], onEvent: redraw });

  // Cooldown labels count down in place; when one expires the list is rebuilt
  // so the stage becomes tappable again without a manual refresh.
  const tick = setInterval(() => {
    if (!root.isConnected) { clearInterval(tick); return; }
    const cards = root.querySelectorAll('.stage.is-cooling');
    let expired = false;
    for (let i = 0; i < cards.length; i++) {
      const id = cards[i]._cooldownStage;
      const left = cooldownLeft(id);
      if (left <= 0) { expired = true; continue; }
      const lbl = cards[i].querySelector('.stage__cd');
      if (lbl) lbl.textContent = 'RE-ARMING ' + formatTime(left);
    }
    if (expired) redraw();
  }, 1000);

  return root;
}

registerScreen('campaign', renderCampaign);
