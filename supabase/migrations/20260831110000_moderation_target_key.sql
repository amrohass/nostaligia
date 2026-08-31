-- 0059 · moderation_actions can finally record a content_blocks edit
--
-- §4: "Every moderator and admin action writes to moderation_actions AND audit_log with
-- actor, target, timestamp, and before/after state. No privileged action may bypass this."
--
-- An admin editing site copy is the one privileged action that has never satisfied that
-- sentence. 0055 built the write path, wrote the audit_log row, and said so at the trigger:
-- moderation_actions.target_id is `uuid not null` and content_blocks is keyed (key, locale),
-- so the row could not be written at all. Carried as an open decision since 30 Aug and
-- decided by Amro on 31 Aug 2026.
--
-- == The decision, and the option it rejects ==================
--
-- A synthetic uuid derived from the key -- md5 of 'page.about.title:ar', cast to uuid -- was
-- the other candidate and is the worse one. It would have satisfied the not-null while
-- putting a value in a uuid column that joins to nothing, cannot be resolved back to the
-- thing it names without knowing the recipe, and is indistinguishable at a glance from a
-- real row id. A moderator reading the log would see a uuid and reasonably go looking for
-- the row it points at. The trail is read by people; a value that lies to them is worse than
-- a column that admits what it is.
--
-- So: `target_id` becomes nullable and `target_key text` is added beside it, carrying the
-- composite key in a form that reads as one -- 'content_block:page.about.title:ar'.
--
-- == What the not-null was protecting, and how that survives ==
--
-- It was not protecting the uuid-ness. It was protecting the property that a moderation row
-- NAMES ITS TARGET -- a row saying "somebody approved something" is not a record of a
-- decision. `moderation_actions_names_a_target` restates exactly that and nothing more, so
-- relaxing the column does not relax the invariant.
--
-- Deliberately NOT expressed per target_type ("a content_block row must use target_key, a
-- post row must use target_id"): that is the right rule and it cannot be written here. A
-- check constraint is validated against existing rows when it is added, which would evaluate
-- 'content_block'::public.moderation_target inside the same transaction that adds the enum
-- value -- the one thing Postgres refuses. Splitting it across two migrations to gain a
-- constraint that the two writers in this schema already satisfy is not worth a migration.

set search_path = public, extensions;

-- ── §4's target vocabulary gains site copy ───────────────────
--
-- Safe inside the transaction for the reason 0021 gives when it adds 'place': nothing here
-- USES the new value. The trigger body below is text until a row is written, long after this
-- commits.
alter type public.moderation_target add value if not exists 'content_block';

-- ── The column pair ──────────────────────────────────────────
alter table public.moderation_actions
  alter column target_id drop not null;

alter table public.moderation_actions
  add column if not exists target_key text
    constraint moderation_actions_target_key_length
    check (target_key is null or char_length(btrim(target_key)) between 1 and 200);

comment on column public.moderation_actions.target_id is
  'The row this action was taken on, where the target is keyed by uuid. NULL when it is not -- see target_key.';
comment on column public.moderation_actions.target_key is
  'The target of an action on a table not keyed by uuid, as "<type>:<key>" -- e.g. content_block:page.about.title:ar. NULL when target_id carries it.';

-- A row must still name what it was about. This is the whole of what `not null` was doing.
-- Dropped first so the file is re-runnable, the way 0056 is: an `add constraint` that fails
-- on second application makes a migration that cannot be replayed onto a database that has
-- already seen half of it.
alter table public.moderation_actions
  drop constraint if exists moderation_actions_names_a_target;

alter table public.moderation_actions
  add constraint moderation_actions_names_a_target
  check (num_nonnulls(target_id, target_key) >= 1);

-- ── The grant, which is NOT inherited ────────────────────────
--
-- This line was very nearly not written, on the reasoning that 0010's
-- `grant select on public.moderation_actions to authenticated` is table-level and a
-- table-level grant covers a column added later. Both halves are true and the conclusion is
-- false: **0015 revoked that grant and replaced it with a COLUMN LIST** --
--
--     revoke all on public.moderation_actions from anon, authenticated;
--     grant select (id, actor, action, target_type, target_id, note, created_at) ...
--
-- -- so the table-level entry is gone from relacl and each column carries its own. A column
-- added now is granted to nobody. Measured before this line existed: relacl held only
-- postgres and service_role, every original column had `authenticated=r` of its own, and
-- has_column_privilege(authenticated, …, 'target_key', 'select') was FALSE.
--
-- The visible failure would have been a moderator's log screen with a column that is always
-- blank -- or, more likely, PostgREST refusing the whole SELECT and the screen showing
-- nothing at all, for a reason nothing on it names. Fourth instance of this schema's most
-- expensive recurring bug (M1's return=representation, 0053's save_place, 0055's upsert):
-- **a column-subset grant does not extend to a column added afterwards, and nothing warns.**
grant select (target_key) on public.moderation_actions to authenticated;

-- ── The trail that 0055 could not write ──────────────────────
--
-- Replaces 0055's function. Same audit_log row, unchanged, plus the moderation_actions row
-- it always should have written. Both in one trigger and therefore one transaction: §4's
-- "AND" is not satisfied by two writes that can land apart.
--
-- The action vocabulary is 0055's, unchanged -- content_block.create / .edit / .publish --
-- because it is already what the audit rows say and a trail that names the same event two
-- ways is worse than one that names it once.
create or replace function public.content_blocks_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_action text;
  v_actor  uuid := (select auth.uid());
  v_before jsonb;
  v_after  jsonb;
begin
  v_action := case
    when tg_op = 'INSERT' and new.published is not null then 'content_block.publish'
    when tg_op = 'INSERT'                               then 'content_block.create'
    when old.published is distinct from new.published   then 'content_block.publish'
    else 'content_block.edit'
  end;

  -- draft and published are recorded in full: an audit row that said only "copy changed"
  -- would not answer the question the trail exists for, which is what the site used to say.
  v_before := case when tg_op = 'INSERT' then null
                   else jsonb_build_object('key', old.key, 'locale', old.locale,
                                           'draft', old.draft, 'published', old.published,
                                           'version', old.version) end;
  v_after  := jsonb_build_object('key', new.key, 'locale', new.locale,
                                 'draft', new.draft, 'published', new.published,
                                 'version', new.version);

  -- audit_log keeps target_id null and carries the key in the payload, exactly as 0055 wrote
  -- it. That table's target_type is text and its target_id has always been nullable, so
  -- nothing about it needed this migration and nothing about it changes.
  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (v_actor, v_action, 'content_block', null, v_before, v_after);

  -- moderation_actions, which is what 0059 is for. `note` carries the version rather than the
  -- text: this table is the register of decisions and audit_log is the record of content, and
  -- duplicating a whole draft into both would double the row that §3 keeps permanently.
  insert into public.moderation_actions (actor, action, target_type, target_id, target_key, note)
  values (v_actor, v_action, 'content_block', null,
          'content_block:' || new.key || ':' || new.locale,
          'version ' || new.version::text);

  return null;
end;
$fn$;

comment on function public.content_blocks_write_audit() is
  'CLAUDE.md §4 -- every edit to site copy writes BOTH an audit_log row and a moderation_actions row, by trigger. The second became possible in 0059.';

-- The trigger itself is 0055's and is not recreated: `create or replace function` swaps the
-- body under it. Recreating the trigger here would be a no-op that reads as though the
-- wiring had changed.
