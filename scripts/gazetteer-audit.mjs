// Where the basemap thinks each gazetteer place is, next to where the gazetteer says it is.
//
//     node scripts/gazetteer-audit.mjs                 # against the published places.json
//     node scripts/gazetteer-audit.mjs --json          # machine-readable
//
// ── Why this cannot be checked by looking at the map ─────────
//
// map.js draws a gazetteer label by projecting the gazetteer's OWN coordinate, so the label
// is where the row says it is no matter how wrong the row is. The picture agrees with itself.
// The only independent opinion available is the basemap extract, which carries `name:ar` and
// `name:en` on its places, POIs and roads — so this asks IT where each name is and reports
// the distance.
//
// ── Why it matters more than a misplaced label ───────────────
//
// §7's 21 Aug amendment: "a place chosen from the gazetteer publishes `exact`". A contributor
// who picks a place from the autocomplete rather than dropping a pin gets their item published
// at that row's coordinate, unfuzzed, as a precise claim about where a photograph was taken.
// A row that is 600 m out publishes every item pinned to it 600 m out, and calls it exact.
//
// ── What a distance here does and does not mean ──────────────
//
// Neither source is authoritative. A gazetteer row is a name a moderator chose for this
// archive and can legitimately mean something the extract does not have — a quarter with no
// OSM polygon, a landmark known locally by another name. So this REPORTS rather than judges,
// and a match is evidence rather than proof:
//
//   · a name found in the extract's `places` layer is the strongest signal — those are
//     localities and neighbourhoods, the same kind of thing a gazetteer row is;
//   · a match on a POI or a road is weaker: "عمارة البلدة القديمة1" is a building NAMED after
//     the old town, not the old town, and it will happily sit half a kilometre away;
//   · no match at all is not a fault. It means the extract has nothing to say.
//
// Read the layer and the matched name, not just the metres.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cfg = JSON.parse(readFileSync(join(root, 'config/site.json'), 'utf8'));
const CDN = `https://${cfg.domains.cdn}`;
const JSON_OUT = process.argv.includes('--json');

/* The site's own decoders, under a fake `window`, so this reads the archive exactly as a
   browser does rather than through a second implementation that could differ. */
const sandbox = {
  console, TextDecoder, Promise, Math, JSON, Uint8Array, DataView, ArrayBuffer,
  DecompressionStream, Response, fetch: (...a) => globalThis.fetch(...a)
};
sandbox.window = sandbox;
sandbox.global = sandbox;
vm.createContext(sandbox);
for (const f of ['pmtiles.js', 'mvt.js']) {
  vm.runInContext(readFileSync(join(root, 'site/assets/js', f), 'utf8'), sandbox, { filename: f });
}
const { PMTILES, MVT } = sandbox;

/* ── Geodesy, to the accuracy this needs ──────────────────────────────────── */

const unproject = (x, y) => {
  const n = Math.PI - 2 * Math.PI * y;
  return { lat: 180 / Math.PI * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lon: x * 360 - 180 };
};

