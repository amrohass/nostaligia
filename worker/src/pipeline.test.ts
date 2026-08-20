// Routing, the failure split, and where derivatives are allowed to live.
//
// Everything is faked except the filesystem, which the pipeline genuinely uses. What is
// under test is the DECISIONS: what gets refused before a byte moves, what counts as the
// uploader's fault versus the world's, and whether a public URL can be traced back to the
// person who uploaded it.
//
//     deno test --allow-read --allow-write --allow-env worker/

import {
  assertManifest,
  type Ffmpeg,
  type FfmpegResult,
  JOB_DEADLINE_MS,
  processJob,
} from "./pipeline.ts";
import type { AssetRow, IngestReporter, RpcOutcome } from "./db.ts";
import type { Bucket, ObjectStore } from "./store.ts";
import type { Job } from "./job.ts";

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) {
    throw new Error(`${msg}\n  expected: ${expected}\n  actual:   ${actual}`);
  }
}

const JOB: Job = {
  object_key: "00000000-0000-0000-0000-0000000000a1/f7c2",
  post_id: "00000000-0000-0000-0000-00000000bb01",
  issued_at: "2026-08-19T12:00:00.000Z",
};

// Leading bytes only — enough for the sniffer, which is all the pipeline reads before
// deciding. See _shared/magic-bytes.ts.
const SIGNATURES = {
  jpeg: new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0]),
  webm: new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0]),
  ogg: new TextEncoder().encode("OggS____"),
  svg: new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"></svg>'),
  garbage: new Uint8Array([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]),
};

const PROBE = {
  video: JSON.stringify({
    format: { duration: "30" },
    streams: [{ codec_type: "video", width: 1920, height: 1080 }, { codec_type: "audio" }],
  }),
  longVideo: JSON.stringify({
    format: { duration: "5400" }, // an hour and a half
    streams: [{ codec_type: "video", width: 1920, height: 1080 }],
  }),
  noDuration: JSON.stringify({
    streams: [{ codec_type: "video", width: 1920, height: 1080 }],
  }),
  audio: JSON.stringify({
    format: { duration: "62" },
    streams: [{ codec_type: "audio" }],
  }),
  image: JSON.stringify({
    streams: [{ codec_type: "video", width: 4000, height: 3000 }],
  }),
};

class FakeStore implements ObjectStore {
  calls: string[] = [];
  headThrows = false;

  constructor(private readonly leading: Uint8Array) {}

  head(bucket: Bucket, key: string, length: number): Promise<Uint8Array> {
    this.calls.push(`head ${bucket}/${key}`);
    if (this.headThrows) return Promise.reject(new Error("R2 unreachable"));
    return Promise.resolve(this.leading.subarray(0, length));
  }

  async download(bucket: Bucket, key: string, destPath: string): Promise<void> {
    this.calls.push(`download ${bucket}/${key}`);
    await Deno.writeFile(destPath, this.leading);
  }

  upload(bucket: Bucket, key: string, _srcPath: string, _mime: string): Promise<number> {
    this.calls.push(`upload ${bucket}/${key}`);
    return Promise.resolve(4096);
  }

  copy(
    from: { bucket: Bucket; key: string },
    to: { bucket: Bucket; key: string },
  ): Promise<void> {
    this.calls.push(`copy ${from.bucket}/${from.key} -> ${to.bucket}/${to.key}`);
    return Promise.resolve();
  }

  remove(bucket: Bucket, key: string): Promise<void> {
    this.calls.push(`remove ${bucket}/${key}`);
    return Promise.resolve();
  }

  wrote(): string[] {
    return this.calls.filter((c) => c.startsWith("upload") || c.startsWith("copy"));
  }
}

class FakeReporter implements IngestReporter {
  completed: { assets: AssetRow[]; mime: string }[] = [];
  failures: string[] = [];
  completeResult: RpcOutcome = { ok: true };

  complete(_key: string, mime: string, assets: AssetRow[]): Promise<RpcOutcome> {
    this.completed.push({ assets, mime });
    return Promise.resolve(this.completeResult);
  }

  fail(_key: string, reason: string): Promise<RpcOutcome> {
    this.failures.push(reason);
    return Promise.resolve({ ok: true });
  }
}

