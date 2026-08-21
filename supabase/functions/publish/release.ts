/* The publish sequence. §2, in order, with the order as the safety property.
 *
 *     lease → read → build → WRITE EVERYTHING → validate → record → flip → item pages
 *           → release lease
 *
 * ── Why the order is the whole design ────────────────────────
 *
 * §10's M2 exit criterion: "a killed build never becomes visible."
 *
 * Nothing a visitor can reach changes until the second-to-last step. Every shard is written
 * to `/v/{ISO-ts}/`, a path nothing points at, under keys nobody has ever requested. A
 * publisher killed at any point before the flip leaves an orphan directory and a `releases`
 * row marked inactive — which is litter, not an outage. The flip is one small object.
 *
 * The prerendered item pages are the one exception, and they are last for that reason. They
 * cannot live under /v/ — a permalink that needed the manifest resolved first would put a
 * request in front of every link anyone has ever shared — so they are written at the root,
 * after the flip, and a failure among them does not fail the release. See step 9.
 *
 * That is also why validation sits between writing and flipping rather than before writing:
 * the thing worth validating is what actually landed in the bucket, not what we intended to
 * send. A publisher that checked its own in-memory plan and then half-uploaded it would pass
 * its own review and ship a broken release.
 *
 * ── Injected everything ──────────────────────────────────────
 *
 * Deps carries the database, the object store and the clock. Not for tidiness: the sequence
 * above has failure modes at every step — the lease is held, the hash check drops a row, an
 * upload fails halfway, the flip fails after a successful write — and every one of them
 * needs a test that says what the archive looks like afterwards. None of those are reachable
 * against real R2 without deliberately breaking real R2.
 */

import {
  buildShards,
  type ContentBlocks,
  contentFile,
  profileFile,
  publicPost,
  type ShardFile,
  type SourcePost,
  type SourceProfile,
  stableStringify,
} from "./shards.ts";
import { itemPage, itemPageKey } from "./prerender.ts";
import type { ObjectSink } from "../_shared/r2.ts";

// Re-exported so this module's callers and tests keep one import for the whole sequence.
export type { ObjectSink };

/** The database, as this function uses it. Every call is one PostgREST RPC. */
export interface Db {
  publishablePosts(): Promise<Array<SourcePost & { hash_matches?: boolean }>>;
  redactedPostIds(): Promise<string[]>;
  /** content_blocks, published half only (0043). Section 9's single source of truth. */
  contentBlocks(): Promise<ContentBlocks>;
  /** The public projection of every profile the archive names (0044). */
  publishableProfiles(): Promise<SourceProfile[]>;
  /**
   * Posts that must NOT have a prerendered page, for the reason in step 9.
   *
   * The complement of publishablePosts, and asked for as its own call rather than derived
   * by subtracting: the publisher only ever sees rows it may publish, so it has no way to
   * know that a post it published last week was withdrawn this morning. Without this list
   * that post's /item/{id} would keep serving its full text from the root of the bucket
   * after it had vanished from every shard.
   */
  unpublishablePostIds(): Promise<string[]>;
  /**
   * The revisions come back with the lease, and that is the whole reason they are here.
   *
   * §2's debounce compares what is live against the revision the ACTIVE release was built
   * from, and "built from" has to mean "as of before the archive was read". This call
   * happens under the advisory lock, before publishablePosts(); recordRelease() happens
   * thirty to ninety seconds later, after every object has landed. Reading the revision at
   * that later point would count an approval that arrived mid-build as already published,
   * and that approval would then never publish at all.
   */
  claimLease(holder: string, ttlSeconds: number, note: string): Promise<{
    acquired: boolean;
    reason: string;
    content_revision?: number;
    counter_revision?: number;
  }>;
  /**
   * The claim-time revision goes back with the lease, and it is what closes the gap the
   * cron used to cover.
   *
   * publish() claims, then reads. An approval committing between those two moments is not
   * in this release, and its own dispatch was refused `held` by the lease it collided
   * with — so with no cron, nothing would ever ask again. 0042 compares this number against
   * the revision at release time and dispatches once if it moved.
   *
   * Passing it only on the paths that got a lease is deliberate: the comparison must mean
   * "changed while I held it", never "there is work outstanding", or a build that fails
   * repeatedly would re-dispatch forever.
   */
  releaseLease(holder: string, claimedContentRevision?: number): Promise<void>;
  /**
   * Both of these carry the holder, and 0038 refuses them without a live lease held by it.
   *
   * The lease used to govern who may BEGIN a publish and nothing about who may finish one —
   * so a publisher whose TTL lapsed mid-build could still flip its now-stale release over a
   * newer one that another publisher had already put live. Passing the holder is what makes
   * the lease cover the writes as well as the start.
   */
  recordRelease(
    path: string,
    contentRevision: number,
    counterRevision: number,
    holder: string,
  ): Promise<{ recorded: boolean; id?: string; reason?: string }>;
  activateRelease(
    id: string,
    holder: string,
  ): Promise<{ activated: boolean; reason?: string; previous_path?: string | null }>;
}

