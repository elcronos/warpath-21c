// js/ui/officers.js — Officer Corps screen: roster grid with rarity frames and
// star pips, commander detail sheet (level-up, promotion, assignment), command
// slot board, and the gold recruitment banner with a draw-reveal animation.
// Exports: renderOfficers, officerPortrait, officerPortraitNode, rarityColor, starRow

import { h, svg, clear, mount } from '../util/dom.js';
import { formatNum, pct, clamp } from '../util/fmt.js';
import { registerScreen } from './registry.js';
import { toast, openModal, icon } from './shell.js';
import { S } from '../engine/state.js';
import { RARITY, OFFICERS, DRAW_COST, PITY_COUNT } from '../data/officers.js';
import { BONUS_META } from '../data/tech.js';
import { CLASS_META } from '../data/units.js';
import { rect, poly, circ, path, PALETTE } from './svg-art.js';
import * as Off from '../engine/officers.js';
import { injectStyle, bindLive, statChip, sectionCard, progressBar } from './army.js';

let activeTab = 'roster';

/**
 * The three nodes on the Recruit tab that depend on gold, so the gold-only
 * patcher can update them without a structural redraw. Null on the Roster tab.
 * @type {{val:HTMLElement, b1:HTMLElement, b10:HTMLElement}|null}
 */
let goldRefs = null;

const CSS = `
.offgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(104px,1fr)); gap:var(--sp-2); }
.offcard { position:relative; display:flex; flex-direction:column; gap:4px; padding:5px;
  border-radius:var(--r-md); border:2px solid var(--line); background:var(--panel-2);
  cursor:pointer; min-height:44px; text-align:center; }
.offcard:active { transform:scale(.98); }
.offcard.is-locked { opacity:.45; filter:saturate(.25); }
.offcard__art { width:100%; border-radius:var(--r-sm); overflow:hidden; background:#0c1017; }
.offcard__name { font-size:11.5px; font-weight:700; line-height:1.15; }
.offcard__rar { position:absolute; top:4px; left:4px; font-size:9px; font-weight:800;
  letter-spacing:.06em; padding:1px 5px; border-radius:var(--r-pill); background:rgba(0,0,0,.65); }
.offcard__lv { position:absolute; top:4px; right:4px; font-size:9.5px; font-weight:700;
  padding:1px 5px; border-radius:var(--r-pill); background:rgba(0,0,0,.65); color:var(--text-dim); }
.offcard__slot { position:absolute; bottom:26px; right:4px; font-size:9px; padding:1px 5px;
  border-radius:var(--r-pill); background:var(--accent); color:#151007; font-weight:800; }
.stars { display:flex; justify-content:center; gap:1px; }
.slotrow { display:flex; align-items:center; gap:var(--sp-2); padding:var(--sp-2) 0;
  border-bottom:1px solid var(--line-soft); }
.slotrow:last-child { border-bottom:0; }
.slotrow__art { width:44px; height:44px; flex:none; border-radius:var(--r-sm); overflow:hidden;
  background:#0c1017; border:1px solid var(--line); }
.slotrow__main { flex:1 1 auto; min-width:0; }
.drawgrid { display:grid; grid-template-columns:repeat(auto-fill, minmax(96px,1fr)); gap:var(--sp-2); }
.drawcard { border-radius:var(--r-md); border:2px solid var(--line); background:var(--panel-2);
  padding:5px; text-align:center; opacity:0; transform:translateY(10px) scale(.9);
  animation:offreveal .42s cubic-bezier(.2,.9,.3,1.3) forwards; }
@keyframes offreveal { to { opacity:1; transform:none; } }
@keyframes offglow { 0%,100% { box-shadow:0 0 0 0 rgba(240,165,0,0); }
  50% { box-shadow:0 0 14px 2px rgba(240,165,0,.55); } }
.drawcard.is-ssr { animation:offreveal .42s cubic-bezier(.2,.9,.3,1.3) forwards,
  offglow 1.6s ease-in-out 0.4s 3; }
.drawcard__tag { font-size:9.5px; font-weight:800; letter-spacing:.05em; }
.pity { display:flex; align-items:center; gap:var(--sp-2); font-size:12px; }
.pity .bar { flex:1 1 auto; }
@media (prefers-reduced-motion: reduce) {
  .drawcard { animation-duration:.01s; }
  .drawcard.is-ssr { animation:offreveal .01s forwards; }
}
`;

