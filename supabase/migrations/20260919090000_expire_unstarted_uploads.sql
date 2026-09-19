-- 0065 · An upload that never started is failed, and its daily slot given back
--
-- The defect, measured 18 Sep 2026 against the deployed database: two posts (29 Aug and
-- 17 Sep) sat in 'awaiting_bytes' with ingest_attempts = 0, and signed HEADs found no
-- object in quarantine/ or originals/. request-upload creates the row BEFORE the browser's
-- PUT; a PUT that fails or is abandoned leaves it; the share sheet's retry calls
-- request-upload again and makes a NEW row. Nothing ever moved the old one. The member saw
-- "لم يكتمل الرفع" forever, the row could never reach the moderation queue (0025 requires
-- 'ready'), and it had spent one of that day's upload slots.
--
-- ── Which rows, exactly ──────────────────────────────────────
--
-- `ingest_attempts = 0` and 'awaiting_bytes' is the precise shape of "complete-upload never
-- reached begin_ingest": begin_ingest increments attempts on its first call, and
-- release_ingest never decrements them (0031). A row a worker gave back has attempts >= 1
-- and bytes known to be in quarantine; it is NOT this function's, and stays with the
-- processing reaper that is still held on the deployed-worker probe (0041). Nothing here
-- depends on JOB_DEADLINE_MS.
--
-- Approved rows are left alone. An approved post with no bytes is an anomaly this function
-- is not the place to judge, and touching one would move the content revision and dispatch
-- a publish (0042) for a row publishable_posts() never returns anyway.
--
-- ── The window ───────────────────────────────────────────────
--
-- request-upload signs a PUT valid for 300 s (URL_TTL_SECONDS), and R2, like S3, checks
-- that expiry when the request BEGINS — so five minutes bounds the start of a transfer,
-- not its end. The window is therefore five minutes plus the longest transfer we are
-- willing to wait for, and it follows §6's role-aware caps through author_label, which
-- posts_stamp_authorship stamps from the same role request-upload read:
--
--     member             200 MB   + 60 min  ≈ 0.45 Mbit/s sustained
--     moderator / admin    4 GB   + 6 h     ≈ 1.6  Mbit/s sustained
--
-- Set long on purpose. Too short fails a slow but real upload: its complete-upload then
-- meets 'terminal_state', and bytes that did arrive are stranded in quarantine. Too long
-- only leaves an orphan labelled "incomplete" for an hour more.
--
-- ── The slot, and why NOT the bytes ──────────────────────────
--
-- The row's day in upload_quota gets its COUNT back — the daily slot. Its BYTES stay
-- charged, and that is the cost ceiling rather than an oversight:
--
--   · the declared size is not stored on the post, so there is no exact figure to return;
--   · more to the point, this function cannot see R2. `attempts = 0` means complete-upload
--     never ran, not that no bytes arrived — a PUT that finished before the tab closed
--     leaves an object in quarantine all the same, and quarantine has no lifecycle rule
--     yet (§6 names one; it is unprovisioned). If bytes were returned too, a member could
--     claim, PUT, never complete, wait an hour and repeat, writing an unbounded number of
--     bytes a day into a bucket nothing empties. With bytes kept, every signed PUT still
--     counts against §6's daily byte ceiling, and the signature binds content-length, so
--     that ceiling still bounds what can be written.
--
-- Each claim still needs a Turnstile token, so a returned slot is not a way to automate
-- anything.

set search_path = public, extensions;

create or replace function public.expire_unstarted_uploads()
returns integer
language plpgsql
set search_path = ''
as $$
declare
  -- request-upload's URL_TTL_SECONDS. Change both together.
  c_url_ttl         constant interval := interval '5 minutes';
  c_member_transfer constant interval := interval '60 minutes';
  c_staff_transfer  constant interval := interval '6 hours';
  v_expired         integer;
begin
  with expired as (
    update public.posts p
       set ingest_state = 'failed',
           ingest_error = 'upload_expired'
     where p.ingest_state = 'awaiting_bytes'
       and p.ingest_attempts = 0
       and p.status <> 'approved'
       and p.created_at < now() - c_url_ttl
                              - case when p.author_label = 'member' then c_member_transfer
                                     else c_staff_transfer end
    returning p.created_by, (p.created_at at time zone 'UTC')::date as day
  ),
  -- The day the slot was CHARGED, by the same expression claim_upload_quota uses
  -- (`(now() at time zone 'UTC')::date`, evaluated in the transaction that inserted the
  -- row), so a slot is returned to the day it was taken from even when the reaper runs
  -- after midnight.
  per_day as (
    select e.created_by, e.day, count(*)::integer as n
      from expired e
     where e.created_by is not null
     group by e.created_by, e.day
  ),
  released as (
    update public.upload_quota q
       set count = greatest(q.count - d.n, 0)
      from per_day d
     where q.user_id = d.created_by
       and q.day = d.day
    returning 1
  )
  select count(*)::integer into v_expired from expired;

  return v_expired;
end;
$$;

comment on function public.expire_unstarted_uploads() is
  'Fails uploads whose bytes never arrived (attempts = 0, past the signed URL plus a transfer '
  'window) and returns the day''s upload slot — count, not bytes (0065).';

-- Nobody a browser can be. pg_cron runs it as the owner; the service role may run it by hand.
revoke execute on function public.expire_unstarted_uploads() from public, anon, authenticated;
grant  execute on function public.expire_unstarted_uploads() to service_role;

-- Every fifteen minutes, so an orphan turns "failed" within 15 minutes of its window. The
-- UPDATE touches at most a handful of rows; pg_cron's run log gains ~96 rows a day.
-- cron.schedule with a job name is an upsert, so re-applying this re-points rather than
-- duplicates.
select cron.schedule('rma-expire-uploads', '*/15 * * * *',
                     $job$select public.expire_unstarted_uploads()$job$);
