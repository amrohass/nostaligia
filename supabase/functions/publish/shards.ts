/* The shard builder. Rows in, files out, nothing else.
 *
 * §2's read path: manifest.json → feed/page-N.json, geo/{cell}.json, decade/{d}.json,
 * item/{id}.json, all immutable under /v/{ISO-ts}/ and all served from the CDN with
 * `max-age=31536000`. This module decides what is IN those files. Writing them to R2,
 * validating them and flipping the pointer is the publisher's job (piece 3).
 *
 * Pure on purpose — no fetch, no Deno, no clock. A shard is the most consequential output
 * in the system: it is cached for a year, served to everyone, and copied onward by anyone
 * who saves the page. If something is wrong in here it is wrong in public and it stays
 * wrong. A pure function can be given a hostile row and inspected byte by byte, which is
 * what shards.test.ts does.
 *
 * ── §7, and why this is an allowlist ─────────────────────────
 *
 * "The aggregate is more dangerous than any single item: one identity plus full
 * contribution history plus precise coordinates plus timestamps is a de-anonymization
 * vector."
 *
 * Every public shape below is built field by field from a named list. Not `delete
 * row.location`, not a denylist, not a spread with omissions — an allowlist, because the
 * failure mode of every other approach is a column added in some future migration that
 * flows straight out to the CDN because nobody remembered to exclude it. A column added
 * to an allowlist appears nowhere until someone decides it should.
 *
 * The six that must never appear, and why each is not merely tidiness:
 *
 *   location            §7: publish location_public, never location. The fuzzing in 0021
 *                       is worthless if the raw point ships beside it.
 *   created_by          The auth user id. Stable, global, and joins a contributor's every
 *                       item together forever. The author is named by HANDLE, which §7
 *                       makes public and user-chosen precisely so it can be.
 *   ingest_object_key   Begins with the uploader's uuid — the same finding that moved
 *                       public derivative paths to be keyed by post id in M1 piece 3.
 *   created_at          §7: "Public timestamps are day-precision." An exact submission
 *                       time is a movement record.
 *   consent             Contains a legal record about a person. Internal, forever.
 *   content_hash /      Moderation machinery. approved_by names a specific moderator, and
 *   approved_by         a moderator identifiable per-item is a moderator who can be
 *                       pressured per-item.
 *
 * ── Determinism ──────────────────────────────────────────────
 *
 * §2 rebuilds "only changed shards". That means the publisher compares what it just built
 * against what is live, so identical input must produce identical BYTES — not merely equal
 * objects. stableStringify sorts keys at every level; nothing here reads a clock.
 */

/** §9's budget covers "HTML + CSS + JS + first feed page", so the first page has to be small. */
export const FEED_PAGE_SIZE = 24;

/**
 * Geohash precision for the geo/ shards.
 *
 * 5 characters is roughly 4.9 km × 4.9 km — one cell covers Ramallah, which for an archive
 * of one city means the map fetches one file. That is the correct answer for this archive
 * and an obviously wrong one for a bigger geography, so it is a constant with a comment
 * rather than a number in a loop: raising it to 6 (~1.2 km × 0.6 km) is a one-line change
 * that costs an extra request per pan.
 */
export const GEO_PRECISION = 5;

const BASE32 = "0123456789bcdefghjkmnpqrstuvwxyz";

export type PostKind = "media" | "voice" | "event";

/**
 * A published comment, as 0044's publishable_posts() nests it.
 *
 * §9 lists comments among the things that "read from content_blocks/shards", and §2's zero
 * database reads makes that mandatory rather than merely tidy: 0015 grants `anon` SELECT on
 * nothing, so a comment a visitor cannot get from a shard is a comment they cannot read.
 *
 * The commenter is named by handle, exactly as the post's author is, and for the same §7
 * reason — created_by is the join key that turns separate remarks into one person's history.
 */
export interface SourceComment {
  id: string;
  body: string;
  lang: string | null;
  /** Day precision (§7), from comments.created_on. */
  day: string;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_path: string | null;
}

