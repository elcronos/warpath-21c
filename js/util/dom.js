// js/util/dom.js — DOM/SVG construction helpers used by every ui module.
// Exports: h, svg, frag, clear, mount, el (alias h), text, qs, qsa, setAttrs, on

const SVG_NS = 'http://www.w3.org/2000/svg';

/**
 * Apply attributes/props to an element.
 * Supported keys:
 *   class / className : string | array | object {name:boolean}
 *   style             : string | object (camelCase or kebab-case keys)
 *   dataset           : object -> data-* attributes
 *   onclick / on*     : function -> addEventListener('click', fn)
 *   html              : innerHTML (only use with trusted strings)
 *   ref               : function called with the element
 *   value/checked/disabled/selected : set as properties
 *   anything else     : setAttribute (null/undefined/false skipped)
 * @param {Element} node
 * @param {object} attrs
 */
export function setAttrs(node, attrs) {
  if (!attrs) return node;
  for (const key in attrs) {
    if (!Object.prototype.hasOwnProperty.call(attrs, key)) continue;
    const val = attrs[key];
    if (val === null || val === undefined || val === false) {
      if (key === 'class' || key === 'className' || key === 'style' ||
          key === 'dataset' || key === 'html' || key === 'ref') continue;
      if (key.length > 2 && key.slice(0, 2) === 'on') continue;
      continue;
    }
    if (key === 'class' || key === 'className') {
      const cls = classString(val);
      if (cls) node.setAttribute('class', cls);
      continue;
    }
    if (key === 'style') {
      if (typeof val === 'string') {
        node.setAttribute('style', val);
      } else {
        for (const p in val) {
          if (!Object.prototype.hasOwnProperty.call(val, p)) continue;
          const v = val[p];
          if (v === null || v === undefined) continue;
          if (p.indexOf('-') >= 0 || p.indexOf('--') === 0) node.style.setProperty(p, String(v));
          else node.style[p] = v;
        }
      }
      continue;
    }
    if (key === 'dataset') {
      for (const d in val) {
        if (!Object.prototype.hasOwnProperty.call(val, d)) continue;
        if (val[d] === null || val[d] === undefined) continue;
        node.setAttribute('data-' + camelToKebab(d), String(val[d]));
      }
      continue;
    }
    if (key === 'html') {
      node.innerHTML = String(val);
      continue;
    }
    if (key === 'ref') {
      if (typeof val === 'function') val(node);
      continue;
    }
    if (key.length > 2 && key.slice(0, 2) === 'on' && typeof val === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), val);
      continue;
    }
    if (key === 'value' || key === 'checked' || key === 'selected') {
      node[key] = val;
      continue;
    }
    if (key === 'disabled') {
      if (val) node.setAttribute('disabled', '');
      continue;
    }
    if (key === 'xlinkHref') {
      node.setAttributeNS('http://www.w3.org/1999/xlink', 'href', String(val));
      continue;
    }
    node.setAttribute(camelToAttr(key), val === true ? '' : String(val));
  }
  return node;
}

function camelToKebab(s) {
  return s.replace(/([A-Z])/g, (m) => '-' + m.toLowerCase());
}

// SVG attributes are mostly kebab/colon already; only convert well-known camel forms.
const KEEP_CAMEL = /^(viewBox|preserveAspectRatio|patternUnits|gradientUnits|gradientTransform|markerWidth|markerHeight|refX|refY|spreadMethod|clipPathUnits|maskUnits|primitiveUnits|baseFrequency|numOctaves|stdDeviation|textLength|lengthAdjust|startOffset|pathLength|systemLanguage|requiredFeatures|attributeName|repeatCount|keyTimes|keySplines|calcMode|filterUnits)$/;
function camelToAttr(s) {
  if (KEEP_CAMEL.test(s)) return s;
  if (/[A-Z]/.test(s) && s.indexOf('-') === -1) return camelToKebab(s);
  return s;
}

function classString(val) {
  if (!val) return '';
  if (typeof val === 'string') return val;
  if (Array.isArray(val)) return val.filter(Boolean).map(classString).join(' ');
  if (typeof val === 'object') {
    const out = [];
    for (const k in val) if (val[k]) out.push(k);
    return out.join(' ');
  }
  return String(val);
}

/**
 * Append children to a node. Accepts node | string | number | array | null | function.
 * @param {Node} node
 * @param {*} children
 */
export function append(node, children) {
  if (children === null || children === undefined || children === false || children === true) return node;
  if (Array.isArray(children)) {
    for (let i = 0; i < children.length; i++) append(node, children[i]);
    return node;
  }
  if (children instanceof Node) {
    node.appendChild(children);
    return node;
  }
  if (typeof children === 'function') {
    return append(node, children());
  }
  node.appendChild(document.createTextNode(String(children)));
  return node;
}

