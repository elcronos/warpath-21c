// js/ui/svg.js — the game's SVG art library (entry point).
// Small monochrome UI glyphs (ICONS, 24x24, currentColor) plus large flat-military
// illustrations (ART, 100x100): 16 buildings, 4 unit classes with an 8-step tier tint,
// 12 officer portraits and the world-map tiles.
//
// Exports: PALETTE, ICONS, ICON_KEYS, ART, ART_KEYS, UNIT_ART, OFFICER_ART,
//          OFFICER_STYLE, getIcon, getArt, iconHTML, artHTML, hasIcon, hasArt,
//          resolveArtKey, svgNode, RES_ART_COLOR, buildingArt, tileArt, tileHTML
//
// Two output flavours for every asset:
//   getIcon(key, size, color) / getArt(key, size, opts) -> live SVGElement
//   iconHTML(key, size, color) / artHTML(key, size, opts) -> string (for `html:` attrs)
//
// The building/map drawings live in ./svg-art.js (kept split for file size).

import { svg } from '../util/dom.js';
import {
  PALETTE, VIEW, poly, rect, circ, path, iso, diamond, ellipseShade,
  tierTint, levelBadge, BUILDING_ART, BUILDING_ART_KEYS, MAP_ART, MAP_ART_KEYS,
  squareTile, TILE_EMBLEM, TERRAIN_FILL
} from './svg-art.js';

export { PALETTE };

const P = PALETTE;

/** Resource key -> illustration colour (matches the CSS custom properties). */
export const RES_ART_COLOR = {
  oil: P.oil, steel: P.steelRes, rare: P.rare, food: P.food, gold: P.gold, power: P.amber
};

// ===========================================================================
// 1. ICONS — 24x24 glyphs. Each returns markup that inherits `fill` from the
//    wrapping <svg> (so getIcon's `color` tints them), unless it opts into
//    an explicit accent colour.
// ===========================================================================

