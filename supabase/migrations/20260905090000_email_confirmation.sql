-- 0060 · Email confirmation, owned by this project rather than by GoTrue.
--
-- Approved 5 Sep 2026 as "mechanism B" out of the three measured in
-- docs/session-report-2026-09-03-auth.md §2, together with the answer to Step B: an
-- unconfirmed account may do NONE of the four things a member does — post, upload,
-- comment, like/save.
--
-- ── Why the project has to own the flag at all ───────────────
--
-- Measured against the live project on 3 Sep, not assumed: GoTrue v2.196.0 cannot grant a
-- session to an unconfirmed account. The two settings are mutually exclusive halves of
-- what was asked for.
--
--   mailer_autoconfirm: false   /signup returns a user and NO session. email_confirmed_at
--                               is meaningful, GoTrue owns the mail. "Sign the member in
--                               immediately" is impossible.
--   mailer_autoconfirm: true    /signup returns a session AND stamps email_confirmed_at at
--                               signup, sending nothing. There is no flag left to gate on.
--
-- So deferred confirmation is not reachable by configuration. It needs a flag this schema
-- owns, and this is it — shaped exactly like public.user_roles under §4: service role
-- only, no grant to anon or authenticated, no policy, read by RLS through a SECURITY
-- DEFINER accessor. Nothing a browser sends decides it.
--
-- ── The cost, stated here rather than discovered later ───────
--
-- Once Amro turns "Confirm email" off, auth.users.email_confirmed_at becomes always-set
-- and MEANINGLESS. Two flags will live in one database and one of them will be a lie. The
-- comment on this table is where somebody about to read the wrong one finds that out.
--
-- ── Deployment order, which is load-bearing ──────────────────
--
-- This migration is safe to apply BEFORE that dashboard change, and is written to be. The
-- backfill below copies auth.users.email_confirmed_at into this table once, so every
-- account that exists today keeps working. Until the flip, a new signup still gets no
-- session at all, clicks the mail GoTrue sends, and lands with a session whose `amr` says
-- it came from a link — which is exactly what confirm_email() below wants. Both worlds
-- work; only the source of the mail changes.
--
-- It must also be applied BEFORE request-upload is redeployed. That function's new gate
-- calls public.email_confirmed(), and against a database without this migration PostgREST
-- answers 404 — which the handler reads as confirmation_check_failed and refuses. It
-- refuses rather than passing on purpose (§5 denies by default), so the ordering is what
-- keeps that from breaking every upload.
--
-- ── And one consequence that belongs to Amro, not to the code ─
--
-- With confirmations off, an unconfirmed account can squat somebody else's address: sign
-- up as victim@example.com, get a session, and block the real owner from registering. The
-- squat exists today too — the difference is that today the squatter gets no session. Step
-- B's answer is what bounds it: with all four gated, a squatted session can browse and
-- nothing else. It cannot publish a word under the address it took.

-- ═══ 1 · The flag ════════════════════════════════════════════

create table public.email_confirmations (
  user_id      uuid primary key references auth.users (id) on delete cascade,
  -- NULL means not confirmed. Deliberately not a boolean: when a member confirmed is a
  -- fact worth keeping, and a boolean would have to be joined to something else to answer
  -- "how long has this account been able to contribute".
  confirmed_at timestamptz,
  -- Our own rate limit on the confirmation mail, independent of the provider's cap. See
  -- claim_confirmation_send().
  last_sent_at timestamptz,
  created_at   timestamptz not null default now()
);

comment on table public.email_confirmations is
  'CLAUDE.md §4-shaped: authorization state, service role only, no browser grant and no '
  'policy. THIS is the confirmation flag, not auth.users.email_confirmed_at — once '
  '"Confirm email" is off in the dashboard GoTrue stamps that column at signup and it is '
  'always set. Read it and you will conclude that every account is confirmed.';

comment on column public.email_confirmations.confirmed_at is
  'NULL until a session whose amr shows a MAILED LINK stamps it (public.confirm_email). A '
  'password session can never set it.';