export interface Deps {
  db: Db;
  sink: ObjectSink;
  /** The release timestamp and the lease holder. Injected so a test can assert exact keys. */
  now: () => Date;
  newHolder: () => string;
  /**
   * SITE_ORIGIN — where a shared link points. Every og:url and canonical link in every
   * prerendered page is built from it, so a wrong value produces pages that look correct
   * and send every reader to a host that is not this one. config/site.json carries it and
   * the generator prints the `supabase secrets set` line.
   */
  siteOrigin: string;
  /** CDN_ORIGIN, or "" — with no CDN there is no absolute image URL, so no og:image. */
  cdnOrigin: string;
}

export interface PublishOutcome {
  published: boolean;
  reason: string;
  release?: string;
  previous?: string | null;
  files?: number;
  posts?: number;
  /** Rows §5 refused. Reported, never silently dropped — see below. */
  rejectedHashes?: string[];
  redacted?: number;
  /** Prerendered item pages written, and the ones that could not be. Step 9. */
  pages?: number;
  pagesFailed?: string[];
}

/** §2: "TTL 30–60 s" on the pointer, immutable for everything under /v/. */
const MANIFEST_CACHE = "public, max-age=45, must-revalidate";
const IMMUTABLE_CACHE = "public, max-age=31536000, immutable";
/**
 * §8: "a short-TTL redactions.json that clients filter against". Shorter than the manifest,
 * because takedown latency must not be bounded by anything — including by the pointer's own
 * cache window. The bytes are already deleted by the time a client reads this; the file is
 * what stops a cached release from rendering a card for something that is gone.
 */
const REDACTIONS_CACHE = "public, max-age=20, must-revalidate";
/**
 * §9's prerendered item pages, and the one cache header in this file that is neither
 * immutable nor near-zero.
 *
 * They cannot be immutable: the object at `item/{id}/index.html` is REWRITTEN in place on
 * every publish — it has to be, because the URL is a permalink somebody pasted into a group
 * chat and it cannot carry a release timestamp (see prerender.ts's itemPageKey).
 *
 * They should not be near-zero either: a preview crawler fetches this once per share, from
 * many edges, and this is the one document in the archive with an audience that arrives in
 * bursts.
 *
 * Five minutes with must-revalidate is the compromise, and the number that makes it safe is
 * not this one — §8's takedown deletes the object itself and purges the CDN path in the same
 * request, so removal has never been bounded by a TTL. What this window bounds is how long a
 * corrected title takes to reach a preview card.
 */
const ITEM_PAGE_CACHE = "public, max-age=300, must-revalidate";

const LEASE_TTL_SECONDS = 300;

/** `/v/2026-08-19T12:34:56Z/` — the shape releases_path_shape already enforces. */
export function releasePath(now: Date): string {
  return `/v/${now.toISOString().replace(/\.\d{3}Z$/, "Z")}/`;
}

/**
 * Everything a release contains, as keys relative to the bucket root.
 *
 * Split out from publish() so a test can assert the CONTENT of a release without a sink at
 * all, and so piece 5's diffing has one place to ask "what would this release be".
 */