/** A profile, as 0044's publishable_profiles() returns it: the public projection, already. */
export interface SourceProfile {
  handle: string;
  display_name: string | null;
  avatar_path: string | null;
  /** profiles.role_cache. DISPLAY ONLY (§4) — nothing may read it as authorization. */
  label: string | null;
  /** Already null unless visibility says public — the decision is 0044's, not this file's. */
  bio: string | null;
  member_since: number | null;
  show_contributions: boolean;
  show_comments: boolean;
}

/** A media_assets row, as the publisher selects it. */
export interface SourceAsset {
  role: "master" | "rendition" | "thumb" | "poster";
  rendition: string | null;
  storage_path: string;
  bucket: "originals" | "public";
  mime: string;
  width: number | null;
  height: number | null;
  duration_s: number | null;
}

/**
 * A posts row as it arrives from the database.
 *
 * Deliberately declares the fields that must NOT be published as well as the ones that must.
 * A type that only listed the safe columns would make the dangerous ones invisible here and
 * `any` at the call site, and the whole point of this module is that somebody reading it can
 * see what was left out.
 */
export interface SourcePost {
  id: string;
  kind: PostKind;
  title_ar: string | null;
  title_en: string | null;
  body_ar: string | null;
  body_en: string | null;
  date_earliest: string | null;
  date_latest: string | null;
  date_precision: string | null;
  decade: number | null;
  location_public: { lat: number; lon: number } | null;
  location_precision: "exact" | "street" | "area" | "hidden";
  place_name_ar: string | null;
  place_name_en: string | null;
  event_starts_at: string | null;
  event_ends_at: string | null;
  venue_ar: string | null;
  venue_en: string | null;
  license: string | null;
  provenance: string | null;
  author_label: string | null;
  author_handle: string | null;
  author_display_name: string | null;
  author_avatar_path: string | null;
  like_count: number;
  comment_count: number;
  /** Published comments only. 0044 filters; nothing here re-decides what may be shown. */
  comments: SourceComment[];
  /** Day precision already, from the `created_on` column §7 exists to make people use. */
  created_on: string;
  media: SourceAsset[];

  // ── Present, and never published. See the header. ──────────
  location?: unknown;
  created_by?: unknown;
  created_at?: unknown;
  ingest_object_key?: unknown;
  consent?: unknown;
  content_hash?: unknown;
  approved_by?: unknown;
  approved_at?: unknown;
  status?: unknown;
  takedown?: unknown;
}

export interface ShardFile {
  /** Relative to the release root, e.g. `feed/page-1.json`. */
  path: string;
  json: string;
}

/* ── Geohash ───────────────────────────────────────────────── */

/**
 * §2: "Geohash is a derived publish-time shard key ONLY."
 *
 * Twenty lines rather than a dependency, and it is derived HERE rather than stored, so
 * there is no column to drift out of agreement with the coordinates it claims to describe.
 */
export function geohash(lat: number, lon: number, precision = GEO_PRECISION): string {
  let latMin = -90, latMax = 90, lonMin = -180, lonMax = 180;
  let hash = "";
  let bit = 0, ch = 0, even = true;

  while (hash.length < precision) {
    if (even) {
      const mid = (lonMin + lonMax) / 2;
      if (lon >= mid) { ch = (ch << 1) | 1; lonMin = mid; } else { ch = ch << 1; lonMax = mid; }
    } else {
      const mid = (latMin + latMax) / 2;
      if (lat >= mid) { ch = (ch << 1) | 1; latMin = mid; } else { ch = ch << 1; latMax = mid; }
    }
    even = !even;
    if (++bit === 5) {
      hash += BASE32[ch];
      bit = 0;
      ch = 0;
    }
  }
  return hash;
}

/* ── Deterministic JSON ────────────────────────────────────── */

