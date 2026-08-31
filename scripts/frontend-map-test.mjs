// M4's two format readers, against files this test builds byte by byte.
//
//     node scripts/frontend-map-test.mjs
//
// ── Why a builder and not a fixture ──────────────────────────
//
// pmtiles.js and mvt.js decode binary formats nobody can eyeball. A checked-in .pmtiles
// fixture would make every assertion here a comparison between two things I cannot read,
// and a decoder bug and a bad fixture would look identical. So the test ENCODES — a header
// at the spec's byte offsets, a directory in its four-column layout, a protobuf tile with
// its zig-zag geometry — and then asks the reader to get the same values back. The encoder
// is the specification, written out, and it is the thing to check when this file fails.
//
// ── What this cannot cover ───────────────────────────────────
//
// Drawing. map.js's create() needs a canvas, a ResizeObserver and a pointer, and standing
// all three up would be a browser — so what is asserted here is the arithmetic that decides
// WHERE things are drawn (the projection, its inverse, and the style/decode agreement) and
// not the pixels. The map rendering correctly is a manual check, and the README says so
// rather than implying this file covers it.
//
// Same technique as the other front-end tests: modules are evaluated against a stub
// `window`. No jsdom, no test runner, no dependency — §9's no-build-step rule applies to
// the tests too, or the tests become the build step.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { gzipSync } from 'node:zlib';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (rel) => readFileSync(join(root, rel), 'utf8');

let passed = 0;
let failed = 0;
function ok(cond, name) {
  if (cond) { passed++; console.log(`ok ${passed + failed} - ${name}`); }
  else { failed++; console.log(`not ok ${passed + failed} - ${name}`); }
}
const eq = (a, b, name) => ok(a === b, `${name}${a === b ? '' : ` — got ${a}, want ${b}`}`);

/* ── Encoders: the two formats, written out ───────────────────────────────── */

function varint(n) {
  const out = [];
  while (n > 127) { out.push((n & 127) | 128); n = Math.floor(n / 128); }
  out.push(n);
  return out;
}

/** The PMTiles v3 directory: ids as deltas, then runs, then lengths, then offsets. */
function encodeDirectory(entries) {
  const out = [...varint(entries.length)];
  let last = 0;
  for (const e of entries) { out.push(...varint(e.tileId - last)); last = e.tileId; }
  for (const e of entries) out.push(...varint(e.runLength));
  for (const e of entries) out.push(...varint(e.length));
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    // 0 is the format's "immediately after the previous entry", which is what makes a
    // clustered archive's offset column almost all zeroes.
    const contiguous = i > 0 && e.offset === entries[i - 1].offset + entries[i - 1].length;
    out.push(...varint(contiguous ? 0 : e.offset + 1));
  }
  return Uint8Array.from(out);
}

/**
 * A whole archive: 127-byte header, root directory, optional leaf section, tile data.
 *
 * `tiles` is a map of "z/x/y" to bytes. Anything not listed is absent, which is the
 * ordinary state of a vector archive rather than an error.
 */
