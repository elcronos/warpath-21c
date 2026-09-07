// js/ui/research.js — Research Lab screen: four branch tabs, an SVG dependency
// graph of the tech tree, per-node detail sheets and the live research slot.
// Exports: renderResearch

import { h, svg, clear, mount } from '../util/dom.js';
import { formatNum, formatTime, formatClock, pct, clamp } from '../util/fmt.js';
import { registerScreen } from './registry.js';
import { toast, openModal, confirmDialog, icon } from './shell.js';

import { TECH, BRANCHES, BRANCH_META, BONUS_META, techsInBranch } from '../data/tech.js';
import * as Research from '../engine/research.js';
import {
  injectStyle, bindLive, costRow, progressBar, statChip, sectionCard
} from './army.js';

const NODE_W = 132;
const NODE_H = 78;
const GAP_X = 52;
const GAP_Y = 26;
const PAD = 18;

let activeBranch = 'economy';

const CSS = `
.tree-wrap { overflow:auto; -webkit-overflow-scrolling:touch; border:1px solid var(--line-soft);
  border-radius:var(--r-md); background:rgba(0,0,0,.22); }
.tree { display:block; }
.tnode { cursor:pointer; }
.tnode rect.tnode__bg { fill:var(--panel-2); stroke:var(--line); stroke-width:1.5; }
.tnode.is-avail rect.tnode__bg { stroke-width:2; }
.tnode.is-locked { opacity:.5; }
.tnode.is-max rect.tnode__bg { fill:#22301f; }
.tnode.is-run rect.tnode__bg { fill:#2a2413; }
.tnode text { font-family:var(--font); fill:var(--text); }
.tnode .tnode__name { font-size:11.5px; font-weight:700; }
.tnode .tnode__lv { font-size:10px; fill:var(--muted); letter-spacing:.06em; }
.tlink { fill:none; stroke:var(--line); stroke-width:2; }
.tlink.is-open { stroke:var(--accent-dark); }
.bonuslist { display:flex; flex-direction:column; gap:4px; }
.bonusrow { display:flex; align-items:center; gap:var(--sp-2); font-size:12.5px; }
.bonusrow__k { flex:1 1 auto; color:var(--text-dim); }
.bonusrow__now { font-variant-numeric:tabular-nums; color:var(--muted); }
.bonusrow__next { font-variant-numeric:tabular-nums; color:var(--ok); font-weight:700; }
`;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

/**
 * Column/row positions for every tech in a branch, derived from the prereq chain.
 * @param {string} branch
 * @returns {{nodes:object[], width:number, height:number, byKey:Object<string,object>}}
 */
function layoutBranch(branch) {
  const list = techsInBranch(branch);
  const depth = {};
  const visiting = {};

  function depthOf(key) {
    if (depth[key] !== undefined) return depth[key];
    if (visiting[key]) return 0;
    visiting[key] = true;
    const t = TECH[key];
    const req = t && t.requires && t.requires.tech;
    const d = (req && TECH[req.key] && TECH[req.key].branch === branch)
      ? depthOf(req.key) + 1
      : 0;
    visiting[key] = false;
    depth[key] = d;
    return d;
  }

  const rowsUsed = {};
  const nodes = [];
  const byKey = {};
  let maxCol = 0;
  let maxRow = 0;

  for (let i = 0; i < list.length; i++) {
    const t = list[i];
    const col = depthOf(t.key);
    const row = rowsUsed[col] === undefined ? 0 : rowsUsed[col] + 1;
    rowsUsed[col] = row;
    const node = {
      key: t.key,
      def: t,
      col,
      row,
      x: PAD + col * (NODE_W + GAP_X),
      y: PAD + row * (NODE_H + GAP_Y),
      prereq: (t.requires && t.requires.tech && TECH[t.requires.tech.key]) ? t.requires.tech : null
    };
    nodes.push(node);
    byKey[t.key] = node;
    if (col > maxCol) maxCol = col;
    if (row > maxRow) maxRow = row;
  }

  return {
    nodes,
    byKey,
    width: PAD * 2 + (maxCol + 1) * NODE_W + maxCol * GAP_X,
    height: PAD * 2 + (maxRow + 1) * NODE_H + maxRow * GAP_Y
  };
}

