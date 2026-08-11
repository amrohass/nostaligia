/* The back office — screens 4a–4h.
   One olive rail, eight hash-routed sections. Decisions mutate the in-memory
   working set so the queue actually drains as a moderator works through it. */

(function (global) {
  'use strict';

  var el = UI.el, qs = UI.qs, mount = UI.mount, toneStyle = UI.toneStyle, ICONS = UI.ICONS;
  var t = function (k, v) { return I18N.t(k, v); };
  var pick = I18N.pick, gloss = I18N.gloss, num = I18N.num;

  var SECTIONS = ['overview', 'queue', 'archive', 'events', 'places', 'members', 'reports', 'settings'];
  var RAMALLAH = [31.9022, 35.2034];

  /* Working state. Everything starts from DATA and is copied so decisions in one
     session never mutate the seed. */
  var work = {
    queue: DATA.QUEUE.slice(),
    queueFilter: 'all',
    queueSelected: DATA.QUEUE[0].id,
    events: DATA.QUEUE.filter(function (item) { return item.kind === 'event'; }).slice(),
    eventsTab: 'pending',
    eventSelected: null,
    placeSelected: DATA.PLACES[0].id,
    placeCoords: {},
    memberFilter: 'all',
    memberSelected: DATA.MEMBERS[0].id,
    memberRoles: {},
    memberStatus: {},
    reports: DATA.REPORTS.slice(),
    reportSelected: DATA.REPORTS[0].id,
    settingsSection: 'review',
    settings: { sla: 48, warn: true, auto: false, reviewers: 1, comments: true }
  };

  // Events live in their own approval list, seeded from the event-kind submissions.
  work.events = [
    { id: 'e1', tone: 'ochre', publisher: 'community', submittedHours: 14,
      title: { ar: 'ورشة: ترميم الصور العائلية', en: 'Workshop: restoring family photographs' },
      venueShort: { ar: 'مركز السكاكيني', en: 'Sakakini Centre' },
      when: { ar: 'الأربعاء ١ نيسان', en: 'Wednesday 1 April' },
      date: { ar: 'الأربعاء ١ نيسان ٢٠٢٦', en: 'Wednesday 1 April 2026' },
      time: { ar: '٤:٠٠ – ٨:٠٠ عصرًا', en: '4:00 – 8:00 pm' },
      venue: { ar: 'مركز خليل السكاكيني الثقافي', en: 'Khalil Sakakini Cultural Centre' },
      seats: { ar: '٢٠ مقعدًا · التسجيل مطلوب', en: '20 seats · registration required' },
      category: { ar: 'ورشة', en: 'Workshop' },
      plate: 'event poster · 1600×1000',
      description: { ar: 'ورشة عملية لأربع ساعات في مسح الصور العائلية وترميمها رقميًا، بإشراف فريق الأرشيف. عشرون مقعدًا، والتسجيل مجاني.',
                     en: 'A four-hour hands-on workshop in scanning and digitally restoring family photographs, led by the archive team. Twenty seats, free to register.' },
      by: { ar: 'مركز السكاكيني — مروان د.', en: 'Sakakini Centre — Marwan D.' },
      byInitial: { ar: 'م', en: 'M' },
      byMeta: { ar: 'شريك موثّق · ٤ فعاليات سابقة', en: 'Verified partner · 4 previous events' } },

    { id: 'e2', tone: 'clay', publisher: 'community', submittedHours: 20,
      title: { ar: 'جولة مشي: شارع ركب وذاكرته', en: 'Walking tour: Rukab Street remembered' },
      venueShort: { ar: 'ميدان المنارة', en: 'Al-Manara Square' },
      when: { ar: 'الجمعة ١٠ نيسان', en: 'Friday 10 April' },
      date: { ar: 'الجمعة ١٠ نيسان ٢٠٢٦', en: 'Friday 10 April 2026' },
      time: { ar: '١٠:٠٠ – ١٢:٠٠ صباحًا', en: '10:00 am – 12:00 pm' },
      venue: { ar: 'نقطة اللقاء: ميدان المنارة', en: 'Meeting point: Al-Manara Square' },
      seats: { ar: '٣٠ مشاركًا · بلا تسجيل', en: '30 walkers · no registration' },
      category: { ar: 'جولة', en: 'Tour' },
      plate: 'event photo · walking tour',
      description: { ar: 'جولة على الأقدام في شارع ركب مع رواة من أهل الشارع، تتوقف عند سبعة مواقع تحمل ذكريات موثّقة في الأرشيف.',
                     en: 'A walk along Rukab Street with narrators who grew up on it, stopping at seven sites that carry memories held in the archive.' },
      by: { ar: 'سميرة خ.', en: 'Samira Kh.' },
      byInitial: { ar: 'س', en: 'S' },
      byMeta: { ar: 'مساهمة · ٧ مساهمات منشورة', en: 'Contributor · 7 published contributions' } },

    { id: 'e3', tone: 'olive', publisher: 'team', submittedHours: 31,
      title: { ar: 'ليلة استماع: أصوات من الشتات', en: 'Listening night: voices from the diaspora' },
      venueShort: { ar: 'عبر الإنترنت', en: 'Online' },
      when: { ar: 'الأحد ٣ أيار', en: 'Sunday 3 May' },
      date: { ar: 'الأحد ٣ أيار ٢٠٢٦', en: 'Sunday 3 May 2026' },
      time: { ar: '٩:٠٠ مساءً بتوقيت القدس', en: '9:00 pm Jerusalem time' },
      venue: { ar: 'عبر الإنترنت', en: 'Online' },
      seats: { ar: 'بلا حدّ', en: 'Unlimited' },
      category: { ar: 'استماع', en: 'Listening' },
      plate: 'event audio · listening night',
      description: { ar: 'ساعتان من التسجيلات الصوتية التي وصلت من عمّان وسانتياغو وديترويت، يقدّمها فريق الأرشيف ويعلّق عليها الرواة.',
                     en: 'Two hours of voice recordings sent from Amman, Santiago and Detroit, introduced by the archive team with the narrators present.' },
      by: { ar: 'فريق الأرشيف — هناء ع.', en: 'Archive team — Hana A.' },
      byInitial: { ar: 'ه', en: 'H' },
      byMeta: { ar: 'محرّرة أرشيف', en: 'Archive editor' } }
  ];
  work.eventSelected = work.events[0].id;

  /* ── Routing ─────────────────────────────────────────────── */

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

  function member(id) {
    for (var i = 0; i < DATA.MEMBERS.length; i++) if (DATA.MEMBERS[i].id === id) return DATA.MEMBERS[i];
    return null;
  }
  function memberRole(m) { return work.memberRoles[m.id] || m.role; }
  function memberStatus(m) { return work.memberStatus[m.id] || m.status; }

  /* ── Rail ────────────────────────────────────────────────── */

  function renderRail() {
    var current = section();
    var badges = {
      queue: { value: work.queue.length, kind: 'urgent' },
      events: { value: work.events.length, kind: null },
      reports: { value: work.reports.length, kind: 'warn' }
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
        el('div.rail__me-avatar', { text: I18N.lang === 'ar' ? 'ه' : 'H' }),
        el('div', null, [
          el('div.rail__me-name', { text: t('admin.me') }),
          el('div.rail__me-role', { text: t('admin.myRole') })
        ])
      ]),
      el('a.rail__exit', { href: 'index.html', text: t('admin.backToSite') })
    ]);
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

  /* ── 4b Overview ─────────────────────────────────────────── */

  function renderOverview() {
    var dueSoon = work.queue.filter(function (item) { return item.hoursLeft <= 24; }).length;
    var peak = Math.max.apply(null, DATA.INTAKE.map(function (m) { return m.value; }));

    return [
      topbar(t('ov.greeting'), t('ov.today', { n: num(dueSoon) }), [
        langButton(),
        el('a.abtn.abtn--primary', { href: '#/queue', text: t('ov.start') })
      ]),
      el('div.admin__scroll', null, [
        el('div.stat-row', null, [
          stat(t('ov.pending'), num(work.queue.length), t('ov.pendingNote'), true),
          stat(t('ov.published'), num(68), t('ov.publishedNote')),
          stat(t('ov.newMembers'), num(142), t('ov.newMembersNote')),
          stat(t('ov.audioHours'), num(31) + ':' + num(40), t('ov.audioNote'))
        ]),
        el('div.panels', null, [
          el('div.panel', null, [
            el('div.panel__head', null, [
              el('h2.panel__title', { text: t('ov.intake') }),
              el('span.panel__aside', { text: t('ov.intakeRange') })
            ]),
            el('div.bars', { role: 'img', 'aria-label': t('ov.intake') }, DATA.INTAKE.map(function (m, i) {
              var last = i === DATA.INTAKE.length - 1;
              var modifier = last ? '.bars__bar--current' : (i === DATA.INTAKE.length - 2 ? '.bars__bar--recent' : '');
              return el('div.bars__col' + (last ? '.bars__col--current' : ''), null, [
                el('div.bars__bar' + modifier, {
                  style: 'height:' + Math.round(m.value / peak * 100) + '%',
                  title: m.month + ': ' + num(m.value)
                }),
                el('span.bars__label', { text: m.month })
              ]);
            })),
            el('div.panel__foot', null, [
              el('span', { text: t('ov.totalPublished') }),
              el('span', { text: '·' }),
              el('span', { text: t('ov.mapped') })
            ])
          ]),
          el('div', { style: 'display:flex;flex-direction:column;gap:18px' }, [
            el('div.panel', null, [
              el('h2.panel__title', { text: t('ov.gaps') }),
              el('div.meters', null, DATA.COVERAGE.map(function (row) {
                var fill = row.level === 'low' ? '.meter__fill--low' : (row.level === 'mid' ? '.meter__fill--mid' : '');
                return el('div.meter', null, [
                  el('span.meter__label', { text: t('decade.' + row.decade) }),
                  el('div.meter__track', null, el('div.meter__fill' + fill, { style: 'width:' + row.pct + '%' })),
                  el('span.meter__value', { text: num(row.count) })
                ]);
              })),
              el('p.panel__aside', { style: 'line-height:1.7', text: t('ov.gapsNote') })
            ]),
            el('div.panel', null, [
              el('h2.panel__title', { text: t('ov.latest') }),
              el('ul.feed', null, DATA.ACTIVITY.map(function (item) {
                return el('li', null, [
                  el('span.feed__dot' + (item.level === 'ok' ? '' : '.feed__dot--' + item.level)),
                  el('div.feed__text', { html: pick(item.text) })
                ]);
              }))
            ])
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

  /* ── 4a Review queue ─────────────────────────────────────── */

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
                  // Latin digits: the SLA chip is set in Inter and reads left-to-right.
                  el('span.sla' + slaClass(item.hoursLeft), { text: item.hoursLeft + 'h' })
                ]),
                el('div.queue-item__sub', {
                  text: t('kind.' + item.kind) + ' · ' + pick(item.by) +
                        ' · ' + t('time.ago', { n: num(item.arrivedHours) })
                })
              ]);
            })
          : el('p.queue-item__sub', { style: 'padding:20px', text: t('q.empty') })),
        selected ? queueDetail(selected) : el('div.empty-pane', { text: t('q.clear') })
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
            el('div.detail__field', null, [
              el('span.detail__key', { text: t('q.tags') }),
              el('div.detail__tags', null, item.tags.map(function (tag) {
                return el('span.tag', { text: pick(tag) });
              }).concat([el('button.tag.tag--add', { type: 'button', text: t('q.addTag') })]))
            ])
          ]),
          el('div.contributor', null, [
            el('div.contributor__row', null, [
              el('div.contributor__avatar', { style: '--p1:#A98D66', text: pick(item.byInitial) }),
              el('div', null, [
                el('div.contributor__name', { text: pick(item.by) }),
                el('div.contributor__meta', {
                  text: (I18N.lang === 'ar' ? 'عضو منذ ' : 'Member since ') + I18N.year(item.memberSince) +
                        ' · ' + num(item.published) + (I18N.lang === 'ar' ? ' مساهمات منشورة' : ' published')
                })
              ])
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
        el('div.decisions__actions', null, [
          el('button.abtn.abtn--quiet', { type: 'button', onclick: function () { decide(item, 'rejected'); }, text: t('q.reject') }),
          el('button.abtn.abtn--ghost', { type: 'button', onclick: function () { decide(item, 'sentBack'); }, text: t('q.sendBack') }),
          el('button.abtn.abtn--primary', { type: 'button', onclick: function () { decide(item, 'published'); }, text: t('q.publish') })
        ])
      ])
    ]);
  }

  function detailField(key, value) {
    return el('div.detail__field', null, [
      el('span.detail__key', { text: key }),
      el('span.detail__value', { text: value })
    ]);
  }

  function decide(item, outcome) {
    work.queue = work.queue.filter(function (row) { return row.id !== item.id; });
    var next = pendingQueue()[0];
    work.queueSelected = next ? next.id : null;
    render();
    UI.toast(t('q.' + outcome, { t: pick(item.title) }));
  }

  /* ── 4c Published archive ────────────────────────────────── */

  function renderArchiveRegister() {
    var columns = ['', '', t('ar.colTitle'), t('ar.colBy'), t('ar.colPlace'), t('ar.colDecade'), t('ar.colDate'), t('ar.colViews'), ''];

    return [
      topbar(t('ar.title'), t('ar.sub'), [
        langButton(),
        el('button.abtn.abtn--primary', { type: 'button', onclick: function () { UI.toast(t('ar.add')); }, text: t('ar.add') })
      ]),
      el('div.chips', null, [
        chip(t('q.all') + ' ' + num(3412), true, null),
        chip(t('q.photos') + ' ' + num(2604), false, null),
        chip(t('q.voice') + ' ' + num(541), false, null),
        chip(t('q.video') + ' ' + num(267), false, null),
        chip(t('ar.filterMore'), false, null, 'chip--dashed'),
        el('button.abtn.abtn--ghost.chip--end', {
          type: 'button', onclick: function () { UI.toast(t('ar.exported')); }, text: t('ar.export')
        })
      ]),
      el('div.admin__scroll', null, [
        el('div.table.table--archive', { role: 'table' }, [
          el('div.table__row.table__row--head', null, [
            el('input', { type: 'checkbox', 'aria-label': t('q.all') })
          ].concat(columns.slice(1).map(function (label) { return el('span', { text: label }); }))),
          el('div', null, DATA.PUBLISHED.map(function (row) {
            var place = DATA.place(row.place);
            return el('div.table__row', null, [
              el('input', { type: 'checkbox', 'aria-label': pick(row.title) }),
              el('span.table__thumb', { style: toneStyle(row.tone) }),
              el('span.table__title', { text: pick(row.title) }),
              el('span.table__cell', { text: pick(row.by) }),
              el('span.table__cell', { text: place ? pick(place.name) : '' }),
              el('span.table__cell--era', { text: t('decade.' + row.decade) }),
              el('span.table__cell.table__cell--muted', { text: pick(row.on) }),
              el('span.table__num', { text: num(row.views) }),
              el('button.table__more', { type: 'button', 'aria-label': pick(row.title), text: '···' })
            ]);
          }))
        ]),
        el('div.pager', null, [
          el('span.pager__count', { text: t('ar.showing', { n: num(DATA.PUBLISHED.length) }) }),
          el('div.pager__pages', null, [
            el('button.pager__page', { type: 'button', 'aria-current': 'true', text: num(1) }),
            el('button.pager__page', { type: 'button', text: num(2) }),
            el('button.pager__page', { type: 'button', text: num(3) }),
            el('button.pager__page.pager__page--label', { type: 'button', text: t('ar.next') })
          ])
        ])
      ])
    ];
  }

  /* ── 4d Events approval ──────────────────────────────────── */

  function renderEvents() {
    var selected = null;
    work.events.forEach(function (item) { if (item.id === work.eventSelected) selected = item; });
    if (!selected) selected = work.events[0] || null;
    if (selected) work.eventSelected = selected.id;

    return [
      topbar(t('ae.title'), t('ae.sub', { n: num(work.events.length) }), [
        langButton(),
        el('button.abtn.abtn--primary', { type: 'button', onclick: function () { UI.toast(t('ae.add')); }, text: t('ae.add') })
      ]),
      el('div.admin__body', null, [
        el('div.pane-list', { role: 'listbox', 'aria-label': t('ae.title') }, [
          el('div.pane-list__filters', null, [
            chip(t('ae.pending') + ' ' + num(work.events.length), work.eventsTab === 'pending',
              function () { work.eventsTab = 'pending'; render(); }),
            chip(t('ae.live') + ' ' + num(6), work.eventsTab === 'live',
              function () { work.eventsTab = 'live'; render(); })
          ])
        ].concat(work.eventsTab === 'live'
          ? [el('p.queue-item__sub', { style: 'padding:20px', text: t('events.count', { n: num(DATA.EVENTS.length) }) })]
          : (work.events.length
              ? work.events.map(function (item) {
                  return el('button.queue-item', {
                    type: 'button', role: 'option',
                    'aria-selected': item.id === work.eventSelected ? 'true' : 'false',
                    onclick: function () { work.eventSelected = item.id; render(); }
                  }, [
                    el('span.queue-item__title', { text: pick(item.title) }),
                    el('span.queue-item__sub', { text: pick(item.venueShort) + ' · ' + pick(item.when) }),
                    el('span.event__publisher.event__publisher--' + item.publisher, {
                      text: t('publisher.' + item.publisher)
                    })
                  ]);
                })
              : [el('p.queue-item__sub', { style: 'padding:20px', text: t('ae.empty') })]))),
        selected && work.eventsTab === 'pending' ? eventDetail(selected) : el('div.empty-pane', { text: t('ae.empty') })
      ])
    ];
  }

  function eventDetail(item) {
    return el('div.pane-detail', null, [
      el('div.pane-detail__scroll', null, [
        el('div.pane-detail__media', null, [
          el('div.submitted-plate.plate', { style: toneStyle(item.tone) },
            el('span.mono', { text: item.plate })),
          el('div.contributor', { style: 'background:var(--paper)' }, [
            el('span.flagged__label', { text: t('ae.desc') }),
            el('p.detail__story', { text: pick(item.description) })
          ])
        ]),
        el('div.pane-detail__side', null, [
          el('div', null, [
            el('h2.detail__title', { text: pick(item.title) }),
            el('div.detail__gloss.gloss-line', { text: gloss(item.title) })
          ]),
          el('div.detail__fields', null, [
            detailField(t('ae.date'), pick(item.date)),
            detailField(t('ae.time'), pick(item.time)),
            detailField(t('ae.venue'), pick(item.venue)),
            detailField(t('ae.seats'), pick(item.seats)),
            detailField(t('ae.category'), pick(item.category))
          ]),
          el('div.contributor', null, [
            el('div.contributor__row', null, [
              el('div.contributor__avatar', { style: '--p1:#8A9268', text: pick(item.byInitial) }),
              el('div', null, [
                el('div.contributor__name', { text: pick(item.by) }),
                el('div.contributor__meta', { text: pick(item.byMeta) })
              ])
            ])
          ]),
          el('div.review-note', { text: t('ae.note') })
        ])
      ]),
      el('div.decisions', null, [
        el('span.decisions__meta', { text: t('ae.submitted', { a: t('time.ago', { n: num(item.submittedHours) }) }) }),
        el('div.decisions__actions', null, [
          el('button.abtn.abtn--quiet', { type: 'button', onclick: function () { resolveEvent(item, 'rejected'); }, text: t('q.reject') }),
          el('button.abtn.abtn--ghost', { type: 'button', onclick: function () { resolveEvent(item, 'sentBack'); }, text: t('ae.requestEdit') }),
          el('button.abtn.abtn--primary', { type: 'button', onclick: function () { resolveEvent(item, 'approved'); }, text: t('ae.approve') })
        ])
      ])
    ]);
  }

  function resolveEvent(item, outcome) {
    work.events = work.events.filter(function (row) { return row.id !== item.id; });
    work.eventSelected = work.events.length ? work.events[0].id : null;
    render();
    UI.toast(t(outcome === 'approved' ? 'ae.approved' : 'q.' + outcome, { t: pick(item.title) }));
  }

  /* ── 4e Places & map ─────────────────────────────────────── */

  var gazetteer = null;
  var gazetteerMarkers = null;

  function placeCoords(place) {
    return work.placeCoords[place.id] || [place.lat, place.lng];
  }

  function renderPlaces() {
    var selected = DATA.place(work.placeSelected) || DATA.PLACES[0];
    var coords = placeCoords(selected);

    return [
      topbar(t('pl.title'), t('pl.sub', { n: num(64) }), [
        langButton(),
        el('button.abtn.abtn--primary', { type: 'button', onclick: function () { UI.toast(t('pl.add')); }, text: t('pl.add') })
      ]),
      el('div.admin__body', null, [
        el('div.pane-list.pane-list--wide', null, [
          el('div.pane-list__filters', null, [
            el('input.search', { type: 'search', style: 'flex:1;width:auto', placeholder: t('pl.searchPh'), 'aria-label': t('pl.searchPh') }),
            el('button.abtn.abtn--ghost', { type: 'button', style: 'padding:7px 12px', text: t('pl.add') })
          ]),
          el('div.places', { role: 'listbox', 'aria-label': t('pl.title') },
            DATA.PLACES.map(function (place) {
              var pc = placeCoords(place);
              return el('button.place', {
                type: 'button', role: 'option',
                'aria-selected': place.id === work.placeSelected ? 'true' : 'false',
                onclick: function () { work.placeSelected = place.id; render(); }
              }, [
                el('div', { style: 'flex:1;min-width:0' }, [
                  el('div.place__name', { text: pick(place.name) }),
                  el('div.place__coords.gloss-line', {
                    text: gloss(place.name) + ' · ' + pc[0].toFixed(4) + ', ' + pc[1].toFixed(4)
                  })
                ]),
                el('span.place__count', { text: t('pl.count', { n: num(place.memories) }) })
              ]);
            }).concat([
              el('div.merge-prompt', null, [
                el('span', { text: t('pl.merge') }),
                el('button', { type: 'button', onclick: function () { UI.toast(t('pl.merged')); }, text: t('pl.mergeBtn') })
              ])
            ]))
        ]),
        el('div.pane-detail', null, [
          el('div.gazetteer-map', null, [
            el('div', { id: 'gazetteer', style: 'position:absolute;inset:0' }),
            el('div.place-legend', { html: t('pl.legend').replace(/(أصفر|yellow)/, '<b>$1</b>') })
          ]),
          el('div.place-footer', null, [
            el('div', { style: 'display:flex;flex-direction:column;gap:3px' }, [
              el('span.place-footer__name', { text: pick(selected.name) }),
              el('span.place-footer__coords.gloss-line', {
                text: gloss(selected.name) + ' · ' + coords[0].toFixed(4) + ', ' + coords[1].toFixed(4)
              }),
              el('span.place-footer__meta', {
                text: t('pl.oldest', { n: num(selected.memories), y: I18N.year(selected.earliest) })
              })
            ]),
            el('div', { style: 'display:flex;gap:9px;flex-wrap:wrap' }, [
              el('button.abtn.abtn--ghost', { type: 'button', onclick: function () { UI.toast(t('pl.editCoords')); }, text: t('pl.editCoords') }),
              el('a.abtn.abtn--primary', { href: 'index.html#/map', text: t('pl.viewMemories') })
            ])
          ])
        ])
      ])
    ];
  }

  function initGazetteer() {
    var host = qs('#gazetteer');
    if (!host || typeof L === 'undefined') return;
    if (gazetteer) { gazetteer.remove(); gazetteer = null; }

    gazetteer = L.map(host, { zoomControl: true }).setView(RAMALLAH, 14);
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19, attribution: '© OpenStreetMap'
    }).addTo(gazetteer);
    gazetteerMarkers = L.layerGroup().addTo(gazetteer);

    DATA.PLACES.forEach(function (place) {
      var isSelected = place.id === work.placeSelected;
      // Yellow marks a place whose coordinates have never been confirmed.
      var colour = isSelected ? '#C05B3E' : (place.unconfirmed ? '#D9A441' : '#8A9268');
      var size = isSelected ? 20 : 13;
      // NOT ported to CSSOM, deliberately. These style attributes go through Leaflet's
      // divIcon innerHTML and `style-src 'self'` blocks them — but this whole map is
      // already dead under that CSP: Leaflet loads from unpkg and the tiles come from the
      // public OSM endpoint, which CLAUDE.md section 2 forbids outright. Both are listed
      // in config/site.json as known_violations. M4 replaces the map with PMTiles on R2,
      // and this markup goes with it. Styling it now would fix nothing and would be
      // building M4 early.
      var icon = L.divIcon({
        className: '',
        html: '<span style="display:block;width:' + size + 'px;height:' + size +
          'px;border-radius:999px;background:' + colour + ';border:' + (isSelected ? 3 : 2.5) +
          'px solid #F7F4EC;box-shadow:0 2px 6px rgba(38,40,31,.3)"></span>' +
          (isSelected ? '<span class="map-pin__label" style="position:absolute;top:' + (size + 5) +
            'px;left:50%;transform:translateX(-50%)">' + pick(place.name) + ' · ' + num(place.memories) + '</span>' : ''),
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2]
      });
      L.marker(placeCoords(place), { icon: icon, draggable: true, title: pick(place.name) })
        .addTo(gazetteerMarkers)
        .on('click', function () { work.placeSelected = place.id; render(); })
        .on('dragend', function (event) {
          var pos = event.target.getLatLng();
          work.placeCoords[place.id] = [pos.lat, pos.lng];
          work.placeSelected = place.id;
          render();
          UI.toast(t('pl.moved', { t: pick(place.name) }));
        });
    });
  }

  /* ── 4f Members & roles ──────────────────────────────────── */

  function renderMembers() {
    var rows = DATA.MEMBERS.filter(function (m) {
      if (work.memberFilter === 'all') return true;
      if (work.memberFilter === 'suspended') return memberStatus(m) === 'suspended';
      if (work.memberFilter === 'team') return memberRole(m) === 'editor' || memberRole(m) === 'admin';
      if (work.memberFilter === 'partners') return memberRole(m) === 'partner';
      return memberRole(m) === 'contributor' || memberRole(m) === 'narrator';
    });

    var selected = member(work.memberSelected) || rows[0] || DATA.MEMBERS[0];

    var filters = [
      ['all', t('mb.all'), 4810, null],
      ['contributors', t('mb.contributors'), 962, null],
      ['team', t('mb.team'), 6, null],
      ['partners', t('mb.partners'), 4, null],
      ['suspended', t('mb.suspended'), 2, 'chip--alert']
    ];

    return [
      topbar(t('mb.title'), t('mb.sub'), [
        langButton(),
        el('button.abtn.abtn--primary', { type: 'button', onclick: function () { UI.toast(t('mb.invite')); }, text: t('mb.invite') })
      ]),
      el('div.chips', null, filters.map(function (f) {
        return chip(f[1] + ' ' + num(f[2]), work.memberFilter === f[0], function () {
          work.memberFilter = f[0]; render();
        }, f[3]);
      }).concat([
        el('input.search.chip--end', { type: 'search', placeholder: t('mb.searchPh'), 'aria-label': t('mb.searchPh') })
      ])),
      el('div.admin__body', null, [
        el('div.admin__scroll', { style: 'padding:0 26px 22px' }, [
          el('div.table.table--members', { role: 'table' }, [
            el('div.table__row.table__row--head', null, [
              el('span', { text: t('mb.colMember') }),
              el('span', { text: t('mb.colRole') }),
              el('span', { text: t('mb.colContribs') }),
              el('span', { text: t('mb.colCity') }),
              el('span', { text: t('mb.colJoined') }),
              el('span', { text: t('mb.colStatus') })
            ]),
            el('div', null, rows.map(function (m) {
              var status = memberStatus(m);
              return el('div.table__row', {
                onclick: function () { work.memberSelected = m.id; render(); },
                style: 'cursor:pointer'
              }, [
                el('div.member-cell', null, [
                  el('div.member-cell__avatar', { style: '--p1:' + m.tone, text: pick(m.initial) }),
                  el('div', { style: 'min-width:0' }, [
                    el('div.member-cell__name', { text: pick(m.name) }),
                    el('div.member-cell__email.gloss-line', { style: 'direction:ltr', text: m.email })
                  ])
                ]),
                el('span.role-pill.role-pill--' + memberRole(m), { text: roleLabel(memberRole(m), m) }),
                el('span.table__cell', { text: num(m.contributions) }),
                el('span.table__cell', { text: pick(m.city) }),
                el('span.table__num', { text: I18N.year(m.joined) }),
                el('span.status' + (status === 'suspended' ? '.status--suspended' : ''), {
                  text: status === 'suspended' ? t('status.suspended') : t(m.feminine ? 'status.activeF' : 'status.active')
                })
              ]);
            }))
          ])
        ]),
        memberInspector(selected)
      ])
    ];
  }

  function roleLabel(role, m) {
    if (role === 'editor') return t('admin.myRole');
    if (role === 'partner') return t('mb.rolePartner') + (m.partnerOf ? ' — ' + pick(m.partnerOf) : '');
    if (role === 'narrator') return t('mb.roleNarrator');
    if (role === 'admin') return t('mb.roleAdminShort');
    return t(m.feminine ? 'mb.roleContributorF' : 'mb.roleContributorM');
  }

  function memberInspector(m) {
    var role = memberRole(m);
    var suspended = memberStatus(m) === 'suspended';
    var roles = [
      ['contributor', t('mb.roleContributor')],
      ['editor', t('mb.roleEditor')],
      ['admin', t('mb.roleAdmin')]
    ];

    return el('aside.inspector', { 'aria-label': pick(m.name) }, [
      el('div.inspector__head', null, [
        el('div.inspector__avatar', { style: '--p1:' + m.tone, text: pick(m.initial) }),
        el('div', null, [
          el('div.inspector__name', { text: pick(m.name) }),
          el('div.member-cell__email', { style: 'direction:ltr', text: m.email })
        ])
      ]),
      el('div', null, [
        el('span.note-field__label', { text: t('mb.role') }),
        el('div.role-choice', { role: 'radiogroup', 'aria-label': t('mb.role'), style: 'margin-top:7px' },
          roles.map(function (option) {
            var checked = option[0] === role || (role === 'narrator' && option[0] === 'contributor') ||
                          (role === 'partner' && option[0] === 'contributor');
            return el('button.role-option', {
              type: 'button', role: 'radio', 'aria-checked': checked ? 'true' : 'false',
              onclick: function () { work.memberRoles[m.id] = option[0]; render(); }
            }, [
              el('span.role-option__mark'),
              el('span', { text: option[1] })
            ]);
          }))
      ]),
      el('div.factbox', null, [
        el('span', { text: t('mb.factPublished', { a: num(m.contributions), b: num(m.pending) }) }),
        el('span', { text: t('mb.factLast', { a: t('time.ago', { n: num(m.lastActiveHours) }) }) }),
        el('span', { text: t('mb.factClean') })
      ]),
      el('div.inspector__foot', null, [
        el('button.abtn.abtn--primary', {
          type: 'button',
          onclick: function () { UI.toast(t('mb.saved', { t: pick(m.name) })); },
          text: t('mb.save')
        }),
        el('button.abtn.abtn--quiet', {
          type: 'button',
          onclick: function () {
            work.memberStatus[m.id] = suspended ? 'active' : 'suspended';
            render();
            UI.toast(t(suspended ? 'mb.restored' : 'mb.suspended.done', { t: pick(m.name) }));
          },
          text: suspended ? t('mb.restore') : t('mb.suspend')
        })
      ])
    ]);
  }

  /* ── 4g Reports ──────────────────────────────────────────── */

  function renderReports() {
    var selected = null;
    work.reports.forEach(function (r) { if (r.id === work.reportSelected) selected = r; });
    if (!selected) selected = work.reports[0] || null;
    if (selected) work.reportSelected = selected.id;

    return [
      topbar(t('rp.title'), t('rp.sub', { n: num(work.reports.length) }), [langButton()]),
      el('div.admin__body', null, [
        el('div.pane-list', { role: 'listbox', 'aria-label': t('rp.title') }, [
          el('div.pane-list__filters', null, [
            chip(t('rp.open') + ' ' + num(work.reports.length), true, null),
            chip(t('rp.closed') + ' ' + num(31), false, null)
          ])
        ].concat(work.reports.length
          ? work.reports.map(function (report) {
              return el('button.queue-item', {
                type: 'button', role: 'option',
                'aria-selected': report.id === work.reportSelected ? 'true' : 'false',
                onclick: function () { work.reportSelected = report.id; render(); }
              }, [
                el('div.queue-item__row', null, [
                  el('span.queue-item__title', { text: pick(report.subject) }),
                  el('span.sla.sla' + (report.reason === 'false' ? '--soon' : '--warn'),
                    { text: t('reason.' + report.reason) })
                ]),
                el('div.queue-item__sub', {
                  text: t('rp.count', { n: num(report.count) }) + ' · ' + t('time.ago', { n: num(report.reportedHours) })
                })
              ]);
            })
          : [el('p.queue-item__sub', { style: 'padding:20px', text: t('rp.empty') })])
          .concat([el('p.queue-item__sub', { style: 'padding:14px 16px', text: t('rp.avgClose') })])),
        selected ? reportDetail(selected) : el('div.empty-pane', { text: t('rp.empty') })
      ])
    ];
  }

  function reportDetail(report) {
    var msgId = 'rp-msg-' + report.id;

    return el('div.pane-detail', null, [
      el('div.pane-detail__scroll', { style: 'flex-direction:column;gap:16px' }, [
        el('div.report-reason', null, [
          el('span.report-reason__label', { text: t('rp.reason', { r: t('reason.' + report.reason) }) }),
          el('p.report-reason__quote', { text: pick(report.claim) }),
          el('span.report-reason__who', {
            text: t('rp.reportedBy', {
              n: pick(report.reporter),
              a: t('time.ago', { n: num(report.reportedHours) })
            })
          })
        ]),
        el('div.flagged', null, [
          el('span.flagged__label', { text: t('rp.content') }),
          el('div', { style: 'display:flex;gap:12px;align-items:flex-start' }, [
            el('div.contributor__avatar', { style: '--p1:' + report.authorTone, text: pick(report.authorInitial) }),
            el('div', { style: 'flex:1' }, [
              // Composed rather than assembled as an HTML string: the old spelling put a
              // style="…" attribute through innerHTML, which `style-src 'self'` blocks.
              // Building the node means the styling moves to a class and the author's
              // name goes in as text, not markup.
              el('div.contributor__name', null, [
                pick(report.author),
                el('span.contributor__when', { text: ' · ' + pick(report.authorWhen) })
              ]),
              el('p.detail__story', { text: pick(report.content) })
            ])
          ]),
          el('div.flagged__on', null, [
            el('span.flagged__on-thumb', { style: toneStyle(report.onTone) }),
            el('span', { text: t('rp.onMemory', { t: pick(report.onMemory), n: pick(report.author) }) })
          ])
        ]),
        el('div.note-field', null, [
          el('label.note-field__label', { 'for': msgId, text: t('rp.message') }),
          el('textarea', { id: msgId, placeholder: t('rp.messagePh') })
        ]),
        el('div.suggestions', null, [
          chip(t('rp.suggest1'), false, null),
          chip(t('rp.suggest2'), false, null),
          chip(t('rp.suggest3'), false, null)
        ])
      ]),
      el('div.decisions', null, [
        el('span.decisions__meta', { text: t('rp.logged') }),
        el('div.decisions__actions', null, [
          el('button.abtn.abtn--quiet', { type: 'button', onclick: function () { closeReport(report); }, text: t('rp.delete') }),
          el('button.abtn.abtn--ghost', { type: 'button', onclick: function () { closeReport(report); }, text: t('rp.hide') }),
          // The archive's default is to keep the memory and correct the record.
          el('button.abtn.abtn--olive', { type: 'button', onclick: function () { closeReport(report); }, text: t('rp.keep') })
        ])
      ])
    ]);
  }

  function closeReport(report) {
    work.reports = work.reports.filter(function (r) { return r.id !== report.id; });
    work.reportSelected = work.reports.length ? work.reports[0].id : null;
    render();
    UI.toast(t('rp.closedOne'));
  }

  /* ── 4h Settings ─────────────────────────────────────────── */

  function renderSettings() {
    var sections = [
      ['archive', t('st.secArchive')],
      ['review', t('st.secReview')],
      ['langs', t('st.secLangs')],
      ['taxonomy', t('st.secTaxonomy')],
      ['team', t('st.secTeam')],
      ['backup', t('st.secBackup')]
    ];

    return [
      topbar(t('st.title'), t('st.sub'), [langButton()]),
      el('div.admin__body', null, [
        el('div.settings-nav', null, sections.map(function (s) {
          return el('button', {
            type: 'button',
            'aria-current': work.settingsSection === s[0] ? 'true' : 'false',
            onclick: function () { work.settingsSection = s[0]; render(); },
            text: s[1]
          });
        })),
        work.settingsSection === 'review'
          ? reviewSettings()
          : el('div.settings', null, [
              el('h2.settings__title', { text: sectionTitle(sections) }),
              el('p.setting__hint', { text: t('st.sectionSoon') })
            ])
      ])
    ];
  }

  function sectionTitle(sections) {
    for (var i = 0; i < sections.length; i++) if (sections[i][0] === work.settingsSection) return sections[i][1];
    return '';
  }

  function reviewSettings() {
    return el('div.settings', null, [
      el('h2.settings__title', { text: t('st.secReview') }),

      setting(t('st.sla'), t('st.slaHint'),
        el('div.segmented', { role: 'group', 'aria-label': t('st.sla') }, [24, 48, 72].map(function (hours) {
          return el('button', {
            type: 'button',
            'aria-pressed': work.settings.sla === hours ? 'true' : 'false',
            onclick: function () { work.settings.sla = hours; render(); },
            text: t('time.hours', { n: num(hours) })
          });
        }))),

      setting(t('st.warn'), null, toggle('warn', 'st.warnOn', 'st.warnOff')),

      setting(t('st.auto'), t('st.autoHint'), toggle('auto', 'st.autoOn', 'st.autoOff')),

      setting(t('st.reviewers'), null,
        el('select', {
          'aria-label': t('st.reviewers'),
          onchange: function (event) { work.settings.reviewers = Number(event.target.value); }
        }, [
          el('option', { value: '1', selected: work.settings.reviewers === 1 ? true : null, text: t('st.reviewers1') }),
          el('option', { value: '2', selected: work.settings.reviewers === 2 ? true : null, text: t('st.reviewers2') })
        ])),

      setting(t('st.sendBackText'), t('st.sendBackHint'),
        el('textarea', { 'aria-label': t('st.sendBackText'), text: t('st.sendBackDefault') })),

      setting(t('st.comments'), null, toggle('comments', 'st.commentsOn', 'st.commentsOff')),

      el('div.settings__foot', null, [
        el('button.abtn.abtn--primary', {
          type: 'button', onclick: function () { UI.toast(t('st.saved')); }, text: t('st.save')
        }),
        el('span.settings__saved', { text: t('st.lastEdit') })
      ])
    ]);
  }

  function setting(name, hint, control) {
    return el('div.setting', null, [
      el('div.setting__key', null, [
        el('div.setting__name', { text: name }),
        hint ? el('div.setting__hint', { text: hint }) : null
      ]),
      el('div.setting__control', null, control)
    ]);
  }

  function toggle(key, onLabel, offLabel) {
    var on = work.settings[key];
    return el('div.switch-row', null, [
      el('button.switch', {
        type: 'button', role: 'switch', 'aria-checked': on ? 'true' : 'false',
        'aria-label': on ? t(onLabel) : t(offLabel),
        onclick: function () { work.settings[key] = !work.settings[key]; render(); }
      }),
      el('span.switch-row__text', { text: on ? t(onLabel) : t(offLabel) })
    ]);
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
    settings: renderSettings
  };

  function render() {
    var name = section();
    if (gazetteer && name !== 'places') { gazetteer.remove(); gazetteer = null; }
    renderRail();
    mount(qs('#main'), VIEWS[name]());
    if (name === 'places') initGazetteer();
  }

  global.addEventListener('hashchange', render);
  global.addEventListener('langchange', render);

  render();
})(window);