function buildArchive(tiles, opts = {}) {
  const compression = opts.tileCompression ?? 2;   // gzip, the default a writer produces
  const internal = opts.internalCompression ?? 2;

  const ids = Object.keys(tiles).map((key) => {
    const [z, x, y] = key.split('/').map(Number);
    return { key, id: tileIdOf(z, x, y) };
  }).sort((a, b) => a.id - b.id);

  const bodies = [];
  const entries = [];
  let at = 0;
  for (const { key, id } of ids) {
    const raw = tiles[key];
    const body = compression === 2 ? new Uint8Array(gzipSync(Buffer.from(raw))) : raw;
    bodies.push(body);
    entries.push({ tileId: id, runLength: 1, offset: at, length: body.length });
    at += body.length;
  }
  const tileData = concat(bodies);

  // Half the entries can be pushed into a leaf directory, which is the branch a real
  // extract takes and the one a root-only test would never exercise.
  let rootEntries = entries;
  let leafBytes = new Uint8Array(0);
  if (opts.useLeaves && entries.length > 1) {
    const split = Math.floor(entries.length / 2);
    const leaf = encodeDirectory(entries.slice(split));
    leafBytes = internal === 2 ? new Uint8Array(gzipSync(Buffer.from(leaf))) : leaf;
    rootEntries = entries.slice(0, split).concat([
      // runLength 0 marks a pointer into the leaf section rather than into the tile data.
      { tileId: entries[split].tileId, runLength: 0, offset: 0, length: leafBytes.length }
    ]);
  }

  const rootRaw = encodeDirectory(rootEntries);
  const root = internal === 2 ? new Uint8Array(gzipSync(Buffer.from(rootRaw))) : rootRaw;

  const HEADER = 127;
  const rootOffset = HEADER;
  const leafOffset = rootOffset + root.length;
  const tileOffset = leafOffset + leafBytes.length;

  const header = new Uint8Array(HEADER);
  const view = new DataView(header.buffer);
  for (let i = 0; i < 7; i++) header[i] = 'PMTiles'.charCodeAt(i);
  header[7] = opts.version ?? 3;
  const u64 = (at2, value) => {
    view.setUint32(at2, value >>> 0, true);
    view.setUint32(at2 + 4, Math.floor(value / 4294967296), true);
  };
  u64(8, rootOffset); u64(16, root.length);
  u64(24, 0); u64(32, 0);                       // no JSON metadata
  u64(40, leafOffset); u64(48, leafBytes.length);
  u64(56, tileOffset); u64(64, tileData.length);
  u64(72, entries.length); u64(80, entries.length); u64(88, entries.length);
  header[96] = 1;                               // clustered
  header[97] = internal;
  header[98] = compression;
  header[99] = 1;                               // tile type: mvt
  header[100] = opts.minZoom ?? 0;
  header[101] = opts.maxZoom ?? 14;
  view.setInt32(102, Math.round(34.9 * 1e7), true);
  view.setInt32(106, Math.round(31.7 * 1e7), true);
  view.setInt32(110, Math.round(35.4 * 1e7), true);
  view.setInt32(114, Math.round(32.1 * 1e7), true);
  header[118] = 14;
  view.setInt32(119, Math.round(35.2034 * 1e7), true);
  view.setInt32(123, Math.round(31.9038 * 1e7), true);

  return concat([header, root, leafBytes, tileData]);
}

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

/** The Hilbert index, written independently of the module so the test is not its own oracle. */
function tileIdOf(z, x, y) {
  let acc = 0;
  for (let t = 0; t < z; t++) acc += Math.pow(2, t) * Math.pow(2, t);
  let d = 0, rx, ry, tx = x, ty = y;
  for (let s = Math.pow(2, z) / 2; s >= 1; s /= 2) {
    rx = (tx & s) > 0 ? 1 : 0;
    ry = (ty & s) > 0 ? 1 : 0;
    d += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { tx = s - 1 - tx; ty = s - 1 - ty; }
      const swap = tx; tx = ty; ty = swap;
    }
  }
  return acc + d;
}

/* ── A vector tile, by hand ───────────────────────────────────────────────── */

const tag = (field, wire) => varint(field * 8 + wire);
const bytesField = (field, bytes) => [...tag(field, 2), ...varint(bytes.length), ...bytes];
const strBytes = (s) => [...Buffer.from(s, 'utf8')];
const zig = (n) => (n < 0 ? -2 * n - 1 : 2 * n);
const command = (id, count) => (id & 0x7) | (count << 3);

function feature({ type, geometry, tags = [] }) {
  const geom = [];
  for (const n of geometry) geom.push(...varint(n));
  const tagsPacked = [];
  for (const n of tags) tagsPacked.push(...varint(n));
  return [
    ...tag(3, 0), ...varint(type),
    ...(tags.length ? bytesField(2, tagsPacked) : []),
    ...bytesField(4, geom)
  ];
}

function layer({ name, extent = 4096, features = [], keys = [], values = [] }) {
  const out = [
    ...tag(15, 0), ...varint(2),
    ...bytesField(1, strBytes(name)),
    ...tag(5, 0), ...varint(extent)
  ];
  for (const k of keys) out.push(...bytesField(3, strBytes(k)));
  for (const v of values) out.push(...bytesField(4, bytesField(1, strBytes(v))));
  for (const f of features) out.push(...bytesField(2, f));
  return out;
}

function vectorTile(layers) {
  const out = [];
  for (const l of layers) out.push(...bytesField(3, l));
  return Uint8Array.from(out);
}

/* ── The window the modules run against ───────────────────────────────────── */

