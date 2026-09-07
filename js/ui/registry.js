// js/ui/registry.js — screen registry shared by main.js and every ui/<screen>.js.
// Kept in its own leaf module so ui modules never have to import main.js (cycle risk).
// Exports: SCREENS, SCREEN_ORDER, SCREEN_META, registerScreen, getScreen, hasScreen, listScreens

/**
 * name -> render function. A render function takes no arguments and returns a
 * DOM Node (or a string) that main.js mounts into #view.
 * @type {Object<string, () => (Node|string)>}
 */
export const SCREENS = Object.create(null);

/** Tab order used by the bottom nav and the hash router. */
export const SCREEN_ORDER = ['base', 'map', 'army', 'research', 'officers', 'campaign', 'settings'];

/** Display metadata for the nav (labels; icons live in ui/shell.js). */
export const SCREEN_META = {
  base: { label: 'Base', title: 'Command Base' },
  map: { label: 'Map', title: 'World Map' },
  army: { label: 'Army', title: 'Armed Forces' },
  research: { label: 'Tech', title: 'Research Lab' },
  officers: { label: 'Officers', title: 'Officer Corps' },
  campaign: { label: 'Ops', title: 'Campaign' },
  settings: { label: 'Menu', title: 'Settings' }
};

/**
 * Register a screen renderer. Later registrations replace earlier ones.
 * @param {string} name one of SCREEN_ORDER
 * @param {() => (Node|string)} renderFn
 */
export function registerScreen(name, renderFn) {
  if (typeof name !== 'string' || !name) {
    console.warn('[registry] registerScreen needs a name');
    return;
  }
  if (typeof renderFn !== 'function') {
    console.warn('[registry] renderFn for "' + name + '" is not a function');
    return;
  }
  SCREENS[name] = renderFn;
}

/** @returns {(()=> (Node|string))|null} */
export function getScreen(name) {
  return SCREENS[name] || null;
}

/** @returns {boolean} */
export function hasScreen(name) {
  return typeof SCREENS[name] === 'function';
}

/** @returns {string[]} registered screen names, in SCREEN_ORDER first. */
export function listScreens() {
  const known = SCREEN_ORDER.filter((n) => hasScreen(n));
  const extra = Object.keys(SCREENS).filter((n) => SCREEN_ORDER.indexOf(n) === -1);
  return known.concat(extra);
}