/**
 * JSON with object keys sorted at every level.
 *
 * The publisher decides whether to rewrite a shard by comparing bytes. JSON.stringify
 * preserves insertion order, so two runs that built the same object through different code
 * paths would serialise differently and every shard would look changed on every publish —
 * which turns "rebuild only changed shards" into "rebuild everything", quietly, with the
 * only symptom being a CDN bill.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = sortDeep(v);
    }
    return out;
  }
  return value;
}

/* ── The public shapes ─────────────────────────────────────── */

/**
 * The author, as a shard may name them.
 *
 * §7: "handle is user-chosen, NOT a legal name" and "Handle and avatar are always public."
 * The auth user id is not here and must not be: it is the join key that turns a set of
 * separate contributions into one person's complete history.
 */
function author(row: SourcePost) {
  if (!row.author_handle) return null;
  return {
    handle: row.author_handle,
    display_name: row.author_display_name ?? null,
    avatar_path: row.author_avatar_path ?? null,
    label: row.author_label ?? "member",
  };
}

/**
 * Only what the CDN may serve.
 *
 * §6: "NEVER serve a row with bucket='originals' through the public CDN path." The master
 * is dropped here, not filtered downstream — a shard that named it would be a permanent,
 * cached, world-readable index of the archival originals, which is a worse disclosure than
 * any single URL because it is the whole map.
 */
function publicMedia(assets: SourceAsset[]) {
  return assets
    .filter((a) => a.bucket === "public")
    .map((a) => ({
      role: a.role,
      rendition: a.rendition,
      path: a.storage_path,
      mime: a.mime,
      width: a.width,
      height: a.height,
      duration_s: a.duration_s,
    }))
    .sort((a, b) => (a.role + (a.rendition ?? "")).localeCompare(b.role + (b.rendition ?? "")));
}

/** The card. Small, because §9's budget counts the first feed page. */
export function feedEntry(row: SourcePost) {
  const thumb = publicMedia(row.media).find((m) => m.role === "thumb");
  return {
    id: row.id,
    kind: row.kind,
    title_ar: row.title_ar,
    title_en: row.title_en,
    decade: row.decade,
    date_precision: row.date_precision,
    thumb: thumb ? thumb.path : null,
    author: author(row),
    likes: row.like_count,
    comments: row.comment_count,
    day: row.created_on,
  };
}

/**
 * One published comment, allowlisted.
 *
 * `status` does not travel, and its absence is the point: only 'published' rows reach this
 * function at all, so a status field in the shard could only ever say "published" — and a
 * field that is always the same value is a field somebody will one day set differently.
 * created_by is absent for the reason the header gives about the post's author.
 */
function publicComment(c: SourceComment) {
  return {
    id: c.id,
    body: c.body,
    lang: c.lang ?? null,
    day: c.day,
    author: c.author_handle
      ? {
        handle: c.author_handle,
        display_name: c.author_display_name ?? null,
        avatar_path: c.author_avatar_path ?? null,
      }
      : null,
  };
}

/**
 * The item page. Everything public about one post, and nothing else.
 *
 * Note the deliberate asymmetry with feedEntry: there, `comments` is a NUMBER, because a
 * card has room for a count and §9's budget counts the first feed page. Here it is the
 * thread, and the count travels beside it as `comment_count`. Two shapes, two jobs; the key
 * that means a number is spelled differently from the key that means a list.
 */
export function publicPost(row: SourcePost) {
  return {
    id: row.id,
    kind: row.kind,
    title_ar: row.title_ar,
    title_en: row.title_en,
    body_ar: row.body_ar,
    body_en: row.body_en,
    date_earliest: row.date_earliest,
    date_latest: row.date_latest,
    date_precision: row.date_precision,
    decade: row.decade,
    // §7: the fuzzed point, and nothing at all when the contributor said hidden. 0021
    // already derives location_public as null for 'hidden', so this is the second of two
    // independent reasons the coordinate does not ship — deliberately, because the first
    // one is a trigger somebody could disable in a migration.
    location: row.location_precision === "hidden" ? null : row.location_public,
    location_precision: row.location_precision,
    place_ar: row.place_name_ar,
    place_en: row.place_name_en,
    event_starts_at: row.event_starts_at,
    event_ends_at: row.event_ends_at,
    venue_ar: row.venue_ar,
    venue_en: row.venue_en,
    license: row.license,
    provenance: row.provenance,
    author: author(row),
    likes: row.like_count,
    comment_count: row.comment_count,
    comments: (row.comments ?? []).map(publicComment),
    day: row.created_on,
    media: publicMedia(row.media),
  };
}