function mapWindow(archiveBytes, opts = {}) {
  const requests = [];
  const win = {
    fetch(url, init) {
      const header = (init && init.headers && init.headers.Range) || '';
      requests.push(header);
      if (opts.missing) return Promise.resolve({ status: 404 });
      const m = /bytes=(\d+)-(\d+)/.exec(header);
      const slice = m
        ? archiveBytes.slice(Number(m[1]), Number(m[2]) + 1)
        : archiveBytes;
      return Promise.resolve({
        // 200 is the failure mode that matters: an intermediary that ignored the Range
        // header and sent the whole file. pmtiles.js must refuse it rather than slice it.
        status: opts.ignoreRange ? 200 : 206,
        arrayBuffer: () => Promise.resolve(slice.buffer.slice(slice.byteOffset, slice.byteOffset + slice.byteLength))
      });
    },
    Response: globalThis.Response,
    DecompressionStream: globalThis.DecompressionStream,
    TextDecoder: globalThis.TextDecoder,
    _requests: requests
  };
  new Function('window', read('site/assets/js/pmtiles.js'))(win);
  new Function('window', read('site/assets/js/mvt.js'))(win);
  return win;
}

/* ═══ 1 · the Hilbert index ═══════════════════════════════════════════════ */

console.log('# pmtiles.js — the tile id an archive is sorted by');

{
  const win = mapWindow(buildArchive({}));
  const { tileId } = win.PMTILES;

  eq(tileId(0, 0, 0), 0, 'z0 is id 0');
  // The four z1 tiles, in the curve's own order: it visits (0,0) (0,1) (1,1) (1,0), which
  // is what keeps neighbours adjacent in the file and is the whole reason for the format.
  eq(tileId(1, 0, 0), 1, 'z1 (0,0)');
  eq(tileId(1, 0, 1), 2, 'z1 (0,1)');
  eq(tileId(1, 1, 1), 3, 'z1 (1,1)');
  eq(tileId(1, 1, 0), 4, 'z1 (1,0)');
  eq(tileId(2, 0, 0), 5, 'z2 starts after every z1 tile');

  // Distinctness across a whole zoom, which a row-major implementation would also pass —
  // so it is paired with the ordering above rather than standing in for it.
  const seen = new Set();
  for (let x = 0; x < 8; x++) for (let y = 0; y < 8; y++) seen.add(tileId(3, x, y));
  eq(seen.size, 64, 'every z3 tile has its own id');

  let threw = false;
  try { tileId(3, 8, 0); } catch (e) { threw = e.key === 'map.err.bounds'; }
  ok(threw, 'an x outside the zoom is refused rather than folded');
}

/* ═══ 2 · reading an archive ══════════════════════════════════════════════ */

console.log('# pmtiles.js — header, directory, and one tile');

const TILE = vectorTile([
  layer({
    name: 'water',
    features: [feature({
      type: 3,
      geometry: [
        command(1, 1), zig(0), zig(0),
        command(2, 3), zig(10), zig(0), zig(0), zig(10), zig(-10), zig(0),
        command(7, 1)
      ]
    })]
  }),
  layer({
    name: 'roads',
    // Two values, and the feature points at the SECOND, so the key index (0) and the value
    // index (1) differ. With one of each, `values[tags[i]]` and `values[tags[i + 1]]` are
    // the same lookup and a decoder that confused them would pass.
    keys: ['kind'],
    values: ['minor_road', 'major_road'],
    features: [feature({
      type: 2,
      tags: [0, 1],
      geometry: [command(1, 1), zig(5), zig(5), command(2, 1), zig(20), zig(0)]
    })]
  }),
  layer({
    name: 'buildings',
    features: [feature({ type: 3, geometry: [command(1, 1), zig(1), zig(1), command(2, 2), zig(2), zig(0), zig(0), zig(2), command(7, 1)] })]
  })
]);

