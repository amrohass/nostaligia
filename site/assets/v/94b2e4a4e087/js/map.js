/* The map. Canvas, vector tiles, and our own labels.

   §10's M4: "PostGIS-backed geo; decade slider filtering; place-name autocomplete →
   gazetteer resolution → drag-to-confirm pin fallback; PMTiles basemap on R2; tile-failure
   fallback to list view." This file is the basemap and the pin. The slider, the autocomplete
   and the list are public.js's, and the list is also what happens when anything here fails.

   ── Loaded on demand ─────────────────────────────────────────

   Not in the shell's script list. public.js injects a tag for it the first time somebody
   opens /map or drops a pin, exactly as admin-boot.js does for the dashboard — §9's budget
   covers "HTML + CSS + JS + first feed page", and a reader who never opens the map should
   not pay for a tile decoder. scripts/frontend-budget.mjs measures the shell, so this stays
   outside the figure by construction rather than by an exemption written into the script.

   ── Why a canvas and not SVG or a library ────────────────────

   §2 voids MapLibre and forbids the public OSM tile endpoint; §9 forbids a build step. What
   is left is the platform. One canvas, one draw call per feature class, and a redraw on
   interaction — a Palestine extract at city zoom is a few thousand paths, which a
   mid-range Android draws in a frame. SVG would put those thousands of paths in the DOM and
   ask the browser to lay them out.

   ── Nothing here reads a colour ──────────────────────────────

   §9: "Reuse tokens.css. Never hardcode a color." A canvas cannot resolve var(--map-water),
   so the palette is read once from the computed style of the document element and passed to
   the draw. Adding a colour means adding a token, not editing this file. */

