/* Small DOM helpers and the shared icon set.
   Kept deliberately thin — the app files below build markup with these directly
   rather than pulling in a framework.

   ── There is no `html:` prop, and there cannot be ────────────

   §6: "XSS: textContent only, or DOMPurify. Every innerHTML / insertAdjacentHTML /
   outerHTML on user content is a defect."

   el() used to accept `{html: '<svg…>'}` and assign it to innerHTML. Every call site was an
   icon or a `<b>` around a number, and none of them was user content — which is exactly why
   it survived three milestones. The prop is gone rather than documented, because the defect
   it invites is not the call sites that exist: it is the next one, written by someone who
   sees `html:` in the helper's signature and reaches for it with a title in hand.

   What replaced it is below: svgEl() builds real SVG nodes, and el()'s children already
   accept nodes. Nothing in this codebase can now put a string into the DOM as markup.
   scripts/frontend-xss-test.mjs asserts that by scanning the served tree.

   ── bdi() ───────────────────────────────────────────────────

   §6's other half: "Render user strings in <bdi>." 0045 strips the override characters on
   ingest; <bdi> handles the case that needs no special characters at all — an Arabic title
   inside an English sentence, or the reverse, where the two scripts' natural directions make
   the surrounding punctuation and digits land in the wrong place. Every user-authored string
   in this front end goes through bdi(). */

