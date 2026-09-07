// js/util/fmt.js — formatting + math + RNG helpers.
// Exports: formatNum, formatTime, formatClock, clamp, lerp, rngFrom, mulberry32, pick, shuffle, uid, roman, pct

const UNITS = [
  { v: 1e12, s: 'T' },
  { v: 1e9, s: 'B' },
  { v: 1e6, s: 'M' },
  { v: 1e3, s: 'K' }
];

/**
 * Format a number compactly: 950 -> "950", 1200 -> "1.2K", 3400000 -> "3.4M".
 * @param {number} n
 * @param {number} [digits=1] decimals used for the compact form
 * @returns {string}
 */
export function formatNum(n, digits = 1) {
  if (n === null || n === undefined || Number.isNaN(Number(n))) return '0';
  // guard against being used directly as an Array#map callback (index -> digits)
  if (!Number.isInteger(digits) || digits < 0 || digits > 2) digits = 1;
  let num = Number(n);
  const neg = num < 0;
  num = Math.abs(num);
  if (num < 1000) {
    const r = num < 10 && num % 1 !== 0 ? Math.round(num * 10) / 10 : Math.round(num);
    return (neg ? '-' : '') + String(r);
  }
  for (let i = 0; i < UNITS.length; i++) {
    const u = UNITS[i];
    if (num < u.v) continue;
    let val = num / u.v;
    let str;
    if (val >= 100) {
      const r = Math.round(val);
      // 999_999 must read as "1M", not "1000K": promote to the next unit.
      if (r >= 1000 && i > 0) {
        const up = UNITS[i - 1];
        return (neg ? '-' : '') + trimZero((num / up.v).toFixed(digits)) + up.s;
      }
      str = String(r);
    } else {
      str = trimZero(val.toFixed(digits));
    }
    return (neg ? '-' : '') + str + u.s;
  }
  return (neg ? '-' : '') + String(Math.round(num));
}

function trimZero(s) {
  if (s.indexOf('.') === -1) return s;
  return s.replace(/\.?0+$/, '');
}

/**
 * Format a duration in seconds as a short human string: "1d 4h", "2h 05m", "12m 30s", "9s".
 * @param {number} sec
 * @returns {string}
 */
export function formatTime(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const d = Math.floor(s / 86400);
  s -= d * 86400;
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (d > 0) return h > 0 ? `${d}d ${h}h` : `${d}d`;
  if (h > 0) return `${h}h ${pad(m)}m`;
  if (m > 0) return `${m}m ${pad(s)}s`;
  return `${s}s`;
}

/**
 * Format seconds as a strict clock: "01:04:09" or "04:09".
 * @param {number} sec
 * @returns {string}
 */
export function formatClock(sec) {
  let s = Math.max(0, Math.floor(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  return h > 0 ? `${pad(h)}:${pad(m)}:${pad(s)}` : `${pad(m)}:${pad(s)}`;
}

function pad(n) {
  return n < 10 ? '0' + n : String(n);
}

/** Clamp v into [lo, hi]. */
export function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Linear interpolation. */
export function lerp(a, b, t) {
  return a + (b - a) * t;
}

/** Percent string helper: pct(0.125) -> "12.5%" */
export function pct(v, digits = 1) {
  return trimZero((Number(v) * 100).toFixed(digits)) + '%';
}

/**
 * mulberry32 PRNG factory. Returns a function producing floats in [0,1).
 * @param {number} seed
 * @returns {() => number}
 */
export function mulberry32(seed) {
  let a = (seed >>> 0) || 1;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Seeded RNG factory accepting a number OR a string seed.
 * @param {number|string} seed
 * @returns {() => number}
 */
export function rngFrom(seed) {
  let s;
  if (typeof seed === 'number' && Number.isFinite(seed)) {
    s = Math.floor(Math.abs(seed)) >>> 0;
  } else {
    const str = String(seed === undefined || seed === null ? 'warpath' : seed);
    s = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      s ^= str.charCodeAt(i);
      s = Math.imul(s, 16777619) >>> 0;
    }
  }
  if (s === 0) s = 1;
  return mulberry32(s);
}

/** Pick a random element from arr using rng (defaults to Math.random). */
export function pick(arr, rng) {
  if (!arr || arr.length === 0) return undefined;
  const r = typeof rng === 'function' ? rng : Math.random;
  return arr[Math.floor(r() * arr.length) % arr.length];
}

/** Return a new shuffled copy of arr (Fisher-Yates) using rng. */
export function shuffle(arr, rng) {
  const r = typeof rng === 'function' ? rng : Math.random;
  const out = arr.slice();
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

let _uidCounter = 0;
/** Short unique id, monotonic within a session. */
export function uid(prefix = 'id') {
  _uidCounter += 1;
  return prefix + '_' + Date.now().toString(36) + '_' + _uidCounter.toString(36);
}

const ROMAN = [
  [1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'],
  [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']
];
/** Roman numeral for 1..3999 (used for unit tiers). */
export function roman(n) {
  let v = Math.max(0, Math.floor(n));
  let out = '';
  for (const [num, sym] of ROMAN) {
    while (v >= num) {
      out += sym;
      v -= num;
    }
  }
  return out || '0';
}