/** @type {Object<string, (p?:object)=>string>} */
export const ICONS = {
  // ---- resources -----------------------------------------------------
  oil: () => path('M12 2.2c3.7 4.4 6.1 8 6.1 11A6.1 6.1 0 0 1 5.9 13.2c0-3 2.4-6.6 6.1-11Zm0 3.3c-2.6 3.3-4.1 5.9-4.1 7.7a4.1 4.1 0 0 0 8.2 0c0-1.8-1.5-4.4-4.1-7.7Z', 'currentColor') +
    path('M12 8.6c1.5 2 2.3 3.5 2.3 4.6a2.3 2.3 0 0 1-4.6 0c0-1.1.8-2.6 2.3-4.6Z', 'currentColor', 'opacity="0.55"'),
  steel: () => path('M3.4 7.2h17.2l-2.3 4.8 2.3 4.8H3.4l2.3-4.8-2.3-4.8Zm3.2 2 1.3 2.8-1.3 2.8h10.8l-1.3-2.8 1.3-2.8H6.6Z', 'currentColor') +
    path('M9 10.4h6l-.7 1.6.7 1.6H9l.7-1.6L9 10.4Z', 'currentColor', 'opacity="0.5"'),
  rare: () => path('M12 1.8 3.8 8.6 12 22.2l8.2-13.6L12 1.8Zm0 2.8 5.6 4.6-5.6 9.4-5.6-9.4L12 4.6Z', 'currentColor') +
    path('M12 6.4 8.2 9.6 12 16l3.8-6.4L12 6.4Z', 'currentColor', 'opacity="0.5"'),
  food: () => path('M6.6 2.2v6h1.1v-6h1.6v6h1.1v-6h1.6v7.2c0 1.6-.9 2.8-2.3 3.1V22H7.3V12.5C5.9 12.2 5 11 5 9.4V2.2h1.6Zm10 0c2.1 0 3.6 2.5 3.6 5.6 0 2.5-1 4.4-2.5 5V22h-2.2V2.2h1.1Z', 'currentColor'),
  gold: () => path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.1a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Z', 'currentColor') +
    path('M12.9 6.6h-1.8v1.1c-1.4.2-2.3 1.1-2.3 2.4 0 1.4 1 2.1 2.7 2.5 1.2.3 1.6.6 1.6 1.1 0 .6-.5.9-1.4.9-1 0-1.6-.4-1.8-1.2H8.1c.2 1.5 1.1 2.4 3 2.6v1.1h1.8v-1.1c1.6-.2 2.6-1.1 2.6-2.5 0-1.4-.9-2.1-2.8-2.6-1.1-.3-1.5-.5-1.5-1 0-.5.4-.8 1.2-.8.9 0 1.4.4 1.5 1.1h1.8c-.1-1.4-1-2.2-2.8-2.4V6.6Z', 'currentColor', 'opacity="0.75"'),
  power: () => path('M13.6 1.8 3.9 14.2h5.7L8.9 22.2 20.1 9.4h-6.2l1.7-7.6h-2Z', 'currentColor'),

  // ---- navigation ----------------------------------------------------
  base: () => path('M12 2.4 2.5 10v11.6h7.1v-6.2h4.8v6.2h7.1V10L12 2.4Zm0 2.7 7.3 5.9v9h-3.1v-6.2H7.8v6.2H4.7v-9L12 5.1Z', 'currentColor') +
    rect(10.6, 6.4, 2.8, 3, 'currentColor', 'opacity="0.6"'),
  map: () => path('M9 2.4 2.4 5v16.6L9 19l6 2.6 6.6-2.6V2.4L15 5 9 2.4Zm-.9 2.4 5.8 2.5v12L8.1 16.8v-12Zm-3.6.4v12l1.9-.8v-12l-1.9.8Zm14.7-.8v12.3l-1.9.8V5.2l1.9-.8Z', 'currentColor'),
  army: () => path('M12 1.8 3.6 4.9v6.4c0 5.2 3.6 9.9 8.4 11.1 4.8-1.2 8.4-5.9 8.4-11.1V4.9L12 1.8Zm0 2.2 6.4 2.4v5.1c0 4-2.6 7.6-6.4 8.8-3.8-1.2-6.4-4.8-6.4-8.8V6.4L12 4Z', 'currentColor') +
    path('M11 6.9h2v3.3h3.3v2H13v3.4h-2v-3.4H7.7v-2H11V6.9Z', 'currentColor'),
  research: () => path('M8.6 2v2h1.2v5.4l-5.6 8.9A2.6 2.6 0 0 0 6.4 22.2h11.2a2.6 2.6 0 0 0 2.2-3.9l-5.6-8.9V4h1.2V2H8.6Zm3.4 2h.1v5.9l2.4 3.9H9.5L12 9.9V4Zm-3.6 11.8h7.2l2 3.2c.2.4 0 .9-.4.9H6.8c-.4 0-.6-.5-.4-.9l2-3.2Z', 'currentColor') +
    circ(11, 18.6, 1.1, 'currentColor', 'opacity="0.7"'),
  officers: () => path('M12 2a4.6 4.6 0 1 0 0 9.2A4.6 4.6 0 0 0 12 2Zm0 2.1a2.5 2.5 0 1 1 0 5 2.5 2.5 0 0 1 0-5ZM3.8 21.1c0-4.1 3.7-7.2 8.2-7.2s8.2 3.1 8.2 7.2v1H3.8v-1Zm2.3-1h11.8c-.6-2.5-3-4.1-5.9-4.1s-5.3 1.6-5.9 4.1Z', 'currentColor'),
  campaign: () => path('M5.7 1.8v20.4L12 17.8l6.3 4.4V1.8H5.7Zm2.1 2.1h8.4v14.2L12 15.2l-4.2 2.9V3.9Z', 'currentColor') +
    path('M12 5.6l1.1 2.3 2.5.4-1.8 1.8.4 2.5L12 11.4l-2.2 1.2.4-2.5-1.8-1.8 2.5-.4L12 5.6Z', 'currentColor', 'opacity="0.65"'),
  settings: () => path('M10.2 1.9h3.6l.4 2.6 1.7.9 2.4-1 1.8 3.1-2 1.7v1.6l2 1.7-1.8 3.1-2.4-1-1.7.9-.4 2.6h-3.6l-.4-2.6-1.7-.9-2.4 1-1.8-3.1 2-1.7v-1.6l-2-1.7 1.8-3.1 2.4 1 1.7-.9.4-2.6Z M12 8.3a3.7 3.7 0 1 0 0 7.4 3.7 3.7 0 0 0 0-7.4Z', 'currentColor', 'fill-rule="evenodd"'),

  // ---- misc UI -------------------------------------------------------
  clock: () => path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.1a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Z', 'currentColor') +
    path('M11 6.2v7h5.8v-2h-3.8v-5H11Z', 'currentColor'),
  speedup: () => path('M13.4 1.8 4.6 13.4h4.8l-1 8.8 8.8-11.6h-4.8l1-8.8Z', 'currentColor') +
    path('M4.2 4.6h5v1.8h-5V4.6Zm-2 4h5v1.8h-5V8.6Z', 'currentColor', 'opacity="0.55"'),
  lock: () => path('M12 2.2a4.9 4.9 0 0 0-4.9 4.9v2.3H5.5v11.4h13V9.4h-1.6V7.1A4.9 4.9 0 0 0 12 2.2Zm0 2.1a2.8 2.8 0 0 1 2.8 2.8v2.3H9.2V7.1A2.8 2.8 0 0 1 12 4.3Zm-4.4 7.2h8.8v7.2H7.6v-7.2Zm4.4 1.6a1.6 1.6 0 0 0-.8 3v1.6h1.6v-1.6a1.6 1.6 0 0 0-.8-3Z', 'currentColor'),
  check: () => path('M9.6 16.1 5.5 12l-1.5 1.5 5.6 5.6L20.5 8.2 19 6.7 9.6 16.1Z', 'currentColor'),
  arrow: () => path('M13.1 4.6 11.6 6l5 5H3.4v2h13.2l-5 5 1.5 1.4L20.6 12l-7.5-7.4Z', 'currentColor'),
  star: () => path('M12 2.2l2.9 6 6.6.9-4.8 4.6 1.2 6.5L12 17.1l-5.9 3.1 1.2-6.5-4.8-4.6 6.6-.9 2.9-6Z', 'currentColor'),
  chevron: () => path('M9.1 4.6 7.7 6l6 6-6 6 1.4 1.4L16.5 12 9.1 4.6Z', 'currentColor'),
  plus: () => path('M11 4.6v6.4H4.6v2H11v6.4h2v-6.4h6.4v-2H13V4.6h-2Z', 'currentColor'),
  close: () => path('M5.4 4 4 5.4 10.6 12 4 18.6 5.4 20 12 13.4 18.6 20 20 18.6 13.4 12 20 5.4 18.6 4 12 10.6 5.4 4Z', 'currentColor'),
  march: () => path('M2.4 11h11.8l-4-4L11.6 5.6 18 12l-6.4 6.4-1.4-1.4 4-4H2.4v-2Z', 'currentColor') +
    path('M19.4 5.6h2v12.8h-2V5.6Z', 'currentColor', 'opacity="0.6"'),
  shield: () => path('M12 1.8 3.8 4.9v6.4c0 5.2 3.6 9.9 8.2 11.1 4.6-1.2 8.2-5.9 8.2-11.1V4.9L12 1.8Zm0 2.2 6.2 2.4v5.1c0 4-2.5 7.6-6.2 8.8-3.7-1.2-6.2-4.8-6.2-8.8V6.4L12 4Z', 'currentColor'),
  sword: () => path('M19.8 2.2 12 10l-1.4-1.4-1.5 1.5 4.8 4.8 1.5-1.5L14 12l7.8-7.8V2.2h-2ZM4.7 14.4l-1.5 1.5 1.6 1.6-1.4 1.4 1.4 1.4 1.4-1.4 1.6 1.6 1.5-1.5-4.6-4.6Z', 'currentColor') +
    path('M9.6 10.4 4.2 5v-2.8h2.9l5.3 5.4-2.8 2.8Z', 'currentColor', 'opacity="0.6"'),
  flag: () => path('M5.2 2.2h2v19.6h-2V2.2Z', 'currentColor') +
    path('M8 3.2h11.8l-2.6 4.4 2.6 4.4H8V3.2Z', 'currentColor', 'opacity="0.8"'),
  hq: () => ICONS.base(),
  warn: () => path('M12 2 1 21.4h22L12 2Zm0 4.3 7.4 12.9H4.6L12 6.3Zm-1 3.9v5.2h2v-5.2h-2Zm0 6.4v2h2v-2h-2Z', 'currentColor'),
  info: () => path('M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 2.1a7.9 7.9 0 1 1 0 15.8 7.9 7.9 0 0 1 0-15.8Zm-1 3v2h2v-2h-2Zm0 3.5v6h2v-6h-2Z', 'currentColor'),
  heal: () => path('M9.6 2.6h4.8v4.6H19v4.8h-4.6v4.6H9.6v-4.6H5V7.2h4.6V2.6Z', 'currentColor') +
    path('M2.6 18.4h5l1.6-2.4 2.4 4.4 2-3.2 1.4 1.2h6.4v2h-7.2l-1.2-1-2.4 3.6-2.6-4.6-.8 1.2h-4.6v-1.2Z', 'currentColor', 'opacity="0.7"'),
  gather: () => path('M12 2.6 4.6 7v10L12 21.4 19.4 17V7L12 2.6Zm0 2.4 5.4 3.2v6.4L12 19 6.6 14.6V8.2L12 5Z', 'currentColor') +
    path('M12 8.2 8.8 10v4l3.2 1.8 3.2-1.8v-4L12 8.2Z', 'currentColor', 'opacity="0.65"'),
  attack: () => ICONS.sword(),
  build: () => path('M17 2.2a5.4 5.4 0 0 0-5 7.5L3.2 18.5l2.3 2.3 8.8-8.8A5.4 5.4 0 1 0 17 2.2Zm0 2a3.4 3.4 0 0 1 1.2.2l-2.4 2.4 1.6 1.6 2.4-2.4A3.4 3.4 0 1 1 17 4.2Z', 'currentColor'),
  queue: () => rect(3.2, 4.2, 17.6, 3.6, 'currentColor') +
    rect(3.2, 10.2, 17.6, 3.6, 'currentColor', 'opacity="0.75"') +
    rect(3.2, 16.2, 17.6, 3.6, 'currentColor', 'opacity="0.5"'),
  minus: () => rect(4.6, 11, 14.8, 2, 'currentColor'),
  refresh: () => path('M12 3.4a8.6 8.6 0 0 1 8.2 6h-2.2A6.6 6.6 0 0 0 5.6 12h2.8L4.6 16.6.8 12h2.8A8.6 8.6 0 0 1 12 3.4Zm7.6 4.6L23.4 12h-2.8a8.6 8.6 0 0 1-15.8 3.4h2.2A6.6 6.6 0 0 0 18.4 12h-2.8l4-4Z', 'currentColor')
};