/** Haversine. Metres, on a sphere — at city scale the ellipsoid correction is centimetres. */
function metres(a, b) {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * rad;
  const dLon = (b.lon - a.lon) * rad;
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(a.lat * rad) * Math.cos(b.lat * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Every vertex averaged. For a point feature that is the point; for a roundabout, its middle. */
function centroid(feature, layer, tx, ty, z) {
  let sx = 0, sy = 0, n = 0;
  for (const ring of feature.rings) {
    for (let i = 0; i + 1 < ring.length; i += 2) { sx += ring[i]; sy += ring[i + 1]; n++; }
  }
  if (!n) return null;
  const size = 2 ** z;
  return unproject((tx + (sx / n) / layer.extent) / size, (ty + (sy / n) / layer.extent) / size);
}

/* ── Name matching ────────────────────────────────────────────────────────── */

/* Arabic normalisation, deliberately shallow: the definite article, the alef and ya variants
   and the taa marbuta are the differences that actually appear between a moderator's spelling
   and OSM's. Written as code-point ranges rather than a character class of literal combining
   marks, for the reason map.js gives about bidi controls — an invisible character in source is
   unreviewable, and harakat in a `[a-b]` range are exactly that. */
const ALEFS = new Set([0x0623, 0x0625, 0x0622, 0x0671]);   // أ إ آ ٱ
const HARAKAT = (c) => (c >= 0x064B && c <= 0x0652) || c === 0x0670 || c === 0x0640; // + tatweel

function normalise(s) {
  let out = '';
  for (const ch of String(s).trim().toLowerCase()) {
    const c = ch.codePointAt(0);
    if (HARAKAT(c)) continue;
    if (ALEFS.has(c)) { out += 'ا'; continue; }        // -> bare alef
    if (c === 0x0649) { out += 'ي'; continue; }        // alef maqsura -> ya
    if (c === 0x0629) { out += 'ه'; continue; }        // taa marbuta -> haa
    out += ch;
  }
  return out
    .replace(/^ال/, '')          // the definite article
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Levenshtein, capped — only ever asked whether the distance is 0 or 1. */
function within1(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  let j = 0;
  while (j < a.length - i && j < b.length - i && a[a.length - 1 - j] === b[b.length - 1 - j]) j++;
  return (a.length - i - j) <= 1 && (b.length - i - j) <= 1;
}

/**
 * How good a match is, and the two grades are NOT interchangeable.
 *
 * `strong` is the same name, allowing one character: the deployed gazetteer says
 * "رام الله التحتا" where the extract says "رام الله التحتة", which is one letter and the same
 * neighbourhood.
 *
 * `weak` is containment, and it is kept because it is often right — "al-Manara Square lion
 * statues" contains the square and stands exactly on it. It is graded separately because it
 * is also how a false match happens: "رام الله التحتا" CONTAINS "رام الله", so the first draft
 * of this script matched Lower Ramallah to the city of Ramallah and reported a confident
 * 5,975 m to the wrong place. A weak hit is a lead, not a measurement.
 */
function grade(a, b) {
  const x = normalise(a);
  const y = normalise(b);
  if (!x || !y) return null;
  if (x === y || (x.length >= 4 && within1(x, y))) return 'strong';
  /* Containment, and the threshold is low ON PURPOSE. "دوار المنارة" is Al-Manara and is only
     half the string; "رام الله" inside "رام الله التحتا" is half the string and is a different
     place. No ratio separates those, so this does not try to: it admits both as WEAK and lets
     the grade, the layer and the metres beside them do the work. A lead that is printed and
     dismissed costs a glance; one that is silently dropped costs the finding. */
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (long.includes(short) && short.length / long.length >= 0.33) return 'weak';
  return null;
}

/* ── The archive ──────────────────────────────────────────────────────────── */

const manifest = await (await fetch(`${CDN}/manifest.json`, { cache: 'no-store' })).json();
const release = String(manifest.release ?? '').replace(/\/$/, '');
const places = (await (await fetch(`${CDN}${release}/places.json`)).json()).items ?? [];

const basemapPath = String(cfg.basemap?.path ?? '');
if (!basemapPath) {
  console.error('gazetteer-audit: config/site.json has no basemap.path — nothing to compare against.');
  process.exit(2);
}
const archive = PMTILES.archive(`${CDN}/${basemapPath}`);
const header = await archive.header();
const Z = header.maxZoom;

/* One pass over the tiles covering every gazetteer point, rather than a pass per place: the
   archive is read over Range requests and the tiles overlap heavily at this scale. */
const wanted = new Set();
const tileOf = (lat, lon) => {
  const n = 2 ** Z;
  const s = Math.min(Math.max(Math.sin(lat * Math.PI / 180), -0.9999), 0.9999);
  return {
    x: Math.floor((lon + 180) / 360 * n),
    y: Math.floor((0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n)
  };
};
const span = (lat, lon, radius) => {
  const t = tileOf(lat, lon);
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) wanted.add(`${t.x + dx}/${t.y + dy}`);
  }
};

/* Two windows, and the second is the point.
 *
 * Around each place: ±2 tiles, roughly 2 km at z15 — enough to find a row that is merely
 * imprecise.
 *
 * And around the MEDIAN of the gazetteer, wider. Searching only near each row's own
 * coordinate can never find a row that is badly wrong, which is the case worth catching: the
 * first run of this script could not see that "رام الله التحتا" sits 6 km from where the
 * gazetteer puts it, because it only ever looked where the gazetteer pointed. The median is
 * used rather than the mean precisely because one wild row must not move it.
 */
const RADIUS = Number((process.argv.find((a) => a.startsWith('--radius=')) || '').split('=')[1]) || 2;
const CENTRE_RADIUS = RADIUS + 5;
const mid = (xs) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const centre = { lat: mid(places.map((p) => p.lat)), lon: mid(places.map((p) => p.lon)) };

for (const p of places) span(p.lat, p.lon, RADIUS);
span(centre.lat, centre.lon, CENTRE_RADIUS);

const features = [];
// A feature that straddles a tile edge is encoded into BOTH tiles, so the same place arrives
// twice and the first run of this script printed "عمارة البلدة القديمة1" as two separate hits
// at identical coordinates. Keyed on the name and the position to ~10 m.
const seen = new Set();

for (const key of wanted) {
  const [tx, ty] = key.split('/').map(Number);
  let bytes;
  try { bytes = await archive.tile(Z, tx, ty); } catch { continue; }
  if (!bytes) continue;
  const layers = MVT.decodeTile(bytes, ['places', 'pois', 'roads']);
  for (const name of ['places', 'pois', 'roads']) {
    const layer = layers[name];
    if (!layer) continue;
    for (const f of layer.features) {
      const names = ['name:ar', 'name:en', 'name']
        .map((k) => MVT.attribute(f, k)).filter((v) => typeof v === 'string' && v.trim());
      if (!names.length || !f.rings?.length) continue;
      const at = centroid(f, layer, tx, ty, Z);
      if (!at) continue;
      const id = `${name}|${names[0]}|${at.lat.toFixed(4)}|${at.lon.toFixed(4)}`;
      if (seen.has(id)) continue;
      seen.add(id);
      features.push({ layer: name, kind: MVT.attribute(f, 'kind'), names, at });
    }
  }
}

/* ── The report ───────────────────────────────────────────────────────────── */

// Strongest evidence first: a strong name match on the `places` layer is a gazetteer row and
// its counterpart. A weak match on a POI is a lead.
const RANK = { places: 0, pois: 1, roads: 2 };
const GRADE = { strong: 0, weak: 1 };

const rows = places.map((p) => {
  const hits = [];
  for (const f of features) {
    let best = null;
    for (const n of f.names) {
      for (const want of [p.name_ar, p.name_en]) {
        const g = grade(n, want);
        if (g && (!best || GRADE[g] < GRADE[best])) best = g;
      }
    }
    if (best) hits.push({ ...f, grade: best, m: metres(p, f.at) });
  }
  hits.sort((a, b) => (GRADE[a.grade] - GRADE[b.grade]) || (RANK[a.layer] - RANK[b.layer]) || (a.m - b.m));
  return { place: p, hits: hits.slice(0, 4) };
});

const best = (hits) => hits.find((h) => h.grade === 'strong' && h.layer === 'places') || hits[0] || null;

if (JSON_OUT) {
  console.log(JSON.stringify(rows.map((r) => {
    const b = best(r.hits);
    return {
      name_ar: r.place.name_ar, name_en: r.place.name_en, lat: r.place.lat, lon: r.place.lon,
      best: b ? { layer: b.layer, kind: b.kind, grade: b.grade, names: b.names, metres: Math.round(b.m), at: b.at } : null
    };
  }), null, 2));
} else {
  console.log(`\ngazetteer-audit · ${places.length} places in ${release} · basemap z${Z}`);
  console.log(`  ${wanted.size} tiles read around each place (±${RADIUS}) and around the gazetteer's median (±${CENTRE_RADIUS})\n`);
  for (const { place, hits } of rows) {
    console.log(`${place.name_ar}  /  ${place.name_en}`);
    console.log(`   gazetteer says  ${place.lat}, ${place.lon}`);
    if (!hits.length) {
      console.log('   nothing in the extract by that name in the tiles read — nothing to compare, which is not a fault\n');
      continue;
    }
    for (const h of hits) {
      const flag = h.grade === 'strong' && h.layer === 'places' && h.m > 250 ? '   <-- LOOK' : '';
      console.log(`   ${h.grade === 'strong' ? 'STRONG' : '  weak'} ${String(Math.round(h.m)).padStart(6)} m  ${h.layer}/${h.kind}  ${h.at.lat.toFixed(5)}, ${h.at.lon.toFixed(5)}  — ${h.names.join(' / ')}${flag}`);
    }
    console.log('');
  }
  console.log('STRONG on the `places` layer is a gazetteer row and its counterpart. A weak hit on a POI');
  console.log('is a lead: a building named AFTER somewhere is not that place.');
}
