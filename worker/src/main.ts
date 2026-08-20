// The worker's HTTP surface: two routes, one of which does anything.
//
// ── Why it answers 202 and then works ────────────────────────
//
// complete-upload awaits this response. A 20-minute ladder held open would blow that
// function's own wall-clock limit long before ffmpeg finished, and the Edge Function would
// report a failure for a job that was progressing fine. So the job is acknowledged as soon
// as it is proven authentic, and the transcode runs after the response — which is why
// Cloud Run must be deployed with --no-cpu-throttling. Without it the instance is throttled
// to near zero the moment the response is sent and the job never finishes.
//
// That flag does NOT break §6's scale-to-zero requirement: it governs CPU on a live
// instance between requests, not whether idle instances are kept alive. --min-instances=0
// is what answers that, and it is in the deploy command.
//
// ── Why it refuses work while busy ───────────────────────────
//
// Cloud Run considers a request finished when the response is sent, so with the 202 above
// it would happily route a second job to an instance already using every core. The busy
// flag turns that into a 503, which complete-upload treats as a failed invocation and
// releases (migration 0031) — so the retry lands on a fresh instance instead of two
// transcodes fighting over one CPU.
//
// ── What an unauthenticated caller can spend ─────────────────
//
// That busy flag is also the shape of an availability failure, and it is the reason for
// the byte cap below. Concurrency is 1 and max-instances is 3, so three requests occupy
// the ENTIRE worker fleet for as long as they are being received. An unauthenticated
// caller cannot get a job run — verifyJob refuses it — but without a cap it can hold an
// instance open streaming a body that will be rejected at the end, and members' uploads
// queue behind 401s that have not happened yet. §6's cost ceiling is meant to refuse
// exactly this, and a per-request memory bound is the cheap half of refusing it.
//
// So the body is read against a constant cap BEFORE the signature is checked. That is
// deliberately the wrong order for authentication and the right one for resources: there
// is no way to verify a signature over bytes that have not arrived, so the only question
// is how many bytes we are willing to accept before we can. The answer is 8 KiB.
//
// This bounds memory per request. It does not bound how long an unauthenticated caller can
// hold a connection, and it is not a substitute for putting the service behind an invoker
// identity — it is what makes the exposure finite while that decision is open.

import { verifyJob } from "./job.ts";
import { PostgrestReporter } from "./db.ts";
import { LocalStore, type ObjectStore, R2Store } from "./store.ts";
import { type Ffmpeg, type FfmpegResult, processJob } from "./pipeline.ts";

function env(name: string): string {
  const v = Deno.env.get(name);
  if (!v) throw new Error(`missing required environment variable: ${name}`);
  return v;
}

/** A wedged decoder must not hold an instance until Cloud Run's own timeout. */
const JOB_TIMEOUT_MS = Number(Deno.env.get("JOB_TIMEOUT_MS") ?? 25 * 60 * 1000);

/**
 * The most a job body may be, in bytes. See the header for why it exists.
 *
 * Deliberately a constant and NOT an environment variable. Every other limit in this
 * system is a policy figure an operator might reasonably tune; this one is derived from
 * the payload complete-upload actually sends, so a deployment that needed a different
 * value would be a deployment whose job shape had changed — which is a code change, and
 * should arrive as one. An env var here would also be a way to widen the exposure above
 * from outside the repository, which is the opposite of the point.
 *
 * The arithmetic. A job is `{object_key, post_id, issued_at}` and nothing else
 * (job.ts). object_key is `<uploader uuid>/<object uuid>` — 73 bytes; post_id is a UUID
 * — 36; issued_at is an ISO-8601 timestamp with milliseconds — 24; JSON framing for
 * three named string fields — ~45. **The largest legitimate body is about 180 bytes.**
 *
 * 8 KiB is ~45x that. The headroom is not caution about the numbers above, which are
 * exact — it is so that adding fields to Job never requires anyone to remember this
 * constant exists. And it is still four orders of magnitude below what Cloud Run would
 * otherwise let an anonymous caller push into a 4 GiB instance (32 MiB per request).
 */
export const MAX_JOB_BODY_BYTES = 8 * 1024;

/**
 * The request body, or null if it is over the cap.
 *
 * Two refusals, because one is not enough. Content-Length is checked first so an honest
 * oversized request costs nothing at all — but it is a claim by the sender, and a chunked
 * request carries no Content-Length to check. So the stream is also counted as it
 * arrives and abandoned the moment it passes the cap, which is what actually bounds a
 * caller who lies or simply never stops sending.
 *
 * `cancel()` rather than draining: the point is to stop the sender, and reading a body to
 * its end in order to reject it would spend exactly the resource being protected.
 */
