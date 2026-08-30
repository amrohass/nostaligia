/* The back office. Eight sections behind one olive rail, every one of them on real data.

   ── What changed in M3 ───────────────────────────────────────

   Everything except the review queue used to read `DATA` — twelve invented memories, a
   members table, a reports list, three months of intake statistics, a coverage chart and a
   settings screen backed by nothing. README listed it as a known departure and M3 owns it.

   The invented numbers were the part worth deleting most deliberately. A dashboard that
   tells a moderator "142 new members" and "31:40 hours of audio" is not a placeholder; it
   is a screen quietly lying to the person using it to make decisions. Where a real source
   exists, these screens now read it. Where one does not — the gazetteer's editing tools are
   M4's, and the review settings were never backed by a table — the screen says so and
   shows what is actually there.

   ── This file authorises nothing ─────────────────────────────

   §5: "The browser is hostile. This includes admin.js." Every query below is a REQUEST.
   What a moderator may read and change is decided by the policies in 0018–0020 and by the
   column grants in 0015, for this file and for curl alike. A member who fetches
   /assets/js/admin.js and runs it gets a dashboard whose every panel is empty and whose
   every button is refused, from the database. */

(function (global) {
  'use strict';

  var el = UI.el, qs = UI.qs, mount = UI.mount, toneStyle = UI.toneStyle, ICONS = UI.ICONS;
  var bdi = UI.bdi;
  var t = function (k, v) { return I18N.t(k, v); };
  var pick = I18N.pick, gloss = I18N.gloss, num = I18N.num;

  /* `settings` is gone and `copy` is in its place. §4 gives admins "Edit site copy
     (content_blocks)" and §9 makes the dashboard the single source of truth for it; the
     settings screen it replaces offered an SLA, an auto-publish toggle and a reviewer count
     that no table has ever stored. */
  var SECTIONS = ['overview', 'queue', 'archive', 'events', 'places', 'members', 'reports', 'copy'];

  /* Working state. Nothing is seeded — each screen loads on first visit and says which of
     "loading", "empty" and "could not ask" it is in, because those three look identical
     when they share a message and mean opposite things to a moderator. */
  var work = {
    queue: [],
    queueLoaded: false,
    queueError: null,
    queueBusy: null,          // id of the item whose decision is in flight
    queueFilter: 'all',
    queueSelected: null,

    /* Every other screen, in one shape: rows, a loaded flag, an error key. `loaded` is what
       distinguishes an empty archive from an archive nobody has asked for yet. */
    panels: {},

    archiveBusy: null,        // post id whose takedown is in flight
    reportBusy: null,
    reportSelected: null,
    copySelected: null,
    copyDirty: {}
  };

  function panel(name) {
    if (!work.panels[name]) work.panels[name] = { rows: [], loaded: false, error: null };
    return work.panels[name];
  }

  /**
   * One screen's data, loaded once per session.
   *
   * The three states are kept apart deliberately, and `loaded` is set on the error path as
   * well as the success path: without it a failed load looks like a load that has not
   * happened yet, and the screen sits on a spinner forever rather than telling anyone what
   * went wrong.
   */
  function loadPanel(name, run) {
    var p = panel(name);
    if (p.loaded || p.loading) return Promise.resolve(p);
    p.loading = true;
    return run().then(function (rows) {
      p.rows = rows || [];
      p.loaded = true;
      p.loading = false;
      p.error = null;
      render();
      return p;
    }, function (err) {
      p.loaded = true;
      p.loading = false;
      p.error = err && err.key ? err.key : 'admin.err.generic';
      render();
      return p;
    });
  }

  /** The body of a screen whose rows are not there — loading, refused, or genuinely empty. */
  function panelState(p, emptyKey) {
    return el('p.queue-item__sub', { style: 'padding:20px', text:
      p.error ? t(p.error) : !p.loaded ? t('q.loading') : t(emptyKey) });
  }

  /* ── Routing ─────────────────────────────────────────────── */

  /* The dashboard keeps hash routing, and that is a decision rather than an oversight.
     §2's History API requirement is about the PUBLIC archive: real per-item URLs so a link
     pasted into WhatsApp resolves and a crawler can read it (§9). Nothing here is shared,
     nothing here is crawled — admin.html carries `noindex` — and a path-routed dashboard
     would need its own _redirects rule for every section. The reason the rule exists does
     not apply, so the cost of following it would buy nothing. */
  function section() {
    var hash = global.location.hash.replace(/^#\/?/, '');
    return SECTIONS.indexOf(hash) > -1 ? hash : 'overview';
  }

  function pendingQueue() {
    return work.queue.filter(function (item) {
      if (work.queueFilter === 'all') return true;
      if (work.queueFilter === 'soon') return item.hoursLeft <= 24;
      return item.kind === work.queueFilter;
    });
  }

  /* ── Rail ────────────────────────────────────────────────── */

  function renderRail() {
    var current = section();
    var badges = {
      queue: { value: work.queue.length, kind: 'urgent' },
      reports: { value: openReports().length, kind: 'warn' }
    };

    mount(qs('#rail'), [
      el('div.rail__head', null, [
        el('div.rail__mark', { text: t('brand.name') }),
        el('div.rail__sub', { text: t('brand.admin') })
      ]),
      el('div.rail__nav', null, SECTIONS.map(function (name) {
        var badge = badges[name];
        return el('a.rail__link', {
          href: '#/' + name,
          'aria-current': name === current ? 'page' : null
        }, [
          el('span', { text: t('admin.' + name) }),
          badge && badge.value
            ? el('span.rail__badge' + (badge.kind ? '.rail__badge--' + badge.kind : ''), { text: num(badge.value) })
            : null
        ]);
      })),
      el('div.rail__me', null, [
        el('div.rail__me-avatar', { text: meInitial() }),
        el('div', null, [
          el('div.rail__me-name', null, bdi(me.handle || t('admin.me'))),
          el('div.rail__me-role', { text: t('role.' + (me.role || 'moderator')) })
        ])
      ]),
      el('a.rail__exit', { href: '/', text: t('admin.backToSite') })
    ]);
  }

  /* Who is signed in, for the rail only. §4: the ROLE that matters is the one authz_role()
     returns and the one the policies read; this is a label on a screen. admin-boot.js has
     already asked the database and refused to load this file for anyone else. */
  var me = { handle: null, role: null };

  function meInitial() {
    if (me.handle) return String(me.handle).trim().charAt(0).toUpperCase();
    return I18N.lang === 'ar' ? 'م' : 'M';
  }

  function loadMe() {
    var account = AUTH.user();
    if (!account) return Promise.resolve();
    return Promise.all([
      DB.select('profiles', 'select=handle&id=eq.' + encodeURIComponent(account.id))
        .then(function (rows) { return rows && rows[0] ? rows[0].handle : null; }, function () { return null; }),
      DB.rpc('authz_role').then(function (role) { return role; }, function () { return null; })
    ]).then(function (both) {
      me.handle = both[0];
      me.role = both[1];
      renderRail();
    });
  }

  function topbar(title, sub, actions) {
    return el('div.topbar', null, [
      el('div', null, [
        el('h1.topbar__title', { text: title }),
        sub ? el('div.topbar__sub', { text: sub }) : null
      ]),
      actions ? el('div.topbar__actions', null, actions) : null
    ]);
  }

  function langButton() {
    return el('button.lang-toggle', {
      type: 'button', title: t('lang.switchTo'), onclick: function () { I18N.toggle(); }, text: t('lang.other')
    });
  }

  function chip(label, active, onclick, modifier) {
    return el('button.chip' + (modifier ? '.' + modifier : ''), {
      type: 'button',
      'aria-pressed': active ? 'true' : 'false',
      onclick: onclick,
      text: label
    });
  }

  /* A title pair from a posts row, either side falling back to the other — one of the pair
     may be absent by design (posts_has_a_title requires one, not both). */
  function titlePair(row) {
    return { ar: row.title_ar || row.title_en || '', en: row.title_en || row.title_ar || '' };
  }

  function decadeLabel(decade) {
    if (!decade) return '';
    var key = 'decade.' + decade;
    var label = t(key);
    return label === key ? String(decade) : label;
  }

  /* ── 4b Overview ─────────────────────────────────────────── */

  /**
   * Four counts and a ledger, all of them computed.
   *
   * PostgREST's `Prefer: count=exact` would give the totals in a HEAD request, but db.js
   * reads bodies rather than headers and widening it for one screen is the wrong trade —
   * these are hundreds of rows at launch, not millions, and asking for the id column is one
   * request either way.
   *
   * The activity feed is `moderation_actions`, which is the real thing the invented one was
   * imitating: §4 requires every privileged action to write there, so it cannot be
   * incomplete without a policy having been bypassed.
   */
  function renderOverview() {
    var approved = panel('approved');
    var actions = panel('actions');

    var dueSoon = work.queue.filter(function (item) { return item.hoursLeft <= 24; }).length;

    var byDecade = {};
    approved.rows.forEach(function (row) {
      if (!row.decade) return;
      byDecade[row.decade] = (byDecade[row.decade] || 0) + 1;
    });
    var decades = Object.keys(byDecade).map(Number).sort(function (a, b) { return a - b; });
    var peak = decades.reduce(function (max, d) { return Math.max(max, byDecade[d]); }, 1);

    return [
      topbar(t('ov.greeting'), t('ov.today', { n: num(dueSoon) }), [
        langButton(),
        el('a.abtn.abtn--primary', { href: '#/queue', text: t('ov.start') })
      ]),
      el('div.admin__scroll', null, [
        el('div.stat-row', null, [
          stat(t('ov.pending'), work.queueLoaded ? num(work.queue.length) : '—', t('ov.pendingNote'), true),
          stat(t('ov.published'), approved.loaded ? num(approved.rows.length) : '—', t('ov.publishedNote')),
          stat(t('ov.decadesCovered'), approved.loaded ? num(decades.length) : '—', t('ov.decadesNote')),
          stat(t('ov.openReports'), reportsPanelLoaded() ? num(openReports().length) : '—', t('ov.reportsNote'))
        ]),
        el('div.panels', null, [
          el('div.panel', null, [
            el('div.panel__head', null, [
              el('h2.panel__title', { text: t('ov.gaps') }),
              el('span.panel__aside', { text: t('ov.gapsRange') })
            ]),
            /* The coverage meter the invented one imitated, over the real archive. A decade
               with nothing in it is the whole point of the panel, so the row is drawn from
               DATA.DECADES and shows a zero rather than being skipped — a gap you cannot
               see is a gap nobody fills. */
            approved.loaded
              ? el('div.meters', null, DATA.DECADES.map(function (d) {
                  var count = byDecade[d] || 0;
                  var pct = Math.round(count / peak * 100);
                  var fill = count === 0 ? '.meter__fill--low' : (pct < 40 ? '.meter__fill--mid' : '');
                  return el('div.meter', null, [
                    el('span.meter__label', { text: decadeLabel(d) }),
                    el('div.meter__track', null, el('div.meter__fill' + fill, { style: 'width:' + pct + '%' })),
                    el('span.meter__value', { text: num(count) })
                  ]);
                }))
              : panelState(approved, 'ar.empty'),
            el('p.panel__aside', { style: 'line-height:1.7', text: t('ov.gapsNote') })
          ]),
          el('div.panel', null, [
            el('h2.panel__title', { text: t('ov.latest') }),
            actions.loaded && actions.rows.length
              ? el('ul.feed', null, actions.rows.slice(0, 12).map(function (row) {
                  return el('li', null, [
                    el('span.feed__dot' + (/reject|takedown/.test(row.action) ? '.feed__dot--warn' : '')),
                    el('div.feed__text', null, [
                      el('span', { text: t('action.' + row.action) === 'action.' + row.action
                        ? row.action : t('action.' + row.action) }),
                      ' · ',
                      el('span.comment__when', { text: String(row.created_at || '').slice(0, 10) })
                    ])
                  ]);
                }))
              : panelState(actions, 'ov.noActivity')
          ])
        ])
      ])
    ];
  }

  function stat(label, value, note, alert) {
    return el('div.stat', null, [
      el('span.stat__label', { text: label }),
      el('span.stat__value' + (alert ? '.stat__value--alert' : ''), { text: value }),
      el('span.stat__note', { text: note })
    ]);
  }
  /* ── 4a Review queue — the one screen on real data ────────── */

  /* The queue predicate, and it is the schema's rather than this file's: migration 0025
     narrowed posts_moderation_queue_idx to exactly `status = 'pending' and ingest_state =
     'ready'`, because an item whose media is still being transcoded reaches a moderator as
     a row with nothing to look at.

     Both halves are also a REQUEST, not a guard (§5). If policy 0018 were wrong this would
     return whatever the database chose to hand over; what keeps another member's pending
     post out of this list is the policy, not the filter. */
  /* created_on, not created_at — and created_by is absent entirely.
   *
   * 0015 grants SELECT column by column, and `created_at` is not among them for ANY browser
   * role. §7: "Public timestamps are day-precision. Never expose exact submission times
   * publicly." Column grants cannot distinguish a moderator from a member, so that rule
   * reaches this dashboard too: the arrival time it can show is a DATE.
   *
   * The first draft of this query asked for created_at and created_by. PostgREST refuses
   * the whole request when it names an ungranted column, so the queue would have been
   * empty with a 403 — found by 15_moderation_queue, which had the same mistake in its
   * ORDER BY.
   */
  /* location_precision is asked for because of R1, not for display: §7 fuzzes domestic
     coordinates by default, and `exact` is the one value that opts a contributor out of
     that. It is legitimate — a public landmark has no home to expose — which is exactly
     why the schema does not refuse it and why the control has to be editorial. A
     moderator must SEE the choice, or precise coordinates get published by never being
     noticed.

     Safe to name here, and checked rather than assumed: 0015 grants it to
     `authenticated`, and 15_moderation_queue asserts that with `location` as the control.
     PostgREST refuses the WHOLE request when a query names one ungranted column, so
     adding a column to this list is never cosmetic — it is how the queue silently
     becomes empty. */
  var QUEUE_QUERY = [
    /* `place:places(...)` is a PostgREST embed across posts.place_id. It works because
       0015 grants `authenticated` SELECT on those two columns and 0017's places_select
       admits every signed-in reader — not because this query asked nicely. */
    'select=id,kind,title_ar,title_en,body_ar,body_en,created_on,' +
      'license,provenance,decade,location_precision,place_id,' +
      'place:places(name_ar,name_en),' +
      'media_assets(role,rendition,storage_path,bucket,mime,width,height,bytes,duration_s)',
    'status=eq.pending',
    'ingest_state=eq.ready',
    'order=created_on.asc',
    'limit=100'
  ].join('&');

  /* §1 promises a reply within 48 hours and the share sheet says so to every contributor.
     The countdown a moderator sees is that promise, not a setting. */
  var SLA_HOURS = 48;

  /* Day precision in, hours out — see QUEUE_QUERY. The number a moderator reads is
     therefore coarse, and honestly so: it cannot be finer than the column allows. */
  function hoursSince(dateOnly) {
    var then = Date.parse(dateOnly);
    if (!isFinite(then)) return 0;
    return Math.max(0, Math.floor((Date.now() - then) / 86400000) * 24);
  }

  /* The UI filters on photo/voice/video/event; the database stores media/voice/event. The
     difference that matters to a reviewer is what they are about to look at, so the display
     kind is derived from the master's mime rather than from `kind`. */
  function displayKind(row, master) {
    if (row.kind === 'event') return 'event';
    var mime = (master && master.mime) || '';
    if (mime.indexOf('video/') === 0) return 'video';
    if (mime.indexOf('audio/') === 0) return 'voice';
    if (row.kind === 'voice') return 'voice';
    return 'photo';
  }

  /* A CDN URL for a derivative.

     Only ever called for bucket='public' rows. §3: "NEVER serve a row with
     bucket='originals' through the public CDN path" — and the master is filtered out
     before this is reached, not checked inside it, so there is no path where an
     originals/ row could acquire a public URL by accident. */
  /* DB.mediaUrl, not a local concatenation: it returns null for anything outside the
     `public` bucket, which is §6's rule expressed as code rather than as a habit of the
     callers. See db.js for why that distinction is worth a function. */
  function cdnUrl(asset) {
    return DB.mediaUrl(asset);
  }

  function mapRow(row) {
    var assets = row.media_assets || [];
    var master = null;
    var thumb = null;
    var renditions = [];
    assets.forEach(function (a) {
      if (a.role === 'master') master = a;
      else if (a.role === 'thumb') thumb = a;
      else if (a.role === 'rendition') renditions.push(a);
    });

    var arrived = hoursSince(row.created_on);
    var titlePair = { ar: row.title_ar || row.title_en || '', en: row.title_en || row.title_ar || '' };
    var storyPair = { ar: row.body_ar || row.body_en || '', en: row.body_en || row.body_ar || '' };

    return {
      id: row.id,
      kind: displayKind(row, master),
      arrivedHours: arrived,
      hoursLeft: Math.max(0, SLA_HOURS - arrived),
      title: titlePair,
      story: storyPair,
      /* Everything the prototype invented per item and the database does not carry yet.
         Left as empty pairs rather than removed, so the existing detail panel renders
         unchanged instead of needing a rewrite it will get in M3 anyway. */
      by: { ar: '', en: '' },
      byInitial: { ar: '؟', en: '?' },
      /* Real as of M4. This was an empty pair for three milestones because nothing wrote
         posts.place_id — 0049 does now, from the gazetteer the share sheet resolves
         against, so the field a moderator reads is the answer a contributor gave. */
      placeId: row.place_id || null,
      place: row.place
        ? { ar: row.place.name_ar || row.place.name_en || '',
            en: row.place.name_en || row.place.name_ar || '' }
        : { ar: '', en: '' },
      decade: row.decade ? { ar: String(row.decade), en: String(row.decade) } : { ar: '', en: '' },
      tags: [],
      thumbs: [],
      imageCount: renditions.length,
      /* Provenance and licence are the two §7 fields a reviewer actually has to read: a
         contributor granting a licence they do not hold is how heritage archives acquire
         liability. */
      license: row.license || '',
      provenance: row.provenance || '',
      /* Null for a post with no coordinates at all, which is most of them. Only the
         string 'exact' raises the flag — 'street' and 'area' are already fuzzed and
         'hidden' publishes nothing. */
      locationPrecision: row.location_precision || null,
      plate: [master && master.mime,
              master && master.width ? master.width + '×' + master.height : null,
              master && master.bytes ? Math.round(master.bytes / 1024) + ' KB' : null]
        .filter(Boolean).join(' · '),
      thumbUrl: thumb ? cdnUrl(thumb) : null,
      previewUrl: renditions.length ? cdnUrl(renditions[0]) : null,
      previewMime: renditions.length ? renditions[0].mime : null
    };
  }

  function loadQueue() {
    return DB.select('posts', QUEUE_QUERY).then(function (rows) {
      work.queue = (rows || []).map(mapRow);
      work.queueLoaded = true;
      work.queueError = null;
      if (!work.queueSelected && work.queue.length) work.queueSelected = work.queue[0].id;
      render();
    }).catch(function (err) {
      work.queueLoaded = true;
      work.queueError = err && err.key ? err.key : 'admin.err.generic';
      render();
    });
  }

  function slaClass(hoursLeft) {
    if (hoursLeft <= 12) return '.sla--soon';
    if (hoursLeft <= 24) return '.sla--warn';
    return '';
  }

  function renderQueue() {
    var items = pendingQueue();
    var selected = null;
    items.forEach(function (item) { if (item.id === work.queueSelected) selected = item; });
    if (!selected) selected = items[0] || null;
    if (selected) work.queueSelected = selected.id;

    var counts = {
      all: work.queue.length,
      photo: work.queue.filter(function (i) { return i.kind === 'photo'; }).length,
      voice: work.queue.filter(function (i) { return i.kind === 'voice'; }).length,
      video: work.queue.filter(function (i) { return i.kind === 'video'; }).length,
      event: work.queue.filter(function (i) { return i.kind === 'event'; }).length,
      soon: work.queue.filter(function (i) { return i.hoursLeft <= 24; }).length
    };

    var filters = [
      ['all', t('q.all'), counts.all, null],
      ['photo', t('q.photos'), counts.photo, null],
      ['voice', t('q.voice'), counts.voice, null],
      ['video', t('q.video'), counts.video, null],
      ['event', t('q.events'), counts.event, null],
      ['soon', t('q.dueSoon'), counts.soon, 'chip--alert chip--end']
    ];

    return [
      topbar(t('q.title'), t('q.sub', { n: num(work.queue.length) }), [
        langButton(),
        el('input.search', { type: 'search', placeholder: t('q.searchPh'), 'aria-label': t('q.searchPh') }),
        el('button.abtn.abtn--ghost', { type: 'button', text: t('q.oldest') })
      ]),
      el('div.chips', null, filters.map(function (f) {
        return chip(f[1] + ' ' + num(f[2]), work.queueFilter === f[0], function () {
          work.queueFilter = f[0];
          render();
        }, f[3]);
      })),
      el('div.admin__body', null, [
        el('div.pane-list', { role: 'listbox', 'aria-label': t('q.title') }, items.length
          ? items.map(function (item) {
              return el('button.queue-item', {
                type: 'button',
                role: 'option',
                'aria-selected': item.id === work.queueSelected ? 'true' : 'false',
                onclick: function () { work.queueSelected = item.id; render(); }
              }, [
                el('div.queue-item__row', null, [
                  el('span.queue-item__title', { text: pick(item.title) }),
                  /* R1. In the LIST as well as the detail pane, because a moderator
                     working a queue of thirty decides what to open from this row — a flag
                     only in the inspector is a flag seen after the decision to look. */
                  exactFlag(item),
                  // Latin digits: the SLA chip is set in Inter and reads left-to-right.
                  el('span.sla' + slaClass(item.hoursLeft), { text: item.hoursLeft + 'h' })
                ]),
                /* `pick(item.by)` sat between these two and mapRow has never had a value
                   for it — 0015 does not grant `created_by` on posts to any browser role,
                   so the queue query cannot ask who submitted an item. The result was a
                   double separator around nothing. Dropped rather than filled: the honest
                   fix needs posts_full(), which is a change to M1's screen. */
                el('div.queue-item__sub', {
                  text: t('kind.' + item.kind) + ' · ' + t('time.ago', { n: num(item.arrivedHours) })
                })
              ]);
            })
          /* Three states, not one. "Nothing pending", "still asking" and "could not ask"
             look identical if they share a message, and they mean opposite things: the
             first is a moderator's job done, the last is a moderator being shown a clear
             queue that is not clear. */
          : el('p.queue-item__sub', { style: 'padding:20px', text:
              work.queueError ? t(work.queueError)
                : !work.queueLoaded ? t('q.loading')
                : t('q.empty') })),
        selected ? queueDetail(selected) : el('div.empty-pane', { text:
          work.queueError ? t(work.queueError)
            : !work.queueLoaded ? t('q.loading')
            : t('q.clear') })
      ])
    ];
  }

  function queueDetail(item) {
    var noteId = 'note-' + item.id;

    return el('div.pane-detail', null, [
      el('div.pane-detail__scroll', null, [
        el('div.pane-detail__media', null, [
          el('div.submitted-plate.plate', { style: toneStyle(item.tone) }, [
            el('span.mono', { text: item.plate }),
            el('span.submitted-plate__status', { text: t('q.awaiting') })
          ]),
          item.thumbs && item.thumbs.length > 1
            ? el('div.thumbs', null, item.thumbs.map(function (tone, i) {
                return el('button.thumb', {
                  type: 'button', 'aria-pressed': i === 0 ? 'true' : 'false',
                  'aria-label': String(i + 1), style: toneStyle(tone)
                });
              }).concat([
                el('span.thumbs__note', { text: t('q.inThis', { n: num(item.thumbs.length) }) })
              ]))
            : null
        ]),
        el('div.pane-detail__side', null, [
          el('div', null, [
            el('h2.detail__title', { text: pick(item.title) }),
            el('div.detail__gloss.gloss-line', { text: gloss(item.title) })
          ]),
          el('p.detail__story', { text: pick(item.story) }),
          el('div.detail__fields', null, [
            detailField(t('q.place'), pick(item.place)),
            detailField(t('q.decade'), pick(item.decade)),
            /* The list flag says "look"; this says what was chosen and what publishing it
               would mean. Shown for every value, not only 'exact', so the field is a fact
               about the post rather than an alarm that appears from nowhere. */
            item.locationPrecision
              ? el('div.detail__field', null, [
                  el('span.detail__key', { text: t('q.precision') }),
                  el('span.detail__value', null, [
                    el('span', { text: t('precision.' + item.locationPrecision) }),
                    item.locationPrecision === 'exact'
                      ? el('span.detail__warn', { text: t('q.exactWhy') })
                      : null
                  ])
                ])
              : null,
            /* R1, carried from M0 and completed here. The queue has flagged 'exact' since
               M1 "so publishing a precise coordinate is reviewed as a decision rather than
               accepted as a default" — but a flag with no control beside it left a
               moderator who saw a wrong pin with one option, which was to reject the whole
               submission. This is the other half. */
            el('div.detail__field', null, [
              el('span.detail__key', { text: t('q.locationFix') }),
              el('span.detail__value', null, [
                el('button.abtn.abtn--ghost', {
                  type: 'button',
                  onclick: function () { openLocationFix(item); },
                  text: t('q.locationFixDo')
                })
              ])
            ]),
            el('div.detail__field', null, [
              el('span.detail__key', { text: t('q.tags') }),
              el('div.detail__tags', null, item.tags.map(function (tag) {
                return el('span.tag', { text: pick(tag) });
              }).concat([el('button.tag.tag--add', { type: 'button', text: t('q.addTag') })]))
            ])
          ]),
          /* This block used to show a contributor: an avatar, a name, and
             "Member since {year} · {n} published". None of those values has ever existed.
             mapRow leaves `by`, `byInitial`, `memberSince` and `published` unset — they
             were prototype fields, and 0015 grants no browser role `created_by` on posts,
             so the queue query cannot learn who submitted an item at all. What rendered
             was an empty name over the literal text "Member since undefined · undefined
             published", on the screen a moderator uses to decide.

             What replaces it is the two fields §7 actually says a reviewer has to read,
             which mapRow has been extracting since M1 and nothing displayed: "a
             contributor granting a license they do not hold is how heritage archives
             acquire liability". The publish button already refuses without them
             (posts_approved_has_rights); this is what lets a moderator judge whether the
             ones that ARE there mean anything. */
          el('div.contributor', null, [
            el('div.detail__field', null, [
              el('span.detail__key', { text: t('share.fLicense') }),
              el('span.detail__value', { text: item.license || t('q.rightsMissing') })
            ]),
            el('div.detail__field', null, [
              el('span.detail__key', { text: t('share.fProvenance') }),
              el('span.detail__value', null, bdi(item.provenance || t('q.rightsMissing')))
            ]),
            el('div.contributor__consent', { text: t('q.consent') })
          ]),
          el('div.note-field', null, [
            el('label.note-field__label', { 'for': noteId, text: t('q.internalNote') }),
            el('textarea', { id: noteId, placeholder: t('q.internalNotePh') })
          ])
        ])
      ]),
      el('div.decisions', null, [
        el('span.decisions__meta', {
          text: t('q.arrived', {
            a: t('time.ago', { n: num(item.arrivedHours) }),
            b: t('time.hours', { n: num(item.hoursLeft) })
          })
        }),
        /* §7, enforced by posts_approved_has_rights: "nothing goes public without recorded
           provenance and a license." A post missing either CANNOT be approved by anyone,
           so the button says so rather than sending an UPDATE that comes back as a raw
           constraint violation.

           Member uploads now arrive with both — the share sheet asks for them and
           claim_upload_slot refuses the upload without them (migration 0032). What still
           reaches this branch is everything that did NOT come through that path: rows
           predating 0032, and the ~300 seed items the M5 importer will carry, whose rights
           are whatever they historically are and sometimes unresolved.

           Rejecting is still allowed — a post with no rights is exactly the kind a
           moderator needs to be able to turn away. */
        (function () {
          var hasRights = Boolean(item.license) && Boolean(item.provenance);
          var busy = work.queueBusy === item.id;
          var actions = [
            el('button.abtn.abtn--quiet', {
              type: 'button', disabled: busy || null,
              onclick: function () { decide(item, 'rejected'); }, text: t('q.reject')
            }),
            el('button.abtn.abtn--ghost', {
              type: 'button', disabled: busy || null,
              onclick: function () { decide(item, 'sentBack'); }, text: t('q.sendBack')
            }),
            el('button.abtn.abtn--primary', {
              type: 'button',
              disabled: busy || !hasRights || null,
              title: hasRights ? null : t('q.rightsMissing'),
              onclick: function () { decide(item, 'published'); },
              text: busy ? t('auth.working') : t('q.publish')
            })
          ];
          if (!hasRights) actions.unshift(el('span.decisions__warn', { text: t('q.rightsMissing') }));
          return el('div.decisions__actions', null, actions);
        }())
      ])
    ]);
  }

  /* R1, carried into M1 from M0's reasoning: the queue must visually flag any submission
     with location_precision = 'exact'.

     A chip rather than a colour on the row, and labelled rather than iconographic, because
     the moderator has to be able to act on it: the decision is "did this contributor mean
     to publish their own doorstep", and an unlabelled dot does not ask that question.

     Returns null — not an empty element — for everything else. `el()` skips null children,
     so a post with no coordinates costs no DOM and no whitespace. */
  function exactFlag(item) {
    if (item.locationPrecision !== 'exact') return null;
    return el('span.flag.flag--exact', {
      text: t('q.exactFlag'),
      title: t('q.exactWhy'),
      /* The chip is decoration to a screen reader without this; the label below it in the
         detail pane is the full sentence. */
      'aria-label': t('q.exactWhy')
    });
  }

  function detailField(key, value) {
    return el('div.detail__field', null, [
      el('span.detail__key', { text: key }),
      el('span.detail__value', { text: value })
    ]);
  }

  /* A real decision.
   *
   * The client sends `status` and NOTHING else. approved_by, approved_at and content_hash
   * are written by the trigger from migration 0012 and are ungranted at the privilege
   * layer for every role (0015) — so approval attribution cannot be forged from here even
   * if this function tried. That is the design: a moderator approves by asking, and the
   * database records who asked.
   *
   * The row is removed from the local queue only AFTER the database confirms. Removing it
   * optimistically would show a moderator a drained queue built from updates that were
   * refused — the exact failure §5 warns about, where the client's picture of authorization
   * and the database's disagree and the client's is the one on screen.
   */
  var OUTCOME_STATUS = {
    published: 'approved',
    rejected: 'rejected',
    /* "Send back" returns it to the contributor to fix. There is no post_status value for
       that — 'withdrawn' means the AUTHOR pulled it — so the button is disabled rather
       than mapped onto something that means something else. Adding a state is a schema
       change and a moderation-policy decision, not something to improvise here. */
    sentBack: null
  };

  function decide(item, outcome) {
    var status = OUTCOME_STATUS[outcome];
    if (!status) { UI.toast(t('q.err.sendBackUnsupported')); return; }
    if (work.queueBusy) return;

    work.queueBusy = item.id;
    render();

    /* select=id,status is REQUIRED, not tidy. `return=representation` makes PostgREST
       select the row it just wrote, and with no select= that is `*` — which migration 0015
       revoked at the table level, so every approval came back 403 "permission denied for
       table posts" with the UPDATE rolled back. Both columns are in 0015's grant list.
       DB.patch now refuses a filter without one; see db.js. */
    DB.patch('posts', 'id=eq.' + encodeURIComponent(item.id) + '&select=id,status', { status: status })
      .then(function (rows) {
        work.queueBusy = null;
        /* PostgREST answers 200 with an EMPTY array when the row exists but no policy
           allowed the update — not an error. Treating that as success is how a dashboard
           tells a moderator an item was published while the database refused it. */
        if (!rows || rows.length === 0) {
          work.queueError = 'admin.err.denied';
          render();
          return;
        }
        work.queue = work.queue.filter(function (row) { return row.id !== item.id; });
        var next = pendingQueue()[0];
        work.queueSelected = next ? next.id : null;
        work.queueError = null;
        render();
        UI.toast(t('q.' + outcome, { t: pick(item.title) }));
      })
      .catch(function (err) {
        work.queueBusy = null;
        work.queueError = err && err.key ? err.key : 'admin.err.generic';
        render();
      });
  }

  /* ── 4c Published archive ────────────────────────────────── */

  /* Everything a moderator may see of an approved post, and nothing 0015 withholds.
     `location` and `created_by` are absent for the reason QUEUE_QUERY records: PostgREST
     refuses the WHOLE request when it names one ungranted column, so a column added here is
     never cosmetic — it is how the register silently becomes empty. */
  var ARCHIVE_QUERY = [
    'select=id,kind,title_ar,title_en,decade,created_on,license,location_precision,takedown',
    'status=eq.approved',
    'order=created_on.desc',
    'limit=200'
  ].join('&');

  function loadArchive() {
    return loadPanel('approved', function () { return DB.select('posts', ARCHIVE_QUERY); });
  }

  function renderArchiveRegister() {
    var p = panel('approved');
    var rows = p.rows.filter(function (row) { return !row.takedown; });
    var columns = [t('ar.colTitle'), t('ar.colKind'), t('ar.colDecade'), t('ar.colDate'), t('ar.colLicense'), ''];

    return [
      topbar(t('ar.title'), t('ar.sub', { n: rows.length ? num(rows.length) : '—' }), [langButton()]),
      el('div.admin__scroll', null, [
        rows.length
          ? el('div.table.table--archive', { role: 'table' }, [
              el('div.table__row.table__row--head', null,
                columns.map(function (label) { return el('span', { text: label }); })),
              el('div', null, rows.map(function (row) {
                var title = titlePair(row);
                return el('div.table__row', null, [
                  el('span.table__title', null,
                    el('a', { href: '/item/' + encodeURIComponent(row.id), target: '_blank', rel: 'noopener' },
                      bdi(pick(title)))),
                  el('span.table__cell', { text: t('kind.' + (row.kind === 'event' ? 'event' : row.kind === 'voice' ? 'voice' : 'photo')) }),
                  el('span.table__cell--era', { text: decadeLabel(row.decade) }),
                  el('span.table__cell.table__cell--muted', { text: row.created_on || '' }),
                  el('span.table__cell', { text: row.license || t('ar.noLicense') }),
                  el('button.abtn.abtn--quiet', {
                    type: 'button',
                    disabled: work.archiveBusy === row.id || null,
                    onclick: function () { confirmTakedown(row); },
                    text: work.archiveBusy === row.id ? t('auth.working') : t('ar.takedown')
                  })
                ]);
              }))
            ])
          : panelState(p, 'ar.empty')
      ])
    ];
  }

  /**
   * §8, from the dashboard.
   *
   * The takedown Edge Function has existed since M2 and its handler's header says it is
   * "called from admin.js by a moderator" — which was not true: nothing called it, so the
   * only way to remove content was a curl command with a moderator's token. This is the
   * button that sentence describes.
   *
   * A confirmation step, and a required note, because this is the one control on this
   * dashboard that destroys bytes: §8 deletes the derivatives AND the archival master, and
   * 0036 is explicit that "we still hold it, just privately" is not what was asked for. The
   * note goes to `moderation_actions` through the transaction-local GUC 0036 added, so the
   * ledger records why rather than only that.
   */
  /**
   * A moderator corrects where an item is.
   *
   * Two answers and one refusal, in the order 0049 resolves them: a gazetteer entry, a pin,
   * or nothing at all. "Nothing" is not a cancel — it clears the coordinate and sets the
   * precision to 'hidden', which is the correct outcome for a pin that should never have
   * been placed, and there was no other way to reach it.
   *
   * The queue holds pending posts only, so this does not un-approve anything today. It can
   * on an approved row — location is in 0012's content hash — and set_post_location returns
   * the status the row ended up with rather than the one that was asked for, so the toast
   * says which happened instead of leaving an item to reappear in the queue unexplained.
   */
  function openLocationFix(item) {
    var chosen = item.placeId ? { id: item.placeId, name: pick(item.place) } : null;
    var pin = null;
    var timer = null;
    var sequence = 0;
    var scrim;

    var results = el('ul.placepick__results', { role: 'listbox', hidden: true });
    var summary = el('p.placepick__chosen');
    var error = el('p.form-error', { role: 'alert', hidden: true });

    function describe() {
      summary.textContent = chosen ? t('q.locationPlace', { name: chosen.name })
        : pin ? t('q.locationPin')
        : t('q.locationNone');
    }

    var search = el('input.input', {
      type: 'text',
      placeholder: t('q.locationSearch'),
      'aria-label': t('q.locationSearch'),
      oninput: function () {
        global.clearTimeout(timer);
        var term = search.value.trim();
        if (term.length < 2) { mount(results, []); results.hidden = true; return; }
        var mine = ++sequence;
        timer = global.setTimeout(function () {
          DB.rpc('places_search', { p_q: term }).then(function (rows) {
            if (mine !== sequence || !scrim) return;
            mount(results, (rows || []).map(function (row) {
              var name = pick({ ar: row.name_ar || row.name_en, en: row.name_en || row.name_ar });
              return el('li.placepick__result', { role: 'option' },
                el('button.placepick__hit', {
                  type: 'button',
                  onclick: function () {
                    chosen = { id: row.id, name: name };
                    pin = null;
                    search.value = '';
                    mount(results, []);
                    results.hidden = true;
                    describe();
                  }
                }, bdi(name)));
            }));
            results.hidden = false;
          }, function () { if (scrim) { mount(results, []); results.hidden = true; } });
        }, 250);
      }
    });

    function close() {
      global.clearTimeout(timer);
      if (scrim && scrim._release) scrim._release();
      if (scrim) scrim.remove();
      scrim = null;
    }

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        DB.rpc('set_post_location', {
          p_post_id: item.id,
          p_place_id: chosen ? chosen.id : null,
          p_lat: pin ? pin.lat : null,
          p_lon: pin ? pin.lon : null
        }).then(function (out) {
          if (!out || out.saved !== true) {
            error.textContent = t('q.locationErr.' + ((out && out.reason) || 'generic'));
            error.hidden = false;
            return;
          }
          close();
          UI.toast(t('q.locationSaved'));
          loadQueue();
        }, function (err) {
          error.textContent = t(err && err.key ? err.key : 'admin.err.generic');
          error.hidden = false;
        });
      }
    }, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('q.locationFix') }),
          el('p.dialog__blurb', { text: t('q.locationBlurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ]),
      summary,
      el('div.field', null, [
        el('label.field__label', { text: t('q.locationSearch') }),
        search,
        results
      ]),
      el('div.placepick__actions', null, [
        el('button.abtn.abtn--ghost', {
          type: 'button',
          onclick: function () {
            openPin(pin, function (where) { pin = where; chosen = null; describe(); });
          },
          text: t('q.locationPinDo')
        }),
        el('button.abtn.abtn--ghost', {
          type: 'button',
          onclick: function () { chosen = null; pin = null; describe(); },
          text: t('q.locationClear')
        })
      ]),
      el('p.field__hint', { text: t('q.locationNote') }),
      error,
      el('div.dialog__actions', null, [
        el('button.abtn.abtn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.abtn.abtn--primary', { type: 'submit', text: t('q.locationSave') })
      ])
    ]);

    describe();
    scrim = el('div.scrim', { role: 'dialog', 'aria-modal': 'true' }, [form]);
    global.document.body.appendChild(scrim);
    scrim._release = UI.trapFocus(scrim, close);
  }

  function confirmTakedown(row) {
    var noteInput = el('textarea.input', {
      rows: '2', required: true,
      placeholder: t('ar.takedownNotePh'), 'aria-label': t('ar.takedownNote')
    });
    var error = el('p.form-error', { role: 'alert', hidden: true });
    var scrim;

    function close() {
      if (scrim && scrim._release) scrim._release();
      if (scrim) scrim.remove();
      scrim = null;
    }

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        var note = noteInput.value.trim();
        if (!note) { error.textContent = t('ar.takedownNoteRequired'); error.hidden = false; return; }
        close();
        runTakedown(row, note);
      }
    }, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('ar.takedownTitle') }),
          el('p.dialog__blurb', { text: t('ar.takedownBlurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ]),
      el('p.detail__story', null, bdi(pick(titlePair(row)))),
      noteInput,
      error,
      el('div.dialog__actions', null, [
        el('button.abtn.abtn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.abtn.abtn--primary', { type: 'submit', text: t('ar.takedownConfirm') })
      ])
    ]);

    scrim = el('div.scrim', { role: 'dialog', 'aria-modal': 'true' }, [form]);
    global.document.body.appendChild(scrim);
    scrim._release = UI.trapFocus(scrim, close);
  }

  function runTakedown(row, note) {
    work.archiveBusy = row.id;
    render();

    var url = CONFIG.origins.supabase + '/functions/v1/takedown';
    AUTH.accessToken().then(function (token) {
      return global.fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: CONFIG.supabase.anonKey,
          Authorization: 'Bearer ' + token
        },
        body: JSON.stringify({ post_id: row.id, note: note })
      });
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (body) {
        work.archiveBusy = null;

        /* 200 and 207 are BOTH takedowns and mean different things, and collapsing them is
           the failure the Edge Function's own header warns about: 207 means the post is
           marked and hidden and some part of the removal did not complete — an unpurged
           CDN path, an object R2 refused. A moderator who is told "done" while a cached
           copy is still being served has been given something worse than an error, because
           the next thing they do is tell a contributor their photograph is gone. */
        if (res.status === 200) {
          markTakenDown(row.id);
          UI.toast(t('ar.takenDown', { t: pick(titlePair(row)) }));
        } else if (res.status === 207) {
          markTakenDown(row.id);
          UI.toast(t('ar.takenDownPartial', { r: String(body.cdn_reason || body.reason || '') }));
        } else {
          UI.toast(t(body.error === 'forbidden' ? 'admin.err.denied' : 'admin.err.generic'));
        }
        render();
      });
    }).catch(function () {
      work.archiveBusy = null;
      UI.toast(t('admin.err.offline'));
      render();
    });
  }

  function markTakenDown(id) {
    panel('approved').rows.forEach(function (row) { if (row.id === id) row.takedown = true; });
  }

  /* ── 4d Events ───────────────────────────────────────────── */

  /* Events are `kind = 'event'` posts (§3: "Do not split by type"), so PENDING events are
     already in the review queue with everything else and its `event` filter finds them.
     This screen is therefore the LIVE list — what the events surface is actually showing —
     which is the half a moderator could not see anywhere before. */
  function renderEvents() {
    var p = panel('approved');
    var rows = p.rows.filter(function (row) { return row.kind === 'event' && !row.takedown; });
    var pendingEvents = work.queue.filter(function (item) { return item.kind === 'event'; }).length;

    return [
      topbar(t('ae.title'), t('ae.sub', { n: num(rows.length) }), [
        langButton(),
        pendingEvents
          ? el('a.abtn.abtn--primary', { href: '#/queue', text: t('ae.inQueue', { n: num(pendingEvents) }) })
          : null
      ]),
      el('div.admin__scroll', null, [
        el('p.panel__aside', { style: 'padding:0 0 14px', text: t('ae.note') }),
        rows.length
          ? el('div.table.table--archive', { role: 'table' }, [
              el('div.table__row.table__row--head', null, [
                el('span', { text: t('ar.colTitle') }),
                el('span', { text: t('ar.colDecade') }),
                el('span', { text: t('ar.colDate') }),
                el('span', { text: '' })
              ]),
              el('div', null, rows.map(function (row) {
                return el('div.table__row', null, [
                  el('span.table__title', null, bdi(pick(titlePair(row)))),
                  el('span.table__cell--era', { text: decadeLabel(row.decade) }),
                  el('span.table__cell.table__cell--muted', { text: row.created_on || '' }),
                  el('a.abtn.abtn--ghost', {
                    href: '/item/' + encodeURIComponent(row.id), target: '_blank', rel: 'noopener',
                    text: t('ae.view')
                  })
                ]);
              }))
            ])
          : panelState(p, 'ae.empty')
      ])
    ];
  }

  /* ── 4e Places ───────────────────────────────────────────── */

  /* The gazetteer, and in M4 it is writable.
   *
   * §10's M4: "place-name autocomplete → gazetteer resolution → drag-to-confirm pin
   * fallback". The contributor's half of that is in the share sheet; this is the half that
   * makes it worth anything, because autocomplete over an empty table answers nothing. A
   * moderator adds the places, confirms the coordinates, and collects the misspellings as
   * aliases — 0048's matcher is a substring match and Arabic orthography varies, so an
   * alias is the answer to "why did searching for منارة not find المنارة".
   *
   * What this screen replaced: seven invented landmarks on a Leaflet map fed by the public
   * OSM tile endpoint, which §2 forbids in as many words and the CSP has blocked since M0.
   *
   * §5, once, because this screen now writes: nothing here is a guard. 0017's places_insert
   * and places_update policies require is_moderator(), 0048's save_place is SECURITY
   * INVOKER so those policies still decide, and 0048's trigger writes §4's audit rows
   * whatever calls it. A member who loads this file and clicks Save is refused by the
   * database.
   */
  function renderPlaces() {
    var p = panel('places');

    return [
      topbar(t('pl.title'), t('pl.sub', { n: p.loaded ? num(p.rows.length) : '—' }), [
        el('button.abtn.abtn--primary', {
          type: 'button', onclick: function () { openPlaceEditor(null); }, text: t('pl.add')
        }),
        langButton()
      ]),
      el('div.admin__scroll', null, [
        el('p.panel__aside', { style: 'padding:0 0 14px', text: t('pl.editNote') }),
        p.rows.length
          ? el('div.places', null, p.rows.map(function (place) {
              return el('button.place.place--button', {
                type: 'button',
                onclick: function () { openPlaceEditor(place); }
              }, [
                el('div', { style: 'flex:1;min-width:0' }, [
                  el('div.place__name', null, bdi(pick({ ar: place.name_ar || place.name_en, en: place.name_en || place.name_ar }))),
                  el('div.place__coords.gloss-line', {
                    text: gloss({ ar: place.name_ar || '', en: place.name_en || '' }) || ''
                  })
                ]),
                place.unconfirmed
                  ? el('span.flag.flag--exact', { text: t('pl.unconfirmed'), title: t('pl.unconfirmedWhy') })
                  : null
              ]);
            }))
          : panelState(p, 'pl.empty')
      ])
    ];
  }

  /**
   * Create or correct one entry.
   *
   * The coordinate is set with the same pin control a contributor uses, on the same map
   * module, because a gazetteer coordinate and a contributor's pin are the same act — and
   * because a pair of numeric boxes is not something anybody can fill in honestly from
   * memory.
   *
   * `unconfirmed` is the one field with a rule behind it rather than a preference: 0005's
   * places_confirmed_has_location says a confirmed place knows where it is, so saving a
   * confirmed entry with no pin is refused. An entry with a name and no coordinate is
   * legitimate and is exactly what the flag is for — it is a place somebody named that
   * nobody has located yet, and 0050 keeps it out of the published map until they do.
   */
  function openPlaceEditor(place) {
    var editing = place || null;
    var names = UI.langPair(t('pl.name'), {
      ar: (editing && editing.name_ar) || '',
      en: (editing && editing.name_en) || ''
    });
    var aliasInput = el('input.input', {
      type: 'text',
      placeholder: t('pl.aliasesPh'),
      'aria-label': t('pl.aliases')
    });
    aliasInput.value = ((editing && editing.aliases) || []).join('، ');

    var point = editing && typeof editing.lat === 'number'
      ? { lat: editing.lat, lon: editing.lon }
      : null;
    var pointNote = el('p.field__hint', {
      text: point ? t('pl.pinSet', { n: point.lat.toFixed(4) + ', ' + point.lon.toFixed(4) })
                  : t('pl.pinNone')
    });

    var unconfirmed = el('input', { type: 'checkbox' });
    unconfirmed.checked = Boolean(editing && editing.unconfirmed);

    var error = el('p.form-error', { role: 'alert', hidden: true });
    var scrim;

    function close() {
      if (scrim && scrim._release) scrim._release();
      if (scrim) scrim.remove();
      scrim = null;
    }

    var form = el('form.dialog.dialog--form', {
      onsubmit: function (event) {
        event.preventDefault();
        var pair = names.read();
        var args = {
          p_id: editing ? editing.id : null,
          p_name_ar: pair.ar || null,
          p_name_en: pair.en || null,
          // Split on either comma, because a moderator typing Arabic is typing on an Arabic
          // keyboard and the comma there is ،
          p_aliases: aliasInput.value.split(/[,،]/).map(function (a) { return a.trim(); })
            .filter(Boolean),
          p_lat: point ? point.lat : null,
          p_lon: point ? point.lon : null,
          p_unconfirmed: unconfirmed.checked
        };

        DB.rpc('save_place', args).then(function (out) {
          if (!out || out.saved !== true) {
            // The database's own reason, named. "Could not save" is not something a
            // moderator can act on; "a confirmed place needs a pin" is.
            error.textContent = t('pl.err.' + ((out && out.reason) || 'generic'));
            error.hidden = false;
            return;
          }
          close();
          // Reloaded rather than patched into the list: the row that came back is the row
          // the database has, and merging a local copy is how two views of one table start
          // disagreeing.
          var panelData = panel('places');
          panelData.loaded = false;
          panelData.loading = false;
          LOADERS.places();
          UI.toast(t('pl.saved'));
        }, function (err) {
          error.textContent = t(err && err.key ? err.key : 'admin.err.generic');
          error.hidden = false;
        });
      }
    }, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: editing ? t('pl.editTitle') : t('pl.addTitle') }),
          el('p.dialog__blurb', { text: t('pl.blurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ]),
      names.node,
      el('div.field', null, [
        el('label.field__label', { text: t('pl.aliases') }),
        aliasInput,
        el('p.field__hint', { text: t('pl.aliasesWhy') })
      ]),
      el('div.field', null, [
        el('label.field__label', { text: t('pl.point') }),
        el('button.abtn.abtn--ghost', {
          type: 'button',
          onclick: function () {
            openPin(point, function (where) {
              point = where;
              pointNote.textContent = t('pl.pinSet', {
                n: where.lat.toFixed(4) + ', ' + where.lon.toFixed(4)
              });
            });
          },
          text: t('pl.pinPick')
        }),
        pointNote
      ]),
      el('label.checkbox.checkbox--wrap', null, [
        unconfirmed,
        el('span', { text: t('pl.unconfirmedLabel') })
      ]),
      error,
      el('div.dialog__actions', null, [
        el('button.abtn.abtn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        el('button.abtn.abtn--primary', { type: 'submit', text: t('pl.save') })
      ])
    ]);

    scrim = el('div.scrim', { role: 'dialog', 'aria-modal': 'true' }, [form]);
    global.document.body.appendChild(scrim);
    scrim._release = UI.trapFocus(scrim, close);
  }

  /**
   * The map, in pick mode, over a scrim.
   *
   * Shared by the gazetteer editor and by the queue's location control below. When no
   * basemap is provisioned — config/site.json's basemap.path is empty until somebody builds
   * the extract — this says so and offers nothing else: a coordinate typed into a box is a
   * coordinate nobody verified, and this is the table the whole map draws its names from.
   */
  function openPin(current, onConfirm) {
    var pin = current || null;
    var instance = null;
    var scrim;

    function close() {
      if (instance) instance.destroy();
      instance = null;
      if (scrim && scrim._release) scrim._release();
      if (scrim) scrim.remove();
      scrim = null;
    }

    var slot = el('div.mapview.mapview--pick');
    var confirm = el('button.abtn.abtn--primary', {
      type: 'button',
      disabled: !pin,
      onclick: function () { if (pin) { onConfirm(pin); close(); } },
      text: t('pl.pinConfirm')
    });

    function failed() {
      mount(slot, el('p.mapview__note', { role: 'status', text: t('pl.pinNoMap') }));
      confirm.disabled = true;
    }

    var dialog = el('div.dialog.dialog--pin', null, [
      el('div.dialog__head', null, [
        el('div.dialog__head-text', null, [
          el('h2.dialog__title', { text: t('pl.pinTitle') }),
          el('p.dialog__blurb', { text: t('pl.pinBlurb') })
        ]),
        el('button.dialog__close', { type: 'button', 'aria-label': t('action.close'), onclick: close, text: '✕' })
      ]),
      slot,
      el('div.dialog__actions', null, [
        el('button.abtn.abtn--ghost', { type: 'button', onclick: close, text: t('action.cancel') }),
        confirm
      ])
    ]);

    scrim = el('div.scrim', { role: 'dialog', 'aria-modal': 'true' }, [dialog]);
    global.document.body.appendChild(scrim);
    scrim._release = UI.trapFocus(scrim, close);

    if (!CONFIG.basemap.url) { failed(); return; }

    UI.loadMap().then(function () {
      if (!scrim) return;
      instance = global.MAP.create(slot, {
        url: CONFIG.basemap.url,
        mode: 'pick',
        label: t('pl.pinTitle'),
        center: pin || { lat: 31.9038, lon: 35.2034 },
        zoom: 15,
        pin: pin,
        onPin: function (where) { pin = where; confirm.disabled = false; },
        onFail: failed
      });
      instance.ready.catch(function () { /* onFail has it */ });
    }, failed);
  }

  /* ── 4f Members ──────────────────────────────────────────── */

  /**
   * Who has a profile, and what badge they wear.
   *
   * Read-only, and the reason is §4 rather than effort. "Manage users / roles" is an admin
   * capability, but a role lives in `public.user_roles`, which 0015 revokes from every
   * browser role twice over — no grant and no policy — precisely so that the ability to
   * make a moderator is not reachable from a page. Granting it would need an RPC with its
   * own audit path and its own denial tests, and no milestone has specified one.
   *
   * `role_cache` is what is shown, and it is labelled as a badge in the copy rather than as
   * a permission: §4 says it "must never be trusted for authorization", and a dashboard
   * column headed "role" invites exactly that reading.
   *
   * No email column, and there will not be one — §7: "Emails are never published. Not in
   * profiles, not in snapshots, not in exports." The schema does not have the column, which
   * is the version of that rule that cannot be undone by a query. The previous screen
   * showed invented ones.
   */
  function renderMembers() {
    var p = panel('members');

    return [
      topbar(t('mb.title'), t('mb.sub', { n: p.loaded ? num(p.rows.length) : '—' }), [langButton()]),
      el('div.admin__scroll', null, [
        el('p.panel__aside', { style: 'padding:0 0 14px', text: t('mb.readOnly') }),
        p.rows.length
          ? el('div.table.table--members', { role: 'table' }, [
              el('div.table__row.table__row--head', null, [
                el('span', { text: t('mb.colHandle') }),
                el('span', { text: t('mb.colName') }),
                el('span', { text: t('mb.colBadge') })
              ]),
              el('div', null, p.rows.map(function (row) {
                return el('div.table__row', null, [
                  el('span.table__title', null,
                    el('a', { href: '/u/' + encodeURIComponent(row.handle), target: '_blank', rel: 'noopener' },
                      bdi('@' + row.handle))),
                  el('span.table__cell', null, bdi(row.display_name || '')),
                  el('span.table__cell', null, el('span.badge', { text: t('role.' + (row.role_cache || 'member')) }))
                ]);
              }))
            ])
          : panelState(p, 'mb.empty')
      ])
    ];
  }

  /* ── 4g Reports ──────────────────────────────────────────── */

  function openReports() {
    return panel('reports').rows.filter(function (row) { return row.status !== 'closed'; });
  }

  function reportsPanelLoaded() { return panel('reports').loaded; }

  /**
   * §4's "review reports", on the real table.
   *
   * Until M3 nothing could CREATE a report — the info page promised "use the report control
   * on the memory" and there was no control — so this screen reviewed an invented list.
   * engage.js writes them now, from the viewer.
   *
   * The reporter is shown by user id and not by handle, which looks unhelpful and is
   * deliberate: `reports.reported_by` is a uuid and joining it to `profiles` would put "who
   * reported whom" on a screen. 0020 already restricts a report to its reporter and to
   * moderators for exactly that reason — revealing a reporter to the person they reported
   * is how retaliation happens — and a moderator deciding a report does not need the name to
   * decide it.
   */
  function renderReports() {
    var p = panel('reports');
    var rows = openReports();
    var selected = null;
    rows.forEach(function (row) { if (row.id === work.reportSelected) selected = row; });
    if (!selected) selected = rows[0] || null;
    if (selected) work.reportSelected = selected.id;

    return [
      topbar(t('rp.title'), t('rp.sub', { n: num(rows.length) }), [langButton()]),
      el('div.admin__body', null, [
        el('div.pane-list', { role: 'listbox', 'aria-label': t('rp.title') }, rows.length
          ? rows.map(function (row) {
              return el('button.queue-item', {
                type: 'button', role: 'option',
                'aria-selected': row.id === work.reportSelected ? 'true' : 'false',
                onclick: function () { work.reportSelected = row.id; render(); }
              }, [
                el('span.queue-item__title', null, bdi(row.reason.slice(0, 80))),
                /* The kind LEADS the line. An abuse report asks whether a rule was broken
                   and may legitimately be answered no; a removal request is somebody
                   asserting a right over material about themselves and starts §8's clock.
                   A moderator has to tell them apart before reading the reason. */
                el('span.queue-item__sub', { text: t('rp.kind.' + (row.kind || 'abuse'))
                  + ' · ' + t('rp.on.' + row.target_type)
                  + ' · ' + String(row.created_at || '').slice(0, 10) })
              ]);
            })
          : [panelState(p, 'rp.empty')]),
        selected ? reportDetail(selected) : el('div.empty-pane', {
          text: p.error ? t(p.error) : !p.loaded ? t('q.loading') : t('rp.empty')
        })
      ])
    ];
  }

  function reportDetail(row) {
    var busy = work.reportBusy === row.id;
    return el('div.pane-detail', null, [
      el('div.pane-detail__scroll', null, [
        el('div.pane-detail__side', null, [
          el('h2.detail__title', { text: t('rp.reason', { r: '' }) }),
          el('p.detail__story', null, bdi(row.reason)),
          el('div.detail__fields', null, [
            detailField(t('rp.target'), t('rp.on.' + row.target_type)),
            detailField(t('rp.filed'), String(row.created_at || '').slice(0, 10)),
            detailField(t('mb.colStatus'), t('rp.' + (row.status === 'closed' ? 'closed' : 'open')))
          ]),
          row.target_type === 'post'
            ? el('a.abtn.abtn--ghost', {
                href: '/item/' + encodeURIComponent(row.target_id), target: '_blank', rel: 'noopener',
                text: t('rp.viewContent')
              })
            : null,
          el('div.review-note', { text: t('rp.logged') })
        ])
      ]),
      el('div.decisions', null, [
        el('span.decisions__meta', { text: t('rp.closeNote') }),
        el('div.decisions__actions', null, [
          el('button.abtn.abtn--primary', {
            type: 'button', disabled: busy || null,
            onclick: function () { closeReport(row); },
            text: busy ? t('auth.working') : t('rp.keep')
          })
        ])
      ])
    ]);
  }

  function closeReport(row) {
    if (work.reportBusy) return;
    work.reportBusy = row.id;
    render();
    /* select=id,status for the reason db.js records at length: `return=representation`
       with no select is a SELECT of `*`, and 0015 grants reports column by column. */
    DB.patch('reports', 'id=eq.' + encodeURIComponent(row.id) + '&select=id,status', { status: 'closed' })
      .then(function (rows) {
        work.reportBusy = null;
        if (!rows || !rows.length) {
          /* 200 with an empty array is an RLS refusal, not a success. Treating it as one is
             how a dashboard tells a moderator a report is closed while the database
             refused — the same trap the review queue documents. */
          UI.toast(t('admin.err.denied'));
          render();
          return;
        }
        row.status = 'closed';
        work.reportSelected = null;
        UI.toast(t('rp.closedOne'));
        render();
      })
      .catch(function (err) {
        work.reportBusy = null;
        UI.toast(t(err && err.key ? err.key : 'admin.err.generic'));
        render();
      });
  }

  /* ── 4h Site copy ────────────────────────────────────────── */

  /**
   * §4: "Edit site copy (content_blocks) — admin only." §9: the dashboard is the single
   * source of truth for every string on the public site that is not UI chrome.
   *
   * This is the screen that makes both true. Before it, the archive's Arabic and English
   * prose lived as JavaScript literals in assets/js/store.js and could only be changed by a
   * deploy.
   *
   * ── draft and published are two columns for a reason ────────
   *
   * `draft` is the editor's working copy and reaches no shard; `published` is what the
   * publisher bakes into content.json. Saving writes the draft. Publishing copies the draft
   * over `published`, which bumps the content revision (0043) and dispatches a publish
   * (0042) — so the two buttons are genuinely different actions and the second one is the
   * one that changes what the world reads.
   *
   * A moderator sees this screen too, and every write they attempt is refused by 0020's
   * policy. That is §5 working as intended rather than a gap: the rail hides nothing, the
   * database decides, and a refusal arrives as a named message rather than as silence.
   */
  function renderCopy() {
    var p = panel('copy');
    var blocks = groupBlocks(p.rows);
    var keys = Object.keys(blocks).sort();
    var selected = blocks[work.copySelected] ? work.copySelected : keys[0];
    work.copySelected = selected;

    return [
      topbar(t('cp.title'), t('cp.sub'), [langButton()]),
      el('div.admin__body', null, [
        el('div.pane-list', { role: 'listbox', 'aria-label': t('cp.title') }, keys.length
          ? keys.map(function (key) {
              var dirty = work.copyDirty[key];
              return el('button.queue-item', {
                type: 'button', role: 'option',
                'aria-selected': key === selected ? 'true' : 'false',
                onclick: function () { work.copySelected = key; render(); }
              }, [
                el('span.queue-item__title', { text: key }),
                el('span.queue-item__sub', {
                  text: dirty ? t('cp.unsaved')
                    : blocks[key].unpublished ? t('cp.draftPending') : t('cp.live')
                })
              ]);
            })
          : [panelState(p, 'cp.empty')]),
        selected ? copyEditor(selected, blocks[selected]) : el('div.empty-pane', {
          text: p.error ? t(p.error) : !p.loaded ? t('q.loading') : t('cp.empty')
        })
      ])
    ];
  }

  /* content_blocks is one row per (key, locale); every editor in this codebase edits both
     sides at once (UI.langPair) so a change cannot land in one language only. */
  function groupBlocks(rows) {
    var out = {};
    rows.forEach(function (row) {
      var entry = out[row.key] || (out[row.key] = { key: row.key, ar: null, en: null, unpublished: false });
      entry[row.locale] = row;
      if (row.draft !== row.published) entry.unpublished = true;
    });
    return out;
  }

  function copyEditor(key, entry) {
    var pair = UI.langPair(key, {
      ar: (entry.ar && (entry.ar.draft != null ? entry.ar.draft : entry.ar.published)) || '',
      en: (entry.en && (entry.en.draft != null ? entry.en.draft : entry.en.published)) || ''
    }, { multiline: true, rows: '8' });

    pair.ar.addEventListener('input', function () { work.copyDirty[key] = true; });
    pair.en.addEventListener('input', function () { work.copyDirty[key] = true; });

    var note = el('p.form-error', { role: 'alert', hidden: true });

    function write(publish) {
      var value = pair.read();
      note.hidden = true;
      /* save_content_block(), not an upsert on the table — and the reason is the same one
         that put the READ behind content_blocks_draft() twelve lines below.

         PostgREST sends `resolution=merge-duplicates` as INSERT … ON CONFLICT DO UPDATE SET
         draft = excluded.draft, and EXCLUDED is the target's rowtype, so that statement
         needs SELECT on `draft`. 0015 withholds exactly that column from `authenticated`,
         because 0020's select policy is `using (true)` and the grant is the only thing
         keeping unpublished prose away from every signed-in member. So the upsert was
         refused 42501 before RLS ever ran, and every Save and every Publish on this screen
         failed from M3 until 0055 — a privilege error, so nothing recorded that an admin
         had tried. One call per locale still, for the reason the old comment gave: a key
         that exists in Arabic and not yet in English is the ordinary state of adding a
         block. */
      return Promise.all(['ar', 'en'].map(function (locale) {
        return DB.rpc('save_content_block', {
          p_key: key, p_locale: locale, p_draft: value[locale], p_publish: Boolean(publish)
        }).then(function (out) {
          if (!out || out.saved !== true) {
            /* The database's own reason, named — as on the places screen. "denied" is the
               one a moderator sees, and it is a different thing from being signed out.
               An Error carrying `.key`, because that is the shape db.js throws and the
               catch below already reads. */
            var refused = new Error('cp.err.' + ((out && out.reason) || 'generic'));
            refused.key = refused.message;
            throw refused;
          }
          return out;
        });
      })).then(function () {
        delete work.copyDirty[key];
        panel('copy').loaded = false;
        UI.toast(t(publish ? 'cp.published' : 'cp.saved'));
        return loadCopy();
      }).catch(function (err) {
        note.textContent = t(err && err.key ? err.key : 'admin.err.generic');
        note.hidden = false;
      });
    }

    return el('div.pane-detail', null, [
      el('div.pane-detail__scroll', null, [
        el('div.pane-detail__side', null, [
          el('h2.detail__title', { text: key }),
          el('p.panel__aside', { text: t('cp.blurb') }),
          pair.node,
          note
        ])
      ]),
      el('div.decisions', null, [
        el('span.decisions__meta', { text: entry.unpublished ? t('cp.draftPending') : t('cp.live') }),
        el('div.decisions__actions', null, [
          el('button.abtn.abtn--ghost', { type: 'button', onclick: function () { write(false); }, text: t('cp.save') }),
          el('button.abtn.abtn--primary', { type: 'button', onclick: function () { write(true); }, text: t('cp.publish') })
        ])
      ])
    ]);
  }

  function loadCopy() {
    return loadPanel('copy', function () {
      /* content_blocks_draft(), not the table. 0015 does not grant `draft` to anyone — it is
         unpublished prose — and 0016's accessor returns it for admins only. A moderator gets
         an empty list from the same call, which is the honest answer rather than a screen
         full of controls that will all be refused. */
      return DB.rpc('content_blocks_draft');
    });
  }

  /* ── Render ──────────────────────────────────────────────── */

  var VIEWS = {
    overview: renderOverview,
    queue: renderQueue,
    archive: renderArchiveRegister,
    events: renderEvents,
    places: renderPlaces,
    members: renderMembers,
    reports: renderReports,
    copy: renderCopy
  };

  /* Each screen asks for its own rows the first time it is opened, and never again unless
     something invalidates them. Loading everything at boot would make opening the dashboard
     five requests slower for a moderator who only ever uses the queue. */
  var LOADERS = {
    overview: function () {
      loadArchive();
      loadPanel('actions', function () {
        return DB.select('moderation_actions', 'select=action,created_at&order=created_at.desc&limit=20');
      });
      loadPanel('reports', function () {
        return DB.select('reports', 'select=id,kind,target_type,target_id,reason,status,created_at&order=kind.desc,created_at.desc&limit=100');
      });
    },
    archive: loadArchive,
    events: loadArchive,
    places: function () {
      loadPanel('places', function () {
        /* The RPC, not the table, and the reason is one column: `location` is a geography,
           which PostgREST hands over as WKB hex — a string this screen would have to parse
           to show a coordinate or seed the pin. 0048's places_search returns lat and lon as
           numbers, along with the aliases the editor needs, and an empty term means the
           whole gazetteer. */
        return DB.rpc('places_search', { p_q: '', p_limit: 200 });
      });
    },
    members: function () {
      loadPanel('members', function () {
        return DB.select('profiles', 'select=handle,display_name,role_cache&order=handle.asc&limit=200');
      });
    },
    reports: function () {
      loadPanel('reports', function () {
        return DB.select('reports', 'select=id,kind,target_type,target_id,reason,status,created_at&order=kind.desc,created_at.desc&limit=100');
      });
    },
    copy: loadCopy
  };

  function render() {
    var name = section();
    renderRail();
    mount(qs('#main'), VIEWS[name]());
    if (LOADERS[name]) LOADERS[name]();
  }

  global.addEventListener('hashchange', render);
  global.addEventListener('langchange', render);

  render();

  loadMe();
  loadQueue();
})(window);