export function releaseFiles(
  posts: SourcePost[],
  redacted: string[],
  path: string,
  content: ContentBlocks = {},
  profiles: SourceProfile[] = [],
): ShardFile[] {
  const files = buildShards(posts);

  // §9: "Page copy, cards, events, comments, and the info page all read from
  // content_blocks/shards so the dashboard is the single source of truth." content.json is
  // the first half of that sentence; the comments are inside the item shards buildShards
  // just produced.
  files.push(contentFile(content));

  // One per profile the archive names — see publishable_profiles (0044) for why the set is
  // bounded by the archive rather than by the user table.
  for (const profile of profiles) files.push(profileFile(profile, posts));

  // Written INTO the release as well as at the root. A client that has a release cached for
  // a year and never re-reads the root would otherwise keep rendering a redacted item; this
  // copy is immutable and correct as of the build, and the root copy catches everything
  // after it.
  files.push({ path: "redactions.json", json: stableStringify({ ids: redacted }) });
  return files.map((f) => ({ path: `${path.slice(1)}${f.path}`, json: f.json }));
}

export async function publish(deps: Deps): Promise<PublishOutcome> {
  const holder = deps.newHolder();

  // ── 1 · the lease ──
  const lease = await deps.db.claimLease(holder, LEASE_TTL_SECONDS, "publish");
  if (!lease.acquired) {
    // Not an error. A cron every two minutes will find a publish in progress regularly,
    // and a publisher that logged a failure each time would teach its operator to stop
    // reading the log.
    return { published: false, reason: lease.reason };
  }

  try {
    // ── 2 · read ──
    const candidates = await deps.db.publishablePosts();
    const redacted = await deps.db.redactedPostIds();
    const content = await deps.db.contentBlocks();
    const profiles = await deps.db.publishableProfiles();
    const unpublishable = await deps.db.unpublishablePostIds();

    // §5: "the publisher refuses rows whose hash ≠ approved hash." Refused, and NAMED —
    // a row that silently vanished would look exactly like one that was never approved,
    // and the situation this detects is content altered after approval, which is the one
    // situation somebody needs to hear about rather than be quietly protected from.
    const rejectedHashes = candidates
      .filter((p) => p.hash_matches === false)
      .map((p) => p.id);
    const posts = candidates.filter((p) => p.hash_matches !== false);

    // ── 3 · build ──
    const path = releasePath(deps.now());
    const files = releaseFiles(posts, redacted, path, content, profiles);

    // ── 4 · write everything, while nothing points here ──
    for (const file of files) {
      await deps.sink.put(file.path, file.json, "application/json; charset=utf-8", IMMUTABLE_CACHE);
    }

    // ── 5 · validate what LANDED ──
    //
    // Every file is read back. The manifest is about to name this directory, and the cost
    // of naming a directory with a missing shard is a page that 404s for a year — the CDN
    // will cache the miss too.
    const missing: string[] = [];
    for (const file of files) {
      if (!(await deps.sink.exists(file.path))) missing.push(file.path);
    }
    if (missing.length > 0) {
      return {
        published: false,
        reason: "incomplete_release",
        release: path,
        files: files.length,
        rejectedHashes,
        posts: posts.length,
      };
    }

    // ── 6 · record, still inactive, stamped with the revision the LEASE was claimed at ──
    //
    // Not the revision now. Everything between the claim and this line either made it into
    // the release — in which case stamping the older number costs one spurious republish —
    // or did not, in which case stamping the newer one would lose it silently and forever.
    // The two errors are not symmetric, so the older number is the one to carry.
    //
    // ?? 0 rather than a throw: a database that answered the claim without the revisions is
    // one running an older 0034, and "republish once" is a better failure than "refuse to
    // publish at all" for a mismatch that only a botched deploy can produce.
    const recorded = await deps.db.recordRelease(
      path,
      lease.content_revision ?? 0,
      lease.counter_revision ?? 0,
      holder,
    );
    if (!recorded.recorded || !recorded.id) {
      return { published: false, reason: recorded.reason ?? "record_failed", release: path };
    }

    // ── 7 · the pointer ──
    //
    // Written BEFORE activate_release, because the manifest object is what a browser
    // actually reads and the releases row is bookkeeping. If the row said active and the
    // object still named the old release, the archive would be correct and the ledger
    // would lie; the other way round, for the fraction of a second between these two
    // calls, the ledger lags and the archive is already right.
    await deps.sink.put(
      "manifest.json",
      stableStringify({ release: path, generated_on: deps.now().toISOString().slice(0, 10) }),
      "application/json; charset=utf-8",
      MANIFEST_CACHE,
    );

    // The root redaction list, at its own short TTL. Rewritten on every publish so it is
    // never staler than the last cron tick, and rewritten by takedown immediately (piece 4)
    // so it is usually much fresher than that.
    await deps.sink.put(
      "redactions.json",
      stableStringify({ ids: redacted }),
      "application/json; charset=utf-8",
      REDACTIONS_CACHE,
    );

    const flipped = await deps.db.activateRelease(recorded.id, holder);
    if (!flipped.activated) {
      // The lease lapsed between recording and flipping. The manifest object above already
      // names this release, but the ledger refused to — and the manifest is what a browser
      // reads, so the archive HAS moved. Reported as a failure rather than swallowed: this
      // is the one window where the object and the ledger disagree, and an operator needs
      // to know which release is actually being served.
      return {
        published: false,
        reason: flipped.reason ?? "activate_failed",
        release: path,
        files: files.length,
        posts: posts.length,
        rejectedHashes,
      };
    }

    // ── 9 · the permalinks, after the flip and never fatal ──
    //
    // §9's prerendered item pages are the one thing a release writes OUTSIDE /v/, because a
    // permalink cannot require resolving a pointer first (prerender.ts, itemPageKey). Three
    // consequences, and each is why this step is here rather than in step 4:
    //
    //   · they are written AFTER the flip, so a killed build leaves the previous pages
    //     rather than a set that half-describes a release nobody activated. M2's "a killed
    //     build is never visible" is about the archive the manifest names, and these are not
    //     in it.
    //   · deletions come first. Removing a page is never harmful and a post that stopped
    //     being publishable — withdrawn, rejected after approval — must not keep serving
    //     its full text at a root URL. Takedown does not wait for this (§8): it deletes
    //     the page itself, in the same request as the bytes.
    //
    //     One case is NOT in that list and is worth naming: a row §5's hash check refused.
    //     It is still `status = 'approved'`, so unpublishable_post_ids does not return it,
    //     and its page survives from the last release that did include it. That page shows
    //     the content as APPROVED, not the altered version — the alteration is exactly why
    //     the row was refused — so it is stale rather than a disclosure. It is also
    //     reported: `rejectedHashes` names every such row in the outcome, because §5's
    //     point is that somebody hears about it rather than being quietly protected.
    //   · a failure here does NOT fail the release. The archive is correct without a
    //     prerendered page; the SPA renders the same item from the same shard. Holding the
    //     pointer hostage to a preview card would be the wrong thing to be strict about.
    const pagesFailed: string[] = [];
    let pages = 0;

    for (const id of unpublishable) {
      try {
        await deps.sink.remove(itemPageKey(id));
      } catch {
        pagesFailed.push(itemPageKey(id));
      }
    }

    for (const post of posts) {
      try {
        await deps.sink.put(
          itemPageKey(post.id),
          itemPage(publicPost(post), {
            siteOrigin: deps.siteOrigin,
            cdnOrigin: deps.cdnOrigin,
          }),
          "text/html; charset=utf-8",
          ITEM_PAGE_CACHE,
        );
        pages++;
      } catch {
        pagesFailed.push(itemPageKey(post.id));
      }
    }

    return {
      published: true,
      reason: "published",
      release: path,
      previous: flipped.previous_path ?? null,
      files: files.length,
      posts: posts.length,
      rejectedHashes,
      redacted: redacted.length,
      pages,
      pagesFailed,
    };
  } finally {
    // Always. A publisher that threw while holding the lease would otherwise block every
    // subsequent run until the TTL expired — five minutes of a stale archive for what may
    // have been one bad row.
    //
    // The claim-time revision rides along so 0042 can ask for one more publish if content
    // changed while this build was running. Reached from every exit including the failures,
    // which is the point of it being here rather than at the end of the happy path.
    await deps.db.releaseLease(holder, lease.content_revision).catch(() => {});
  }
}
