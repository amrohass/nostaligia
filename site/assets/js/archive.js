/* The read path. §2, from the browser's side.

       manifest.json  ->  /v/{ts}/  ->  feed/page-N.json · item/{id}.json
                                        decade/{d}.json · geo/{cell}.json
                                        profile/{handle}.json · content.json
       redactions.json (short TTL, filtered against everything above)

   ── Zero database reads ─────────────────────────────────────

   §2: "Static sharded JSON releases on CDN. Zero database reads for public visitors."
   Nothing in this file touches PostgREST, carries a token, or knows the anon key exists.
   A signed-out visitor browsing the whole archive makes requests to exactly one origin —
   `CONFIG.archiveBase` — and every one of them is a cacheable GET.

   That is not only a cost decision. §7 calls the aggregate of identity, history and
   timestamps the de-anonymisation vector; a read path with no queries in it has no query
   log, so there is nothing to correlate even for whoever runs the database.

   ── Everything here is immutable except two files ───────────

   The release directory is content-addressed by timestamp and served `max-age=31536000,
   immutable`, so a shard is cached in the browser and never revalidated. `manifest.json`
   and `redactions.json` are the two short-TTL files, and they are the only two this module
   ever re-fetches. `no-store` is set on both rather than trusted to the header, because a
   takedown must not be defeated by an intermediary that ignored `must-revalidate`.

   ── Redactions are a filter, not a lookup ───────────────────

   §8: "add the ID to the short-TTL redactions.json that clients filter against". A client
   holding a year-old cached release must not render a card for something that is gone —
   so every list this module hands out is filtered on the way out, and item() answers null
   for a redacted id rather than the shard it still has. The bytes are already deleted; this
   is what stops the card. */

