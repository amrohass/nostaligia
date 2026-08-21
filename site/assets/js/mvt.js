/* Mapbox Vector Tile, decoded far enough to draw it.

   A PMTiles tile body is a protocol-buffer message: layers, each holding features, each
   holding a geometry encoded as a little stack machine over zig-zag varints. This file turns
   those bytes into arrays of numbers. It draws nothing and knows no colours.

   ── Why geometry only ────────────────────────────────────────

   The map renders NO text from tile data. Every label on the screen comes from the archive's
   own gazetteer — places.json, written by the publisher from rows a moderator typed in both
   languages (§9: "All content comes from the store"). That is what makes an Arabic-first map
   possible: a basemap extract carries whatever names its renderer baked in, usually Latin,
   and no amount of styling turns them into Arabic.

   It also removes most of the work. Label rendering from vector tiles means glyph atlases,
   collision detection across tile boundaries, and a shaping engine — which for Arabic means
   a shaping engine that is CORRECT, since a naive one renders disconnected letterforms that
   read as broken to anyone who can read them. Drawing our own labels with the browser's own
   text engine gets correct shaping for free.

   So `attributes` here is a lookup, not a materialised object per feature: the styles need
   one or two keys on the roads layer and nothing anywhere else, and building a props object
   for every building in Ramallah would be the largest allocation in the frame.

   ── Coordinates ──────────────────────────────────────────────

   Feature coordinates are in TILE space — 0..extent, where extent is almost always 4096 —
   with y increasing downward. Values outside that range are legal and common: a road that
   continues past the tile edge is encoded with a buffer around it, and clipping is the
   renderer's business.

   ── The reference, deliberately not a URL ────────────────────

   The format is Mapbox's vector-tile-spec 2.1, at github.com/mapbox/vector-tile-spec. The
   scheme is missing on purpose: scripts/frontend-csp-test.mjs ratchets every `https://…` in
   the served tree as a third-party origin, and it scans raw text rather than parsing out
   comments — so a spec link in a header would be reported as a new dependency this page
   fetches. It fetches nothing. Do not "fix" this by adding the scheme. */

