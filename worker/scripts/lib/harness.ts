/* What ladder-fixture.ts and exif-gate.ts both need to drive the real pipeline: an ffmpeg
 * that is actually ffmpeg, and a reporter that keeps what the pipeline tried to record
 * instead of sending it to PostgREST.
 *
 * One copy rather than two. A fake that drifts from its twin produces two scripts that
 * disagree about what the pipeline did, and the one you did not run is the one that was
 * right.
 */

import type { AssetRow, IngestReporter, RpcOutcome } from "../../src/db.ts";
import type { Ffmpeg, FfmpegResult } from "../../src/pipeline.ts";

export class RealFfmpeg implements Ffmpeg {
  async run(bin: "ffmpeg" | "ffprobe", a: string[]): Promise<FfmpegResult> {
    const out = await new Deno.Command(bin, { args: a, stdout: "piped", stderr: "piped" })
      .output();
    return {
      code: out.code,
      stdout: new TextDecoder().decode(out.stdout),
      stderr: new TextDecoder().decode(out.stderr),
    };
  }
}

/** complete_ingest and fail_ingest, kept in memory. The RPCs themselves are pgTAP's job. */
export class CapturingReporter implements IngestReporter {
  assets: AssetRow[] = [];
  failure: string | null = null;
  complete(_k: string, _m: string, assets: AssetRow[]): Promise<RpcOutcome> {
    this.assets = assets;
    return Promise.resolve({ ok: true });
  }
  fail(_k: string, reason: string): Promise<RpcOutcome> {
    this.failure = reason;
    return Promise.resolve({ ok: true });
  }
}

/** A named check that records rather than throws, so one run reports every failure it found. */
export class Checks {
  readonly failures: string[] = [];
  check(condition: boolean, message: string): void {
    if (!condition) this.failures.push(message);
  }
  /** Prints what failed and exits non-zero, or prints the tally. Returns nothing: it exits. */
  report(passedMessage: string): never {
    if (this.failures.length > 0) {
      console.error(`\n${this.failures.length} check(s) failed:`);
      for (const f of this.failures) console.error(`  ✗ ${f}`);
      Deno.exit(1);
    }
    console.log(`\n${passedMessage}`);
    Deno.exit(0);
  }
}