{
  const bytes = buildArchive({ '14/9700/6300': TILE, '14/9701/6300': TILE });
  const win = mapWindow(bytes);
  const archive = win.PMTILES.archive('https://cdn.test/basemap.pmtiles');

  const header = await archive.header();
  eq(header.minZoom, 0, 'min zoom');
  eq(header.maxZoom, 14, 'max zoom');
  eq(header.tileCompression, 2, 'tile compression is gzip');
  ok(Math.abs(header.centerLat - 31.9038) < 1e-6, 'the centre survives the E7 encoding');

  // The first request is the header alone, not the file: an archive that fetched itself to
  // read 127 bytes would defeat the entire point of the format.
  ok(win._requests[0] === 'bytes=0-126', `the first request is the 127-byte header (${win._requests[0]})`);

  const tile = await archive.tile(14, 9700, 6300);
  ok(tile instanceof Uint8Array, 'a tile comes back as bytes');
  ok(tile.length === TILE.length, 'and it is the tile that was written, decompressed');

  // A tile the archive does not hold answers null AND fetches nothing. The second half is
  // the discriminating one: an entry covers a RUN of consecutive ids, and a lookup that
  // returned the nearest entry without checking the run would range-request the neighbour's
  // bytes and hand them back — a tile of the wrong place, drawn confidently.
  const before = win._requests.length;
  eq(await archive.tile(14, 9702, 6300), null, 'a tile the archive does not hold is null, not an error');
  eq(win._requests.length, before, '...and asks the network for nothing');

  // Out of the archive's zoom range. This pins the OUTCOME only: the min/max check in
  // tile() is an optimisation, and deleting it lands here anyway because tile ids are
  // unique per zoom and the directory has no entry to find. Said plainly rather than left
  // as an assertion that reads like it covers the guard.
  eq(await archive.tile(2, 1, 1), null, 'a zoom outside the archive is null');
}

{
  // The leaf branch. A root-only archive never follows the runLength-0 pointer, so this is
  // the same assertions against a two-level directory.
  const bytes = buildArchive(
    { '14/9700/6300': TILE, '14/9701/6300': TILE, '14/9700/6301': TILE, '14/9701/6301': TILE },
    { useLeaves: true }
  );
  const win = mapWindow(bytes);
  const archive = win.PMTILES.archive('https://cdn.test/basemap.pmtiles');

  const first = await archive.tile(14, 9700, 6300);
  const last = await archive.tile(14, 9701, 6301);
  ok(first instanceof Uint8Array && last instanceof Uint8Array,
     'tiles resolve through BOTH the root directory and a leaf');

  // CONTROL for the assertion above: it only means something if the archive really did put
  // some entries in a leaf. Without this, an encoder that quietly kept everything in the
  // root would make the leaf path untested and the test still green.
  eq(win.PMTILES.parseHeader(bytes).leafLength > 0, true,
     'CONTROL: the archive under test actually has a leaf directory');
}

console.log('# pmtiles.js — the failures that must not look like an empty city');

{
  const win = mapWindow(buildArchive({ '14/9700/6300': TILE }), { ignoreRange: true });
  const archive = win.PMTILES.archive('https://cdn.test/basemap.pmtiles');
  let key = null;
  try { await archive.header(); } catch (e) { key = e.key; }
  eq(key, 'map.err.range', 'a server that ignored the Range header is a failure, not a whole-file download');
}

{
  const win = mapWindow(buildArchive({}), { missing: true });
  const archive = win.PMTILES.archive('https://cdn.test/basemap.pmtiles');
  let key = null;
  try { await archive.header(); } catch (e) { key = e.key; }
  eq(key, 'map.err.missing', 'a 404 on the archive is named');
}

{
  // brotli for the directories. Legal in the spec, undecodable in a browser, and the reason
  // map.js has a fallback at all — so it must be a NAMED refusal rather than a hang.
  //
  // What this pins is the OUTCOME, and deliberately not the branch that produces it:
  // deleting the compression check entirely still ends here, because gunzip on brotli bytes
  // fails and that failure carries the same key. The branch that would NOT end here is one
  // that returned the bytes undecoded, and this catches that.
  const bytes = buildArchive({ '14/9700/6300': TILE }, { internalCompression: 3 });
  const win = mapWindow(bytes);
  const archive = win.PMTILES.archive('https://cdn.test/basemap.pmtiles');
  let key = null;
  try { await archive.tile(14, 9700, 6300); } catch (e) { key = e.key; }
  eq(key, 'map.err.compression', 'a brotli-compressed directory is refused by name');
}

{
  const bytes = buildArchive({}, { version: 2 });
  const win = mapWindow(bytes);
  let key = null;
  try { await win.PMTILES.archive('https://cdn.test/x.pmtiles').header(); } catch (e) { key = e.key; }
  eq(key, 'map.err.version', 'a v2 archive is refused rather than misread');
}

/* ═══ 3 · the vector tile ═════════════════════════════════════════════════ */

console.log('# mvt.js — geometry, attributes, and the layers it refuses to decode');

