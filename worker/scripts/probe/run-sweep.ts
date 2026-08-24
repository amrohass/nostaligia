/* Runs probe-timing.ts once per media file, INSIDE the built worker image.
 *
 *     deno run --allow-read --allow-write --allow-run --allow-env \
 *       worker/scripts/probe/run-sweep.ts \
 *       --dir fottage --out docs/probe-samples.ndjson --log docs/probe-run.txt
 *
 * Run from the repository root. Requires `rma-media-worker:probe` to exist:
 *
 *     docker build -f worker/Dockerfile -t rma-media-worker:probe .
 *
 * ── Why inside the image ─────────────────────────────────────
 *
 * The number is only worth having if the ffmpeg that produced it is the ffmpeg that ships.
 * The image pins ffmpeg 7.1.5 on trixie; a laptop has whatever it has. The image does not
 * contain worker/scripts, so the scripts directory is mounted in.
 *
 * ── Why --cpuset-cpus and never --cpus ───────────────────────
 *
 * `--cpus` is a CFS quota: ffmpeg's thread auto-detection still sees every host core and
 * spawns that many threads to share a fraction of one, which measures thrash rather than a
 * 2-vCPU instance. A cpuset restricts the visible CPUs, and probe-timing.ts's own
 * `host_cpus` field then reads 2 — so every record states the shape it was measured under
 * instead of relying on this file being read alongside it.
 *
 * ── Ordering, and why results are appended one at a time ─────
 *
 * Images first, then videos ascending by duration, longest LAST. Each result is written the
 * moment it lands, so an interrupted sweep keeps everything already measured — which is not
 * hypothetical: the first run of this was killed during the final sample.
 *
 * ── The contamination warning is the important part ──────────
 *
 * Do NOT run anything else CPU-heavy while a sweep is in progress. A sample that lost CPU to
 * a concurrent Docker build looks EXACTLY like a slow sample in the output — there is no
 * marker, and the only way to catch it is to know it happened. One sample had to be
 * re-run for this reason.
 */

function arg(name: string, fallback: string | null = null): string | null {
  const i = Deno.args.indexOf(name);
  return i === -1 ? fallback : (Deno.args[i + 1] ?? fallback);
}

const dir = arg("--dir", "fottage")!;
const out = arg("--out", "docs/probe-samples.ndjson")!;
const log = arg("--log", "docs/probe-run.txt")!;
const image = arg("--image", "rma-media-worker:probe")!;
const cpuset = arg("--cpuset", "0,1")!;
const memory = arg("--memory", "3g")!;

// Docker needs a native absolute path for -v; Deno.realPath gives one on every platform.
const repo = await Deno.realPath(".");

const VIDEO = /\.(mp4|mov|m4v|mkv|webm)$/i;
const IMAGE = /\.(jpe?g|png|heic|heif|webp|tiff?)$/i;
const AUDIO = /\.(m4a|mp3|opus|ogg|wav|flac|aac)$/i;

/** Duration in seconds, or null. Read on the HOST so ordering does not cost a container. */
async function duration(path: string): Promise<number | null> {
  try {
    const r = await new Deno.Command("ffprobe", {
      args: ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path],
      stdout: "piped",
      stderr: "null",
    }).output();
    const n = Number(new TextDecoder().decode(r.stdout).trim());
    return Number.isFinite(n) ? n : null;
  } catch {
    return null; // no host ffprobe: fall back to size ordering
  }
}

interface Sample { file: string; label: string; sort: number }
const samples: Sample[] = [];

for await (const e of Deno.readDir(dir)) {
  if (!e.isFile) continue;
  const path = `${dir}/${e.name}`;
  const { size } = await Deno.stat(path);
  const isMedia = VIDEO.test(e.name) || IMAGE.test(e.name) || AUDIO.test(e.name);
  if (!isMedia) continue;
  // Images sort before every video; videos sort by duration, so the longest runs last.
  const d = VIDEO.test(e.name) || AUDIO.test(e.name) ? (await duration(path) ?? size / 1e6) : -1;
  samples.push({ file: e.name, label: e.name.replace(/\.[^.]+$/, ""), sort: d });
}
samples.sort((a, b) => a.sort - b.sort);

if (samples.length === 0) {
  console.error(`no media files found in ${dir}`);
  Deno.exit(2);
}

const stamp = () => new Date().toISOString();
const appendLog = (s: string) => Deno.writeTextFile(log, s, { append: true });

console.log(`${samples.length} samples, longest last, into ${out}`);

for (const [i, s] of samples.entries()) {
  const started = Date.now();
  await appendLog(`\n=== [${i + 1}/${samples.length}] ${s.label}  ${s.file}  start ${stamp()} ===\n`);
  console.log(`[${i + 1}/${samples.length}] ${s.label} …`);

  const cmd = new Deno.Command("docker", {
    args: [
      "run", "--rm", "--entrypoint", "deno",
      `--cpuset-cpus=${cpuset}`, "--memory", memory,
      "-v", `${repo}/worker/scripts:/app/worker/scripts:ro`,
      "-v", `${repo}/${dir}:/data:ro`,
      image,
      "run", "--allow-read", "--allow-write", "--allow-run", "--allow-env",
      "worker/scripts/probe-timing.ts",
      "--file", `/data/${s.file}`,
      "--source", "real",
      "--label", s.label,
    ],
    // MSYS path mangling rewrites /data/... into a Windows path under Git Bash.
    env: { MSYS_NO_PATHCONV: "1" },
    stdout: "piped",
    stderr: "piped",
  });

  const res = await cmd.output();
  const stdout = new TextDecoder().decode(res.stdout).trim();
  const stderr = new TextDecoder().decode(res.stderr);
  const elapsed = Math.round((Date.now() - started) / 1000);

  await appendLog(stderr + `\n--- exit ${res.code}, wall ${elapsed}s ---\n`);

  if (res.code === 0 && stdout.startsWith("{")) {
    await Deno.writeTextFile(out, stdout + "\n", { append: true });
    console.log(`    ok  ${elapsed}s`);
  } else {
    // Recorded rather than dropped: a sample that failed is a fact about the pipeline.
    console.log(`    FAILED exit ${res.code} after ${elapsed}s`);
    await Deno.writeTextFile(
      out,
      JSON.stringify({ label: s.label, file: s.file, source: "real", failed: true, exit_code: res.code, wall_s: elapsed }) + "\n",
      { append: true },
    );
  }
}

console.log("all samples attempted");
