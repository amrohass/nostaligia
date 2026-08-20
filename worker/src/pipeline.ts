// quarantine object in, derivatives out, one RPC either way.
//
// ── The failure split is the most important thing here ───────
//
// Every failure is either PERMANENT or TRANSIENT and they are handled in opposite
// directions:
//
//   permanent   the bytes are the problem — unrecognised, SVG, too long, will not decode.
//               fail_ingest. Terminal. The uploader is told why and the slot is spent.
//   transient   the world is the problem — R2 unreachable, PostgREST refusing the call,
//               the instance running out of room. NO RPC AT ALL, and a non-2xx back to
//               complete-upload so it releases the row for a retry.
//
// Calling fail_ingest on a transient error would burn a contributor's upload over a network
// blip, and fail_ingest is terminal — nothing walks it back. When in doubt this code treats
// a failure as transient, because the cost of being wrong that way is a retry and the cost
// of being wrong the other way is a lost photograph.
//
// ── Preservation happens before delivery ─────────────────────
//
// The master is copied to originals/ BEFORE any transcode starts. §6 calls it "the archival
// copy and the thing an institutional partner would want on deposit"; if this process dies
// halfway through a 20-minute ladder, the copy that matters already exists. Doing it last
// would mean the most valuable artefact is the one most likely to be lost.

import { SNIFF_LENGTH, sniff } from "../../supabase/functions/_shared/magic-bytes.ts";
import type { AssetRow, IngestReporter } from "./db.ts";
import type { Bucket, ObjectStore } from "./store.ts";
import type { Job } from "./job.ts";
import {
  audioArgs,
  DURATION_CEILING_S,
  imageArgs,
  parseProbe,
  POSTER_AT_S,
  posterArgs,
  probeArgs,
  type Rendition,
  thumbArgs,
  VIDEO_LADDER,
  videoArgs,
  videoRungs,
  waveformArgs,
} from "./ladder.ts";

export interface FfmpegResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface Ffmpeg {
  run(bin: "ffmpeg" | "ffprobe", args: string[]): Promise<FfmpegResult>;
}

/**
 * Wall-clock ceiling for a WHOLE job, across every ffmpeg invocation it makes.
 *
 * ── Why this is not the same thing as JOB_TIMEOUT_MS ─────────
 *
 * main.ts arms a fresh watchdog per spawned process, so it bounds ONE wedged decoder and
 * not the job: a video makes six invocations (four rungs, poster, thumb), so the watchdog
 * alone permits 6 x 25 = 150 minutes before the last timer fires. Both exist and they
 * bound different things — the watchdog kills a hung process, this refuses to start more
 * work once the job as a whole has run too long.
 *
 * ── Derivation ───────────────────────────────────────────────
 *
 * Measured in CI, the same ladder at two source lengths so fixed and marginal cost come
 * apart (worker/scripts/ladder-fixture.ts --duration, run at 3840x2160):
 *
 *     3s  source -> 8.9s wall        slope     2.267 s wall per s source
 *     30s source -> 70.1s wall       intercept 2.1 s fixed
 *
 * §6's largest legitimate job is a moderator's 20-minute master:
 *
 *     1200 x 2.267 + 2.1                        = 45.4 min   measured, extrapolated
 *     x1.9   4 vCPU runner -> Cloud Run --cpu=2 = 86 min     x264 scales sub-linearly
 *     x2     testsrc -> real footage            = 172 min    ESTIMATE, NOT MEASURED
 *     +5 min 4 GB down, ~1.2 GB of renditions up = 177 min
 *     x1.35  safety                              = 240 min
 *
 * **The x2 is a guess and it is the dominant term.** lavfi's testsrc is flat, low-motion
 * and highly compressible — close to a best case for x264 — while real 4K footage carries
 * grain and camera motion. CI cannot measure the difference, because committing real 4K
 * footage is what ladder-fixture.ts's header refuses. A one-off measurement against the
 * deployed worker with real footage is the only thing that settles it.
 *
 * Being generous here is close to free: the cost of too long is that a wedged job burns
 * longer before it is killed, which is exactly today's behaviour. It is NOT free once
 * public.reap_stale_ingests exists, because that lease is derived from this number and
 * every minute here is a minute a stranded upload stays invisible. That is why the lease
 * is deliberately not written yet.
 */