(function (global) {
  'use strict';

  var doc = global.document;
  var SVG_NS = 'http://www.w3.org/2000/svg';

  /** el('div.memory', {onclick: fn}, [children]) */
  function el(spec, props, children) {
    var parts = String(spec).split('.');
    var tag = parts.shift() || 'div';
    var node = doc.createElement(tag);
    if (parts.length) node.className = parts.join(' ');

    if (props) {
      Object.keys(props).forEach(function (key) {
        var value = props[key];
        if (value == null || value === false) return;
        if (key === 'text') { node.textContent = value; return; }
        if (key === 'style') { applyStyle(node, value); return; }
        if (key === 'dataset') {
          Object.keys(value).forEach(function (d) { node.dataset[d] = value[d]; });
          return;
        }
        if (key.slice(0, 2) === 'on' && typeof value === 'function') {
          node.addEventListener(key.slice(2), value);
          return;
        }
        node.setAttribute(key, value === true ? '' : value);
      });
    }

    append(node, children);
    return node;
  }

  /* An SVG element, in the SVG namespace.

     createElement('svg') produces an HTMLUnknownElement that renders as nothing — SVG needs
     createElementNS, and every child of it does too, which is why this recurses rather than
     handing off to el(). Attributes are set without a namespace, which is correct for
     everything here (`xlink:*` would need setAttributeNS and nothing uses it). */
  function svgEl(tag, attrs, children) {
    var node = doc.createElementNS(SVG_NS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (key) {
        if (attrs[key] == null || attrs[key] === false) return;
        node.setAttribute(key, attrs[key]);
      });
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach(function (child) {
        if (child) node.appendChild(child);
      });
    }
    return node;
  }

  /**
   * A user-authored string, isolated.
   *
   * <bdi> resolves the string's direction from its own content and keeps that resolution
   * from leaking into the surrounding line. The alternative — dir="auto" on the parent —
   * applies one direction to a whole mixed line and gets it wrong for at least one of the
   * two scripts, which on this site is every card that pairs an Arabic title with its
   * English gloss.
   *
   * textContent, so it is a text node and not markup, for the same reason as everywhere else.
   */
  function bdi(value) {
    var node = doc.createElement('bdi');
    node.textContent = value == null ? '' : String(value);
    return node;
  }

  /* Apply a `prop:value;prop:value` string through CSSOM instead of the style attribute.

     Why not setAttribute('style', …): a Content-Security-Policy with `style-src 'self'`
     and no 'unsafe-inline' blocks the style ATTRIBUTE — it is an inline style like any
     other, and it does not matter that script rather than markup wrote it. Property
     writes through CSSOM are explicitly not covered, because the policy governs what the
     document declares, not what script computes. This is the whole reason the helper
     exists; see CLAUDE.md section 6 and config/site.json.

     setProperty rather than `node.style[prop] = value`: this codebase sets CUSTOM
     properties — toneStyle() emits `--p1`/`--p2` — and camelCase assignment cannot reach
     those. setProperty handles both, so there is one path rather than two.

     Split on the FIRST colon only: `background:var(--paper)` already carries a colon-free
     value, but url() and gradient values will not, and a split-on-every-colon would
     silently truncate them.

     Known limit: a value containing a literal semicolon — a `data:image/svg+xml;base64,…`
     background, say — would be split wrongly. No call site does that today. If one ever
     needs to, pass the declaration through a class instead of inlining it. */
  function applyStyle(node, declarations) {
    String(declarations).split(';').forEach(function (declaration) {
      var colon = declaration.indexOf(':');
      if (colon < 0) return;
      var prop = declaration.slice(0, colon).trim();
      var value = declaration.slice(colon + 1).trim();
      if (!prop) return;
      var priority = '';
      if (/!important$/i.test(value)) {
        priority = 'important';
        value = value.replace(/!important$/i, '').trim();
      }
      node.style.setProperty(prop, value, priority);
    });
  }

  function append(node, children) {
    if (children == null || children === false) return node;
    if (Array.isArray(children)) {
      children.forEach(function (child) { append(node, child); });
      return node;
    }
    node.appendChild(typeof children === 'object' ? children : doc.createTextNode(String(children)));
    return node;
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function mount(node, children) {
    clear(node);
    append(node, children);
    return node;
  }

  function qs(selector, root) { return (root || doc).querySelector(selector); }
  function qsa(selector, root) {
    return Array.prototype.slice.call((root || doc).querySelectorAll(selector));
  }

  /** Turns a tone name into the two custom properties the .plate rules read. */
  function toneStyle(name, extra) {
    var pair = global.DATA.tone(name);
    return '--p1:' + pair[0] + ';--p2:' + pair[1] + (extra ? ';' + extra : '');
  }

  /* Every icon returns a NODE. They used to return strings that a caller assigned to
     innerHTML — see the header. The signatures are otherwise unchanged, so a call site
     moves from `{html: ICONS.lock()}` to passing it as a child. */
  var ICONS = {
    /* Gold padlock — marks a control a signed-out visitor cannot use. */
    lock: function (fill) {
      return svgEl('svg', { width: 9, height: 9, viewBox: '0 0 10 10', 'aria-hidden': 'true' }, [
        svgEl('rect', { x: 1.5, y: 4.2, width: 7, height: 4.6, rx: 1.2, fill: fill || '#26281F' }),
        svgEl('path', {
          d: 'M3.2 4.2V3a1.8 1.8 0 0 1 3.6 0v1.2',
          fill: 'none', stroke: fill || '#26281F', 'stroke-width': 1.3
        })
      ]);
    },
    lockLarge: function (fill) {
      return svgEl('svg', { width: 18, height: 18, viewBox: '0 0 10 10', 'aria-hidden': 'true' }, [
        svgEl('rect', { x: 1.5, y: 4.2, width: 7, height: 4.6, rx: 1.2, fill: fill || '#A67B24' }),
        svgEl('path', {
          d: 'M3.2 4.2V3a1.8 1.8 0 0 1 3.6 0v1.2',
          fill: 'none', stroke: fill || '#A67B24', 'stroke-width': 1.3
        })
      ]);
    },
    camera: function (stroke) {
      return svgEl('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl('rect', { x: 2.5, y: 5, width: 19, height: 14.5, rx: 2.5, fill: 'none', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('circle', { cx: 12, cy: 12, r: 3.4, fill: 'none', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('rect', { x: 8, y: 2.6, width: 8, height: 3, rx: 1.2, fill: stroke })
      ]);
    },
    mic: function (stroke) {
      return svgEl('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl('rect', { x: 9.4, y: 2.6, width: 5.2, height: 12, rx: 2.6, fill: 'none', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('path', { d: 'M5.5 11.5a6.5 6.5 0 0 0 13 0', fill: 'none', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('path', { d: 'M12 18v3.4', stroke: stroke, 'stroke-width': 1.8 })
      ]);
    },
    calendar: function (stroke) {
      return svgEl('svg', { width: 22, height: 22, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl('rect', { x: 3, y: 4.5, width: 18, height: 17, rx: 2.5, fill: 'none', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('path', { d: 'M3 9.5h18', stroke: stroke, 'stroke-width': 1.8 }),
        svgEl('path', { d: 'M8 2.5v4M16 2.5v4', stroke: stroke, 'stroke-width': 1.8 })
      ]);
    },
    upload: function () {
      return svgEl('svg', { width: 24, height: 24, viewBox: '0 0 24 24', 'aria-hidden': 'true' }, [
        svgEl('path', {
          d: 'M12 16V5M12 5l-4.2 4.2M12 5l4.2 4.2',
          fill: 'none', stroke: '#C05B3E', 'stroke-width': 1.8, 'stroke-linecap': 'round'
        }),
        svgEl('path', {
          d: 'M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2',
          fill: 'none', stroke: '#C05B3E', 'stroke-width': 1.8, 'stroke-linecap': 'round'
        })
      ]);
    },
    /* The Google and Apple marks lived here, for sign-in buttons that CLAUDE.md §2 does
       not permit ("email + password only"). Deleted with M1 piece 4 rather than left
       unused: they are ~1.5 KB against §9's 150 KB budget, and a vendor mark sitting in
       the icon set is a social provider waiting for someone to re-add the button. */

    /** Waveform for voice memories. `heights` drives the bars; `played` how many are coloured. */
    waveform: function (width, height, played) {
      var heights = [8, 16, 22, 12, 18, 10, 24, 14, 20, 8, 16, 22, 6];
      var bars = heights.map(function (h, i) {
        return svgEl('rect', {
          x: i * 10,
          y: (26 - h) / 2,
          width: 4,
          height: h,
          rx: 2,
          fill: i < (played == null ? 7 : played) ? '#C05B3E' : 'rgba(38,40,31,.25)'
        });
      });
      var node = svgEl('svg', {
        viewBox: '0 0 134 26', width: width, height: height, 'aria-hidden': 'true'
      }, bars);
      // display:block through CSSOM rather than a style attribute — style-src blocks the
      // attribute (see applyStyle) and an SVG inline in a flex row otherwise sits on the
      // text baseline with a few pixels of descender space under it.
      node.style.setProperty('display', 'block');
      return node;
    }
  };

  /* Content records are {ar, en} pairs, so every editor edits both sides at once.
     Each input carries its own dir/lang, otherwise Arabic renders left-to-right
     whenever the surrounding page is in English (and vice versa). */
  function langPair(label, value, opts) {
    opts = opts || {};
    var tag = opts.multiline ? 'textarea' : 'input';
    var pair = value || { ar: '', en: '' };

    function side(lang, dir, text, placeholder) {
      var node = el(tag + '.input', {
        dir: dir,
        lang: lang,
        rows: opts.multiline ? (opts.rows || '3') : null,
        type: opts.multiline ? null : (opts.type || 'text'),
        placeholder: placeholder || '',
        'aria-label': label + ' (' + (lang === 'ar' ? 'العربية' : 'English') + ')'
      });
      node.value = text || '';
      return node;
    }

    var ar = side('ar', 'rtl', pair.ar, opts.placeholderAr);
    var en = side('en', 'ltr', pair.en, opts.placeholderEn);

    return {
      ar: ar,
      en: en,
      node: el('div.field-pair', null, [
        el('div.field', null, [el('label.field__label', null, [label, ' — العربية']), ar]),
        el('div.field', null, [el('label.field__label', null, [label, ' — English']), en])
      ]),
      read: function () { return { ar: ar.value.trim(), en: en.value.trim() }; }
    };
  }

  /** Brief confirmation of an action that has no other visible result. */
  var toastTimer = null;
  function toast(message) {
    var existing = qs('.toast');
    if (existing) existing.remove();
    var node = el('div.toast', { role: 'status', text: message });
    doc.body.appendChild(node);
    global.clearTimeout(toastTimer);
    toastTimer = global.setTimeout(function () { node.remove(); }, 3200);
  }

  /* A module, fetched the first time something needs it.

     §5 has admin.js "dynamically imported on moderator/admin login" and §9 budgets the
     first paint, so two things in this codebase are deliberately absent from a shell's
     script list: the dashboard, and M4's map. Both are IIFEs against `window` rather than
     ES modules — import() cannot take them — and the property that actually matters is
     that the BYTES are not fetched, which a script tag gives.

     Not secrecy, in either case. §5: "Hiding client code is not security." Anyone may
     request either file directly.

     Memoised per src, so two callers racing for the map get one download and one
     evaluation. A failure clears the memo: a module that failed to load because the
     network dropped must be retryable, and a rejected promise left in the map would refuse
     forever. */
  var scripts = {};
  function loadScript(src) {
    if (!scripts[src]) {
      scripts[src] = new Promise(function (resolve, reject) {
        var node = doc.createElement('script');
        node.src = src;
        node.onload = function () { resolve(src); };
        node.onerror = function () { scripts[src] = null; reject(new Error('ui.err.script')); };
        doc.body.appendChild(node);
      });
    }
    return scripts[src];
  }

  /* The map, in dependency order — and the order is load-bearing: map.js reads PMTILES and
     MVT off `window` when its IIFE runs, so a parallel load that finished out of order
     would leave it holding undefined. */
  function loadMap() {
    return loadScript('/assets/js/pmtiles.js')
      .then(function () { return loadScript('/assets/js/mvt.js'); })
      .then(function () { return loadScript('/assets/js/map.js'); });
  }

  /** Traps Tab inside an open dialog and restores focus when it closes. */
  function trapFocus(container, onEscape) {
    var previous = doc.activeElement;
    var selector = 'a[href],button:not([disabled]),input:not([disabled]),textarea,select,[tabindex]:not([tabindex="-1"])';

    function onKey(event) {
      if (event.key === 'Escape' && onEscape) { onEscape(); return; }
      if (event.key !== 'Tab') return;
      var items = qsa(selector, container).filter(function (node) { return node.offsetParent !== null; });
      if (!items.length) return;
      var first = items[0];
      var last = items[items.length - 1];
      if (event.shiftKey && doc.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && doc.activeElement === last) { event.preventDefault(); first.focus(); }
    }

    container.addEventListener('keydown', onKey);
    var firstField = qs(selector, container);
    if (firstField) firstField.focus();

    return function release() {
      container.removeEventListener('keydown', onKey);
      if (previous && previous.focus) previous.focus();
    };
  }

  global.UI = {
    el: el,
    svgEl: svgEl,
    bdi: bdi,
    append: append,
    clear: clear,
    mount: mount,
    qs: qs,
    qsa: qsa,
    toneStyle: toneStyle,
    langPair: langPair,
    ICONS: ICONS,
    toast: toast,
    trapFocus: trapFocus,
    loadScript: loadScript,
    loadMap: loadMap
  };
})(window);