/** @type {string[]} */
export const ICON_KEYS = Object.keys(ICONS);

// ===========================================================================
// 2. UNIT ART — one silhouette per class, tinted by tier (1..8).
//    Called as UNIT_ART.tank({ tier: 5, pips: true })
// ===========================================================================

function tierPips(tier, color) {
  const n = Math.max(1, Math.min(8, tier | 0));
  let out = '';
  for (let i = 0; i < n; i++) {
    const x = 10 + i * 10;
    out += poly(x + ',92 ' + (x + 5) + ',86 ' + (x + 10) + ',92 ' + (x + 5) + ',89.5', color);
  }
  return out;
}

/** @type {Object<string, (p?:object)=>string>} */
export const UNIT_ART = {
  /** Rifleman: helmet, webbing, rifle at the ready. */
  infantry(p) {
    const t = tierTint(p && p.tier);
    return ellipseShade(50, 88, 24, 6, 0.28) +
      // legs
      poly('40,60 47,60 45,86 37,86', t.dark) +
      poly('52,60 60,60 63,86 55,86', t.body) +
      rect(33, 84, 14, 4, P.ink) + rect(53, 84, 14, 4, P.ink) +
      // torso + pack
      path('M36 34 h28 l4 16 -4 14 h-28 l-4 -14 z', t.body) +
      path('M50 34 h14 l4 16 -4 14 h-14 z', t.light) +
      poly('64,36 74,40 74,58 64,56', t.dark) +
      // webbing
      poly('38,42 62,42 62,46 38,46', P.ink, 'opacity="0.45"') +
      rect(46, 40, 8, 10, t.trim, 'opacity="0.7"') +
      // arms
      poly('30,40 38,38 40,58 33,58', t.dark) +
      poly('62,38 70,42 66,58 60,56', t.light) +
      // head + helmet
      circ(50, 24, 10, P.skin) +
      path('M38 24 a12 12 0 0 1 24 0 l2 3 h-28 z', t.dark) +
      path('M50 12 a12 12 0 0 1 12 12 l2 3 h-14 z', t.body) +
      rect(42, 27, 16, 3, P.ink, 'opacity="0.5"') +
      // rifle
      '<path d="M28 58 L74 36" stroke="' + P.ink + '" stroke-width="4" stroke-linecap="round" fill="none"/>' +
      '<path d="M34 55 L70 38" stroke="' + P.steelDk + '" stroke-width="2" stroke-linecap="round" fill="none"/>' +
      (p && p.pips ? tierPips((p && p.tier) || 1, t.trim) : '');
  },

  /** Main battle tank in three-quarter view. */
  tank(p) {
    const t = tierTint(p && p.tier);
    return ellipseShade(50, 84, 36, 7, 0.28) +
      // tracks
      path('M10 62 h72 a6 6 0 0 1 0 16 h-72 a6 6 0 0 1 0 -16 z', P.ink) +
      circ(20, 70, 6, t.dark) + circ(36, 70, 5, t.dark) + circ(52, 70, 5, t.dark) +
      circ(68, 70, 5, t.dark) + circ(80, 70, 6, t.dark) +
      rect(14, 66, 68, 3, t.dark, 'opacity="0.7"') +
      // hull
      poly('12,62 88,62 82,48 20,48', t.body) +
      poly('50,48 82,48 88,62 50,62', t.light) +
      poly('20,48 50,48 50,62 12,62', t.dark) +
      // skirt highlight
      rect(20, 56, 60, 2.6, t.trim, 'opacity="0.45"') +
      // turret
      path('M34 46 h30 l6 -12 h-40 z', t.light) +
      poly('50,34 64,34 64,46 50,46', t.body) +
      rect(44, 28, 12, 6, t.dark) +
      circ(50, 28, 3.4, t.trim) +
      // gun barrel + muzzle brake
      rect(62, 36, 34, 5, P.steelDk) +
      rect(88, 34, 8, 9, P.steel) +
      // stowage
      rect(24, 40, 10, 5, t.dark) + rect(24, 40, 10, 2, t.trim, 'opacity="0.6"') +
      (p && p.pips ? tierPips((p && p.tier) || 1, t.trim) : '');
  },

  /** Strike jet seen from a high three-quarter angle. */
  aircraft(p) {
    const t = tierTint(p && p.tier);
    return ellipseShade(50, 88, 26, 5, 0.22) +
      // wings
      poly('50,44 96,62 96,70 50,60', t.dark) +
      poly('50,44 4,62 4,70 50,60', t.body) +
      // fuselage
      path('M50 8 l10 22 v42 l-10 10 -10 -10 v-42 z', t.light) +
      path('M50 8 l10 22 v42 l-10 10 z', t.body) +
      // canopy
      path('M50 18 l5 9 -5 8 -5 -8 z', P.glass) +
      path('M50 18 l5 9 -5 8 z', P.glassDk) +
      // tail planes
      poly('50,68 70,76 70,82 50,76', t.dark) +
      poly('50,68 30,76 30,82 50,76', t.body) +
      poly('47,62 53,62 53,84 50,88 47,84', t.trim, 'opacity="0.85"') +
      // engine glow + hardpoints
      circ(50, 80, 4, P.amber) + circ(50, 80, 2, P.amberLt) +
      rect(28, 62, 5, 12, t.dark) + rect(67, 62, 5, 12, t.dark) +
      rect(14, 63, 4, 8, P.steelDk) + rect(82, 63, 4, 8, P.steelDk) +
      (p && p.pips ? tierPips((p && p.tier) || 1, t.trim) : '');
  },

  /** Towed howitzer with split trail and shield. */
  artillery(p) {
    const t = tierTint(p && p.tier);
    return ellipseShade(50, 84, 34, 6, 0.28) +
      // split trail
      poly('42,58 20,80 26,82 48,62', t.dark) +
      poly('50,58 34,82 40,84 56,62', t.body) +
      // wheels
      circ(30, 70, 11, P.ink) + circ(30, 70, 6, t.dark) + circ(30, 70, 2.4, t.trim) +
      circ(66, 70, 11, P.ink) + circ(66, 70, 6, t.dark) + circ(66, 70, 2.4, t.trim) +
      // carriage
      poly('26,58 74,58 68,48 34,48', t.body) +
      poly('50,48 68,48 74,58 50,58', t.light) +
      // shield
      poly('34,50 66,50 62,28 38,28', t.dark) +
      poly('50,28 62,28 66,50 50,50', t.body) +
      rect(44, 32, 12, 7, P.ink, 'opacity="0.55"') +
      // barrel + recoil sleeve
      '<path d="M46 44 L94 14" stroke="' + P.steelDk + '" stroke-width="7" stroke-linecap="round" fill="none"/>' +
      '<path d="M50 42 L90 17" stroke="' + P.steelLt + '" stroke-width="2.4" stroke-linecap="round" fill="none" opacity="0.8"/>' +
      circ(92, 15, 4.6, t.dark) +
      // shell crate
      rect(12, 62, 12, 10, t.dark) + rect(12, 62, 12, 3, t.trim, 'opacity="0.6"') +
      (p && p.pips ? tierPips((p && p.tier) || 1, t.trim) : '');
  }
};

