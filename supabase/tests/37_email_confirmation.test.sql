-- 0060 · an account that has not proved it holds its address contributes nothing.
--
-- Approved 5 Sep 2026: mechanism B out of the three in
-- docs/session-report-2026-09-03-auth.md §2, and Step B answered "gate all four".
--
-- ── The assertion this file exists for ───────────────────────
--
-- Tests 14 and 15. public.claim_upload_slot is SECURITY DEFINER, so it inserts the draft
-- post as its OWNER and RLS on public.posts is never evaluated on the one path a member
-- actually uploads through. A version of this migration that added `public.email_confirmed()`
-- to posts_insert and stopped there would have gone green on every other assertion here and
-- left the upload door open — the policy would have been decorative on the only path that
-- matters. The BEFORE INSERT trigger is what closes it; 14 is the refusal and 15 is the
-- control that says the function still works, so 14 is the gate rather than a broken call.
--
-- ── Paired, throughout ───────────────────────────────────────
--
-- Every "cannot" has a "can" beside it, run as a DIFFERENT member against the SAME
-- statement. A refusal is also what a broken grant, a missing fixture and an empty table
-- look like, and an unpaired "cannot" keeps passing against all three. 31_precision_control
-- learned this the expensive way (§1 of the pgTAP traps): `authenticated` holds column
-- subsets, so a 42501 can arrive for reasons that have nothing to do with the boundary
-- under test.
--
-- ── And the boundary that cannot be faked ────────────────────
--
-- Tests 16–20. The flag is stamped only from a session whose `amr` names a mailed link, and
-- `amr` is inside a token GoTrue signed. A password session asking to be confirmed is
-- refused BY NAME, and 17 is what says the refusal was real: the row is still unconfirmed
-- afterwards. Merged into one assertion, a `confirm_email()` that returned a refusal and
-- stamped anyway would pass.

begin;
create extension if not exists pgtap;

-- 3 the predicate · 10 the four writes · 2 the definer path · 5 the amr boundary
-- 2 the grants · 2 provisioning · 2 the mail rate limit
select plan(26);

-- ── Fixtures ─────────────────────────────────────────────────
--
-- No blanket confirm here, unlike the other thirty-five files: the whole point is that two
-- of these three accounts are in different states.
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e0c1', 'ec-confirmed@t.local'),
  ('00000000-0000-0000-0000-00000000e0c2', 'ec-unconfirmed@t.local'),
  ('00000000-0000-0000-0000-00000000e0c3', 'ec-mod@t.local');

-- The trigger provisioned three UNCONFIRMED rows above (email_confirmed_at was null on all
-- three). One of them becomes an ordinary member, and the moderator has to be confirmed too
-- or test 5's control would be measuring the wrong account.
update public.email_confirmations
   set confirmed_at = now()
 where user_id in ('00000000-0000-0000-0000-00000000e0c1',
                   '00000000-0000-0000-0000-00000000e0c3');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000e0c3', 'moderator',
        '00000000-0000-0000-0000-00000000e0c3');

-- Both approval constraints satisfied — posts_approved_has_rights and
-- posts_approved_is_attributable — and content_hash is 64 lowercase hex rather than a
-- label. Settable directly only because this INSERT runs before any JWT is set, so
-- posts_stamp_authorship returns early.
insert into public.posts (id, kind, title_en, body_en, status, created_by,
                          license, provenance, consent,
                          approved_by, approved_at, content_hash)
values ('00000000-0000-0000-0000-00000000ef01', 'media', 'an approved photograph',
        'of a street corner', 'approved', '00000000-0000-0000-0000-00000000e0c1',
        'CC-BY-SA-4.0', 'family album',
        jsonb_build_object('granted', true, 'may_withdraw', true),
        '00000000-0000-0000-0000-00000000e0c3', now(),
        '15df9d67f8e90a98014647411681314ce17bf434981db443bf36cae14532a677');

-- Owner-rights readers. `authenticated` holds column subsets on posts and comments (0015),
-- and email_confirmations is granted to nobody at all — so reading any of them through the
-- member's own role would fail on the grant rather than on the behaviour, which is
-- indistinguishable from the refusals half this file is looking for.
create function pg_temp.confirmed_at(p_user uuid) returns timestamptz
language sql stable security definer set search_path = '' as $fn$
  select c.confirmed_at from public.email_confirmations c where c.user_id = p_user;
$fn$;

create function pg_temp.has_row(p_user uuid) returns boolean
language sql stable security definer set search_path = '' as $fn$
  select exists (select 1 from public.email_confirmations c where c.user_id = p_user);
$fn$;