class FakeFfmpeg implements Ffmpeg {
  encodeCode = 0;
  /** Every invocation, so a test can prove work STOPPED rather than merely that it failed. */
  readonly runs: string[] = [];
  constructor(private readonly probeJson: string) {}
  run(bin: "ffmpeg" | "ffprobe", _args: string[]): Promise<FfmpegResult> {
    this.runs.push(bin);
    if (bin === "ffprobe") {
      return Promise.resolve({ code: 0, stdout: this.probeJson, stderr: "" });
    }
    return Promise.resolve({ code: this.encodeCode, stdout: "", stderr: "encoder said no" });
  }
  get encodes(): number {
    return this.runs.filter((r) => r === "ffmpeg").length;
  }
}

async function withWorkDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "rma-test-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function harness(leading: Uint8Array, probeJson: string) {
  return { store: new FakeStore(leading), reporter: new FakeReporter(), ffmpeg: new FakeFfmpeg(probeJson) };
}

// ── Refusals that must happen before anything moves ──────────

Deno.test("SVG is refused by content, and nothing is copied or uploaded", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.svg, PROBE.image);
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "failed", "§6 rejects SVG outright");
    assertEquals(h.reporter.failures[0], "svg_rejected", "and names it, so it is greppable");
    assertEquals(h.store.wrote().length, 0, "a refused file never reaches originals/ or public/");
  });
});

Deno.test("bytes matching nothing are refused rather than guessed at", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.garbage, PROBE.image);
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "failed", "no pipeline exists for an unknown format");
    assertEquals(h.reporter.failures[0], "unrecognised_format", "named");
    assertEquals(h.store.wrote().length, 0, "and nothing was written on the way to finding out");
  });
});

// The gate that request-upload cannot enforce: the presigned URL binds bytes, not seconds.
Deno.test("a file over the duration ceiling is refused, and never archived", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.longVideo);
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "failed", "90 minutes is past §6's largest cap");
    assertEquals(h.reporter.failures[0], "over_duration_ceiling", "named");
    assert(
      !h.store.calls.some((c) => c.startsWith("copy")),
      "a refused upload must not be copied into originals/ — it is not part of the archive",
    );
  });
});

Deno.test("a container that will not state its duration is refused, not assumed short", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.noDuration);
    const outcome = await processJob(JOB, { ...h, workDir });
    assertEquals(outcome.kind, "failed", "an uncheckable duration is an unbounded transcode");
    assertEquals(h.reporter.failures[0], "undeclarable_duration", "named");
  });
});

Deno.test("a decode that fails is the uploader's problem and is reported as such", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    h.ffmpeg.encodeCode = 1;
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "failed", "a file that will not decode is a bad file");
    assert(h.reporter.failures[0].startsWith("encode_failed"), "named by stage");
    assert(
      !h.reporter.failures[0].includes("encoder said no"),
      "and ffmpeg's stderr — derived from hostile bytes — never rides into a message the uploader sees",
    );
  });
});

// ── The failure split ────────────────────────────────────────
//
// The most consequential pair of assertions in this file. fail_ingest is TERMINAL: nothing
// walks it back. Calling it because R2 blinked would burn a contributor's photograph.

Deno.test("storage being unreachable never becomes a failed ingest", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    h.store.headThrows = true;
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "transient", "the world's problem, not the file's");
    assertEquals(h.reporter.failures.length, 0, "fail_ingest is terminal and must not be called");
  });
});

Deno.test("a manifest the database refuses is a worker bug, and is retried not burnt", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    h.reporter.completeResult = { ok: false, reason: "expected_exactly_one_master" };
    const outcome = await processJob(JOB, { ...h, workDir });

    assertEquals(outcome.kind, "transient", "this worker and the database disagree — that is ours");
    assertEquals(h.reporter.failures.length, 0, "and not something to blame the upload for");
  });
});

// ── §7 · a public URL must not name the uploader ─────────────

Deno.test("public derivatives are keyed by post, never by the uploader's id", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    await processJob(JOB, { ...h, workDir });

    const assets = h.reporter.completed[0].assets;
    const uploaderId = JOB.object_key.split("/")[0];

    for (const a of assets.filter((x) => x.bucket === "public")) {
      assert(
        !a.storage_path.includes(uploaderId),
        `${a.storage_path} carries the uploader's user id into a CDN URL — §7's aggregate ` +
          "de-anonymisation vector, handed out in a filename",
      );
      assert(
        a.storage_path.startsWith(JOB.post_id + "/"),
        `${a.storage_path} should be keyed by post id`,
      );
    }

    // The master keeps the object key, and that is fine: originals/ is never CDN-fronted,
    // so the uploader's id there is provenance rather than exposure.
    const master = assets.find((a) => a.role === "master")!;
    assertEquals(master.storage_path, JOB.object_key, "the master keeps its quarantine key");
    assertEquals(master.bucket, "originals", "§6: the archival copy, never public");
  });
});

