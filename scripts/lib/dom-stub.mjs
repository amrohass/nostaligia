/* A DOM small enough to run public.js against, and no smaller.
 *
 * ── Why this exists ──────────────────────────────────────────
 *
 * §9 forbids a build step and the tests inherit that rule, so there is no jsdom here and
 * there is not going to be. Every front-end test until now has therefore asserted one of two
 * things: what the SOURCE says (a regex over the file), or what one module returns when
 * poked (archive.js against a stubbed fetch). Neither can answer the question that produced
 * this file — "where does this button actually point after the reader has been to /map?" —
 * because the answer is a property of a node that a render produced, three functions deep,
 * from state nothing exports.
 *
 * The catalogue in scripts/mutation-pass.mjs is a list of assertions that could not fail. A
 * regex asserting `href` is not the literal '/' is the next entry on it: it goes green the
 * moment the string moves into a variable, whatever the variable holds.
 *
 * So: enough DOM to render, and a selector engine that handles exactly the selectors this
 * codebase uses. It is NOT a browser. Layout does not exist, `offsetParent` is a lie told
 * so trapFocus finds something, and nothing here computes a style. What it does faithfully
 * is the tree, the attributes, and querySelector — which is all an assertion about markup
 * needs.
 *
 *   import { makeWindow, textOf, allOf } from './lib/dom-stub.mjs';
 */

/* ── Selectors ────────────────────────────────────────────────
 *
 * A compound selector: an optional tag, then any number of `#id`, `.class` and
 * `[attr]` / `[attr=v]` / `[attr="v"]` terms, plus `:not(...)` around one of those. Comma
 * lists are supported because ui.js's focus-trap selector is one. Descendant combinators
 * are NOT, because nothing in this codebase uses one — and a half-working combinator would
 * silently match the wrong node rather than throwing, which is the failure this whole file
 * is trying not to have.
 */