/** Split a tech name into at most two balanced lines. */
function wrapName(name) {
  const words = String(name).split(' ');
  if (words.length === 1) return [name];
  let best = 1;
  let bestDiff = Infinity;
  for (let i = 1; i < words.length; i++) {
    const a = words.slice(0, i).join(' ').length;
    const b = words.slice(i).join(' ').length;
    const diff = Math.abs(a - b);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = i;
    }
  }
  return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
}

// ---------------------------------------------------------------------------
// Detail sheet
// ---------------------------------------------------------------------------

function bonusRows(st) {
  const keys = {};
  for (const k in st.bonusNow) keys[k] = true;
  for (const k in st.bonusNext) keys[k] = true;
  const rows = [];
  for (const k in keys) {
    if (!Object.prototype.hasOwnProperty.call(keys, k)) continue;
    const meta = BONUS_META[k] || { label: k, kind: 'pct' };
    const now = Number(st.bonusNow[k]) || 0;
    const next = Number(st.bonusNext[k]) || 0;
    rows.push(h('div.bonusrow', [
      h('span.bonusrow__k', meta.label),
      h('span.bonusrow__now', now > 0 ? '+' + pct(now) : '—'),
      st.maxed ? null : h('span', { style: { color: 'var(--muted)' } }, '→'),
      st.maxed ? null : h('span.bonusrow__next', '+' + pct(next))
    ]));
  }
  return h('div.bonuslist', rows);
}

function openTechSheet(key, redraw) {
  const st = Research.techStatus(key);
  if (!st) return;
  const meta = BRANCH_META[st.branch] || { name: st.branch, color: 'var(--accent)' };

  const startBtn = h('button.btn.btn--primary.btn--block', { type: 'button' },
    st.maxed ? 'Fully researched' : 'Research Lv.' + st.nextLevel);
  if (st.maxed || !st.can) {
    startBtn.disabled = true;
    startBtn.classList.add('is-disabled');
  }

  const handle = openModal({
    title: st.name,
    body: h('div.stack', [
      h('div.row', [
        h('span.tag', { style: { color: meta.color, borderColor: meta.color } }, meta.name),
        h('span.tag.tag--lvl', 'Lv.' + st.level + ' / ' + st.maxLevel),
        st.inProgress ? h('span.tag.tag--accent', 'In progress') : null
      ]),
      h('p.modal__text', st.desc),
      h('h4.upper.small.muted', 'Effects'),
      bonusRows(st),
      st.maxed ? null : h('div.sep'),
      st.maxed ? null : h('div.stack', { style: { gap: '6px' } }, [
        h('h4.upper.small.muted', 'Cost for level ' + st.nextLevel),
        costRow(st.cost),
        h('div.small.muted', 'Duration ' + formatTime(st.time))
      ]),
      st.can || st.maxed ? null : h('div.warnbox', [
        icon('warn', { size: 16 }),
        h('span', st.reason)
      ]),
      st.maxed ? null : startBtn
    ]),
    actions: [{ label: 'Close', kind: 'ghost' }]
  });

  startBtn.addEventListener('click', () => {
    const r = Research.startResearch(key);
    if (r.ok) {
      handle.close();
      redraw();
    }
  });
}

// ---------------------------------------------------------------------------
// Tree drawing
// ---------------------------------------------------------------------------