// ── The three pipelines ──────────────────────────────────────

Deno.test("a 1080p video yields its rungs, a poster and a thumb", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.video);
    const outcome = await processJob(JOB, { ...h, workDir });
    assertEquals(outcome.kind, "ready", "the happy path");

    const assets = h.reporter.completed[0].assets;
    const rungs = assets.filter((a) => a.role === "rendition").map((a) => a.rendition).join(",");
    assertEquals(rungs, "1080p,720p,480p", "no 1440p from a 1080p source");
    assertEquals(assets.filter((a) => a.role === "poster").length, 1, "§6: a poster per video");
    assertEquals(assets.filter((a) => a.role === "thumb").length, 1, "§6: and a thumbnail");
    assertEquals(assets.filter((a) => a.role === "master").length, 1, "one master");
  });
});

Deno.test("an image yields a display rendition and a thumb", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    const outcome = await processJob(JOB, { ...h, workDir });
    assertEquals(outcome.kind, "ready", "the happy path");

    const assets = h.reporter.completed[0].assets;
    assertEquals(assets.filter((a) => a.role === "rendition").length, 1, "one display copy");
    assertEquals(assets.filter((a) => a.role === "thumb").length, 1, "one thumbnail");
    assertEquals(h.reporter.completed[0].mime, "image/jpeg", "the SNIFFED type is reported");
  });
});

// The reason migration 0029 exists: before it, this row had no shape it could take.
Deno.test("audio yields one normalized rendition on the audio rung", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.ogg, PROBE.audio);
    const outcome = await processJob(JOB, { ...h, workDir });
    assertEquals(outcome.kind, "ready", "the happy path");

    const assets = h.reporter.completed[0].assets;
    const rendition = assets.find((a) => a.role === "rendition")!;
    assertEquals(rendition.rendition, "audio", "migration 0029's rung");
    assertEquals(rendition.mime, "audio/ogg", "Opus in Ogg");
    assertEquals(assets.filter((a) => a.role === "thumb").length, 1, "a waveform card for the grid");
  });
});

Deno.test("quarantine is cleared only after the ingest is recorded", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.jpeg, PROBE.image);
    await processJob(JOB, { ...h, workDir });

    const removeAt = h.store.calls.findIndex((c) => c.startsWith("remove"));
    const copyAt = h.store.calls.findIndex((c) => c.startsWith("copy"));
    assert(removeAt !== -1, "the quarantine object is cleaned up");
    assert(copyAt !== -1 && copyAt < removeAt, "and never before the master is safe");
  });
});

Deno.test("preservation happens before any transcode", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.video);
    await processJob(JOB, { ...h, workDir });

    const copyAt = h.store.calls.findIndex((c) => c.startsWith("copy"));
    const firstUpload = h.store.calls.findIndex((c) => c.startsWith("upload"));
    assert(
      copyAt < firstUpload,
      "if this dies mid-ladder, the archival copy must already exist (§6)",
    );
  });
});

// ── The manifest guard ───────────────────────────────────────

Deno.test("assertManifest enforces §6's bucket rules before the database has to", () => {
  const master: AssetRow = {
    role: "master",
    storage_path: "u/k",
    bucket: "originals",
    mime: "image/jpeg",
    sort_order: 0,
  };
  const thumb: AssetRow = {
    role: "thumb",
    storage_path: "p/thumb.webp",
    bucket: "public",
    mime: "image/webp",
    sort_order: 1,
  };

  assertManifest([master, thumb]); // the valid case

  const cases: Array<[string, AssetRow[]]> = [
    ["no master", [thumb]],
    ["two masters", [master, { ...master, storage_path: "u/k2" }, thumb]],
    ["master in public", [{ ...master, bucket: "public" }, thumb]],
    ["derivative in originals", [master, { ...thumb, bucket: "originals" }]],
    ["rendition with no rung", [master, { ...thumb, role: "rendition" }]],
    ["an SVG derivative", [master, { ...thumb, mime: "image/svg+xml" }]],
  ];

  for (const [label, assets] of cases) {
    let threw = false;
    try {
      assertManifest(assets);
    } catch {
      threw = true;
    }
    assert(threw, `${label} must be caught here, before the bytes are already in a bucket`);
  }
});