create function pg_temp.comment_count(p_body text) returns int
language sql stable security definer set search_path = '' as $fn$
  select count(*)::int from public.comments c where c.body = p_body;
$fn$;

create function pg_temp.post_count(p_title text) returns int
language sql stable security definer set search_path = '' as $fn$
  select count(*)::int from public.posts p where p.title_en = p_title;
$fn$;

-- ═══ 1–3 · The predicate itself ══════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c1","role":"authenticated"}';

select ok(public.email_confirmed(),
  'CONTROL: a confirmed member reads true — so every refusal below can actually fail');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

select ok(not public.email_confirmed(),
  '...and an unconfirmed one reads false');

set local request.jwt.claims to '';

select ok(not public.email_confirmed(),
  '...and a signed-out caller reads false, not null — a policy cannot be left NULL-open');

-- ═══ 4–13 · The four writes, both ways round ═════════════════
--
-- posts first. This is the RLS path — a member composing a post row directly — and it is
-- NOT the upload path, which is tests 14–15.

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c1","role":"authenticated"}';

select lives_ok($$
  insert into public.posts (kind, title_en, body_en)
  values ('media', 'confirmed member post', 'a description') $$,
  'a confirmed member may write a post');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

-- 23514, not 42501, AND THE DIFFERENCE IS WORTH KNOWING. A BEFORE ROW trigger fires before
-- the RLS WITH CHECK is evaluated, so on public.posts the trigger always answers first and
-- the member gets a NAMED refusal (`email_unconfirmed`) rather than a generic row-level
-- security violation. That is the better error to hand a client, and it is also how a
-- redundant policy clause rots unnoticed — which is what test 7 is for.
--
-- comments, likes and saves have no such trigger and answer 42501 below. Two shapes for one
-- boundary; engage.js maps both.
select throws_ok($$
  insert into public.posts (kind, title_en, body_en)
  values ('media', 'unconfirmed member post', 'a description') $$,
  '23514', null,
  '...and an unconfirmed one may not — by name, from the trigger, before RLS is reached');

select is(pg_temp.post_count('unconfirmed member post'), 0,
  '...and nothing landed, so that was a refusal and not a silent success');

-- The claim that there are TWO independent mechanisms, made checkable rather than asserted.
-- Because the trigger always answers first, posts_insert's own confirmation term can never
-- be observed through an ordinary insert — so nothing would notice if somebody deleted it,
-- and the file would still be green with one mechanism where it says two. Disabling the
-- trigger for a single statement is the only way to ask the policy anything at all.
reset role;
alter table public.posts disable trigger posts_require_confirmed_email;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

select throws_ok($$
  insert into public.posts (kind, title_en, body_en)
  values ('media', 'policy only', 'a description') $$,
  '42501', null,
  '...and with the trigger disabled the POLICY refuses it too — two mechanisms, not one');

reset role;
alter table public.posts enable trigger posts_require_confirmed_email;

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

-- comments. §1''s 30 Aug amendment publishes these the moment they are written and records
-- that no comment queue was ever built, so bidi stripping is the only filter between a
-- hostile string and a shard. This is Step B''s sharpest case and the reason the answer was
-- "gate all four".
select throws_ok($$
  insert into public.comments (post_id, body, lang)
  values ('00000000-0000-0000-0000-00000000ef01', 'from an unconfirmed account', 'en') $$,
  '42501', null,
  'an unconfirmed member may not comment — the one write with no prior restraint behind it');

select is(pg_temp.comment_count('from an unconfirmed account'), 0,
  '...and that comment does not exist');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c1","role":"authenticated"}';

select lives_ok($$
  insert into public.comments (post_id, body, lang)
  values ('00000000-0000-0000-0000-00000000ef01', 'from a confirmed account', 'en') $$,
  '...and a confirmed member may');

-- likes and saves. Neither is visible to a stranger, so gating them is not about what
-- anybody else sees: an account that has proved nothing should not accumulate rows keyed to
-- an address it may not hold.
select lives_ok($$
  insert into public.likes (user_id, post_id)
  values ('00000000-0000-0000-0000-00000000e0c1',
          '00000000-0000-0000-0000-00000000ef01') $$,
  'a confirmed member may like');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

select throws_ok($$
  insert into public.likes (user_id, post_id)
  values ('00000000-0000-0000-0000-00000000e0c2',
          '00000000-0000-0000-0000-00000000ef01') $$,
  '42501', null,
  '...and an unconfirmed one may not');

select throws_ok($$
  insert into public.saves (user_id, post_id)
  values ('00000000-0000-0000-0000-00000000e0c2',
          '00000000-0000-0000-0000-00000000ef01') $$,
  '42501', null,
  '...nor save');

