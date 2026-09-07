// js/ui/svg-art.js — the raw drawing layer: shared palette, iso primitives,
// the 16 building illustrations and the world-map tile art.
// Every function returns a *string of SVG markup* (no outer <svg>), authored in a
// 100x100 user-space box so callers can scale it to any pixel size.
// Exports: PALETTE, VIEW, poly, rect, circ, path, ellipseShade, iso, plate, shade,
//          tierTint, TIER_TINTS, levelBadge, BUILDING_ART, MAP_ART, BUILDING_ART_KEYS,
//          MAP_ART_KEYS
//
// Style rules (kept consistent across every asset):
//   * flat colour only, 2-3 tones per material, no gradients
//   * light comes from the upper right: top face lightest, right face mid, left face darkest
//   * buildings stand on a common iso base plate, front bottom edge around y=82
//   * a level badge may be stamped in the bottom-right corner (see levelBadge)

/** The whole game's colour vocabulary. Olive / steel / amber / dark navy. */
export const PALETTE = {
  // structural neutrals
  ink: '#0b0f15',
  navy: '#1a2230',
  navyLt: '#26334a',
  outline: '#0d141c',

  steelDk: '#3f4b58',
  steel: '#5d6c7c',
  steelLt: '#8b9dae',
  steelHi: '#b6c4d2',

  oliveDk: '#333f24',
  olive: '#4d5f2f',
  oliveLt: '#6f8540',
  oliveHi: '#93a95c',

  concreteDk: '#3a414b',
  concrete: '#525b67',
  concreteLt: '#737e8c',

  amber: '#f0a500',
  amberDk: '#a97600',
  amberLt: '#ffc94d',

  rust: '#8a4b2a',
  rustLt: '#b8683a',
  crimson: '#c23a37',
  crimsonDk: '#8d2624',

  glass: '#4a9df8',
  glassDk: '#25507f',
  smoke: '#8892a0',

  // resource identity colours (match css custom properties)
  oil: '#8f7cff',
  oilDk: '#5b4bb8',
  steelRes: '#9fb3c8',
  steelResDk: '#63788d',
  rare: '#4fd1c5',
  rareDk: '#2b8b83',
  food: '#7bd66a',
  foodDk: '#48944a',
  gold: '#f0a500',
  goldDk: '#a97600',

  // terrain
  grass: '#4e6d3f',
  grassDk: '#3a5330',
  desert: '#bb9c62',
  desertDk: '#94764a',
  urban: '#6b7381',
  urbanDk: '#4d5560',

  // rarity frames (mirrors RARITY in js/data/balance.js)
  rarity: { R: '#5b8dd6', SR: '#a874e8', SSR: '#f0a500' },

  // skin / cloth tones for officer portraits
  skin: '#c98d63',
  skinDk: '#9c6641',
  skinLt: '#e0ac82',
  cloth: '#42505f',
  clothDk: '#2c3742',
  hair: '#2a2320'
};

/** Every art function draws inside this square user space. */
export const VIEW = 100;

// ---------------------------------------------------------------------------
// tiny markup primitives
// ---------------------------------------------------------------------------

/** @param {string} points @param {string} fill @param {string} [extra] raw attrs */
export function poly(points, fill, extra) {
  return '<polygon points="' + points + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
}

export function rect(x, y, w, h, fill, extra) {
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h +
    '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
}

export function circ(cx, cy, r, fill, extra) {
  return '<circle cx="' + cx + '" cy="' + cy + '" r="' + r + '" fill="' + fill + '"' +
    (extra ? ' ' + extra : '') + '/>';
}

export function path(d, fill, extra) {
  return '<path d="' + d + '" fill="' + fill + '"' + (extra ? ' ' + extra : '') + '/>';
}

/** Soft elliptical contact shadow. */
export function ellipseShade(cx, cy, rx, ry, opacity) {
  return '<ellipse cx="' + cx + '" cy="' + cy + '" rx="' + rx + '" ry="' + ry +
    '" fill="#000" opacity="' + (opacity === undefined ? 0.22 : opacity) + '"/>';
}

/**
 * A pseudo-isometric box.
 * @param {number} cx  centre x of the top face
 * @param {number} cy  centre y of the top face
 * @param {number} w   half width of the top face
 * @param {number} d   half depth of the top face
 * @param {number} hgt vertical extrusion downwards
 * @param {[string,string,string]} c [topColour, leftColour, rightColour]
 * @returns {string} three polygons (front-bottom vertex lands at cy + d + hgt)
 */
export function iso(cx, cy, w, d, hgt, c) {
  const top = c[0], left = c[1], right = c[2];
  return (
    poly((cx - w) + ',' + cy + ' ' + cx + ',' + (cy + d) + ' ' + cx + ',' + (cy + d + hgt) + ' ' + (cx - w) + ',' + (cy + hgt), left) +
    poly((cx + w) + ',' + cy + ' ' + cx + ',' + (cy + d) + ' ' + cx + ',' + (cy + d + hgt) + ' ' + (cx + w) + ',' + (cy + hgt), right) +
    poly(cx + ',' + (cy - d) + ' ' + (cx + w) + ',' + cy + ' ' + cx + ',' + (cy + d) + ' ' + (cx - w) + ',' + cy, top)
  );
}