/* ── The per-job deadline ───────────────────────────────────────
 *
 * JOB_TIMEOUT_MS in main.ts is a per-INVOCATION watchdog: it kills one hung decoder. It
 * does not bound the job, because a video makes six invocations and each gets a fresh
 * timer — 6 x 25 minutes before the last one fires. This is the ceiling on the whole job.
 *
 * The value is derived in pipeline.ts from a two-point measurement, and one of its terms
 * (real footage versus lavfi testsrc) is an ESTIMATE. That is recorded at the constant.
 */

Deno.test("the deadline is the derived four hours, not a round guess", () => {
  assertEquals(JOB_DEADLINE_MS, 240 * 60 * 1000, "see pipeline.ts for the arithmetic");
});

Deno.test("a job already past its deadline does no work at all", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.video);
    const outcome = await processJob(JOB, {
      ...h,
      workDir,
      now: () => 1_000,
      deadlineAt: 500, // already spent
    });

    assertEquals(outcome.kind, "failed", "an over-deadline job must be permanent, not transient");
    assert(
      outcome.kind === "failed" && outcome.reason.startsWith("job_deadline_exceeded"),
      `wrong reason: ${JSON.stringify(outcome)}`,
    );
    assertEquals(h.ffmpeg.encodes, 0, "it encoded something despite being out of time");
    assertEquals(
      h.reporter.failures[0]?.startsWith("job_deadline_exceeded"),
      true,
      "the uploader is not told why the ingest failed",
    );
  });
});

// THE assertion that the remaining rungs actually abort, and it is pinned to an EXACT
// count rather than an upper bound. That is deliberate and it is the whole discrimination.
//
// checkDeadline is called from two places — encode() and probe() — and probe() runs once
// per published asset, so the two interleave all the way down the ladder. An upper bound
// of "fewer than the full ladder" is satisfied by EITHER site alone: with the check
// deleted from encode() the clock is only consulted after each publish, so rungs two and
// three encode in full before anything notices, and the count comes in at 3. Measured, not
// reasoned — that mutation left the bounded version green.
//
// Three encodes where the design promises one is not a rounding difference. Each is a
// 4K rung, and JOB_DEADLINE_MS exists precisely to stop a job spending them; a ceiling
// whose test tolerates two extra encodes past the deadline is not testing the ceiling.
//
// So: exactly one. The clock advances 30 per check against a deadline of 100, which fires
// on the fourth — probe(source), encode(1080p), probe(1080p output), then the 720p encode
// is refused. If the number of probes on this path ever legitimately changes, this figure
// changes with it and somebody re-derives it, which is the correct outcome for a cost
// ceiling and the reason it is not written as a range.
Deno.test("a deadline reached mid-ladder abandons the remaining rungs", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.video);
    let t = 0;
    const outcome = await processJob(JOB, {
      ...h,
      workDir,
      now: () => (t += 30),
      deadlineAt: 100, // fires on the fourth check
    });

    assertEquals(outcome.kind, "failed", "the job did not stop");
    assertEquals(
      h.ffmpeg.encodes,
      1,
      "the ladder ran past its budget — see this test's header for why the count is exact",
    );
  });
});

// THE COUNTER-TEST. Without it, a checkDeadline that threw unconditionally would pass both
// assertions above and every video in the archive would fail to ingest.
Deno.test("...and a deadline that has not arrived changes nothing", async () => {
  await withWorkDir(async (workDir) => {
    const h = harness(SIGNATURES.webm, PROBE.video);
    const outcome = await processJob(JOB, {
      ...h,
      workDir,
      now: () => 1_000,
      deadlineAt: 9_999_999,
    });

    assertEquals(outcome.kind, "ready", "a job inside its budget was refused");
    const assets = h.reporter.completed[0].assets;
    assertEquals(
      assets.filter((a) => a.role === "rendition").map((a) => a.rendition).join(","),
      "1080p,720p,480p",
      "the full ladder still runs when there is time for it",
    );
  });
});
