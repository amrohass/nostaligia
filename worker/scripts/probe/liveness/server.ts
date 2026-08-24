/* Throwaway probe: does Scaleway Serverless Containers keep a min-scale=0 instance alive
 * while it works AFTER answering 202, with no request in flight?
 *
 * worker/README.md "The deadline gap": the real worker answers 202 and then transcodes.
 * Scaleway documents "all instances terminated after 15 minutes of inactivity" for
 * min-scale=0 and is silent on post-response work. Cloud Run answered this with
 * --no-cpu-throttling; Scaleway documents no equivalent. Nothing here is settled by
 * reading more documentation.
 *
 * The three outcomes this is built to tell apart:
 *
 *   TERMINATED  logs stop near 15 min and never resume. min-scale=0 is unsafe.
 *   FROZEN      a heartbeat gap far larger than 30s, then heartbeats resume. CPU is
 *               throttled between requests: the job would not die but would take
 *               unbounded wall-clock, which for JOB_DEADLINE_MS is the same problem.
 *   ALIVE       40 minutes of 30s heartbeats with no gap. min-scale=0 is safe.
 *
 * FROZEN is why every beat carries both a wall-clock timestamp and the gap since the
 * previous beat. A log that merely stops cannot distinguish the first two, and they have
 * different answers.
 */

const BOOT_ID = crypto.randomUUID().slice(0, 8);
const BOOT_AT = new Date();
const BEAT_MS = 30_000;
const RUN_MS = 40 * 60_000;

function log(event: string, extra: Record<string, unknown> = {}) {
  console.log(JSON.stringify({
    probe: "scw-post-response",
    boot: BOOT_ID,
    at: new Date().toISOString(),
    event,
    ...extra,
  }));
}

log("boot", { beat_ms: BEAT_MS, run_ms: RUN_MS });

let running = false;

/* The beats are kept in memory and served back from /report, so the result does NOT depend
 * on retrieving container logs. Scaleway ships serverless logs to Cockpit, which means a
 * Loki token and a query round-trip; worse, an empty Loki result is ambiguous between "the
 * instance died" and "the log pipeline lagged", which is precisely the distinction this
 * probe exists to make.
 *
 * Reading /report is one request AFTER the run window has closed, so it cannot extend the
 * inactivity timer during the measurement. And it is self-interpreting:
 *
 *   same boot id + 80 beats + no gap  → ALIVE
 *   same boot id + a large gap        → FROZEN (and the gap size is the evidence)
 *   DIFFERENT boot id, no history     → the instance that answered 202 is gone
 */
interface Beat { beat: number; at: string; elapsed_s: number; gap_ms: number }
const beats: Beat[] = [];
let acceptedAt: string | null = null;

async function heartbeat() {
  const t0 = Date.now();
  let beat = 0;
  let prev = t0;
  while (Date.now() - t0 < RUN_MS) {
    await new Promise((r) => setTimeout(r, BEAT_MS));
    const now = Date.now();
    beat++;
    const rec: Beat = {
      beat,
      at: new Date(now).toISOString(),
      elapsed_s: Math.round((now - t0) / 1000),
      // A gap far above BEAT_MS means the instance was frozen, not terminated. This is
      // the whole reason the probe measures rather than just prints a counter.
      gap_ms: now - prev,
    };
    beats.push(rec);
    log("beat", { ...rec, since_boot_s: Math.round((now - BOOT_AT.getTime()) / 1000) });
    prev = now;
  }
  log("done", { beats: beat, elapsed_s: Math.round((Date.now() - t0) / 1000) });
  running = false;
}

Deno.serve({ port: 8080, hostname: "0.0.0.0" }, (req) => {
  const url = new URL(req.url);
  if (url.pathname === "/health") return new Response("ok\n", { status: 200 });

  if (url.pathname === "/report") {
    const last = beats[beats.length - 1] ?? null;
    const maxGap = beats.reduce((m, b) => Math.max(m, b.gap_ms), 0);
    return new Response(
      JSON.stringify({
        boot: BOOT_ID,
        booted_at: BOOT_AT.toISOString(),
        accepted_at: acceptedAt,
        running,
        beat_count: beats.length,
        last_beat: last,
        max_gap_ms: maxGap,
        beats,
      }, null, 2) + "\n",
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }

  if (running) {
    log("already_running");
    return new Response(JSON.stringify({ boot: BOOT_ID, already_running: true }) + "\n", {
      status: 409,
      headers: { "content-type": "application/json" },
    });
  }
  running = true;
  acceptedAt = new Date().toISOString();
  log("accepted", { path: url.pathname, method: req.method });

  // Deliberately NOT awaited, and no waitUntil equivalent: this is exactly the shape the
  // real worker uses in worker/src/main.ts — answer, then work with nothing in flight.
  heartbeat();

  return new Response(JSON.stringify({ boot: BOOT_ID, accepted: true }) + "\n", {
    status: 202,
    headers: { "content-type": "application/json" },
  });
});