/* ── content.json ──────────────────────────────────────────── */

/** `content_blocks`, published half only, as {key: {ar, en}}. §9's single source of truth. */
export type ContentBlocks = Record<string, { ar?: string; en?: string }>;

/**
 * The whole of the site's editable copy, in one file.
 *
 * One file rather than one per block: there are a few dozen blocks totalling a few
 * kilobytes, every page needs several of them, and §9's budget counts the first paint. A
 * shard per block would be a few dozen requests to render a header.
 */
export function contentFile(blocks: ContentBlocks): ShardFile {
  return { path: "content.json", json: stableStringify({ blocks }) };
}

/* ── profile/{handle}.json ─────────────────────────────────── */

/**
 * One profile page, as everyone sees it.
 *
 * §7: "Handle and avatar are always public. Everything else on a profile (bio,
 * contributions, comments) is governed by profiles.visibility." 0044 has already applied
 * that to `bio`; the two lists are gated here, because they are assembled here.
 *
 * A hidden list is an EMPTY list, never a missing key and never the list with a flag beside
 * it. A flag would put the data in the file and ask the client to be discreet about it,
 * which is the same mistake as hiding unapproved content in the browser (§5).
 *
 * Attribution is not gated and cannot be: a contributor who hides their contribution LIST
 * still appears as the author on each card, because §7 makes handle and avatar public
 * precisely so the archive can keep crediting people. What visibility governs is the
 * aggregate — the page that collects one person's whole history in one place, which is the
 * de-anonymisation vector §7 names.
 */
export function profileFile(profile: SourceProfile, rows: SourcePost[]): ShardFile {
  const handle = profile.handle;

  const contributions = profile.show_contributions
    ? rows.filter((r) => r.author_handle === handle).map(feedEntry)
    : [];

  // Flattened from the posts rather than queried separately: the comment bodies are already
  // in hand, and a second query would be a second chance for the two to disagree about which
  // comments are published.
  const comments = profile.show_comments
    ? rows.flatMap((r) =>
      (r.comments ?? [])
        .filter((c) => c.author_handle === handle)
        .map((c) => ({
          id: c.id,
          post_id: r.id,
          post_title_ar: r.title_ar,
          post_title_en: r.title_en,
          body: c.body,
          lang: c.lang ?? null,
          day: c.day,
        }))
    )
    : [];

  // Newest first, then by id — the same tie-break buildShards uses, for the same reason: an
  // unstable order rewrites the shard on every publish.
  comments.sort((a, b) => (a.day === b.day ? a.id.localeCompare(b.id) : b.day.localeCompare(a.day)));

  return {
    // Lower-cased because a handle is a URL segment and a URL segment is what a browser
    // sends. `normalized_handle` already folds case on the database side, so the stored
    // handle is lower-case for Latin script and unchanged for Arabic, which has none.
    path: `profile/${handle.toLowerCase()}.json`,
    json: stableStringify({
      handle,
      display_name: profile.display_name ?? null,
      avatar_path: profile.avatar_path ?? null,
      label: profile.label ?? "member",
      bio: profile.bio ?? null,
      member_since: profile.member_since ?? null,
      contributions,
      comments,
    }),
  };
}

/* ── The shards ────────────────────────────────────────────── */

/**
 * Every file in a release except manifest.json, which the publisher writes last because it
 * is the pointer and must not exist until everything it points at does.
 *
 * Rows arrive already filtered to approved and not-taken-down; this module does not decide
 * what is publishable, only what publishing looks like. That split is deliberate: the
 * predicate belongs in SQL beside the RLS policies that share it, not in a TypeScript file
 * that could disagree with them.
 */
