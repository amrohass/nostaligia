# Probe tooling

Operational scripts, not part of the worker image — `worker/Dockerfile` copies `worker/src`
only, so nothing here ships. They exist because two questions about the worker can only be
answered by measurement, and both answers are cited elsewhere in the repository.

| | |
|---|---|
| `run-sweep.ts` | drives `../probe-timing.ts` once per media file, inside the built image |
| `report.ts` | turns the resulting NDJSON into `docs/probe-results.md` |
| `liveness/` | the throwaway container that answered the `min-scale` question |

## Timing sweep

```bash
docker build -f worker/Dockerfile -t rma-media-worker:probe .

deno run --allow-read --allow-write --allow-run --allow-env \
  worker/scripts/probe/run-sweep.ts \
  --dir fottage --out docs/probe-samples.ndjson --log docs/probe-run.txt

deno run --allow-read --allow-write worker/scripts/probe/report.ts \
  --in docs/probe-samples.ndjson --out docs/probe-results.md \
  --host "<cpu model, core count, year>" --ffmpeg "ffmpeg 7.1.5 on trixie" \
  --commit "$(git rev-parse --short HEAD)"
```

**Do not run anything else CPU-heavy while a sweep is in progress.** A sample that lost CPU
to a concurrent build looks *exactly* like a slow sample — there is no marker in the output,
and the only way to catch it is to know it happened. One sample had to be re-run for this
reason on 24 Aug 2026.

`run-sweep.ts` uses `--cpuset-cpus`, never `--cpus`. The latter is a CFS quota, so ffmpeg's
thread auto-detection still sees every host core and spawns that many threads to share a
fraction of one — which measures thrash, not a 2-vCPU instance.

`report.ts` derives nothing. §6 keeps `JOB_DEADLINE_MS` with the maintainer, and a generator
that printed "therefore N minutes" would be making that decision. It also excludes any
`--source synthetic` row from the report outright.

## Liveness probe — does the host keep working after the response?

`main.ts` answers `202` and then transcodes with **no request in flight**. Every scale-to-zero
HTTP platform decides idleness by request activity, so whether that survives is a property of
the host, not of this code. `liveness/` answers 202 and then heartbeats every 30s for 40
minutes — the same shape — and serves its own history from `/report`.

Serving the beats back is deliberate rather than reading platform logs: an empty log result
cannot distinguish *the instance died* from *the log pipeline lagged*, which is the exact
distinction being measured. Every beat also carries the wall-clock gap since the last one, so
a **freeze** is legible as a huge gap rather than looking identical to termination.

```bash
docker build -t <registry>/scw-probe:v1 worker/scripts/probe/liveness
docker push <registry>/scw-probe:v1
# deploy at min-scale=0, then:
curl -X POST https://<endpoint>/jobs -d '{}'        # note the boot id in the 202
# wait past the run window, sending NOTHING — any request resets the inactivity timer
curl https://<endpoint>/report
```

Read the result by boot id:

| | |
|---|---|
| same boot id, full beat count, no gap | **alive** — post-response work is safe |
| same boot id, one huge gap | **frozen** — survived, but wall clock is unbounded |
| **different** boot id, empty history | **the instance that took the job is gone** |

Ran against Scaleway Serverless Containers at `min-scale=0` on 24 Aug 2026: different boot
id, cold-started seven seconds after the request, empty history. See `worker/README.md`
→ "What the heartbeat probe measured".
