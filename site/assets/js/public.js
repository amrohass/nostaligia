/* The public Atlas — archive, immersive viewer, located items, events, profiles, the info
   page, and the gate that stands between a signed-out visitor and any control that writes.

   ── Where the content comes from ─────────────────────────────

   ARCHIVE, and nothing else. §2: "Static sharded JSON releases on CDN. Zero database reads
   for public visitors." A signed-out reader can browse the whole archive without a single
   request to PostgREST — no token, no anon key in flight, no query log to correlate (§7).

   What still talks to the database, and only for someone already signed in: ENGAGE (their
   own likes, saves and pending comments) and profile_view() on their own profile. Both are
   engagement, which §1 gates behind sign-in anyway.

   store.js is gone. It kept memories, comments, users and page copy in localStorage and let
   any view write to them — README listed that as "client-authoritative unmoderated writes",
   and §5 is unambiguous that unapproved content must be unreadable at the POLICY level
   rather than filtered by a browser that has already been handed it.

   ── Routes are paths ────────────────────────────────────────

   §2: History API, not hash routing. Every one of these is a real URL a server sees, which
   is the whole reason the prerendered item pages in the publisher can exist at all:

     /                 the archive
     /item/{id}        one memory, in the immersive viewer
     /map              located memories, by decade
     /events           events
     /u/{handle}       somebody's profile
     /me               your own
     /page, /page/{s}  the info page, deep-linked to a section

   site/_redirects serves index.html with a 200 for anything unmatched, so a refresh on
   /item/{id} keeps the path rather than 404ing.

   Old #/… links are translated once at boot. A diaspora archive spreads by people sending
   each other links, and the ones already sent do not stop existing when the routing does. */