/** A flat iso diamond (roofs, pads, tiles). */
export function diamond(cx, cy, w, d, fill, extra) {
  return poly(cx + ',' + (cy - d) + ' ' + (cx + w) + ',' + cy + ' ' + cx + ',' + (cy + d) + ' ' + (cx - w) + ',' + cy, fill, extra);
}

/** Darkening overlay used to fake ambient occlusion. */
export function shade(points, opacity) {
  return poly(points, '#000', 'opacity="' + (opacity === undefined ? 0.18 : opacity) + '"');
}

/**
 * The shared ground plate every building stands on.
 * @param {string} [top] plate top colour
 * @param {string} [side] plate rim colour
 */
export function plate(top, side) {
  const t = top || PALETTE.oliveDk;
  const s = side || PALETTE.ink;
  return (
    ellipseShade(50, 80, 46, 15, 0.25) +
    poly('4,74 50,92 96,74 96,80 50,98 4,80', s) +
    diamond(50, 74, 46, 18, t) +
    diamond(50, 74, 46, 18, 'none', 'stroke="' + PALETTE.ink + '" stroke-width="1.2" opacity="0.5"') +
    diamond(50, 74, 30, 11.7, '#fff', 'opacity="0.05"')
  );
}

/** Eight-step tint ramp used to distinguish unit tiers 1..8. */
export const TIER_TINTS = [
  { body: '#5c6b3a', dark: '#3a4524', light: '#83955a', trim: '#9aa87a' }, // T1 field olive
  { body: '#54683f', dark: '#33422a', light: '#7e9560', trim: '#a8b98c' }, // T2
  { body: '#4a6350', dark: '#2c3f34', light: '#71906f', trim: '#9fc0a4' }, // T3
  { body: '#455f6b', dark: '#293c46', light: '#6c8c9b', trim: '#a3bfcd' }, // T4
  { body: '#3f5670', dark: '#26364a', light: '#63819f', trim: '#9db6d1' }, // T5
  { body: '#414a72', dark: '#272c48', light: '#66719f', trim: '#a2a9d3' }, // T6
  { body: '#4d4368', dark: '#2f2942', light: '#7a6c9c', trim: '#c0a8e0' }, // T7
  { body: '#5c4630', dark: '#372a1d', light: '#9c7846', trim: '#ffc94d' }  // T8 gilded
];

/**
 * @param {number} tier 1..8 (clamped)
 * @returns {{body:string,dark:string,light:string,trim:string}}
 */
export function tierTint(tier) {
  const t = Math.max(1, Math.min(8, Math.round(Number(tier) || 1)));
  return TIER_TINTS[t - 1];
}

/**
 * Level badge stamped in the bottom-right corner of an art tile.
 * @param {number|string} level
 * @param {string} [accent]
 */
export function levelBadge(level, accent) {
  const a = accent || PALETTE.amber;
  const txt = String(level);
  const fs = txt.length > 2 ? 11 : 14;
  return (
    circ(83, 83, 13, PALETTE.ink, 'opacity="0.92"') +
    circ(83, 83, 13, 'none', 'stroke="' + a + '" stroke-width="2"') +
    '<text x="83" y="' + (83 + fs * 0.36) + '" text-anchor="middle" font-size="' + fs +
    '" font-weight="700" font-family="system-ui,-apple-system,Segoe UI,Roboto,sans-serif" fill="' + a + '">' +
    txt + '</text>'
  );
}

// ---------------------------------------------------------------------------
// buildings — keys match BUILDING_KEYS in js/data/buildings.js
// ---------------------------------------------------------------------------

const P = PALETTE;

function windowsRow(x, y, n, gap, w, hgt, fill) {
  let out = '';
  for (let i = 0; i < n; i++) out += rect(x + i * gap, y + i * (gap * 0.39), w, hgt, fill);
  return out;
}

/** Flag on a pole, drawn from (x,y) upwards. */
function flag(x, y, hgt, cloth) {
  return (
    rect(x - 0.9, y - hgt, 1.8, hgt, P.steelLt) +
    poly(x + 0.9 + ',' + (y - hgt) + ' ' + (x + 14) + ',' + (y - hgt + 4) + ' ' + (x + 0.9) + ',' + (y - hgt + 9), cloth || P.crimson)
  );
}

