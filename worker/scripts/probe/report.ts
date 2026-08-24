/* Turns probe-samples.ndjson into docs/probe-results.md.
 *
 *     deno run --allow-read --allow-write worker/scripts/probe/report.ts \
 *       --in docs/probe-samples.ndjson --out docs/probe-results.md \
 *       --host "Intel i5-4210U @ 1.70GHz (2 cores / 4 threads, 15 W, 2014)" \
 *       --ffmpeg "ffmpeg 7.1.5 on trixie" --commit "$(git rev-parse --short HEAD)"
 *
 * RAW NUMBERS ONLY. This deliberately computes no factor, no ratio across samples, and no
 * proposed constant: CLAUDE.md §6 keeps the JOB_DEADLINE_MS decision with the maintainer,
 * and a generator that helpfully printed "therefore N minutes" would be making it. The only
 * arithmetic is unit conversion, a sample's own stages summed, and a sample's own wall clock
 * over its own source duration — all restatements of one measurement rather than derivations
 * across the set.
 */

interface Stage { seq: number; stage: string; kind: string; detail: string; ms: number }
interface Sample {
  label: string; file: string; source: string; host_cpus: number | null;
  bytes: number; duration_s: number | null; width: number | null; height: number | null;
  outcome: string; reason: string | null; total_ms: number; stages: Stage[];
  failed?: boolean; exit_code?: number; wall_s?: number;
}

function arg(n: string, d: string | null = null): string | null {
  const i = Deno.args.indexOf(n);
  return i === -1 ? d : (Deno.args[i + 1] ?? d);
}
const inPath = arg("--in", "docs/probe-samples.ndjson")!;
const outPath = arg("--out", "docs/probe-results.md")!;
const host = arg("--host", "unstated");
const ffmpeg = arg("--ffmpeg", null);
const commit = arg("--commit", null);

const all: Sample[] = Deno.readTextFileSync(inPath)
  .split(/\r?\n/).filter((l) => l.trim().startsWith("{")).map((l) => JSON.parse(l));

// A synthetic row must never reach this file. probe-timing.ts's header is explicit that the
// whole point of --source is that the two are not interchangeable.
const synthetic = all.filter((s) => s.source !== "real");
const ok = all.filter((s) => !s.failed && s.source === "real");
const bad = all.filter((s) => s.failed);

const mib = (b: number) => (b / 1048576).toFixed(1);
const secs = (ms: number) => (ms / 1000).toFixed(2);
const mmss = (ms: number) => {
  const t = Math.round(ms / 1000);
  return `${Math.floor(t / 60)}m${String(t % 60).padStart(2, "0")}s`;
};
const res = (s: Sample) => s.width && s.height ? `${s.width}x${s.height}` : "—";
const dur = (s: Sample) => s.duration_s === null ? "—" : `${s.duration_s.toFixed(1)}s`;
const rungs = (s: Sample) => s.stages.filter((g) => g.kind === "ffmpeg" && g.stage.endsWith(".mp4")).length;
const isVideo = (s: Sample) => (s.duration_s ?? 0) > 0 && rungs(s) > 0;

const L: string[] = [];
const w = (s = "") => L.push(s);

w("# Probe results — per-stage wall clock, real footage");
w();
w("Raw measurements for CLAUDE.md §6's `JOB_DEADLINE_MS`. **No constant is derived here and");
w("none is proposed** — §6 keeps that decision with the maintainer, and the");
w("`ESTIMATE, NOT MEASURED` tag at the constant stays until they make it.");
w();
if (commit) w(`Measured ${new Date().toISOString().slice(0, 10)} at commit \`${commit}\`.`);
w();
w("## What this is, and what it is not");
w();
w("Every sample is **real footage** — a phone or camera file, never `lavfi`/`testsrc`. That is");
w("the point: §6 records that the dominant term in the current estimate is the");
w("**testsrc-to-real-footage factor**, and that it is an estimate rather than a measurement.");
w();
w("Three things these numbers are **not**, each of which would change them:");
w();
w("- **Not the deployed worker.** They come from the built worker image run locally. The");
w("  ffmpeg is identical — it is the same image — but the CPU is not.");
w("- **Not real R2.** The probe uses `LocalStore` over a temp directory, so every `store` row");
w("  is a local file operation. **Network transfer is unmeasured and is additive on top of");
w("  these totals.**");
if (host) {
  w(`- **Not fast hardware.** Host: **${host}**, container pinned to 2 CPUs. Read these as a`);
  w("  **conservative upper bound** on the same work in the deployment, never as a floor.");
}
w();
w("`--cpuset-cpus` rather than `--cpus` is deliberate: `--cpus` is a CFS quota, so ffmpeg's");
w("thread auto-detection still sees every core and spawns that many threads to share a");
w("fraction of one — measuring thrash rather than a 2-vCPU instance. Every record below");
w("carries its own `host_cpus`, so each states the shape it was measured under.");
w();
if (ffmpeg) { w(`Image: \`${ffmpeg}\`.`); w(); }
w("---");
w();
w("## Summary");
w();
w("| sample | size | duration | resolution | outcome | total wall clock |");
w("|---|---:|---:|---:|---|---:|");
for (const s of ok) {
  w(`| \`${s.label}\` | ${mib(s.bytes)} MiB | ${dur(s)} | ${res(s)} | ${s.outcome} | **${secs(s.total_ms)}s** (${mmss(s.total_ms)}) |`);
}
for (const s of bad) w(`| \`${s.label}\` | — | — | — | **FAILED** exit ${s.exit_code} | ${s.wall_s}s |`);
w();