// ---------------------------------------------------------------------------
// Portraits — parametric flat SVG busts, deterministic per officer key.
// ---------------------------------------------------------------------------

const SKIN = ['#e9c6a1', '#dcac7e', '#c08a5e', '#96613e', '#6f4630'];
const SKIN_DK = ['#c9a077', '#b98a5f', '#9c6b45', '#74472c', '#523322'];
const HAIR = ['#241b14', '#4a382a', '#75603c', '#9aa0a6', '#141414'];

function hashKey(key) {
  let s = 0;
  const str = String(key);
  for (let i = 0; i < str.length; i++) s = (s * 31 + str.charCodeAt(i)) >>> 0;
  return s;
}

function ellipseStr(cx, cy, rx, ry, fill, extra) {
  return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry +
    '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
}

/**
 * Raw SVG markup (no outer <svg>) for a commander portrait, 100x100.
 * @param {string} key officer key
 * @returns {string}
 */
export function officerPortrait(key) {
  const def = OFFICERS[key];
  if (!def) return '';
  const hsh = hashKey(key);
  const rar = RARITY[def.rarity];
  const clsColor = (CLASS_META[def.cls] && CLASS_META[def.cls].color) || PALETTE.olive;
  // Headgear reads the commander's branch so the roster stays legible at a
  // glance; everything else varies with a hash of the key.
  const HEADGEAR_BY_CLASS = { infantry: 2, tank: 1, aircraft: 3, artillery: 0 };
  const skinIdx = (hsh >>> 5) % SKIN.length;
  const hairIdx = (hsh >>> 11) % HAIR.length;
  const headgear = HEADGEAR_BY_CLASS[def.cls] === undefined ? (hsh % 4) : HEADGEAR_BY_CLASS[def.cls];
  const facial = (hsh >>> 17) % 3;
  const visor = ((hsh >>> 21) & 1) === 1;
  const skin = SKIN[skinIdx];
  const skinDk = SKIN_DK[skinIdx];
  const hair = HAIR[hairIdx];

  let out = '';
  // backdrop
  out += rect(0, 0, 100, 100, '#0f151d');
  out += poly('0,100 0,58 50,32 100,58 100,100', '#151d28');
  out += circ(50, 44, 30, rar.color, 'opacity="0.13"');
  out += rect(0, 0, 100, 3, rar.color, 'opacity="0.85"');

  // shoulders + uniform
  out += poly('6,100 16,74 84,74 94,100', PALETTE.oliveDk);
  out += poly('6,100 16,74 34,74 26,100', PALETTE.olive);
  out += poly('94,100 84,74 66,74 74,100', PALETTE.olive);
  // collar + lapels
  out += poly('38,74 50,92 62,74 56,72 44,72', '#1b2229');
  out += poly('38,74 44,72 46,86 40,86', clsColor);
  out += poly('62,74 56,72 54,86 60,86', clsColor);
  // rank pips on the shoulder
  const pips = def.rarity === 'SSR' ? 3 : def.rarity === 'SR' ? 2 : 1;
  for (let i = 0; i < pips; i++) {
    out += circ(20 + i * 6, 80 + i * 1.6, 2, PALETTE.amber);
  }

  // neck + head
  out += rect(43, 58, 14, 18, skinDk);
  out += ellipseStr(50, 44, 17, 20, skin);
  out += ellipseStr(33.5, 46, 3.2, 4.4, skinDk);
  out += ellipseStr(66.5, 46, 3.2, 4.4, skinDk);

  // hair base
  out += path('M33 40 q4 -16 17 -16 q13 0 17 16 q-8 -6 -17 -6 q-9 0 -17 6 z', hair);

  // a beard is laid down first so the mouth still reads on top of it
  if (facial === 2) {
    out += path('M35 46 q2 18 15 18 q13 0 15 -18 q-4 7 -15 7 q-11 0 -15 -7 z', hair, 'opacity="0.85"');
  }

  // brows + eyes + mouth
  out += rect(39, 40, 8, 2, hair, 'rx="1"');
  out += rect(53, 40, 8, 2, hair, 'rx="1"');
  out += ellipseStr(43, 45, 2.6, 2.2, '#20252c');
  out += ellipseStr(57, 45, 2.6, 2.2, '#20252c');
  if (facial === 1) out += rect(44, 50.5, 12, 2.4, hair, 'rx="1.2"');
  out += rect(45, 55, 10, 1.8, facial === 2 ? '#3a2b20' : skinDk, 'rx="0.9"');

  // headgear
  if (headgear === 0) {
    // peaked cap
    out += path('M31 34 q0 -14 19 -14 q19 0 19 14 l0 3 -38 0 z', PALETTE.oliveDk);
    out += rect(29, 34, 42, 5, '#1b2229', 'rx="2"');
    out += path('M27 39 q23 9 46 0 l0 3 q-23 8 -46 0 z', '#121820');
    out += circ(50, 28, 4.2, PALETTE.amber);
    out += circ(50, 28, 1.8, PALETTE.crimson);
  } else if (headgear === 1) {
    // beret
    out += path('M30 34 q2 -16 21 -16 q17 0 18 14 q1 5 -5 5 z', clsColor);
    out += rect(30, 33, 40, 4, '#1b2229', 'rx="2"');
    out += circ(37, 27, 3.4, PALETTE.amber);
  } else if (headgear === 2) {
    // steel helmet
    out += path('M29 40 q0 -22 21 -22 q21 0 21 22 z', PALETTE.steelDk);
    out += path('M29 40 q0 -22 21 -22 q6 0 10 3 q-14 3 -14 19 z', PALETTE.steel);
    out += rect(27, 38, 46, 4, PALETTE.steelDk, 'rx="2"');
  } else {
    // flight helmet + headset (visor pushed up on the brow)
    out += path('M30 40 q0 -22 20 -22 q20 0 20 22 l0 2 -40 0 z', PALETTE.steelDk);
    out += path('M30 40 q0 -22 20 -22 q7 0 11 4 q-15 4 -15 20 z', PALETTE.steel);
    out += rect(26, 40, 9, 13, '#1b2229', 'rx="4"');
    out += rect(65, 40, 9, 13, '#1b2229', 'rx="4"');
    out += path('M67 52 q-4 9 -13 10', 'none', 'stroke="#1b2229" stroke-width="1.8" fill="none" stroke-linecap="round"');
    out += ellipseStr(53, 62, 4, 2.4, '#1b2229');
    if (visor) {
      out += rect(31, 30, 38, 6, PALETTE.glassDk, 'rx="3" opacity="0.95"');
      out += rect(33, 31.5, 12, 1.6, PALETTE.glass, 'rx="0.8" opacity="0.7"');
    }
  }

  return out;
}

