/* CLAUDE.md §11, launch gate 2 — "EXIF stripping verified on a real photo carrying GPS
 * data, end to end."
 *
 *     deno run --allow-read --allow-write --allow-run --allow-env \
 *       worker/scripts/exif-gate.ts
 *
 * ── What this proves that nothing else did ───────────────────
 *
 * ladder.test.ts asserts `-map_metadata -1` is in the argv. ladder-fixture.ts asserts an
 * ffmpeg `-metadata title=` tag does not survive the transcode. Both are true and neither is
 * this gate: a container tag written by the tool that removes it proves the flag is spelled
 * right. It says nothing about a JPEG APP1 segment, which is a block the decoder never has
 * to look at and which is where a camera actually writes the coordinates of the room the
 * photograph was taken in.
 *
 * So: a real JPEG, a real APP1 carrying real GPS rationals, through the real pipeline, and
 * then the output is parsed as bytes.
 *
 * ── And the other half of §6, which is easy to lose ──────────
 *
 * "Masters: 4K accepted. The uploaded master is stored untouched in originals/." Untouched
 * means untouched — the archival copy is supposed to still carry the metadata a future
 * curator would want, and originals/ is never CDN-fronted, so it is allowed to. A pipeline
 * that stripped everything everywhere would pass a naive "no EXIF anywhere" test while
 * quietly destroying the preservation copy. This asserts both directions: gone from public/,
 * intact and byte-identical in originals/.
 *
 * ── Phase 2, and why a passing gate is not enough ────────────
 *
 * A check that has never been seen to fail is not a check. If `readGps` returned null on
 * everything, or the derivative were not the file this script thinks it is, phase 1 would go
 * green while proving nothing whatsoever — and it would keep going green for years.
 *
 * So the inspection is also pointed at files it MUST condemn. Two of them, because they fail
 * for different reasons:
 *
 *   2a  the source photograph itself, fed to the same inspect() the derivatives went
 *       through. Deterministic, no ffmpeg involved, and it fails if the inspector is blind.
 *   2b  a run where the image encode is replaced by a byte copy — the exact shape of the
 *       regression that would matter: a "derivative" that is the original wearing a .webp
 *       name. Somebody wires publish() to `src` instead of `display` and this is what ships.
 *
 * ── The first thing phase 2 found ────────────────────────────
 *
 * Its first version sabotaged `-map_metadata -1` by deleting it from the argv, and the
 * derivatives came out clean anyway. That is not a bug; it is where the safety actually
 * comes from. For an image, ffmpeg DECODES to raw pixels and re-encodes with libwebp, and a
 * pixel buffer has no APP1 to carry — §6's "re-encode every image server-side; this strips
 * EXIF and kills polyglots in one step" is doing the work, and the flag is belt-and-braces.
 *
 * Worth knowing precisely because it inverts what to be afraid of. The image path is not one
 * flag away from leaking coordinates. It is one `-c:v copy` — one decision to stop
 * re-encoding — away, and that is what 2b models.
 *
 * ── What is still not covered ────────────────────────────────
 *
 * "End to end" in §11 means through the deployed system: a browser PUT to a real R2
 * quarantine bucket, the real container, and the object fetched back over the CDN. This runs
 * the same pipeline code against LocalStore, which is everything except the network. The
 * remaining step needs the worker deployed, and store-roundtrip.ts covers the S3 wire
 * behaviour separately against MinIO.
 */

import { LocalStore } from "../src/store.ts";
import { type Ffmpeg, type FfmpegResult, processJob } from "../src/pipeline.ts";
import { CapturingReporter, Checks, RealFfmpeg } from "./lib/harness.ts";
import {
  buildExifApp1,
  gpsWireBytes,
  indexOfBytes,
  injectExif,
  jpegMarkers,
  RAMALLAH,
  readGps,
  riffChunks,
} from "./lib/exif.ts";

const DESCRIPTION = "SENSITIVE-CAPTION-DO-NOT-PUBLISH";
const OBJECT_KEY = "uploader/gps-fixture";
const POST_ID = "00000000-0000-0000-0000-0000000ffff2";

const LAT_WIRE = gpsWireBytes(RAMALLAH.latitude);
const LON_WIRE = gpsWireBytes(RAMALLAH.longitude);
const CAPTION_WIRE = new TextEncoder().encode(DESCRIPTION);

const real = new RealFfmpeg();
const checks = new Checks();