-- Not readable and not writable from a browser, by anyone. Same reasoning as user_roles:
-- a member who can write this table confirms themselves.
revoke all on public.email_confirmations from anon, authenticated;

alter table public.email_confirmations enable row level security;

-- ═══ 2 · A row exists as soon as the account does ════════════
--
-- One implementation, called from the trigger and from the backfill, for the reason 0057
-- gives: a bulk INSERT in the backfill would be a second copy of the rule, and two copies
-- of a rule drift.

create or replace function public.ensure_email_confirmation(
  p_user         uuid,
  p_confirmed_at timestamptz
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_user is null then
    return false;
  end if;

  -- An account that already has a row is left exactly as it is, which is what makes the
  -- trigger safe to re-run and the backfill safe to run beside it. It also means the
  -- backfill can never UNCONFIRM somebody by running twice.
  insert into public.email_confirmations (user_id, confirmed_at)
  values (p_user, p_confirmed_at)
  on conflict (user_id) do nothing;

  return found;
end;
$$;

comment on function public.ensure_email_confirmation(uuid, timestamptz) is
  'Provisioning half of 0060. Never updates an existing row — confirm_email() is the only '
  'thing that may confirm anybody.';

-- Nobody calls this from a browser, and nobody calls it through PostgREST at all. It is a
-- trigger body and a backfill helper, and both of its callers are SECURITY DEFINER — so the
-- inner call runs with the definer's rights and never with the session role's. Named roles,
-- not PUBLIC: 0056's lesson, which 0057 then reproduced hours after reading it.
revoke all on function public.ensure_email_confirmation(uuid, timestamptz)
  from public, anon, authenticated, service_role;

-- ── The existing trigger gains a second job ──────────────────
--
-- Extended rather than joined by a second trigger on auth.users. That table is not ours,
-- restoring it is the fiddliest part of a restore (the 1 Sep restore found its
-- provisioning trigger in no dump at all), and one trigger to notice is better than two.
create or replace function public.provision_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.ensure_profile(new.id);
  -- new.email_confirmed_at rather than NULL: while "Confirm email" is still ON, GoTrue
  -- inserts the user unconfirmed and stamps the column on the click, so this is NULL for
  -- every real signup today. It is passed through anyway because an admin-created user
  -- (`admin/users` with email_confirm: true) arrives already confirmed, and inserting that
  -- one as unconfirmed would lock out an account nobody can send mail to.
  perform public.ensure_email_confirmation(new.id, new.email_confirmed_at);
  return new;
end;
$$;

revoke all on function public.provision_profile() from public, anon, authenticated, service_role;

-- ── Backfill ─────────────────────────────────────────────────
--
-- THE REASON THIS MIGRATION IS NOT A LOCKOUT. Every account that exists right now
-- confirmed by mail under the old setting, so every one of them carries a real
-- email_confirmed_at, and every one stays able to contribute across this deploy.
do $backfill$
declare
  v_made int := 0;
  r      record;
begin
  for r in select u.id, u.email_confirmed_at from auth.users u loop
    if public.ensure_email_confirmation(r.id, r.email_confirmed_at) then
      v_made := v_made + 1;
    end if;
  end loop;
  raise notice 'email_confirmations: % row(s) backfilled', v_made;
end;
$backfill$;

-- ═══ 3 · What policies read ══════════════════════════════════
--
-- The direct analogue of authz_role(): SECURITY DEFINER over a table no browser can see,
-- stable, search_path pinned. FALSE when signed out — deliberately, and for the same
-- reason authz_role() returns NULL rather than 'member': a signed-out visitor is not an
-- unconfirmed member, and a policy that confuses the two is a policy that has stopped
-- describing anybody.
create or replace function public.email_confirmed()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.email_confirmations c
    where c.user_id = (select auth.uid())
      and c.confirmed_at is not null
  );
$$;

comment on function public.email_confirmed() is
  'CLAUDE.md §4/§5 — has THIS caller proved they hold the mailbox. Read by the four INSERT '
  'policies and by the posts trigger below. False when signed out.';