{
  const win = mapWindow(buildArchive({}));
  const layers = win.MVT.decodeTile(TILE, ['water', 'roads']);

  ok('water' in layers && 'roads' in layers && 'buildings' in layers,
     'every layer in the tile is named, whether or not it was wanted');
  eq(layers.water.extent, 4096, 'the extent is read, not assumed');

  const ring = layers.water.features[0].rings[0];
  // MoveTo(0,0), LineTo three deltas, ClosePath — so the ring is five points and the last
  // is the first. The deltas are cumulative, which is the part a decoder gets wrong.
  eq(ring.join(','), '0,0,10,0,10,10,0,10,0,0', 'the polygon decodes to absolute coordinates');
  eq(layers.water.features[0].type, 3, 'a polygon knows it is one');

  eq(win.MVT.attribute(layers.roads.features[0], 'kind'), 'major_road',
     'an attribute resolves through the layer key and value tables');
  eq(win.MVT.attribute(layers.roads.features[0], 'name'), null,
     'an attribute the feature does not carry is null');

  // The reason `wanted` exists: buildings is the largest layer in a city tile and the style
  // does not draw it below z15. Naming it and not decoding it is most of the frame budget
  // on the mid-range Android §10 names.
  eq(layers.buildings.features.length, 0, 'an unwanted layer is parsed but not decoded');
  eq(layers.water.features.length, 1, 'CONTROL: a wanted layer IS decoded');
}

/* ═══ 4 · the projection ══════════════════════════════════════════════════ */

console.log('# map.js — the arithmetic that decides where things land');

{
  const win = mapWindow(buildArchive({}));
  win.document = { documentElement: {}, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }) };
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  new Function('window', read('site/assets/js/map.js'))(win);
  const { project, unproject, STYLE, LABELS, WANTED } = win.MAP;

  const centre = project(0, 0);
  ok(Math.abs(centre.x - 0.5) < 1e-9 && Math.abs(centre.y - 0.5) < 1e-9,
     'the null island is the middle of the world');

  const manara = project(31.9038, 35.2034);
  const back = unproject(manara.x, manara.y);
  ok(Math.abs(back.lat - 31.9038) < 1e-6 && Math.abs(back.lon - 35.2034) < 1e-6,
     'project and unproject are inverses at Ramallah');

  // North is UP: a larger latitude must give a SMALLER y. A sign error here draws the whole
  // city upside down, which is the kind of thing that looks like a broken extract.
  ok(project(32.5, 35.2).y < project(31.5, 35.2).y, 'y increases southward');
  ok(project(31.9, 36.0).x > project(31.9, 35.0).x, 'x increases eastward');

  // The list mvt.js is asked to decode is DERIVED from the two rule tables rather than
  // written a third time. A rule for a layer nobody decodes draws nothing, silently, forever
  // — which is exactly how a label rule would fail: no error, just a map with no names.
  const styled = [...new Set([...STYLE, ...LABELS].map((r) => r.layer))].sort();
  eq(WANTED.slice().sort().join(','), styled.join(','),
     'every styled or labelled layer is decoded, and no other');
  ok(STYLE.some((r) => r.layer === 'water') && STYLE.some((r) => r.layer === 'roads'),
     'CONTROL: the style has the layers a city basemap needs');
  ok(LABELS.some((r) => r.layer === 'roads') && LABELS.some((r) => r.layer === 'places')
     && LABELS.some((r) => r.layer === 'pois'),
     'CONTROL: the label rules read the three layers this extract carries names on');
  /* Every label rule is gated on the VIEW zoom, and create() caps view.maxZoom at the
     archive's own maxZoom PLUS three levels of overzoom — 15 + 3 for the Palestine extract on
     R2. A rule above that ceiling is not a rule that shows later, it is a rule that shows
     NEVER, in complete silence: no error, no warning, just a map that looks deliberately
     sparse. The first draft of LABELS put POIs and minor roads at 16 while the view still
     stopped at 15, and neither ever drew one label.
     Both numbers are written out rather than read back off map.js, for the reason 05_matrix's
     cell count is: a bound derived from the thing it bounds cannot detect that thing moving.
     If the extract is ever rebuilt to a different depth, this line is the one to change. */
  const EXTRACT_MAX_ZOOM = 15;
  const OVERZOOM = 3;
  const unreachable = LABELS.filter((r) => !(r.minZoom >= 8 && r.minZoom <= EXTRACT_MAX_ZOOM + OVERZOOM));
  ok(unreachable.length === 0,
     `every label rule can be reached at a zoom the map can actually show${unreachable.length ? ' — ' + unreachable.map((r) => `${r.layer}@z${r.minZoom}`).join(', ') : ''}`);
  ok(new RegExp(`header\\.maxZoom \\+ ${OVERZOOM}`).test(read('site/assets/js/map.js')),
     `CONTROL: map.js really does allow ${OVERZOOM} levels of overzoom past the archive — the ceiling above is not a number this test invented`);
}