/**
 * A ready-to-mount portrait <svg>.
 * @param {string} key
 * @param {number} [size=96]
 */
export function officerPortraitNode(key, size) {
  return svg('svg.offart', {
    viewBox: '0 0 100 100',
    width: size || 96,
    height: size || 96,
    'aria-hidden': 'true',
    style: { display: 'block', width: '100%', height: 'auto' },
    html: officerPortrait(key)
  });
}

/** Colour for a rarity code. */
export function rarityColor(rarity) {
  const r = RARITY[rarity];
  return r ? r.color : 'var(--line)';
}

const STAR_PATH = 'M12 2 14.9 8.6 22 9.3 16.7 14 18.2 21 12 17.4 5.8 21 7.3 14 2 9.3 9.1 8.6Z';

/**
 * A row of star pips.
 * @param {number} stars filled stars
 * @param {number} maxStars total pips
 * @param {number} [size=11]
 */
export function starRow(stars, maxStars, size) {
  const row = h('div.stars');
  const s = size || 11;
  for (let i = 0; i < maxStars; i++) {
    row.appendChild(svg('svg', {
      viewBox: '0 0 24 24', width: s, height: s, 'aria-hidden': 'true',
      fill: i < stars ? 'var(--accent)' : 'rgba(255,255,255,.16)'
    }, svg('path', { d: STAR_PATH })));
  }
  return row;
}

// ---------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------

function passiveRows(info) {
  const rows = [];
  for (const k in info.bonuses) {
    if (!Object.prototype.hasOwnProperty.call(info.bonuses, k)) continue;
    const meta = BONUS_META[k] || { label: k };
    rows.push(h('div.bonusrow', [
      h('span.bonusrow__k', meta.label),
      h('span.bonusrow__next', '+' + pct(info.bonuses[k]))
    ]));
  }
  if (rows.length === 0) rows.push(h('div.tiny.muted', 'Recruit this commander to activate their passives.'));
  return h('div.bonuslist', rows);
}

function slotLabel(slot) {
  if (!slot) return null;
  if (slot === Off.GARRISON_SLOT) return 'Garrison';
  if (slot.indexOf('march:') === 0) return 'March ' + slot.slice(6);
  return slot;
}