-- ═══ 4 · How it is set, and why a browser cannot fake it ═════
--
-- We mint no token, set no expiry and write no single-use or replay logic — the part of
-- this §6 would least want us writing ourselves. The confirmation mail is GoTrue's OWN
-- magic link. Clicking it establishes a session, and that session's `amr` records how it
-- was obtained: a mailed link says `otp`, a typed password says `password`.
--
-- `amr` is inside a token GoTrue signed. A browser cannot edit it without invalidating the
-- signature, and PostgREST verifies the signature before auth.jwt() has a value at all. So
-- "this session was created by clicking something we mailed" is a fact the database can
-- establish without trusting the client — the same boundary §4 already draws for role.
--
-- recovery counts. A password-reset link is a mailed link and proves mailbox control just
-- as completely as a confirmation link does; refusing it would mean a member who has just
-- proved they hold the address is still told to go and prove it.
create or replace function public.confirm_email()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_uid  uuid := (select auth.uid());
  v_amr  jsonb;
  v_link boolean;
  v_at   timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('confirmed', false, 'reason', 'unauthenticated');
  end if;

  -- coalesce, because a token issued before the access-token hook existed, or by a client
  -- that requested no amr, has no key at all — and `null -> 'amr'` would make the EXISTS
  -- below NULL rather than false.
  v_amr := coalesce(auth.jwt() -> 'amr', '[]'::jsonb);

  -- The typeof guard is not defensive decoration. jsonb_array_elements RAISES on anything
  -- that is not an array, inside a SECURITY DEFINER function, and the member would get a
  -- 500 with a Postgres error in it rather than a refusal they can read. Same rule
  -- claim_upload_slot follows for every value that arrives from outside.
  select case when jsonb_typeof(v_amr) <> 'array' then false else exists (
    select 1
    from jsonb_array_elements(v_amr) e
    where e ->> 'method' in ('otp', 'magiclink', 'recovery', 'email')
  ) end into v_link;

  if not v_link then
    -- Named rather than merged into a generic refusal: a member who reaches this by
    -- pressing something in a password session needs to be told to open the link, and a
    -- caller probing the boundary should get the same answer every time.
    return jsonb_build_object('confirmed', false, 'reason', 'not_a_mailed_link');
  end if;

  -- Idempotent, and it keeps the FIRST timestamp. Clicking an old link twice must not
  -- rewrite when this account became able to contribute.
  update public.email_confirmations
     set confirmed_at = coalesce(confirmed_at, now())
   where user_id = v_uid
  returning confirmed_at into v_at;

  if v_at is null then
    -- No row. Only reachable for an account created before 0060 whose backfill did not
    -- see it — i.e. never, in practice. Provision and stamp rather than refusing somebody
    -- who has just proved they hold the mailbox.
    perform public.ensure_email_confirmation(v_uid, now());
    select confirmed_at into v_at from public.email_confirmations where user_id = v_uid;
  end if;

  return jsonb_build_object('confirmed', v_at is not null, 'confirmed_at', v_at);
end;
$$;

comment on function public.confirm_email() is
  'Stamps confirmation, and ONLY from a session whose amr shows a mailed link. The browser '
  'asserts nothing here that is not inside a signature.';

-- ═══ 5 · What the member's own screen may ask ════════════════

create or replace function public.email_confirmation_status()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select case
    when (select auth.uid()) is null
      then jsonb_build_object('signed_in', false, 'confirmed', false)
    else (
      select jsonb_build_object(
        'signed_in', true,
        'confirmed', c.confirmed_at is not null,
        'confirmed_at', c.confirmed_at,
        'last_sent_at', c.last_sent_at
      )
      from public.email_confirmations c
      where c.user_id = (select auth.uid())
    )
  end;
$$;

comment on function public.email_confirmation_status() is
  'The caller''s OWN confirmation state, and nobody else''s — there is no argument to pass. '
  'Returns null-ish only for a signed-out caller.';