function drawTree(branch, redraw) {
  const lay = layoutBranch(branch);
  const meta = BRANCH_META[branch];
  const root = svg('svg.tree', {
    viewBox: '0 0 ' + lay.width + ' ' + lay.height,
    width: lay.width,
    height: lay.height,
    // the global reset sets svg{max-width:100%}, which would squash the tree
    // into the panel instead of letting .tree-wrap scroll it sideways.
    style: { width: lay.width + 'px', height: lay.height + 'px', maxWidth: 'none' },
    role: 'img',
    'aria-label': meta.name + ' technology tree'
  });

  // links first so nodes paint over them
  for (let i = 0; i < lay.nodes.length; i++) {
    const n = lay.nodes[i];
    if (!n.prereq) continue;
    const p = lay.byKey[n.prereq.key];
    if (!p) continue;
    const x1 = p.x + NODE_W;
    const y1 = p.y + NODE_H / 2;
    const x2 = n.x;
    const y2 = n.y + NODE_H / 2;
    const mid = (x1 + x2) / 2;
    const open = Research.getTechLevel(n.prereq.key) >= n.prereq.level;
    root.appendChild(svg('path.tlink' + (open ? '.is-open' : ''), {
      d: 'M' + x1 + ' ' + y1 + ' C' + mid + ' ' + y1 + ', ' + mid + ' ' + y2 + ', ' + x2 + ' ' + y2
    }));
  }

  for (let i = 0; i < lay.nodes.length; i++) {
    const n = lay.nodes[i];
    const st = Research.techStatus(n.key);
    let cls = 'is-locked';
    if (st.maxed) cls = 'is-max';
    else if (st.inProgress) cls = 'is-run';
    else if (st.can) cls = 'is-avail';
    else if (st.missing.length === 0) cls = 'is-short';

    const g = svg('g.tnode.' + cls, {
      transform: 'translate(' + n.x + ',' + n.y + ')',
      role: 'button',
      tabindex: '0',
      onclick: () => openTechSheet(n.key, redraw),
      onkeydown: (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openTechSheet(n.key, redraw);
        }
      }
    });

    g.appendChild(svg('rect.tnode__bg', {
      x: 0, y: 0, width: NODE_W, height: NODE_H, rx: 9,
      stroke: cls === 'is-locked' ? 'var(--line)' : meta.color
    }));
    g.appendChild(svg('rect', {
      x: 0, y: 0, width: 5, height: NODE_H, rx: 2.5, fill: meta.color,
      opacity: cls === 'is-locked' ? 0.35 : 1
    }));

    const lines = wrapName(n.def.name);
    for (let li = 0; li < lines.length; li++) {
      g.appendChild(svg('text.tnode__name', {
        x: 14, y: 22 + li * 14
      }, lines[li]));
    }

    g.appendChild(svg('text.tnode__lv', {
      x: 14, y: NODE_H - 22
    }, st.maxed ? 'MAX · Lv.' + st.level : 'Lv.' + st.level + ' / ' + st.maxLevel));

    // level pips
    const pipW = Math.min(9, (NODE_W - 28) / st.maxLevel);
    for (let p = 0; p < st.maxLevel; p++) {
      g.appendChild(svg('rect', {
        x: 14 + p * pipW,
        y: NODE_H - 16,
        width: Math.max(3, pipW - 2),
        height: 6,
        rx: 1.6,
        fill: p < st.level ? meta.color : 'var(--line)'
      }));
    }

    if (st.inProgress) {
      g.appendChild(svg('circle', { cx: NODE_W - 14, cy: 16, r: 5, fill: 'var(--accent)' }));
    } else if (st.maxed) {
      g.appendChild(svg('path', {
        d: 'M' + (NODE_W - 22) + ' 16 l4 4 8 -9',
        fill: 'none', stroke: 'var(--ok)', 'stroke-width': 2.4, 'stroke-linecap': 'round'
      }));
    }

    root.appendChild(g);
  }

  return h('div.tree-wrap', root);
}

// ---------------------------------------------------------------------------
// Active research panel
// ---------------------------------------------------------------------------