async function readCappedBody(req: Request, cap: number): Promise<string | null> {
  const declared = req.headers.get("Content-Length");
  if (declared !== null) {
    const n = Number(declared);
    // A malformed Content-Length is refused too. It is not a header a legitimate client
    // constructs by hand — fetch() sets it — so an unparseable one is a probe.
    if (!Number.isFinite(n) || n < 0 || n > cap) return null;
  }
  if (!req.body) return "";

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }

  const buf = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    buf.set(c, at);
    at += c.byteLength;
  }
  // Byte-identical to what req.text() would have produced, which matters: the signature
  // is computed over these exact bytes and a different decode is a different message.
  return new TextDecoder().decode(buf);
}

class RealFfmpeg implements Ffmpeg {
  async run(bin: "ffmpeg" | "ffprobe", args: string[]): Promise<FfmpegResult> {
    const command = new Deno.Command(bin, {
      args,
      stdout: "piped",
      stderr: "piped",
      // Nothing is ever written to the child's stdin. -nostdin is passed as well; both are
      // here because a decoder that blocks waiting for input is a decoder that holds an
      // instance forever.
      stdin: "null",
    });
    const child = command.spawn();
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch { /* already gone */ }
    }, JOB_TIMEOUT_MS);

    try {
      const { code, stdout, stderr } = await child.output();
      return {
        code,
        stdout: new TextDecoder().decode(stdout),
        stderr: new TextDecoder().decode(stderr),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}

function buildStore(): ObjectStore {
  // The local backend exists for worker/scripts/ladder-fixture.ts, which runs the real
  // pipeline against a directory so a laptop needs no MinIO. It is selected by an explicit
  // opt-in, never by a missing credential — a store that silently falls back to the local
  // disk when R2 is misconfigured would report success while writing the archive nowhere.
  if (Deno.env.get("MEDIA_WORKER_STORE") === "local") {
    return new LocalStore(env("MEDIA_WORKER_LOCAL_ROOT"));
  }
  return new R2Store({
    accountId: env("R2_ACCOUNT_ID"),
    accessKeyId: env("R2_ACCESS_KEY_ID"),
    secretAccessKey: env("R2_SECRET_ACCESS_KEY"),
  });
}

let busy = false;

export async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "GET" && url.pathname === "/healthz") {
    // `ok` and nothing else. This route is unauthenticated by necessity — a platform
    // health check cannot hold a signing secret — so everything in its response is
    // readable by anyone with the URL. It used to report `busy`, which turned it into a
    // free oracle for whether the fleet was saturated: exactly the signal an attacker
    // wants while occupying it, and exactly the signal a member's stalled upload is
    // evidence of. Liveness is all a health check is entitled to know.
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (req.method !== "POST" || url.pathname !== "/jobs") {
    return new Response(JSON.stringify({ error: "not_found" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Bounded FIRST, before the secret is read and before a signature is computed. An
  // over-cap body is refused having cost one header lookup and at most 8 KiB — see the
  // header for why that ordering is the resource answer rather than an auth weakening.
  const rawBody = await readCappedBody(req, MAX_JOB_BODY_BYTES);
  if (rawBody === null) {
    return new Response(JSON.stringify({ error: "job_too_large" }), {
      status: 413,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Verified as TEXT, before parsing. See job.ts: re-serialising to check a signature
  // compares against this runtime's key order rather than the sender's.
  const verdict = await verifyJob(
    rawBody,
    req.headers.get("X-Signature"),
    env("MEDIA_WORKER_SECRET"),
  );

  if (!verdict.ok) {
    // 401 for every rejection, with the reason in the body but not in the status. An
    // unauthenticated caller learns whether their signature or their timestamp was wrong
    // only if we tell them, and there is no reason to.
    return new Response(JSON.stringify({ error: verdict.reason }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  if (busy) {
    return new Response(JSON.stringify({ error: "busy" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
  busy = true;

  const job = verdict.job;

  // Deliberately not awaited. The response goes out now; see the header.
  (async () => {
    const workDir = await Deno.makeTempDir({ prefix: "rma-ingest-" });
    try {
      const outcome = await processJob(job, {
        store: buildStore(),
        reporter: new PostgrestReporter({
          url: env("SUPABASE_URL"),
          anonKey: env("SUPABASE_ANON_KEY"),
          workerJwt: env("MEDIA_WORKER_JWT"),
        }),
        ffmpeg: new RealFfmpeg(),
        workDir,
      });
      // The object key is logged and the post id is not: the key is what an operator
      // correlates against R2, and it is already in the Edge Function's logs.
      console.log(JSON.stringify({ object_key: job.object_key, outcome: outcome.kind }));
    } catch (e) {
      console.error(JSON.stringify({ object_key: job.object_key, unhandled: String(e) }));
    } finally {
      // A 4 GB master plus four renditions on a container filesystem is not something to
      // leave behind on an instance that will serve the next job.
      await Deno.remove(workDir, { recursive: true }).catch(() => {});
      busy = false;
    }
  })();

  return new Response(JSON.stringify({ accepted: true, object_key: job.object_key }), {
    status: 202,
    headers: { "Content-Type": "application/json" },
  });
}

if (import.meta.main) {
  const port = Number(Deno.env.get("PORT") ?? 8080);
  Deno.serve({ port }, handleRequest);
}