-- ── Our own rate limit on the confirmation mail ──────────────
--
-- The interval is OURS and sits in front of the provider's, which is the whole reason it is
-- not left to GoTrue: the provider's cap is PROJECT-WIDE, so one member holding a button
-- down spends everybody's.
--
-- It is called with the MEMBER'S OWN TOKEN, not the service key, and that is the design
-- rather than a convenience. PostgREST verifies the signature itself and derives auth.uid()
-- from it, so the caller is authenticated by the database independently of whatever the Edge
-- gateway did — the rule _shared/http.ts states and request-upload follows. A version taking
-- `p_user uuid` from a service-role caller would have had the Edge Function read the subject
-- out of an unverified token, and a forged one would then mail anybody.
--
-- IT DOES NOT RETURN THE ADDRESS. The Edge Function reads that from the same token, AFTER
-- this call has proved the token genuine — the pattern request-upload uses for the object
-- key. §7 says emails are never published, and an RPC that hands one back is one refactor
-- away from a screen that shows it.
--
-- WHAT IT DOES NOT DO, stated rather than implied: it cannot stop a client that skips it
-- and calls GoTrue directly with the anon key, which any browser can do. That client meets
-- the provider's own cap. This bounds the ordinary case — a member pressing the button
-- repeatedly — which is the case that actually happens.
create or replace function public.claim_confirmation_send()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  -- One confirmation mail per minute per account. A ceiling on abuse, not a fairness
  -- mechanism: raise it only against a real provider bill. CLAUDE.md §6 carries the same
  -- figure; change them together.
  c_interval constant interval := interval '60 seconds';

  v_uid   uuid := (select auth.uid());
  v_last  timestamptz;
  v_done  timestamptz;
begin
  if v_uid is null then
    return jsonb_build_object('allowed', false, 'reason', 'unauthenticated');
  end if;

  select c.last_sent_at, c.confirmed_at into v_last, v_done
    from public.email_confirmations c
   where c.user_id = v_uid
   for update;

  if not found then
    perform public.ensure_email_confirmation(v_uid, null);
    v_last := null;
    v_done := null;
  end if;

  -- Already confirmed is a refusal rather than a no-op send. Mailing a link to somebody
  -- who does not need one is how a member learns to ignore the mail that matters.
  if v_done is not null then
    return jsonb_build_object('allowed', false, 'reason', 'already_confirmed');
  end if;

  if v_last is not null and v_last > now() - c_interval then
    return jsonb_build_object(
      'allowed', false,
      'reason', 'too_soon',
      'retry_after_s', ceil(extract(epoch from (v_last + c_interval) - now()))::int
    );
  end if;

  -- Stamped BEFORE the mail is sent, not after. A provider that is slow, or that fails
  -- after accepting, must not leave the limit unspent — the cheap failure is one member
  -- waiting a minute for a retry, and the expensive one is a retry loop against a paid
  -- mail API.
  update public.email_confirmations
     set last_sent_at = now()
   where user_id = v_uid;

  return jsonb_build_object('allowed', true);
end;
$$;

comment on function public.claim_confirmation_send() is
  'Claims one confirmation-mail slot for the CALLER. Returns no address — §7. Called by the '
  'resend-confirmation Edge Function with the member''s own token, so PostgREST verifies who '
  'is asking rather than the Edge gateway being trusted to have done it.';

-- ── Grants, revoked from every named role first ─────────────
--
-- REVOKE FROM PUBLIC IS NOT ENOUGH HERE and the reason is 0056's, which cost five open
-- functions on the deployed database while CI called them closed: a hosted Supabase
-- project carries default ACLs that grant EXECUTE to anon, authenticated AND service_role
-- **explicitly**, so `revoke ... from public` removes a grant those roles are not using. A
-- local stack has no such defaults, which is exactly why the difference is invisible until
-- somebody runs 16_function_grants against the real database.
--
-- Naming all four makes the resulting ACL identical in both places, which is what lets the
-- matrix in 16_function_grants be a single literal list rather than two.
revoke all on function public.email_confirmed()               from public, anon, authenticated, service_role;
revoke all on function public.confirm_email()                 from public, anon, authenticated, service_role;
revoke all on function public.email_confirmation_status()     from public, anon, authenticated, service_role;
revoke all on function public.claim_confirmation_send()       from public, anon, authenticated, service_role;

