/* PMTiles v3, read over HTTP range requests.

   §2 fixes the basemap: "PMTiles (Palestine extract) on R2. NEVER the public OSM tile
   endpoint." A PMTiles archive is ONE object — header, directories and every tile in a
   single file — and a client reads the parts it needs with Range requests. That is what
   makes it the right shape for this project: one object in the `public` bucket, served by
   the same CDN as the shards, at $0 egress, with no tile server to run and nothing to rate
   limit.

   ── Why this file exists rather than a dependency ────────────

   §9 allows no build step, and §2 voids MapLibre. The official pmtiles npm package is an ES
   module distribution that assumes a bundler; vendoring its build output would put ~40 KB of
   someone else's minified code in a repository whose whole posture is that every line is
   readable. What this project actually needs is the read path — header, directory, one tile
   — which is what is below. Writing archives, deduplication, the ETag-aware caching layer
   and the protocol adapters are all the parts we do not use.

   ── What it does NOT do ──────────────────────────────────────

   Decompress brotli or zstd. The spec allows both for the internal directories and for the
   tile bodies, and a browser can decompress neither — DecompressionStream does gzip and
   deflate only. An archive built with either raises `map.err.compression`, which map.js
   turns into §10's stated fallback to the list view rather than a blank canvas. Build the
   extract with the default gzip and this never comes up.

   ── The 2^53 line ───────────────────────────────────────────

   Varints are decoded into ordinary numbers, so offsets and tile ids are exact up to
   2^53 — about 9 petabytes of archive and every tile id below zoom 26. A planet-scale
   archive would need BigInt here. A Palestine extract is a few megabytes. */

