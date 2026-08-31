-- moderation_actions can record a target that is not keyed by a uuid (0059).
--
-- §4 asks for "moderation_actions AND audit_log" on every privileged action, and one action
-- has never managed both: an admin editing site copy. `moderation_actions.target_id` was
-- `uuid not null` and `content_blocks` is keyed (key, locale), so 0055 wrote the audit row,
-- skipped the other, and said so at the trigger. 0059 makes target_id nullable and adds
-- `target_key text` beside it.
--
-- ── What this file has to discriminate ───────────────────────
--
-- Three failures, and only the first is obvious:
--
--   1. no moderation row at all — the state before 0059;
--   2. a row that is written but says nothing useful. A trigger stamping every edit as one
--      action, or a target_key that does not identify the block, both produce "a row
--      appears" and both are useless to the person reading the log. So the action is checked
--      against the audit row's action for the SAME event, and the key is checked by value;
--   3. the not-null relaxed into nothing. Dropping `not null` is a real loss unless the
--      property it was carrying is restated, and the property was never uuid-ness — it was
--      that a row NAMES ITS TARGET. Assertions 8 and 9 are a refusal and its control.
--
-- And one regression: every writer that already used target_id must be untouched (10).

begin;
create extension if not exists pgtap;

-- 2 shape · 5 the copy trail · 2 the invariant · 1 regression · 1 the grant
select plan(11);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-000000ac0d01', 'mk-admin@t.local'),
  ('00000000-0000-0000-0000-000000ac0d02', 'mk-mod@t.local');

insert into public.user_roles (user_id, role, granted_by) values
  ('00000000-0000-0000-0000-000000ac0d01', 'admin',
   '00000000-0000-0000-0000-000000ac0d01'),
  ('00000000-0000-0000-0000-000000ac0d02', 'moderator',
   '00000000-0000-0000-0000-000000ac0d01');

-- ═══ 1-2 · the shape 0059 changed ════════════════════════════
--
-- Read off the catalogue rather than inferred from a successful insert: an insert that
-- happens to supply both columns would pass whatever the nullability is.

select is(
  (select a.attnotnull from pg_attribute a
    where a.attrelid = 'public.moderation_actions'::regclass and a.attname = 'target_id'),
  false,
  'target_id is nullable — a target that is not a uuid can be recorded');

select is(
  (select format_type(a.atttypid, a.atttypmod) from pg_attribute a
    where a.attrelid = 'public.moderation_actions'::regclass and a.attname = 'target_key'),
  'text',
  'and target_key is there to carry it');

-- ═══ 3-7 · an admin edits site copy ══════════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-000000ac0d01","role":"authenticated"}';
do $$ begin perform public.save_content_block('t.mk', 'ar', 'مسودة', false); end $$;
do $$ begin perform public.save_content_block('t.mk', 'ar', 'منشور', true);  end $$;
reset role;

select is(
  (select count(*) from public.moderation_actions
    where target_key = 'content_block:t.mk:ar'), 2::bigint,
  'a save and a publish each write a moderation_actions row — §4''s AND, at last');

select is(
  (select count(*) from public.audit_log
    where target_type = 'content_block'
      and after ->> 'key' = 't.mk' and after ->> 'locale' = 'ar'), 2::bigint,
  'CONTROL: the audit_log half 0055 already wrote is untouched — this is a second row, not a moved one');

-- The key is checked by VALUE. A trigger writing a constant, or the key without the locale,
-- writes a row that passes assertion 3 and identifies nothing: t.mk exists in two locales and
-- they are edited separately.
select set_eq(
  $q$ select distinct target_key from public.moderation_actions
       where target_key like 'content_block:t.mk%' $q$,
  array['content_block:t.mk:ar'],
  'and the key names the block AND its locale, in the composite form');

select is(
  (select count(*) from public.moderation_actions
    where target_key = 'content_block:t.mk:ar' and target_id is not null), 0::bigint,
  'with no uuid invented to sit beside it — the rejected design would pass every assertion above');

-- The two events are a create and a publish, and they must not read as the same thing. A
-- trigger stamping one action for everything passes 3, 5 and 6.
select set_eq(
  $q$ select action from public.moderation_actions
       where target_key = 'content_block:t.mk:ar' $q$,
  array['content_block.create', 'content_block.publish'],
  'and the two rows say WHICH decision each was, matching the audit row for the same event');

-- ═══ 8-9 · what the not-null was protecting ══════════════════
--
-- As postgres: there is no INSERT grant and no INSERT policy on this table, by design, so
-- the roles a browser can reach cannot reach this assertion at all.

select throws_ok(
  $q$ insert into public.moderation_actions (actor, action, target_type, target_id, target_key)
      values (null, 'content_block.edit', 'content_block', null, null) $q$,
  '23514', null,
  'a row naming NEITHER a uuid nor a key is refused — dropping the not-null did not drop the rule');

select lives_ok(
  $q$ insert into public.moderation_actions (actor, action, target_type, target_id, target_key)
      values (null, 'content_block.edit', 'content_block', null, 'content_block:t.control:en') $q$,
  'CONTROL: the same row WITH a key is accepted, so 8 is the constraint discriminating and not the table being shut');

-- ═══ 10 · the writers that already worked ════════════════════
--
-- 0059 relaxed a column every existing trigger relies on. A role grant is the cheapest
-- privileged action to provoke and it writes through 0011's trigger, untouched by this
-- migration.

do $$ begin
  update public.user_roles set role = 'admin'
   where user_id = '00000000-0000-0000-0000-000000ac0d02';
end $$;

select set_eq(
  $q$ select action from public.moderation_actions
       where target_type = 'profile'
         and target_id = '00000000-0000-0000-0000-000000ac0d02'
         and target_key is null $q$,
  array['role.grant', 'role.change'],
  'a uuid-keyed action still records a uuid and leaves target_key null — nothing was migrated onto the new column');

-- ═══ 11 · the column is readable by the people who read the log ══
--
-- 0010 grants SELECT at TABLE level rather than as a column list, so a new column is covered
-- — but this schema uses column-subset grants heavily and 0055 exists because of one, so it
-- is measured rather than assumed. Without this, target_key would be invisible to the
-- dashboard and the first sign of it would be a blank column on a screen.

select is(
  has_column_privilege('authenticated', 'public.moderation_actions', 'target_key', 'select'),
  true,
  'a moderator can actually SELECT target_key — the grant is table-level, not a stale column list');

select * from finish();
rollback;