function openOfficerSheet(key, redraw) {
  const info = Off.officerInfo(key);
  if (!info) return;
  const color = rarityColor(info.rarity);
  const body = h('div.stack');

  const handle = openModal({ title: info.name, body, actions: [{ label: 'Close', kind: 'ghost' }] });

  function refresh() {
    const i = Off.officerInfo(key);
    clear(body);

    const xpNeed = i.xpToNext || 0;
    const promo = Off.canPromote(key);

    const marchSlots = (S.map && Array.isArray(S.map.marches) ? S.map.marches : [])
      .map((m) => ({ slot: Off.marchSlot(m.id), label: 'March ' + m.kind }));
    const slots = [{ slot: Off.GARRISON_SLOT, label: 'Garrison (base)' }].concat(marchSlots);

    mount([
      h('div.row', [
        h('div', { style: { width: '108px', flex: 'none', border: '2px solid ' + color, borderRadius: 'var(--r-md)', overflow: 'hidden' } },
          officerPortraitNode(key, 108)),
        h('div.stack', { style: { gap: '4px' } }, [
          h('div.row', [
            h('span.tag', { style: { color, borderColor: color } }, RARITY[i.rarity].name),
            h('span.tag', CLASS_META[i.cls] ? CLASS_META[i.cls].name : i.cls)
          ]),
          h('div.small.muted', i.title),
          i.owned ? starRow(i.stars, i.maxStars, 14) : null,
          h('div.small', i.owned ? 'Level ' + i.level + ' / ' + i.maxLevel : 'Not recruited'),
          i.owned ? h('div.tiny.muted', 'Power ' + formatNum(i.power)
            + (i.assigned ? ' · ' + slotLabel(i.assigned) : '')) : null
        ])
      ]),
      h('p.modal__text.small', i.desc),

      h('h4.upper.small.muted', 'Passives'),
      passiveRows(i),

      h('h4.upper.small.muted', 'Battle skill'),
      h('div.card', [
        h('div.card__title', i.skill.name),
        h('div.card__meta', i.skill.desc),
        h('div.tiny.muted', 'Triggers on ' + (i.skill.trigger === 'battleStart' ? 'battle start' : 'round start'))
      ]),

      i.owned ? h('div.sep') : null,

      i.owned && i.level < i.maxLevel ? h('div.stack', { style: { gap: '6px' } }, [
        h('h4.upper.small.muted', 'Training'),
        h('div.tiny.muted', 'XP ' + formatNum(i.xp) + ' / ' + formatNum(xpNeed)),
        progressBar(xpNeed > 0 ? clamp(i.xp / xpNeed, 0, 1) : 1),
        h('div.btn-row', [
          h('button.btn.btn--sm.btn--primary', {
            type: 'button',
            onclick: () => {
              const r = Off.levelUp(key, { gold: 50 });
              if (!r.ok) toast(r.reason, 'warn');
              refresh();
              redraw();
            }
          }, '50 gold'),
          h('button.btn.btn--sm.btn--primary', {
            type: 'button',
            onclick: () => {
              const r = Off.levelUp(key, { gold: 250 });
              if (!r.ok) toast(r.reason, 'warn');
              refresh();
              redraw();
            }
          }, '250 gold')
        ]),
        h('div.tiny.muted', Off.XP_PER_GOLD + ' XP per gold.')
      ]) : null,

      i.owned ? h('div.stack', { style: { gap: '6px' } }, [
        h('h4.upper.small.muted', 'Promotion'),
        h('div.tiny.muted', i.fragsToNextStar > 0
          ? 'Fragments ' + formatNum(i.fragments) + ' / ' + formatNum(i.fragsToNextStar)
          : 'Maximum stars reached — fragments held: ' + formatNum(i.fragments)),
        i.fragsToNextStar > 0
          ? progressBar(clamp(i.fragments / i.fragsToNextStar, 0, 1), 'bar--ok')
          : null,
        i.fragsToNextStar > 0
          ? h('button.btn.btn--sm.btn--ok.btn--block', {
            type: 'button',
            disabled: !promo.ok,
            onclick: () => {
              const r = Off.promoteStar(key);
              if (!r.ok) toast(r.reason, 'warn');
              refresh();
              redraw();
            }
          }, promo.ok ? 'Promote to ' + (i.stars + 1) + '★' : promo.reason)
          : null
      ]) : null,

      i.owned ? h('div.stack', { style: { gap: '6px' } }, [
        h('h4.upper.small.muted', 'Assignment'),
        h('div.btn-row', slots.map((s) => h('button.btn.btn--sm'
          + (i.assigned === s.slot ? '.btn--primary' : '.btn--ghost'), {
          type: 'button',
          onclick: () => {
            const r = i.assigned === s.slot ? Off.unassign(key) : Off.assign(key, s.slot);
            if (!r.ok) toast(r.reason, 'warn');
            refresh();
            redraw();
          }
        }, i.assigned === s.slot ? 'Recall from ' + s.label : s.label))),
        h('div.tiny.muted', 'Command slots used ' + Off.usedSlots() + ' / ' + Off.officerSlots()
          + '. Unassigned commanders still give ' + pct(Off.RESERVE_SHARE, 0) + ' of their passives.')
      ]) : h('div.warnbox', [
        icon('warn', { size: 16 }),
        h('span', 'Not on your staff yet. Recruit them from the Recruit tab or collect '
          + formatNum(i.fragments) + ' fragments through the campaign.')
      ])
    ], body);
  }

  refresh();
  return handle;
}

