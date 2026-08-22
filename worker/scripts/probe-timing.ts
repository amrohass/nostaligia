/* Per-stage wall-clock timing for one real media file, through the real pipeline.
 *
 *     deno run --allow-read --allow-write --allow-run --allow-env \
 *       worker/scripts/probe-timing.ts --file /path/to/clip.mp4 --source real
 *
 * ── Why this is a decorator and not an edit to pipeline.ts ───
 *
 * The number this produces is only worth having if the code it times is the code that
 * runs in production. So nothing here changes the pipeline: `processJob` is called
 * exactly as main.ts calls it, and the timing comes from wrapping the two dependencies
 * it already injects — `Ffmpeg` and `ObjectStore`. Every ffmpeg invocation and every
 * object operation passes through a wrapper on its way to the real one.
 *
 * The alternative — timestamps sprinkled through pipeline.ts — would measure a build of
 * the pipeline that only exists while being measured, and would put instrumentation in
 * the file that carries JOB_DEADLINE_MS. Neither is worth it when the seam is already
 * there.
 *
 * ── How a stage gets its name ────────────────────────────────
 *
 * `encode(deps, args, what)` knows the label but does not pass it to ffmpeg, so a wrapper
 * on Ffmpeg cannot see it. It does not need to: every argv builder in ladder.ts puts the
 * path LAST, so the basename of the final argument names the stage unambiguously —
 * 1440p.mp4, poster.webp, thumb.webp, display.webp, audio.opus. ffprobe is told apart by
 * the `bin` argument rather than the path, because it is the one invocation whose last
 * argument is an input.
 *
 * If ladder.ts ever stops putting the output last, the stage names here degrade to the
 * raw basename rather than going silently wrong — which is why the assertion below
 * checks that every expected stage was actually seen.
 *
 * ── What this does NOT do ────────────────────────────────────
 *
 *  · It does not touch the network. The store is a LocalStore over a temp directory, so
 *    what is measured is DECODE, not transfer. Transfer is a separate term and it is
 *    additive; conflating them would flatter the CPU figure.
 *  · It does not run on Cloud Run, Scaleway, or anything else. Host CPU is stated in the
 *    output so a figure from a laptop is never mistaken for a figure from the deployment.
 *  · It does not derive, propose, or apply a deadline. Raw numbers only — CLAUDE.md §6
 *    keeps that decision with the maintainer.
 *
 * ── --source is mandatory and is not decoration ──────────────
 *
 * §6's dominant estimated term is testsrc-to-real-footage. A synthetic run through this
 * script produces numbers that look exactly like real ones, and the whole point of the
 * probe is that they are not interchangeable. So every record carries the operator's own
 * declaration, and a `synthetic` row is legible as such forever after. Only `real` rows
 * belong in docs/probe-results.md.
 */

import { LocalStore, type Bucket, type ObjectStore } from "../src/store.ts";
import { type Ffmpeg, type FfmpegResult, processJob } from "../src/pipeline.ts";
import { CapturingReporter, RealFfmpeg } from "./lib/harness.ts";

const args = Deno.args;

function arg(name: string, fallback: string | null = null): string | null {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
}

const file = arg("--file");
const source = arg("--source");
const label = arg("--label", null);

if (file === null) {
  console.error("--file <path> is required: a real media file to push through the pipeline");
  Deno.exit(2);
}
if (source !== "real" && source !== "synthetic") {
  console.error(
    "--source must be 'real' or 'synthetic'.\n" +
      "  real       footage from a camera or phone. The only kind that belongs in a probe report.\n" +
      "  synthetic  lavfi/testsrc or anything generated. Fine for exercising this script;\n" +
      "             NOT a measurement — §6's dominant estimate is exactly this difference.",
  );
  Deno.exit(2);
}

// ── the record ───────────────────────────────────────────────

interface StageRecord {
  seq: number;
  stage: string;
  kind: "ffmpeg" | "ffprobe" | "store";
  detail: string;
  started_at: string;
  ended_at: string;
  ms: number;
}

const records: StageRecord[] = [];
let seq = 0;

async function timed<T>(
  stage: string,
  kind: StageRecord["kind"],
  detail: string,
  fn: () => Promise<T>,
): Promise<T> {
  const startedAt = new Date();
  const t0 = performance.now();
  try {
    return await fn();
  } finally {
    const ms = performance.now() - t0;
    records.push({
      seq: seq++,
      stage,
      kind,
      detail,
      started_at: startedAt.toISOString(),
      ended_at: new Date().toISOString(),
      ms: Math.round(ms),
    });
  }
}

/** The basename of the last argv element. See the header for why that is the output. */
function stageFromArgs(a: string[]): string {
  const last = a[a.length - 1] ?? "";
  const base = last.slice(last.lastIndexOf("/") + 1);
  return base === "" ? "unknown" : base;
}

class TimedFfmpeg implements Ffmpeg {
  constructor(private readonly inner: Ffmpeg) {}
  run(bin: "ffmpeg" | "ffprobe", a: string[]): Promise<FfmpegResult> {
    const stage = bin === "ffprobe" ? "probe" : stageFromArgs(a);
    return timed(stage, bin, stageFromArgs(a), () => this.inner.run(bin, a));
  }
}

class TimedStore implements ObjectStore {
  constructor(private readonly inner: ObjectStore) {}