export const JOB_DEADLINE_MS = 240 * 60 * 1000;

export interface PipelineDeps {
  store: ObjectStore;
  reporter: IngestReporter;
  ffmpeg: Ffmpeg;
  /** A directory this job owns. The caller creates it and removes it. */
  workDir: string;
  /**
   * Epoch ms after which no NEW work starts. processJob fills this in from
   * JOB_DEADLINE_MS; tests set it directly. Work already in flight is not interrupted —
   * that is the per-invocation watchdog's job.
   */
  deadlineAt?: number;
  /** Injectable only so the deadline is testable without waiting four hours. */
  now?: () => number;
}

export type Outcome =
  | { kind: "ready"; assets: AssetRow[] }
  | { kind: "failed"; reason: string }
  | { kind: "transient"; error: string };

/** Thrown for anything the uploader is responsible for. Anything else is transient. */
class PermanentFailure extends Error {}

/**
 * Where a derivative lives in the public bucket.
 *
 * Keyed by POST ID, never by the object key — and this is a §7 rule, not a tidiness
 * preference. The object key is `{uploader_uuid}/{random}`, so a CDN URL built from it
 * publishes the uploader's user id in every image src on the site. Anyone could then group
 * the entire archive by contributor from the HTML alone: "one identity plus full
 * contribution history plus precise coordinates" is the exact aggregate §7 names as a
 * de-anonymisation vector, and it would have been handed out for free in a filename.
 *
 * The master keeps the object key, because originals/ is never CDN-fronted and the
 * uploader's id there is provenance rather than exposure.
 */
function publicPath(postId: string, leaf: string): string {
  return `${postId}/${leaf}`;
}

/** The ladder rung whose height an output actually reached. Derived, never guessed. */
function rungForHeight(height: number): Rendition {
  const hit = VIDEO_LADDER.find((r) => r.height <= height);
  return hit ? hit.name : "480p";
}

/**
 * Refuses to start more work once the job's wall clock is spent.
 *
 * A PermanentFailure rather than a transient one, deliberately. A job that has run for
 * four hours will run for four hours again on the next attempt — it is the file that is
 * the problem, whether it is pathological or simply larger than this system can serve —
 * so retrying it twice more would spend twelve hours to reach the same place. The uploader
 * is told, `ingest_error` names it specifically, and §6's cost ceiling is respected.
 */
function checkDeadline(deps: PipelineDeps, what: string): void {
  const now = deps.now?.() ?? Date.now();
  if (deps.deadlineAt !== undefined && now >= deps.deadlineAt) {
    // `what` is a constant from this file, never attacker-derived, so it is safe to put in
    // an error the uploader will read.
    throw new PermanentFailure(`job_deadline_exceeded_before_${what}`);
  }
}

async function probe(deps: PipelineDeps, path: string) {
  checkDeadline(deps, "probe");
  const r = await deps.ffmpeg.run("ffprobe", probeArgs(path));
  if (r.code !== 0) throw new PermanentFailure("probe_failed");
  return parseProbe(r.stdout);
}

async function encode(deps: PipelineDeps, args: string[], what: string): Promise<void> {
  // Checked before EACH invocation, which is what makes the remaining rungs abort: a
  // 4-rung ladder that blows its budget on rung two does not go on to encode three and
  // four before anybody notices.
  checkDeadline(deps, what);
  const r = await deps.ffmpeg.run("ffmpeg", args);
  if (r.code !== 0) {
    // ffmpeg's stderr is derived from attacker-supplied bytes and never reaches the
    // uploader — `what` is a constant from this file. The stderr belongs in the instance
    // log, where an operator can read it and a contributor cannot.
    console.error(`ffmpeg ${what} failed: ${r.stderr.slice(0, 2000)}`);
    throw new PermanentFailure(`encode_failed_${what}`);
  }
}