// ===========================================================================
// 3. OFFICER PORTRAITS — bust silhouettes in a rarity-coloured frame.
//    Keys match OFFICER_KEYS in js/data/officers.js.
// ===========================================================================

/** Per-officer look: rarity frame, headgear style, uniform tone, insignia. */
export const OFFICER_STYLE = {
  hastings:  { rarity: 'R',   gear: 'peakcap',  cloth: '#4b5a3a', accent: P.amber,    skin: P.skin,   face: 'moustache', pips: 2 },
  kruger:    { rarity: 'R',   gear: 'tanker',   cloth: '#4a4740', accent: P.rustLt,   skin: P.skinDk, face: 'stubble',   pips: 2 },
  tanaka:    { rarity: 'R',   gear: 'fieldcap', cloth: '#3f4a44', accent: P.rare,     skin: P.skinLt, face: 'glasses',   pips: 1 },
  rossi:     { rarity: 'R',   gear: 'beret',    cloth: '#4a3f3f', accent: P.crimson,  skin: P.skin,   face: 'scar',      pips: 1 },
  petrova:   { rarity: 'SR',  gear: 'ushanka',  cloth: '#3d4653', accent: P.steelHi,  skin: P.skinLt, face: 'plain',     pips: 3 },
  vega:      { rarity: 'SR',  gear: 'aviator',  cloth: '#3a4450', accent: P.glass,    skin: P.skinDk, face: 'visor',     pips: 3 },
  okonkwo:   { rarity: 'SR',  gear: 'helmet',   cloth: '#455036', accent: P.oliveHi,  skin: '#8a5a35', face: 'plain',    pips: 3 },
  lindqvist: { rarity: 'SR',  gear: 'hood',     cloth: '#404a42', accent: P.foodDk,   skin: P.skinLt, face: 'eyepatch',  pips: 2 },
  moreau:    { rarity: 'SR',  gear: 'kepi',     cloth: '#3f4558', accent: P.amberLt,  skin: P.skin,   face: 'plain',     pips: 3 },
  ironside:  { rarity: 'SSR', gear: 'general',  cloth: '#3a3f34', accent: P.amber,    skin: P.skin,   face: 'moustache', pips: 5 },
  valentine: { rarity: 'SSR', gear: 'flightcap',cloth: '#38414f', accent: P.glass,    skin: P.skinLt, face: 'shades',    pips: 4 },
  zhao:      { rarity: 'SSR', gear: 'commander',cloth: '#4a3a3a', accent: P.crimson,  skin: P.skinDk, face: 'plain',     pips: 5 }
};