/* ═══ 5 · the names on the map ════════════════════════════════════════════ */

console.log('# map.js — which name a feature is labelled with, and where a street name sits');

{
  // U+202E, built rather than typed: an override pasted into a source file is invisible in
  // every diff and every review, which is the whole reason §6 strips it.
  const RLO = String.fromCharCode(0x202E);
  const NAMED = vectorTile([
    layer({
      name: 'roads',
      keys: ['kind', 'name', 'name:ar', 'name:en'],
      values: [
        'major_road',           // 0
        'شارع الإرسال',           // 1
        'Sharia Al-Irsal',      // 2
        'גבעת זאב',              // 3  a default name in Hebrew script
        'شارع' + RLO + ' ركب'   // 4  a name carrying a bidi override
      ],
      features: [
        // Both language tags, and a default name as well.
        feature({ type: 2, tags: [0, 0, 1, 1, 2, 1, 3, 2],
                  geometry: [command(1, 1), zig(5), zig(5), command(2, 1), zig(20), zig(0)] }),
        // Nothing but a Hebrew default name.
        feature({ type: 2, tags: [0, 0, 1, 3],
                  geometry: [command(1, 1), zig(5), zig(9), command(2, 1), zig(20), zig(0)] }),
        // The same Hebrew default, WITH an Arabic tag beside it — the control.
        feature({ type: 2, tags: [0, 0, 1, 3, 2, 1],
                  geometry: [command(1, 1), zig(5), zig(13), command(2, 1), zig(20), zig(0)] }),
        // Only a default name, and it is already Arabic — the common case in this extract.
        feature({ type: 2, tags: [0, 0, 1, 1],
                  geometry: [command(1, 1), zig(5), zig(17), command(2, 1), zig(20), zig(0)] }),
        // An override inside the Arabic name.
        feature({ type: 2, tags: [0, 0, 2, 4],
                  geometry: [command(1, 1), zig(5), zig(21), command(2, 1), zig(20), zig(0)] }),
        // A road as OSM actually stores one: a straight stretch cut into three collinear
        // segments, then a right-angle turn into a shorter one. The name belongs on the
        // stretch — all 60 units of it — and the turn is what ends it.
        feature({ type: 2, tags: [0, 0, 2, 1],
                  geometry: [command(1, 1), zig(0), zig(0),
                             command(2, 4), zig(10), zig(0), zig(20), zig(0), zig(30), zig(0),
                                            zig(0), zig(30)] })
      ]
    })
  ]);

  const win = mapWindow(buildArchive({}));
  win.document = { documentElement: {}, createElement: () => ({ style: {}, setAttribute() {}, addEventListener() {} }) };
  win.getComputedStyle = () => ({ getPropertyValue: () => '' });
  new Function('window', read('site/assets/js/map.js'))(win);
  const { labelText, lineAnchor } = win.MAP;
  const roads = win.MVT.decodeTile(NAMED, ['roads']).roads.features;

  eq(labelText(roads[0], 'ar'), 'شارع الإرسال', 'Arabic reads name:ar');
  eq(labelText(roads[0], 'en'), 'Sharia Al-Irsal', 'English reads name:en');

  // The whole point of the exclusion, and the assertion that would go green again the moment
  // somebody "simplifies" the fallback to `name:ar || name`.
  eq(labelText(roads[1], 'ar'), null,
     'a feature whose only name is Hebrew gets NO Arabic label rather than a Hebrew one');
  eq(labelText(roads[1], 'en'), null, 'and no English one either — it is not a translation');
  eq(labelText(roads[2], 'ar'), 'شارع الإرسال',
     'CONTROL: the same Hebrew default WITH an Arabic tag is labelled, so the rule is about the fallback and not about the feature');

  eq(labelText(roads[3], 'ar'), 'شارع الإرسال',
     'a default name in Arabic IS used when there is no name:ar — most of this extract');
  eq(labelText(roads[3], 'en'), 'شارع الإرسال',
     'and in English too: the Arabic name is the only name there is');

  const stripped = labelText(roads[4], 'ar');
  ok(stripped.indexOf(RLO) === -1, 'a bidi override in a tile name is stripped (§6)');
  ok(stripped.indexOf('شارع') > -1 && stripped.indexOf('ركب') > -1,
     'and both words survive the stripping — it removes the control, not the text');

  /* A street name is set along the street, on its longest straight RUN — because a road's
     centroid can sit off the road wherever it bends, and because the longest single SEGMENT
     of a densely-noded real street is far too short to write a name on. This fixture
     discriminates between all three readings: the longest segment is 30, the whole polyline
     end to end is 67, and the straight run is 60. */
  const anchor = lineAnchor(roads[5]);
  eq(anchor.span, 60, 'collinear segments are ONE run — not the longest segment (30)');
  eq(anchor.tx, 30, 'the anchor is the midpoint of that run');
  eq(anchor.ty, 0, 'and it sits on the road, not beside it');
  eq(anchor.dy, 0, 'the angle comes from the run’s own direction — the turn is excluded');

  eq(lineAnchor(win.MVT.decodeTile(TILE, ['water']).water.features[0]).span, 10,
     'CONTROL: lineAnchor measures a real geometry rather than returning a constant');
}