(function (global) {
  'use strict';

  var doc = global.document;
  var PMTILES = global.PMTILES;
  var MVT = global.MVT;

  /** Web Mercator, normalised so the whole world is 0..1 on both axes. */
  function project(lat, lon) {
    var s = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
    return {
      x: (lon + 180) / 360,
      y: 0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)
    };
  }

  function unproject(x, y) {
    var n = Math.PI - 2 * Math.PI * y;
    return {
      lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))),
      lon: x * 360 - 180
    };
  }

  function clamp(value, lo, hi) { return Math.min(Math.max(value, lo), hi); }

  /* ── The style ─────────────────────────────────────────────
   *
   * Ordered, and the order is the paint order: earth under water under roads under
   * buildings. Layer names are the Protomaps basemap schema's; a layer an extract does not
   * have simply draws nothing, which is why an archive built from a different schema
   * degrades to a blank-but-working map rather than an exception.
   *
   * `width` is in CSS pixels and takes the fractional zoom, because a road that is 1px at
   * z14 and 1px at z17 reads as a city that has stopped growing as you zoom into it.
   */
  var STYLE = [
    { layer: 'earth', kind: 'fill', token: '--map-earth' },
    { layer: 'landuse', kind: 'fill', token: '--map-landuse' },
    { layer: 'water', kind: 'fill', token: '--map-water' },
    {
      layer: 'buildings', kind: 'fill', token: '--map-building', minZoom: 15
    },
    {
      layer: 'roads', kind: 'line', token: '--map-road',
      width: function (z) { return Math.max(0.6, (z - 12) * 0.5); }
    },
    {
      // The same layer twice: the major roads are drawn again, thicker, over the rest, so
      // the shape of the city reads at a glance. `match` is what picks them out.
      layer: 'roads', kind: 'line', token: '--map-road-major',
      match: { key: 'kind', values: ['highway', 'major_road'] },
      width: function (z) { return Math.max(1.2, (z - 11) * 0.8); }
    },
    {
      layer: 'boundaries', kind: 'line', token: '--map-boundary',
      width: function () { return 1; }, dash: [4, 3]
    }
  ];

  /* ── The names the extract already carries ──────────────────
   *
   * Added 31 Aug 2026, and it REVERSES a decision rather than filling a gap, so the reason
   * belongs here and not only in a commit message.
   *
   * mvt.js's header used to say this map renders no text from tile data, because "a basemap
   * extract carries whatever names its renderer baked in, usually Latin". That is true of a
   * RASTER extract and false of this one — which is the same argument §2 makes for choosing
   * vector, followed one step further than it was followed at the time. A vector tile
   * carries name attributes, plural and per language, and the deployed Palestine extract
   * carries `name:ar` throughout. Measured over Al-Manara at z14: 146 of 163 roads named,
   * 125 of 126 POIs, every place — in Arabic, from OpenStreetMap contributors who live here.
   *
   * So the old rule produced the opposite of what it wanted. `places.json` holds THREE rows
   * — a floor a moderator typed for the pin and the autocomplete, and no more than that —
   * and a map of Ramallah with three labels on it reads as a city nobody has named.
   *
   * The gazetteer does not lose anything: it is drawn FIRST and wins every collision, so a
   * name a moderator confirmed always beats the extract's for the same spot.
   *
   * Ordered, and the order is the priority — an earlier rule claims its space first.
   *
   * `minZoom` is the VIEW zoom, and it must be at or below `view.maxZoom` or the rule never
   * fires — not later, never, in complete silence. The first draft of this table put POIs and
   * minor roads at 16 when the view stopped at 15, and they simply did not exist: no error
   * anywhere, and a map that read as deliberately sparse. The ceiling is the archive's own
   * maxZoom plus create()'s three levels of overzoom — 18 for the Palestine extract — and the
   * test pins it as a literal so it cannot drift out from under this table unnoticed.
   */
  var LABELS = [
    {
      layer: 'places', kind: 'point', minZoom: 9, token: '--map-label',
      match: { key: 'kind', values: ['country', 'region', 'locality', 'city', 'town'] },
      size: 13, weight: '700'
    },
    {
      layer: 'places', kind: 'point', minZoom: 13, token: '--map-label',
      match: { key: 'kind', values: ['neighbourhood', 'suburb', 'quarter', 'village', 'hamlet'] },
      size: 11.5, weight: '600'
    },
    {
      // The streets that carry the shape of the city, from the zoom their geometry thickens.
      layer: 'roads', kind: 'line', minZoom: 14, token: '--map-label-minor',
      match: { key: 'kind', values: ['highway', 'major_road'] },
      size: 11, weight: '600'
    },
    {
      // Everything else with a name on it. `exclude` rather than a second `match` list: the
      // rule above has already drawn the majors, and without this every one of them would be
      // a second candidate competing with its own label.
      layer: 'roads', kind: 'line', minZoom: 16, token: '--map-label-minor',
      exclude: { key: 'kind', values: ['highway', 'major_road'] },
      size: 10.5, weight: '500'
    },
    {
      /* Landmarks, at street zoom.
       *
       * The `match` list is the whole point of this rule and is not a performance measure.
       * Nine z15 tiles over the centre carry 1,600 named POIs, and the largest kinds are
       * restaurant (167), supermarket (137), cafe (69), pharmacy (64) and bank (50) — draw
       * them all and Ramallah becomes a business directory that is out of date the year it
       * ships. What is listed below is what a person navigates a city by and what a heritage
       * archive is actually about: worship, schooling, medicine, government, transport,
       * parks, cemeteries, monuments and the camp. A shop is not a landmark.
       */
      layer: 'pois', kind: 'point', minZoom: 16, token: '--map-label-minor',
      match: {
        key: 'kind',
        values: [
          'place_of_worship', 'monastery', 'religious',
          'hospital', 'clinic',
          'school', 'secondary', 'college', 'university', 'kindergarten',
          'library', 'museum', 'gallery', 'arts_centre', 'theatre',
          'townhall', 'police', 'fire_station', 'post_office', 'military',
          'bus_station', 'marketplace', 'refugee_camp',
          'park', 'garden', 'playground', 'sports_centre', 'stadium', 'pitch',
          'cemetery', 'memorial', 'monument', 'artwork', 'attraction', 'viewpoint',
          'spring', 'fountain'
        ]
      },
      size: 10.5, weight: '500'
    }
  ];

  /** Every layer either table touches — what mvt.js is asked to decode, and nothing else. */
  var WANTED = STYLE.concat(LABELS).map(function (rule) { return rule.layer; })
    .filter(function (name, i, all) { return all.indexOf(name) === i; });

  /* At most this many labels in a frame, whatever the zoom asks for. The collision test is
     O(n) per candidate against everything already placed, so an uncapped dense z16 view is
     quadratic in the one place §10 measures — a mid-range Android. */
  var LABEL_BUDGET = 140;

  /* The type stack per language. Same two values as --font-ar / --font-en in tokens.css;
     a canvas takes a font string, not a var(). The glyphs are whatever the device has —
     there is no atlas and no font fetched from anywhere, which is what keeps this inside a
     CSP whose font-src is 'self'. */
  var FAMILY = {
    ar: "'IBM Plex Sans Arabic', system-ui, sans-serif",
    en: "'Inter', system-ui, sans-serif"
  };

  /**
   * Bidi controls — U+202A–202E and U+2066–2069 — stripped exactly as §6 strips them on
   * ingest. This is third-party text drawn straight onto a canvas, and an override left in
   * it reverses a label.
   *
   * A code-point loop rather than a regex literal, deliberately: a character class holding
   * these is a pair of INVISIBLE characters in the source, which nobody can review and no
   * diff can show. This repository has already lost an afternoon to a mechanical rewrite
   * over characters that did not appear on the screen.
   */
  function stripBidi(text) {
    var out = '';
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if ((c >= 0x202A && c <= 0x202E) || (c >= 0x2066 && c <= 0x2069)) continue;
      out += text.charAt(i);
    }
    return out;
  }

  /** Hebrew, U+0590–U+05FF. The one script a default `name` may not fall back to — see
      labelText. Written the same way and for the same reason as stripBidi. */
  function hasHebrew(text) {
    for (var i = 0; i < text.length; i++) {
      var c = text.charCodeAt(i);
      if (c >= 0x0590 && c <= 0x05FF) return true;
    }
    return false;
  }

  function docLang() { return doc.documentElement.lang === 'en' ? 'en' : 'ar'; }

  /**
   * What to write on a feature, in the language the page is in.
   *
   * `name:ar` / `name:en` first, then the feature's own default `name` — which in this
   * extract is the local name and is usually already the Arabic one.
   *
   * The one exclusion: a default `name` in HEBREW script is never used. It is not a
   * translation of the Arabic, it is a different name for the same point, and an
   * Arabic-first archive of Ramallah that quietly labels its map in Hebrew wherever a
   * settlement carries no `name:ar` would be doing something nobody asked it for. Where that
   * happens the feature keeps its geometry and gets no label — which is already what happens
   * to the 17 roads in a central tile that carry no name at all. It is one line to reverse
   * if that judgement is wrong, and it is deliberately not silent about being a judgement.
   */
  function labelText(feature, lang) {
    var text = MVT.attribute(feature, lang === 'ar' ? 'name:ar' : 'name:en');
    if (!text) {
      var plain = MVT.attribute(feature, 'name');
      if (plain && !hasHebrew(plain)) text = plain;
    }
    if (typeof text !== 'string') return null;
    text = stripBidi(text).trim();
    return text ? text : null;
  }

  /* How far a run of segments may turn and still count as one straight stretch: cos 30°.
     Tighter and a gently curved street never gets a name at all; looser and the text lies
     across a bend instead of along the road. */
  var STRAIGHT = 0.866;

  /** A point feature's coordinate, in tile space. */
  function pointAnchor(feature) {
    var ring = feature.rings[0];
    if (!ring || ring.length < 2) return null;
    return { tx: ring[0], ty: ring[1], dx: 0, dy: 0, span: 0 };
  }

  /**
   * The longest straight RUN of a line, which is where its name goes.
   *
   * Not the centroid: a road's centroid can sit off the road entirely wherever it bends, and
   * a street name floating in the block beside its street is worse than no street name. A run
   * is always ON the line, and its chord is the angle to set the text at.
   *
   * Runs, and deliberately not the longest single SEGMENT, which is what this measured first
   * and which put almost no names on the map. OSM geometry is densely noded — a straight
   * street is a couple of dozen collinear segments, not one — so the longest segment of a real
   * street is short, and every one of them then failed drawLabels' "is there room for this
   * name" test. The symptom was a city with three street names on it, and nothing about it
   * looked like a measurement problem.
   */
  function lineAnchor(feature) {
    var best = null;
    var bestLen = 0;

    /** One finished run, from where it started to where it ended. */
    function consider(x0, y0, x1, y1) {
      var dx = x1 - x0;
      var dy = y1 - y0;
      // The chord, not the distance walked: a run that curves has less straight room for text
      // than its arc length claims, and overstating that is how a label ends up sticking out
      // past both ends of the street it names.
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len <= bestLen) return;
      bestLen = len;
      best = { tx: (x0 + x1) / 2, ty: (y0 + y1) / 2, dx: dx, dy: dy, span: len };
    }

    for (var r = 0; r < feature.rings.length; r++) {
      var ring = feature.rings[r];
      var ax = 0, ay = 0;      // where the current run started
      var px = 0, py = 0;      // the last vertex it reached
      var rdx = 0, rdy = 0;    // the direction it set out in
      var open = false;

      for (var i = 0; i + 3 < ring.length; i += 2) {
        var dx = ring[i + 2] - ring[i];
        var dy = ring[i + 3] - ring[i + 1];
        var len = Math.sqrt(dx * dx + dy * dy);
        if (!len) continue;

        var turned = open &&
          (rdx * dx + rdy * dy) / (Math.sqrt(rdx * rdx + rdy * rdy) * len) < STRAIGHT;

        if (!open || turned) {
          if (open) consider(ax, ay, px, py);
          ax = ring[i]; ay = ring[i + 1];
          rdx = dx; rdy = dy;
          open = true;
        }
        px = ring[i + 2]; py = ring[i + 3];
      }
      if (open) consider(ax, ay, px, py);
    }
    return best;
  }

  /**
   * Every colour the map uses, read from tokens.css once.
   *
   * Keyed by the token name, so a style rule names `--map-water` and the draw looks it up —
   * there is no second table mapping tokens to fields, which is the thing that goes stale
   * when a token is added. The fallbacks are only for a document with no stylesheet at all,
   * which in practice means a test.
   */
  function palette() {
    var css = global.getComputedStyle(doc.documentElement);
    var defaults = {
      '--map-canvas': '#EEF1E6',
      '--map-earth': '#E8E4D8',
      '--map-landuse': '#E2E7D6',
      '--map-water': '#C9D8DA',
      '--map-building': '#DCD7C7',
      '--map-road': '#FBF8EF',
      '--map-road-major': '#FFFFFF',
      '--map-boundary': '#8A9268',
      '--map-label': '#26281F',
      '--map-label-minor': '#4C5142',
      '--map-label-halo': '#F7F4EC',
      '--map-pin': '#C05B3E',
      '--map-pin-ink': '#F7F4EC'
    };
    var out = {};
    Object.keys(defaults).forEach(function (name) {
      var value = css.getPropertyValue(name);
      out[name] = value && value.trim() ? value.trim() : defaults[name];
    });
    return out;
  }

  /* ── One map ───────────────────────────────────────────────── */

  /**
   * options
   *   url         the .pmtiles archive
   *   center      {lat, lon} — where to open
   *   zoom        initial zoom
   *   mode        'browse' (markers, selectable) or 'pick' (one draggable pin)
   *   onSelect    fn(item) — a marker was activated
   *   onPin       fn({lat, lon}) — the pin moved, in 'pick' mode
   *   onFail      fn(err) — the basemap could not be drawn; the caller falls back to a list
   */
  function create(container, options) {
    options = options || {};

    var canvas = doc.createElement('canvas');
    canvas.className = 'mapview__canvas';
    // role=application, because arrow keys pan rather than scroll and a screen reader must
    // hand them over. The LIST beside it is the accessible equivalent and is always
    // rendered — a canvas is not an alternative to that, it is a convenience on top of it.
    canvas.setAttribute('role', 'application');
    canvas.setAttribute('tabindex', '0');
    if (options.label) canvas.setAttribute('aria-label', options.label);
    container.appendChild(canvas);

    var ctx = canvas.getContext('2d');
    var colors = palette();
    var archive = PMTILES.archive(options.url);

    var view = {
      center: project((options.center && options.center.lat) || 31.9038,
                      (options.center && options.center.lon) || 35.2034),
      zoom: options.zoom || 14,
      minZoom: 8,
      maxZoom: 18,
      // The deepest zoom the archive itself has tiles for; everything above it is overzoom.
      // fit() stops here — see the note there.
      archiveMaxZoom: 18,
      width: 0,
      height: 0,
      dpr: 1
    };

    var items = [];        // located archive entries: {id, lat, lon, ...}
    var places = [];       // gazetteer labels: {name_ar, name_en, lat, lon}
    var pin = options.pin || null;
    var markers = [];      // screen positions, rebuilt each draw, used for hit testing
    var tiles = {};        // key -> {layers} | 'pending' | 'empty'
    var order = [];        // tile keys, oldest first — the cache eviction order
    var labelCache = {};   // key -> {lang, list} — one tile's labels, in TILE space
    var TILE_CACHE = 64;
    var frame = null;
    var dead = false;
    var failed = false;

    /* ── Geometry of the view ───────────────────────────────── */

    function worldSize() { return 256 * Math.pow(2, view.zoom); }

    function toScreen(lat, lon) {
      var p = project(lat, lon);
      var size = worldSize();
      return {
        x: (p.x - view.center.x) * size + view.width / 2,
        y: (p.y - view.center.y) * size + view.height / 2
      };
    }

    function toLatLon(px, py) {
      var size = worldSize();
      return unproject(
        view.center.x + (px - view.width / 2) / size,
        view.center.y + (py - view.height / 2) / size
      );
    }

    function resize() {
      var rect = container.getBoundingClientRect();
      // Capped at 2: a 3x phone panel costs 2.25 times the fill rate of a 2x one and is
      // indistinguishable at arm's length. This is the single biggest lever on §10's
      // "usable on a mid-range Android".
      view.dpr = Math.min(global.devicePixelRatio || 1, 2);
      view.width = Math.max(1, Math.round(rect.width));
      view.height = Math.max(1, Math.round(rect.height));
      canvas.width = Math.round(view.width * view.dpr);
      canvas.height = Math.round(view.height * view.dpr);
      canvas.style.setProperty('width', view.width + 'px');
      canvas.style.setProperty('height', view.height + 'px');
      schedule();
    }

    /* ── Tiles ──────────────────────────────────────────────── */

    function tileZoom(header) {
      return clamp(Math.round(view.zoom), header.minZoom, header.maxZoom);
    }

    function remember(key, value) {
      if (!(key in tiles)) order.push(key);
      tiles[key] = value;
      while (order.length > TILE_CACHE) {
        var oldest = order.shift();
        if (tiles[oldest] === 'pending') {
          // Moved to the back rather than dropped. Dropping it would leave the entry in
          // `tiles` and out of `order` — never evicted, and never re-added when it
          // resolved, because remember() only pushes a key it has not seen. A slow leak of
          // whole decoded tiles, on the device least able to afford it.
          order.push(oldest);
          break;
        }
        delete tiles[oldest];
        delete labelCache[oldest];
      }
    }

    function requestTile(z, x, y) {
      var key = z + '/' + x + '/' + y;
      if (key in tiles) return tiles[key];
      remember(key, 'pending');

      archive.tile(z, x, y).then(function (bytes) {
        if (dead) return;
        remember(key, bytes ? MVT.decodeTile(bytes, WANTED) : 'empty');
        schedule();
      }, function (err) {
        if (dead) return;
        // A single missing tile is not a failure — an extract holds nothing outside its
        // bounding box and a vector tile with no features is simply absent. What IS a
        // failure is the archive being unreadable at all, and that surfaces from ready()
        // below, once, rather than from every tile in the viewport.
        remember(key, 'empty');
        if (err && (err.key === 'map.err.compression' || err.key === 'map.err.version')) fail(err);
      });
      return 'pending';
    }

    /* ── Drawing ────────────────────────────────────────────── */

    function drawTile(layers, z, x, y) {
      var size = worldSize();
      var n = Math.pow(2, z);
      var originX = (x / n - view.center.x) * size + view.width / 2;
      var originY = (y / n - view.center.y) * size + view.height / 2;

      for (var s = 0; s < STYLE.length; s++) {
        var rule = STYLE[s];
        if (rule.minZoom && view.zoom < rule.minZoom) continue;
        var layer = layers[rule.layer];
        if (!layer || !layer.features.length) continue;

        var scale = size / (n * layer.extent);
        ctx.beginPath();
        var drew = false;

        for (var f = 0; f < layer.features.length; f++) {
          var feature = layer.features[f];
          if (!feature.rings) continue;
          if (rule.match) {
            var value = MVT.attribute(feature, rule.match.key);
            if (rule.match.values.indexOf(value) === -1) continue;
          }
          if (rule.kind === 'fill' && feature.type !== MVT.GEOM.POLYGON) continue;
          if (rule.kind === 'line' && feature.type === MVT.GEOM.POINT) continue;

          for (var r = 0; r < feature.rings.length; r++) {
            var ring = feature.rings[r];
            if (ring.length < 4) continue;
            ctx.moveTo(originX + ring[0] * scale, originY + ring[1] * scale);
            for (var i = 2; i < ring.length; i += 2) {
              ctx.lineTo(originX + ring[i] * scale, originY + ring[i + 1] * scale);
            }
            drew = true;
          }
        }
        if (!drew) continue;

        if (rule.kind === 'fill') {
          ctx.fillStyle = colors[rule.token];
          // nonzero, not evenodd: MVT polygon winding encodes holes, and evenodd would
          // punch a courtyard out of every building that has one and fill every one that
          // does not.
          ctx.fill('nonzero');
        } else {
          ctx.strokeStyle = colors[rule.token];
          ctx.lineWidth = rule.width ? rule.width(view.zoom) : 1;
          ctx.lineJoin = 'round';
          ctx.lineCap = 'round';
          ctx.setLineDash(rule.dash || []);
          ctx.stroke();
          ctx.setLineDash([]);
        }
      }
    }

    /**
     * One tile's label candidates, in TILE space, decoded once and kept.
     *
     * Once, and not once per frame: MVT.attribute is a linear scan of a feature's tag list,
     * a z15 tile over the centre carries about five hundred named features, and repeating
     * that for every tile on every pan frame is the difference between a map that moves and
     * one that stutters — on the mid-range Android §10 names as M4's exit criterion.
     *
     * What legitimately changes per frame is where these land on the screen, and that is
     * arithmetic (collectLabels). What changes rarely is the language, which is why the
     * cached entry carries the `lang` it was built for rather than trusting a cache clear
     * to happen somewhere else.
     */
    function tileLabels(layers, key) {
      var lang = docLang();
      var cached = labelCache[key];
      if (cached && cached.lang === lang) return cached;

      var list = [];
      for (var r = 0; r < LABELS.length; r++) {
        var rule = LABELS[r];
        var layer = layers[rule.layer];
        if (!layer || !layer.features.length) continue;

        for (var f = 0; f < layer.features.length; f++) {
          var feature = layer.features[f];
          if (!feature.rings || !feature.rings.length) continue;
          if (rule.match) {
            var kind = MVT.attribute(feature, rule.match.key);
            if (rule.match.values.indexOf(kind) === -1) continue;
          }
          if (rule.exclude) {
            var not = MVT.attribute(feature, rule.exclude.key);
            if (rule.exclude.values.indexOf(not) > -1) continue;
          }
          var anchor = rule.kind === 'line' ? lineAnchor(feature) : pointAnchor(feature);
          if (!anchor) continue;
          var text = labelText(feature, lang);
          if (!text) continue;

          anchor.rule = r;
          anchor.text = text;
          anchor.extent = layer.extent;
          list.push(anchor);
        }
      }

      cached = { lang: lang, list: list };
      labelCache[key] = cached;
      return cached;
    }

    /** The screen position of one tile's candidates, appended to `out`. */
    function collectLabels(layers, key, z, x, y, out) {
      var size = worldSize();
      var n = Math.pow(2, z);
      var originX = (x / n - view.center.x) * size + view.width / 2;
      var originY = (y / n - view.center.y) * size + view.height / 2;
      var list = tileLabels(layers, key).list;

      for (var i = 0; i < list.length; i++) {
        var cand = list[i];
        if (view.zoom < LABELS[cand.rule].minZoom) continue;

        var scale = size / (n * cand.extent);
        var sx = originX + cand.tx * scale;
        var sy = originY + cand.ty * scale;
        if (sx < -80 || sy < -20 || sx > view.width + 80 || sy > view.height + 20) continue;

        var angle = 0;
        if (cand.span) {
          angle = Math.atan2(cand.dy, cand.dx);
          // Upright. A line at 170° and one at -10° are the same line, and only one of the
          // two readings of it is text a person can read.
          if (angle > Math.PI / 2) angle -= Math.PI;
          else if (angle < -Math.PI / 2) angle += Math.PI;
        }

        out.push({
          rule: cand.rule, text: cand.text,
          x: sx, y: sy, angle: angle, span: cand.span * scale
        });
      }
    }

    /**
     * Labels, with a box test so two do not land on top of each other.
     *
     * Drawn with the browser's own text engine, which means Arabic is shaped and joined
     * correctly and mixed strings get the bidi algorithm for free — the reason mvt.js
     * decodes name STRINGS and stops there rather than growing a glyph atlas and a shaper.
     * `direction` is set from the document so a label sits the right way round in either
     * language.
     *
     * Two passes, and the order is the whole policy: the archive's own gazetteer first, so a
     * name a moderator confirmed claims its space before the extract offers another for the
     * same spot, then the extract's own names in LABELS order.
     */
    function drawLabels(candidates) {
      var taken = [];
      var seen = {};
      var drawn = 0;
      var lang = docLang();

      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.direction = lang === 'ar' ? 'rtl' : 'ltr';

      /** One label, if there is room for it and nothing by this name is on screen already. */
      function place(text, x, y, angle, size, ink) {
        if (drawn >= LABEL_BUDGET) return;
        // By NAME, across the whole frame: a road runs through four tiles and a POI sits in
        // the buffer of its neighbour, so the same string arrives several times per draw.
        // Dropping repeats is also what stops a single street being labelled six times.
        if (seen[text]) return;
        if (x < -80 || y < -20 || x > view.width + 80 || y > view.height + 20) return;

        var w = ctx.measureText(text).width;
        var h = size + 4;
        var cos = Math.abs(Math.cos(angle));
        var sin = Math.abs(Math.sin(angle));
        // The axis-aligned box around a rotated one. Cheap, slightly generous, and generous
        // in the right direction — it spaces rotated street names apart rather than letting
        // them touch.
        var hw = (w / 2) * cos + (h / 2) * sin + 3;
        var hh = (w / 2) * sin + (h / 2) * cos + 2;
        var box = { x1: x - hw, y1: y - hh, x2: x + hw, y2: y + hh };

        for (var t = 0; t < taken.length; t++) {
          var other = taken[t];
          if (box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1) return;
        }
        taken.push(box);
        seen[text] = true;
        drawn++;

        if (angle) { ctx.save(); ctx.translate(x, y); ctx.rotate(angle); }
        var px = angle ? 0 : x;
        var py = angle ? 0 : y;
        // A halo rather than a plate: a filled rectangle behind every label turns a map of a
        // dense city into a wall of boxes.
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors['--map-label-halo'];
        ctx.strokeText(text, px, py);
        ctx.fillStyle = ink;
        ctx.fillText(text, px, py);
        if (angle) ctx.restore();
      }

      ctx.font = '600 12px ' + FAMILY[lang];
      for (var i = 0; i < places.length; i++) {
        var gazetteer = places[i];
        var name = lang === 'ar'
          ? (gazetteer.name_ar || gazetteer.name_en)
          : (gazetteer.name_en || gazetteer.name_ar);
        if (!name) continue;
        var at = toScreen(gazetteer.lat, gazetteer.lon);
        place(name, at.x, at.y, 0, 12, colors['--map-label']);
      }

      if (!candidates || !candidates.length) return;

      // Grouped by rule rather than walked once: setting ctx.font invalidates the text
      // measurement cache, and the alternative is doing it per label.
      for (var r = 0; r < LABELS.length && drawn < LABEL_BUDGET; r++) {
        var rule = LABELS[r];
        if (view.zoom < rule.minZoom) continue;
        ctx.font = rule.weight + ' ' + rule.size + 'px ' + FAMILY[lang];
        var ink = colors[rule.token];

        for (var c = 0; c < candidates.length; c++) {
          var cand = candidates[c];
          if (cand.rule !== r) continue;
          // A name wider than the road it names is not a label, it is a line of text lying
          // across the city. Points have no span and are never held to this.
          if (cand.span && cand.span < ctx.measureText(cand.text).width) continue;
          place(cand.text, cand.x, cand.y, cand.angle, rule.size, ink);
          if (drawn >= LABEL_BUDGET) break;
        }
      }
    }

    function drawMarkers() {
      markers = [];
      for (var i = 0; i < items.length; i++) {
        var item = items[i];
        if (typeof item.lat !== 'number' || typeof item.lon !== 'number') continue;
        var at = toScreen(item.lat, item.lon);
        if (at.x < -20 || at.y < -20 || at.x > view.width + 20 || at.y > view.height + 20) continue;

        markers.push({ x: at.x, y: at.y, item: item });

        ctx.beginPath();
        ctx.arc(at.x, at.y, 7, 0, Math.PI * 2);
        ctx.fillStyle = colors['--map-pin'];
        ctx.fill();
        ctx.lineWidth = 2;
        ctx.strokeStyle = colors['--map-pin-ink'];
        ctx.stroke();
      }
    }

    function drawPin() {
      if (!pin) return;
      var at = toScreen(pin.lat, pin.lon);
      // A teardrop, drawn as two arcs and a point, so it reads as "this exact spot" rather
      // than as another item marker.
      ctx.beginPath();
      ctx.arc(at.x, at.y - 14, 9, Math.PI, 0);
      ctx.lineTo(at.x, at.y);
      ctx.closePath();
      ctx.fillStyle = colors['--map-pin'];
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = colors['--map-pin-ink'];
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(at.x, at.y - 14, 3.2, 0, Math.PI * 2);
      ctx.fillStyle = colors['--map-pin-ink'];
      ctx.fill();
    }

    /* The header, once it has landed. Held rather than awaited per frame: draw() runs on
       every pan, and a promise callback there would push the whole basemap one microtask
       behind the markers drawn on top of it. Until it arrives the map paints its background
       and whatever overlay it has, which is what an opening map looks like anyway. */
    var headerCache = null;

    function draw() {
      frame = null;
      if (dead || !view.width) return;

      ctx.setTransform(view.dpr, 0, 0, view.dpr, 0, 0);
      ctx.fillStyle = colors['--map-canvas'];
      ctx.fillRect(0, 0, view.width, view.height);

      // Gathered across every tile and drawn in one pass afterwards, because collision is a
      // property of the SCREEN: a per-tile pass would let a name at the edge of one tile land
      // on top of a name at the edge of the next.
      var labels = [];

      if (headerCache) {
        var z = tileZoom(headerCache);
        var n = Math.pow(2, z);
        var size = worldSize();

        // The tile range under the viewport, with one tile of margin so a pan does not
        // reveal a blank edge before the fetch lands.
        var left = view.center.x - (view.width / 2) / size;
        var top = view.center.y - (view.height / 2) / size;
        var right = view.center.x + (view.width / 2) / size;
        var bottom = view.center.y + (view.height / 2) / size;

        var x0 = Math.max(0, Math.floor(left * n) - 1);
        var x1 = Math.min(n - 1, Math.floor(right * n) + 1);
        var y0 = Math.max(0, Math.floor(top * n) - 1);
        var y1 = Math.min(n - 1, Math.floor(bottom * n) + 1);

        for (var x = x0; x <= x1; x++) {
          for (var y = y0; y <= y1; y++) {
            var got = requestTile(z, x, y);
            if (got && got !== 'pending' && got !== 'empty') {
              drawTile(got, z, x, y);
              collectLabels(got, z + '/' + x + '/' + y, z, x, y, labels);
            }
          }
        }
      }

      drawLabels(labels);
      drawMarkers();
      drawPin();
    }

    function schedule() {
      if (frame || dead) return;
      frame = global.requestAnimationFrame(draw);
    }

    function fail(err) {
      if (failed || dead) return;
      failed = true;
      if (options.onFail) options.onFail(err);
    }

    /* ── Interaction ────────────────────────────────────────── */

    var pointers = {};
    var dragging = null;      // 'map' | 'pin'
    var last = null;
    var pinchStart = null;
    var moved = 0;
    /* Whether this gesture was ever a pinch. `moved` cannot answer that: the two-pointer
       branch returns before touching it, so a pinch-zoom ends with moved at 0 and would
       read as a clean tap — which in 'pick' mode moves the pin to wherever the last finger
       happened to be. */
    var pinched = false;

    function localPoint(event) {
      var rect = canvas.getBoundingClientRect();
      return { x: event.clientX - rect.left, y: event.clientY - rect.top };
    }

    function nearPin(at) {
      if (!pin) return false;
      var p = toScreen(pin.lat, pin.lon);
      return Math.abs(at.x - p.x) < 18 && at.y - p.y < 6 && at.y - p.y > -30;
    }

    canvas.addEventListener('pointerdown', function (event) {
      canvas.setPointerCapture(event.pointerId);
      pointers[event.pointerId] = localPoint(event);
      moved = 0;

      var ids = Object.keys(pointers);
      if (ids.length === 1) pinched = false;
      if (ids.length === 2) {
        pinchStart = {
          distance: pointerDistance(ids),
          zoom: view.zoom
        };
        pinched = true;
        dragging = null;
        return;
      }
      last = pointers[event.pointerId];
      dragging = options.mode === 'pick' && nearPin(last) ? 'pin' : 'map';
    });

    function pointerDistance(ids) {
      var a = pointers[ids[0]];
      var b = pointers[ids[1]];
      return Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));
    }

    canvas.addEventListener('pointermove', function (event) {
      if (!(event.pointerId in pointers)) return;
      var at = localPoint(event);
      pointers[event.pointerId] = at;

      var ids = Object.keys(pointers);
      if (ids.length === 2 && pinchStart) {
        var ratio = pointerDistance(ids) / pinchStart.distance;
        view.zoom = clamp(pinchStart.zoom + Math.log2(ratio), view.minZoom, view.maxZoom);
        schedule();
        return;
      }
      if (!dragging || !last) return;

      var dx = at.x - last.x;
      var dy = at.y - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      last = at;

      if (dragging === 'pin') {
        // +14 because the pin's point sits below the finger, at the tip of the teardrop:
        // dragging it by the head and dropping it by the point is what makes it land where
        // it looks like it lands.
        var next = toLatLon(at.x, at.y + 14);
        pin = { lat: next.lat, lon: next.lon };
        if (options.onPin) options.onPin(pin);
      } else {
        var size = worldSize();
        view.center.x -= dx / size;
        view.center.y = clamp(view.center.y - dy / size, 0, 1);
      }
      schedule();
    });

    function endPointer(event) {
      delete pointers[event.pointerId];
      var left = Object.keys(pointers);
      if (left.length < 2) pinchStart = null;
      if (left.length === 1) {
        // One finger of a pinch lifted. Without this the remaining finger controls nothing
        // until it is lifted too — `dragging` was cleared when the pinch began — so the map
        // goes dead under a hand that is still on it.
        last = pointers[left[0]];
        dragging = 'map';
      }
      if (left.length === 0) {
        // A tap, not a drag. The threshold is in CSS pixels and generous, because a finger
        // moves a few of them on every tap and a map that answers only perfectly still taps
        // feels broken rather than precise.
        if (moved < 8 && !pinched) tap(localPoint(event));
        pinched = false;
        dragging = null;
        last = null;
      }
    }

    canvas.addEventListener('pointerup', endPointer);
    canvas.addEventListener('pointercancel', endPointer);

    function tap(at) {
      if (options.mode === 'pick') {
        var where = toLatLon(at.x, at.y);
        pin = { lat: where.lat, lon: where.lon };
        if (options.onPin) options.onPin(pin);
        schedule();
        return;
      }
      var best = null;
      var bestDistance = 22;
      for (var i = 0; i < markers.length; i++) {
        var distance = Math.hypot(markers[i].x - at.x, markers[i].y - at.y);
        if (distance < bestDistance) { bestDistance = distance; best = markers[i]; }
      }
      if (best && options.onSelect) options.onSelect(best.item);
    }

    canvas.addEventListener('wheel', function (event) {
      event.preventDefault();
      var at = localPoint(event);
      var before = toLatLon(at.x, at.y);
      // deltaMode 1 is lines, 2 is pages. Treating all three as pixels makes a trackpad and
      // a mouse wheel differ by a factor of forty.
      var step = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 400 : event.deltaY;
      view.zoom = clamp(view.zoom - step / 260, view.minZoom, view.maxZoom);
      // Keep the point under the cursor still, which is what makes wheel zoom feel like
      // zooming rather than like scrolling.
      var after = toScreen(before.lat, before.lon);
      var size = worldSize();
      view.center.x += (after.x - at.x) / size;
      view.center.y = clamp(view.center.y + (after.y - at.y) / size, 0, 1);
      schedule();
    }, { passive: false });

    canvas.addEventListener('keydown', function (event) {
      var size = worldSize();
      var step = 60 / size;
      var handled = true;
      // ArrowLeft moves the view left on the screen in both languages. Direction-flipping
      // arrow keys on a map is a well-meant RTL instinct that makes it unusable — the
      // arrows refer to the picture, not to the text.
      if (event.key === 'ArrowLeft') view.center.x -= step;
      else if (event.key === 'ArrowRight') view.center.x += step;
      else if (event.key === 'ArrowUp') view.center.y = clamp(view.center.y - step, 0, 1);
      else if (event.key === 'ArrowDown') view.center.y = clamp(view.center.y + step, 0, 1);
      else if (event.key === '+' || event.key === '=') view.zoom = clamp(view.zoom + 0.5, view.minZoom, view.maxZoom);
      else if (event.key === '-' || event.key === '_') view.zoom = clamp(view.zoom - 0.5, view.minZoom, view.maxZoom);
      else handled = false;
      if (handled) { event.preventDefault(); schedule(); }
    });

    var observer = null;
    if (typeof global.ResizeObserver === 'function') {
      observer = new global.ResizeObserver(resize);
      observer.observe(container);
    } else {
      global.addEventListener('resize', resize);
    }

    resize();

    /* The one promise the caller waits on. It resolves when the archive's header and root
       directory are readable — which is the difference between "this map has no tiles here"
       and "this is not a map", and therefore the difference between an empty city and §10's
       fallback to the list view. */
    var ready = archive.header().then(function (header) {
      headerCache = header;
      view.minZoom = Math.max(header.minZoom, 4);
      /* Three levels past the deepest zoom the archive was built to — OVERZOOM, which is a
         thing a vector archive can do and a raster one cannot: tileZoom() already clamps the
         tile it asks for, so beyond the archive's own maximum the same tile is drawn larger
         rather than a new one fetched. Geometry scales; it does not blur.
         Before this the view stopped dead at the header's maxZoom, which for the Palestine
         extract is 15 — and a z15 view at 992px is nearly four kilometres across, a scale at
         which no street name has room to be written and every POI in the city arrives at
         once. Both of M4's label problems were this one line. Three and not more because
         overzoom is free in bytes and not in honesty: at some point the map is claiming a
         precision the extract never had. */
      view.maxZoom = Math.max(header.maxZoom + 3, view.minZoom);
      view.archiveMaxZoom = Math.max(header.maxZoom, view.minZoom);
      view.zoom = clamp(view.zoom, view.minZoom, view.maxZoom);
      schedule();
      return header;
    });
    ready.catch(fail);

    return {
      ready: ready,
      canvas: canvas,

      setItems: function (next) { items = next || []; schedule(); },
      setPlaces: function (next) { places = next || []; schedule(); },
      setPin: function (next) { pin = next; schedule(); },
      getPin: function () { return pin; },

      /** Centres on a point without changing the zoom — used when a search resolves. */
      panTo: function (lat, lon, zoom) {
        view.center = project(lat, lon);
        if (zoom) view.zoom = clamp(zoom, view.minZoom, view.maxZoom);
        schedule();
      },

      /** Frames a set of points, which is how the map opens on the archive it actually has. */
      fit: function (points) {
        var usable = (points || []).filter(function (p) {
          return typeof p.lat === 'number' && typeof p.lon === 'number';
        });
        if (!usable.length) return;
        var minLat = 90, maxLat = -90, minLon = 180, maxLon = -180;
        usable.forEach(function (p) {
          minLat = Math.min(minLat, p.lat); maxLat = Math.max(maxLat, p.lat);
          minLon = Math.min(minLon, p.lon); maxLon = Math.max(maxLon, p.lon);
        });
        view.center = project((minLat + maxLat) / 2, (minLon + maxLon) / 2);

        var a = project(minLat, minLon);
        var b = project(maxLat, maxLon);
        var spanX = Math.abs(b.x - a.x) || 1e-6;
        var spanY = Math.abs(b.y - a.y) || 1e-6;
        // 0.8 leaves a margin, so the outermost item is not against the frame.
        var fitZoom = Math.log2(Math.min(view.width / (256 * spanX), view.height / (256 * spanY)) * 0.8);
        /* Stops at the archive's own maxZoom rather than at view.maxZoom, so the OPENING view
           never lands inside the overzoom range. Four items a few streets apart otherwise
           frame to z18 and the map opens on one block with no neighbourhood, no city and no
           context — the reader is somewhere in Ramallah without being told where. A reader
           who wants that close can zoom; a map should not start there. */
        view.zoom = clamp(fitZoom, view.minZoom, Math.min(view.maxZoom, view.archiveMaxZoom));
        schedule();
      },

      destroy: function () {
        dead = true;
        if (frame) global.cancelAnimationFrame(frame);
        if (observer) observer.disconnect();
        else global.removeEventListener('resize', resize);
        if (canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
  }

  global.MAP = {
    create: create,
    project: project,
    unproject: unproject,
    STYLE: STYLE,
    LABELS: LABELS,
    WANTED: WANTED,
    // For the tests, which check the naming rule without standing up a canvas.
    labelText: labelText,
    lineAnchor: lineAnchor
  };
})(window);