// ---------------------------------------------------------------------------
// Roster + slots
// ---------------------------------------------------------------------------

function officerCard(info, redraw) {
  const color = rarityColor(info.rarity);
  return h('button.offcard' + (info.owned ? '' : '.is-locked'), {
    type: 'button',
    style: { borderColor: info.owned ? color : 'var(--line)' },
    onclick: () => openOfficerSheet(info.key, redraw)
  }, [
    h('div.offcard__art', officerPortraitNode(info.key, 100)),
    h('span.offcard__rar', { style: { color } }, info.rarity),
    info.owned ? h('span.offcard__lv', 'L' + info.level) : null,
    info.owned && info.assigned ? h('span.offcard__slot', 'ON') : null,
    h('div.offcard__name', info.name),
    info.owned ? starRow(info.stars, info.maxStars, 10) : h('div.tiny.muted', 'Locked')
  ]);
}

function slotsPanel(redraw) {
  const total = Off.officerSlots();
  const map = Off.assignments();
  const marches = (S.map && Array.isArray(S.map.marches) ? S.map.marches : []);
  const entries = [{ slot: Off.GARRISON_SLOT, label: 'Garrison', desc: 'Bonuses apply at your base.' }]
    .concat(marches.map((m) => ({
      slot: Off.marchSlot(m.id),
      label: 'March leader',
      desc: (m.kind || 'march') + ' → ' + (m.to ? m.to.x + ',' + m.to.y : 'field')
    })));

  const rows = entries.map((e) => {
    const key = map[e.slot] || null;
    const info = key ? Off.officerInfo(key) : null;
    return h('div.slotrow', [
      h('div.slotrow__art', info ? officerPortraitNode(key, 44) : svg('svg', {
        viewBox: '0 0 100 100', width: 44, height: 44, 'aria-hidden': 'true',
        html: rect(0, 0, 100, 100, '#0f151d') + circ(50, 42, 16, '#1e2733')
          + poly('16,100 26,72 74,72 84,100', '#1e2733')
      })),
      h('div.slotrow__main', [
        h('div.list__title', info ? info.name : e.label + ' — empty'),
        h('div.list__sub', info ? e.label + ' · Lv.' + info.level + ' ' + info.stars + '★' : e.desc)
      ]),
      info
        ? h('button.btn.btn--sm.btn--ghost', {
          type: 'button',
          onclick: () => {
            Off.unassignSlot(e.slot);
            redraw();
          }
        }, 'Recall')
        : null
    ]);
  });

  return sectionCard('Command Slots', Off.usedSlots() + ' of ' + total + ' in use',
    rows.length ? h('div.stack', rows) : h('p.muted.small', 'No slots available.'));
}

// ---------------------------------------------------------------------------
// Recruit
// ---------------------------------------------------------------------------

function showDrawResults(results) {
  const cards = results.map((r, i) => {
    const info = Off.officerInfo(r.key);
    return h('div.drawcard' + (r.rarity === 'SSR' ? '.is-ssr' : ''), {
      style: {
        borderColor: rarityColor(r.rarity),
        animationDelay: (i * 140) + 'ms'
      }
    }, [
      officerPortraitNode(r.key, 90),
      h('div.drawcard__tag', { style: { color: rarityColor(r.rarity) } }, r.rarity),
      h('div.tiny', info ? info.name : r.name),
      h('div.tiny', { style: { color: r.isNew ? 'var(--ok)' : 'var(--muted)' } },
        r.isNew ? 'NEW' : '+' + r.fragments + ' frags')
    ]);
  });

  openModal({
    title: 'Recruitment',
    cls: 'modal--draw',
    body: h('div.stack', [
      h('div.drawgrid', cards),
      h('div.tiny.muted.center', results.some((r) => r.pityForced)
        ? 'Guaranteed Legendary triggered.'
        : 'Fragments promote commanders you already command.')
    ]),
    actions: [{ label: 'Confirm', kind: 'primary' }]
  });
}