/* ═══ 6 · the wiring the front end depends on ═════════════════════════════ */

console.log('# the map is loaded on demand, and the budget depends on that');

{
  const shell = read('site/index.html');
  for (const module of ['map.js', 'mvt.js', 'pmtiles.js']) {
    ok(!shell.includes(`/assets/js/${module}`),
       `${module} is NOT in the shell's script list — §9's budget is measured from it`);
  }

  // ...and something must therefore load them, or /map is a permanently empty panel.
  const ui = read('site/assets/js/ui.js');
  ok(/loadScript/.test(ui) && /pmtiles\.js/.test(ui) && /mvt\.js/.test(ui) && /map\.js/.test(ui),
     'UI.loadMap fetches all three');
  // The order is load-bearing: map.js reads PMTILES and MVT off `window` at IIFE time.
  // Matched on the loaded PATH rather than the bare filename — the comment above loadMap
  // names map.js while explaining exactly this, and a filename search finds the prose.
  const order = ['pmtiles.js', 'mvt.js', 'map.js'].map((m) => ui.indexOf(`/assets/js/${m}`));
  ok(order.every((n) => n > -1) && order[0] < order[1] && order[1] < order[2],
     'and in dependency order — map.js reads the other two off window when it runs');

  /* §9: "Reuse tokens.css. Never hardcode a color." A canvas cannot resolve var(), so
     map.js reads the palette from the document — and the only literal colours allowed in
     the file are the documented fallbacks inside palette()'s `defaults`, for a document
     with no stylesheet at all. Any hex outside that block is a colour that stopped coming
     from tokens.css, which is invisible until someone changes a token and nothing moves. */
  const map = read('site/assets/js/map.js');
  const defaults = /var defaults = \{([\s\S]*?)\};/.exec(map);
  ok(defaults !== null, 'CONTROL: palette()’s defaults block is where this test thinks it is');
  const outside = map.replace(defaults ? defaults[0] : '', '').match(/#[0-9A-Fa-f]{6}/g) || [];
  ok(outside.length === 0,
     `no colour is hardcoded outside palette()’s fallbacks${outside.length ? ' — ' + outside.join(', ') : ''}`);
  // ...and the fallbacks must name every token the style asks for, or a document without a
  // stylesheet paints `undefined` and the map comes out transparent.
  const tokens = [...map.matchAll(/token: '(--map-[a-z-]+)'/g)].map((m) => m[1]);
  const missing = tokens.filter((name) => !(defaults && defaults[1].includes(`'${name}'`)));
  ok(tokens.length > 0 && missing.length === 0,
     `every styled token has a fallback${missing.length ? ' — missing ' + missing.join(', ') : ''}`);
}

console.log(`\n1..${passed + failed}`);
if (failed) {
  console.error(`\nFAILED ${failed} of ${passed + failed}`);
  process.exit(1);
}
console.log(`All ${passed} assertions passed.`);