/**
 * ffmpeg with the encode taken out of it.
 *
 * Every ffmpeg invocation becomes "copy the input to the output"; ffprobe still runs for
 * real, so the pipeline's own decisions are unchanged and only the transform is gone. That
 * is the regression this models: a derivative that is the original wearing a .webp name,
 * which is what ships the day somebody decides re-encoding is expensive and reaches for
 * `-c:v copy`.
 *
 * §6 is unambiguous that the re-encode is the safety property — "re-encode every image
 * server-side; this strips EXIF and kills polyglots in one step" — so a pipeline without it
 * MUST be caught, and phase 2b is where we find out whether it would be.
 */
class Passthrough implements Ffmpeg {
  async run(bin: "ffmpeg" | "ffprobe", args: string[]): Promise<FfmpegResult> {
    if (bin === "ffprobe") return real.run(bin, args);
    const input = args[args.indexOf("-i") + 1];
    const output = args[args.length - 1];
    await Deno.copyFile(input, output);
    return { code: 0, stdout: "", stderr: "passthrough" };
  }
}

/**
 * Every way one published file was found to still carry the source's metadata.
 *
 * A named function rather than a loop body, because phase 2 has to point it at files it
 * KNOWS are dirty. An inspector that is only ever run on clean files is an inspector whose
 * output nobody has ever read.
 */
function inspect(name: string, bytes: Uint8Array): string[] {
  const leaks: string[] = [];
  if (bytes.length === 0) return [`${name} was recorded but is not on disk`];

  // The gate, stated in the container the derivative is supposed to be.
  const chunks = riffChunks(bytes);
  if (chunks.length === 0) leaks.push(`${name} is not the WebP the manifest claims`);
  if (chunks.includes("EXIF")) leaks.push(`${name} carries an EXIF chunk (§11 gate 2)`);
  if (chunks.includes("XMP ")) leaks.push(`${name} carries an XMP chunk`);

  // And again without believing anything about the container. This is the check that does
  // the real work: it finds the coordinates wherever they are, in whatever the file turned
  // out to be, including a file that is not a WebP at all.
  if (indexOfBytes(bytes, LAT_WIRE) !== -1) leaks.push(`${name} contains the raw latitude rationals (§7)`);
  if (indexOfBytes(bytes, LON_WIRE) !== -1) leaks.push(`${name} contains the raw longitude rationals (§7)`);
  if (indexOfBytes(bytes, CAPTION_WIRE) !== -1) leaks.push(`${name} contains the source caption`);
  return leaks;
}

// ── The photograph ───────────────────────────────────────────
//
// Generated rather than committed: a real photograph carrying real GPS is somebody's real
// location, and putting one in a public repository to prove we remove locations would be a
// poor joke. The bytes are in the same places either way.
const scratch = await Deno.makeTempDir({ prefix: "rma-exif-" });
const genPath = `${scratch}/generated.jpg`;
const gen = await real.run("ffmpeg", [
  "-y",
  "-f",
  "lavfi",
  "-i",
  "testsrc=size=640x480",
  "-frames:v",
  "1",
  genPath,
]);
if (gen.code !== 0) {
  console.error(gen.stderr);
  throw new Error("could not generate the fixture frame");
}

const carrying = injectExif(
  await Deno.readFile(genPath),
  buildExifApp1(RAMALLAH, DESCRIPTION),
);

// ── The fixture is checked before it is trusted ──────────────
//
// A fixture that carries no GPS passes every derivative check without the pipeline doing
// anything at all. That is the failure mode this gate exists to avoid, so it is ruled out
// first and loudly.
const sourceGps = readGps(carrying);
checks.check(sourceGps !== null, "the fixture carries no GPS — every check below is vacuous");
checks.check(
  sourceGps !== null && Math.abs(sourceGps.latitude - RAMALLAH.latitude) < 1e-6,
  `the fixture's latitude reads back as ${sourceGps?.latitude}`,
);
checks.check(jpegMarkers(carrying)[0] === 0xffe1, "the APP1 is not where a camera puts it");

interface Run {
  ok: boolean;
  assets: { role: string; bucket: string; path: string }[];
  /** Every way a published file was found to still carry the source's metadata. */
  leaks: string[];
  masterIntact: boolean;
  masterKeptGps: boolean;
  note: string;
}

