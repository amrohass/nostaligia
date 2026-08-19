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

  /* Content comes from the store — the same records the dashboard edits. DATA
     still supplies places, decades and tone palettes, which are reference data
     rather than editable content.

     `memories` is a plain array because the viewer indexes into it; it is
     refreshed from the store at the top of every render. */
  var memories = [];

  function refreshContent() {
    memories = Store.list('memories', function (m) { return m.status !== 'hidden'; });
  }

  function events() {
    return Store.list('events');
  }

  /** An editorial copy block, in the active language. */
  function copyText(id) {
    return pick(Store.copy(id));
  }

  /* The session is AUTH's now, not this file's.

     Until M1 piece 4 this module kept its own `rma.signedIn` flag in sessionStorage and a
     hardcoded member record. Both are gone: `state.signedIn` mirrors AUTH so the views can
     read it synchronously while rendering, and AUTH.onChange keeps that mirror honest.

     `state.userId` still points at a Store record, because profiles, comments and
     attribution all read from the prototype store and that store is M3's to replace. The
     bridge is deliberately one line and deliberately ugly, so it is obvious what has to go
     when the store becomes real: a signed-in member is shown against the demo profile. */
  var DEMO_USER_ID = 'm1';

  var state = {
    signedIn: false,
    userId: null,
    account: null,     // { id, email, role } from AUTH — the real identity
    likes: {},
    decade: 'all',
    viewer: null,      // { index }
    mapCard: null,     // memory id
    editOpen: false,   // profile edit panel
    releaseTrap: null,
    /* §9: "The sign-in gate always preserves intent — the pending action and its item
       survive the auth round-trip and the user returns exactly where they were." This is
       where that intent is parked while the member signs in. */
    pending: null      // { run: function, label: string }
  };

  function adoptAccount(account) {
    state.account = account;
    state.signedIn = account !== null;
    state.userId = account ? DEMO_USER_ID : null;
  }

  function currentUser() {
    return state.userId ? Store.get('users', state.userId) : null;
  }

  /* ── Routing ─────────────────────────────────────────────── */

  function hashPath() {
    return global.location.hash.replace(/^#\/?/, '');
  }

  function route() {
    var hash = hashPath();
    if (hash.slice(0, 2) === 'm/') return 'archive';
    if (hash === 'me' || hash.slice(0, 2) === 'u/') return 'profile';
    if (hash === 'page' || hash.slice(0, 5) === 'page/') return 'page';
    return ['archive', 'map', 'events'].indexOf(hash) > -1 ? hash : 'archive';
  }

  /** #/me is the signed-in member; #/u/<id> is somebody else. */
  function routedProfileId() {
    var hash = hashPath();
    if (hash === 'me') return state.userId;
    if (hash.slice(0, 2) === 'u/') return hash.slice(2);
    return null;
  }

  /** #/page/<slug> scrolls to a section; bare #/page starts at the top. */
  function routedPageSlug() {
    var hash = hashPath();
    return hash.slice(0, 5) === 'page/' ? hash.slice(5) : null;
  }

  /** #/m/<id> deep-links a single memory, so every one of them has a URL. */
  function routedMemoryIndex() {
    var hash = global.location.hash.replace(/^#\/?/, '');
    if (hash.slice(0, 2) !== 'm/') return -1;
    var id = hash.slice(2);
    for (var i = 0; i < memories.length; i++) if (memories[i].id === id) return i;
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
      var me = currentUser();
      actions.push(el('button.btn.btn--primary.btn--share', { type: 'button', onclick: openShareSheet }, [
        el('span.plus', { text: '+' }),
        t('action.share')
      ]));
      // The avatar is the way into your own profile; sign-out moved beside it.
      actions.push(el('a.avatar-btn', {
        href: '#/me',
        title: t('profile.mine'),
        'aria-label': t('profile.mine'),
        'aria-current': current === 'profile' && routedProfileId() === state.userId ? 'page' : null,
        style: me && me.tone ? '--p1:' + me.tone : null,
        text: me ? pick(me.initial) : (I18N.lang === 'ar' ? 'ع' : 'M')
      }));
      actions.push(el('button.btn.btn--quiet.masthead__signout', {
        type: 'button', onclick: signOut, text: t('action.signOut')
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
          el('p.site-footer__blurb', { text: copyText('footer.blurb') })
        ]),
        // Each link deep-links to its own section of the info page.
        el('nav.site-footer__links', { 'aria-label': t('footer.project') }, [
          el('div.site-footer__heading', { text: t('footer.project') })
        ].concat(Store.list('pages').map(function (section) {
          return el('a', { href: '#/page/' + section.slug, text: pick(section.title) });
        }).concat([
          el('a', { href: '#/page/support', text: t('footer.terms') })
        ]))),
        el('div.donate', null, [
          el('div.donate__title', { text: copyText('donate.title') }),
          el('p.donate__blurb', { text: copyText('donate.blurb') }),
          el('a.btn', { href: '#/page/donate', text: t('donate.cta') })
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
    memories.forEach(function (memory, i) {
      columns[i % count].push(memoryCard(memory, i));
    });

    return el('div', { dataset: { cols: String(count) } }, [
      el('section.hero', null, [
        el('h1.hero__line', { text: copyText('hero.line') }),
        el('p.hero__blurb', { text: copyText('hero.blurb') }),
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
    var memory = memories[index];
    var overlay = qs('#viewer');
    if (!overlay) return;

    qs('.viewer__position', overlay).textContent =
      num(index + 1) + ' / ' + num(memories.length);

    mount(qs('.viewer__rail', overlay), viewerRail(memory));
    mount(qs('.viewer__comments', overlay), commentsPanel(memory));
  }

  /* Comments are their own collection now, so they can be listed on a profile and
     moderated from the dashboard. Each one resolves its author to a real user. */
  function commentRow(comment, tag) {
    var author = Store.author(comment) || {};
    return el(tag || 'li.comment', null, [
      profileLink(author, el('span.comment__avatar', {
        style: author.tone ? '--p1:' + author.tone : null,
        text: pick(author.initial || { ar: '؟', en: '?' })
      })),
      el('div', null, [
        el('div.comment__head', null, [
          profileLink(author, el('span.comment__name', { text: pick(author.name || { ar: 'عضو', en: 'Member' }) })),
          el('span.comment__when', { text: pick(comment.when) })
        ]),
        el('p.comment__body', { text: pick(comment.body) })
      ])
    ]);
  }

  function commentsPanel(memory) {
    var rows = Store.commentsOn(memory.id);
    var list = rows.length
      ? el('ul.comments__list', null, rows.map(function (comment) { return commentRow(comment); }))
      : el('div.comments__list', null, el('p.comments__empty', { text: t('comments.empty') }));

    return [
      el('div.comments__head', null, [
        el('div.comments__count', { html: t('comments.title') + ' <b>' + num(rows.length) + '</b>' }),
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
    }, memories.map(viewerSlide));

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
      index = Math.max(0, Math.min(memories.length - 1, index));
      if (index !== state.viewer.index) {
        state.viewer.index = index;
        renderViewerChrome(index);
        // Keep the address bar on the memory in view without stacking history.
        global.history.replaceState(null, '', '#/m/' + memories[index].id);
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
    var memory = memories[state.viewer.index];
    var current = state.likes[memory.id] != null ? state.likes[memory.id] : memory.likes;
    state.likes[memory.id] = current === memory.likes ? current + 1 : memory.likes;
    renderViewerChrome(state.viewer.index);
  }

  /** Wraps a member-only action so a signed-out visitor gets the gate instead.
   *
   *  The action is handed to the gate as the pending intent (§9), so liking an item from
   *  the viewer signs you in and then likes it — rather than signing you in and leaving
   *  you to find the item again and work out whether the first press registered. */
  function guard(action) {
    return function () {
      if (!state.signedIn) { openGate(action); return; }
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

  /**
   * The sign-in gate.
   *
   * §9 requires it to preserve intent: whatever the member was trying to do is parked in
   * `state.pending` and replayed the moment they are signed in, so they land back on the
   * same item rather than on the archive with their action forgotten.
   *
   * @param {function} [intent]  what to re-run once signed in
   */
  function openGate(intent) {
    state.pending = typeof intent === 'function' ? { run: intent } : null;
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

  /* socialRow() lived here. CLAUDE.md §2 is unambiguous — "Auth | Supabase Auth, email +
     password only" — and the Google and Apple buttons were prototype decoration wired to a
     toast. Removed rather than hidden: a disabled social button is a promise, and this
     archive is not going to hand a third-party identity provider the list of who
     contributes to it (§7). */

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
    function close() { closeOverlay(scrim); if (widget) widget.remove(); }

    /* §6: Turnstile on signup. It is mounted for sign-in too — credential stuffing against
       a password endpoint is the same bot problem, and the widget is invisible when the
       visitor is unremarkable. */
    var captchaSlot = el('div.captcha');
    var widget = null;

    var errorNote = el('p.form-error', { role: 'alert', hidden: true });
    function showError(key, vars) {
      /* textContent, never innerHTML — §6. These strings are ours, but the habit is the
         defence: the day one of them interpolates a server value, this is already safe. */
      errorNote.textContent = t(key, vars);
      errorNote.hidden = false;
    }
    function clearError() { errorNote.hidden = true; errorNote.textContent = ''; }

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

    body.push(captchaSlot);
    body.push(errorNote);
    body.push(el('div.dialog__foot', null, mode === 'signup'
      ? [t('signup.haveAcct') + ' ', el('a', { href: '#', onclick: function (e) { e.preventDefault(); close(); openAuth('login'); }, text: t('action.signIn') })]
      : [t('login.newHere') + ' ', el('a', { href: '#', onclick: function (e) { e.preventDefault(); close(); openAuth('signup'); }, text: t('login.createOne') })]
    ));

    var busy = false;

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        if (busy) return;

        var email = (UI.qs('input[type=email]', form) || {}).value || '';
        var password = (UI.qs('input[type=password]', form) || {}).value || '';
        var submitButton = UI.qs('button[type=submit]', form);

        clearError();
        busy = true;
        if (submitButton) { submitButton.disabled = true; submitButton.textContent = t('auth.working'); }

        function finish() {
          busy = false;
          if (submitButton) {
            submitButton.disabled = false;
            submitButton.textContent = t(mode === 'signup' ? 'signup.submit' : 'login.submit');
          }
          /* A Turnstile token is single-use and was just spent. Without this reset the
             member's second attempt sends a token the server has already seen and is told
             they are a robot for pressing the button twice. */
          if (widget) widget.reset();
        }

        widget.token().then(function (captcha) {
          return mode === 'signup'
            ? AUTH.signUp(email, password, captcha).then(function (result) {
              if (result.confirmationRequired) {
                close();
                UI.toast(t('auth.confirmSent'));
                return null;
              }
              return result.user;
            })
            : AUTH.signIn(email, password, captcha);
        }).then(function (account) {
          if (account === null) return;   // awaiting email confirmation
          close();
          onSignedIn(account);
        }).catch(function (err) {
          showError(err && err.key ? err.key : 'auth.err.generic');
          finish();
        });
      }
    }, body);

    scrim = overlayShell('scrim', [form], close);
    widget = TURNSTILE.mount(captchaSlot);
  }

  /* Everything that has to happen once a real session exists. Called from the auth dialog
     and from AUTH.restore() at startup, so a restored session and a fresh sign-in take
     exactly the same path — the bug that pattern avoids is the one where a reloaded page
     looks signed in but never replays the pending intent. */
  function onSignedIn(account) {
    adoptAccount(account);
    renderMasthead();
    if (state.viewer) renderViewerChrome(state.viewer.index);

    /* §9. The action that hit the gate runs now, and the member ends up where they were
       rather than being returned to the archive to find their own way back. */
    var pending = state.pending;
    state.pending = null;
    if (pending && pending.run) {
      try { pending.run(); } catch (e) { /* a stale intent must not break the sign-in */ }
    } else {
      UI.toast(t('login.title'));
    }
  }

  function signOut() {
    AUTH.signOut();
    adoptAccount(null);
    state.pending = null;
    // A profile route is member-only; drop back to the archive on the way out.
    if (route() === 'profile') { global.location.hash = '#/archive'; return; }
    renderMasthead();
    if (state.viewer) renderViewerChrome(state.viewer.index);
  }

  /* ── Share sheet ─────────────────────────────────────────── */

  function openShareSheet() {
    /* §9's gate, with intent: a signed-out visitor who presses Share is returned to this
       sheet after signing in, not to the archive. */
    if (!state.signedIn) { openGate(openShareSheet); return; }

    var scrim;
    var kind = 'photo';
    function close() { closeOverlay(scrim); if (widget) widget.remove(); }

    var captchaSlot = el('div.captcha');
    var widget = null;
    var fileInput = el('input', { type: 'file', 'class': 'sr-only', accept: 'image/*,video/*,audio/*' });

    var statusNote = el('p.form-status', { role: 'status', hidden: true });
    var errorNote = el('p.form-error', { role: 'alert', hidden: true });
    var progressBar = el('div.progress__fill');
    var progress = el('div.progress', { hidden: true, role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' }, progressBar);

    function say(key) { statusNote.textContent = t(key); statusNote.hidden = false; }
    function fail(key, vars) { errorNote.textContent = t(key, vars); errorNote.hidden = false; }
    function clearNotes() {
      errorNote.hidden = true; errorNote.textContent = '';
      statusNote.hidden = true; statusNote.textContent = '';
      progress.hidden = true;
    }

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

    /* §7's three, asked here because §7 says "captured at upload" — and because a licence
       collected afterwards is a licence collected from someone who has already lost
       interest. claim_upload_slot refuses the upload without them (migration 0032); the
       `required` attributes below are a courtesy that saves a round-trip.

       The vocabulary comes from UPLOAD.LICENSES rather than being written out here: the
       list the sheet OFFERS and the list the database ACCEPTS drifting apart would show up
       as an invalid_license refusal on a value the member was handed. */
    var licenseSelect = el('select.input', { required: true },
      UPLOAD.LICENSES.map(function (id, i) {
        return el('option', { value: id, selected: i === 0 ? true : null, text: t('license.' + id) });
      }));

    var provenanceInput = el('input.input', {
      type: 'text', required: true, placeholder: t('share.fProvenancePh')
    });

    var consentBox = el('input', { type: 'checkbox', required: true });

    var busy = false;

    var form = el('form.dialog.dialog--sheet', {
      onsubmit: function (event) {
        event.preventDefault();
        if (busy) return;

        var inputs = UI.qsa('.input', form);
        var titleValue = (inputs[0] || {}).value || '';
        var storyValue = (UI.qs('textarea.input', form) || {}).value || '';
        var file = fileInput.files && fileInput.files[0];
        var submitButton = UI.qs('button[type=submit]', form);

        clearNotes();
        if (!file) { fail('up.err.noFile'); return; }

        /* The archive is Arabic-first (§9) but a contributor writes in whichever language
           they think in, and nothing here can tell which. Sending the text as `_ar` would
           file an English caption under Arabic; the database only requires ONE of the pair
           (posts_has_a_title), so the honest move is to fill the side matching the
           interface they are using and leave the other for a moderator. */
        var lang = I18N.lang === 'en' ? 'en' : 'ar';
        var draft = { kind: kind === 'voice' ? 'voice' : kind === 'event' ? 'event' : 'media' };
        draft['title_' + lang] = titleValue;
        draft['body_' + lang] = storyValue;

        /* §7. Only `granted` is sent — granted_at is stamped by the database, because a
           timestamp evidencing that someone agreed at a moment is worthless if the person
           being evidenced supplied it, and may_withdraw is a right §7 grants rather than
           one the contributor elects. */
        draft.license = licenseSelect.value;
        draft.provenance = provenanceInput.value;
        draft.consent = { granted: consentBox.checked };

        busy = true;
        if (submitButton) { submitButton.disabled = true; submitButton.textContent = t('auth.working'); }

        function release() {
          busy = false;
          if (submitButton) { submitButton.disabled = false; submitButton.textContent = t('share.submit'); }
          /* Single-use, and just spent. See openAuth for the failure this prevents. */
          if (widget) widget.reset();
        }

        widget.token().then(function (captcha) {
          return UPLOAD.submit(file, draft, captcha, {
            onStage: function (name) {
              say('up.stage.' + name);
              progress.hidden = name !== 'uploading';
            },
            onProgress: function (fraction) {
              var pct = Math.round(fraction * 100);
              progressBar.style.inlineSize = pct + '%';
              progress.setAttribute('aria-valuenow', String(pct));
            }
          });
        }).then(function () {
          close();
          UI.toast(t('share.sent'));
        }).catch(function (err) {
          var key = err && err.key ? err.key : 'up.err.generic';
          /* The limits are in the message because "too big" without a number is a message
             that cannot be acted on. */
          fail(key, key === 'up.err.tooBig'
            ? { n: Math.round(UPLOAD._limits.maxBytes / (1024 * 1024)) }
            : key === 'up.err.tooLong'
            ? { n: Math.round(UPLOAD._limits.maxDurationS / 60) }
            : undefined);
          release();
        });
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
        fileInput
      ]),
      el('div.field-pair', null, [
        el('div.field', null, [
          el('label.field__label', { text: t('share.fLicense') }),
          licenseSelect,
          el('p.field__hint', { text: t('share.fLicenseNote') })
        ]),
        el('div.field', null, [
          el('label.field__label', { text: t('share.fProvenance') }),
          provenanceInput
        ])
      ]),
      el('label.checkbox.checkbox--wrap', null, [
        consentBox,
        el('span', { text: t('share.consent') })
      ]),
      captchaSlot,
      progress,
      statusNote,
      errorNote,
      el('div.review-note', { text: t('share.review') }),
      el('div.dialog__actions', null, [
        el('button.btn.btn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.btn.btn--primary', { type: 'submit', text: t('share.submit') })
      ])
    ]);

    scrim = overlayShell('scrim.scrim--heavy', [form], close);
    widget = TURNSTILE.mount(captchaSlot);
  }

  /* ── Profile ─────────────────────────────────────────────────
     Display name, avatar and role badge are never gated — attribution has to stay
     legible or the archive stops crediting anyone. Everything else is governed by
     the user's `visibility` map. The owner viewing #/me sees all of it, with each
     private section flagged so they can tell what visitors are missing. */

  function profileLink(user, node) {
    if (!user || !user.id) return node;
    return el('a.profile-link', { href: '#/u/' + user.id, tabindex: '-1' }, node);
  }

  function isPublic(user, field) {
    return (user.visibility || {})[field] !== 'private';
  }

  function avatarNode(user, className) {
    return el('span.' + (className || 'profile__avatar'), {
      style: user.tone ? '--p1:' + user.tone : null,
      'aria-hidden': 'true',
      text: pick(user.initial)
    });
  }

  function privateFlag() {
    return el('span.privacy-flag', { text: t('profile.ownerOnly') });
  }

  /** One profile section, or nothing at all when a visitor may not see it.
      The count is its own element — a "·" between an Arabic label and a digit
      reads ambiguously once bidi reorders the line. */
  function profileSection(user, field, isOwner, title, count, body) {
    var visible = isPublic(user, field);
    if (!visible && !isOwner) return null;
    return el('section.profile__section', null, [
      el('div.profile__section-head', null, [
        el('h2.profile__section-title', { text: title }),
        el('span.profile__section-count', { text: num(count) }),
        !visible ? privateFlag() : null
      ]),
      body
    ]);
  }

  function renderProfile(userId) {
    var user = Store.get('users', userId);
    if (!user) {
      return el('div.page-head', null, [
        el('h1.page-head__title', { text: t('profile.notFound') }),
        el('p.page-head__blurb', null, el('a', { href: '#/archive', text: t('viewer.back') }))
      ]);
    }

    /* #/me is your own view; #/u/<id> is always the public one — including for
       your own id, which makes it a preview of what visitors actually get. */
    var isSelf = state.signedIn && user.id === state.userId;
    var isOwner = isSelf && hashPath() === 'me';
    var contributions = Store.memoriesFor(user.id);
    var comments = Store.commentsFor(user.id);

    var facts = [];
    if (isPublic(user, 'personalInfo') || isOwner) {
      if (user.city) facts.push(el('span.profile__fact', { text: pick(user.city) }));
      if (user.joined) facts.push(el('span.profile__fact', { text: t('profile.memberSince', { n: I18N.year(user.joined) }) }));
      if (!isPublic(user, 'personalInfo')) facts.push(privateFlag());
    }

    var header = el('header.profile__header', null, [
      avatarNode(user),
      el('div.profile__identity', null, [
        el('h1.profile__name', { text: pick(user.name) }),
        el('div.profile__gloss.gloss-line', { text: gloss(user.name) }),
        el('div.profile__badges', null, [
          el('span.badge', { text: t('mb.role' + roleKey(user)) }),
          isOwner ? el('span.badge.badge--voice', { text: t('profile.you') }) : null
        ]),
        facts.length ? el('div.profile__facts', null, facts) : null
      ])
    ]);

    var bio = (isPublic(user, 'bio') || isOwner) && pick(user.bio)
      ? el('div.profile__bio-wrap', null, [
          el('p.profile__bio', { text: pick(user.bio) }),
          !isPublic(user, 'bio') ? privateFlag() : null
        ])
      : null;

    var contributionsBody = contributions.length
      ? el('div.profile__grid', null, contributions.map(function (memory) { return memoryCard(memory); }))
      : el('p.profile__empty', { text: t('profile.noContributions') });

    var commentsBody = comments.length
      ? el('ul.profile__comments', null, comments.map(function (comment) {
          var memory = Store.get('memories', comment.memoryId);
          return el('li.profile__comment', null, [
            el('p.comment__body', { text: pick(comment.body) }),
            el('div.profile__comment-meta', null, [
              memory
                ? el('a', { href: '#/m/' + memory.id, text: t('profile.onMemory', { t: pick(memory.title) }) })
                : el('span', { text: t('profile.onRemoved') }),
              el('span.comment__when', { text: pick(comment.when) })
            ])
          ]);
        }))
      : el('p.profile__empty', { text: t('profile.noComments') });

    return el('div.profile', null, [
      isSelf && !isOwner
        ? el('div.profile__preview', null, [
            el('span', { text: t('profile.previewNotice') }),
            el('a', { href: '#/me', text: t('profile.backToMine') })
          ])
        : null,
      header,
      bio,
      isOwner ? editPanel(user) : null,
      profileSection(user, 'contributions', isOwner, t('profile.contributions'), contributions.length, contributionsBody),
      profileSection(user, 'comments', isOwner, t('profile.comments'), comments.length, commentsBody)
    ]);
  }

  function roleKey(user) {
    var map = { editor: 'Editor', partner: 'Partner', narrator: 'Narrator', admin: 'AdminShort' };
    if (map[user.role]) return map[user.role];
    return user.feminine ? 'ContributorF' : 'ContributorM';
  }

  /* ── Edit profile & privacy (owner only) ─────────────────── */

  function editPanel(user) {
    var open = state.editOpen;

    var controls = el('div.profile__edit-controls', null, [
      el('button.btn.btn--ghost.profile__edit-toggle', {
        type: 'button',
        'aria-expanded': open ? 'true' : 'false',
        onclick: function () { state.editOpen = !state.editOpen; render(); },
        text: t('profile.editTitle')
      }),
      el('a.profile__preview-link', { href: '#/u/' + user.id, text: t('profile.previewLink') })
    ]);

    if (!open) return el('div.profile__edit', null, controls);

    var namePair = UI.langPair(t('profile.displayName'), user.name);
    var bioPair = UI.langPair(t('profile.bio'), user.bio, { multiline: true, rows: '3' });

    var toggles = Store.VISIBILITY_FIELDS.map(function (fieldName) {
      var on = isPublic(user, fieldName);
      return el('div.privacy-row', null, [
        el('div', null, [
          el('div.privacy-row__name', { text: t('profile.field.' + fieldName) }),
          el('div.privacy-row__hint', { text: t('profile.hint.' + fieldName) })
        ]),
        el('button.switch', {
          type: 'button',
          role: 'switch',
          'aria-checked': on ? 'true' : 'false',
          'aria-label': t('profile.field.' + fieldName) + ' — ' + (on ? t('profile.public') : t('profile.private')),
          onclick: function () {
            var next = {};
            Store.VISIBILITY_FIELDS.forEach(function (f) { next[f] = isPublic(user, f) ? 'public' : 'private'; });
            next[fieldName] = on ? 'private' : 'public';
            Store.set('users', user.id, { visibility: next });
            render();
          }
        }),
        el('span.privacy-row__state', { text: on ? t('profile.public') : t('profile.private') })
      ]);
    });

    var form = el('form.profile__edit-form', {
      onsubmit: function (event) {
        event.preventDefault();
        var name = namePair.read();
        Store.set('users', user.id, {
          // A blank name would erase attribution everywhere, so it falls back.
          name: { ar: name.ar || user.name.ar, en: name.en || user.name.en },
          bio: bioPair.read()
        });
        UI.toast(t('profile.saved'));
        render();
      }
    }, [
      namePair.node,
      bioPair.node,
      el('div.privacy-list', null, [
        el('div.privacy-list__head', null, [
          el('h3.profile__section-title', { text: t('profile.privacyTitle') }),
          el('p.privacy-list__note', { text: t('profile.privacyNote') })
        ])
      ].concat(toggles)),
      el('div.dialog__actions', null, [
        el('button.btn.btn--primary', { type: 'submit', text: t('profile.save') })
      ])
    ]);

    return el('div.profile__edit.profile__edit--open', null, [controls, form]);
  }

  /* ── Info page ───────────────────────────────────────────── */

  function renderInfoPage() {
    var sections = Store.list('pages');

    return el('div.infopage', null, [
      el('div.page-head', null, [
        el('div', null, [
          el('h1.page-head__title', { text: t('page.title') }),
          el('p.page-head__blurb', { text: t('page.blurb') })
        ])
      ]),
      el('nav.infopage__toc', { 'aria-label': t('page.title') }, sections.map(function (section) {
        return el('a.infopage__toc-link', {
          href: '#/page/' + section.slug,
          'aria-current': routedPageSlug() === section.slug ? 'true' : null,
          text: pick(section.title)
        });
      })),
      el('div.infopage__body', null, sections.map(function (section) {
        return el('section.infosection', { id: 'section-' + section.slug }, [
          el('h2.infosection__title', { text: pick(section.title) }),
          el('div.infosection__gloss.gloss-line', { text: gloss(section.title) })
        ].concat(
          pick(section.body).split(/\n\s*\n/).map(function (para) {
            return el('p.infosection__para', { text: para });
          })
        ).concat(
          section.slug === 'donate' ? [donateContact(section)] : []
        ));
      }))
    ]);
  }

  /* Email opens the mail client; the phone number opens WhatsApp. */
  function donateContact(section) {
    var contact = section.contact || {};
    var email = contact.email || '';
    var whatsapp = contact.whatsapp || '';
    var waDigits = whatsapp.replace(/[^\d]/g, '');

    return el('div.donate-contact', null, [
      el('h3.donate-contact__title', { text: t('page.donateReach') }),
      el('div.donate-contact__rows', null, [
        el('a.donate-contact__row', { href: 'mailto:' + email }, [
          el('span.donate-contact__label', { text: t('page.email') }),
          el('span.donate-contact__value.lat', { text: email })
        ]),
        el('a.donate-contact__row', {
          href: waDigits ? 'https://wa.me/' + waDigits : 'https://wa.me/',
          target: '_blank',
          rel: 'noopener'
        }, [
          el('span.donate-contact__label', { text: t('page.whatsapp') }),
          el('span.donate-contact__value.lat', { text: whatsapp })
        ])
      ]),
      el('p.donate-contact__note', { text: t('page.donateNote') })
    ]);
  }

  /* ── Map ─────────────────────────────────────────────────── */

  var mapInstance = null;
  var markerLayer = null;

  function memoriesForDecade() {
    if (state.decade === 'all') return memories;
    return memories.filter(function (memory) { return memory.decade === state.decade; });
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

  /* Returns whether the map actually came up.
     Leaflet is loaded from unpkg, which `script-src 'self'` blocks — so `L` is undefined
     on every deployment that serves the CSP, which is now all of them. admin.js already
     guarded this; here the bare `L.map(...)` threw a ReferenceError that propagated out of
     the router mid-route, AFTER the footer had been hidden, stranding the reader on a
     blank panel with no way onward.
     `typeof` rather than a truthiness test: `L` is an undeclared global, and any other
     check on it throws before it can answer.
     The return value exists so the caller can keep the page coherent — see the map branch
     in the router. */
  function initMap() {
    if (mapInstance) { mapInstance.remove(); mapInstance = null; }
    if (typeof L === 'undefined') return false;
    mapInstance = L.map('map', { zoomControl: true, attributionControl: true })
      .setView(RAMALLAH, 15);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '© OpenStreetMap'
    }).addTo(mapInstance);
    markerLayer = L.layerGroup().addTo(mapInstance);
    refreshMap();
    return true;
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

    var commentRows = Store.commentsOn(memory.id);
    var comments = commentRows.length
      ? el('ul.map-card__comments', null, commentRows.map(function (comment) { return commentRow(comment); }))
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
          html: t('comments.title') + ' <b>' + num(commentRows.length) + '</b>'
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
          el('h1.page-head__title', { text: copyText('events.title') }),
          el('p.page-head__blurb', { text: copyText('events.blurb') })
        ]),
        el('span.page-head__count', { text: t('events.count', { n: num(events().length) }) })
      ]),
      el('ul.events', null, events().map(function (event) {
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
    refreshContent();

    var name = route();
    var memoryIndex = routedMemoryIndex();

    // Profiles are member-only: a signed-out visitor meets the gate and lands back
    // on the archive rather than on an empty page.
    if (name === 'profile' && !state.signedIn) {
      // Captured before the redirect, so signing in returns them to the profile they asked
      // for rather than to the archive they were bounced to (§9).
      var wanted = global.location.hash;
      global.location.replace('#/archive');
      renderMasthead();
      renderFooter();
      mount(qs('#view'), renderArchive());
      openGate(function () { global.location.hash = wanted; });
      return;
    }

    renderMasthead();
    renderFooter();

    var view = qs('#view');
    if (name === 'map') {
      mount(view, renderMap());
      // The footer is hidden because the map fills the viewport. Hide it only once the
      // map is actually up: doing it unconditionally around a map that failed to load
      // removes the last navigation on the page and leaves nothing behind.
      qs('#site-footer').hidden = initMap();
    } else {
      qs('#site-footer').hidden = false;
      if (mapInstance) { mapInstance.remove(); mapInstance = null; }
      if (name === 'profile') mount(view, renderProfile(routedProfileId()));
      else if (name === 'page') mount(view, renderInfoPage());
      else if (name === 'events') { mount(view, renderEvents()); tintVoiceWaveforms(); }
      else mount(view, renderArchive());
    }

    // The viewer is a route, not a mode: #/m/<id> opens it over the archive.
    closeViewer();
    if (memoryIndex > -1) openViewer(memoryIndex);
    else if (name === 'page' && routedPageSlug()) scrollToSection(routedPageSlug());
    else global.scrollTo(0, 0);
  }

  /** #/page/<slug> renders the whole page, then brings that section into view. */
  function scrollToSection(slug) {
    var target = qs('#section-' + slug);
    if (!target) { global.scrollTo(0, 0); return; }
    var top = target.getBoundingClientRect().top + global.pageYOffset - 80;
    global.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  global.addEventListener('hashchange', render);
  global.addEventListener('langchange', render);
  // A dashboard edit in another tab reaches the public site without a reload.
  Store.subscribe(function () { render(); });

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

  /* Restore a session before first paint settles, so a reload does not flash the
     signed-out masthead at a member who never left.

     Deliberately not awaited by render(): the archive is public (§1, "browsing is open"),
     so it must paint whether or not there is a session to restore, and whether or not the
     refresh call succeeds. A failed restore is the ordinary signed-out case. */
  AUTH.restore().then(function (account) {
    if (account) onSignedIn(account);
  });

  /* The session can end without anyone pressing sign-out — a refresh token that has been
     rotated away, or an expiry. AUTH says so; the masthead has to agree. */
  AUTH.onChange(function (account) {
    if (!account && state.signedIn) {
      adoptAccount(null);
      renderMasthead();
      if (route() === 'profile') global.location.hash = '#/archive';
    }
  });
})(window);
