/* Small DOM helpers and the shared icon set.
   Kept deliberately thin — the app files below build markup with these directly
   rather than pulling in a framework. */

(function (global) {
  'use strict';

  var doc = global.document;

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
        if (key === 'html') { node.innerHTML = value; return; }
        if (key === 'text') { node.textContent = value; return; }
        if (key === 'style') { node.setAttribute('style', value); return; }
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

  var ICONS = {
    /* Gold padlock — marks a control a signed-out visitor cannot use. */
    lock: function (fill) {
      return '<svg width="9" height="9" viewBox="0 0 10 10" aria-hidden="true">' +
        '<rect x="1.5" y="4.2" width="7" height="4.6" rx="1.2" fill="' + (fill || '#26281F') + '"></rect>' +
        '<path d="M3.2 4.2V3a1.8 1.8 0 0 1 3.6 0v1.2" fill="none" stroke="' + (fill || '#26281F') + '" stroke-width="1.3"></path></svg>';
    },
    lockLarge: function (fill) {
      return '<svg width="18" height="18" viewBox="0 0 10 10" aria-hidden="true">' +
        '<rect x="1.5" y="4.2" width="7" height="4.6" rx="1.2" fill="' + (fill || '#A67B24') + '"></rect>' +
        '<path d="M3.2 4.2V3a1.8 1.8 0 0 1 3.6 0v1.2" fill="none" stroke="' + (fill || '#A67B24') + '" stroke-width="1.3"></path></svg>';
    },
    camera: function (stroke) {
      return '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="2.5" y="5" width="19" height="14.5" rx="2.5" fill="none" stroke="' + stroke + '" stroke-width="1.8"></rect>' +
        '<circle cx="12" cy="12" r="3.4" fill="none" stroke="' + stroke + '" stroke-width="1.8"></circle>' +
        '<rect x="8" y="2.6" width="8" height="3" rx="1.2" fill="' + stroke + '"></rect></svg>';
    },
    mic: function (stroke) {
      return '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="9.4" y="2.6" width="5.2" height="12" rx="2.6" fill="none" stroke="' + stroke + '" stroke-width="1.8"></rect>' +
        '<path d="M5.5 11.5a6.5 6.5 0 0 0 13 0" fill="none" stroke="' + stroke + '" stroke-width="1.8"></path>' +
        '<path d="M12 18v3.4" stroke="' + stroke + '" stroke-width="1.8"></path></svg>';
    },
    calendar: function (stroke) {
      return '<svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">' +
        '<rect x="3" y="4.5" width="18" height="17" rx="2.5" fill="none" stroke="' + stroke + '" stroke-width="1.8"></rect>' +
        '<path d="M3 9.5h18" stroke="' + stroke + '" stroke-width="1.8"></path>' +
        '<path d="M8 2.5v4M16 2.5v4" stroke="' + stroke + '" stroke-width="1.8"></path></svg>';
    },
    upload: '<svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M12 16V5M12 5l-4.2 4.2M12 5l4.2 4.2" fill="none" stroke="#C05B3E" stroke-width="1.8" stroke-linecap="round"></path>' +
      '<path d="M4 16.5v2A2.5 2.5 0 0 0 6.5 21h11a2.5 2.5 0 0 0 2.5-2.5v-2" fill="none" stroke="#C05B3E" stroke-width="1.8" stroke-linecap="round"></path></svg>',
    google: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M21.6 12.2c0-.7-.06-1.4-.18-2H12v3.9h5.4a4.6 4.6 0 0 1-2 3v2.5h3.2c1.9-1.7 3-4.3 3-7.4z" fill="#4285F4"></path>' +
      '<path d="M12 22c2.7 0 5-.9 6.6-2.4l-3.2-2.5c-.9.6-2 1-3.4 1a5.9 5.9 0 0 1-5.5-4H3.2v2.6A10 10 0 0 0 12 22z" fill="#34A853"></path>' +
      '<path d="M6.5 14a6 6 0 0 1 0-3.9V7.5H3.2a10 10 0 0 0 0 9z" fill="#FBBC05"></path>' +
      '<path d="M12 6a5.4 5.4 0 0 1 3.8 1.5L18.7 4.6A9.6 9.6 0 0 0 12 2a10 10 0 0 0-8.8 5.5l3.3 2.6A5.9 5.9 0 0 1 12 6z" fill="#EA4335"></path></svg>',
    apple: '<svg width="15" height="15" viewBox="0 0 24 24" aria-hidden="true">' +
      '<path d="M16.6 12.9c0-2.5 2-3.7 2.1-3.8-1.2-1.7-3-1.9-3.6-1.9-1.5-.2-3 .9-3.8.9-.8 0-2-.9-3.3-.9-1.7 0-3.3 1-4.1 2.5-1.8 3.1-.5 7.6 1.2 10.1.9 1.2 1.9 2.6 3.2 2.5 1.3-.1 1.8-.8 3.3-.8s2 .8 3.3.8c1.4 0 2.3-1.2 3.1-2.5.98-1.4 1.4-2.8 1.4-2.9-.03-.01-2.7-1-2.8-4z" fill="#26281F"></path>' +
      '<path d="M14.2 5.6c.7-.9 1.2-2.1 1-3.3-1 .04-2.3.7-3 1.6-.7.8-1.3 2-1.1 3.2 1.2.1 2.4-.6 3.1-1.5z" fill="#26281F"></path></svg>',

    /** Waveform for voice memories. `heights` drives the bars; `played` how many are coloured. */
    waveform: function (width, height, played) {
      var heights = [8, 16, 22, 12, 18, 10, 24, 14, 20, 8, 16, 22, 6];
      var bars = heights.map(function (h, i) {
        var fill = i < (played == null ? 7 : played) ? '#C05B3E' : 'rgba(38,40,31,.25)';
        return '<rect x="' + (i * 10) + '" y="' + ((26 - h) / 2) + '" width="4" height="' + h +
          '" rx="2" fill="' + fill + '"></rect>';
      }).join('');
      return '<svg viewBox="0 0 134 26" width="' + width + '" height="' + height +
        '" style="display:block" aria-hidden="true">' + bars + '</svg>';
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
    append: append,
    clear: clear,
    mount: mount,
    qs: qs,
    qsa: qsa,
    toneStyle: toneStyle,
    langPair: langPair,
    ICONS: ICONS,
    toast: toast,
    trapFocus: trapFocus
  };
})(window);
