-- 0057 · Every account gets a profile, at the moment the account exists.
--
-- THE GAP. `public.profiles` was empty while `auth.users` held 11 rows. No signup path —
-- client or trigger — had ever created a profile, in any milestone. So §7's "handle is
-- user-chosen and mandatory, avatar mandatory" was unimplemented end to end: every public
-- byline rendered as "A member", every `profile/{handle}.json` shard was absent, and
-- `/u/{handle}` resolved to nothing for anybody. `reserved_handles` and the whole handle
-- machinery (0002's normalized_handle / is_allowed_handle, 0004's reserved and 0051's
-- tombstone triggers) existed and had never once been reached by a real signup.
--
-- WHAT THIS DOES, and deliberately no more. A profile row appears when the account does,
-- carrying a placeholder handle. It does NOT let a member choose one — §7 says the handle
-- is user-chosen, and the screen where they choose it is M5's profile editor. Until then a
-- member has an identity that exists, is unique and is theirs, and can be renamed later,
-- rather than no identity at all.
--
-- ── The handle ───────────────────────────────────────────────
-- `member_` plus 12 hex characters. Three properties matter:
--
--   · it carries NOTHING about the person. Not the email local part, not a name, not the
--     account id. §7 is explicit that emails are never published, and a handle derived
--     from one publishes it in the URL bar. Derived from the user id it would be no better
--     in kind: the id is the author key, and a handle that is a pure function of it turns
--     every byline into a lookup into the contribution history §7 names as the
--     de-anonymisation vector. Random is the only version of this that leaks nothing.
--   · it satisfies is_allowed_handle BY CONSTRUCTION: 19 characters (inside 3–30),
--     all-Latin lowercase plus digits, at least one letter guaranteed by the prefix even
--     when all 12 hex digits come up numeric, and exactly one underscore — not leading,
--     not trailing, not doubled.
--   · it is already normalized, so `handle = normalized_handle(handle)` holds and the
--     handle in the database is the handle in the URL.
--
-- It is NOT of the form `deleted_user_[0-9a-f]{12,17}`, so 0051's tombstone trigger has no
-- opinion about it — a live member must never be able to wear a withdrawn account's marker.
--
-- gen_random_uuid() rather than pgcrypto's gen_random_bytes(): it is in pg_catalog from
-- PostgreSQL 13 on, so it needs no extension and no schema qualification games under
-- `search_path = ''`.
--
-- ── Failure is loud ──────────────────────────────────────────
-- 48 bits of randomness against an archive of "low thousands within a year" (§1) makes a
-- collision a once-in-never event, and five attempts makes it less than that. If all five
-- somehow collide, or a constraint refuses the row for a reason nobody predicted, this
-- RAISES and the signup fails. That is the intended direction: an account with no profile
-- is precisely the silent half-state that produced this migration, and swallowing the
-- error to let the signup through would recreate the bug on purpose.

-- One implementation, called from both places below. A bulk INSERT in the backfill would
-- have been a second copy of the handle rule, and two copies of a rule drift.
create or replace function public.ensure_profile(p_user uuid)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_handle text;
begin
  if p_user is null then
    return false;
  end if;

  -- An account that somehow already has a profile is left exactly as it is. That is what
  -- makes the trigger safe to re-run and the backfill safe to run beside it.
  if exists (select 1 from public.profiles p where p.id = p_user) then
    return false;
  end if;

  for i in 1..5 loop
    v_handle := 'member_' ||
                substr(replace(pg_catalog.gen_random_uuid()::text, '-', ''), 1, 12);
    begin
      insert into public.profiles (id, handle) values (p_user, v_handle);
      return true;
    exception
      when unique_violation then
        -- Only a handle clash is worth another go. Anything else is a real problem and
        -- belongs in the caller's face rather than buried in a retry loop.
        null;
    end;
  end loop;

  raise exception 'could not provision a profile for % after 5 handle attempts', p_user
    using errcode = 'unique_violation';
end;
$$;

comment on function public.ensure_profile(uuid) is
  'CLAUDE.md §7 — an account without a profile has no public identity. Placeholder handle; '
  'the member chooses their own in M5''s editor. avatar_path stays NULL, which IS the '
  'generated avatar (0004 says so; public.js renders it from the handle).';

-- Nobody calls this from a browser. It is a trigger body and a backfill helper.
revoke all on function public.ensure_profile(uuid) from public, anon, authenticated;

create or replace function public.provision_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_profile(new.id);
  return new;
end;
$$;

revoke all on function public.provision_profile() from public, anon, authenticated;

-- AFTER, not BEFORE: profiles carries a foreign key to auth.users(id), so the user has to
-- exist before a profile can reference it.
drop trigger if exists users_provision_profile on auth.users;
create trigger users_provision_profile
  after insert on auth.users
  for each row execute function public.provision_profile();

-- ── Backfill ─────────────────────────────────────────────────
-- The accounts that predate this migration, through the same function every future signup
-- will take.
do $backfill$
declare
  r record;
  v_made int := 0;
begin
  for r in select u.id from auth.users u
            where not exists (select 1 from public.profiles p where p.id = u.id)
  loop
    if public.ensure_profile(r.id) then
      v_made := v_made + 1;
    end if;
  end loop;
  raise notice 'provisioned % profile(s) for pre-existing accounts', v_made;
end;
$backfill$;