function frameFor(rarity) {
  const c = P.rarity[rarity] || P.rarity.R;
  return {
    ring: c,
    bgTop: rarity === 'SSR' ? '#3a2c12' : rarity === 'SR' ? '#2c2340' : '#1b2634',
    bgBot: rarity === 'SSR' ? '#1a140a' : rarity === 'SR' ? '#171327' : '#101822'
  };
}

function headgear(kind, cloth, accent) {
  switch (kind) {
    case 'peakcap':
      return path('M28 34 a22 18 0 0 1 44 0 v3 h-44 z', cloth) +
        path('M50 16 a22 18 0 0 1 22 18 v3 h-22 z', accent, 'opacity="0.25"') +
        rect(26, 34, 48, 5, P.ink) +
        path('M24 39 h52 l-4 6 h-44 z', '#11161d') +
        circ(50, 27, 4, accent);
    case 'tanker':
      return path('M28 36 a22 20 0 0 1 44 0 v4 h-44 z', cloth) +
        rect(26, 30, 48, 7, P.ink, 'opacity="0.55"') +
        circ(38, 33, 6, accent) + circ(62, 33, 6, accent) +
        circ(38, 33, 3.6, P.glassDk) + circ(62, 33, 3.6, P.glassDk) +
        rect(44, 31, 12, 4, P.ink);
    case 'fieldcap':
      return path('M29 36 a21 16 0 0 1 42 0 v2 h-42 z', cloth) +
        rect(28, 36, 44, 4, P.ink, 'opacity="0.6"') +
        path('M28 40 h44 l-3 4 h-38 z', '#141a21') +
        rect(46, 24, 8, 4, accent);
    case 'beret':
      return path('M26 34 q6 -20 26 -20 q22 0 20 18 q-20 8 -46 2 z', accent) +
        path('M50 14 q22 0 20 18 q-10 4 -20 5 z', P.ink, 'opacity="0.25"') +
        circ(34, 28, 4, P.amberLt) +
        rect(24, 32, 10, 4, P.ink);
    case 'ushanka':
      return path('M26 36 a24 20 0 0 1 48 0 v3 h-48 z', '#5a5148') +
        path('M50 16 a24 20 0 0 1 24 20 v3 h-24 z', '#6d6156') +
        path('M24 34 q-4 16 6 20 l4 -14 z', '#5a5148') +
        path('M76 34 q4 16 -6 20 l-4 -14 z', '#6d6156') +
        path('M50 20 l3.4 7 7.4 1-5.4 5.2 1.3 7.4-6.7-3.6-6.7 3.6 1.3-7.4-5.4-5.2 7.4-1z', accent);
    case 'aviator':
      return path('M28 38 a22 22 0 0 1 44 0 v2 h-44 z', cloth) +
        path('M50 16 a22 22 0 0 1 22 22 v2 h-22 z', P.steelDk) +
        path('M28 34 h44 v10 a22 10 0 0 1 -44 0 z', P.glassDk) +
        path('M30 36 h18 v8 a20 8 0 0 1 -18 -3 z', accent, 'opacity="0.55"') +
        rect(24, 32, 52, 4, P.steelDk);
    case 'helmet':
      return path('M27 38 a23 21 0 0 1 46 0 l3 4 h-52 z', cloth) +
        path('M50 17 a23 21 0 0 1 23 21 l3 4 h-26 z', accent, 'opacity="0.3"') +
        '<path d="M30 28 q20 -6 40 0 M28 36 q22 -4 44 0" stroke="' + P.ink +
        '" stroke-width="1.6" fill="none" opacity="0.55"/>' +
        rect(24, 42, 52, 4, P.ink, 'opacity="0.5"');
    case 'hood':
      return path('M24 46 q0 -32 26 -32 q26 0 26 32 l-6 4 q-4 -22 -20 -22 q-16 0 -20 22 z', cloth) +
        path('M50 14 q26 0 26 32 l-6 4 q-4 -22 -20 -22 z', P.ink, 'opacity="0.25"') +
        rect(30, 44, 40, 6, accent, 'opacity="0.7"') +
        circ(50, 20, 3, accent, 'opacity="0.6"');
    case 'kepi':
      return rect(28, 24, 44, 14, cloth) +
        rect(28, 24, 22, 14, P.ink, 'opacity="0.18"') +
        rect(26, 36, 48, 4, accent) +
        path('M24 40 h52 l-4 5 h-44 z', '#11161d') +
        rect(44, 26, 12, 3, accent);
    case 'general':
      return path('M26 34 a24 19 0 0 1 48 0 v4 h-48 z', cloth) +
        path('M50 15 a24 19 0 0 1 24 19 v4 h-24 z', P.ink, 'opacity="0.2"') +
        rect(24, 34, 52, 6, P.ink) +
        path('M22 40 h56 l-5 7 h-46 z', '#11161d') +
        '<path d="M30 44 h40" stroke="' + accent + '" stroke-width="2" fill="none"/>' +
        path('M50 20 l3.2 6.6 7.3 1-5.3 5.1 1.3 7.2-6.5-3.4-6.5 3.4 1.3-7.2-5.3-5.1 7.3-1z', accent) +
        circ(34, 30, 2.4, accent) + circ(66, 30, 2.4, accent);
    case 'flightcap':
      return path('M28 38 a22 20 0 0 1 44 0 v3 h-44 z', cloth) +
        path('M50 18 a22 20 0 0 1 22 20 v3 h-22 z', P.steelDk, 'opacity="0.6"') +
        rect(24, 36, 52, 5, P.ink) +
        // headset
        circ(26, 44, 7, P.ink) + circ(74, 44, 7, P.ink) +
        circ(74, 44, 4, accent, 'opacity="0.7"') +
        '<path d="M26 40 q24 -22 48 0" stroke="' + P.steelDk + '" stroke-width="4" fill="none"/>' +
        '<path d="M28 48 q10 12 18 12" stroke="' + P.ink + '" stroke-width="3" fill="none"/>';
    case 'commander':
    default:
      return path('M26 35 a24 20 0 0 1 48 0 v4 h-48 z', cloth) +
        path('M50 15 a24 20 0 0 1 24 20 v4 h-24 z', accent, 'opacity="0.22"') +
        rect(24, 35, 52, 5, P.ink) +
        path('M22 40 h56 l-4 6 h-48 z', '#11161d') +
        path('M50 20 l3.6 7.4 8.2 1.2-6 5.8 1.4 8.1-7.2-3.8-7.2 3.8 1.4-8.1-6-5.8 8.2-1.2z', accent);
  }
}