(function (global) {
  'use strict';

  var GEOM = { POINT: 1, LINE: 2, POLYGON: 3 };

  /* ── Protobuf, the four wire types that appear here ────────── */

  function Reader(buf, start, end) {
    this.buf = buf;
    this.p = start == null ? 0 : start;
    this.end = end == null ? buf.length : end;
  }

  Reader.prototype.varint = function () {
    var result = 0, shift = 1, b;
    do {
      if (this.p >= this.end) throw new Error('mvt: truncated varint');
      b = this.buf[this.p++];
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return result;
  };

  /** Zig-zag: the encoding that keeps small negative numbers small. */
  Reader.prototype.svarint = function () {
    var value = this.varint();
    return (value % 2) === 1 ? -(value + 1) / 2 : value / 2;
  };

  Reader.prototype.string = function (length) {
    var bytes = this.buf.subarray(this.p, this.p + length);
    this.p += length;
    // TextDecoder rather than fromCharCode: layer names are ASCII but attribute values are
    // not, and a byte-per-character read turns any UTF-8 string into mojibake.
    return new global.TextDecoder('utf-8').decode(bytes);
  };

  /** Advances past a field this decoder does not care about. */
  Reader.prototype.skip = function (wire) {
    if (wire === 0) { this.varint(); return; }
    if (wire === 1) { this.p += 8; return; }
    if (wire === 2) { this.p += this.varint(); return; }
    if (wire === 5) { this.p += 4; return; }
    throw new Error('mvt: wire type ' + wire);
  };

  /* ── Geometry ──────────────────────────────────────────────── */

  /**
   * The command stack, decoded into flat rings.
   *
   *   MoveTo(1)     starts a new ring / places a point
   *   LineTo(2)     extends the current one
   *   ClosePath(7)  closes a polygon ring, carrying no parameters
   *
   * A ring is a flat array [x0, y0, x1, y1, …] rather than an array of point objects. At a
   * few thousand vertices per tile the object-per-point version is the difference between a
   * frame and a stutter on the mid-range Android §10 names as M4's exit criterion.
   */
  function geometry(reader, end) {
    var rings = [];
    var current = null;
    var x = 0, y = 0;

    while (reader.p < end) {
      var command = reader.varint();
      var id = command & 0x7;
      var count = command >> 3;

      if (id === 7) {                       // ClosePath
        if (current && current.length >= 2) {
          // Explicitly closed here rather than left to the renderer's closePath(), so a ring
          // is a complete polygon whatever draws it — the hit-testing and the bounds pass
          // both read these arrays without a canvas in sight.
          current.push(current[0], current[1]);
        }
        continue;
      }

      for (var i = 0; i < count; i++) {
        x += reader.svarint();
        y += reader.svarint();
        if (id === 1) {                     // MoveTo — a new ring
          current = [x, y];
          rings.push(current);
        } else if (current) {               // LineTo
          current.push(x, y);
        }
      }
    }
    return rings;
  }

  /* ── Layers ────────────────────────────────────────────────── */

  function decodeValue(reader, end) {
    var value = null;
    while (reader.p < end) {
      var tag = reader.varint();
      var field = tag >> 3;
      var wire = tag & 0x7;
      if (field === 1 && wire === 2) value = reader.string(reader.varint());
      else if (field === 4 || field === 5) value = reader.varint();
      else if (field === 6) value = reader.svarint();
      else if (field === 7) value = reader.varint() === 1;
      else reader.skip(wire);
    }
    return value;
  }

  function decodeFeature(reader, end, layer) {
    var feature = { type: 0, rings: null, tags: null };
    while (reader.p < end) {
      var tag = reader.varint();
      var field = tag >> 3;
      var wire = tag & 0x7;

      if (field === 3) feature.type = reader.varint();
      else if (field === 2 && wire === 2) {
        var tagEnd = reader.p + reader.varint();
        var tags = [];
        while (reader.p < tagEnd) tags.push(reader.varint());
        feature.tags = tags;
      } else if (field === 4 && wire === 2) {
        var geomEnd = reader.p + reader.varint();
        feature.rings = geometry(reader, geomEnd);
        reader.p = geomEnd;
      } else reader.skip(wire);
    }
    feature.layer = layer;
    return feature;
  }

  function decodeLayer(reader, end) {
    var layer = { name: '', extent: 4096, features: [], keys: [], values: [] };
    var featureRanges = [];

    while (reader.p < end) {
      var tag = reader.varint();
      var field = tag >> 3;
      var wire = tag & 0x7;

      if (field === 1 && wire === 2) layer.name = reader.string(reader.varint());
      else if (field === 5) layer.extent = reader.varint();
      else if (field === 3 && wire === 2) layer.keys.push(reader.string(reader.varint()));
      else if (field === 4 && wire === 2) {
        var valueEnd = reader.p + reader.varint();
        layer.values.push(decodeValue(reader, valueEnd));
        reader.p = valueEnd;
      } else if (field === 2 && wire === 2) {
        // Deferred: the layer's name arrives in this same message and the caller decides by
        // NAME whether the features are wanted at all. Decoding first and asking afterwards
        // would decode every building in a tile the style never draws.
        var featureEnd = reader.p + reader.varint();
        featureRanges.push([reader.p, featureEnd]);
        reader.p = featureEnd;
      } else reader.skip(wire);
    }

    layer.decodeFeatures = function () {
      for (var i = 0; i < featureRanges.length; i++) {
        var span = featureRanges[i];
        layer.features.push(decodeFeature(new Reader(reader.buf, span[0], span[1]), span[1], layer));
      }
      return layer.features;
    };
    return layer;
  }

  /**
   * One tile.
   *
   * `wanted` names the layers to decode features for. Everything else is parsed only far
   * enough to find its end — the layer names still come back, so a caller can see what an
   * archive holds without paying for it.
   */
  function decodeTile(bytes, wanted) {
    var reader = new Reader(bytes);
    var layers = {};

    while (reader.p < reader.end) {
      var tag = reader.varint();
      var field = tag >> 3;
      var wire = tag & 0x7;
      if (field === 3 && wire === 2) {
        var end = reader.p + reader.varint();
        var layer = decodeLayer(new Reader(bytes, reader.p, end), end);
        if (!wanted || wanted.indexOf(layer.name) > -1) layer.decodeFeatures();
        layers[layer.name] = layer;
        reader.p = end;
      } else reader.skip(wire);
    }
    return layers;
  }

  /** One attribute of one feature, or null. See the header for why this is not an object. */
  function attribute(feature, key) {
    var tags = feature.tags;
    var keys = feature.layer.keys;
    if (!tags) return null;
    for (var i = 0; i + 1 < tags.length; i += 2) {
      if (keys[tags[i]] === key) return feature.layer.values[tags[i + 1]];
    }
    return null;
  }

  global.MVT = {
    decodeTile: decodeTile,
    attribute: attribute,
    GEOM: GEOM,
    // For the tests, which encode a tile by hand and read it back.
    Reader: Reader
  };
})(window);
