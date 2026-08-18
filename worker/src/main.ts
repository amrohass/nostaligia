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
    return new Response(JSON.stringify({ ok: true, busy }), {
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

  // Read the body as TEXT and verify it before parsing. See job.ts: re-serialising to check
  // a signature compares against this runtime's key order rather than the sender's.
  const rawBody = await req.text();
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