export async function processJob(job: Job, deps: PipelineDeps): Promise<Outcome> {
  // Started HERE rather than in main.ts, so every caller gets the deadline — the fixture
  // scripts and the tests included — and none of them has to remember to set it. An
  // explicit deadlineAt from a test wins.
  const withDeadline: PipelineDeps = {
    ...deps,
    deadlineAt: deps.deadlineAt ?? (deps.now?.() ?? Date.now()) + JOB_DEADLINE_MS,
  };

  try {
    return await run(job, withDeadline);
  } catch (e) {
    if (e instanceof PermanentFailure) {
      try {
        await deps.reporter.fail(job.object_key, e.message);
      } catch (reportErr) {
        // The file is bad AND the database is unreachable. Reporting the second is the only
        // useful thing left: the row stays in 'processing' and complete-upload releases it,
        // so the uploader retries and gets the same permanent refusal once the database is
        // back. That is the right end state.
        return { kind: "transient", error: `fail_ingest unreachable: ${reportErr}` };
      }
      return { kind: "failed", reason: e.message };
    }
    return { kind: "transient", error: String(e) };
  }
}

async function run(job: Job, deps: PipelineDeps): Promise<Outcome> {
  const key = job.object_key;

  // ── 1 · what is this, really (§6: magic bytes, not extension) ──
  const headBytes = await deps.store.head("quarantine", key, SNIFF_LENGTH);
  const sniffed = sniff(headBytes);

  if (sniffed === null) throw new PermanentFailure("unrecognised_format");
  // §6 names SVG specifically. The sniffer catches it by content, so a .jpg that is really
  // an SVG document is refused here rather than being handed to a decoder.
  if (sniffed.mime.startsWith("image/svg")) throw new PermanentFailure("svg_rejected");

  // ── 2 · pull it down and measure it ──────────────────────────
  const src = `${deps.workDir}/source`;
  await deps.store.download("quarantine", key, src);
  const meta = await probe(deps, src);
  const masterBytes = (await Deno.stat(src)).size;

  if (sniffed.family === "video" || sniffed.family === "audio") {
    // A container that will not declare its duration cannot be checked against the ceiling,
    // and an unbounded transcode is exactly what the ceiling exists to prevent. Refused
    // rather than assumed short.
    if (meta.durationS === null) throw new PermanentFailure("undeclarable_duration");
    if (meta.durationS > DURATION_CEILING_S) {
      throw new PermanentFailure("over_duration_ceiling");
    }
  }
  if (sniffed.family === "video" && (!meta.hasVideo || meta.height === null)) {
    throw new PermanentFailure("no_video_stream");
  }
  if (sniffed.family === "audio" && !meta.hasAudio) {
    throw new PermanentFailure("no_audio_stream");
  }
  if (sniffed.family === "image" && !meta.hasVideo) {
    throw new PermanentFailure("no_image_stream");
  }

  // ── 3 · preservation, before anything else ───────────────────
  //
  // Server-side copy. The master is up to 4 GB and does not travel through this process a
  // second time — it is already on local disk for the transcode, but re-uploading it would
  // cost the bytes twice and gain nothing.
  await deps.store.copy({ bucket: "quarantine", key }, { bucket: "originals", key });

  const assets: AssetRow[] = [{
    role: "master",
    storage_path: key,
    // §6, and complete_ingest refuses any other combination: the master is the archival
    // copy, it lives in originals/, and originals/ is never CDN-fronted.
    bucket: "originals",
    mime: sniffed.mime,
    bytes: masterBytes,
    width: meta.width,
    height: meta.height,
    duration_s: meta.durationS,
    sort_order: 0,
  }];

  // ── 4 · delivery ─────────────────────────────────────────────
  let order = 1;

  const publish = async (
    localPath: string,
    leaf: string,
    role: AssetRow["role"],
    mime: string,
    rendition: Rendition | null = null,
  ): Promise<void> => {
    const out = await probe(deps, localPath);
    const path = publicPath(job.post_id, leaf);
    const bytes = await deps.store.upload("public" as Bucket, path, localPath, mime);
    assets.push({
      role,
      rendition,
      storage_path: path,
      bucket: "public",
      mime,
      bytes,
      width: out.width,
      height: out.height,
      duration_s: out.durationS,
      sort_order: order++,
    });
  };

  if (sniffed.family === "image") {
    const display = `${deps.workDir}/display.webp`;
    await encode(deps, imageArgs(src, display), "image");
    const displayMeta = await probe(deps, display);
    await publish(
      display,
      "display.webp",
      "rendition",
      "image/webp",
      rungForHeight(displayMeta.height ?? 0),
    );

    const thumb = `${deps.workDir}/thumb.webp`;
    await encode(deps, thumbArgs(display, thumb), "thumb");
    await publish(thumb, "thumb.webp", "thumb", "image/webp");
  } else if (sniffed.family === "video") {
    const rungs = videoRungs(meta.height ?? 0);
    if (rungs.length === 0) throw new PermanentFailure("unreadable_dimensions");

    for (const rung of rungs) {
      const out = `${deps.workDir}/${rung.name}.mp4`;
      await encode(deps, videoArgs(src, out, rung), rung.name);
      await publish(out, `${rung.name}.mp4`, "rendition", "video/mp4", rung.name);
    }

    // §6: "Generate a thumbnail and a poster frame for every video at ingest."
    // Seek to a second in, unless the clip is shorter than that.
    const at = Math.min(POSTER_AT_S, Math.max(0, (meta.durationS ?? 0) / 2));
    const poster = `${deps.workDir}/poster.webp`;
    await encode(deps, posterArgs(src, poster, at), "poster");
    await publish(poster, "poster.webp", "poster", "image/webp");

    // From the poster, not from the master: one already-decoded frame instead of seeking
    // into a 4 GB file a second time.
    const thumb = `${deps.workDir}/thumb.webp`;
    await encode(deps, thumbArgs(poster, thumb), "thumb");
    await publish(thumb, "thumb.webp", "thumb", "image/webp");
  } else {
    const out = `${deps.workDir}/audio.opus`;
    await encode(deps, audioArgs(src, out), "audio");
    await publish(out, "audio.opus", "rendition", "audio/ogg", "audio");

    // A voice note is otherwise a blank tile in a grid built for photographs.
    const wave = `${deps.workDir}/thumb.webp`;
    await encode(deps, waveformArgs(src, wave), "waveform");
    await publish(wave, "thumb.webp", "thumb", "image/webp");
  }

  assertManifest(assets);

  // ── 5 · report ───────────────────────────────────────────────
  const res = await deps.reporter.complete(key, sniffed.mime, assets);
  if (res.ok !== true) {
    // The database refused a manifest that passed assertManifest, so the two disagree about
    // what a valid asset set is. That is a bug in this worker, not a bad file — transient,
    // so it is retried and shows up in the logs rather than burning the upload.
    return { kind: "transient", error: `complete_ingest refused: ${res.reason}` };
  }

  // Best-effort. §6 has a lifecycle rule purging orphans after 30 days, so a failure here
  // costs storage for a month and nothing else — it must never fail the job, which has
  // already succeeded.
  try {
    await deps.store.remove("quarantine", key);
  } catch (e) {
    console.error(`quarantine cleanup failed for ${key}: ${e}`);
  }

  return { kind: "ready", assets };
}

/**
 * The same rules complete_ingest enforces, checked before the call rather than after.
 *
 * Not redundant with the database. The database is the authority and refuses a bad manifest
 * outright — but by then the bytes are already in a bucket. Catching it here means a
 * mistake in this file surfaces as a bug report from CI, not as a master sitting in the
 * public bucket with its EXIF intact waiting for the RPC to say no.
 */
export function assertManifest(assets: AssetRow[]): void {
  const masters = assets.filter((a) => a.role === "master");
  if (masters.length !== 1) {
    throw new Error(`expected exactly one master, got ${masters.length}`);
  }
  if (masters[0].bucket !== "originals") {
    throw new Error("the master must be in originals/ (CLAUDE.md §6)");
  }
  for (const a of assets) {
    if (a.role !== "master" && a.bucket !== "public") {
      throw new Error(`a ${a.role} in ${a.bucket}/ would never reach the CDN`);
    }
    if ((a.role === "rendition") !== (a.rendition != null)) {
      throw new Error(`${a.role} and rendition=${a.rendition} disagree`);
    }
    if (/^image\/svg/.test(a.mime)) throw new Error("SVG is refused (CLAUDE.md §6)");
  }
}