function activePanel(redraw) {
  const lab = Research.labLevel();
  const p = Research.researchProgress(Date.now());

  if (lab < 1) {
    return sectionCard('Research Lab', 'Not built',
      h('p.muted.small', 'Construct a Research Lab in your base to unlock the technology tree.'));
  }

  if (!p.active) {
    return sectionCard('Research Lab', 'Lab level ' + lab + ' · slot idle',
      h('p.muted.small', 'Pick a technology below to begin a research project.'));
  }

  const bar = progressBar(p.pct);
  const timeEl = h('span.qrow__time', formatClock(p.remaining));
  const body = h('div.stack', [
    h('div.qrow__head', [
      h('span.qrow__t', p.name + ' → Lv.' + p.level),
      timeEl
    ]),
    bar,
    h('div.btn-row', [
      h('button.btn.btn--sm.btn--primary', {
        type: 'button',
        onclick: () => {
          const r = Research.speedUpResearch(true);
          if (!r.ok) toast(r.reason, 'warn');
          redraw();
        }
      }, p.free ? 'Finish now' : 'Rush · ' + p.gold + 'g'),
      h('button.btn.btn--sm.btn--ghost', {
        type: 'button',
        onclick: async () => {
          const ok = await confirmDialog('Cancel research?',
            'The project is abandoned and every resource refunded.', { okLabel: 'Cancel it', danger: true });
          if (!ok) return;
          Research.cancelResearch();
          redraw();
        }
      }, 'Cancel')
    ])
  ]);

  const card = sectionCard('Researching', 'Lab level ' + lab, body);
  card.tickRefs = { endAt: p.endAt, total: p.total, bar, timeEl };
  return card;
}

// ---------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------

/**
 * Render the Research screen.
 * @returns {HTMLElement}
 */
export function renderResearch() {
  injectStyle('warpath-ui-research', CSS);
  const root = h('div.stack.screen-research');

  function branchTabs() {
    const tabs = h('div.tabs');
    for (let i = 0; i < BRANCHES.length; i++) {
      const b = BRANCHES[i];
      const meta = BRANCH_META[b];
      const done = techsInBranch(b).reduce((n, t) => n + Research.getTechLevel(t.key), 0);
      const btn = h('button.tab' + (b === activeBranch ? '.is-active' : ''), {
        type: 'button',
        onclick: () => {
          activeBranch = b;
          redraw();
        }
      }, [
        h('span', { style: { color: meta.color } }, meta.name),
        h('span.tiny.muted', ' ' + done)
      ]);
      tabs.appendChild(btn);
    }
    return tabs;
  }

  function summary() {
    return h('div.grid.grid--3', [
      statChip('Lab level', String(Research.labLevel())),
      statChip('Techs', String(Object.keys(Research.researchedLevels()).length) + ' / 40'),
      statChip('Total levels', formatNum(Research.totalTechLevels()))
    ]);
  }

  function redraw() {
    clear(root);
    const meta = BRANCH_META[activeBranch];
    mount([
      activePanel(redraw),
      sectionCard('Technology', 'Four branches · 40 projects', [
        summary(),
        branchTabs(),
        h('p.tiny.muted', meta.name + ' — tap a node for details. Lines show prerequisites; '
          + 'scroll sideways for the deeper tiers.'),
        drawTree(activeBranch, redraw)
      ])
    ], root);
  }

  redraw();

  bindLive(root, {
    events: ['state:changed', 'research:done'],
    onEvent: redraw,
    tick: () => {
      const card = root.querySelector('.panel');
      if (!card || !card.tickRefs) return;
      const refs = card.tickRefs;
      const remain = Math.max(0, Math.ceil((refs.endAt - Date.now()) / 1000));
      refs.timeEl.textContent = formatClock(remain);
      refs.bar.fill.style.width = (clamp(1 - remain / refs.total, 0, 1) * 100).toFixed(1) + '%';
    },
    ms: 500
  });

  return root;
}

registerScreen('research', renderResearch);