async function runPipeline(ffmpeg: Ffmpeg): Promise<Run> {
  const root = await Deno.makeTempDir({ prefix: "rma-exif-run-" });
  const workDir = `${root}/work`;
  await Deno.mkdir(workDir, { recursive: true });
  await Deno.mkdir(`${root}/quarantine/uploader`, { recursive: true });
  // Onto the extension-free object key — §6 validates by magic bytes, and a real quarantine
  // key has no extension to be fooled by.
  await Deno.writeFile(`${root}/quarantine/${OBJECT_KEY}`, carrying);

  const reporter = new CapturingReporter();
  const outcome = await processJob(
    { object_key: OBJECT_KEY, post_id: POST_ID, issued_at: new Date().toISOString() },
    { store: new LocalStore(root), reporter, ffmpeg, workDir },
  );

  const leaks: string[] = [];
  const assets = reporter.assets.map((a) => ({
    role: a.role,
    bucket: a.bucket,
    path: a.storage_path,
  }));

  for (const a of reporter.assets.filter((x) => x.bucket === "public")) {
    const bytes = await Deno.readFile(`${root}/public/${a.storage_path}`)
      .catch(() => new Uint8Array(0));
    leaks.push(...inspect(a.storage_path, bytes));

    // §7, unrelated to metadata: a public path must not name the uploader. Checked here
    // rather than in inspect() because it is a property of the PATH, and phase 2 points
    // inspect() at files that have no path in public/ at all.
    if (a.storage_path.includes("uploader")) {
      leaks.push(`${a.storage_path} carries the uploader id into a public path (§7)`);
    }
  }

  const stored = await Deno.readFile(`${root}/originals/${OBJECT_KEY}`)
    .catch(() => new Uint8Array(0));
  const run: Run = {
    ok: outcome.kind === "ready",
    assets,
    leaks,
    masterIntact: stored.length === carrying.length && indexOfBytes(stored, carrying) === 0,
    masterKeptGps: readGps(stored) !== null,
    note: outcome.kind === "ready" ? "" : `${JSON.stringify(outcome)} ${reporter.failure ?? ""}`,
  };
  await Deno.remove(root, { recursive: true }).catch(() => {});
  return run;
}

// ── Phase 1 · the pipeline as it ships ───────────────────────

const clean = await runPipeline(real);

checks.check(clean.ok, `the pipeline did not finish: ${clean.note}`);
checks.check(
  clean.assets.some((a) => a.role === "master" && a.bucket === "originals"),
  "the master must be in originals/ (§6)",
);
checks.check(
  clean.assets.some((a) => a.bucket === "public"),
  "nothing was published, so nothing was checked",
);
for (const leak of clean.leaks) checks.check(false, leak);

checks.check(
  clean.masterIntact,
  "the master in originals/ is not byte-identical to what was uploaded (§6: stored untouched)",
);
checks.check(
  clean.masterKeptGps,
  "the master lost its EXIF — originals/ is the archival copy and is never CDN-fronted, " +
    "so it is supposed to keep it",
);

// ── Phase 2a · the inspector, shown a file it must condemn ──
//
// The source photograph, through the same inspect() the derivatives went through. No ffmpeg,
// no pipeline, nothing that can vary between machines: if this comes back clean, every empty
// leak list above means "the inspector found nothing anywhere", which is not the same claim
// at all.

const sourceLeaks = inspect("the source photograph", carrying);
checks.check(
  sourceLeaks.length >= 3,
  "inspect() found nothing in the photograph that demonstrably carries GPS and a caption — " +
    `it is blind, and phase 1's silence means nothing (found: ${sourceLeaks.length})`,
);

// ── Phase 2b · the regression that would actually ship ──────
//
// The encode replaced by a byte copy. §6's re-encode is the property that destroys EXIF on
// the image path — not the -map_metadata flag, which for a decode-and-re-encode has nothing
// left to act on — so this is the mutation that models losing it.

const leaky = await runPipeline(new Passthrough());

checks.check(
  leaky.ok,
  `the passthrough run did not finish, so it proves nothing either way: ${leaky.note}`,
);
checks.check(
  leaky.leaks.length > 0,
  "a pipeline that publishes the ORIGINAL as its derivative passed every check phase 1 " +
    "runs — the checks are blind and a real regression would ship green",
);

// ── Report ───────────────────────────────────────────────────

console.log(`\nsource        ${carrying.length}B  GPS ${sourceGps?.latitude}, ${sourceGps?.longitude}`);
for (const a of clean.assets) console.log(`  ${a.role.padEnd(9)} ${a.bucket.padEnd(9)} ${a.path}`);
console.log(`\nmaster        ${clean.masterIntact ? "byte-identical" : "ALTERED"}, GPS ${clean.masterKeptGps ? "kept (§6)" : "GONE"}`);
console.log(`published     ${clean.assets.filter((a) => a.bucket === "public").length} file(s), ${clean.leaks.length} leak(s)`);
console.log(`
inspector     ${sourceLeaks.length} finding(s) on the source itself — it is not blind`);
console.log(`passthrough   ${leaky.leaks.length} leak(s) when the re-encode is removed:`);
for (const leak of leaky.leaks) console.log(`  · ${leak}`);

await Deno.remove(scratch, { recursive: true }).catch(() => {});
checks.report("§11 gate 2: GPS EXIF does not survive into public/, does survive in originals/, and the check fails when it should.");