function faceDetail(kind, accent) {
  switch (kind) {
    case 'moustache':
      return path('M42 62 q8 -4 16 0 q-8 5 -16 0 z', P.hair) + circ(43, 54, 2, P.ink) + circ(57, 54, 2, P.ink);
    case 'stubble':
      return path('M38 58 q12 12 24 0 q-2 12 -12 12 q-10 0 -12 -12 z', P.ink, 'opacity="0.25"') +
        circ(43, 54, 2, P.ink) + circ(57, 54, 2, P.ink);
    case 'glasses':
      return circ(43, 54, 6, 'none', 'stroke="' + P.steelHi + '" stroke-width="2"') +
        circ(57, 54, 6, 'none', 'stroke="' + P.steelHi + '" stroke-width="2"') +
        rect(48, 53, 4, 1.8, P.steelHi);
    case 'scar':
      return circ(43, 54, 2, P.ink) + circ(57, 54, 2, P.ink) +
        '<path d="M60 46 L64 62" stroke="' + P.crimsonDk + '" stroke-width="2" fill="none"/>';
    case 'eyepatch':
      return circ(57, 54, 2, P.ink) +
        path('M36 50 h14 v9 h-14 z', P.ink) +
        '<path d="M34 46 L68 58" stroke="' + P.ink + '" stroke-width="2" fill="none"/>';
    case 'visor':
      return rect(36, 48, 28, 9, P.glassDk) + rect(38, 50, 10, 4, accent, 'opacity="0.7"');
    case 'shades':
      return path('M36 50 h12 v8 h-12 z', P.ink) + path('M52 50 h12 v8 h-12 z', P.ink) +
        rect(48, 52, 4, 2, P.ink) + rect(38, 51, 4, 2, P.steelHi, 'opacity="0.6"');
    default:
      return circ(43, 54, 2, P.ink) + circ(57, 54, 2, P.ink) +
        path('M44 64 q6 3 12 0 q-6 5 -12 0 z', P.skinDk);
  }
}

function rankPips(n, accent) {
  let out = '';
  for (let i = 0; i < n; i++) {
    out += poly((16 + i * 7) + ',88 ' + (20 + i * 7) + ',82 ' + (24 + i * 7) + ',88 ' + (20 + i * 7) + ',86', accent);
  }
  return out;
}

/**
 * Build one officer bust.
 * @param {object} st entry of OFFICER_STYLE
 * @param {object} [p] {frame:boolean}
 */
