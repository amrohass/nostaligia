// The real pipeline, real ffmpeg, real files — at whatever resolution the machine can take.
//
//     deno run --allow-read --allow-write --allow-run --allow-env \
//       worker/scripts/ladder-fixture.ts --size 320x240
//
// ── Why the size is an argument ──────────────────────────────
//
// The dev machine has 8 GB of RAM and is already running the Supabase stack; a 4K transcode
// on it is not a test, it is an afternoon. But rung SELECTION is pure arithmetic and is
// asserted exhaustively at 2160 in ladder.test.ts with no file at all, so what is actually
// left to prove here is that ffmpeg accepts the argv this repository builds and writes the
// files the manifest claims. That is true at 320x240 in about two seconds.
//
// CI then runs the same script at 3840x2160, where the encode is real and the machine is
// somebody else's. Same code path, same assertions, one flag apart.
//
// Nothing here touches the database or the network. The RPCs are covered by pgTAP
// (10_ingest_rpcs, 13, 14) and the store's wire behaviour by store-roundtrip.ts.

import { LocalStore } from "../src/store.ts";
import { processJob } from "../src/pipeline.ts";
import { CapturingReporter, RealFfmpeg } from "./lib/harness.ts";

const args = Deno.args;

/** `indexOf(...) + 1` reads args[0] when the flag is absent, which silently uses the wrong value. */
function arg(name: string, fallback: string): string {
  const i = args.indexOf(name);
  return i === -1 ? fallback : (args[i + 1] ?? fallback);
}

const sizeArg = arg("--size", "320x240");
const kind = arg("--kind", "video");

// Source length in seconds. Default 3 — what the correctness runs use, long enough to
// exercise every rung and short enough to be free.
//
// It is a FLAG because the per-job deadline has to be derived from throughput at more than
// one length. A single measurement cannot separate fixed cost (container start, source
// generation, probing) from marginal cost (seconds of wall per second of source), and
// §6's ceiling is a 20-minute master — 400x this default. Multiplying one 3-second figure
// by 400 is an assumption wearing a number. Two points give a slope and an intercept.
const durationArg = arg("--duration", "3");
const duration = Number(durationArg);
if (!Number.isFinite(duration) || duration <= 0) {
  console.error(`--duration must be a positive number of seconds, got ${durationArg}`);
  Deno.exit(2);
}

if (!/^\d+x\d+$/.test(sizeArg)) {
  console.error(`--size must look like 1920x1080, got ${sizeArg}`);
  Deno.exit(2);
}
const [, heightStr] = sizeArg.split("x");
const sourceHeight = Number(heightStr);

const ffmpeg = new RealFfmpeg();
const root = await Deno.makeTempDir({ prefix: "rma-fixture-" });
const workDir = `${root}/work`;
await Deno.mkdir(workDir, { recursive: true });
await Deno.mkdir(`${root}/quarantine/uploader`, { recursive: true });

const OBJECT_KEY = "uploader/fixture";
const POST_ID = "00000000-0000-0000-0000-0000000ffff1";
const sourcePath = `${root}/quarantine/${OBJECT_KEY}`;

// ── Generate the source ──────────────────────────────────────
//
// testsrc rather than a committed asset. A 4K fixture in git is a 4K fixture cloned by
// everyone forever, and lavfi produces one deterministically in a second.
//
// The metadata is the point of the video case. -map_metadata -1 is CLAUDE.md §11 gate 2,
// and a strip that is never given anything to strip is a strip that is never tested — so
// the source is deliberately stamped with tags the derivatives must not carry.
//
// Generated to a name WITH an extension and then moved onto the extension-free object key.
// ffmpeg picks its muxer from the output extension and refuses a bare name; the pipeline,
// by contrast, must never see one, because §6 validates by magic bytes and a real
// quarantine key is `{uuid}/{uuid}`. Doing this in two steps keeps both true.
const genExt = kind === "video" ? "mp4" : kind === "image" ? "jpg" : "m4a";
const genPath = `${root}/generated.${genExt}`;

if (kind === "video") {
  const gen = await ffmpeg.run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${sizeArg}:rate=25:duration=${duration}`,
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${duration}`,
    "-c:v",
    "libx264",
    "-pix_fmt",
    "yuv420p",
    "-c:a",
    "aac",
    "-metadata",
    "title=SENSITIVE-TITLE",
    "-metadata",
    "comment=31.9,35.2",
    genPath,
  ]);
  if (gen.code !== 0) {
    console.error(gen.stderr);
    throw new Error("could not generate the fixture clip");
  }
} else if (kind === "image") {
  const gen = await ffmpeg.run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `testsrc=size=${sizeArg}`,
    "-frames:v",
    "1",
    genPath,
  ]);
  if (gen.code !== 0) throw new Error("could not generate the fixture image");
} else if (kind === "audio") {
  const gen = await ffmpeg.run("ffmpeg", [
    "-y",
    "-f",
    "lavfi",
    "-i",
    `sine=frequency=440:duration=${duration}`,
    "-c:a",
    "aac",
    "-metadata",
    "title=SENSITIVE-TITLE",
    genPath,
  ]);
  if (gen.code !== 0) throw new Error("could not generate the fixture audio");
} else {
  console.error(`--kind must be video, image or audio; got ${kind}`);
  Deno.exit(2);
}