/**
 * Create an HTML element.
 * Signatures: h('div'), h('div', attrs), h('div', children), h('div', attrs, children)
 * Tag supports shorthand: 'div.card', 'span#id.chip.small', 'button.btn.primary'
 * @param {string} tag
 * @param {object|*} [attrs]
 * @param {*} [children]
 * @returns {HTMLElement}
 */
export function h(tag, attrs, children) {
  const parsed = parseTag(tag);
  const node = document.createElement(parsed.tag);
  let a = attrs;
  let c = children;
  if (isChildLike(a)) {
    c = a;
    a = null;
  }
  if (parsed.id) node.id = parsed.id;
  if (parsed.classes.length) node.setAttribute('class', parsed.classes.join(' '));
  if (a) {
    if (parsed.classes.length && (a.class || a.className)) {
      const merged = parsed.classes.join(' ') + ' ' + classString(a.class || a.className);
      const copy = Object.assign({}, a);
      delete copy.className;
      copy.class = merged;
      setAttrs(node, copy);
    } else {
      setAttrs(node, a);
    }
  }
  append(node, c);
  return node;
}

/**
 * Create an SVG-namespaced element. Same signature as h().
 * @param {string} tag
 * @param {object|*} [attrs]
 * @param {*} [children]
 * @returns {SVGElement}
 */
export function svg(tag, attrs, children) {
  const parsed = parseTag(tag);
  const node = document.createElementNS(SVG_NS, parsed.tag);
  let a = attrs;
  let c = children;
  if (isChildLike(a)) {
    c = a;
    a = null;
  }
  if (parsed.id) node.setAttribute('id', parsed.id);
  if (parsed.classes.length) node.setAttribute('class', parsed.classes.join(' '));
  if (a) {
    if (parsed.classes.length && (a.class || a.className)) {
      const merged = parsed.classes.join(' ') + ' ' + classString(a.class || a.className);
      const copy = Object.assign({}, a);
      delete copy.className;
      copy.class = merged;
      setAttrs(node, copy);
    } else {
      setAttrs(node, a);
    }
  }
  append(node, c);
  return node;
}

function isChildLike(v) {
  if (v === null || v === undefined) return false;
  if (v instanceof Node) return true;
  if (Array.isArray(v)) return true;
  const t = typeof v;
  return t === 'string' || t === 'number';
}

const tagCache = new Map();
function parseTag(tag) {
  if (typeof tag !== 'string' || tag === '') return { tag: 'div', id: '', classes: [] };
  const cached = tagCache.get(tag);
  if (cached) return cached;
  let name = 'div';
  let id = '';
  const classes = [];
  const m = tag.match(/^[A-Za-z][A-Za-z0-9:-]*/);
  if (m) name = m[0];
  const rest = tag.slice(m ? m[0].length : 0);
  const parts = rest.match(/[.#][^.#]+/g) || [];
  for (const p of parts) {
    if (p[0] === '#') id = p.slice(1);
    else classes.push(p.slice(1));
  }
  const out = { tag: name, id, classes };
  tagCache.set(tag, out);
  return out;
}

/** Create a DocumentFragment from children. */
export function frag(children) {
  const f = document.createDocumentFragment();
  append(f, children);
  return f;
}

/** Create a text node. */
export function text(s) {
  return document.createTextNode(s === null || s === undefined ? '' : String(s));
}

/** Remove all children of el. Returns el. */
export function clear(el) {
  if (!el) return el;
  while (el.firstChild) el.removeChild(el.firstChild);
  return el;
}

/**
 * Replace parent's children with `node` (or append if replace === false).
 * @param {Node|Node[]|string} node
 * @param {Element|string} parent element or selector
 * @param {boolean} [replace=true]
 * @returns {Element} the parent
 */
export function mount(node, parent, replace = true) {
  const p = typeof parent === 'string' ? document.querySelector(parent) : parent;
  if (!p) return null;
  if (replace) clear(p);
  append(p, node);
  return p;
}

/** querySelector shorthand. */
export function qs(sel, root) {
  return (root || document).querySelector(sel);
}

/** querySelectorAll shorthand returning a real Array. */
export function qsa(sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
}

/**
 * addEventListener shorthand returning an unbind function.
 * @returns {()=>void}
 */
export function on(node, evt, fn, opts) {
  if (!node) return () => {};
  node.addEventListener(evt, fn, opts);
  return () => node.removeEventListener(evt, fn, opts);
}

/** Alias of h() for readability in some modules. */
export const el = h;