function recruitPanel(redraw) {
  const pity = Math.max(0, Math.floor(Number(S.officers && S.officers.pity) || 0));
  const gold = Math.floor(Number(S.res.gold) || 0);

  const draw = (n) => () => {
    const r = Off.recruit(n);
    if (!r.ok) {
      toast(r.reason, 'warn');
      return;
    }
    showDrawResults(r.results);
    redraw();
  };

  const goldChip = statChip('Gold', formatNum(gold));
  const btn1 = h('button.btn.btn--primary', {
    type: 'button',
    disabled: gold < DRAW_COST.single,
    onclick: draw(1)
  }, 'Recruit x1 · ' + DRAW_COST.single + 'g');
  const btn10 = h('button.btn.btn--primary', {
    type: 'button',
    disabled: gold < DRAW_COST.ten,
    onclick: draw(DRAW_COST.tenCount)
  }, 'Recruit x' + DRAW_COST.tenCount + ' · ' + DRAW_COST.ten + 'g');
  goldRefs = { val: goldChip.querySelector('.stat__value'), b1: btn1, b10: btn10 };

  return sectionCard('Recruit Commanders', 'Gold draw · guaranteed Legendary every ' + PITY_COUNT + ' draws', [
    h('div.grid.grid--3', [
      goldChip,
      statChip('Draws made', formatNum(Number(S.officers && S.officers.draws) || 0)),
      statChip('Pity', pity + ' / ' + PITY_COUNT)
    ]),
    h('div.pity', [
      h('span.tiny.muted', 'To guarantee'),
      progressBar(clamp(pity / PITY_COUNT, 0, 1), 'bar--ok'),
      h('span.tiny.mono', (PITY_COUNT - pity) + ' left')
    ]),
    h('div.btn-row', [btn1, btn10]),
    h('div.tiny.muted', 'Odds: Legendary 4%, Super Rare 26%, Rare 70%. Duplicates convert to '
      + 'fragments (5 / 10 / 20) which raise a commander’s star rank.')
  ]);
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Render the Officers screen.
 * @returns {HTMLElement}
 */
export function renderOfficers() {
  injectStyle('warpath-ui-officers', CSS);
  const root = h('div.stack.screen-officers');

  function redraw() {
    clear(root);
    goldRefs = null;
    const list = Off.ownedList();
    const ownedCount = list.filter((i) => i.owned).length;

    const tabs = h('div.tabs', [
      h('button.tab' + (activeTab === 'roster' ? '.is-active' : ''), {
        type: 'button',
        onclick: () => {
          activeTab = 'roster';
          redraw();
        }
      }, 'Roster'),
      h('button.tab' + (activeTab === 'recruit' ? '.is-active' : ''), {
        type: 'button',
        onclick: () => {
          activeTab = 'recruit';
          redraw();
        }
      }, 'Recruit')
    ]);

    const content = activeTab === 'recruit'
      ? [recruitPanel(redraw)]
      : [
        slotsPanel(redraw),
        sectionCard('Officer Corps', ownedCount + ' of ' + list.length + ' commanders',
          h('div.offgrid', list.map((info) => officerCard(info, redraw))))
      ];

    mount([tabs].concat(content), root);
  }

  redraw();
  bindLive(root, { events: ['state:changed'], onEvent: redraw });
  // Gold ticks every second, so a structural redraw on 'res:changed' would
  // rebuild every inline-SVG portrait once a second. Patch the three
  // gold-dependent nodes in place instead.
  bindLive(root, {
    events: ['res:changed'],
    onEvent: () => {
      if (!goldRefs) return;
      const g = Math.floor(Number(S.res.gold) || 0);
      if (goldRefs.val) goldRefs.val.textContent = formatNum(g);
      goldRefs.b1.disabled = g < DRAW_COST.single;
      goldRefs.b10.disabled = g < DRAW_COST.ten;
    }
  });
  return root;
}

registerScreen('officers', renderOfficers);
