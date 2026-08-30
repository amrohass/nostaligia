/* Export the archive as JSON and CSV, with Dublin Core field names.
 *
 *     deno run --allow-net --allow-read --allow-write scripts/export-archive.ts
 *     deno run --allow-net --allow-read --allow-write scripts/export-archive.ts \
 *       --base https://<cdn> --site https://<origin> --out export
 *
 * CLAUDE.md §10 M5: "export job (JSON + CSV, Dublin Core field names)". This is it.
 *
 * ── It reads the PUBLISHED RELEASE, not the database ─────────
 *
 * That is the whole design, and it is a privacy decision before it is a convenience one.
 *
 * §7 says plainly: "Emails are never published. Not in profiles, not in snapshots, and not
 * in exports." An exporter that queried Postgres would have to re-implement every
 * projection the publisher already performs — the fuzzed coordinate instead of the real
 * one, day-precision timestamps, the profile visibility map, the exclusion of pending,
 * rejected, withdrawn and taken-down rows — and would be one forgotten WHERE clause away
 * from putting a contributor's home coordinate in a spreadsheet somebody emails onward.
 *
 * Reading `/v/{ts}/` instead means the export cannot contain anything the archive has not
 * already published to every visitor. The privacy properties are inherited rather than
 * reproduced. `location` in a shard is already `location_public`; `author` is already
 * whatever the visibility map allowed; `day` is already day-precision.
 *
 * It also needs NO CREDENTIAL, which is why this runs against staging or production
 * without the service-role key that M5's other half is still waiting on.
 *
 * The cost is stated rather than hidden: an item that is approved but not yet in a release
 * is not in the export, and a field the publisher does not put in a shard cannot appear
 * here. Both are correct for a public archival export and would be wrong for a backup —
 * which is a different job, and is the other M5 item.
 *
 * ── Dublin Core, and where it does not fit ───────────────────
 *
 * DCMI Metadata Terms. Two mappings are judgement calls and are marked at the line:
 * `dcterms:coverage` carries the FUZZED point, and `dcterms:date` carries an EDTF interval
 * rather than a date, because §3 is explicit that a heritage photograph is "sometime in
 * the 60s" and collapsing that to a single day would be inventing precision the archive
 * deliberately does not claim.
 */

const DEFAULT_OUT = "export";

function arg(name: string): string | null {
  const i = Deno.args.indexOf("--" + name);
  return i >= 0 && i + 1 < Deno.args.length ? Deno.args[i + 1] : null;
}

const cfg = JSON.parse(await Deno.readTextFile(new URL("../config/site.json", import.meta.url)));

/* `read_path.base` is a token — "@cdn" or "self" — exactly as the front end resolves it,
 * so this does not become a second place a hostname lives (§2). */
function defaultBase(): string {
  const token = cfg.read_path?.base ?? "@cdn";
  if (token === "@cdn") return `https://${cfg.domains.cdn}`;
  if (token.startsWith("@")) return `https://${cfg.domains[token.slice(1)]}`;
  return "";
}

const BASE = (arg("base") ?? defaultBase()).replace(/\/$/, "");
const OUT = arg("out") ?? DEFAULT_OUT;
/* Optional. A dcterms:identifier is more useful as a resolvable URL than as a bare uuid,
 * but §2 keeps `domains.site` as PLACEHOLDER_DOMAIN until a production host exists, and a
 * URL built on a placeholder is worse than no URL. So: id alone unless told otherwise. */
const SITE = (arg("site") ?? "").replace(/\/$/, "");

if (!BASE) {
  console.error("no read-path base: pass --base https://<cdn>");
  Deno.exit(1);
}