-- ═══ 14–15 · The path no policy governs ══════════════════════
--
-- THE ONE THIS FILE EXISTS FOR. claim_upload_slot is SECURITY DEFINER: it inserts as its
-- owner, RLS never evaluates at all, and posts_insert above would have been decorative on
-- the only path a member uploads through. 23514 is the trigger's own check_violation — the
-- same refusal test 5 gets, arriving through a completely different door.

select throws_ok($$
  select public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-00000000e0c2/k1', 'media',
    '{"title_en":"t","body_en":"b","license":"CC0-1.0","provenance":"family album",
      "consent":{"granted":true}}') $$,
  '23514', null,
  'an unconfirmed member cannot claim an upload slot either — the trigger, since RLS cannot reach here');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c1","role":"authenticated"}';

select is(
  (public.claim_upload_slot(1024,
    '00000000-0000-0000-0000-00000000e0c1/k1', 'media',
    '{"title_en":"t","body_en":"b","license":"CC0-1.0","provenance":"family album",
      "consent":{"granted":true}}') ->> 'allowed')::boolean,
  true,
  'CONTROL: a confirmed member still can — so 12 was the gate and not a broken function');

-- ═══ 16–20 · What may set the flag ═══════════════════════════
--
-- The session above carries no amr at all, which is the same shape as a password sign-in
-- for this purpose: nothing in it says a link was clicked.

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated","amr":[{"method":"password"}]}';

select is(public.confirm_email() ->> 'reason', 'not_a_mailed_link',
  'a PASSWORD session cannot confirm itself, and is told exactly why');

select ok(pg_temp.confirmed_at('00000000-0000-0000-0000-00000000e0c2') is null,
  '...and the row is still unconfirmed, so that refusal was real');

-- A token whose amr is not an array at all. jsonb_array_elements RAISES on one of those
-- inside a SECURITY DEFINER function, which would reach the member as a 500 carrying a
-- Postgres error rather than a refusal — the failure mode claim_upload_slot's defensive
-- parsing exists to avoid.
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated","amr":"password"}';

select is(public.confirm_email() ->> 'reason', 'not_a_mailed_link',
  '...and a malformed amr is a refusal, not a 500');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated","amr":[{"method":"otp","timestamp":1}]}';

select is((public.confirm_email() ->> 'confirmed')::boolean, true,
  'a MAILED-LINK session confirms — amr is inside a signature, so a browser cannot forge it');

select lives_ok($$
  insert into public.comments (post_id, body, lang)
  values ('00000000-0000-0000-0000-00000000ef01', 'now that I am confirmed', 'en') $$,
  '...and the boundary actually moves: the same member may now comment');

-- ═══ 21–22 · The grants that make it a boundary ══════════════

select throws_ok($$ select confirmed_at from public.email_confirmations $$,
  '42501', null,
  'no browser role may read the flag table — it is §4-shaped, like user_roles');

-- claim_confirmation_send IS callable by a member, deliberately: it is called with their
-- own token so that PostgREST verifies who is asking, and it acts on auth.uid() alone. What
-- it must not do is hand an address back, because §7 says emails are never published and an
-- RPC that returns one is a refactor away from a screen that shows it.
select ok(
  not (public.claim_confirmation_send() ?| array['email', 'address']),
  '...and the mail-slot claim returns no address to the browser (§7)');

reset role;

-- ═══ 23–24 · A row exists as soon as the account does ════════

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-00000000e0c4', 'ec-new@t.local');

select ok(pg_temp.has_row('00000000-0000-0000-0000-00000000e0c4')
          and pg_temp.confirmed_at('00000000-0000-0000-0000-00000000e0c4') is null,
  'a new account is provisioned a row, UNCONFIRMED');

-- An admin-created user (`admin/users` with email_confirm: true) arrives already confirmed.
-- Inserting that one as unconfirmed would lock out an account nobody can send mail to.
insert into auth.users (id, email, email_confirmed_at)
values ('00000000-0000-0000-0000-00000000e0c5', 'ec-preconfirmed@t.local', now());

select ok(pg_temp.confirmed_at('00000000-0000-0000-0000-00000000e0c5') is not null,
  '...and one created already-confirmed is carried through, not overwritten');

-- ═══ 25–26 · Our own limit on the mail ═══════════════════════
--
-- Independent of the provider's cap, which is project-wide: without a limit of our own, one
-- member holding a button down spends everybody's.

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c4","role":"authenticated"}';

select is((public.claim_confirmation_send() ->> 'allowed')::boolean, true,
  'the first confirmation mail is allowed');

select is(public.claim_confirmation_send() ->> 'reason', 'too_soon',
  '...and the second inside the interval is not');

reset role;

select * from finish();
rollback;