const TERM = /^(?:#([\w:.\-]+)|\.([\w-]+)|\[([\w-]+)(?:([~^$*|]?=)"?([^\]"]*)"?)?\])/;

function parseCompound(raw) {
  let src = raw.trim();
  if (!src) return null;

  const tests = [];
  const tag = /^([a-zA-Z][\w-]*)/.exec(src);
  if (tag) {
    const want = tag[1].toLowerCase();
    tests.push((n) => n.tagName.toLowerCase() === want);
    src = src.slice(tag[0].length);
  }

  while (src) {
    if (src.startsWith(':not(')) {
      const close = src.indexOf(')');
      if (close === -1) throw new Error(`dom-stub: unbalanced :not( in ${raw}`);
      const inner = parseCompound(src.slice(5, close));
      tests.push((n) => !inner(n));
      src = src.slice(close + 1);
      continue;
    }
    const m = TERM.exec(src);
    if (!m) throw new Error(`dom-stub: unsupported selector "${raw}" at "${src}"`);
    const [, id, cls, attr, , value] = m;
    if (id) tests.push((n) => n.id === id);
    else if (cls) tests.push((n) => n.classList().includes(cls));
    else if (value === undefined) tests.push((n) => n.hasAttribute(attr));
    else tests.push((n) => n.getAttribute(attr) === value);
    src = src.slice(m[0].length);
  }

  return (node) => tests.every((fn) => fn(node));
}

function compile(selector) {
  const parts = String(selector).split(',').map(parseCompound).filter(Boolean);
  return (node) => parts.some((fn) => fn(node));
}

/* ── Nodes ────────────────────────────────────────────────── */

let seq = 0;

function createNode(tagName, namespace) {
  const node = {
    tagName: String(tagName).toUpperCase(),
    namespaceURI: namespace || null,
    nodeType: 1,
    _uid: ++seq,
    className: '',
    id: '',
    value: '',
    hidden: false,
    disabled: false,
    checked: false,
    src: '',
    rows: '',
    scrollTop: 0,
    clientHeight: 800,
    dataset: {},
    attributes: Object.create(null),
    childNodes: [],
    parentNode: null,
    listeners: Object.create(null),
    /* trapFocus filters on `offsetParent !== null` to skip hidden controls. Nothing here
       lays anything out, so every node claims to be visible; the alternative — null — would
       make the trap find nothing and quietly stop asserting. */
    offsetParent: {},

    classList() {
      return String(this.className).split(/\s+/).filter(Boolean);
    },
    get isConnected() {
      let n = this;
      while (n.parentNode) n = n.parentNode;
      return n._isDocumentRoot === true;
    },
    get firstChild() { return this.childNodes[0] || null; },
    get children() { return this.childNodes.filter((c) => c.nodeType === 1); },

    get textContent() {
      if (this._text !== undefined) return this._text;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      this.childNodes.forEach((c) => { c.parentNode = null; });
      this.childNodes = [];
      this._text = v == null ? '' : String(v);
    },

    setAttribute(name, v) {
      this.attributes[name] = String(v);
      if (name === 'id') this.id = String(v);
      if (name === 'class') this.className = String(v);
      if (name === 'value') this.value = String(v);
    },
    getAttribute(name) {
      if (name === 'class') return this.className || null;
      if (name === 'id') return this.id || null;
      return name in this.attributes ? this.attributes[name] : null;
    },
    hasAttribute(name) {
      if (name === 'class') return Boolean(this.className);
      if (name === 'id') return Boolean(this.id);
      return name in this.attributes;
    },
    removeAttribute(name) { delete this.attributes[name]; },

    appendChild(child) {
      if (this._text !== undefined) { this._text = undefined; }
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    },
    insertBefore(child, ref) {
      const at = ref ? this.childNodes.indexOf(ref) : -1;
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      if (at === -1) this.childNodes.push(child); else this.childNodes.splice(at, 0, child);
      return child;
    },
    removeChild(child) {
      const at = this.childNodes.indexOf(child);
      if (at > -1) this.childNodes.splice(at, 1);
      child.parentNode = null;
      return child;
    },
    replaceChildren(...next) {
      this.childNodes.forEach((c) => { c.parentNode = null; });
      this.childNodes = [];
      this._text = undefined;
      next.forEach((c) => c && this.appendChild(c));
    },
    remove() { if (this.parentNode) this.parentNode.removeChild(this); },

    querySelectorAll(selector) {
      const match = compile(selector);
      const out = [];
      const walk = (n) => n.childNodes.forEach((c) => {
        if (c.nodeType !== 1) return;
        if (match(c)) out.push(c);
        walk(c);
      });
      walk(this);
      return out;
    },
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; },

    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      this.listeners[type] = (this.listeners[type] || []).filter((f) => f !== fn);
    },
    /** Fires the handlers registered on THIS node. No bubbling — nothing here needs it. */
    fire(type, event) {
      (this.listeners[type] || []).slice().forEach((fn) => fn({
        type, target: this, currentTarget: this, preventDefault() {}, stopPropagation() {},
        defaultPrevented: false, button: 0, key: '', ...event,
      }));
    },
    focus() { if (this._doc) this._doc.activeElement = this; },
    scrollBy() {},
    getBoundingClientRect() { return { top: 0, left: 0, width: 0, height: 0 }; },
  };

  node.style = {
    _props: Object.create(null),
    setProperty(k, v) { this._props[k] = v; },
    removeProperty(k) { delete this._props[k]; },
    getPropertyValue(k) { return this._props[k] || ''; },
  };

  return node;
}

/* ── The window ───────────────────────────────────────────── */

/**
 * A window with the shell's own body — masthead, #view, #site-footer, #overlays — and a
 * history that really moves `location.pathname`, because a router that pushes into a stub
 * that forgets is a router nothing can test.
 */