-- email_confirmed() is a plain predicate about the CALLER and reveals nothing about anybody
-- else, exactly like authz_role() and is_admin() before it. It is also read by RLS policies,
-- which are evaluated as the querying role, so the role doing the writing must hold it.
grant execute on function public.email_confirmed() to anon, authenticated, service_role;

-- The two the member's own screen calls, with the member's own token.
grant execute on function public.confirm_email()             to authenticated;
grant execute on function public.email_confirmation_status() to authenticated;

-- Called with the member's own token, so `authenticated` is the role PostgREST arrives as.
-- The grant is not the authorization: the function acts on auth.uid() and can do nothing to
-- anybody else's row. The worst a member can do by calling it directly is spend their own
-- sixty seconds without a mail being sent.
grant execute on function public.claim_confirmation_send() to authenticated;

-- ═══ 6 · The four INSERT policies ════════════════════════════
--
-- Restated whole rather than patched, for the reason 0054 gives: a reader deciding whether
-- an unconfirmed member can do this needs the entire clause in front of them. Everything
-- except the confirmation term is unchanged.

drop policy if exists posts_insert on public.posts;

create policy posts_insert on public.posts
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and public.email_confirmed()
    and created_by = (select auth.uid())
    and status = 'pending'
    and not takedown
  );

drop policy if exists comments_insert on public.comments;

create policy comments_insert on public.comments
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and public.email_confirmed()
    and created_by = (select auth.uid())
    and status = 'published'
    and exists (
      select 1 from public.posts p
      where p.id = comments.post_id
        and p.status = 'approved'
        and not p.takedown
    )
  );

-- Step B's sharpest case. §1's 30 Aug amendment publishes a comment the moment it is
-- written and records that no comment queue was ever built, so bidi stripping is the only
-- filter between a hostile string and a shard. An unconfirmed account commenting is a spam
-- path with no prior restraint in front of it — and under this migration's own squatting
-- note, a spam path that could speak under somebody else's address.

drop policy if exists likes_insert on public.likes;

create policy likes_insert on public.likes
  for insert to authenticated
  with check (
        public.email_confirmed()
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.posts p
      where p.id = likes.post_id and p.status = 'approved' and not p.takedown
    )
  );

drop policy if exists saves_insert on public.saves;

create policy saves_insert on public.saves
  for insert to authenticated
  with check (
        public.email_confirmed()
    and user_id = (select auth.uid())
    and exists (
      select 1 from public.posts p
      where p.id = saves.post_id and p.status = 'approved' and not p.takedown
    )
  );

-- A save is private even from moderators, so gating it is not about what anybody else
-- sees. It is gated because a save is a write, and an account that has proved nothing
-- should not be able to accumulate rows keyed to an address it may not hold.

-- ═══ 7 · The upload path, which no policy governs ════════════
--
-- THE HOLE THIS CLOSES, and it is the reason posts_insert alone would have been
-- decorative. public.claim_upload_slot is SECURITY DEFINER: it inserts the draft post as
-- its owner, so RLS on public.posts never evaluates and the policy above never runs on the
-- one path a member actually uploads through.
--
-- A trigger fires regardless. It is scoped to sessions that HAVE a uid, so the seed
-- importer and every service-role write are untouched — those are trusted by §6 and have
-- no mailbox to prove.
create or replace function public.require_confirmed_email()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.email_confirmed() then
    raise exception 'email_unconfirmed'
      using errcode = 'check_violation',
            hint = 'Confirm the address on the account before contributing.';
  end if;
  return new;
end;
$$;

comment on function public.require_confirmed_email() is
  'The confirmation gate for SECURITY DEFINER insert paths, which RLS cannot reach. '
  'Service-role writes (auth.uid() null) pass: the seed importer has no mailbox.';

revoke all on function public.require_confirmed_email()
  from public, anon, authenticated, service_role;

drop trigger if exists posts_require_confirmed_email on public.posts;
create trigger posts_require_confirmed_email
  before insert on public.posts
  for each row execute function public.require_confirmed_email();