// Onto the extension-free object key. From here nothing downstream knows or could use what
// the file was called — the sniffer decides what it is from its leading bytes, which is
// §6's rule and the whole reason this move happens.
await Deno.rename(genPath, sourcePath);

const store = new LocalStore(root);
const reporter = new CapturingReporter();

const started = performance.now();
const outcome = await processJob(
  { object_key: OBJECT_KEY, post_id: POST_ID, issued_at: new Date().toISOString() },
  { store, reporter, ffmpeg, workDir },
);
const elapsed = ((performance.now() - started) / 1000).toFixed(1);

// ── Assertions ───────────────────────────────────────────────

const failures: string[] = [];
const check = (cond: boolean, msg: string) => {
  if (!cond) failures.push(msg);
};

check(outcome.kind === "ready", `outcome was ${outcome.kind}: ${JSON.stringify(outcome)}`);

const assets = reporter.assets;
const master = assets.find((a) => a.role === "master");
check(master !== undefined, "no master row");
check(master?.bucket === "originals", "the master must be in originals/ (§6)");
check(
  await Deno.stat(`${root}/originals/${OBJECT_KEY}`).then(() => true).catch(() => false),
  "the master was not actually copied into originals/",
);

for (const a of assets.filter((x) => x.role !== "master")) {
  check(a.bucket === "public", `${a.role} landed in ${a.bucket}/`);
  check(
    !a.storage_path.includes("uploader"),
    `${a.storage_path} carries the uploader id into a public path (§7)`,
  );
  const onDisk = await Deno.stat(`${root}/public/${a.storage_path}`)
    .then((s) => s.size)
    .catch(() => -1);
  check(onDisk > 0, `${a.storage_path} was recorded but is not on disk`);
}

if (kind === "video") {
  const expected = sourceHeight >= 1440
    ? ["1440p", "1080p", "720p", "480p"]
    : sourceHeight >= 1080
    ? ["1080p", "720p", "480p"]
    : sourceHeight >= 720
    ? ["720p", "480p"]
    : ["480p"];
  const got = assets.filter((a) => a.role === "rendition").map((a) => a.rendition);
  check(
    got.join(",") === expected.join(","),
    `rungs for a ${sourceHeight}-line source: expected ${expected}, got ${got}`,
  );
  check(assets.some((a) => a.role === "poster"), "§6 requires a poster for every video");
  check(assets.some((a) => a.role === "thumb"), "§6 requires a thumbnail for every video");

  // §11 gate 2, as far as a generated file can reach. The source carries tags; every
  // derivative must not. This is NOT the gate itself — that needs a real photograph
  // carrying real GPS EXIF, end to end — but it does prove -map_metadata -1 is in force.
  for (const a of assets.filter((x) => x.bucket === "public" && x.mime === "video/mp4")) {
    const probed = await ffmpeg.run("ffprobe", [
      "-v",
      "error",
      "-show_entries",
      "format_tags",
      "-of",
      "json",
      `${root}/public/${a.storage_path}`,
    ]);
    check(
      !probed.stdout.includes("SENSITIVE-TITLE") && !probed.stdout.includes("31.9"),
      `${a.storage_path} carried the source metadata through the transcode`,
    );
  }
}

if (kind === "audio") {
  const rendition = assets.find((a) => a.role === "rendition");
  check(rendition?.rendition === "audio", "the audio rung (migration 0029)");
  check(rendition?.mime === "audio/ogg", "Opus in Ogg");
}

// ── Report ───────────────────────────────────────────────────

// The shape is parsed by the throughput step in CI, which needs the source length and the
// wall time on one line to fit a slope. `elapsed` brackets processJob ONLY — container
// start, source generation and the rename are all outside it — which is what makes two of
// these separable into fixed and marginal cost.
console.log(`\nLADDER ${kind} ${sizeArg} source=${duration}s wall=${elapsed}s`);
for (const a of assets) {
  console.log(
    `  ${a.role.padEnd(9)} ${(a.rendition ?? "").padEnd(6)} ${a.bucket.padEnd(9)} ` +
      `${String(a.bytes ?? 0).padStart(9)}B  ${a.storage_path}`,
  );
}

await Deno.remove(root, { recursive: true }).catch(() => {});

if (failures.length > 0) {
  console.error(`\n${failures.length} check(s) failed:`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  Deno.exit(1);
}
console.log(`\n${assets.length} assets, all checks passed.`);