export function makeWindow(options = {}) {
  const opts = { pathname: '/', hash: '', innerWidth: 1200, ...options };

  const document = {
    _isDocumentRoot: true,
    nodeType: 9,
    title: '',
    childNodes: [],
    parentNode: null,
    createElement(tag) { const n = createNode(tag); n._doc = document; return n; },
    createElementNS(ns, tag) { const n = createNode(tag, ns); n._doc = document; return n; },
    createTextNode(text) {
      return { nodeType: 3, textContent: String(text), parentNode: null, childNodes: [] };
    },
    addEventListener(type, fn) { (document.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      document.listeners[type] = (document.listeners[type] || []).filter((f) => f !== fn);
    },
    listeners: Object.create(null),
    querySelector(s) { return document.body.querySelector(s) || (compile(s)(document.body) ? document.body : null); },
    querySelectorAll(s) { return document.body.querySelectorAll(s); },
  };
  document.documentElement = document.createElement('html');
  document.documentElement.parentNode = document;
  document.body = document.createElement('body');
  document.body.parentNode = document.documentElement;
  document.documentElement.childNodes.push(document.body);
  document.childNodes.push(document.documentElement);
  document.activeElement = document.body;

  /* site/index.html's own landmarks. public.js reaches for these by id at boot and would
     otherwise throw on the first mount — which would look like a routing bug. */
  for (const [tag, id, cls] of [
    ['header', 'masthead', 'masthead'], ['main', 'view', ''],
    ['footer', 'site-footer', 'site-footer'], ['div', 'overlays', ''],
  ]) {
    const n = document.createElement(tag);
    n.id = id;
    if (cls) n.className = cls;
    document.body.appendChild(n);
  }

  const store = () => {
    const m = new Map();
    return {
      getItem: (k) => (m.has(k) ? m.get(k) : null),
      setItem: (k, v) => m.set(k, String(v)),
      removeItem: (k) => m.delete(k),
      _map: m,
    };
  };

  const timers = [];
  const win = {
    document,
    location: {
      pathname: opts.pathname, hash: opts.hash, search: '',
      origin: 'https://x.test',
      get href() { return 'https://x.test' + this.pathname + this.hash; },
    },
    history: {
      entries: [],
      pushState(_s, _t, url) { win.history.entries.push(['push', url]); win._setPath(url); },
      replaceState(_s, _t, url) { win.history.entries.push(['replace', url]); win._setPath(url); },
    },
    _setPath(url) {
      const [path, hash] = String(url).split('#');
      win.location.pathname = path || '/';
      win.location.hash = hash ? '#' + hash : '';
    },
    localStorage: store(),
    sessionStorage: store(),
    listeners: Object.create(null),
    addEventListener(type, fn) { (win.listeners[type] ||= []).push(fn); },
    removeEventListener(type, fn) {
      win.listeners[type] = (win.listeners[type] || []).filter((f) => f !== fn);
    },
    dispatchEvent() {},
    /* Deferred, not dropped: public.js debounces scroll, resize and the viewer's scroll
       settle through setTimeout, and a stub that never calls back would make every one of
       those paths untestable. `flushTimers()` runs them on demand. */
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    clearTimeout(id) { if (id && timers[id - 1]) timers[id - 1].fn = null; },
    setInterval() { return 0; },
    clearInterval() {},
    scrollTo() {},
    innerWidth: opts.innerWidth,
    innerHeight: 900,
    pageYOffset: 0,
    CustomEvent: class {},
    URLSearchParams,
    fetch: () => Promise.reject(new Error('dom-stub: no fetch configured')),
    _timers: timers,
    _flushTimers() {
      const due = timers.splice(0, timers.length);
      due.forEach((t) => { if (t.fn) t.fn(); });
    },
    /** Fires a window-level listener — 'popstate', 'langchange', 'resize'. */
    _emit(type, event) {
      (win.listeners[type] || []).slice().forEach((fn) => fn(event || {}));
    },
    /** A left-click on a node, routed through public.js's document-level delegation. */
    _click(node) {
      (document.listeners.click || []).slice().forEach((fn) => fn({
        target: node, button: 0, defaultPrevented: false,
        metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
        preventDefault() {},
      }));
    },
  };

  return win;
}

/** Every node in `root` matching `selector`, including `root` itself. */
export function allOf(root, selector) {
  const found = root.querySelectorAll(selector);
  return compile(selector)(root) ? [root, ...found] : found;
}

/** The visible text of a node, with whitespace collapsed. */
export function textOf(node) {
  return node ? String(node.textContent).replace(/\s+/g, ' ').trim() : '';
}