function officerBust(st, p) {
  const f = frameFor(st.rarity);
  const showFrame = !p || p.frame !== false;
  const clothDk = P.clothDk;
  return (
    // backdrop
    rect(2, 2, 96, 96, f.bgBot, 'rx="10"') +
    path('M2 62 L98 34 V12 a10 10 0 0 0 -10 -10 H12 a10 10 0 0 0 -10 10 z', f.bgTop) +
    poly('2,74 98,44 98,52 2,82', f.ring, 'opacity="0.14"') +
    // shoulders / uniform
    path('M12 98 q4 -26 38 -26 q34 0 38 26 z', st.cloth) +
    path('M50 72 q34 0 38 26 h-38 z', clothDk, 'opacity="0.35"') +
    // collar + lapel insignia
    poly('38,74 50,88 62,74 56,71 50,80 44,71', '#e8edf2', 'opacity="0.15"') +
    rect(26, 82, 10, 6, st.accent, 'opacity="0.85"') +
    rect(64, 82, 10, 6, st.accent, 'opacity="0.85"') +
    rankPips(Math.max(1, st.pips || 1), st.accent) +
    // neck + head
    rect(43, 62, 14, 12, P.skinDk) +
    path('M32 48 a18 20 0 0 1 36 0 v6 a18 20 0 0 1 -36 0 z', st.skin) +
    path('M50 28 a18 20 0 0 1 18 20 v6 a18 20 0 0 1 -18 20 z', P.skinDk, 'opacity="0.18"') +
    // ears
    circ(31, 52, 3.4, st.skin) + circ(69, 52, 3.4, st.skin) +
    faceDetail(st.face, st.accent) +
    headgear(st.gear, st.cloth, st.accent) +
    // frame
    (showFrame
      ? '<rect x="2" y="2" width="96" height="96" rx="10" fill="none" stroke="' + f.ring + '" stroke-width="3"/>' +
        '<rect x="6" y="6" width="88" height="88" rx="7" fill="none" stroke="#000" stroke-width="1" opacity="0.35"/>' +
        poly('2,12 2,2 12,2 2,12', f.ring) + poly('98,88 98,98 88,98 98,88', f.ring)
      : '')
  );
}

/** key -> portrait markup. @type {Object<string,(p?:object)=>string>} */
export const OFFICER_ART = {};
for (const k in OFFICER_STYLE) {
  if (!Object.prototype.hasOwnProperty.call(OFFICER_STYLE, k)) continue;
  OFFICER_ART[k] = ((style) => (p) => officerBust(style, p))(OFFICER_STYLE[k]);
}

// ===========================================================================
// 4. Registry + public API
// ===========================================================================

/**
 * Every large illustration, keyed by art key.
 * Buildings use their BUILDING_KEYS name, map tiles their MAP_ART name,
 * units `unit_<class>`, officers `off_<key>` (aliases below cover the raw
 * data keys such as `portrait_zhao` and bare `zhao`).
 * @type {Object<string, (p?:object)=>string>}
 */
export const ART = Object.create(null);

for (const k of BUILDING_ART_KEYS) ART[k] = BUILDING_ART[k];
for (const k of MAP_ART_KEYS) ART[k] = MAP_ART[k];
for (const k in UNIT_ART) {
  if (!Object.prototype.hasOwnProperty.call(UNIT_ART, k)) continue;
  ART['unit_' + k] = UNIT_ART[k];
  ART[k] = ART[k] || UNIT_ART[k];   // 'infantry' / 'aircraft' / 'artillery' (tank -> unit)
}
for (const k in OFFICER_ART) {
  if (!Object.prototype.hasOwnProperty.call(OFFICER_ART, k)) continue;
  ART['off_' + k] = OFFICER_ART[k];
  ART['portrait_' + k] = OFFICER_ART[k];
  ART[k] = OFFICER_ART[k];
}
// 'tank' would otherwise be ambiguous with the tank_factory naming; make the
// unit win, since buildings are always addressed by their full key.
ART.tank = UNIT_ART.tank;

/** @type {string[]} */
export const ART_KEYS = Object.keys(ART);

const UNIT_KEY_RE = /^(inf|tank|air|arty)([1-8])$/;
const CLASS_FOR_PREFIX = { inf: 'infantry', tank: 'tank', air: 'aircraft', arty: 'artillery' };

/**
 * Turn any game key into `{ key, props }` for the ART registry.
 * Accepts: building keys, `inf3`/`tank7`-style unit keys, unit class names,
 * officer keys (raw / `off_x` / `portrait_x`) and map-tile keys.
 * @param {string} key
 * @param {object} [props]
 * @returns {{key:string, props:object, fn:((p?:object)=>string)|null}}
 */
export function resolveArtKey(key, props) {
  const k = String(key || '');
  const p = Object.assign({}, props);
  const m = UNIT_KEY_RE.exec(k);
  if (m) {
    if (p.tier === undefined) p.tier = Number(m[2]);
    const cls = CLASS_FOR_PREFIX[m[1]];
    return { key: 'unit_' + cls, props: p, fn: UNIT_ART[cls] };
  }
  const fn = ART[k] || null;
  return { key: k, props: p, fn };
}

/** @returns {boolean} */
export function hasIcon(key) {
  return typeof ICONS[key] === 'function';
}

/** @returns {boolean} */
export function hasArt(key) {
  return resolveArtKey(key).fn !== null;
}

/**
 * Parse an SVG markup string into a live <svg> element.
 * (DOMParser keeps us free of innerHTML-on-SVG quirks and works on file://.)
 * @param {string} inner markup for the inside of the svg
 * @param {object} attrs attributes for the root <svg>
 * @returns {SVGElement}
 */
