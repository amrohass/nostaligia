-- 0041 · The reaper is M1's, release-only, and held on one number
--
-- A comment-only migration, and it exists because the comment is wrong in the deployed
-- database rather than merely in a file. 0030 wrote
--
--     'When the current worker took it. Written from 0030, read by the M6 reaper.'
--
-- onto public.posts.processing_started_at, and `\d+ posts` is where the next person looks
-- to find out what an unused column is for. That sentence now says two false things: the
-- reaper is not M6's, and it is not merely unscheduled — it is blocked on a specific,
-- named measurement. Someone reading the old comment in M2 would reasonably conclude the
-- column is dormant for four more milestones and stop asking.
--
-- ── What actually changed, and when ──────────────────────────
--
-- §12, 20 Aug 2026: the stuck-job reaper was pulled forward into M1's retry path and
-- narrowed to RELEASE-ONLY. It returns a stranded 'processing' row to 'awaiting_bytes'
-- and stops there — it does not re-dispatch the job, because re-dispatch would reopen the
-- deferred question of what identity invokes the worker, which is a deployment decision
-- this project has not taken. A released row is retried by the uploader's own client
-- through complete-upload, which is a path that already exists and is already bounded by
-- ingest_attempts.
--
-- ── Why the function itself is still not here ────────────────
--
-- public.reap_stale_ingests() needs one constant: c_ingest_lease, the age at which a
-- 'processing' row is presumed stranded. That is derived as
--
--     JOB_DEADLINE_MS + the cron period + margin
--
-- and JOB_DEADLINE_MS (CLAUDE.md §6, worker/src/pipeline.ts) still carries an unmeasured
-- factor as its dominant term. A lease set too short kills live 4K transcodes; too long
-- and a stranded upload stays invisible for hours. Both are worse than waiting, and the
-- probe that settles it is a single run against the deployed worker.
--
-- So this migration ships the correction and not the function. The column keeps being
-- written, the record of WHY is now accurate, and the reaper lands in one piece when it
-- has a number rather than in two pieces around a guess.

set search_path = public, extensions;

comment on column public.posts.processing_started_at is
  'When the current worker took it. Written from 0030. Read by public.reap_stale_ingests(), '
  'which is release-only (§12, 20 Aug 2026) and is deliberately unwritten until the '
  'deployed-worker probe settles c_ingest_lease.';