const vids = ok.filter(isVideo);
if (vids.length) {
  w("### Video samples only");
  w();
  w("The images finish in seconds and are not where the deadline risk lives.");
  w();
  w("| sample | source duration | resolution | rungs | total wall clock | ×source duration |");
  w("|---|---:|---:|---:|---:|---:|");
  for (const s of vids) {
    const ratio = s.duration_s ? (s.total_ms / 1000 / s.duration_s).toFixed(2) + "×" : "—";
    w(`| \`${s.label}\` | ${dur(s)} | ${res(s)} | ${rungs(s)} | **${secs(s.total_ms)}s** (${mmss(s.total_ms)}) | ${ratio} |`);
  }
  w();
  w("The ×source column is each sample's own wall clock over its own duration, carried no");
  w("further. Spread between samples at the SAME resolution and rung count is content");
  w("dependence — which is exactly what synthetic input cannot show.");
  w();
}

w("---");
w();
w("## Per-sample stage timings");
w();
w("`store` rows are LocalStore file operations, not network. `ffprobe` rows are the");
w("verification probes the ladder runs after each output.");
w();
for (const s of ok) {
  w(`### \`${s.label}\` — ${s.file}`);
  w();
  w([`${mib(s.bytes)} MiB`, dur(s) !== "—" ? dur(s) : null, res(s) !== "—" ? res(s) : null,
    `${s.host_cpus ?? "?"} vCPU`, `outcome \`${s.outcome}\``].filter(Boolean).join(" · "));
  w();
  w("| # | stage | kind | ms | s |");
  w("|---:|---|---|---:|---:|");
  for (const g of s.stages) w(`| ${g.seq} | \`${g.stage}\` | ${g.kind} | ${g.ms} | ${secs(g.ms)} |`);
  const sum = s.stages.reduce((a, g) => a + g.ms, 0);
  w(`| | **stages summed** | | **${sum}** | **${secs(sum)}** |`);
  w(`| | **job total** | | **${s.total_ms}** | **${secs(s.total_ms)}** |`);
  w();
}

w("---");
w();
w("## Caveats in the sample set");
w();
w("**Gap — no true 3840x2160 source.** Less damaging than it sounds: §6 never makes a 2160p");
w("rendition, so a 4K source yields the same rungs. What is missing is the higher **decode**");
w("cost of 4K input — one term rather than the whole ladder.");
w();
w("**Gap — no audio sample.** The Opus normalize (EBU R128) and waveform-thumbnail path is");
w("**entirely unmeasured**. A voice note is §7's most identifying medium and will be a routine");
w("contribution; its ingest cost is currently unknown.");
w();
w("## Still to measure");
w();
w("These need the deployed worker:");
w();
w("1. **The host CPU factor** — the same samples on the deployed container.");
w("2. **Network transfer** — every `store` row here is local. Real R2 adds a download of the");
w("   master and an upload per rung.");
w();
if (bad.length) {
  w("## Failed samples");
  w();
  for (const s of bad) w(`- \`${s.label}\` (${s.file}) — exit ${s.exit_code} after ${s.wall_s}s`);
  w();
}
if (synthetic.length) {
  w(`> **${synthetic.length} synthetic row(s) were excluded from this report.** They exercise`);
  w("> the harness and are not measurements; §6's dominant estimate is precisely that");
  w("> difference.");
  w();
}

Deno.writeTextFileSync(outPath, L.join("\n") + "\n");
console.log(`wrote ${outPath}: ${ok.length} real samples, ${bad.length} failed, ${synthetic.length} synthetic excluded`);
