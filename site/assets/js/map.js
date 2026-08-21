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

  /** Every layer the style touches — what mvt.js is asked to decode, and nothing else. */
  var WANTED = STYLE.map(function (rule) { return rule.layer; })
    .filter(function (name, i, all) { return all.indexOf(name) === i; });

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
     * Labels, with a box test so two do not land on top of each other.
     *
     * Ours, not the tile's — see mvt.js's header. Drawn with the browser's own text engine,
     * which means Arabic is shaped and joined correctly and mixed strings get the bidi
     * algorithm for free. `direction` is set from the document so a label sits the right way
     * round in either language.
     */
    function drawLabels() {
      var taken = [];
      var lang = doc.documentElement.lang === 'en' ? 'en' : 'ar';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.font = '600 12px ' + (lang === 'ar'
        ? "'IBM Plex Sans Arabic', system-ui, sans-serif"
        : "'Inter', system-ui, sans-serif");
      ctx.direction = lang === 'ar' ? 'rtl' : 'ltr';

      for (var i = 0; i < places.length; i++) {
        var place = places[i];
        var name = lang === 'ar'
          ? (place.name_ar || place.name_en)
          : (place.name_en || place.name_ar);
        if (!name) continue;

        var at = toScreen(place.lat, place.lon);
        if (at.x < -80 || at.y < -20 || at.x > view.width + 80 || at.y > view.height + 20) continue;

        var half = ctx.measureText(name).width / 2 + 4;
        var box = { x1: at.x - half, y1: at.y - 9, x2: at.x + half, y2: at.y + 9 };
        var collides = false;
        for (var t = 0; t < taken.length; t++) {
          var other = taken[t];
          if (box.x1 < other.x2 && box.x2 > other.x1 && box.y1 < other.y2 && box.y2 > other.y1) {
            collides = true;
            break;
          }
        }
        if (collides) continue;
        taken.push(box);

        // A halo rather than a plate: a filled rectangle behind every label turns a map of a
        // dense city into a wall of boxes.
        ctx.lineWidth = 3;
        ctx.strokeStyle = colors['--map-label-halo'];
        ctx.strokeText(name, at.x, at.y);
        ctx.fillStyle = colors['--map-label'];
        ctx.fillText(name, at.x, at.y);
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
            if (got && got !== 'pending' && got !== 'empty') drawTile(got, z, x, y);
          }
        }
      }

      drawLabels();
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
      view.maxZoom = Math.max(header.maxZoom, view.minZoom);
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
        view.zoom = clamp(fitZoom, view.minZoom, view.maxZoom);
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
    WANTED: WANTED
  };
})(window);