(function (global) {
  'use strict';

  /** The fixed header, in bytes. Every offset below is relative to the start of the file. */
  var HEADER_BYTES = 127;

  var COMPRESSION = { UNKNOWN: 0, NONE: 1, GZIP: 2, BROTLI: 3, ZSTD: 4 };

  function MapError(key, detail) {
    var e = new Error(key);
    e.key = key;
    e.detail = detail == null ? null : detail;
    return e;
  }

  /* ── Bytes off the wire ────────────────────────────────────── */

  /**
   * One range request.
   *
   * A conforming server answers 206 with exactly the bytes asked for. A server that ignores
   * the header answers 200 with the whole file, which for a multi-megabyte archive on a
   * phone is the failure this whole design exists to avoid — so it is treated as a failure
   * rather than sliced and quietly accepted. R2 supports Range; a CDN in front of it must
   * pass the header through, which is a deployment fact and is recorded in the README.
   */
  function range(url, offset, length) {
    if (!(length > 0)) return Promise.resolve(new Uint8Array(0));
    return global.fetch(url, {
      headers: { Range: 'bytes=' + offset + '-' + (offset + length - 1) }
    }).then(function (res) {
      if (res.status === 404) throw MapError('map.err.missing', url);
      if (res.status !== 206) throw MapError('map.err.range', res.status);
      return res.arrayBuffer();
    }, function () {
      throw MapError('map.err.offline', url);
    }).then(function (buf) { return new Uint8Array(buf); });
  }

  /**
   * gzip, or nothing at all.
   *
   * DecompressionStream is the browser's own inflater — no JS implementation ships in this
   * file, and one is not written here on purpose: an inflate loop is exactly the kind of
   * code that is subtly wrong on malformed input, and the input is a file fetched over the
   * network. The platform's is fuzzed by people whose job that is.
   */
  function decompress(bytes, kind) {
    if (kind === COMPRESSION.NONE || kind === COMPRESSION.UNKNOWN) return Promise.resolve(bytes);
    if (kind !== COMPRESSION.GZIP) return Promise.reject(MapError('map.err.compression', kind));
    if (typeof global.DecompressionStream !== 'function') {
      return Promise.reject(MapError('map.err.compression', 'no DecompressionStream'));
    }
    var stream = new global.Response(bytes).body.pipeThrough(new global.DecompressionStream('gzip'));
    return new global.Response(stream).arrayBuffer().then(function (buf) {
      return new Uint8Array(buf);
    }, function () {
      throw MapError('map.err.compression', 'gzip failed');
    });
  }

  /* ── The header ────────────────────────────────────────────── */

  function parseHeader(bytes) {
    if (bytes.length < HEADER_BYTES) throw MapError('map.err.header', 'short');
    var magic = String.fromCharCode(bytes[0], bytes[1], bytes[2], bytes[3], bytes[4], bytes[5], bytes[6]);
    if (magic !== 'PMTiles') throw MapError('map.err.header', 'magic');
    if (bytes[7] !== 3) throw MapError('map.err.version', bytes[7]);

    var view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    // Every multi-byte field is little-endian. u64 is read as two u32 halves and recombined,
    // because getBigUint64 would give a BigInt that every arithmetic site would then have to
    // convert. See the 2^53 note in the header comment.
    function u64(at) {
      return view.getUint32(at, true) + view.getUint32(at + 4, true) * 4294967296;
    }

    return {
      rootOffset: u64(8),
      rootLength: u64(16),
      metadataOffset: u64(24),
      metadataLength: u64(32),
      leafOffset: u64(40),
      leafLength: u64(48),
      tileDataOffset: u64(56),
      tileDataLength: u64(64),
      clustered: bytes[96] === 1,
      internalCompression: bytes[97],
      tileCompression: bytes[98],
      tileType: bytes[99],
      minZoom: bytes[100],
      maxZoom: bytes[101],
      minLon: view.getInt32(102, true) / 1e7,
      minLat: view.getInt32(106, true) / 1e7,
      maxLon: view.getInt32(110, true) / 1e7,
      maxLat: view.getInt32(114, true) / 1e7,
      centerZoom: bytes[118],
      centerLon: view.getInt32(119, true) / 1e7,
      centerLat: view.getInt32(123, true) / 1e7
    };
  }

  /* ── Directories ───────────────────────────────────────────── */

  function varint(bytes, state) {
    var result = 0, shift = 1, b;
    do {
      if (state.p >= bytes.length) throw MapError('map.err.directory', 'truncated');
      b = bytes[state.p++];
      result += (b & 0x7f) * shift;
      shift *= 128;
    } while (b & 0x80);
    return result;
  }

  /**
   * A directory: entries sorted by tile id, in four columns rather than four-field records.
   *
   * The column layout is the format's, not a choice here — ids first as deltas, then run
   * lengths, then lengths, then offsets — and it is why a directory compresses so well.
   *
   * An offset of 0 is the format's way of saying "immediately after the previous entry",
   * which is what makes a clustered archive's offset column almost entirely zeroes.
   */
  function parseDirectory(bytes) {
    var state = { p: 0 };
    var count = varint(bytes, state);
    var entries = new Array(count);
    var i, id = 0;

    for (i = 0; i < count; i++) {
      id += varint(bytes, state);
      entries[i] = { tileId: id, runLength: 0, offset: 0, length: 0 };
    }
    for (i = 0; i < count; i++) entries[i].runLength = varint(bytes, state);
    for (i = 0; i < count; i++) entries[i].length = varint(bytes, state);
    for (i = 0; i < count; i++) {
      var value = varint(bytes, state);
      entries[i].offset = value === 0 && i > 0
        ? entries[i - 1].offset + entries[i - 1].length
        : value - 1;
    }
    return entries;
  }

  /**
   * The entry covering a tile id, or null.
   *
   * Binary search, and the run-length is what makes it more than an exact-match lookup: one
   * entry can stand for a run of consecutive ids that all resolve to the same bytes, which
   * is how an archive stores one blank ocean tile once. A run of 0 means the entry points at
   * a LEAF DIRECTORY rather than at a tile, and the caller follows it.
   */
  function findEntry(entries, tileId) {
    var lo = 0, hi = entries.length - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (tileId < entries[mid].tileId) hi = mid - 1;
      else if (tileId > entries[mid].tileId) lo = mid + 1;
      else return entries[mid];
    }
    // Not an exact hit: the candidate is the last entry at or below the id, and it covers
    // this tile only if its run reaches that far.
    if (hi >= 0) {
      var entry = entries[hi];
      if (entry.runLength === 0) return entry;                       // a leaf directory
      if (tileId - entry.tileId < entry.runLength) return entry;
    }
    return null;
  }

  /* ── z/x/y → tile id ───────────────────────────────────────── */

  /**
   * The Hilbert index of a tile, which is the order a PMTiles archive is sorted in.
   *
   * A Hilbert curve rather than row-major because it keeps neighbours near each other in the
   * file: panning fetches ranges that are close together, and a CDN that has cached one has
   * usually cached the next. That property is the whole reason the format works over HTTP.
   *
   * The leading term is the number of tiles in every zoom below this one — (4^z - 1) / 3 —
   * so ids are unique across zooms.
   */
  function tileId(z, x, y) {
    if (z < 0 || z > 26) throw MapError('map.err.zoom', z);
    var n = Math.pow(2, z);
    if (x < 0 || y < 0 || x >= n || y >= n) throw MapError('map.err.bounds', z + '/' + x + '/' + y);

    var acc = (Math.pow(4, z) - 1) / 3;
    var rx, ry, d = 0, tx = x, ty = y;
    for (var s = n / 2; s >= 1; s = s / 2) {
      rx = (tx & s) > 0 ? 1 : 0;
      ry = (ty & s) > 0 ? 1 : 0;
      d += s * s * ((3 * rx) ^ ry);
      // Rotate the quadrant so the curve stays continuous across it.
      if (ry === 0) {
        if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
        var swap = tx; tx = ty; ty = swap;
      }
    }
    return acc + d;
  }

  /* ── The archive ───────────────────────────────────────────── */

  /**
   * One archive at one URL.
   *
   * The header and the root directory are fetched once and held for the life of the page —
   * two requests before the first tile, and none after. Leaf directories are cached as they
   * are needed; a Palestine extract has few enough that they are not evicted.
   *
   * Tile BYTES are deliberately not cached here. map.js caches decoded geometry, which is
   * what it actually draws, and holding both would mean two copies of every tile in memory
   * on a phone.
   */
  function archive(url) {
    var headerPromise = null;
    var rootPromise = null;
    var leaves = {};

    function header() {
      if (!headerPromise) {
        headerPromise = range(url, 0, HEADER_BYTES).then(parseHeader).catch(function (err) {
          // Retryable: a header fetched during a dropped connection must not poison the
          // archive for the rest of the session.
          headerPromise = null;
          throw err;
        });
      }
      return headerPromise;
    }

    function root() {
      if (!rootPromise) {
        rootPromise = header().then(function (h) {
          return range(url, h.rootOffset, h.rootLength)
            .then(function (bytes) { return decompress(bytes, h.internalCompression); })
            .then(parseDirectory);
        }).catch(function (err) {
          rootPromise = null;
          throw err;
        });
      }
      return rootPromise;
    }

    function leaf(h, offset, length) {
      var key = offset + ':' + length;
      if (!leaves[key]) {
        leaves[key] = range(url, h.leafOffset + offset, length)
          .then(function (bytes) { return decompress(bytes, h.internalCompression); })
          .then(parseDirectory)
          .catch(function (err) { delete leaves[key]; throw err; });
      }
      return leaves[key];
    }

    /**
     * The decompressed bytes of one tile, or null when the archive does not have it.
     *
     * Null is the ordinary case, not an error: a vector archive stores nothing for a tile
     * with no features in it, and an extract stores nothing outside its bounding box. A
     * caller that treated a missing tile as a failure would fall back to the list view every
     * time somebody panned to the edge of the city.
     */
    function tile(z, x, y) {
      return header().then(function (h) {
        if (z < h.minZoom || z > h.maxZoom) return null;
        var id = tileId(z, x, y);
        return root().then(function (entries) {
          var entry = findEntry(entries, id);
          // One level of leaves, which is what the spec's own writer produces and what every
          // extract in practice has. A deeper tree resolves to null rather than looping.
          if (entry && entry.runLength === 0) {
            return leaf(h, entry.offset, entry.length).then(function (leafEntries) {
              var hit = findEntry(leafEntries, id);
              return hit && hit.runLength > 0 ? hit : null;
            });
          }
          return entry;
        }).then(function (entry) {
          if (!entry || entry.runLength === 0) return null;
          return range(url, h.tileDataOffset + entry.offset, entry.length)
            .then(function (bytes) { return decompress(bytes, h.tileCompression); });
        });
      });
    }

    return { url: url, header: header, tile: tile };
  }

  global.PMTILES = {
    archive: archive,
    // Exported for the tests, which build an archive byte by byte and read it back rather
    // than asserting against a fixture nobody can inspect.
    parseHeader: parseHeader,
    parseDirectory: parseDirectory,
    findEntry: findEntry,
    tileId: tileId,
    COMPRESSION: COMPRESSION,
    HEADER_BYTES: HEADER_BYTES
  };
})(window);
