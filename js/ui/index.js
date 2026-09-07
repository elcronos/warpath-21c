// js/ui/index.js — the single entry point js/main.js imports. It pulls in every
// screen module purely for its registerScreen() side effect; nothing here is
// called directly.
//
// The five panel screens are static imports (they ship together). The base and
// world-map screens are loaded with individually-caught dynamic imports and a
// top-level await, so a single broken screen degrades to main.js's "sector
// coming online" placeholder instead of taking the whole UI layer down with it.
//
// Exports: SCREEN_MODULES, loadErrors

import './army.js';
import './research.js';
import './officers.js';
import './campaign.js';
import './settings.js';

/** Screen modules this file is responsible for importing. */
export const SCREEN_MODULES = [
  './army.js', './research.js', './officers.js', './campaign.js', './settings.js',
  './base.js', './map.js'
];

/** {specifier: Error} for any screen module that failed to load. */
export const loadErrors = {};

const deferred = ['./base.js', './map.js'];

await Promise.all(deferred.map((spec) => import(spec).catch((err) => {
  loadErrors[spec] = err;
  console.warn('[ui] screen module not available: ' + spec, err);
  return null;
})));
