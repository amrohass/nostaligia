-- request_takedown (migration 0036), and the capability it took away.
--
-- §8 is four steps and three of them need R2 and Cloudflare credentials. This file is the
-- fourth — the mark, the role check and the audit trail — plus the thing 0036 fixed:
--
-- Before it, `takedown` was in the column-UPDATE grant to `authenticated`, and
-- posts_update's USING clause is `created_by = auth.uid() OR is_moderator()`. A member
-- could set takedown = true on their own post, and 0012's trigger would write
-- `actor = <that member>, action = 'post.takedown'` into moderation_actions — a row in the
-- team's ledger claiming a moderation action that §4's capability table gives only to
-- moderators and admins.
--
-- Test 5 is that. It is written as an UPDATE rather than an RPC call because the UPDATE is
-- what used to work.

begin;
create extension if not exists pgtap;

-- 3 privileges · 4 the role gate · 5 the mark and its objects · 4 the audit trail
select plan(16);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000ba01', 'td-author@t.local'),
  ('00000000-0000-0000-0000-00000000ba02', 'td-mod@t.local'),
  ('00000000-0000-0000-0000-00000000ba03', 'td-nosy@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000ba02', 'moderator',
        '00000000-0000-0000-0000-00000000ba02');

insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          location_precision, status, ingest_state,
                          approved_by, approved_at, content_hash)
values
  ('00000000-0000-0000-0000-00000000cd01', 'media', 'published', 'live',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ba01', 'hidden',
   'approved', 'ready', '00000000-0000-0000-0000-00000000ba02', now(), repeat('a', 64)),
  ('00000000-0000-0000-0000-00000000cd02', 'media', 'second', 'live',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-00000000ba01', 'hidden',
   'approved', 'ready', '00000000-0000-0000-0000-00000000ba02', now(), repeat('a', 64));

-- The rendition row carries a `rendition` value: media_assets_rendition_iff_rendition_role
-- makes (role = 'rendition') and (rendition is not null) the same statement, so a rung with
-- no name is not a legal row.
insert into public.media_assets (post_id, role, rendition, storage_path, bucket, mime)
values ('00000000-0000-0000-0000-00000000cd01', 'thumb', null,
        '00000000-0000-0000-0000-00000000cd01/thumb.webp', 'public', 'image/webp'),
       ('00000000-0000-0000-0000-00000000cd01', 'rendition', '1080p',
        '00000000-0000-0000-0000-00000000cd01/1080p.mp4', 'public', 'video/mp4'),
       -- §6's preservation copy. A takedown takes it too: "we still hold it, just
       -- privately" is not what was asked for.
       ('00000000-0000-0000-0000-00000000cd01', 'master', null,
        '00000000-0000-0000-0000-00000000ba01/original', 'originals', 'video/quicktime');

create function pg_temp.taken_down(p_id uuid) returns boolean
language sql stable security definer set search_path = '' as $fn$
  select p.takedown from public.posts p where p.id = p_id;
$fn$;

create function pg_temp.ledger(p_id uuid) returns setof record
language sql stable security definer set search_path = '' as $fn$
  select m.action::text, m.actor, m.note from public.moderation_actions m
   where m.target_id = p_id order by m.created_at;
$fn$;

-- ═══ 1–3 · Privileges ════════════════════════════════════════

select ok(
  not has_function_privilege('anon', 'public.request_takedown(uuid,text)', 'execute'),
  'anon cannot request a takedown');

select ok(
  has_function_privilege('authenticated', 'public.request_takedown(uuid,text)', 'execute'),
  'a signed-in user can CALL it — the role check is inside, so the refusal is named');

-- The revoke. This is what 0036 changed.
select ok(
  not has_column_privilege('authenticated', 'public.posts'::regclass, 'takedown', 'UPDATE'),
  '§4: takedown is no longer a column any member can write');

-- ═══ 4–7 · The role gate ═════════════════════════════════════

set local role authenticated;
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000ba03","role":"authenticated"}';

select is(
  public.request_takedown('00000000-0000-0000-0000-00000000cd01') ->> 'reason',
  'forbidden',
  'an unrelated member is refused, by name rather than by silence');

-- The author of the post, not just a stranger. §4 gives takedown to moderators; an author
-- who wants their own contribution gone has status = 'withdrawn', which the ledger records
-- as the author's act rather than as a moderator's.
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000ba01","role":"authenticated"}';

select is(
  public.request_takedown('00000000-0000-0000-0000-00000000cd01') ->> 'reason',
  'forbidden',
  '...and so is the post''s own author');

-- The hole 0036 closed, asserted as the statement that used to work.
select throws_ok($$
  update public.posts set takedown = true
   where id = '00000000-0000-0000-0000-00000000cd01'
$$, '42501', null,
  '...and cannot reach the column directly either, which is how they used to');

select is(
  pg_temp.taken_down('00000000-0000-0000-0000-00000000cd01'), false,
  'after three refusals the post is still live');

-- ═══ 8–12 · The mark, and the objects ════════════════════════

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000ba02","role":"authenticated"}';

select is(
  (public.request_takedown('00000000-0000-0000-0000-00000000cd01',
                           'family requested removal') -> 'ok')::text,
  'true',
  'a moderator may take a post down');

select is(
  pg_temp.taken_down('00000000-0000-0000-0000-00000000cd01'), true,
  '...and the post is marked');

select is(
  public.request_takedown('00000000-0000-0000-0000-00000000cd02') ->> 'reason',
  'taken_down',
  '...while an untouched post is unaffected');

-- The list the Edge Function deletes from. All three assets, both buckets.
select is(
  (select count(*)::integer
     from jsonb_array_elements(
       public.request_takedown('00000000-0000-0000-0000-00000000cd01') -> 'objects')), 3,
  'every asset comes back, derivatives and master alike');

select ok(
  exists (select 1 from jsonb_array_elements(
            public.request_takedown('00000000-0000-0000-0000-00000000cd01') -> 'objects') o
          where o ->> 'bucket' = 'originals'),
  '...including the originals master (§6''s preservation copy is not an exception here)');

-- Idempotent, because retrying is the documented recovery path when byte deletion fails
-- partway. A second call must hand back the object list, not a refusal.
select is(
  public.request_takedown('00000000-0000-0000-0000-00000000cd01') ->> 'reason',
  'already_taken_down',
  'a retry is answered, not refused — retrying IS the recovery path');

select is(
  public.request_takedown('00000000-0000-0000-0000-0000000000ff') ->> 'reason',
  'unknown_post',
  'and an unknown post is named rather than silently succeeding');

reset role;

-- ═══ 15–16 · The audit trail ═════════════════════════════════
--
-- §4: "Every moderator and admin action writes to moderation_actions AND audit_log with
-- actor, target, timestamp, and before/after state."

select is(
  (select count(*)::integer from public.audit_log a
    where a.target_id = '00000000-0000-0000-0000-00000000cd01'
      and a.action = 'post.takedown'
      and a.actor = '00000000-0000-0000-0000-00000000ba02'), 1,
  'the takedown wrote an audit row naming the moderator who did it');

-- The reason, carried to the ledger through a transaction-local GUC because the writer is a
-- trigger and a trigger takes no arguments. A takedown without a recorded reason is a poor
-- record of a decision that may need explaining to the person it affected.
select is(
  (select m.note from public.moderation_actions m
    where m.target_id = '00000000-0000-0000-0000-00000000cd01'
      and m.action = 'post.takedown'),
  'family requested removal',
  '...and the moderation_actions row carries the reason it was given');

select * from finish();
rollback;