export function buildShards(rows: SourcePost[]): ShardFile[] {
  // Newest first, then by id so ties are ordered rather than arbitrary — an unstable sort
  // key would reshuffle pages on every publish and invalidate every cached page with them.
  const ordered = [...rows].sort((a, b) =>
    a.created_on === b.created_on
      ? a.id.localeCompare(b.id)
      : b.created_on.localeCompare(a.created_on)
  );

  const files: ShardFile[] = [];

  // ── feed/page-N.json ──
  const pages = Math.max(1, Math.ceil(ordered.length / FEED_PAGE_SIZE));
  for (let p = 0; p < pages; p++) {
    const slice = ordered.slice(p * FEED_PAGE_SIZE, (p + 1) * FEED_PAGE_SIZE);
    files.push({
      path: `feed/page-${p + 1}.json`,
      json: stableStringify({
        page: p + 1,
        pages,
        total: ordered.length,
        items: slice.map(feedEntry),
      }),
    });
  }

  // ── item/{id}.json ──
  for (const row of ordered) {
    files.push({ path: `item/${row.id}.json`, json: stableStringify(publicPost(row)) });
  }

  // ── decade/{d}.json ──
  const byDecade = new Map<number, SourcePost[]>();
  for (const row of ordered) {
    if (row.decade === null) continue;
    const list = byDecade.get(row.decade) ?? [];
    list.push(row);
    byDecade.set(row.decade, list);
  }
  for (const decade of [...byDecade.keys()].sort((a, b) => a - b)) {
    files.push({
      path: `decade/${decade}.json`,
      json: stableStringify({
        decade,
        total: byDecade.get(decade)!.length,
        items: byDecade.get(decade)!.map(feedEntry),
      }),
    });
  }

  // ── geo/{cell}.json ──
  //
  // 'hidden' contributes nothing to any cell. Not an empty entry, not a cell with a null
  // coordinate — nothing, because appearing in a geo shard at all is itself a disclosure:
  // it says this item is somewhere in this square, which is exactly what hiding the
  // location was meant to prevent.
  const byCell = new Map<string, SourcePost[]>();
  for (const row of ordered) {
    if (row.location_precision === "hidden" || !row.location_public) continue;
    const cell = geohash(row.location_public.lat, row.location_public.lon);
    const list = byCell.get(cell) ?? [];
    list.push(row);
    byCell.set(cell, list);
  }
  for (const cell of [...byCell.keys()].sort()) {
    files.push({
      path: `geo/${cell}.json`,
      json: stableStringify({
        cell,
        total: byCell.get(cell)!.length,
        items: byCell.get(cell)!.map((row) => ({
          ...feedEntry(row),
          lat: row.location_public!.lat,
          lon: row.location_public!.lon,
          precision: row.location_precision,
        })),
      }),
    });
  }

  // ── index.json ──
  //
  // What this release CONTAINS: how many feed pages, which decades have items, which geo
  // cells exist. One small file, immutable with the release like everything else here.
  //
  // It exists because the alternative is guessing. Without it the front end has to carry a
  // hardcoded decade list and a hardcoded geohash cell for Ramallah — two constants that
  // are correct today, silently wrong the first time somebody contributes a 1940s
  // photograph or an item from outside the city, and wrong in the direction where the
  // content exists and simply never appears. The publisher already knows the answer;
  // writing it down costs a few hundred bytes and removes both constants.
  //
  // Derived from what was just built rather than recomputed, so it cannot disagree with the
  // files it describes.
  files.push({
    path: "index.json",
    json: stableStringify({
      pages,
      total: ordered.length,
      decades: [...byDecade.keys()].sort((a, b) => a - b),
      cells: [...byCell.keys()].sort(),
    }),
  });

  return files.sort((a, b) => a.path.localeCompare(b.path));
}
