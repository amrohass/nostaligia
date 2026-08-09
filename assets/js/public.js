/* The public Atlas — archive, immersive viewer, map, events, and the gate that
   stands between a signed-out visitor and any control that writes.

   Routes are hashes so the whole thing serves from a static host:
     #/archive (default) · #/map · #/events */

(function (global) {
  'use strict';

  var el = UI.el, qs = UI.qs, mount = UI.mount, toneStyle = UI.toneStyle, ICONS = UI.ICONS;
  var t = function (k, v) { return I18N.t(k, v); };
  var pick = I18N.pick, gloss = I18N.gloss, num = I18N.num;

  var RAMALLAH = [31.9022, 35.2034];

  var state = {
    signedIn: readSession(),
    likes: {},
    decade: 'all',
    viewer: null,      // { index }
    mapCard: null,     // memory id
    releaseTrap: null
  };

  function readSession() {
    try { return global.sessionStorage.getItem('rma.signedIn') === '1'; }
    catch (e) { return false; }
  }
  function writeSession(value) {
    try { global.sessionStorage.setItem('rma.signedIn', value ? '1' : '0'); }
    catch (e) { /* private mode — session state stays in memory only */ }
  }

  /* ── Routing ─────────────────────────────────────────────── */

  function route() {
    var hash = global.location.hash.replace(/^#\/?/, '');
    if (hash.slice(0, 2) === 'm/') return 'archive';
    return ['archive', 'map', 'events'].indexOf(hash) > -1 ? hash : 'archive';
  }

  /** #/m/<id> deep-links a single memory, so every one of them has a URL. */
  function routedMemoryIndex() {
    var hash = global.location.hash.replace(/^#\/?/, '');
    if (hash.slice(0, 2) !== 'm/') return -1;
    var id = hash.slice(2);
    for (var i = 0; i < DATA.MEMORIES.length; i++) if (DATA.MEMORIES[i].id === id) return i;
    return -1;
  }

  /* ── Masthead ────────────────────────────────────────────── */

  function renderMasthead() {
    var current = route();

    var nav = el('nav.masthead__nav', { 'aria-label': t('nav.archive') }, ['archive', 'map', 'events'].map(function (name) {
      return el('a.navlink', {
        href: '#/' + name,
        'aria-current': name === current ? 'page' : null,
        text: t('nav.' + name)
      });
    }));

    var actions = [
      el('button.lang-toggle', {
        type: 'button',
        title: t('lang.switchTo'),
        onclick: function () { I18N.toggle(); },
        text: t('lang.other')
      })
    ];

    if (state.signedIn) {
      actions.push(el('button.btn.btn--primary.btn--share', { type: 'button', onclick: openShareSheet }, [
        el('span.plus', { text: '+' }),
        t('action.share')
      ]));
      actions.push(el('button.avatar-btn', {
        type: 'button',
        title: t('action.signOut'),
        onclick: signOut,
        text: I18N.lang === 'ar' ? 'س' : 'S'
      }));
    } else {
      actions.push(el('button.btn.btn--quiet', {
        type: 'button', onclick: function () { openAuth('login'); }, text: t('action.signIn')
      }));
      actions.push(el('button.btn.btn--primary', {
        type: 'button', onclick: function () { openAuth('signup'); }, text: t('action.createAcct')
      }));
    }

    mount(qs('#masthead'), [
      el('div.masthead__lead', null, [
        el('a.wordmark', { href: '#/archive' }, [
          el('span.wordmark__primary', { text: t('brand.name') }),
          el('span.wordmark__secondary', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('brand.counterpart') })
        ]),
        nav
      ]),
      el('div.masthead__actions', null, actions)
    ]);
  }

  /* ── Footer ──────────────────────────────────────────────── */

  function renderFooter() {
    mount(qs('#site-footer'), [
      el('div.site-footer__top', null, [
        el('div.site-footer__about', null, [
          el('div.site-footer__mark', { text: t('brand.name') }),
          el('div.site-footer__mark-sub', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('brand.counterpart') }),
          el('p.site-footer__blurb', { text: t('footer.blurb') })
        ]),
        el('nav.site-footer__links', { 'aria-label': t('footer.project') }, [
          el('div.site-footer__heading', { text: t('footer.project') }),
          el('a', { href: '#/archive', text: t('footer.about') }),
          el('a', { href: '#/archive', text: t('footer.contact') }),
          el('a', { href: '#/archive', text: t('footer.help') }),
          el('a', { href: '#/archive', text: t('footer.terms') })
        ]),
        el('div.donate', null, [
          el('div.donate__title', { text: t('donate.title') }),
          el('p.donate__blurb', { text: t('donate.blurb') }),
          el('button.btn', { type: 'button', onclick: function () { UI.toast(t('donate.title')); }, text: t('donate.cta') })
        ])
      ]),
      el('div.site-footer__legal', null, [
        el('span', { text: t('footer.legal') }),
        el('span', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('footer.tag') })
      ])
    ]);
  }

  /* ── Archive ─────────────────────────────────────────────── */

  function columnCount() {
    var width = global.innerWidth;
    if (width < 700) return 2;
    if (width < 1040) return 3;
    return 4;
  }

  function badgeFor(memory) {
    var map = { photo: 'badge--photo', voice: 'badge--voice', video: 'badge--video' };
    return el('span.badge ' + map[memory.kind], { text: t('kind.' + memory.kind) });
  }

  function memoryCard(memory, index) {
    var parts = [];

    if (memory.kind === 'voice') {
      parts.push(el('div.memory__voice-head', null, [
        el('div.memory__voice-avatar', { style: toneStyle(memory.tone) }),
        el('div.memory__voice-title', { text: pick(memory.title) })
      ]));
      parts.push(el('div.waveform', null, [
        el('span.waveform__play', { 'aria-hidden': 'true', text: '▶' }),
        el('span', { html: ICONS.waveform(130, 24, 7) }),
        el('span.waveform__time', { text: memory.duration })
      ]));
    } else {
      parts.push(el('div.memory__plate.plate', {
        style: toneStyle(memory.tone, 'height:' + memory.weight + 'px')
      }, [
        el('span.mono', { text: memory.plate }),
        memory.kind === 'video' ? el('span.memory__duration', { text: '▶ ' + memory.duration }) : null
      ]));
    }

    var body = [];
    if (memory.kind !== 'voice') body.push(el('h3.memory__title', { text: pick(memory.title) }));
    body.push(el('div.memory__gloss.gloss-line', { text: gloss(memory.title) }));
    body.push(el('div.memory__meta', null, [
      badgeFor(memory),
      el('span.era', { text: t('decade.' + memory.decade) })
    ]));
    parts.push(el('div.memory__body', null, body));

    return el('a.memory', {
      href: '#/m/' + memory.id,
      'aria-label': pick(memory.title)
    }, parts);
  }

  function renderArchive() {
    var count = columnCount();
    var columns = [];
    for (var c = 0; c < count; c++) columns.push([]);
    DATA.MEMORIES.forEach(function (memory, i) {
      columns[i % count].push(memoryCard(memory, i));
    });

    return el('div', { dataset: { cols: String(count) } }, [
      el('section.hero', null, [
        el('h1.hero__line', { text: t('hero.line') }),
        el('p.hero__blurb', { text: t('hero.blurb') }),
        el('ul.hero__stats', null, [
          el('li', { text: t('hero.memories', { n: num(3462) }) }),
          el('li', { text: t('hero.narrators', { n: num(890) }) }),
          el('li', { text: t('hero.decades') })
        ])
      ]),
      el('div.grid', null, columns.map(function (cards) {
        return el('div.grid__col', null, cards);
      })),
      el('div.feed-end', null, [
        el('span.dot'), el('span.dot'), el('span.dot'),
        el('span', { text: t('feed.more') })
      ])
    ]);
  }

  /* ── Immersive viewer ────────────────────────────────────── */

  function viewerSlide(memory) {
    var plate = el('div.viewer__plate.plate--deep', { style: toneStyle(memory.tone) }, [
      el('span.mono', { text: memory.plate || (pick(memory.title)) })
    ]);
    if (memory.kind === 'video') plate.appendChild(el('span.viewer__play', { text: '▶' }));
    if (memory.kind === 'voice') plate.appendChild(el('span.viewer__play.viewer__play--voice', { text: '▶' }));

    var place = DATA.place(memory.place);

    return el('div.viewer__slide', null, [
      plate,
      el('div.viewer__caption', null, [
        el('h2.viewer__title', { text: pick(memory.title) }),
        el('div.viewer__gloss.gloss-line', { text: gloss(memory.title) }),
        el('div.viewer__meta', null, [
          el('span.badge', { text: t('kind.' + memory.kind) }),
          el('span.era', { text: t('decade.' + memory.decade) }),
          el('span.viewer__place', { text: place ? pick(place.name) : '' })
        ])
      ])
    ]);
  }

  function railAction(glyph, label, description, onActivate) {
    var locked = !state.signedIn;
    return el('button.rail-action', {
      type: 'button',
      onclick: onActivate,
      'aria-label': locked ? description + ' — ' + t('action.signIn') : description
    }, [
      el('span.rail-action__glyph', null, [
        glyph,
        locked ? el('span.padlock', { html: ICONS.lock('#26281F') }) : null
      ]),
      el('span.rail-action__label', { text: label })
    ]);
  }

  function viewerRail(memory) {
    var likes = state.likes[memory.id] != null ? state.likes[memory.id] : memory.likes;
    return [
      railAction(el('span', { text: '♡' }), num(likes), t('viewer.like'), guard(toggleLike)),
      railAction(el('span', { text: '✩' }), t('viewer.save'), t('viewer.save'), guard(function () { UI.toast(t('viewer.save')); })),
      railAction(el('span', { text: '↓' }), t('viewer.download'), t('viewer.download'), guard(function () { UI.toast(t('viewer.download')); }))
    ];
  }

  /* Re-derives everything outside the scroller: position, engagement rail and
     comments. Called on scroll and whenever sign-in state changes, since the
     padlocks belong to the rail. */
  function renderViewerChrome(index) {
    var memory = DATA.MEMORIES[index];
    var overlay = qs('#viewer');
    if (!overlay) return;

    qs('.viewer__position', overlay).textContent =
      num(index + 1) + ' / ' + num(DATA.MEMORIES.length);

    mount(qs('.viewer__rail', overlay), viewerRail(memory));
    mount(qs('.viewer__comments', overlay), commentsPanel(memory));
  }

  function commentsPanel(memory) {
    var list = memory.comments && memory.comments.length
      ? el('ul.comments__list', null, memory.comments.map(function (comment) {
          return el('li.comment', null, [
            el('span.comment__avatar', { text: pick(comment.initial) }),
            el('div', null, [
              el('div.comment__head', null, [
                el('span.comment__name', { text: pick(comment.name) }),
                el('span.comment__when', { text: pick(comment.when) })
              ]),
              el('p.comment__body', { text: pick(comment.body) })
            ])
          ]);
        }))
      : el('div.comments__list', null, el('p.comments__empty', { text: t('comments.empty') }));

    return [
      el('div.comments__head', null, [
        el('div.comments__count', { html: t('comments.title') + ' <b>' + num((memory.comments || []).length) + '</b>' }),
        el('div.comments__subject', { text: pick(memory.title) })
      ]),
      list,
      el('button.locked-prompt', {
        type: 'button',
        onclick: state.signedIn ? function () { UI.toast(t('comments.title')); } : openGate
      }, [
        el('span.locked-prompt__lock', { html: ICONS.lock('#26281F') }),
        el('span', { text: state.signedIn ? t('comments.title') : t('comments.locked') })
      ])
    ];
  }

  function openViewer(index) {
    state.viewer = { index: index };

    var scroller = el('div.viewer__scroller', {
      onscroll: onViewerScroll
    }, DATA.MEMORIES.map(viewerSlide));

    var overlay = el('div.viewer', { id: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('nav.archive') }, [
      el('div.viewer__stage', null, [
        scroller,
        el('div.viewer__topbar', null, [
          el('a.viewer__close', { href: '#/archive', text: t('viewer.back') }),
          el('span.viewer__position')
        ]),
        el('div.viewer__rail'),
        el('div.viewer__hint', null, el('span', { text: t('viewer.next') }))
      ]),
      el('aside.viewer__comments')
    ]);

    qs('#overlays').appendChild(overlay);
    global.document.body.style.overflow = 'hidden';
    renderViewerChrome(index);

    // Jump to the chosen memory without animating past everything before it.
    scroller.scrollTop = index * scroller.clientHeight;

    state.releaseTrap = UI.trapFocus(overlay, closeViewer);
    global.addEventListener('keydown', onViewerKey);
  }

  var scrollSettle = null;
  function onViewerScroll(event) {
    global.clearTimeout(scrollSettle);
    var scroller = event.currentTarget;
    scrollSettle = global.setTimeout(function () {
      var index = Math.round(scroller.scrollTop / scroller.clientHeight);
      index = Math.max(0, Math.min(DATA.MEMORIES.length - 1, index));
      if (index !== state.viewer.index) {
        state.viewer.index = index;
        renderViewerChrome(index);
        // Keep the address bar on the memory in view without stacking history.
        global.history.replaceState(null, '', '#/m/' + DATA.MEMORIES[index].id);
      }
    }, 90);
  }

  function onViewerKey(event) {
    if (!state.viewer) return;
    var scroller = qs('.viewer__scroller');
    if (!scroller) return;
    if (event.key === 'ArrowDown' || event.key === 'PageDown') {
      event.preventDefault();
      scroller.scrollBy({ top: scroller.clientHeight, behavior: 'smooth' });
    } else if (event.key === 'ArrowUp' || event.key === 'PageUp') {
      event.preventDefault();
      scroller.scrollBy({ top: -scroller.clientHeight, behavior: 'smooth' });
    }
  }

  function closeViewer() {
    var overlay = qs('#viewer');
    if (overlay) overlay.remove();
    global.removeEventListener('keydown', onViewerKey);
    global.document.body.style.overflow = '';
    state.viewer = null;
    if (state.releaseTrap) { state.releaseTrap(); state.releaseTrap = null; }
  }

  function toggleLike() {
    var memory = DATA.MEMORIES[state.viewer.index];
    var current = state.likes[memory.id] != null ? state.likes[memory.id] : memory.likes;
    state.likes[memory.id] = current === memory.likes ? current + 1 : memory.likes;
    renderViewerChrome(state.viewer.index);
  }

  /** Wraps a member-only action so a signed-out visitor gets the gate instead. */
  function guard(action) {
    return function () {
      if (!state.signedIn) { openGate(); return; }
      action();
    };
  }

  /* ── Gate & auth ─────────────────────────────────────────── */

  function overlayShell(className, contents, onDismiss) {
    var scrim = el('div.' + className, { role: 'dialog', 'aria-modal': 'true' }, contents);
    scrim.addEventListener('mousedown', function (event) {
      if (event.target === scrim && onDismiss) onDismiss();
    });
    qs('#overlays').appendChild(scrim);
    var release = UI.trapFocus(scrim, onDismiss);
    scrim._release = release;
    return scrim;
  }

  function closeOverlay(node) {
    if (!node) return;
    if (node._release) node._release();
    node.remove();
  }

  function openGate() {
    var scrim = overlayShell('scrim', [
      el('div.dialog.dialog--gate', null, [
        el('div.dialog__lock', { html: ICONS.lockLarge('#A67B24') }),
        el('h2.dialog__title', { text: t('gate.title') }),
        el('p.dialog__blurb', { text: t('gate.blurb') }),
        el('button.btn.btn--primary.btn--block', {
          type: 'button',
          onclick: function () { closeOverlay(scrim); openAuth('signup'); },
          text: t('gate.create')
        }),
        el('button.btn.btn--ghost.btn--block', {
          type: 'button',
          onclick: function () { closeOverlay(scrim); openAuth('login'); },
          text: t('action.signIn')
        }),
        el('button.dialog__opt-out', {
          type: 'button', onclick: function () { closeOverlay(scrim); }, text: t('gate.keep')
        })
      ])
    ], function () { closeOverlay(scrim); });
    return scrim;
  }

  function socialRow() {
    return el('div.social-row', null, [
      el('button.social', { type: 'button', onclick: function () { UI.toast(t('auth.google')); } },
        [el('span', { html: ICONS.google }), t('auth.google')]),
      el('button.social', { type: 'button', onclick: function () { UI.toast(t('auth.apple')); } },
        [el('span', { html: ICONS.apple }), t('auth.apple')])
    ]);
  }

  function field(labelText, inputProps, extras) {
    var id = 'f-' + Math.random().toString(36).slice(2, 8);
    inputProps = inputProps || {};
    inputProps.id = id;
    inputProps['class'] = 'input' + (inputProps.email ? ' input--email' : '');
    delete inputProps.email;
    return el('div.field', null, [
      extras
        ? el('div.field__row', null, [el('label.field__label', { 'for': id }, labelText), extras])
        : el('label.field__label', { 'for': id }, labelText),
      el(inputProps.multiline ? 'textarea' : 'input', stripMultiline(inputProps))
    ]);
  }

  function stripMultiline(props) {
    var copy = {};
    Object.keys(props).forEach(function (key) { if (key !== 'multiline') copy[key] = props[key]; });
    return copy;
  }

  function openAuth(mode) {
    var scrim;
    function close() { closeOverlay(scrim); }

    var body = [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t(mode === 'signup' ? 'signup.title' : 'login.title') }),
          el('p.dialog__blurb', { text: t(mode === 'signup' ? 'signup.blurb' : 'login.blurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ])
    ];

    if (mode === 'signup') {
      body.push(field(t('field.name'), { type: 'text', placeholder: t('field.namePh'), autocomplete: 'name' }));
      body.push(field(t('field.email'), { type: 'email', placeholder: 'name@example.com', email: true, autocomplete: 'email' }));
      body.push(el('div.field-pair', null, [
        field(t('field.password'), { type: 'password', placeholder: '••••••••', autocomplete: 'new-password' }),
        field([t('field.city'), ' ', el('span.opt', { text: t('field.optional') })],
          { type: 'text', placeholder: t('field.cityPh'), autocomplete: 'address-level2' })
      ]));
      body.push(el('div.pact', null, [
        el('span.pact__tick', { 'aria-hidden': 'true', text: '✓' }),
        el('span', { text: t('auth.pact') })
      ]));
      body.push(el('button.btn.btn--primary.btn--block', {
        type: 'submit', text: t('signup.submit')
      }));
    } else {
      body.push(field(t('field.email'), { type: 'email', placeholder: 'name@example.com', email: true, autocomplete: 'email' }));
      body.push(field(t('field.password'), { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' },
        el('a.field__hint', { href: '#/archive', onclick: function (e) { e.preventDefault(); UI.toast(t('login.forgot')); }, text: t('login.forgot') })));
      body.push(el('label.checkbox', null, [el('input', { type: 'checkbox', checked: true }), t('login.remember')]));
      body.push(el('button.btn.btn--olive.btn--block', { type: 'submit', text: t('login.submit') }));
    }

    body.push(el('div.rule', null, el('span', { text: t('auth.or') })));
    body.push(socialRow());
    body.push(el('div.dialog__foot', null, mode === 'signup'
      ? [t('signup.haveAcct') + ' ', el('a', { href: '#', onclick: function (e) { e.preventDefault(); close(); openAuth('login'); }, text: t('action.signIn') })]
      : [t('login.newHere') + ' ', el('a', { href: '#', onclick: function (e) { e.preventDefault(); close(); openAuth('signup'); }, text: t('login.createOne') })]
    ));

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        close();
        signIn();
      }
    }, body);

    scrim = overlayShell('scrim', [form], close);
  }

  function signIn() {
    state.signedIn = true;
    writeSession(true);
    renderMasthead();
    if (state.viewer) renderViewerChrome(state.viewer.index);
    UI.toast(t('login.title'));
  }

  function signOut() {
    state.signedIn = false;
    writeSession(false);
    renderMasthead();
    if (state.viewer) renderViewerChrome(state.viewer.index);
  }

  /* ── Share sheet ─────────────────────────────────────────── */

  function openShareSheet() {
    var scrim;
    var kind = 'photo';
    function close() { closeOverlay(scrim); }

    var kinds = [
      { id: 'photo', label: t('share.photo'), icon: ICONS.camera },
      { id: 'voice', label: t('share.voice'), icon: ICONS.mic },
      { id: 'event', label: t('share.event'), icon: ICONS.calendar }
    ];

    var kindRow = el('div.kind-row', { role: 'group', 'aria-label': t('share.title') }, kinds.map(function (option) {
      var active = option.id === kind;
      var button = el('button.kind', {
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        onclick: function () {
          kind = option.id;
          UI.qsa('.kind', kindRow).forEach(function (node, i) {
            var on = kinds[i].id === kind;
            node.setAttribute('aria-pressed', on ? 'true' : 'false');
            node.querySelector('svg').outerHTML = kinds[i].icon(on ? '#C05B3E' : '#3E4A2E');
          });
        }
      }, [
        el('span', { html: option.icon(active ? '#C05B3E' : '#3E4A2E') }),
        el('span', { text: option.label })
      ]);
      return button;
    }));

    var decadeSelect = el('select.input', null, DATA.DECADES.map(function (d) {
      return el('option', { value: String(d), selected: d === 1960 ? true : null, text: t('decade.' + d) });
    }));

    var form = el('form.dialog.dialog--sheet', {
      onsubmit: function (event) {
        event.preventDefault();
        close();
        UI.toast(t('share.sent'));
      }
    }, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('share.title') }),
          el('p.dialog__blurb', { text: t('share.blurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕ ' + t('action.close') })
      ]),
      kindRow,
      field(t('share.fTitle'), { type: 'text', placeholder: t('share.fTitlePh'), required: true }),
      el('div.field-pair', null, [
        field(t('share.fPlace'), { type: 'text', placeholder: t('share.fPlacePh'), list: 'places' }),
        el('div.field', null, [
          el('label.field__label', { text: t('share.fDecade') }),
          decadeSelect
        ])
      ]),
      el('datalist', { id: 'places' }, DATA.PLACES.map(function (place) {
        return el('option', { value: pick(place.name) });
      })),
      field(t('share.fStory'), { multiline: true, placeholder: t('share.fStoryPh'), rows: '3' }),
      el('label.dropzone', null, [
        el('span', { html: ICONS.upload }),
        el('span', { text: t('share.drop') }),
        el('span.dropzone__note', { text: t('share.dropNote') }),
        el('input', { type: 'file', 'class': 'sr-only' })
      ]),
      el('div.review-note', { text: t('share.review') }),
      el('div.dialog__actions', null, [
        el('button.btn.btn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.btn.btn--primary', { type: 'submit', text: t('share.submit') })
      ])
    ]);

    scrim = overlayShell('scrim.scrim--heavy', [form], close);
  }

  /* ── Map ─────────────────────────────────────────────────── */

  var mapInstance = null;
  var markerLayer = null;

  function memoriesForDecade() {
    if (state.decade === 'all') return DATA.MEMORIES;
    return DATA.MEMORIES.filter(function (memory) { return memory.decade === state.decade; });
  }

  function renderMap() {
    var decades = [{ id: 'all', label: t('map.all') }].concat(DATA.DECADES.map(function (d) {
      return { id: d, label: t('decade.' + d) };
    }));

    var bar = el('div.decade-bar', null, [
      el('div.decade-bar__inner', { role: 'group', 'aria-label': t('map.decade') },
        [el('span.decade-bar__label', { text: t('map.decade') })].concat(decades.map(function (option) {
          return el('button.decade', {
            type: 'button',
            'aria-pressed': state.decade === option.id ? 'true' : 'false',
            onclick: function () { state.decade = option.id; refreshMap(); },
            text: option.label
          });
        })))
    ]);

    return el('div.map-page', null, [
      el('div', { id: 'map' }),
      el('div.map-count', { id: 'map-count' }),
      bar
    ]);
  }

  function initMap() {
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
    mapInstance = L.map('map', { zoomControl: true, attributionControl: true })
      .setView(RAMALLAH, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(mapInstance);
    markerLayer = L.layerGroup().addTo(mapInstance);
    refreshMap();
  }

  function refreshMap() {
    if (!mapInstance) return;
    var visible = memoriesForDecade();

    // Memories cluster by place, so a pin carries a count rather than overlapping.
    var byPlace = {};
    visible.forEach(function (memory) {
      (byPlace[memory.place] = byPlace[memory.place] || []).push(memory);
    });

    markerLayer.clearLayers();
    Object.keys(byPlace).forEach(function (placeId) {
      var place = DATA.place(placeId);
      if (!place) return;
      var group = byPlace[placeId];
      var icon = L.divIcon({
        className: '',
        html: '<span class="map-pin"><span class="map-pin__dot">' + num(group.length) + '</span>' +
              '<span class="map-pin__label">' + pick(place.name) + '</span></span>',
        iconSize: [22, 22],
        iconAnchor: [11, 11]
      });
      L.marker([place.lat, place.lng], { icon: icon, keyboard: true, title: pick(place.name) })
        .addTo(markerLayer)
        .on('click', function () { openMapCard(group[0]); });
    });

    var counter = qs('#map-count');
    if (counter) counter.textContent = t('map.inView', { n: num(visible.length) });

    UI.qsa('.decade').forEach(function (node) {
      var label = node.textContent;
      var expected = state.decade === 'all' ? t('map.all') : t('decade.' + state.decade);
      node.setAttribute('aria-pressed', label === expected ? 'true' : 'false');
    });
  }

  function openMapCard(memory) {
    var scrim;
    function close() { closeOverlay(scrim); }
    var place = DATA.place(memory.place);
    var likes = state.likes[memory.id] != null ? state.likes[memory.id] : memory.likes;

    var comments = (memory.comments || []).length
      ? el('ul.map-card__comments', null, memory.comments.map(function (comment) {
          return el('li.comment', null, [
            el('span.comment__avatar', { text: pick(comment.initial) }),
            el('div', null, [
              el('div.comment__head', null, [
                el('span.comment__name', { text: pick(comment.name) }),
                el('span.comment__when', { text: pick(comment.when) })
              ]),
              el('p.comment__body', { text: pick(comment.body) })
            ])
          ]);
        }))
      : el('div.map-card__comments', null, el('p.comments__empty', { text: t('comments.empty') }));

    var card = el('div.map-card', null, [
      el('div.map-card__plate.plate', { style: toneStyle(memory.tone) },
        el('span.mono', { text: memory.plate || pick(memory.title) })),
      el('div.map-card__body', null, [
        el('button.map-card__back', { type: 'button', onclick: close, text: t('map.back') }),
        el('h2.map-card__title', { text: pick(memory.title) }),
        el('div.memory__gloss.gloss-line', { text: gloss(memory.title) }),
        el('div.map-card__meta', null, [
          badgeFor(memory),
          el('span.era', { text: t('decade.' + memory.decade) }),
          el('span.viewer__place', { style: 'color:var(--ink-60)', text: place ? pick(place.name) : '' }),
          el('span.viewer__place', { style: 'color:var(--ink-45)', text: '♡ ' + num(likes) })
        ]),
        el('div.map-card__divider'),
        el('div.map-card__comments-head', {
          html: t('comments.title') + ' <b>' + num((memory.comments || []).length) + '</b>'
        }),
        comments,
        el('button.locked-prompt', {
          type: 'button',
          onclick: state.signedIn ? function () { UI.toast(t('comments.title')); } : function () { close(); openGate(); }
        }, [
          el('span.locked-prompt__lock', { html: ICONS.lock('#26281F') }),
          el('span', { text: state.signedIn ? t('comments.title') : t('comments.lockedShort') })
        ])
      ])
    ]);

    scrim = overlayShell('scrim.scrim--heavy', [card], close);
  }

  /* ── Events ──────────────────────────────────────────────── */

  function renderEvents() {
    return el('div', null, [
      el('div.page-head', null, [
        el('div', null, [
          el('h1.page-head__title', { text: t('events.title') }),
          el('p.page-head__blurb', { text: t('events.blurb') })
        ]),
        el('span.page-head__count', { text: t('events.count', { n: num(DATA.EVENTS.length) }) })
      ]),
      el('ul.events', null, DATA.EVENTS.map(function (event) {
        var plate = event.voice
          ? el('div.event__plate.event__plate--voice', null, el('span', { html: ICONS.waveform(150, 28, 7) }))
          : el('div.event__plate.plate', { style: toneStyle(event.tone) }, el('span.mono', { text: event.plate }));
        plate.appendChild(el('span.event__date', { text: pick(event.date) }));

        return el('li.event', null, [
          plate,
          el('div.event__body', null, [
            el('h2.event__title', { text: pick(event.title) }),
            el('div.event__gloss.gloss-line', { text: gloss(event.title) }),
            el('div.event__where', { text: pick(event.where) }),
            el('span.event__publisher.event__publisher--' + event.publisher, {
              text: t('publisher.' + event.publisher)
            })
          ])
        ]);
      }))
    ]);
  }

  /* Voice events use the gold-on-olive waveform from the design. */
  function tintVoiceWaveforms() {
    UI.qsa('.event__plate--voice rect').forEach(function (rect, i) {
      rect.setAttribute('fill', i < 7 ? '#D9A441' : 'rgba(247,244,236,.3)');
    });
  }

  /* ── Render ──────────────────────────────────────────────── */

  function render() {
    var name = route();
    var memoryIndex = routedMemoryIndex();

    renderMasthead();
    renderFooter();

    var view = qs('#view');
    if (name === 'map') {
      mount(view, renderMap());
      qs('#site-footer').hidden = true;
      initMap();
    } else {
      qs('#site-footer').hidden = false;
      if (mapInstance) { mapInstance.remove(); mapInstance = null; }
      mount(view, name === 'events' ? renderEvents() : renderArchive());
      if (name === 'events') tintVoiceWaveforms();
    }

    // The viewer is a route, not a mode: #/m/<id> opens it over the archive.
    closeViewer();
    if (memoryIndex > -1) openViewer(memoryIndex);
    else global.scrollTo(0, 0);
  }

  global.addEventListener('hashchange', render);
  global.addEventListener('langchange', render);

  // The archive is masonry across a variable column count; re-lay it out on resize.
  var resizeTimer = null;
  var lastColumns = columnCount();
  global.addEventListener('resize', function () {
    global.clearTimeout(resizeTimer);
    resizeTimer = global.setTimeout(function () {
      var next = columnCount();
      if (next !== lastColumns && route() === 'archive' && !state.viewer) {
        lastColumns = next;
        mount(qs('#view'), renderArchive());
      }
      if (mapInstance) mapInstance.invalidateSize();
    }, 150);
  });

  render();
})(window);