(function (global) {
  'use strict';

  var el = UI.el, qs = UI.qs, mount = UI.mount, toneStyle = UI.toneStyle, ICONS = UI.ICONS;
  var bdi = UI.bdi;
  var t = function (k, v) { return I18N.t(k, v); };
  var pick = I18N.pick, gloss = I18N.gloss, num = I18N.num;

  /* ── State ───────────────────────────────────────────────── */

  var state = {
    error: null,          // an i18n key, when the archive could not be read

    feed: [],             // accumulated feed entries, newest first
    /* A deep link may land on an item that is nine feed pages down. Rather than loading
       nine pages to find it, it is fetched alone and shown FIRST in the viewer — and kept
       here rather than pushed into state.feed, because the feed is also what the archive
       grid renders and an item jumping to the front of the masonry because somebody
       arrived from WhatsApp is a bug with a very confusing cause. */
    lead: null,
    page: 0,              // highest feed page loaded
    pages: 1,
    total: 0,
    loadingPage: false,

    items: {},            // id -> item shard, once fetched
    liked: {},            // id -> true, from the member's own rows
    saved: {},
    /* Applied on top of the BAKED counts. §2's 20 Aug amendment: baked counters go live
       with the next content change, so the published number can be days old — this is the
       delta from what the member has done in this session, added rather than pretended. */
    likeDelta: {},

    signedIn: false,
    account: null,        // { id, email, role } from AUTH

    decade: 'all',
    viewer: null,         // { index }
    editOpen: false,
    releaseTrap: null,

    /* §9: "The sign-in gate always preserves intent — the pending action and its item
       survive the auth round-trip and the user returns exactly where they were." */
    pending: null
  };

  function adoptAccount(account) {
    state.account = account ? { id: account.id, email: account.email, role: account.role, handle: null } : null;
    state.signedIn = account !== null;
    if (!account) { state.liked = {}; state.saved = {}; state.likeDelta = {}; }
  }

  /** An editorial copy block, in the active language. §9: never a literal in a view. */
  function copyText(id) { return pick(ARCHIVE.block(id)); }

  /* ── Routing ─────────────────────────────────────────────── */

  function path() {
    var p = global.location.pathname || '/';
    return p.length > 1 && p.charAt(p.length - 1) === '/' ? p.slice(0, -1) : p;
  }

  function segments() {
    return path().split('/').filter(Boolean).map(decodeURIComponent);
  }

  function route() {
    var seg = segments();
    if (!seg.length) return 'archive';
    if (seg[0] === 'item') return 'archive';   // the viewer opens OVER the archive
    if (seg[0] === 'u' || seg[0] === 'me') return 'profile';
    if (seg[0] === 'page') return 'page';
    return ['map', 'events'].indexOf(seg[0]) > -1 ? seg[0] : 'archive';
  }

  function routedItemId() {
    var seg = segments();
    return seg[0] === 'item' && seg[1] ? seg[1] : null;
  }

  /** /me is the signed-in member; /u/<handle> is anybody. */
  function routedHandle() {
    var seg = segments();
    if (seg[0] === 'me') return null;
    return seg[0] === 'u' && seg[1] ? seg[1] : null;
  }

  function isOwnProfileRoute() { return segments()[0] === 'me'; }

  function routedPageSlug() {
    var seg = segments();
    return seg[0] === 'page' && seg[1] ? seg[1] : null;
  }

  /**
   * Go somewhere, and re-render.
   *
   * pushState rather than assigning location: the point of History API routing is that a
   * navigation costs no request. `replace` is for the viewer's scroll position, which
   * must not stack a history entry per slide — otherwise Back walks the reader up through
   * every memory they scrolled past instead of leaving the viewer.
   */
  function navigate(to, replace) {
    if (to === path()) return;
    global.history[replace ? 'replaceState' : 'pushState'](null, '', to);
    render();
  }

  /* One listener for every internal link, rather than an onclick on each.

     Delegation is not a micro-optimisation here: cards, the footer, comment bylines and the
     prerendered HTML the publisher emits all produce anchors, and the prerendered ones are
     in the document BEFORE this file runs. A per-link handler would miss exactly those —
     which are the links a visitor who arrived from WhatsApp sees first.

     Modified clicks are left alone. Ctrl/Cmd-click, middle-click and shift-click mean "open
     this elsewhere", and a router that swallows them breaks the one interaction people use
     to keep their place in a feed. */
  function onDocumentClick(event) {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;

    var node = event.target;
    while (node && node !== global.document.body && node.tagName !== 'A') node = node.parentNode;
    if (!node || node.tagName !== 'A') return;

    var href = node.getAttribute('href');
    if (!href || href.charAt(0) !== '/' || node.hasAttribute('target') ||
        node.hasAttribute('download')) return;

    event.preventDefault();
    navigate(href);
  }

  /* Links shared before §2's routing changed. Translated once, with replaceState so the
     old form does not sit in history waiting to be walked back into. */
  function migrateHashRoute() {
    var hash = global.location.hash.replace(/^#\/?/, '');
    if (!hash) return false;
    var to = null;
    if (hash.slice(0, 2) === 'm/') to = '/item/' + encodeURIComponent(hash.slice(2));
    else if (hash === 'me') to = '/me';
    else if (hash.slice(0, 2) === 'u/') to = '/u/' + encodeURIComponent(hash.slice(2));
    else if (hash === 'page') to = '/page';
    else if (hash.slice(0, 5) === 'page/') to = '/page/' + encodeURIComponent(hash.slice(5));
    else if (['archive', 'map', 'events'].indexOf(hash) > -1) to = hash === 'archive' ? '/' : '/' + hash;
    if (!to) return false;
    global.history.replaceState(null, '', to);
    return true;
  }

  /* ── Masthead ────────────────────────────────────────────── */

  var NAV = [['archive', '/'], ['map', '/map'], ['events', '/events']];

  function renderMasthead() {
    var current = route();

    var nav = el('nav.masthead__nav', { 'aria-label': t('nav.archive') }, NAV.map(function (entry) {
      return el('a.navlink', {
        href: entry[1],
        'aria-current': entry[0] === current ? 'page' : null,
        text: t('nav.' + entry[0])
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
      actions.push(el('a.avatar-btn', {
        href: '/me',
        title: t('profile.mine'),
        'aria-label': t('profile.mine'),
        'aria-current': isOwnProfileRoute() ? 'page' : null,
        text: initialFor(state.account)
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
        el('a.wordmark', { href: '/' }, [
          el('span.wordmark__primary', { text: t('brand.name') }),
          el('span.wordmark__secondary', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('brand.counterpart') })
        ]),
        nav
      ]),
      el('div.masthead__actions', null, actions)
    ]);
  }

  /* §7: "avatar is mandatory but defaults to a generated avatar". The generated one is the
     first character of the handle on a tone derived from it — no request, no upload, and
     nothing about the person in it. A real avatar_path lands in M5 with the profile editor. */
  function initialFor(who) {
    var name = who && (who.handle || who.display_name);
    if (!name) return I18N.lang === 'ar' ? 'ع' : 'M';
    return String(name).trim().charAt(0).toUpperCase();
  }

  function avatarTone(handle) {
    var sum = 0;
    String(handle || '').split('').forEach(function (c) { sum += c.charCodeAt(0); });
    var tones = DATA.TONE_NAMES;
    return tones[sum % tones.length];
  }

  /* ── Footer ──────────────────────────────────────────────── */

  function renderFooter() {
    var sections = ARCHIVE.pages();

    mount(qs('#site-footer'), [
      el('div.site-footer__top', null, [
        el('div.site-footer__about', null, [
          el('div.site-footer__mark', { text: t('brand.name') }),
          el('div.site-footer__mark-sub', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('brand.counterpart') }),
          el('p.site-footer__blurb', { text: copyText('footer.blurb') })
        ]),
        el('nav.site-footer__links', { 'aria-label': t('footer.project') }, [
          el('div.site-footer__heading', { text: t('footer.project') })
        ].concat(sections.map(function (section) {
          return el('a', { href: '/page/' + encodeURIComponent(section.slug), text: pick(section.title) });
        }))),
        el('div.donate', null, [
          el('div.donate__title', { text: copyText('donate.title') }),
          el('p.donate__blurb', { text: copyText('donate.blurb') }),
          el('a.btn', { href: '/page/donate', text: t('donate.cta') })
        ])
      ]),
      el('div.site-footer__legal', null, [
        el('span', { text: t('footer.legal') }),
        el('span', { dir: I18N.lang === 'ar' ? 'ltr' : 'rtl', text: t('footer.tag') })
      ])
    ]);
  }

  /* ── The feed ────────────────────────────────────────────── */

  function columnCount() {
    var width = global.innerWidth;
    if (width < 700) return 2;
    if (width < 1040) return 3;
    return 4;
  }

  /**
   * One more page of the feed.
   *
   * Additive: state.feed accumulates, so the masonry does not reflow what is already read
   * and the viewer's index stays valid across a load. Guarded by `loadingPage` because the
   * scroll handler and a deep link can both ask at once.
   */
  function loadNextPage() {
    if (state.loadingPage || state.page >= state.pages) return Promise.resolve();
    state.loadingPage = true;
    var want = state.page + 1;
    return ARCHIVE.feedPage(want).then(function (body) {
      state.page = body.page;
      state.pages = body.pages;
      state.total = body.total;
      var known = {};
      state.feed.forEach(function (row) { known[row.id] = true; });
      body.items.forEach(function (row) { if (!known[row.id]) state.feed.push(row); });
      state.loadingPage = false;
      return refreshEngagement(body.items.map(function (r) { return r.id; }));
    }, function (err) {
      state.loadingPage = false;
      // Only the FIRST page failing is a broken archive. A later page failing leaves what
      // is already on screen intact, which is what a reader mid-scroll needs.
      if (want === 1) state.error = err && err.key ? err.key : 'archive.err.generic';
      throw err;
    });
  }

  /** The member's own like/save rows for a set of ids. No-op when signed out. */
  function refreshEngagement(ids) {
    if (!state.signedIn || !ids || !ids.length) return Promise.resolve();
    return Promise.all([ENGAGE.likedMap(ids), ENGAGE.savedMap(ids)]).then(function (both) {
      Object.keys(both[0]).forEach(function (id) { state.liked[id] = true; });
      Object.keys(both[1]).forEach(function (id) { state.saved[id] = true; });
    });
  }

  function badgeFor(entry) {
    var kind = displayKind(entry);
    var map = { photo: 'badge--photo', voice: 'badge--voice', video: 'badge--video', event: 'badge--voice' };
    return el('span.badge ' + map[kind], { text: t('kind.' + kind) });
  }

  /* The shard carries the schema's `kind` (media|voice|event). What a reader cares about is
     what they are about to look at, which for `media` depends on the thumb's mime — the same
     distinction the moderation queue makes for the same reason. */
  function displayKind(entry) {
    if (entry.kind === 'event') return 'event';
    if (entry.kind === 'voice') return 'voice';
    if (entry.video) return 'video';
    return 'photo';
  }

  function titlePair(row) {
    return { ar: row.title_ar || row.title_en || '', en: row.title_en || row.title_ar || '' };
  }

  function decadeLabel(decade) {
    if (!decade) return '';
    var key = 'decade.' + decade;
    var label = t(key);
    return label === key ? String(decade) : label;
  }

  /**
   * A card.
   *
   * The whole card is one anchor to /item/{id} — a real URL, so it can be copied, opened in
   * a new tab, and crawled. That is §2's History API requirement doing work rather than
   * being satisfied on paper: under hash routing this href was `#/m/<id>`, which no crawler
   * and no preview fetcher has ever been able to resolve.
   */
  function memoryCard(entry) {
    var title = titlePair(entry);
    var parts = [];

    var thumb = entry.thumb ? ARCHIVE.mediaUrl(entry.thumb) : null;

    if (displayKind(entry) === 'voice' && !thumb) {
      parts.push(el('div.memory__voice-head', null, [
        el('div.memory__voice-avatar', { style: toneStyle(avatarTone(entry.id)) }),
        el('div.memory__voice-title', null, bdi(pick(title)))
      ]));
      parts.push(el('div.waveform', null, [
        el('span.waveform__play', { 'aria-hidden': 'true', text: '▶' }),
        ICONS.waveform(130, 24, 7)
      ]));
    } else if (thumb) {
      parts.push(el('div.memory__plate', null, [
        el('img.memory__img', {
          src: thumb,
          alt: pick(title),
          loading: 'lazy',
          decoding: 'async'
        }),
        displayKind(entry) === 'video' ? el('span.memory__duration', { text: '▶' }) : null
      ]));
    } else {
      /* No derivative to show. The hatched plate rather than a broken image: an item can be
         approved with its thumb missing (a takedown that removed the bytes and has not
         reached this cached release yet), and a broken <img> would read as a site fault. */
      parts.push(el('div.memory__plate.plate', {
        style: toneStyle(avatarTone(entry.id), 'height:220px')
      }, el('span.mono', { text: t('feed.noPreview') })));
    }

    var body = [];
    if (displayKind(entry) !== 'voice' || thumb) {
      body.push(el('h3.memory__title', null, bdi(pick(title))));
    }
    if (gloss(title)) body.push(el('div.memory__gloss.gloss-line', null, bdi(gloss(title))));
    body.push(el('div.memory__meta', null, [
      badgeFor(entry),
      entry.decade ? el('span.era', { text: decadeLabel(entry.decade) }) : null
    ]));
    parts.push(el('div.memory__body', null, body));

    return el('a.memory', {
      href: '/item/' + encodeURIComponent(entry.id),
      'aria-label': pick(title)
    }, parts);
  }

  function renderArchive() {
    var count = columnCount();
    var columns = [];
    for (var c = 0; c < count; c++) columns.push([]);
    state.feed.forEach(function (entry, i) { columns[i % count].push(memoryCard(entry)); });

    var more = state.page < state.pages;

    return el('div', { dataset: { cols: String(count) } }, [
      el('section.hero', null, [
        el('h1.hero__line', { text: copyText('hero.line') }),
        el('p.hero__blurb', { text: copyText('hero.blurb') }),
        el('ul.hero__stats', null, [
          el('li', { text: t('hero.memories', { n: num(state.total) }) }),
          el('li', { text: t('hero.decades') })
        ])
      ]),
      state.feed.length
        ? el('div.grid', null, columns.map(function (cards) {
            return el('div.grid__col', null, cards);
          }))
        : el('p.profile__empty', { text: state.error ? t(state.error) : t('feed.empty') }),
      more
        ? el('div.feed-end', null, [
            el('span.dot'), el('span.dot'), el('span.dot'),
            el('span', { text: t('feed.more') })
          ])
        : null
    ]);
  }

  /* ── Immersive viewer ────────────────────────────────────── */

  /**
   * The media element for one item shard.
   *
   * §6's ladder rule is enforced here on the viewport half: "default to 1080p on desktop,
   * 720p on mobile … Never auto-serve the top rung to a phone." ARCHIVE.rendition() picks
   * and, importantly, steps DOWN when the wanted rung is missing rather than up. The
   * connection half — stepping down on a slow link — is M6's, alongside the performance
   * pass that can actually measure it.
   *
   * The master is never here. §6: originals are not CDN-fronted and are reached only
   * through the explicit, sign-in-gated, rate-limited download — and shards.ts drops the
   * `originals` rows before they are written, so there is nothing in this data to reach.
   */
  function mediaNode(item) {
    var wide = global.innerWidth >= 900;
    var poster = ARCHIVE.role(item.media, 'poster') || ARCHIVE.role(item.media, 'thumb');
    var posterUrl = poster ? ARCHIVE.mediaUrl(poster.path) : null;
    var rendition = ARCHIVE.rendition(item.media, wide);
    var title = pick(titlePair(item));

    if (rendition && rendition.mime && rendition.mime.indexOf('video/') === 0) {
      return el('video.viewer__media', {
        src: ARCHIVE.mediaUrl(rendition.path),
        poster: posterUrl,
        controls: true,
        preload: 'none',
        playsinline: true,
        'aria-label': title
      });
    }
    if (rendition && rendition.mime && rendition.mime.indexOf('audio/') === 0) {
      return el('div.viewer__audio', null, [
        posterUrl ? el('img.viewer__audio-art', { src: posterUrl, alt: title }) : ICONS.waveform(240, 40, 7),
        el('audio.viewer__media', {
          src: ARCHIVE.mediaUrl(rendition.path),
          controls: true, preload: 'none', 'aria-label': title
        })
      ]);
    }
    if (rendition) {
      return el('img.viewer__media', {
        src: ARCHIVE.mediaUrl(rendition.path),
        alt: title, decoding: 'async'
      });
    }
    if (posterUrl) return el('img.viewer__media', { src: posterUrl, alt: title, decoding: 'async' });
    return el('div.viewer__plate.plate--deep', { style: toneStyle(avatarTone(item.id)) },
      el('span.mono', { text: t('feed.noPreview') }));
  }

  function viewerSlide(entry) {
    var title = titlePair(entry);
    var slide = el('div.viewer__slide', { dataset: { id: entry.id } }, [
      el('div.viewer__media-wrap', null,
        entry.thumb
          ? el('img.viewer__media', { src: ARCHIVE.mediaUrl(entry.thumb), alt: pick(title), decoding: 'async' })
          : el('div.viewer__plate.plate--deep', { style: toneStyle(avatarTone(entry.id)) },
              el('span.mono', { text: t('feed.noPreview') }))),
      el('div.viewer__caption', null, [
        el('h2.viewer__title', null, bdi(pick(title))),
        gloss(title) ? el('div.viewer__gloss.gloss-line', null, bdi(gloss(title))) : null,
        el('div.viewer__meta', null, [
          el('span.badge', { text: t('kind.' + displayKind(entry)) }),
          entry.decade ? el('span.era', { text: decadeLabel(entry.decade) }) : null,
          el('span.viewer__place')
        ])
      ])
    ]);
    return slide;
  }

  /** Replaces a slide's thumbnail with the real media once the item shard is in. */
  function upgradeSlide(item) {
    var slide = qs('.viewer__slide[data-id="' + cssEscape(item.id) + '"]');
    if (!slide) return;
    mount(qs('.viewer__media-wrap', slide), mediaNode(item));
    var place = qs('.viewer__place', slide);
    if (place) {
      place.textContent = pick({ ar: item.place_ar || '', en: item.place_en || '' });
    }
  }

  /* CSS.escape is not in every browser this has to run on, and the only values passed here
     are post uuids — but a selector built from data is a selector built from data, and the
     day one of these is a slug rather than a uuid this is what stops it being an injection
     into querySelector. */
  function cssEscape(value) {
    return String(value).replace(/["\\]/g, '\\$&');
  }

  function railAction(glyph, label, description, onActivate, pressed) {
    var locked = !state.signedIn;
    return el('button.rail-action', {
      type: 'button',
      onclick: onActivate,
      'aria-pressed': pressed == null ? null : (pressed ? 'true' : 'false'),
      'aria-label': locked ? description + ' — ' + t('action.signIn') : description
    }, [
      el('span.rail-action__glyph', null, [
        glyph,
        locked ? el('span.padlock', null, ICONS.lock('#26281F')) : null
      ]),
      el('span.rail-action__label', { text: label })
    ]);
  }

  /** The published like count plus this session's own delta. See state.likeDelta. */
  function likeCount(entry) {
    var baked = (entry && (entry.likes != null ? entry.likes : 0)) || 0;
    return baked + (state.likeDelta[entry.id] || 0);
  }

  function viewerRail(entry) {
    var liked = Boolean(state.liked[entry.id]);
    var saved = Boolean(state.saved[entry.id]);
    return [
      railAction(el('span', { text: liked ? '♥' : '♡' }), num(likeCount(entry)), t('viewer.like'),
        guard(function () { toggleLike(entry); }), liked),
      railAction(el('span', { text: saved ? '★' : '✩' }), t('viewer.save'), t('viewer.save'),
        guard(function () { toggleSave(entry); }), saved),
      railAction(el('span', { text: '⚑' }), t('viewer.report'), t('viewer.report'),
        guard(function () { openReport('post', entry.id); }))
    ];
  }

  /* What the viewer scrolls through: the deep-linked item, if it is not already in the
     feed, followed by the feed itself. One function so the scroller, the chrome and the
     index arithmetic cannot disagree about the list they are indexing into. */
  function viewerList() {
    if (!state.lead) return state.feed;
    return [state.lead].concat(state.feed.filter(function (r) { return r.id !== state.lead.id; }));
  }

  function renderViewerChrome(index) {
    var list = viewerList();
    var entry = list[index];
    var overlay = qs('#viewer');
    if (!overlay || !entry) return;

    qs('.viewer__position', overlay).textContent =
      num(index + 1) + ' / ' + num(list.length);

    mount(qs('.viewer__rail', overlay), viewerRail(entry));
    mount(qs('.viewer__comments', overlay), commentsPanel(entry));
  }

  /* ── Comments ────────────────────────────────────────────── */

  function commentRow(comment) {
    var who = comment.author || {};
    var name = who.display_name || who.handle || '';
    var avatar = el('span.comment__avatar', {
      style: toneStyle(avatarTone(who.handle || comment.id)),
      text: initialFor(who)
    });

    return el('li.comment', null, [
      who.handle
        ? el('a.profile-link', { href: '/u/' + encodeURIComponent(who.handle), tabindex: '-1' }, avatar)
        : avatar,
      el('div', null, [
        el('div.comment__head', null, [
          who.handle
            ? el('a.profile-link', { href: '/u/' + encodeURIComponent(who.handle) },
                el('span.comment__name', null, bdi(name)))
            : el('span.comment__name', null, bdi(name || t('comments.someone'))),
          el('span.comment__when', { text: comment.day || '' }),
          comment.pending ? el('span.privacy-flag', { text: t('comments.awaiting') }) : null
        ]),
        el('p.comment__body', null, bdi(comment.body))
      ])
    ]);
  }

  /**
   * The thread.
   *
   * Published comments come from the item shard, so a signed-out visitor reads them with no
   * database at all (§2). A signed-in member additionally sees their OWN pending ones,
   * flagged — because a comment that vanished on submit reads as a comment that was lost,
   * and §1's "reviewed before it is public" is a promise the interface should keep out loud.
   */
  function commentsPanel(entry) {
    var item = state.items[entry.id];
    var rows = (item && item.comments) || [];
    var mine = (item && item._mine) || [];

    var all = rows.concat(mine.filter(function (m) { return m.status !== 'published'; })
      .map(function (m) {
        return {
          id: m.id, body: m.body, day: m.created_on,
          author: { handle: null, display_name: t('comments.you') },
          pending: true
        };
      }));

    var list = all.length
      ? el('ul.comments__list', null, all.map(commentRow))
      : el('div.comments__list', null, el('p.comments__empty', { text: t('comments.empty') }));

    return [
      el('div.comments__head', null, [
        el('div.comments__count', null, [
          t('comments.title') + ' ',
          el('b', { text: num(item ? item.comment_count : (entry.comments || 0)) })
        ]),
        el('div.comments__subject', null, bdi(pick(titlePair(entry))))
      ]),
      list,
      state.signedIn ? commentForm(entry) : el('button.locked-prompt', {
        type: 'button',
        onclick: function () { openGate(); }
      }, [
        el('span.locked-prompt__lock', null, ICONS.lock('#26281F')),
        el('span', { text: t('comments.locked') })
      ])
    ];
  }

  function commentForm(entry) {
    var input = el('textarea.input.comment-form__input', {
      rows: '2',
      placeholder: t('comments.placeholder'),
      'aria-label': t('comments.title')
    });
    var note = el('p.form-error', { role: 'alert', hidden: true });
    var button = el('button.btn.btn--primary', { type: 'submit', text: t('comments.send') });

    return el('form.comment-form', {
      onsubmit: function (event) {
        event.preventDefault();
        note.hidden = true;
        button.disabled = true;
        ENGAGE.comment(entry.id, input.value, I18N.lang).then(function () {
          input.value = '';
          button.disabled = false;
          UI.toast(t('comments.sent'));
          // Re-read the member's own comments so the pending one appears where they left it.
          return loadOwnComments(entry.id).then(function () {
            if (state.viewer) renderViewerChrome(state.viewer.index);
          });
        }).catch(function (err) {
          button.disabled = false;
          note.textContent = t(err && err.key ? err.key : 'admin.err.generic');
          note.hidden = false;
        });
      }
    }, [input, note, el('div.comment-form__actions', null, [
      el('span.review-note', { text: t('comments.reviewNote') }),
      button
    ])]);
  }

  function loadOwnComments(id) {
    if (!state.signedIn) return Promise.resolve();
    return ENGAGE.myComments(id).then(function (rows) {
      if (!state.items[id]) return;
      state.items[id]._mine = rows;
    });
  }

  /* ── Viewer plumbing ─────────────────────────────────────── */

  function openViewer(index) {
    state.viewer = { index: index };

    var scroller = el('div.viewer__scroller', { onscroll: onViewerScroll },
      viewerList().map(viewerSlide));

    var overlay = el('div.viewer', {
      id: 'viewer', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('nav.archive')
    }, [
      el('div.viewer__stage', null, [
        scroller,
        el('div.viewer__topbar', null, [
          el('a.viewer__close', { href: '/', text: t('viewer.back') }),
          el('span.viewer__position')
        ]),
        el('div.viewer__rail'),
        el('div.viewer__hint', null, el('span', { text: t('viewer.next') }))
      ]),
      el('aside.viewer__comments')
    ]);

    qs('#overlays').appendChild(overlay);
    global.document.body.style.setProperty('overflow', 'hidden');
    renderViewerChrome(index);
    focusItem(index);

    scroller.scrollTop = index * scroller.clientHeight;

    state.releaseTrap = UI.trapFocus(overlay, closeViewer);
    global.addEventListener('keydown', onViewerKey);
  }

  /** Fetches the item shard for the focused slide and upgrades it in place. */
  function focusItem(index) {
    var entry = viewerList()[index];
    if (!entry) return;
    if (state.items[entry.id]) {
      upgradeSlide(state.items[entry.id]);
      renderViewerChrome(index);
      return;
    }
    ARCHIVE.item(entry.id).then(function (item) {
      if (!item) return;
      state.items[entry.id] = item;
      return loadOwnComments(entry.id).then(function () {
        // The reader may have scrolled on while this was in flight.
        if (!state.viewer || viewerList()[state.viewer.index] !== entry) return;
        upgradeSlide(item);
        renderViewerChrome(index);
      });
    }, function () { /* a slide that could not load its shard keeps its thumbnail */ });
  }

  var scrollSettle = null;
  function onViewerScroll(event) {
    global.clearTimeout(scrollSettle);
    var scroller = event.currentTarget;
    scrollSettle = global.setTimeout(function () {
      var list = viewerList();
      var index = Math.round(scroller.scrollTop / scroller.clientHeight);
      index = Math.max(0, Math.min(list.length - 1, index));
      if (!state.viewer || index === state.viewer.index) return;
      state.viewer.index = index;
      renderViewerChrome(index);
      focusItem(index);
      // replaceState: scrolling is not navigation, and a history entry per slide would make
      // Back walk the reader up through the feed instead of out of the viewer.
      navigateReplaceItem(list[index].id);
      // Near the end, pull the next page in so the scroller keeps going.
      if (index >= list.length - 3) loadMoreIntoViewer();
    }, 90);
  }

  function navigateReplaceItem(id) {
    global.history.replaceState(null, '', '/item/' + encodeURIComponent(id));
  }

  function loadMoreIntoViewer() {
    if (state.page >= state.pages) return;
    var before = viewerList().length;
    loadNextPage().then(function () {
      var scroller = qs('.viewer__scroller');
      if (!scroller) return;
      viewerList().slice(before).forEach(function (entry) {
        scroller.appendChild(viewerSlide(entry));
      });
      if (state.viewer) renderViewerChrome(state.viewer.index);
    }).catch(function () { /* the reader keeps what is already loaded */ });
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
    global.document.body.style.removeProperty('overflow');
    state.viewer = null;
    if (state.releaseTrap) { state.releaseTrap(); state.releaseTrap = null; }
  }

  /* ── Engagement ──────────────────────────────────────────── */

  function toggleLike(entry) {
    var on = !state.liked[entry.id];
    state.liked[entry.id] = on;
    state.likeDelta[entry.id] = (state.likeDelta[entry.id] || 0) + (on ? 1 : -1);
    if (state.viewer) renderViewerChrome(state.viewer.index);

    ENGAGE.setLike(entry.id, on).catch(function (err) {
      // Put it back. An optimistic update that survives a refusal is a client telling a
      // member their like was recorded when the database said no (§5).
      state.liked[entry.id] = !on;
      state.likeDelta[entry.id] = (state.likeDelta[entry.id] || 0) + (on ? -1 : 1);
      if (state.viewer) renderViewerChrome(state.viewer.index);
      UI.toast(t(err && err.key ? err.key : 'admin.err.generic'));
    });
  }

  function toggleSave(entry) {
    var on = !state.saved[entry.id];
    state.saved[entry.id] = on;
    if (state.viewer) renderViewerChrome(state.viewer.index);
    ENGAGE.setSave(entry.id, on).catch(function (err) {
      state.saved[entry.id] = !on;
      if (state.viewer) renderViewerChrome(state.viewer.index);
      UI.toast(t(err && err.key ? err.key : 'admin.err.generic'));
    });
  }

  /** §4 gives moderators "review reports"; until M3 nothing could create one. */
  function openReport(targetType, targetId) {
    var scrim;
    function close() { closeOverlay(scrim); }

    var reason = el('textarea.input', {
      rows: '3', required: true, placeholder: t('report.placeholder'), 'aria-label': t('report.reason')
    });
    var note = el('p.form-error', { role: 'alert', hidden: true });

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        note.hidden = true;
        ENGAGE.report(targetType, targetId, reason.value).then(function () {
          close();
          UI.toast(t('report.sent'));
        }).catch(function (err) {
          note.textContent = t(err && err.key ? err.key : 'admin.err.generic');
          note.hidden = false;
        });
      }
    }, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('report.title') }),
          el('p.dialog__blurb', { text: t('report.blurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ]),
      reason,
      note,
      el('div.dialog__actions', null, [
        el('button.btn.btn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.btn.btn--primary', { type: 'submit', text: t('report.submit') })
      ])
    ]);

    scrim = overlayShell('scrim', [form], close);
  }

  /** Wraps a member-only action so a signed-out visitor gets the gate instead (§9). */
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
    scrim._release = UI.trapFocus(scrim, onDismiss);
    return scrim;
  }

  function closeOverlay(node) {
    if (!node) return;
    if (node._release) node._release();
    node.remove();
  }

  function openGate(intent) {
    state.pending = typeof intent === 'function' ? { run: intent } : null;
    var scrim = overlayShell('scrim', [
      el('div.dialog.dialog--gate', null, [
        el('div.dialog__lock', null, ICONS.lockLarge('#A67B24')),
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
      /* textContent, never markup — §6. These strings are ours, but the habit is the
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
      /* §3: "handle is user-chosen, NOT a legal name." The field that used to sit here
         asked for a full name, which for a politically sensitive archive (§7) is the
         opposite of what onboarding should collect. */
      body.push(field(t('field.handle'), { type: 'text', placeholder: t('field.handlePh'), autocomplete: 'username' },
        el('span.field__hint', { text: t('field.handleNote') })));
      body.push(field(t('field.email'), { type: 'email', placeholder: 'name@example.com', email: true, autocomplete: 'email' }));
      body.push(field(t('field.password'), { type: 'password', placeholder: '••••••••', autocomplete: 'new-password' }));
      body.push(el('div.pact', null, [
        el('span.pact__tick', { 'aria-hidden': 'true', text: '✓' }),
        el('span', { text: t('auth.pact') })
      ]));
      body.push(el('button.btn.btn--primary.btn--block', { type: 'submit', text: t('signup.submit') }));
    } else {
      body.push(field(t('field.email'), { type: 'email', placeholder: 'name@example.com', email: true, autocomplete: 'email' }));
      body.push(field(t('field.password'), { type: 'password', placeholder: '••••••••', autocomplete: 'current-password' },
        el('button.field__hint', {
          type: 'button',
          onclick: function () { UI.toast(t('login.forgot')); },
          text: t('login.forgot')
        })));
      body.push(el('button.btn.btn--olive.btn--block', { type: 'submit', text: t('login.submit') }));
    }

    body.push(captchaSlot);
    body.push(errorNote);
    body.push(el('div.dialog__foot', null, mode === 'signup'
      ? [t('signup.haveAcct') + ' ', el('button.linklike', {
          type: 'button', onclick: function () { close(); openAuth('login'); }, text: t('action.signIn')
        })]
      : [t('login.newHere') + ' ', el('button.linklike', {
          type: 'button', onclick: function () { close(); openAuth('signup'); }, text: t('login.createOne')
        })]
    ));

    var busy = false;

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        if (busy) return;

        var email = (UI.qs('input[type=email]', form) || {}).value || '';
        var password = (UI.qs('input[type=password]', form) || {}).value || '';
        var handleInput = UI.qs('input[autocomplete=username]', form);
        var handle = handleInput ? handleInput.value.trim() : '';
        var submitButton = UI.qs('button[type=submit]', form);

        clearError();
        if (mode === 'signup' && !handle) { showError('signup.err.handleRequired'); return; }

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
              return claimHandle(handle).then(function () { return result.user; });
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

  /**
   * The profile row, written once, by its owner.
   *
   * §3 makes the handle mandatory and user-chosen, and 0004 deliberately has NO trigger
   * creating a profile at signup — "auto-generating one would either leak the email local
   * part or invent a name for someone". So this is the explicit onboarding step that
   * comment names, and it is here rather than in auth.js because it is a profiles INSERT
   * under 0017's policy, not an auth call.
   *
   * A refusal is reported and the sign-up is NOT rolled back: the account exists, the
   * session works, and a taken handle is something the member fixes on their own profile
   * rather than a reason to make them sign up again.
   */
  function claimHandle(handle) {
    var account = AUTH.user();
    if (!account) return Promise.resolve();
    return DB.insert('profiles', { id: account.id, handle: handle, display_name: handle })
      .catch(function () {
        UI.toast(t('signup.err.handleTaken'));
      });
  }

  function onSignedIn(account) {
    adoptAccount(account);
    renderMasthead();
    loadOwnHandle();
    refreshEngagement(state.feed.map(function (r) { return r.id; })).then(function () {
      if (state.viewer) renderViewerChrome(state.viewer.index);
    });

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

  /**
   * The member's own handle.
   *
   * Not in the JWT: §7 makes the handle a user-chosen public identifier stored in
   * `profiles`, and the token carries the auth user id and the role claim. /me needs it to
   * ask for the right profile shard, and the masthead avatar uses its first character.
   *
   * A member with no profile row yet — signed up before the handle step, or whose
   * claimHandle was refused — simply has none, and /me falls back to profile_view() by id
   * returning nothing, which renderProfile shows as the onboarding-incomplete state.
   */
  function loadOwnHandle() {
    if (!state.account) return Promise.resolve();
    var id = state.account.id;
    return DB.select('profiles', 'select=handle,display_name&id=eq.' + encodeURIComponent(id))
      .then(function (rows) {
        if (!state.account || state.account.id !== id) return;
        var row = rows && rows[0];
        if (!row) return;
        state.account.handle = row.handle;
        state.account.display_name = row.display_name;
        renderMasthead();
      }, function () { /* the avatar falls back to a language-appropriate initial */ });
  }

  function signOut() {
    AUTH.signOut();
    adoptAccount(null);
    state.pending = null;
    if (route() === 'profile') { navigate('/'); return; }
    renderMasthead();
    if (state.viewer) renderViewerChrome(state.viewer.index);
  }

  /* ── Share sheet ─────────────────────────────────────────── */

  /* ── Where was this? ─────────────────────────────────────────
     §10's M4, in the order it names: "place-name autocomplete → gazetteer resolution →
     drag-to-confirm pin fallback".

     The three steps are one control because they are one question, and because the ORDER is
     the privacy design rather than a convenience. A contributor who types "المنارة" and
     picks it out of the list attaches their photograph to a curated public landmark, and
     migration 0049 publishes that coordinate unfuzzed — it is already public, in places.json,
     one file over. Only when the gazetteer has no answer does the pin appear, and a pin is a
     coordinate nobody curated, so it publishes snapped to roughly a block (§7).

     Dropping a pin does not end there either: 0049's `places_near` is asked what named
     places are within reach of it, and the contributor is offered them. Somebody who meant
     Al-Manara and tapped thirty metres off should end up attached to Al-Manara rather than
     filed at a coordinate that is nearly it.

     Signed-in only, like everything else in this sheet. `places_search` is granted to
     `authenticated` and to nobody else: §2's "zero database reads for public visitors" is
     not softened by autocomplete being useful. */

  function placePicker() {
    var chosen = null;         // { id, name } from the gazetteer
    var pin = null;            // { lat, lon } a contributor placed
    var timer = null;
    var sequence = 0;

    var listId = 'place-results';
    var results = el('ul.placepick__results', { id: listId, role: 'listbox', hidden: true });
    var summary = el('p.placepick__chosen', { hidden: true });
    var hint = el('p.field__hint', { text: t('share.fPlaceHint') });

    var input = el('input.input.placepick__input', {
      type: 'text',
      role: 'combobox',
      autocomplete: 'off',
      'aria-expanded': 'false',
      'aria-controls': listId,
      placeholder: t('share.fPlacePh'),
      oninput: function () { schedule(input.value); }
    });

    function clearResults() {
      mount(results, []);
      results.hidden = true;
      input.setAttribute('aria-expanded', 'false');
    }

    function describe() {
      if (chosen) {
        summary.hidden = false;
        summary.textContent = t('share.fPlaceChosen', { name: chosen.name });
      } else if (pin) {
        summary.hidden = false;
        summary.textContent = t('share.fPlacePinned');
      } else {
        summary.hidden = true;
        summary.textContent = '';
      }
    }

    function choose(place) {
      chosen = {
        id: place.id,
        name: I18N.lang === 'en'
          ? (place.name_en || place.name_ar)
          : (place.name_ar || place.name_en)
      };
      pin = null;
      input.value = '';
      clearResults();
      describe();
    }

    function keepPin(where) {
      pin = { lat: where.lat, lon: where.lon };
      chosen = null;
      describe();
    }

    function clear() {
      chosen = null;
      pin = null;
      input.value = '';
      clearResults();
      describe();
    }

    /* Debounced, and the results are dropped when a later query has already been sent.
       Without the sequence check a slow response for "ال" can land after a fast one for
       "المنارة" and replace the right answers with stale ones — which reads as the
       autocomplete ignoring what was typed. */
    function schedule(term) {
      global.clearTimeout(timer);
      if (!term || term.trim().length < 2) { clearResults(); return; }
      var mine = ++sequence;
      timer = global.setTimeout(function () {
        DB.rpc('places_search', { p_q: term.trim() }).then(function (rows) {
          if (mine !== sequence) return;
          show(rows || []);
        }, function () {
          // A failed lookup is not an error a contributor can act on, and the pin below is
          // the answer either way. Silence here, and the button stays.
          if (mine === sequence) clearResults();
        });
      }, 250);
    }

    function show(rows) {
      if (!rows.length) {
        mount(results, el('li.placepick__none', { text: t('share.fPlaceNone') }));
        results.hidden = false;
        input.setAttribute('aria-expanded', 'true');
        return;
      }
      mount(results, rows.map(function (row) {
        var name = I18N.lang === 'en'
          ? (row.name_en || row.name_ar)
          : (row.name_ar || row.name_en);
        var other = I18N.lang === 'en'
          ? (row.name_ar || '')
          : (row.name_en || '');
        return el('li.placepick__result', { role: 'option' },
          el('button.placepick__hit', {
            type: 'button',
            onclick: function () { choose(row); }
          }, [
            bdi(name),
            other ? el('span.placepick__gloss.gloss-line', null, bdi(other)) : null,
            row.unconfirmed ? el('span.placepick__flag', { text: t('share.fPlaceUnconfirmed') }) : null
          ]));
      }));
      results.hidden = false;
      input.setAttribute('aria-expanded', 'true');
    }

    var pinButton = el('button.btn.btn--ghost.btn--small', {
      type: 'button',
      onclick: function () { openPinPicker(pin, keepPin, choose); },
      text: t('share.fPlacePin')
    });

    var clearButton = el('button.btn.btn--ghost.btn--small', {
      type: 'button', onclick: clear, text: t('share.fPlaceClear')
    });

    return {
      node: el('div.field.placepick', null, [
        el('label.field__label', { text: t('share.fPlace') }),
        input,
        results,
        summary,
        el('div.placepick__actions', null, [pinButton, clearButton]),
        hint
      ]),
      /** The draft keys 0049 reads, and nothing when the question was skipped. */
      read: function () {
        if (chosen) return { place_id: chosen.id };
        if (pin) return { lat: String(pin.lat.toFixed(6)), lon: String(pin.lon.toFixed(6)) };
        return {};
      }
    };
  }

  /* The pin, and the resolution step after it.

     The map is the same module /map uses, in 'pick' mode — one draggable teardrop and no
     markers. When the basemap is not provisioned or will not load there is deliberately NO
     numeric fallback: a pair of coordinate boxes is not a control anybody can answer
     honestly from memory, and a wrong pin published at block precision is worse than no
     location at all. The dialog says so and offers the gazetteer instead. */
  function openPinPicker(current, onPin, onPlace) {
    var scrim = null;
    var instance = null;
    var pin = current || null;

    function close() {
      if (instance) instance.destroy();
      instance = null;
      closeOverlay(scrim);
      scrim = null;
    }

    var canvasSlot = el('div.mapview.mapview--pick');
    var nearby = el('div.pinpick__near');
    var confirm = el('button.btn.btn--primary', {
      type: 'button',
      disabled: !pin,
      onclick: function () { if (pin) { onPin(pin); close(); } },
      text: t('share.pinConfirm')
    });

    /* The gazetteer, asked what is around the pin. This is M4's "gazetteer resolution": the
       archive would rather hold "Al-Manara" than a coordinate near it, so the named places
       within 400 m are offered before the bare point is accepted. */
    function askNearby(where) {
      DB.rpc('places_near', { p_lat: where.lat, p_lon: where.lon }).then(function (rows) {
        if (!scrim) return;
        if (!rows || !rows.length) { mount(nearby, []); return; }
        mount(nearby, [
          el('p.pinpick__near-title', { text: t('share.pinNear') })
        ].concat(rows.map(function (row) {
          var name = I18N.lang === 'en'
            ? (row.name_en || row.name_ar)
            : (row.name_ar || row.name_en);
          return el('button.btn.btn--ghost.btn--small', {
            type: 'button',
            onclick: function () { onPlace(row); close(); }
          }, [bdi(name), el('span.pinpick__distance', {
            text: t('share.pinDistance', { n: num(Math.round(row.distance_m)) })
          })]);
        })));
      }, function () { if (scrim) mount(nearby, []); });
    }

    function failed() {
      mount(canvasSlot, el('p.mapview__note', { role: 'status', text: t('share.pinNoMap') }));
      confirm.disabled = true;
    }

    var dialog = el('div.dialog.dialog--pin', null, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('share.pinTitle') }),
          el('p.dialog__blurb', { text: t('share.pinBlurb') })
        ]),
        el('button.dialog__close', {
          type: 'button', 'aria-label': t('action.close'), onclick: close,
          text: '✕ ' + t('action.close')
        })
      ]),
      canvasSlot,
      el('p.pinpick__privacy', { text: t('share.pinPrivacy') }),
      nearby,
      el('div.dialog__actions', null, [
        el('button.btn.btn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        confirm
      ])
    ]);

    scrim = overlayShell('scrim.scrim--heavy', [dialog], close);

    if (!global.CONFIG.basemap.url) { failed(); return; }

    loadMapModules().then(function () {
      if (!scrim) return;
      instance = global.MAP.create(canvasSlot, {
        url: global.CONFIG.basemap.url,
        mode: 'pick',
        label: t('share.pinTitle'),
        center: pin || { lat: 31.9038, lon: 35.2034 },
        zoom: 15,
        pin: pin,
        onPin: function (where) {
          pin = where;
          confirm.disabled = false;
          askNearby(where);
        },
        onFail: failed
      });
      instance.setPlaces(geoCache.places || []);
      instance.ready.catch(function () { /* onFail has it */ });
    }, failed);
  }

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
      return el('button.kind', {
        type: 'button',
        'aria-pressed': active ? 'true' : 'false',
        onclick: function () {
          kind = option.id;
          UI.qsa('.kind', kindRow).forEach(function (node, i) {
            var on = kinds[i].id === kind;
            node.setAttribute('aria-pressed', on ? 'true' : 'false');
            // The icon is a NODE now, so it is replaced rather than assigned as markup
            // (see ui.js on why there is no `html:` prop any more).
            var slot = node.firstChild;
            node.replaceChild(kinds[i].icon(on ? '#C05B3E' : '#3E4A2E'), slot);
          });
        }
      }, [
        option.icon(active ? '#C05B3E' : '#3E4A2E'),
        el('span', { text: option.label })
      ]);
    }));

    /* §3's EDTF-lite decade. Sent, as of migration 0047 — before that this select existed,
       defaulted to the 1960s, and was discarded, leaving every member upload with a null
       decade for a moderator to guess at. */
    var decadeSelect = el('select.input', { 'aria-label': t('share.fDecade') },
      /* Every decade the archive could hold, not only the ones it already does — a
         contributor with the earliest photograph in the collection must be able to say so.
         DATA.DECADES rather than index.json here, for the one place where the two lists
         mean different things. */
      [el('option', { value: '', text: t('share.fDecadeUnknown') })].concat(
        DATA.DECADES.map(function (d) {
          return el('option', { value: String(d), text: decadeLabel(d) });
        })));

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

    var place = placePicker();

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
        if (decadeSelect.value) draft.decade = decadeSelect.value;

        /* M4. Either a gazetteer id or a pin, never both — the picker returns one shape or
           the other, and 0049 resolves the coordinate from the ROW rather than trusting a
           pair of numbers that arrived beside an id. */
        var where = place.read();
        Object.keys(where).forEach(function (key) { draft[key] = where[key]; });

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
              progressBar.style.setProperty('inline-size', pct + '%');
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
      el('div.field', null, [
        el('label.field__label', { text: t('share.fDecade') }),
        decadeSelect
      ]),
      /* The place field was a datalist of seven hardcoded landmarks, deleted with data.js
         in M3 because a free-text place that resolves to nothing is a question asked for no
         reason. This is what M4 replaces it with: the gazetteer, then a pin. */
      place.node,
      field(t('share.fStory'), { multiline: true, placeholder: t('share.fStoryPh'), rows: '3' }),
      el('label.dropzone', null, [
        ICONS.upload(),
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
     §7: display name, avatar and role badge are never gated — attribution has to stay
     legible or the archive stops crediting anyone. Everything else is governed by the
     owner's `visibility` map, applied at PUBLISH time (0044) so the shard a stranger reads
     simply does not contain what was hidden. The owner's own view comes from
     profile_view(), with their own token, and is the only place the private side exists. */

  var profileCache = { key: null, loaded: false, data: null, own: null, mine: null };

  function renderProfile() {
    var own = isOwnProfileRoute();

    if (own && !state.signedIn) return null;   // handled by render(), which opens the gate

    var data = profileCache.data;
    if (!data) {
      /* Three states again, and they are not interchangeable: nothing asked yet, asked and
         still waiting, asked and there is no such profile. `key` is null before a request
         starts — including while /me waits for its own handle — and `loaded` distinguishes
         the last two. Showing "not found" during a fetch tells a member their profile does
         not exist, which for their own profile is alarming and wrong. */
      var pending = profileCache.key === null || !profileCache.loaded;
      return el('div.page-head', null, [
        el('h1.page-head__title', { text: t(pending ? 'q.loading' : 'profile.notFound') }),
        el('p.page-head__blurb', null, el('a', { href: '/', text: t('viewer.back') }))
      ]);
    }

    var isOwner = Boolean(profileCache.own && profileCache.own.is_own);
    var displayName = data.display_name || data.handle;

    var header = el('header.profile__header', null, [
      el('span.profile__avatar', {
        style: toneStyle(avatarTone(data.handle)),
        'aria-hidden': 'true',
        text: initialFor(data)
      }),
      el('div.profile__identity', null, [
        el('h1.profile__name', null, bdi(displayName)),
        el('div.profile__gloss.gloss-line', null, bdi('@' + data.handle)),
        el('div.profile__badges', null, [
          el('span.badge', { text: t('role.' + (data.label || 'member')) }),
          isOwner ? el('span.badge.badge--voice', { text: t('profile.you') }) : null
        ]),
        data.member_since
          ? el('div.profile__facts', null,
              el('span.profile__fact', { text: t('profile.memberSince', { n: I18N.year(data.member_since) }) }))
          : null
      ])
    ]);

    /* The owner's row overrides the shard's, field by field, and only downward-visible
       fields differ: profile_view() returns the bio whatever its visibility when the caller
       owns the profile. A stranger's copy of this page simply does not contain it. */
    var bioText = isOwner && profileCache.own ? profileCache.own.bio : data.bio;
    var bio = bioText
      ? el('div.profile__bio-wrap', null, [
          el('p.profile__bio', null, bdi(bioText)),
          isOwner && !isPublicField('bio') ? privateFlag() : null
        ])
      : null;

    var contributions = data.contributions || [];
    var contributionsBody = contributions.length
      ? el('div.profile__grid', null, contributions.map(memoryCard))
      : el('p.profile__empty', { text: t('profile.noContributions') });

    var comments = data.comments || [];
    var commentsBody = comments.length
      ? el('ul.profile__comments', null, comments.map(function (c) {
          var title = { ar: c.post_title_ar || c.post_title_en || '', en: c.post_title_en || c.post_title_ar || '' };
          return el('li.profile__comment', null, [
            el('p.comment__body', null, bdi(c.body)),
            el('div.profile__comment-meta', null, [
              el('a', { href: '/item/' + encodeURIComponent(c.post_id) }, [
                t('profile.onMemory') + ' ', bdi(pick(title))
              ]),
              el('span.comment__when', { text: c.day || '' })
            ])
          ]);
        }))
      : el('p.profile__empty', { text: t('profile.noComments') });

    return el('div.profile', null, [
      isOwner && !own
        ? el('div.profile__preview', null, [
            el('span', { text: t('profile.previewNotice') }),
            el('a', { href: '/me', text: t('profile.backToMine') })
          ])
        : null,
      header,
      bio,
      isOwner && own ? editPanel() : null,
      isOwner && own ? pendingPanel() : null,
      profileSection('contributions', isOwner, t('profile.contributions'), contributions.length, contributionsBody),
      profileSection('comments', isOwner, t('profile.comments'), comments.length, commentsBody)
    ]);
  }

  function isPublicField(name) {
    var vis = profileCache.own && profileCache.own.visibility;
    return !vis || vis[name] !== 'private';
  }

  function privateFlag() {
    return el('span.privacy-flag', { text: t('profile.ownerOnly') });
  }

  function profileSection(field, isOwner, title, count, body) {
    var visible = isPublicField(field);
    return el('section.profile__section', null, [
      el('div.profile__section-head', null, [
        el('h2.profile__section-title', { text: title }),
        el('span.profile__section-count', { text: num(count) }),
        isOwner && !visible ? privateFlag() : null
      ]),
      body
    ]);
  }

  /**
   * The member's own submissions, whatever state they are in.
   *
   * THE screen the ingest path has never had. A member whose upload the worker refused had
   * no surface anywhere telling them so — the item simply never appeared, which is
   * indistinguishable from a moderator having rejected it in silence. posts_full() returns
   * the author's own rows including ingest_state and ingest_error (0009 grants the member
   * their own error text specifically), so this is the first place the answer exists.
   *
   * What is deliberately NOT here is "expected by": CLAUDE.md §6 holds `expect_by` until a
   * one-off timing probe against the deployed worker replaces the estimated factor in
   * JOB_DEADLINE_MS, and §6 says that number ships once at the real figure rather than
   * being published and corrected. So this screen says which state a submission is in and
   * says nothing about when — which is true, and is more than the member had.
   */
  function pendingPanel() {
    var rows = profileCache.mine || [];
    var open = rows.filter(function (r) {
      return r.status !== 'approved' || r.ingest_state !== 'ready';
    });
    if (!open.length) return null;

    return el('section.profile__section', null, [
      el('div.profile__section-head', null, [
        el('h2.profile__section-title', { text: t('mine.title') }),
        el('span.profile__section-count', { text: num(open.length) })
      ]),
      el('p.profile__empty', { text: t('mine.blurb') }),
      el('ul.mine', null, open.map(function (row) {
        var title = { ar: row.title_ar || row.title_en || '', en: row.title_en || row.title_ar || '' };
        return el('li.mine__row', null, [
          el('div.mine__title', null, bdi(pick(title))),
          el('div.mine__meta', null, [
            el('span.badge', { text: t('mine.state.' + submissionState(row)) }),
            row.ingest_error
              ? el('span.mine__error', { text: t('mine.err.' + row.ingest_error) })
              : null
          ])
        ]);
      }))
    ]);
  }

  /* One label per state a member can actually be in, derived from two columns rather than
     shown raw: `status` and `ingest_state` are independent, and the pair a member needs
     explaining is (pending, failed) — approved-but-broken and never-reviewed look identical
     otherwise, and only one of them is theirs to fix. */
  function submissionState(row) {
    if (row.ingest_state === 'failed') return 'failed';
    if (row.ingest_state === 'awaiting_bytes') return 'incomplete';
    if (row.ingest_state === 'processing') return 'processing';
    if (row.status === 'rejected') return 'rejected';
    if (row.status === 'withdrawn') return 'withdrawn';
    return 'inReview';
  }

  function loadProfile() {
    var own = isOwnProfileRoute();
    var handle = own ? (state.account && state.account.handle) : routedHandle();

    /* /me needs a handle to ask for, and the handle is not in the JWT — §7 keeps it in
       `profiles`, so it arrives from a request that AUTH.restore() starts and that the
       first paint does not wait for. Landing on /me directly therefore reaches here with
       `handle` null.

       Without this branch that produced a permanent wrong answer rather than a slow right
       one: profile_view('') matches nobody, the page renders "profile not found", and
       profileCache.key has already been written, so nothing ever asks again. The member
       sees their own profile missing until they reload.

       So: fetch the handle, re-render, and DO NOT cache anything in the meantime. */
    if (own && !handle) {
      loadOwnHandle().then(function () {
        if (isOwnProfileRoute() && state.account && state.account.handle) render();
      });
      return Promise.resolve();
    }

    var key = own ? 'me:' + (state.account ? state.account.id : '') : 'u:' + handle;
    if (profileCache.key === key) return Promise.resolve();

    profileCache = { key: key, loaded: false, data: null, own: null, mine: null };

    /* Two sources, and the split is §7's. The shard is the public projection everybody
       gets; profile_view() is the owner's (and a moderator's) view of the private half. A
       stranger's browser never receives the hidden fields at all — it is not asked to be
       discreet about data it holds. */
    var ownRow = (own || state.signedIn)
      ? DB.rpc('profile_view', { p_handle: handle || '' }).then(function (rows) {
          return (rows && rows[0]) || null;
        }, function () { return null; })
      : Promise.resolve(null);

    return ownRow.then(function (row) {
      profileCache.own = row;
      /* `handle` is non-null by here — the /me branch above returned early without one —
         so this only falls back for a /u/ route with no segment, which resolves to no
         profile and renders "not found". */
      if (!handle) return null;
      return ARCHIVE.profile(handle);
    }).then(function (shard) {
      profileCache.data = shard || fallbackProfile(profileCache.own);
      if (!own || !state.signedIn) return null;
      // posts_full(): the member's own rows, in every state. See pendingPanel.
      return DB.rpc('posts_full', {}).then(function (rows) {
        profileCache.mine = (rows || []).filter(function (r) {
          return state.account && r.created_by === state.account.id;
        });
      }, function () { profileCache.mine = []; });
    }).then(function () {
      profileCache.loaded = true;
      render();
    }, function () {
      profileCache.loaded = true;
      render();
    });
  }

  /* A profile with nothing published has no shard — publishable_profiles() is bounded by
     the archive (0044). Its owner still has a page, built from the row they can read. */
  function fallbackProfile(own) {
    if (!own) return null;
    return {
      handle: own.handle,
      display_name: own.display_name,
      avatar_path: own.avatar_path,
      label: own.role_cache || 'member',
      bio: own.bio,
      member_since: own.member_since,
      contributions: [],
      comments: []
    };
  }

  /* ── Edit profile & privacy (owner only) ─────────────────── */

  function editPanel() {
    var own = profileCache.own;
    if (!own) return null;
    if (!state.editOpen) {
      return el('div.profile__edit', null, [
        el('button.btn.btn--ghost.profile__edit-toggle', {
          type: 'button',
          'aria-expanded': 'false',
          onclick: function () { state.editOpen = true; render(); },
          text: t('profile.editTitle')
        }),
        el('a.profile__preview-link', { href: '/u/' + encodeURIComponent(own.handle), text: t('profile.previewLink') })
      ]);
    }

    var displayInput = el('input.input', { type: 'text', 'aria-label': t('profile.displayName') });
    displayInput.value = own.display_name || '';
    var bioInput = el('textarea.input', { rows: '3', 'aria-label': t('profile.bio') });
    bioInput.value = own.bio || '';

    var visibility = {};
    ['bio', 'personalInfo', 'contributions', 'comments'].forEach(function (f) {
      visibility[f] = (own.visibility && own.visibility[f]) === 'private' ? 'private' : 'public';
    });

    var toggles = Object.keys(visibility).map(function (fieldName) {
      var row = el('div.privacy-row');
      function paint() {
        var on = visibility[fieldName] === 'public';
        mount(row, [
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
              visibility[fieldName] = on ? 'private' : 'public';
              paint();
            }
          }),
          el('span.privacy-row__state', { text: on ? t('profile.public') : t('profile.private') })
        ]);
      }
      paint();
      return row;
    });

    var note = el('p.form-error', { role: 'alert', hidden: true });

    var form = el('form.profile__edit-form', {
      onsubmit: function (event) {
        event.preventDefault();
        note.hidden = true;
        /* select= is REQUIRED and is not tidiness: `Prefer: return=representation` with no
           select is a SELECT of `*`, and 0015 revoked table-level SELECT on profiles. See
           db.js — this is the defect the lifecycle harness found on posts. */
        DB.patch('profiles', 'id=eq.' + encodeURIComponent(state.account.id) + '&select=handle',
          { display_name: displayInput.value.trim() || null,
            bio: bioInput.value.trim() || null,
            visibility: visibility })
          .then(function (rows) {
            if (!rows || !rows.length) {
              note.textContent = t('admin.err.denied');
              note.hidden = false;
              return;
            }
            UI.toast(t('profile.saved'));
            state.editOpen = false;
            profileCache.key = null;
            loadProfile();
          })
          .catch(function (err) {
            note.textContent = t(err && err.key ? err.key : 'admin.err.generic');
            note.hidden = false;
          });
      }
    }, [
      el('div.field', null, [el('label.field__label', { text: t('profile.displayName') }), displayInput]),
      el('div.field', null, [el('label.field__label', { text: t('profile.bio') }), bioInput]),
      el('div.privacy-list', null, [
        el('div.privacy-list__head', null, [
          el('h3.profile__section-title', { text: t('profile.privacyTitle') }),
          el('p.privacy-list__note', { text: t('profile.privacyNote') })
        ])
      ].concat(toggles)),
      note,
      el('div.dialog__actions', null, [
        el('button.btn.btn--ghost', {
          type: 'button', onclick: function () { state.editOpen = false; render(); }, text: t('action.cancel')
        }),
        el('button.btn.btn--primary', { type: 'submit', text: t('profile.save') })
      ])
    ]);

    return el('div.profile__edit.profile__edit--open', null, [
      el('button.btn.btn--ghost.profile__edit-toggle', {
        type: 'button',
        'aria-expanded': 'true',
        onclick: function () { state.editOpen = false; render(); },
        text: t('profile.editTitle')
      }),
      form
    ]);
  }

  /* ── Info page ───────────────────────────────────────────── */

  function renderInfoPage() {
    var sections = ARCHIVE.pages();

    return el('div.infopage', null, [
      el('div.page-head', null, [
        el('div', null, [
          el('h1.page-head__title', { text: t('page.title') }),
          el('p.page-head__blurb', { text: t('page.blurb') })
        ])
      ]),
      el('nav.infopage__toc', { 'aria-label': t('page.title') }, sections.map(function (section) {
        return el('a.infopage__toc-link', {
          href: '/page/' + encodeURIComponent(section.slug),
          'aria-current': routedPageSlug() === section.slug ? 'true' : null,
          text: pick(section.title)
        });
      })),
      el('div.infopage__body', null, sections.map(function (section) {
        return el('section.infosection', { id: 'section-' + section.slug }, [
          el('h2.infosection__title', { text: pick(section.title) }),
          gloss(section.title) ? el('div.infosection__gloss.gloss-line', { text: gloss(section.title) }) : null
        ].concat(
          pick(section.body).split(/\n\s*\n/).map(function (para) {
            return el('p.infosection__para', { text: para });
          })
        ).concat(
          section.slug === 'donate' ? [donateContact()] : []
        ));
      }))
    ]);
  }

  /* Email opens the mail client; the phone number opens WhatsApp. Both are content blocks
     now (§9), so filling them in is a dashboard edit rather than a deploy. */
  function donateContact() {
    var email = pick(ARCHIVE.block('page.donate.email'));
    var whatsapp = pick(ARCHIVE.block('page.donate.whatsapp'));
    var waDigits = whatsapp.replace(/[^\d]/g, '');

    var rows = [];
    if (email && email.indexOf('PLACEHOLDER') === -1) {
      rows.push(el('a.donate-contact__row', { href: 'mailto:' + email }, [
        el('span.donate-contact__label', { text: t('page.email') }),
        el('span.donate-contact__value.lat', { text: email })
      ]));
    }
    if (waDigits) {
      rows.push(el('a.donate-contact__row', {
        href: 'https://wa.me/' + waDigits, target: '_blank', rel: 'noopener'
      }, [
        el('span.donate-contact__label', { text: t('page.whatsapp') }),
        el('span.donate-contact__value.lat', { text: whatsapp })
      ]));
    }
    // Nothing configured yet renders no link at all. A mailto: to PLACEHOLDER_EMAIL is a
    // dead control that looks live, which is worse than an absent one.
    if (!rows.length) return null;

    return el('div.donate-contact', null, [
      el('h3.donate-contact__title', { text: t('page.donateReach') }),
      el('div.donate-contact__rows', null, rows),
      el('p.donate-contact__note', { text: t('page.donateNote') })
    ]);
  }

  /* ── Located memories ────────────────────────────────────────
     M4. The map is a canvas over a PMTiles basemap on R2 (§2), the decade control is a
     slider, and the list under it is not a lesser version of either — it is §10's stated
     "tile-failure fallback to list view", the accessible equivalent of a canvas nothing can
     read aloud, and what a visitor sees while the tiles are still arriving.

     Three ways the map does not draw, and all three end in the same list:

       · no extract provisioned — config/site.json's basemap.path is empty, which is the
         state this repository ships in until somebody builds the Palestine extract. Not a
         failure and not reported as one.
       · the archive is unreadable — a 404, a range request an intermediary stripped, or a
         compression the browser has no decoder for (see pmtiles.js).
       · the module would not load at all.

     Only the second and third say so on the screen. A map that was never configured has
     nothing to apologise for. */

  var geoCache = { items: null, places: [] };

  var mapState = {
    node: null,          // the container, kept across renders so the canvas survives them
    instance: null,
    loading: false,
    failed: false,
    listNode: null,      // updated in place while the slider is dragged
    countNode: null,
    valueNode: null,
    input: null
  };

  /* map.js and its two dependencies, fetched the first time somebody opens /map or drops a
     pin. UI.loadMap is the shared loader — admin.js reaches for the same three files from
     the gazetteer screen, and two copies of a load-order dependency is one copy too many.
     See ui.js for why these are script tags rather than import(). */
  function loadMapModules() { return UI.loadMap(); }

  function loadGeo() {
    if (geoCache.items) return Promise.resolve(geoCache.items);
    /* Which cells exist comes from the release's index.json, not from a constant. At
       GEO_PRECISION 5 one cell is ~4.9 km and covers Ramallah — which is exactly why
       shards.ts chose 5 — so this is one request in practice. Asking the index rather than
       hardcoding that cell is what keeps it true for an item contributed from outside the
       city, which would otherwise be published into a shard nothing ever fetched. */
    return ARCHIVE.index().then(function (idx) {
      var cells = idx.cells.length
        ? Promise.all(idx.cells.map(function (cell) { return ARCHIVE.geo(cell); }))
        : Promise.resolve([]);
      // The gazetteer alongside, because the basemap carries no labels of its own and a map
      // of a city with no place names on it is a diagram.
      return Promise.all([cells, ARCHIVE.places()]).then(function (both) {
        var all = [];
        both[0].forEach(function (b) { all = all.concat(b.items); });
        geoCache.items = all;
        geoCache.places = both[1] || [];
        return all;
      });
    }).catch(function () {
      geoCache.items = [];
      return geoCache.items;
    });
  }

  /** The decades that actually hold items, from index.json; DATA.DECADES until it loads. */
  function knownDecades() {
    var idx = ARCHIVE.indexNow();
    return idx && idx.decades.length ? idx.decades : DATA.DECADES;
  }

  /** The slider's stops: every decade the archive has, with "all" at one end. */
  function decadeStops() {
    return [{ id: 'all', label: t('map.all') }].concat(knownDecades().map(function (d) {
      return { id: d, label: decadeLabel(d) };
    }));
  }

  function visibleItems() {
    var items = geoCache.items || [];
    if (state.decade === 'all') return items;
    return items.filter(function (row) { return row.decade === state.decade; });
  }

  function locatedCards(visible) {
    if (!visible.length) return el('p.profile__empty', { text: t('map.empty') });
    return el('div.grid', null, [el('div.grid__col', null, visible.map(function (row) {
      var card = memoryCard(row);
      card.appendChild(el('div.located__where', {
        text: t('map.precision.' + (row.precision || 'area'))
      }));
      return card;
    }))]);
  }

  /* The slider moves, and the map and the list follow — without a re-render.

     A full render() on every input event would rebuild the slider under the finger dragging
     it, which loses focus, loses the drag on a touch screen, and makes the control feel
     broken on exactly the mid-range device §10 names as the exit criterion. So the three
     nodes that depend on the decade are updated in place. */
  function applyDecade(id) {
    state.decade = id;
    var visible = visibleItems();

    var stop = null;
    decadeStops().forEach(function (option) { if (option.id === id) stop = option; });
    if (mapState.valueNode && stop) mapState.valueNode.textContent = stop.label;
    // A range input announces its numeric value, which here is an index into a list of
    // decades and means nothing to anyone. aria-valuetext is what makes it say "the 1960s".
    if (mapState.input && stop) mapState.input.setAttribute('aria-valuetext', stop.label);
    if (mapState.countNode) {
      mapState.countNode.textContent = t('map.inView', { n: num(visible.length) });
    }
    if (mapState.listNode) mount(mapState.listNode, locatedCards(visible));
    if (mapState.instance) mapState.instance.setItems(visible);
  }

  function mapFailed() {
    if (mapState.failed) return;
    mapState.failed = true;
    if (mapState.instance) { mapState.instance.destroy(); mapState.instance = null; }
    mapState.node = null;
    if (route() === 'map') render();
  }

  function ensureMap(visible) {
    if (mapState.instance) { mapState.instance.setItems(visible); return; }
    if (mapState.loading) return;
    mapState.loading = true;

    loadMapModules().then(function () {
      if (mapState.failed || !mapState.node) return;
      var instance = global.MAP.create(mapState.node, {
        url: global.CONFIG.basemap.url,
        label: t('map.canvasLabel'),
        center: { lat: 31.9038, lon: 35.2034 },
        onSelect: function (item) { navigate('/item/' + encodeURIComponent(item.id)); },
        onFail: mapFailed
      });
      mapState.instance = instance;
      instance.setPlaces(geoCache.places);
      instance.setItems(visible);
      // Opened on the archive it actually holds rather than on a hardcoded viewport: an
      // item contributed from outside Ramallah is otherwise off-screen at every zoom.
      instance.ready.then(function () {
        if (visible.length) instance.fit(visible);
      }, function () { /* onFail has it; this is only here so the rejection is handled */ });
    }, mapFailed);
  }

  function renderLocated() {
    if (!geoCache.items) return el('p.profile__empty', { text: t('q.loading') });

    var visible = visibleItems();
    var stops = decadeStops();
    var index = 0;
    stops.forEach(function (option, i) { if (option.id === state.decade) index = i; });

    mapState.countNode = el('span.page-head__count', {
      text: t('map.inView', { n: num(visible.length) })
    });
    mapState.valueNode = el('output.decade-slider__value', { text: stops[index].label });

    var input = el('input.decade-slider__input', {
      type: 'range',
      min: '0',
      max: String(stops.length - 1),
      step: '1',
      'aria-label': t('map.decade'),
      'aria-valuetext': stops[index].label,
      oninput: function () {
        var chosen = stops[Math.min(stops.length - 1, Math.max(0, Number(input.value) || 0))];
        applyDecade(chosen.id);
      }
    });
    // Set as a property, not an attribute: on a range input the attribute is the DEFAULT
    // value, and a form reset would be the only thing that ever read it.
    input.value = String(index);
    mapState.input = input;

    mapState.listNode = el('div.located__list', null, locatedCards(visible));

    var panel = null;
    var note = null;
    if (global.CONFIG.basemap.url && !mapState.failed) {
      if (!mapState.node) {
        mapState.node = el('div.mapview', null, [
          // OpenStreetMap's licence requires the credit to be shown. It is a property of
          // the extract, so it comes from config/site.json rather than from I18N.
          el('p.mapview__credit', { text: global.CONFIG.basemap.attribution })
        ]);
      }
      panel = mapState.node;
      ensureMap(visible);
    } else if (mapState.failed) {
      // Said out loud, because a map that silently becomes a list looks like a design
      // decision and this one is not. A basemap that was never configured says nothing.
      note = el('p.mapview__note', { role: 'status', text: t('map.err.tiles') });
    }

    return el('div.located', null, [
      el('div.page-head', null, [
        el('div', null, [
          el('h1.page-head__title', { text: t('map.title') }),
          el('p.page-head__blurb', { text: t(panel ? 'map.blurb' : 'map.blurbList') })
        ]),
        mapState.countNode
      ]),
      el('div.decade-slider', null, [
        el('span.decade-slider__label', { text: t('map.decade') }),
        input,
        mapState.valueNode
      ]),
      panel,
      note,
      mapState.listNode
    ]);
  }

  /* ── Events ──────────────────────────────────────────────── */

  function renderEvents() {
    var events = state.feed.filter(function (row) { return row.kind === 'event'; });

    return el('div', null, [
      el('div.page-head', null, [
        el('div', null, [
          el('h1.page-head__title', { text: copyText('events.title') }),
          el('p.page-head__blurb', { text: copyText('events.blurb') })
        ]),
        el('span.page-head__count', { text: t('events.count', { n: num(events.length) }) })
      ]),
      events.length
        ? el('ul.events', null, events.map(function (entry) {
            var title = titlePair(entry);
            var thumb = entry.thumb ? ARCHIVE.mediaUrl(entry.thumb) : null;
            return el('li.event', null, [
              el('a.event__plate' + (thumb ? '' : '.plate'), {
                href: '/item/' + encodeURIComponent(entry.id),
                style: thumb ? null : toneStyle(avatarTone(entry.id)),
                'aria-label': pick(title)
              }, thumb
                ? el('img.memory__img', { src: thumb, alt: pick(title), loading: 'lazy' })
                : el('span.mono', { text: t('feed.noPreview') })),
              el('div.event__body', null, [
                el('h2.event__title', null,
                  el('a', { href: '/item/' + encodeURIComponent(entry.id) }, bdi(pick(title)))),
                gloss(title) ? el('div.event__gloss.gloss-line', null, bdi(gloss(title))) : null,
                entry.decade ? el('div.event__where', { text: decadeLabel(entry.decade) }) : null
              ])
            ]);
          }))
        : el('p.profile__empty', { text: t('events.empty') })
    ]);
  }

  /* ── Render ──────────────────────────────────────────────── */

  function render() {
    var name = route();

    renderMasthead();
    renderFooter();

    var view = qs('#view');

    if (state.error && !state.feed.length) {
      mount(view, el('div.page-head', null, [
        el('h1.page-head__title', { text: t('archive.err.title') }),
        el('p.page-head__blurb', { text: t(state.error) })
      ]));
      closeViewer();
      return;
    }

    if (name === 'profile') {
      if (isOwnProfileRoute() && !state.signedIn) {
        // Captured before the redirect, so signing in returns them to the profile they
        // asked for rather than to the archive they were bounced to (§9).
        navigate('/', true);
        mount(view, renderArchive());
        openGate(function () { navigate('/me'); });
        closeViewer();
        return;
      }
      loadProfile();
      mount(view, renderProfile() || el('div'));
    } else if (name === 'map') {
      mount(view, renderLocated());
      // renderLocated shows a loading state while items is null; the .then re-renders
      // rather than mounting a second time from inside the first render, which would leave
      // the two competing for #view whenever the shard was already cached.
      if (geoCache.items === null) {
        loadGeo().then(function () { if (route() === 'map') render(); });
      }
    } else if (name === 'page') {
      mount(view, renderInfoPage());
    } else if (name === 'events') {
      mount(view, renderEvents());
    } else {
      mount(view, renderArchive());
    }

    /* The viewer is a route, not a mode: /item/{id} opens it over the archive. */
    var itemId = routedItemId();
    closeViewer();
    if (itemId) openViewerFor(itemId);
    else if (name === 'page' && routedPageSlug()) scrollToSection(routedPageSlug());
    else global.scrollTo(0, 0);
  }

  /**
   * Open the viewer on an id, whether or not it is in the loaded feed.
   *
   * A deep link from WhatsApp arrives on an item that may be on feed page nine. Rather than
   * loading nine pages to find it, the item is fetched directly and put at the front of the
   * feed — so the reader sees what they came for immediately and can then scroll on into
   * the rest of the archive.
   */
  function openViewerFor(id) {
    var inFeed = -1;
    state.feed.forEach(function (row, i) { if (row.id === id) inFeed = i; });
    if (inFeed > -1) { state.lead = null; openViewer(inFeed); return; }

    ARCHIVE.item(id).then(function (item) {
      if (!item) {
        // Redacted, or never published. Either way the archive does not have it, and the
        // reader is told rather than left on a blank overlay. This is also the takedown
        // path a shared link lands on: the item shard is gone and redactions.json names it.
        UI.toast(t('archive.err.missing'));
        navigate('/', true);
        return;
      }
      state.items[id] = item;
      // The feed-entry shape, built from the item shard. feedEntry() in shards.ts is the
      // authority on these keys; this is the one place the front end reconstructs one, and
      // it does so from the item shard's own fields rather than inventing any.
      state.lead = {
        id: item.id,
        kind: item.kind,
        title_ar: item.title_ar,
        title_en: item.title_en,
        decade: item.decade,
        thumb: (ARCHIVE.role(item.media, 'thumb') || {}).path || null,
        author: item.author,
        likes: item.likes,
        comments: item.comment_count,
        day: item.day
      };
      return refreshEngagement([id]).then(function () {
        // The reader may have navigated away while the shard was in flight.
        if (routedItemId() !== id) return;
        openViewer(0);
      });
    }, function () {
      UI.toast(t('archive.err.offline'));
    });
  }

  function scrollToSection(slug) {
    var target = qs('#section-' + slug);
    if (!target) { global.scrollTo(0, 0); return; }
    var top = target.getBoundingClientRect().top + global.pageYOffset - 80;
    global.scrollTo({ top: Math.max(0, top), behavior: 'auto' });
  }

  /* ── Boot ────────────────────────────────────────────────── */

  global.addEventListener('popstate', render);
  global.document.addEventListener('click', onDocumentClick);
  global.addEventListener('langchange', render);

  /* Infinite scroll on the archive. Deliberately not IntersectionObserver on a sentinel:
     the masonry is three columns of different heights, so the last card is not the lowest
     point on the page and a sentinel after it fires early or late depending on which column
     happens to be tallest. */
  var scrollTimer = null;
  global.addEventListener('scroll', function () {
    if (route() !== 'archive' || state.viewer) return;
    global.clearTimeout(scrollTimer);
    scrollTimer = global.setTimeout(function () {
      var remaining = global.document.body.scrollHeight - (global.pageYOffset + global.innerHeight);
      if (remaining > 1200) return;
      var before = state.feed.length;
      loadNextPage().then(function () {
        if (state.feed.length !== before && route() === 'archive' && !state.viewer) {
          mount(qs('#view'), renderArchive());
        }
      }).catch(function () { /* the reader keeps what is already loaded */ });
    }, 120);
  }, { passive: true });

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
    }, 150);
  });

  migrateHashRoute();

  /* The archive paints before anything about a session is known. §1: "Browsing is open" —
     so a failed restore, a slow refresh or no account at all must not delay a single card.

     The order is manifest -> content -> first feed page, and it is sequential because each
     depends on the last: the release path comes from the manifest and the shard paths come
     from the release. §9's budget counts exactly this sequence. */
  ARCHIVE.ready()
    .then(function () { return ARCHIVE.content(); })
    .then(function () { render(); return loadNextPage(); })
    .then(function () {
      render();
      /* Last, and not awaited by anything above it. index.json only refines two lists that
         already have a fallback (the decade bar and the geo cells), so making the first
         paint wait on it would spend a request from §9's budget on something no first
         screen shows. */
      return ARCHIVE.index().catch(function () { return null; });
    })
    .catch(function (err) {
      state.error = err && err.key ? err.key : 'archive.err.generic';
      render();
    });

  AUTH.restore().then(function (account) {
    if (account) onSignedIn(account);
  });

  /* The session can end without anyone pressing sign-out — a refresh token that has been
     rotated away, or an expiry. AUTH says so; the masthead has to agree. */
  AUTH.onChange(function (account) {
    if (!account && state.signedIn) {
      adoptAccount(null);
      renderMasthead();
      if (route() === 'profile') navigate('/');
    }
  });
})(window);