export const BUILDING_ART = {
  /** Headquarters — stepped command block with tower, flag and lit entrance. */
  hq(p) {
    return plate(P.oliveDk) +
      iso(50, 50, 27, 11, 26, [P.olive, P.oliveDk, P.oliveLt]) +
      // right-face windows
      windowsRow(54, 55, 3, 7, 4.5, 6, P.glassDk) +
      windowsRow(54, 66, 3, 7, 4.5, 5, P.glass) +
      // left-face shading + door
      shade('23,50 50,61 50,87 23,76', 0.12) +
      rect(31, 62, 10, 15, P.ink) +
      rect(33, 64, 6, 13, P.amberDk) +
      // tower
      iso(50, 26, 12, 5, 20, [P.oliveLt, P.oliveDk, P.olive]) +
      rect(45, 30, 4, 8, P.glass) +
      rect(51, 30, 4, 8, P.glassDk) +
      diamond(50, 24, 14, 6, P.steelDk) +
      flag(50, 20, 16, P.crimson) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Oil well — lattice derrick, pump jack and a storage drum. */
  oil_well(p) {
    return plate('#4a4436') +
      // storage drum (left)
      iso(24, 60, 11, 5, 16, [P.steelLt, P.steelDk, P.steel]) +
      rect(19, 64, 10, 3, P.oilDk) +
      // derrick
      poly('58,22 66,74 50,74', P.steelDk) +
      poly('58,22 50,74 42,74', P.steel) +
      rect(46, 44, 24, 2.4, P.steelLt) +
      rect(47.5, 56, 21, 2.4, P.steelLt) +
      poly('52,30 64,58 62,58 50,30', P.steelLt, 'opacity="0.55"') +
      poly('64,30 52,58 54,58 66,30', P.steelLt, 'opacity="0.55"') +
      diamond(56, 74, 22, 9, P.concreteDk) +
      // pump jack arm + oil pool
      rect(60, 40, 3, 26, P.steelDk) +
      poly('40,44 74,38 74,42 40,48', P.amberDk) +
      circ(40, 46, 3.4, P.steelLt) +
      '<path d="M40 47 L40 68" stroke="' + P.ink + '" stroke-width="2" fill="none"/>' +
      '<ellipse cx="40" cy="70" rx="9" ry="4" fill="' + P.oilDk + '"/>' +
      '<ellipse cx="40" cy="69" rx="6" ry="2.6" fill="' + P.oil + '"/>' +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Steel mill — furnace hall, twin stacks, glowing tap hole. */
  steel_mill(p) {
    return plate('#3f4148') +
      // stacks (behind)
      iso(28, 24, 6, 2.6, 40, [P.steelLt, P.steelDk, P.steel]) +
      iso(41, 30, 5, 2.2, 34, [P.steelLt, P.steelDk, P.steel]) +
      rect(23, 30, 10, 3, P.rust) +
      rect(36.5, 35, 9, 3, P.rust) +
      circ(28, 18, 6, P.smoke, 'opacity="0.4"') +
      circ(34, 13, 4.5, P.smoke, 'opacity="0.28"') +
      // main hall
      iso(56, 48, 24, 10, 28, [P.steel, P.steelDk, P.steelLt]) +
      // saw-tooth roof
      poly('34,48 42,42 50,48 58,42 66,48 74,42 80,45 80,48', P.concreteDk) +
      // furnace mouth
      rect(60, 60, 14, 12, P.ink) +
      rect(62, 62, 10, 10, P.amber) +
      rect(63.5, 64, 7, 8, P.amberLt) +
      // ladle + rail
      rect(36, 66, 16, 2.5, P.steelDk) +
      circ(44, 62, 5, P.steelDk) +
      circ(44, 62, 3, P.amberDk) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Rare earth mine — rock mound, timbered adit, exposed crystal seam. */
  rare_mine(p) {
    return plate('#42413a') +
      // rock mound
      poly('16,72 34,38 52,30 74,44 86,72', P.concreteDk) +
      poly('52,30 74,44 86,72 58,72', P.concrete) +
      poly('34,38 52,30 58,72 40,72', P.concreteLt, 'opacity="0.5"') +
      // adit
      path('M38 72 v-14 a10 10 0 0 1 20 0 v14 z', P.ink) +
      path('M41 72 v-13 a7 7 0 0 1 14 0 v13 z', '#000', 'opacity="0.85"') +
      rect(36, 42, 24, 3.5, P.rust) +
      rect(37, 45, 3.5, 27, P.rust) +
      rect(55.5, 45, 3.5, 27, P.rust) +
      // crystal seam
      poly('70,52 76,40 82,52 76,62', P.rare) +
      poly('76,40 82,52 76,62', P.rareDk) +
      poly('62,58 66,50 70,58 66,66', P.rare, 'opacity="0.85"') +
      // mine cart
      rect(24, 62, 14, 8, P.steelDk) +
      poly('24,62 38,62 36,58 26,58', P.rareDk) +
      circ(27, 71, 2.6, P.ink) +
      circ(35, 71, 2.6, P.ink) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Farm — ploughed field, barn with pitched roof, grain silo. */
  farm(p) {
    return plate('#4b5c31') +
      // furrows on the plate
      '<path d="M18 74 L50 60 M26 79 L58 65 M34 84 L66 70" stroke="' + P.oliveDk +
      '" stroke-width="2.4" opacity="0.65" fill="none" stroke-linecap="round"/>' +
      // silo
      rect(20, 40, 15, 32, P.steelLt) +
      rect(20, 40, 6, 32, P.steel) +
      path('M20 40 a7.5 5 0 0 1 15 0 z', P.steelDk) +
      rect(20, 52, 15, 2.5, P.steel) +
      // barn
      iso(60, 48, 22, 9, 24, [P.rustLt, P.crimsonDk, P.rust]) +
      poly('38,48 60,39 82,48 60,57', P.concreteDk) +
      poly('60,39 82,48 82,50 60,41', P.concrete) +
      // barn doors
      poly('54,60 66,60 66,74 54,74', P.rust) +
      '<path d="M54 60 L66 74 M66 60 L54 74" stroke="' + P.amberLt + '" stroke-width="1.6" opacity="0.75" fill="none"/>' +
      // crop rows in front
      circ(44, 74, 3, P.food) + circ(50, 78, 3, P.foodDk) + circ(56, 82, 3, P.food) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Warehouse — long shed, roller door, stacked crates. */
  warehouse(p) {
    return plate('#3d4750') +
      iso(52, 46, 30, 12, 26, [P.steel, P.steelDk, P.steelLt]) +
      // corrugation on the right face
      '<path d="M56 50 L56 78 M62 52 L62 80 M68 55 L68 82 M74 58 L74 82" stroke="' + P.steelDk +
      '" stroke-width="1.4" opacity="0.6" fill="none"/>' +
      // roller door
      rect(32, 58, 18, 20, P.concreteDk) +
      rect(34, 60, 14, 16, P.amberDk) +
      '<path d="M34 64 h14 M34 68 h14 M34 72 h14" stroke="' + P.ink + '" stroke-width="1.2" opacity="0.6" fill="none"/>' +
      // crates
      iso(22, 64, 8, 3.5, 9, [P.oliveHi, P.oliveDk, P.olive]) +
      iso(78, 62, 8, 3.5, 9, [P.oliveHi, P.oliveDk, P.olive]) +
      iso(78, 52, 6, 2.6, 7, [P.oliveHi, P.oliveDk, P.olive]) +
      rect(72, 66, 12, 2, P.amberDk) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Trade centre — market pavilion with awning, gold stacks and a comms mast. */
  trade_center(p) {
    return plate('#43424c') +
      iso(52, 46, 24, 10, 24, [P.concreteLt, P.concreteDk, P.concrete]) +
      // awning
      poly('26,52 52,42 78,52 78,56 52,46 26,56', P.amberDk) +
      poly('26,52 52,42 78,52 52,62', P.amber) +
      '<path d="M34 55 L60 45 M42 59 L68 49" stroke="' + P.crimsonDk + '" stroke-width="2.6" opacity="0.8" fill="none"/>' +
      // counter + coins
      rect(38, 62, 26, 4, P.concreteDk) +
      circ(44, 60, 4, P.gold) + circ(44, 57.5, 4, P.goldDk) + circ(44, 55.5, 4, P.gold) +
      circ(56, 60, 4, P.goldDk) + circ(56, 58, 4, P.gold) +
      // mast
      rect(75, 24, 2, 24, P.steelLt) +
      circ(76, 22, 3.2, P.amberLt) +
      '<path d="M70 26 a8 8 0 0 1 12 0" stroke="' + P.amber + '" stroke-width="1.6" fill="none" opacity="0.8"/>' +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Barracks — bunkhouse block with sandbags, flag and drill square. */
  barracks(p) {
    return plate(P.oliveDk) +
      iso(52, 48, 26, 11, 22, [P.olive, P.oliveDk, P.oliveLt]) +
      // half-round roof
      path('M26 48 a26 10 0 0 1 52 0 z', P.oliveHi) +
      path('M52 38 a26 10 0 0 1 26 10 l-26 0 z', P.oliveLt) +
      // door + windows
      rect(46, 58, 12, 16, P.ink) +
      rect(48, 60, 8, 14, P.oliveDk) +
      rect(62, 56, 6, 6, P.glassDk) + rect(70, 60, 6, 6, P.glassDk) +
      rect(32, 56, 6, 6, P.glassDk) +
      // sandbag wall
      circ(28, 72, 4, P.oliveHi) + circ(35, 75, 4, P.olive) + circ(42, 78, 4, P.oliveHi) +
      circ(31.5, 68, 4, P.olive) + circ(38.5, 71, 4, P.oliveHi) +
      flag(80, 52, 22, P.crimson) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Tank factory — assembly hall with chevron door and a hull rolling out. */
  tank_factory(p) {
    return plate('#3f4348') +
      iso(54, 44, 28, 11, 28, [P.steelDk, P.ink, P.steel]) +
      // roof vents
      diamond(54, 44, 28, 11, P.concreteDk) +
      rect(40, 38, 8, 4, P.steelLt) + rect(56, 44, 8, 4, P.steelLt) +
      // chevron shutter
      rect(30, 52, 22, 26, P.ink) +
      poly('32,60 41,54 50,60 50,64 41,58 32,64', P.amber) +
      poly('32,70 41,64 50,70 50,74 41,68 32,74', P.amberDk) +
      // tank hull leaving the bay
      rect(20, 72, 26, 8, P.oliveDk) +
      poly('22,72 44,72 41,66 26,66', P.olive) +
      rect(34, 62, 12, 5, P.oliveLt) +
      rect(44, 63, 14, 2.4, P.oliveDk) +
      circ(24, 81, 3.2, P.ink) + circ(32, 81, 3.2, P.ink) + circ(40, 81, 3.2, P.ink) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Aircraft hangar — barrel-vault hangar, jet nose in the doorway, apron stripe. */
  hangar(p) {
    return plate('#42474f') +
      // apron marking
      poly('12,80 34,70 40,73 18,83', P.amberDk, 'opacity="0.6"') +
      // hangar shell
      path('M20 78 v-16 a30 22 0 0 1 60 0 v16 z', P.steelDk) +
      path('M50 40 a30 22 0 0 1 30 22 v16 h-30 z', P.steel) +
      '<path d="M28 78 v-16 a22 18 0 0 1 44 0 v16" fill="' + P.ink + '"/>' +
      '<path d="M32 78 v-15 a18 15 0 0 1 36 0 v15 z" fill="#05080c"/>' +
      // jet nose emerging
      poly('50,58 62,68 50,74 38,68', P.steelHi) +
      poly('50,58 62,68 50,74', P.steelLt) +
      poly('30,66 50,70 30,74', P.steelLt) +
      poly('70,66 50,70 70,74', P.steel) +
      circ(50, 66, 2.6, P.glass) +
      // roof ribs
      '<path d="M38 42 a30 22 0 0 0 -14 20 M62 42 a30 22 0 0 1 14 20" stroke="' + P.steelLt +
      '" stroke-width="1.6" fill="none" opacity="0.7"/>' +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Artillery range — bunker emplacement with an elevated howitzer and target berm. */
  artillery_range(p) {
    return plate('#4a4a34') +
      // target berm (back)
      path('M62 62 a20 12 0 0 1 34 0 z', P.oliveDk) +
      circ(79, 58, 8, P.concreteLt) + circ(79, 58, 5.4, P.crimson) + circ(79, 58, 2.4, P.concreteLt) +
      // bunker
      iso(40, 54, 22, 9, 18, [P.concrete, P.concreteDk, P.concreteLt]) +
      rect(24, 58, 32, 5, P.ink) +
      // sandbag lip
      circ(22, 72, 4, P.oliveHi) + circ(29, 75, 4, P.olive) + circ(36, 77, 4, P.oliveHi) +
      // howitzer
      circ(46, 56, 7, P.oliveDk) +
      rect(44, 50, 5, 8, P.olive) +
      '<path d="M48 52 L78 32" stroke="' + P.steelDk + '" stroke-width="5" stroke-linecap="round" fill="none"/>' +
      '<path d="M48 52 L78 32" stroke="' + P.steelLt + '" stroke-width="2" stroke-linecap="round" fill="none"/>' +
      circ(78, 32, 3.4, P.ink) +
      poly('40,58 34,70 52,70 48,58', P.oliveDk) +
      circ(37, 71, 3.4, P.ink) + circ(51, 71, 3.4, P.ink) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Wall — crenellated rampart with a gate and two corner towers. */
  wall(p) {
    const merlon = (x, y) => rect(x, y, 6, 6, P.concreteLt) + rect(x, y + 5, 6, 3, P.concrete);
    return plate('#41454d') +
      // rampart runs from lower-left to upper-right
      poly('10,64 50,46 90,64 90,74 50,92 10,74', P.concreteDk) +
      poly('50,46 90,64 90,74 50,84', P.concrete) +
      poly('10,64 50,46 50,84 10,74', P.concreteDk) +
      diamond(50, 55, 40, 18, P.concreteLt, 'opacity="0.35"') +
      merlon(16, 58) + merlon(28, 52) + merlon(64, 52) + merlon(76, 58) +
      // gate
      path('M40 84 v-16 a10 10 0 0 1 20 0 v16 z', P.ink) +
      path('M43 84 v-15 a7 7 0 0 1 14 0 v15 z', P.rust) +
      '<path d="M43 74 h14 M50 62 v22" stroke="' + P.ink + '" stroke-width="1.4" fill="none" opacity="0.7"/>' +
      // towers
      iso(14, 52, 9, 4, 18, [P.concreteLt, P.concreteDk, P.concrete]) +
      iso(86, 52, 9, 4, 18, [P.concreteLt, P.concreteDk, P.concrete]) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Research lab — glass block with observation dome and dish antenna. */
  lab(p) {
    return plate('#3a4150') +
      iso(50, 50, 25, 10, 26, [P.navyLt, P.navy, P.steelDk]) +
      // glass curtain wall
      rect(52, 54, 20, 22, P.glassDk) +
      '<path d="M58 54 v24 M64 56 v22 M52 62 h20 M52 70 h20" stroke="' + P.navy + '" stroke-width="1.2" fill="none"/>' +
      rect(53, 55, 5, 8, P.glass, 'opacity="0.8"') +
      rect(30, 58, 16, 18, P.navy) +
      rect(32, 60, 5, 7, P.glass, 'opacity="0.6"') +
      // dome
      path('M36 42 a14 12 0 0 1 28 0 z', P.steelLt) +
      path('M50 30 a14 12 0 0 1 14 12 h-14 z', P.steel) +
      '<path d="M50 30 v12 M38 39 h24" stroke="' + P.steelDk + '" stroke-width="1.4" fill="none"/>' +
      circ(50, 28, 3, P.rare) +
      // dish
      '<path d="M72 44 a9 9 0 1 0 -0.1 -0.1 z" fill="' + P.steelLt + '"/>' +
      circ(72, 44, 5.4, P.steelDk) +
      rect(71, 44, 2, 12, P.steelDk) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Hospital — clean-lined block with a red cross and an ambulance bay. */
  hospital(p) {
    return plate('#454b53') +
      iso(52, 46, 25, 10, 26, [P.steelHi, P.steel, P.steelLt]) +
      // cross panel
      rect(58, 50, 16, 16, '#eef3f7') +
      rect(64.5, 52, 3.5, 12, P.crimson) +
      rect(60, 56.5, 12.5, 3.5, P.crimson) +
      // window bands
      rect(58, 68, 16, 4, P.glassDk) +
      rect(32, 54, 16, 4, P.glassDk) + rect(32, 62, 16, 4, P.glassDk) +
      // ambulance bay + vehicle
      rect(28, 70, 26, 3, P.concreteDk) +
      rect(24, 62, 18, 10, '#eef3f7') +
      poly('42,62 50,62 52,68 42,68', '#dfe7ee') +
      rect(29, 64, 6, 4, P.glassDk) +
      rect(30, 66, 8, 2.4, P.crimson) +
      circ(30, 73, 3.2, P.ink) + circ(46, 73, 3.2, P.ink) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Officer academy — colonnaded hall with pediment, star crest and banners. */
  academy(p) {
    return plate('#454334') +
      iso(50, 50, 26, 10, 22, [P.concreteLt, P.concreteDk, P.concrete]) +
      // pediment
      poly('22,50 50,38 78,50 50,60', P.concreteLt) +
      poly('50,38 78,50 50,60', P.concrete) +
      poly('34,50 50,43 66,50 50,56', P.amberDk, 'opacity="0.55"') +
      // columns on the right face
      rect(56, 56, 4, 18, P.concreteLt) + rect(63, 59, 4, 18, P.concreteLt) +
      rect(70, 62, 4, 16, P.concreteLt) +
      rect(30, 56, 4, 18, P.concreteDk) + rect(37, 59, 4, 18, P.concreteDk) +
      // steps + doorway
      rect(44, 62, 12, 16, P.ink) +
      poly('38,78 62,78 66,82 34,82', P.concrete) +
      // star crest
      path('M50 30 l3.2 6.6 7.3 1-5.3 5.1 1.3 7.2-6.5-3.4-6.5 3.4 1.3-7.2-5.3-5.1 7.3-1z', P.amber) +
      // banners
      poly('24,54 30,54 30,70 27,66 24,70', P.crimson) +
      poly('70,54 76,54 76,70 73,66 70,70', P.crimson) +
      (p && p.level ? levelBadge(p.level) : '');
  },

  /** Radar station — lattice mast, rotating dish and a signals bunker. */
  radar(p) {
    return plate('#3c4450') +
      // bunker
      iso(36, 62, 18, 8, 14, [P.concrete, P.concreteDk, P.concreteLt]) +
      rect(24, 66, 10, 4, P.glassDk) +
      // mast
      poly('60,34 66,72 54,72', P.steelDk) +
      poly('60,34 62,72 58,72', P.steel) +
      '<path d="M56 46 L64 46 M55 56 L65 56 M54 66 L66 66" stroke="' + P.steelLt + '" stroke-width="1.6" fill="none"/>' +
      // dish
      '<path d="M46 20 a16 16 0 0 1 26 12 l-24 8 z" fill="' + P.steelLt + '"/>' +
      '<path d="M50 24 a11 11 0 0 1 18 8 l-17 5 z" fill="' + P.steelDk + '"/>' +
      rect(57, 30, 3, 10, P.steel) +
      circ(60, 32, 2.6, P.amberLt) +
      // signal arcs
      '<path d="M74 22 a14 14 0 0 1 0 18" stroke="' + P.rare + '" stroke-width="2" fill="none" opacity="0.85"/>' +
      '<path d="M80 17 a21 21 0 0 1 0 28" stroke="' + P.rare + '" stroke-width="2" fill="none" opacity="0.5"/>' +
      (p && p.level ? levelBadge(p.level) : '');
  }
};

/** @type {string[]} */
export const BUILDING_ART_KEYS = Object.keys(BUILDING_ART);

// ---------------------------------------------------------------------------
// world-map tiles — drawn as diamonds filling the 100x100 box
// ---------------------------------------------------------------------------

function groundTile(top, side, speckle) {
  return (
    poly('2,50 50,26 98,50 98,58 50,82 2,58', side) +
    diamond(50, 50, 48, 24, top) +
    (speckle || '')
  );
}

export const MAP_ART = {
  /** Plain grassland tile. */
  tile_grass() {
    return groundTile(P.grass, P.grassDk,
      circ(34, 48, 3.4, P.grassDk, 'opacity="0.8"') +
      circ(62, 56, 4, P.grassDk, 'opacity="0.65"') +
      circ(50, 40, 2.6, '#6f8f52', 'opacity="0.7"'));
  },

  /** Arid / desert tile. */
  tile_desert() {
    return groundTile(P.desert, P.desertDk,
      '<path d="M22 52 q10 -5 20 0 M54 60 q10 -5 20 0 M40 44 q8 -4 16 0" stroke="' + P.desertDk +
      '" stroke-width="2" fill="none" opacity="0.7"/>');
  },

  /** Ruined-urban ground tile. */
  tile_urban() {
    return groundTile(P.urban, P.urbanDk,
      rect(30, 44, 14, 8, P.urbanDk, 'opacity="0.8"') +
      rect(54, 52, 16, 8, P.urbanDk, 'opacity="0.6"') +
      '<path d="M14 52 L50 34 L86 52" stroke="' + P.concreteLt + '" stroke-width="1.4" fill="none" opacity="0.35"/>');
  },

  /** Oil field node. */
  node_oil(p) {
    return MAP_ART.tile_desert() +
      poly('50,26 60,58 40,58', P.steelDk) +
      rect(44, 44, 12, 2, P.steelLt) +
      '<ellipse cx="50" cy="62" rx="14" ry="6" fill="' + P.oilDk + '"/>' +
      '<ellipse cx="50" cy="60" rx="9" ry="3.6" fill="' + P.oil + '"/>' +
      (p && p.level ? levelBadge(p.level, P.oil) : '');
  },

  /** Scrap / steel node. */
  node_steel(p) {
    return MAP_ART.tile_urban() +
      iso(46, 44, 16, 7, 12, [P.steelLt, P.steelDk, P.steelRes]) +
      poly('30,58 50,50 70,58 50,66', P.steelResDk) +
      rect(58, 46, 14, 3, P.steel) +
      rect(34, 52, 12, 3, P.steelLt) +
      (p && p.level ? levelBadge(p.level, P.steelRes) : '');
  },

  /** Rare-earth node. */
  node_rare(p) {
    return MAP_ART.tile_grass() +
      poly('50,22 62,48 50,64 38,48', P.rare) +
      poly('50,22 62,48 50,64', P.rareDk) +
      poly('34,44 42,30 50,44 42,58', P.rare, 'opacity="0.85"') +
      poly('60,46 66,36 72,46 66,56', P.rareDk) +
      (p && p.level ? levelBadge(p.level, P.rare) : '');
  },

  /** Farmland node. */
  node_food(p) {
    return MAP_ART.tile_grass() +
      diamond(50, 50, 34, 17, P.foodDk) +
      '<path d="M24 50 L50 37 M32 55 L58 42 M40 60 L66 47 M48 65 L74 52" stroke="' + P.food +
      '" stroke-width="3" fill="none" opacity="0.9" stroke-linecap="round"/>' +
      poly('62,36 70,32 70,42 62,46', P.rust) +
      (p && p.level ? levelBadge(p.level, P.food) : '');
  },

  /**
   * Hostile NPC camp. `p.level` scales the threat tint and the number of tents.
   */
  npc_camp(p) {
    const lvl = Math.max(1, Math.min(30, (p && p.level) || 1));
    const tierIdx = Math.min(7, Math.floor((lvl - 1) / 4));
    const t = TIER_TINTS[tierIdx];
    const tents = lvl >= 20 ? 3 : lvl >= 9 ? 2 : 1;
    let camp = '';
    const spots = [[50, 42], [34, 52], [66, 52]];
    for (let i = 0; i < tents; i++) {
      const x = spots[i][0], y = spots[i][1];
      camp += poly((x - 11) + ',' + (y + 12) + ' ' + x + ',' + (y - 8) + ' ' + (x + 11) + ',' + (y + 12), t.body) +
        poly(x + ',' + (y - 8) + ' ' + (x + 11) + ',' + (y + 12) + ' ' + x + ',' + (y + 12), t.dark) +
        poly((x - 3) + ',' + (y + 12) + ' ' + x + ',' + (y + 2) + ' ' + (x + 3) + ',' + (y + 12), P.ink);
    }
    return MAP_ART.tile_grass() +
      diamond(50, 52, 40, 20, P.ink, 'opacity="0.25"') +
      camp +
      poly('20,44 20,30 34,34 20,38', P.crimson) +
      rect(19, 30, 1.8, 22, P.steelLt) +
      (p && p.level ? levelBadge(lvl, t.trim) : '');
  },

  /** Ruins — free loot / exploration site. */
  ruins(p) {
    return MAP_ART.tile_urban() +
      poly('28,58 28,34 38,32 38,58', P.concrete) +
      poly('38,32 46,36 46,58 38,58', P.concreteDk) +
      poly('56,58 56,40 66,36 66,58', P.concreteLt) +
      poly('66,36 72,40 72,58 66,58', P.concrete) +
      rect(46, 50, 12, 3.4, P.concreteDk) +
      circ(50, 62, 3, P.concreteDk) + circ(60, 64, 2.4, P.concrete) +
      (p && p.level ? levelBadge(p.level, P.concreteLt) : '');
  },

  /** The player's own city marker. */
  city_player(p) {
    return MAP_ART.tile_grass() +
      diamond(50, 52, 40, 20, P.oliveDk) +
      iso(50, 36, 16, 7, 16, [P.oliveLt, P.oliveDk, P.olive]) +
      iso(30, 50, 9, 4, 10, [P.oliveLt, P.oliveDk, P.olive]) +
      iso(70, 50, 9, 4, 10, [P.oliveLt, P.oliveDk, P.olive]) +
      rect(45, 46, 10, 10, P.amberDk) +
      poly('50,10 50,26 66,18', P.amber) +
      rect(49, 10, 2, 20, P.steelLt) +
      (p && p.level ? levelBadge(p.level) : '');
  }
};

/** @type {string[]} */
export const MAP_ART_KEYS = Object.keys(MAP_ART);

// ---------------------------------------------------------------------------
// Square world-map tiles (40x40) — used by ui/map.js, whose grid is square.
// MAP_ART above stays the isometric "poster" version of the same subjects.
// ---------------------------------------------------------------------------

/** Ground colours by tile.terrain (0..3). */
export const TERRAIN_FILL = ['#2a3a2c', '#3b3527', '#2c313a', '#233043'];
export const TERRAIN_SPECK = ['#3a4a37', '#4a4231', '#394050', '#2e3d52'];

/** Emblems drawn inside a 0 0 40 40 box, centred on (20,20). */
export const TILE_EMBLEM = {
  oil: () => poly('20,8 26,26 14,26', P.steelDk) +
    rect(16, 16, 8, 1.6, P.steelLt) +
    '<ellipse cx="20" cy="28" rx="8" ry="3.4" fill="' + P.oilDk + '"/>' +
    '<ellipse cx="20" cy="27.2" rx="5" ry="2" fill="' + P.oil + '"/>',
  steel: () => poly('8,26 32,26 28,20 12,20', P.steelResDk) +
    poly('12,20 28,20 25,14 15,14', P.steelRes) +
    rect(14, 22, 12, 1.6, P.steelHi, 'opacity="0.6"'),
  rare: () => poly('20,6 27,20 20,32 13,20', P.rare) +
    poly('20,6 27,20 20,32', P.rareDk) +
    poly('9,18 13,10 17,18 13,26', P.rare, 'opacity="0.8"'),
  food: () => rect(7, 12, 26, 16, P.foodDk, 'rx="2"') +
    '<path d="M9 26 L20 14 M15 28 L26 16 M21 30 L32 18" stroke="' + P.food +
    '" stroke-width="2.4" stroke-linecap="round" fill="none"/>',
  npc: (p) => {
    const lvl = Math.max(1, Math.min(30, (p && p.level) || 1));
    const t = TIER_TINTS[Math.min(7, Math.floor((lvl - 1) / 4))];
    return poly('20,8 30,28 10,28', t.body) +
      poly('20,8 30,28 20,28', t.dark) +
      poly('17.5,28 20,18 22.5,28', P.ink) +
      rect(7.4, 8, 1.4, 14, P.steelLt) +
      poly('8.8,8 16,10.5 8.8,13', P.crimson);
  },
  ruins: () => poly('9,29 9,14 14,12 14,29', P.concrete) +
    poly('14,12 18,14 18,29 14,29', P.concreteDk) +
    poly('23,29 23,17 28,15 28,29', P.concreteLt) +
    poly('28,15 32,17 32,29 28,29', P.concrete) +
    rect(18, 22, 5, 1.8, P.concreteDk),
  city: () => rect(8, 16, 24, 14, P.oliveDk, 'rx="2"') +
    rect(12, 12, 16, 12, P.olive) +
    rect(17, 20, 6, 8, P.amberDk) +
    rect(19.2, 2, 1.6, 12, P.steelLt) +
    poly('20.8,3 30,6.5 20.8,10', P.amber)
};

/**
 * A complete square map tile: ground + optional emblem.
 * @param {{kind?:string,res?:string,level?:number,terrain?:number}} tile
 * @returns {string} markup for a 0 0 40 40 viewBox
 */
export function squareTile(tile) {
  const t = tile || {};
  const ti = Math.abs((t.terrain | 0)) % 4;
  let out = rect(0.5, 0.5, 39, 39, TERRAIN_FILL[ti], 'rx="3" stroke="#243040" stroke-width="1"') +
    circ(8, 31, 1.2, TERRAIN_SPECK[ti], 'opacity="0.9"') +
    circ(32, 9, 1.2, TERRAIN_SPECK[ti], 'opacity="0.7"');
  const kind = String(t.kind || 'empty');
  if (kind === 'resource') out += (TILE_EMBLEM[t.res] || TILE_EMBLEM.steel)(t);
  else if (kind === 'npc') out += TILE_EMBLEM.npc(t);
  else if (kind === 'ruins') out += TILE_EMBLEM.ruins(t);
  else if (kind === 'city') out += TILE_EMBLEM.city(t);
  return out;
}