async function getJson(path: string): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`);
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return await res.json();
}

/* ── The Dublin Core mapping ─────────────────────────────────── */

type Shard = Record<string, unknown>;

/** DCMI Type Vocabulary, from the archive's own kind plus what the media actually is. */
function dcType(item: Shard): string {
  const kind = String(item.kind ?? "");
  if (kind === "event") return "Event";
  if (kind === "voice") return "Sound";
  const media = (item.media as Array<Record<string, unknown>> | undefined) ?? [];
  const mime = String(media.find((m) => m.role === "rendition")?.mime ?? "");
  if (mime.startsWith("video/")) return "MovingImage";
  if (mime.startsWith("audio/")) return "Sound";
  return "Image";
}

/**
 * EDTF, not a date. §3: "heritage photos are 'sometime in the 60s'. Never force a single
 * date." A decade becomes the interval `1960/1969`; an exact day stays a day. Collapsing
 * the first into its start would publish a precision the archive does not claim, and a
 * researcher reading the CSV would have no way to know it was invented.
 */
function dcDate(item: Shard): string {
  const a = item.date_earliest as string | null;
  const b = item.date_latest as string | null;
  if (!a && !b) return "";
  if (a && b && a !== b) return `${a}/${b}`;
  return String(a ?? b ?? "");
}

/** Arabic first (§9), with the other language kept rather than dropped. */
function pick(ar: unknown, en: unknown): { primary: string; alternative: string; lang: string } {
  const A = String(ar ?? "").trim();
  const E = String(en ?? "").trim();
  if (A) return { primary: A, alternative: E, lang: "ar" };
  return { primary: E, alternative: "", lang: "en" };
}

/**
 * dcterms:coverage — the place name and, when there is one, the FUZZED point.
 *
 * `item.location` in a shard is already `location_public`: §7 forbids publishing the real
 * coordinate and the publisher never puts it in a shard, so there is nothing here to get
 * wrong. An item at precision 'hidden' carries no point at all and gets only its name.
 */
function dcCoverage(item: Shard): string {
  const place = pick(item.place_ar, item.place_en).primary;
  const loc = item.location as { lat?: number; lon?: number } | null;
  const point = loc && typeof loc.lat === "number" && typeof loc.lon === "number"
    ? `${loc.lat},${loc.lon}`
    : "";
  if (place && point) return `${place} (${point})`;
  return place || point;
}

function toDublinCore(item: Shard) {
  const title = pick(item.title_ar, item.title_en);
  const body = pick(item.body_ar, item.body_en);
  const media = (item.media as Array<Record<string, unknown>> | undefined) ?? [];
  const rendition = media.find((m) => m.role === "rendition") ?? media[0];

  return {
    "dcterms:identifier": SITE ? `${SITE}/item/${item.id}/` : String(item.id ?? ""),
    "dcterms:title": title.primary,
    "dcterms:alternative": title.alternative,
    "dcterms:description": body.primary,
    /* Already projected through the profile visibility map at publish time — a contributor
     * who hid their contributions is `null` in the shard and empty here. Never an email
     * and never a user id: §7 forbids the first outright, and the second is the join key
     * that turns a set of items into one person's history. */
    "dcterms:creator": String(item.author ?? ""),
    "dcterms:publisher": "Ramallah Memory Atlas — ذاكرة رام الله",
    "dcterms:date": dcDate(item),
    "dcterms:temporal": item.decade ? `${item.decade}s` : "",
    "dcterms:type": dcType(item),
    "dcterms:format": String(rendition?.mime ?? ""),
    "dcterms:language": title.lang,
    "dcterms:rights": String(item.license ?? ""),
    /* §7's "where did this come from" — the provenance a contributor supplied at upload. */
    "dcterms:source": String(item.provenance ?? ""),
    "dcterms:coverage": dcCoverage(item),
    /* Not Dublin Core, and kept anyway: a researcher who does not know how precise a
     * coordinate is has been handed a number they will over-trust. */
    "rma:locationPrecision": String(item.location_precision ?? ""),
    "rma:kind": String(item.kind ?? ""),
    "rma:publishedOn": String(item.day ?? ""),
  };
}

/* ── CSV ─────────────────────────────────────────────────────── */

function csvCell(v: string): string {
  // RFC 4180. Quote when the value contains a delimiter, a quote or any newline; double
  // the quotes inside. Arabic needs nothing special — it is UTF-8 like everything else.
  return /[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

function toCsv(rows: Array<Record<string, string>>): string {
  if (!rows.length) return "";
  const cols = Object.keys(rows[0]);
  const lines = [cols.join(",")];
  for (const r of rows) lines.push(cols.map((c) => csvCell(r[c] ?? "")).join(","));
  /* A UTF-8 BOM, deliberately. Excel on Windows reads a BOM-less UTF-8 CSV as the system
   * codepage and renders every Arabic title as mojibake — which for an Arabic-first archive
   * means the export looks broken to the people most likely to open it. Every other
   * consumer tolerates the BOM. */
  return "﻿" + lines.join("\r\n") + "\r\n";
}

/* ── Run ─────────────────────────────────────────────────────── */

const manifest = await getJson("/manifest.json") as { release?: string };
const release = String(manifest.release ?? "").replace(/\/$/, "");
if (!release) {
  console.error("manifest.json names no release");
  Deno.exit(1);
}
console.log(`release: ${release}`);

const ids: string[] = [];
for (let page = 1; ; page++) {
  let feed: { items?: Array<{ id?: string }> };
  try {
    feed = await getJson(`${release}/feed/page-${page}.json`) as typeof feed;
  } catch {
    break; // the page after the last is a 404, which is how the feed ends
  }
  const items = feed.items ?? [];
  if (!items.length) break;
  for (const i of items) if (i.id) ids.push(i.id);
}
console.log(`items in the feed: ${ids.length}`);

const records = [];
for (const id of ids) {
  const item = await getJson(`${release}/item/${id}.json`) as Shard;
  records.push(toDublinCore(item));
}

await Deno.mkdir(OUT, { recursive: true });

const json = {
  "@context": "http://purl.org/dc/terms/",
  generated_on: new Date().toISOString().slice(0, 10), // §7: day precision, here too
  release,
  count: records.length,
  items: records,
};
await Deno.writeTextFile(`${OUT}/archive.json`, JSON.stringify(json, null, 2) + "\n");
await Deno.writeTextFile(`${OUT}/archive.csv`, toCsv(records));

console.log(`wrote ${OUT}/archive.json and ${OUT}/archive.csv — ${records.length} items`);

/* A last, cheap guard rather than a promise. The export is assembled from published shards
 * and structurally cannot contain an address, but "structurally cannot" is what everyone
 * says right up until a shard gains a field. Grep the output for the one thing §7 names. */
const written = await Deno.readTextFile(`${OUT}/archive.json`);
if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(written)) {
  console.error("REFUSING: an email address appears in the export (CLAUDE.md §7)");
  Deno.exit(1);
}
console.log("checked: no email address in the export");