export function svgNode(inner, attrs) {
  const root = svg('svg', attrs);
  const src = '<svg xmlns="http://www.w3.org/2000/svg">' + inner + '</svg>';
  let doc = null;
  try {
    doc = new DOMParser().parseFromString(src, 'image/svg+xml');
  } catch (err) {
    doc = null;
  }
  if (doc && !doc.querySelector('parsererror')) {
    const kids = doc.documentElement.childNodes;
    for (let i = 0; i < kids.length; i++) {
      root.appendChild(document.importNode(kids[i], true));
    }
  } else {
    console.warn('[svg] failed to parse art markup');
  }
  return root;
}

function sizeAttrs(size, view, extra) {
  const s = Number(size) || view;
  const a = {
    viewBox: '0 0 ' + view + ' ' + view,
    width: s,
    height: s,
    'aria-hidden': 'true',
    focusable: 'false'
  };
  return Object.assign(a, extra);
}

/**
 * A 24x24 UI glyph.
 * @param {string} key one of ICON_KEYS
 * @param {number} [size=22] pixel size
 * @param {string} [color] any CSS colour (default: currentColor)
 * @param {string} [cls] extra class names
 * @returns {SVGElement}
 */
export function getIcon(key, size, color, cls) {
  const fn = ICONS[key] || ICONS.warn;
  return svgNode(fn({}), sizeAttrs(size || 22, 24, {
    class: 'ico' + (cls ? ' ' + cls : ''),
    fill: color || 'currentColor'
  }));
}

/**
 * The same glyph as a markup string (for `html:` attributes / innerHTML).
 * @returns {string}
 */
export function iconHTML(key, size, color, cls) {
  const fn = ICONS[key] || ICONS.warn;
  const s = Number(size) || 22;
  return '<svg class="ico' + (cls ? ' ' + cls : '') + '" viewBox="0 0 24 24" width="' + s +
    '" height="' + s + '" fill="' + (color || 'currentColor') +
    '" aria-hidden="true" focusable="false">' + fn({}) + '</svg>';
}

/**
 * A large illustration.
 * @param {string} key building key, unit key (`tank5`) or class, officer key, map tile
 * @param {number} [size=64] pixel size
 * @param {{level?:number, tier?:number, pips?:boolean, frame?:boolean, cls?:string}} [opts]
 * @returns {SVGElement}
 */
export function getArt(key, size, opts) {
  const r = resolveArtKey(key, opts);
  const cls = (opts && opts.cls) || '';
  if (!r.fn) {
    return svgNode(
      rect(6, 6, 88, 88, 'none', 'rx="10" stroke="' + P.steel + '" stroke-width="3" opacity="0.6"') +
      path('M50 26 l22 40 h-44 z', P.steel, 'opacity="0.6"'),
      sizeAttrs(size || 64, VIEW, { class: 'art art--missing' + (cls ? ' ' + cls : '') })
    );
  }
  return svgNode(r.fn(r.props), sizeAttrs(size || 64, VIEW, {
    class: 'art art--' + r.key + (cls ? ' ' + cls : '')
  }));
}

/**
 * The same illustration as a markup string.
 * @returns {string}
 */
export function artHTML(key, size, opts) {
  const r = resolveArtKey(key, opts);
  const s = Number(size) || 64;
  const cls = (opts && opts.cls) || '';
  const inner = r.fn
    ? r.fn(r.props)
    : rect(6, 6, 88, 88, 'none', 'rx="10" stroke="' + P.steel + '" stroke-width="3" opacity="0.6"') +
      path('M50 26 l22 40 h-44 z', P.steel, 'opacity="0.6"');
  return '<svg class="art art--' + (r.fn ? r.key : 'missing') + (cls ? ' ' + cls : '') +
    '" viewBox="0 0 ' + VIEW + ' ' + VIEW + '" width="' + s + '" height="' + s +
    '" aria-hidden="true" focusable="false">' + inner + '</svg>';
}

// ---------------------------------------------------------------------------
// Adapters for the sibling screens (ui/base.js probes for `buildingArt`,
// ui/map.js probes for `tileArt`). Both must return live SVG elements.
// ---------------------------------------------------------------------------

/**
 * Building artwork for the base plot.
 * @param {string} key BUILDING_KEYS entry
 * @param {number|{level?:number,size?:number}} [levelOrOpts]
 * @param {number} [size=100] pixel/user-unit edge
 * @returns {SVGElement} a square <svg> (viewBox 0 0 100 100)
 */
export function buildingArt(key, levelOrOpts, size) {
  const o = (levelOrOpts && typeof levelOrOpts === 'object') ? levelOrOpts : { level: levelOrOpts };
  const px = Number(size) || Number(o.size) || VIEW;
  return getArt(key, px, { level: o.level });
}

/**
 * One square world-map tile (ui/map.js grid, 40 world units per tile).
 * @param {{kind?:string,res?:string,level?:number,terrain?:number}} tile
 * @param {number} [size=40]
 * @returns {SVGElement} <svg x="0" y="0" width=size height=size>
 */
export function tileArt(tile, size) {
  const s = Number(size) || 40;
  return svgNode(squareTile(tile || {}), {
    class: 'wm-tile',
    x: 0, y: 0, width: s, height: s,
    viewBox: '0 0 40 40',
    'aria-hidden': 'true', focusable: 'false'
  });
}

/** Same tile as a markup string. */
export function tileHTML(tile, size) {
  const s = Number(size) || 40;
  return '<svg class="wm-tile" viewBox="0 0 40 40" width="' + s + '" height="' + s +
    '" aria-hidden="true" focusable="false">' + squareTile(tile || {}) + '</svg>';
}

// Re-export the drawing primitives so other ui modules can compose custom art
// (map screen, battle report) in the same visual language.
export { VIEW, poly, rect, circ, path, iso, diamond, ellipseShade, tierTint, levelBadge,
  squareTile, TILE_EMBLEM, TERRAIN_FILL };
