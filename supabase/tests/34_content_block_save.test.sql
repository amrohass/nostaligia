-- Saving site copy (0055) — the write half of the accessor 0016 built for reading.
--
-- §4 gives an admin "Edit site copy (content_blocks)"; §9 makes the dashboard the single
-- source of truth for it. Neither was true on a deployed database, and the reason was not a
-- policy: `INSERT … ON CONFLICT DO UPDATE SET draft = excluded.draft` needs SELECT on
-- `draft`, EXCLUDED being the target's rowtype, and 0015 withholds exactly that column. The
-- statement failed 42501 before RLS was consulted, so is_admin() being true changed nothing.
--
-- ── The two assertions that matter, and they pull apart ──────
--
-- Assertion 6 is the regression guard and it asserts a REFUSAL: the table itself must stay
-- un-upsertable by `authenticated`. Assertion 8 says why — a grant that made the upsert work
-- would also let every signed-in member read every unpublished draft, because 0020's select
-- policy is `using (true)` and the column grant is the only thing withholding it.
--
-- Written as a pair on purpose. Whoever meets the 42501 next will be offered
-- `GRANT SELECT ON public.content_blocks TO authenticated` by Postgres' own HINT, and 6
-- alone would look like an obstacle to remove. 8 is the consequence, spelled out where the
-- temptation is.

begin;
create extension if not exists pgtap;

-- 2 save vs publish · 3 refusals · 3 the boundary · 1 the trail · 1 the signal
select plan(10);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000cb01', 'sb-admin@t.local'),
  ('00000000-0000-0000-0000-00000000cb02', 'sb-mod@t.local'),
  ('00000000-0000-0000-0000-00000000cb03', 'sb-member@t.local');

insert into public.user_roles (user_id, role, granted_by) values
  ('00000000-0000-0000-0000-00000000cb01', 'admin',
   '00000000-0000-0000-0000-00000000cb01'),
  ('00000000-0000-0000-0000-00000000cb02', 'moderator',
   '00000000-0000-0000-0000-00000000cb01');

-- SECURITY DEFINER, because `draft` is precisely the column no browser role may read and
-- this file has to read it to prove the function wrote it.
create function pg_temp.block(p_key text, p_locale text)
returns table (draft text, published text, version integer, updated_by uuid)
language sql stable security definer as $fn$
  select c.draft, c.published, c.version, c.updated_by
    from public.content_blocks c where c.key = p_key and c.locale = p_locale;
$fn$;

create function pg_temp.audit_rows(p_action text, p_key text) returns integer
language sql stable security definer as $fn$
  select count(*)::integer from public.audit_log a
   where a.action = p_action and a.after ->> 'key' = p_key;
$fn$;

create function pg_temp.content_rev() returns bigint
language sql stable security definer as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

-- ═══ 1-2 · Save writes the draft; publish moves the live copy ═
--
-- The two buttons on the copy screen are genuinely different actions, and the two columns
-- exist so an editor can work on a paragraph without the world reading it.

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000cb01","role":"authenticated"}';

-- Separate statements from the assertions below: pg_temp.block is STABLE and reads the
-- snapshot taken before its statement began, so it cannot see a write made in the same one.
do $$ begin perform public.save_content_block('t.copy', 'ar', 'مسوّدة أولى', false); end $$;

select results_eq(
  $q$ select draft, published, version from pg_temp.block('t.copy', 'ar') $q$,
  $q$ values ('مسوّدة أولى'::text, null::text, 0) $q$,
  'Save writes the draft and publishes nothing — the live copy stays empty');

do $$ begin perform public.save_content_block('t.copy', 'ar', 'نصّ منشور', true); end $$;

select results_eq(
  $q$ select draft, published, version from pg_temp.block('t.copy', 'ar') $q$,
  $q$ values ('نصّ منشور'::text, 'نصّ منشور'::text, 1) $q$,
  '...and Publish copies it across and bumps the version the publisher stamps');

-- ═══ 3-5 · The refusals, each named ══════════════════════════

select is(
  public.save_content_block('t.copy', 'ar', '   ', true) ->> 'reason',
  'empty_publish',
  'publishing an empty block is refused — one mis-click must not blank a live page');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000cb02","role":"authenticated"}';

select is(
  public.save_content_block('t.copy', 'ar', 'a moderator tries', false) ->> 'reason',
  'denied',
  'a moderator is refused by name — §4 makes site copy admin-only');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000cb03","role":"authenticated"}';

select is(
  public.save_content_block('t.copy', 'ar', 'a member tries', false) ->> 'reason',
  'denied',
  '...and so is an ordinary member');

-- ═══ 6-7 · The boundary this function exists to get around ═══

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000cb01","role":"authenticated"}';

-- THE regression guard. Not "the old client was wrong" — the table genuinely cannot take
-- this statement from a browser role, and the day it can is the day drafts are public.
select throws_ok(
  $q$ insert into public.content_blocks (key, locale, draft)
      values ('t.copy', 'ar', 'straight at the table')
      on conflict (key, locale) do update set draft = excluded.draft $q$,
  '42501', null,
  'the upsert admin.js used to send is STILL refused, admin or not');

-- Its control. A refusal that came from RLS, or from a table nobody may write at all, would
-- look identical above; this proves the same admin in the same transaction can write.
select lives_ok(
  $q$ select public.save_content_block('t.copy', 'en', 'through the function', false) $q$,
  '...while the same admin, in the same transaction, writes through the function');

-- ═══ 8 · The hole that must not open ═════════════════════════
--
-- Why 6 is a feature. 0020's select policy is `using (true)`, so the column grant is the
-- whole of the protection: grant SELECT on `draft` to make the upsert work and every signed-in
-- member can read every paragraph an editor has not finished.
select throws_ok(
  $q$ select draft from public.content_blocks where key = 't.copy' $q$,
  '42501', null,
  'an admin cannot read `draft` off the table either — content_blocks_draft() is the way in');

reset role;

-- ═══ 9-10 · §4's trail, and the signal ═══════════════════════

select is(
  pg_temp.audit_rows('content_block.publish', 't.copy'), 1,
  'publishing writes exactly one audit row, and it says publish');

-- Measured as a delta: the writes above already moved the number.
create temporary table cb2_rev (rev_before bigint);
insert into cb2_rev select pg_temp.content_rev();

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-00000000cb01","role":"authenticated"}';
do $$ begin perform public.save_content_block('t.copy', 'en', 'now live', true); end $$;
reset role;

select cmp_ok(
  pg_temp.content_rev(), '>', (select rev_before from cb2_rev),
  'publishing copy moves the content revision, so the edit actually reaches a shard');

select * from finish();
rollback;