(function (global) {
  'use strict';

  /* Where the archive lives. Empty string means same origin — see read_path in
     config/site.json. Nothing else in the front end knows this. */
  var BASE = global.CONFIG.archiveBase;

  /* Media is CDN-fronted whatever the shards do: §6 keeps `public/` on the CDN and
     `originals/` off it, and that split does not move when the release tree does. */
  var MEDIA = global.CONFIG.origins.cdn;

  var state = {
    release: null,        // '/v/2026-08-19T12:34:56Z/'
    generatedOn: null,    // 'YYYY-MM-DD', day precision (§7)
    redacted: null,       // Object used as a set; null until the first fetch
    ready: null,          // in-flight or settled ready() promise
    shards: {},           // path -> in-flight or settled fetch promise
    blocks: null,         // content.json, once loaded
    index: null,          // index.json, once loaded
    places: null          // places.json, once loaded
  };

  function ArchiveError(key, detail) {
    var e = new Error(key);
    e.key = key;
    e.detail = detail || null;
    return e;
  }

  /* One GET, with the failure modes named.

     A network failure and a 404 are different things to a visitor and must not share a
     message: the first is "you are offline", the second is "this item is not in the
     archive". Collapsing them is how a reader gets told the archive is broken because
     their train went into a tunnel. */
  function getJson(url, options) {
    options = options || {};
    return global.fetch(url, { cache: options.fresh ? 'no-store' : 'default' })
      .then(function (res) {
        if (res.status === 404) throw ArchiveError('archive.err.missing', url);
        if (!res.ok) throw ArchiveError('archive.err.generic', res.status);
        return res.json().catch(function () { throw ArchiveError('archive.err.generic', 'malformed json'); });
      }, function () {
        throw ArchiveError('archive.err.offline', url);
      });
  }

  /** Release-relative shard, fetched once per page load and then held. */
  function shard(rel) {
    if (!state.release) return Promise.reject(ArchiveError('archive.err.notReady'));
    var key = state.release + rel;
    if (!state.shards[key]) {
      state.shards[key] = getJson(BASE + key).catch(function (err) {
        // Not cached: a shard that failed because the visitor was offline must be
        // retryable, and a promise held in this map would refuse forever.
        delete state.shards[key];
        throw err;
      });
    }
    return state.shards[key];
  }

  function fetchRedactions() {
    return getJson(BASE + '/redactions.json', { fresh: true }).then(function (body) {
      var map = {};
      (body && body.ids ? body.ids : []).forEach(function (id) { map[id] = true; });
      state.redacted = map;
      return map;
    }, function () {
      /* A redaction list that could not be fetched is the one failure this module does not
         propagate, and the reasoning is worth stating: the alternative is a blank archive
         every time the file 404s, which it does before the first publish. What it does NOT
         do is treat the failure as "nothing is redacted" on a list it once had — the
         previous list is kept, so a takedown already known stays applied. */
      if (!state.redacted) state.redacted = {};
      return state.redacted;
    });
  }

  /**
   * Resolve the pointer, and with it the redaction list.
   *
   * Memoised: every view calls this and there must be exactly one manifest fetch per page
   * load. reload() is how a caller asks for a newer release.
   */
  function ready() {
    if (!state.ready) {
      state.ready = getJson(BASE + '/manifest.json', { fresh: true }).then(function (body) {
        var release = body && typeof body.release === 'string' ? body.release : '';
        // The shape releases_path_shape enforces on the database side. Checked here too,
        // because everything below concatenates onto it — a manifest naming `../` or an
        // absolute URL would point the whole read path somewhere else.
        if (!/^\/v\/[0-9A-Za-z:.-]+\/$/.test(release)) {
          throw ArchiveError('archive.err.unpublished', body);
        }
        state.release = release;
        state.generatedOn = body.generated_on || null;
        return fetchRedactions().then(function () {
          return { release: release, generatedOn: state.generatedOn };
        });
      }).catch(function (err) {
        // Same reasoning as shard(): a failed pointer fetch must be retryable, or a visitor
        // who opened the page in a tunnel never sees the archive without a reload.
        state.ready = null;
        throw err;
      });
    }
    return state.ready;
  }

  /** Drops the memo so the next ready() re-reads the pointer. Cheap: shards are immutable
      and keyed by release, so anything unchanged is still cached under the same key. */
  function reload() {
    state.ready = null;
    // Both are per-RELEASE, not per-session: content.json and index.json live inside
    // /v/{ts}/ like every other shard. Keeping them across a pointer flip would leave the
    // page describing one release with another release's copy — the one stale-cache bug
    // that would look like an editing mistake rather than a caching one.
    state.blocks = null;
    state.index = null;
    state.places = null;
    return ready();
  }

  function isRedacted(id) {
    return Boolean(state.redacted && state.redacted[id]);
  }

  function keep(items) {
    return (items || []).filter(function (row) { return row && !isRedacted(row.id); });
  }

  /* ── The shards ──────────────────────────────────────────── */

  /** feed/page-N.json. `total` is the published figure and is NOT adjusted for redactions:
      it is what the release says, and a count that quietly disagreed with the release would
      make a paging bug indistinguishable from a takedown. */
  function feedPage(n) {
    return ready().then(function () {
      return shard('feed/page-' + Math.max(1, n | 0) + '.json');
    }).then(function (body) {
      return {
        page: body.page,
        pages: body.pages,
        total: body.total,
        items: keep(body.items)
      };
    });
  }

  /** item/{id}.json — or null when the archive does not have it, or no longer may. */
  function item(id) {
    return ready().then(function () {
      if (isRedacted(id)) return null;
      return shard('item/' + encodeURIComponent(id) + '.json').then(function (body) {
        return body;
      }, function (err) {
        if (err && err.key === 'archive.err.missing') return null;
        throw err;
      });
    });
  }

  function decade(d) {
    return ready().then(function () {
      return shard('decade/' + encodeURIComponent(d) + '.json');
    }).then(function (body) {
      return { decade: body.decade, total: body.total, items: keep(body.items) };
    }, function (err) {
      // A decade with nothing in it has no shard. That is not an error — it is an empty
      // decade, and the slider must be able to land on one.
      if (err && err.key === 'archive.err.missing') return { decade: d, total: 0, items: [] };
      throw err;
    });
  }

  function geo(cell) {
    return ready().then(function () {
      return shard('geo/' + encodeURIComponent(cell) + '.json');
    }).then(function (body) {
      return { cell: body.cell, total: body.total, items: keep(body.items) };
    }, function (err) {
      if (err && err.key === 'archive.err.missing') return { cell: cell, total: 0, items: [] };
      throw err;
    });
  }

  /**
   * profile/{handle}.json — the PUBLIC projection of a profile, as §7 permits it.
   *
   * The owner's own view is not here and must not be: a shard is one file served to
   * everyone, so anything it carries is public by construction. Private fields come from
   * profile_view() with the owner's own token; see profile.js.
   */
  function profile(handle) {
    return ready().then(function () {
      return shard('profile/' + encodeURIComponent(String(handle).toLowerCase()) + '.json');
    }).then(function (body) {
      return {
        handle: body.handle,
        display_name: body.display_name,
        avatar_path: body.avatar_path,
        label: body.label,
        bio: body.bio,
        member_since: body.member_since,
        contributions: keep(body.contributions),
        comments: (body.comments || []).filter(function (c) { return !isRedacted(c.post_id); })
      };
    }, function (err) {
      if (err && err.key === 'archive.err.missing') return null;
      throw err;
    });
  }

  /**
   * places.json — every name M4's map draws.
   *
   * The basemap is vector geometry with its label layers deliberately not rendered (see
   * mvt.js), so this file is the map's entire text: gazetteer entries a moderator typed, in
   * both languages, published like every other shard. A release built before the gazetteer
   * existed has none, and an empty map is the correct rendering of that.
   */
  function places() {
    if (state.places) return Promise.resolve(state.places);
    return ready()
      .then(function () { return shard('places.json'); })
      .then(function (body) {
        // NOT filtered through keep(). §8's redaction list is post ids; a gazetteer entry
        // is not a contribution and cannot be taken down. Running it through anyway would
        // read as though it could be, which is worse than the two lines it saves.
        state.places = body.items || [];
        return state.places;
      }, function (err) {
        if (err && err.key === 'archive.err.missing') { state.places = []; return state.places; }
        throw err;
      });
  }

  /**
   * index.json — what this release contains.
   *
   * How many feed pages, which decades hold items, which geo cells exist. Without it the
   * front end has to carry a hardcoded decade list and a hardcoded geohash cell, both of
   * which are correct today and silently wrong the first time somebody contributes a 1940s
   * photograph. The publisher derives this from the files it just built, so it cannot
   * describe a release it did not produce.
   *
   * A release built before index.json existed simply has none; the empty shape below lets
   * the caller fall back to DATA.DECADES rather than render nothing.
   */
  function index() {
    if (state.index) return Promise.resolve(state.index);
    return ready()
      .then(function () { return shard('index.json'); })
      .then(function (body) {
        state.index = {
          pages: body.pages || 1,
          total: body.total || 0,
          decades: body.decades || [],
          cells: body.cells || []
        };
        return state.index;
      }, function (err) {
        if (err && err.key === 'archive.err.missing') {
          state.index = { pages: 1, total: 0, decades: [], cells: [] };
          return state.index;
        }
        throw err;
      });
  }

  /* ── Editorial copy ──────────────────────────────────────── */

  /**
   * content.json, the published half of `content_blocks`.
   *
   * §9: "All content comes from the store, never hardcoded in views." The dashboard writes
   * content_blocks, the publisher bakes the published column into the release, and this is
   * where a view reads it. Nothing between the editor and the page is a literal in a JS
   * file.
   */
  function content() {
    if (state.blocks) return Promise.resolve(state.blocks);
    return ready()
      .then(function () { return shard('content.json'); })
      .then(function (body) {
        state.blocks = body && body.blocks ? body.blocks : {};
        return state.blocks;
      }, function (err) {
        // A release built before content blocks existed has no such shard. An empty map
        // renders the key rather than crashing the page, which is the same failure mode
        // I18N.t already has for a missing string.
        if (err && err.key === 'archive.err.missing') { state.blocks = {}; return state.blocks; }
        throw err;
      });
  }

  /** One block, in both languages, as a {ar, en} pair. Synchronous — call after content(). */
  function block(key) {
    var row = state.blocks ? state.blocks[key] : null;
    return row ? { ar: row.ar || '', en: row.en || '' } : { ar: '', en: '' };
  }

  /**
   * The info page's sections, in order.
   *
   * The order is itself a content block (`page.order`, a comma-separated list of slugs), so
   * adding or reordering a section is an edit in the dashboard rather than a deploy. A slug
   * naming no title is skipped rather than rendered empty — an editor mid-edit should not
   * publish a blank heading.
   */
  function pages() {
    var order = block('page.order');
    var slugs = String(order.ar || order.en || '')
      .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
    return slugs.map(function (slug) {
      return {
        slug: slug,
        title: block('page.' + slug + '.title'),
        body: block('page.' + slug + '.body')
      };
    }).filter(function (section) { return section.title.ar || section.title.en; });
  }

  /* ── Media ───────────────────────────────────────────────── */

  /**
   * The CDN URL for a storage_path a shard named.
   *
   * Every path in a shard is already `public/` — shards.ts drops `originals` rows before
   * they are ever written, so there is no bucket to check here and nothing to get wrong.
   * DB.mediaUrl is the other half of this rule and DOES check, because it is handed rows
   * straight out of the database where both buckets are represented.
   */
  function mediaUrl(path) {
    if (typeof path !== 'string' || !path) return null;
    return MEDIA + '/' + path;
  }

  /** The best rendition for this viewport, from a shard's media list. §6's ladder rule:
      "default to 1080p on desktop, 720p on mobile … never auto-serve the top rung to a
      phone." Connection-aware stepping is M6's; the viewport half is free and is here. */
  var LADDER = ['480p', '720p', '1080p', '1440p'];
  function rendition(media, wide) {
    var want = wide ? '1080p' : '720p';
    var have = {};
    (media || []).forEach(function (m) {
      if (m.role === 'rendition' && m.rendition) have[m.rendition] = m;
    });
    if (have[want]) return have[want];
    // Step DOWN first, never up: serving 1440p to a phone because 720p is missing is the
    // exact thing §6 forbids.
    for (var i = LADDER.indexOf(want) - 1; i >= 0; i--) if (have[LADDER[i]]) return have[LADDER[i]];
    for (var j = LADDER.indexOf(want) + 1; j < LADDER.length; j++) if (have[LADDER[j]]) return have[LADDER[j]];
    return null;
  }

  function role(media, name) {
    var found = null;
    (media || []).forEach(function (m) { if (!found && m.role === name) found = m; });
    return found;
  }

  global.ARCHIVE = {
    ready: ready,
    reload: reload,
    refreshRedactions: fetchRedactions,
    isRedacted: isRedacted,
    index: index,
    places: places,
    /* The cached index, or null. A synchronous reader for the one caller that needs the
       decade list mid-render and cannot await — reaching into _state for it would make a
       view depend on this module's internals, which is what _state exists NOT to be. */
    indexNow: function () { return state.index; },
    feedPage: feedPage,
    item: item,
    decade: decade,
    geo: geo,
    profile: profile,
    content: content,
    block: block,
    pages: pages,
    mediaUrl: mediaUrl,
    rendition: rendition,
    role: role,
    get release() { return state.release; },
    get generatedOn() { return state.generatedOn; },

    /* Tests reach in here; views must not. Exposed so scripts/frontend-archive-test.mjs can
       assert the redaction filter without a second implementation of it. */
    _state: state
  };
})(window);
