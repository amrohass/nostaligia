-- 0024 · The quota gate behind request-upload
--
-- §6, cost ceiling layer three: "per-user daily quotas enforced in the database".
-- The emphasis is the point. The obvious implementation — SELECT the counter in the
-- Edge Function, compare, then UPDATE — is a time-of-check/time-of-use race: two
-- concurrent requests both read count = 19, both conclude they are under the limit of
-- 20, and both write 20. Under a script that is not an edge case, it is the normal
-- outcome. A quota enforced across two statements is not enforced.
--
-- So the read and the write are ONE statement here, and the limit lives in its WHERE
-- clause. Concurrency is then Postgres' problem, which it is equipped for: the second
-- transaction blocks on the row lock, re-evaluates against the committed count, and
-- is refused.
--
-- ── What this function does NOT do ───────────────────────────
--
-- Per-file size and duration caps are not here. §6 places those in request-upload,
-- read from the JWT role claim, and duration is not a thing the database is told
-- about. Splitting them this way means each limit has exactly one home:
--
--     per-file size / duration   ->  request-upload (§6)
--     per-day count / bytes      ->  this function  (§6)
--
-- Two homes, no overlap, nothing to drift.

set search_path = public, extensions;

-- ── The daily limits ─────────────────────────────────────────
--
-- CLAUDE.md requires per-user daily quotas but does not name the numbers, so these
-- are CHOSEN, not derived, and are the one thing in this file worth arguing about.
-- They are sized off §6's per-file caps: a member's 1 GiB/day admits five 200 MB
-- uploads or twenty small ones; a moderator's 40 GiB/day admits ten 4 GB masters.
--
-- Kept as a function rather than inlined so that the Edge Function's error message
-- and the enforcement read the same numbers.
create or replace function public.upload_daily_limits(p_role public.app_role)
returns table (max_count integer, max_bytes bigint)
language sql
immutable
set search_path = ''
as $$
  select
    case when p_role in ('moderator', 'admin') then 200 else 20 end,
    case when p_role in ('moderator', 'admin')
         then 42949672960::bigint   -- 40 GiB
         else  1073741824::bigint   --  1 GiB
    end;
$$;

comment on function public.upload_daily_limits(public.app_role) is
  'Per-day upload ceilings by role. Numbers chosen, not specified by CLAUDE.md.';

revoke execute on function public.upload_daily_limits(public.app_role) from public;
grant  execute on function public.upload_daily_limits(public.app_role) to authenticated, service_role;

-- ── The gate ─────────────────────────────────────────────────
--
-- SECURITY DEFINER because upload_quota has every privilege revoked from anon and
-- authenticated and RLS enabled with no policy — a member who can write this table
-- can lift their own quota, so nobody may. The definer context is the only way in.
--
-- Identity comes from auth.uid(), never from an argument. If the caller supplied the
-- user id, then a bug anywhere in the Edge Function would let one member spend
-- another's quota — or, worse, let a forged request spend nobody's. Deriving it from
-- the verified JWT means PostgREST has already authenticated the caller before this
-- function runs, and this call is therefore an independent authentication check as
-- well as a quota check. request-upload leans on that deliberately: it does not
-- trust the Edge gateway's verify_jwt to be the only thing standing between an
-- anonymous request and a signed URL.
--
-- `set timezone = 'UTC'` is load-bearing, not tidiness. The day boundary is the
-- quota's reset, and current_date is evaluated in the CALLER's TimeZone. Without
-- this, `SET TimeZone = 'Pacific/Kiritimati'` on the session rolls the date forward
-- and hands the caller a fresh day's allowance on demand — a one-line quota bypass
-- from any client that can issue a SET. Pinned here, the date is the same for
-- everyone regardless of what the session says.
create or replace function public.claim_upload_quota(p_bytes bigint)
returns jsonb
language plpgsql
security definer
set search_path = ''
set timezone = 'UTC'
as $$
declare
  v_uid       uuid := (select auth.uid());
  v_role      public.app_role;
  v_day       date := (now() at time zone 'UTC')::date;
  v_max_count integer;
  v_max_bytes bigint;
  v_count     integer;
  v_bytes     bigint;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  if p_bytes is null or p_bytes <= 0 then
    return jsonb_build_object('allowed', false, 'reason', 'invalid_bytes');
  end if;

  -- The authoritative role, from the table rather than from any claim the caller
  -- carries. request-upload also reads the JWT claim (§6) and takes whichever of the
  -- two grants LESS, so a moderator demoted mid-token cannot spend moderator quota.
  v_role := public.authz_role();

  select l.max_count, l.max_bytes
    into v_max_count, v_max_bytes
    from public.upload_daily_limits(v_role) l;

  -- A request larger than the entire daily budget can never be admitted. It is
  -- checked here rather than left to the ON CONFLICT guard below because that guard
  -- only runs on the UPDATE path — on the first upload of the day the INSERT would
  -- succeed unchecked and seat an over-budget row.
  if p_bytes > v_max_bytes then
    return jsonb_build_object(
      'allowed', false, 'reason', 'over_daily_bytes', 'role', v_role,
      'limit_count', v_max_count, 'limit_bytes', v_max_bytes
    );
  end if;

  -- One statement: read, test and write. The WHERE is the limit.
  insert into public.upload_quota as q (user_id, day, count, bytes)
  values (v_uid, v_day, 1, p_bytes)
  on conflict (user_id, day) do update
     set count = q.count + 1,
         bytes = q.bytes + p_bytes
   where q.count + 1 <= v_max_count
     and q.bytes + p_bytes <= v_max_bytes
  returning q.count, q.bytes into v_count, v_bytes;

  -- No row came back: the ON CONFLICT guard refused the update. Nothing was written,
  -- which is the property that matters — a refused request must not consume the
  -- allowance it was refused for.
  if v_count is null then
    select q.count, q.bytes into v_count, v_bytes
      from public.upload_quota q
     where q.user_id = v_uid and q.day = v_day;

    return jsonb_build_object(
      'allowed', false, 'reason', 'quota_exceeded', 'role', v_role,
      'count', v_count, 'bytes', v_bytes,
      'limit_count', v_max_count, 'limit_bytes', v_max_bytes
    );
  end if;

  return jsonb_build_object(
    'allowed', true, 'role', v_role, 'day', v_day,
    'count', v_count, 'bytes', v_bytes,
    'limit_count', v_max_count, 'limit_bytes', v_max_bytes
  );
end;
$$;

comment on function public.claim_upload_quota(bigint) is
  'CLAUDE.md §6 — the daily quota, enforced in one statement so it cannot be raced.';

-- authenticated, because the function reads auth.uid() and must therefore run as the
-- caller. The worst a member can do by calling it directly is exhaust their OWN
-- allowance without uploading anything; there is no path to anyone else's counter,
-- and no path to reading the table.
revoke execute on function public.claim_upload_quota(bigint) from public, anon;
grant  execute on function public.claim_upload_quota(bigint) to authenticated, service_role;