  head(bucket: Bucket, key: string, length: number): Promise<Uint8Array> {
    // §6's magic-byte validation is this read plus a pure function over 64 bytes. The
    // read is the only part with a clock worth watching.
    return timed("magic_bytes", "store", `head ${bucket}/${key} ${length}B`, () =>
      this.inner.head(bucket, key, length));
  }
  download(bucket: Bucket, key: string, destPath: string): Promise<void> {
    return timed("download", "store", `${bucket}/${key}`, () =>
      this.inner.download(bucket, key, destPath));
  }
  upload(bucket: Bucket, key: string, srcPath: string, mime: string): Promise<number> {
    return timed(`upload:${key.slice(key.lastIndexOf("/") + 1)}`, "store", `${bucket}/${key}`, () =>
      this.inner.upload(bucket, key, srcPath, mime));
  }
  copy(
    from: { bucket: Bucket; key: string },
    to: { bucket: Bucket; key: string },
  ): Promise<void> {
    // Stage 3, preservation. Server-side against R2; a file copy here.
    return timed("preserve_master", "store", `${from.bucket}->${to.bucket}/${to.key}`, () =>
      this.inner.copy(from, to));
  }
  remove(bucket: Bucket, key: string): Promise<void> {
    return timed("remove_quarantine", "store", `${bucket}/${key}`, () =>
      this.inner.remove(bucket, key));
  }
}

// ── stage the source the way the worker would find it ────────

const stat = await Deno.stat(file);
if (!stat.isFile) {
  console.error(`--file must be a file: ${file}`);
  Deno.exit(2);
}

const root = await Deno.makeTempDir({ prefix: "rma-probe-" });
const workDir = `${root}/work`;
await Deno.mkdir(workDir, { recursive: true });

const objectKey = "00000000-0000-4000-8000-000000000000/probe-source";
const quarantined = `${root}/quarantine/${objectKey}`;
await Deno.mkdir(quarantined.slice(0, quarantined.lastIndexOf("/")), { recursive: true });
await Deno.copyFile(file, quarantined);

const ffmpeg = new RealFfmpeg();

// Source facts, measured OUTSIDE the timed run so probing the input is not charged to it.
const meta = await (async () => {
  const r = await ffmpeg.run("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration:stream=index,codec_type,width,height",
    "-of", "json",
    quarantined,
  ]);
  try {
    const j = JSON.parse(r.stdout);
    const v = (j.streams ?? []).find((s: Record<string, unknown>) => s.codec_type === "video");
    return {
      duration_s: j.format?.duration ? Number(j.format.duration) : null,
      width: v?.width ?? null,
      height: v?.height ?? null,
    };
  } catch {
    return { duration_s: null, width: null, height: null };
  }
})();

const reporter = new CapturingReporter();
const store = new TimedStore(new LocalStore(root));

const jobStartedAt = new Date();
const t0 = performance.now();

const outcome = await processJob(
  { object_key: objectKey, post_id: "00000000-0000-4000-8000-00000000ffff", issued_at: jobStartedAt.toISOString() },
  { store, reporter, ffmpeg: new TimedFfmpeg(ffmpeg), workDir },
);

const totalMs = Math.round(performance.now() - t0);
const jobEndedAt = new Date();

// ── output ───────────────────────────────────────────────────

const sample = {
  label: label ?? file.slice(file.lastIndexOf("/") + 1),
  file: file.slice(file.lastIndexOf("/") + 1),
  source,
  host_cpus: navigator.hardwareConcurrency ?? null,
  bytes: stat.size,
  duration_s: meta.duration_s,
  width: meta.width,
  height: meta.height,
  outcome: outcome.kind,
  reason: outcome.kind === "failed" ? outcome.reason : outcome.kind === "transient" ? outcome.error : null,
  started_at: jobStartedAt.toISOString(),
  ended_at: jobEndedAt.toISOString(),
  total_ms: totalMs,
  stages: records,
};

// NDJSON on stdout: one line per run, so a whole sample set concatenates into a
// distribution without any merging step.
console.log(JSON.stringify(sample));

// Human-readable on stderr, so it never contaminates the machine-readable stream.
const pad = (s: string, n: number) => s.padEnd(n);
console.error(`\n${sample.label}  ${source.toUpperCase()}  ${(stat.size / 1048576).toFixed(1)} MiB` +
  `${meta.duration_s ? `  ${meta.duration_s.toFixed(1)}s` : ""}` +
  `${meta.width ? `  ${meta.width}x${meta.height}` : ""}` +
  `  ${sample.host_cpus ?? "?"} vCPU`);
console.error("─".repeat(64));
for (const r of records) {
  console.error(`  ${pad(r.stage, 26)} ${pad(r.kind, 9)} ${(r.ms / 1000).toFixed(2)}s`);
}
console.error("─".repeat(64));
console.error(`  ${pad("TOTAL", 26)} ${pad(outcome.kind, 9)} ${(totalMs / 1000).toFixed(2)}s`);

if (source === "synthetic") {
  console.error(
    "\n  NOTE: --source synthetic. These numbers exercise the harness and are NOT a\n" +
      "  measurement — do not put them in docs/probe-results.md.",
  );
}

await Deno.remove(root, { recursive: true });

if (outcome.kind !== "ready") Deno.exit(1);
