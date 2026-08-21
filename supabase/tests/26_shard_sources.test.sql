-- What a release is allowed to contain, part two: comments, profiles and item pages (0044,
-- 0046).
--
-- 18_publishable_posts pins the post predicate. This file pins the three things M3 added to
-- the publisher's read side, and each one is here because it moves a §7 boundary:
--
--   comments      a comment BODY now travels into a shard. It is one more place text
--                 becomes public, and one more place created_by must not.
--   profiles      a profile page is the aggregate §7 names as the de-anonymisation vector,
--                 so the visibility map decides what a shard may carry — at publish time,
--                 not in a browser.
--   item pages    §9's prerendered page lives outside the release, so nothing about the
--                 next release removes it. unpublishable_post_ids is what does.
--
-- ── And the signal that goes with them ───────────────────────
--
-- 0044 splits the comment trigger by what a shard carries: a moderator publishing a comment
-- is a CONTENT change and asks for a publish; a member posting into the queue is not and
-- must not send an HTTP request from inside the database on an ordinary write (0042's rule).
-- Assertions 11–13 pin the split, because it is invisible from either side alone.

begin;
create extension if not exists pgtap;

-- 4 comments in shards · 4 profiles · 3 item pages · 3 the signal
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000e1', 'shard-author@t.local'),
  ('00000000-0000-0000-0000-0000000000e2', 'shard-mod@t.local'),
  ('00000000-0000-0000-0000-0000000000e3', 'shard-quiet@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000e2', 'moderator',
        '00000000-0000-0000-0000-0000000000e2');

insert into public.profiles (id, handle, display_name, bio, visibility) values
  ('00000000-0000-0000-0000-0000000000e1', 'openhandle', 'Open Author', 'a public bio',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  -- Everything gated. §7: "owner sees all on their own profile; others see only what is
  -- marked public" — and a shard is served to others, always.
  ('00000000-0000-0000-0000-0000000000e3', 'quiethandle', 'Quiet Author', 'a private bio',
   '{"bio":"private","personalInfo":"private","contributions":"private","comments":"private"}');

create function pg_temp.content_rev() returns bigint
language sql stable as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

create function pg_temp.counter_rev() returns bigint
language sql stable as $fn$
  select counter_revision from public.publish_revision where id;
$fn$;

/* One publishable post per author. Inserted pending and then approved, because
   posts_approved_is_attributable wants approved_at and content_hash and both are written by
   the BEFORE UPDATE trigger. */
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          ingest_state, status) values
  ('00000000-0000-0000-0000-0000000e0001', 'media', 'an open item', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1', 'ready', 'pending'),
  ('00000000-0000-0000-0000-0000000e0002', 'media', 'a quiet item', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e3', 'ready', 'pending'),
  -- Approved and then withdrawn, further down. This is the row unpublishable_post_ids has
  -- to find: it HAD a page, and it must not keep one.
  ('00000000-0000-0000-0000-0000000e0003', 'media', 'a withdrawn item', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1', 'ready', 'pending'),
  -- Never approved. It has no page, so deleting one every publish would be a request per
  -- draft, forever — which is the cost this list is bounded to avoid.
  ('00000000-0000-0000-0000-0000000e0004', 'media', 'a draft', 'a description',
   'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000e1', 'ready', 'pending');

update public.posts set status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000e2'
 where id in ('00000000-0000-0000-0000-0000000e0001',
              '00000000-0000-0000-0000-0000000e0002',
              '00000000-0000-0000-0000-0000000e0003');

-- ═══ 1–4 · Comments reach the shard, without their author's id ══

insert into public.comments (id, post_id, body, lang, status, created_by) values
  ('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0001',
   'a published remark', 'en', 'published', '00000000-0000-0000-0000-0000000000e3'),
  ('00000000-0000-0000-0000-0000000e0c02', '00000000-0000-0000-0000-0000000e0001',
   'a PENDING remark nobody approved', 'en', 'pending', '00000000-0000-0000-0000-0000000000e3'),
  ('00000000-0000-0000-0000-0000000e0c03', '00000000-0000-0000-0000-0000000e0001',
   'a HIDDEN remark a moderator removed', 'en', 'hidden', '00000000-0000-0000-0000-0000000000e3');

create function pg_temp.item(p_id uuid) returns jsonb
language sql stable as $fn$
  select item from jsonb_array_elements(public.publishable_posts()) as t(item)
   where item ->> 'id' = p_id::text;
$fn$;

select is(
  jsonb_array_length(pg_temp.item('00000000-0000-0000-0000-0000000e0001') -> 'comments'),
  1,
  'only the PUBLISHED comment travels — pre-moderation means what it says');

select ok(
  public.publishable_posts()::text not like '%a PENDING remark%'
    and public.publishable_posts()::text not like '%a HIDDEN remark%',
  '...and neither the unreviewed one nor the removed one is in the bytes anywhere');

select is(
  pg_temp.item('00000000-0000-0000-0000-0000000e0001') -> 'comments' -> 0 ->> 'author_handle',
  'quiethandle',
  'a comment is attributed by handle');

-- §7's aggregate vector reaches comments too: created_by is the key that joins one person's
-- remarks across the whole archive, and it is exactly as absent here as it is on a post.
select ok(
  not (pg_temp.item('00000000-0000-0000-0000-0000000e0001') -> 'comments' -> 0 ? 'created_by')
    and public.publishable_posts()::text not like
        '%00000000-0000-0000-0000-0000000000e3%',
  'no commenter user id reaches the publisher');

-- ═══ 5–8 · Profiles, as §7 permits them ══════════════════════

create function pg_temp.profile(p_handle text) returns jsonb
language sql stable as $fn$
  select item from jsonb_array_elements(public.publishable_profiles()) as t(item)
   where item ->> 'handle' = p_handle;
$fn$;

select is(
  pg_temp.profile('openhandle') ->> 'bio',
  'a public bio',
  'a public bio reaches the shard');

select is(
  pg_temp.profile('quiethandle') ->> 'bio',
  null,
  'a private bio does NOT — the browser is never handed it and asked to be discreet');

select is(
  (pg_temp.profile('quiethandle') ->> 'show_contributions')::boolean,
  false,
  'the visibility flags travel, so the publisher can decide whether to build the list at all');

-- The set is bounded by the ARCHIVE, not by the user table: one shard per profile for tens
-- of thousands of accounts would be tens of thousands of objects rewritten on every
-- release, and §2's incremental diff is deferred.
select is(
  (select count(*)::int from jsonb_array_elements(public.publishable_profiles())),
  2,
  'only profiles the archive actually names get a shard');

-- ═══ 9–11 · The pages a release must take away ═══════════════

update public.posts set status = 'withdrawn'
 where id = '00000000-0000-0000-0000-0000000e0003';

select ok(
  public.unpublishable_post_ids() @> '["00000000-0000-0000-0000-0000000e0003"]'::jsonb,
  'a withdrawn post is listed, so its prerendered page is deleted on the next publish');

-- THE bound. Without it the publisher issues one DELETE per member draft on every release,
-- forever, and the set only grows — §6 spends four layers on exactly this class of
-- unbounded operation.
select ok(
  not (public.unpublishable_post_ids() @> '["00000000-0000-0000-0000-0000000e0004"]'::jsonb),
  'a post that was never approved is NOT listed — it never had a page');

-- And the other direction, which is what makes the two above mean something: a post that IS
-- publishable must not be in the list, or every release would delete the page it just wrote.
select ok(
  not (public.unpublishable_post_ids() @> '["00000000-0000-0000-0000-0000000e0001"]'::jsonb),
  'a live post is not listed');

-- ═══ 12–14 · The comment signal, split by what a shard carries ══

create temporary table sc_rev (content_before bigint, counter_before bigint);
insert into sc_rev select pg_temp.content_rev(), pg_temp.counter_rev();

-- A member posting into the moderation queue. Changes no published byte, and 0042 must not
-- send an HTTP request from inside the database on an ordinary member's write.
insert into public.comments (id, post_id, body, status, created_by)
values ('00000000-0000-0000-0000-0000000e0c04', '00000000-0000-0000-0000-0000000e0001',
        'another pending remark', 'pending', '00000000-0000-0000-0000-0000000000e3');

select is(
  pg_temp.content_rev(),
  (select content_before from sc_rev),
  'a PENDING comment moves no content revision — it appears in no shard');

select cmp_ok(
  pg_temp.counter_rev(), '>', (select counter_before from sc_rev),
  '...it moves the counter instead, so the signal is still honest');

-- The moderator's decision. This one DOES change published bytes, so it has to ask for a
-- release: on the counter branch it would wait for an unrelated content change, which on a
-- quiet week is days.
update sc_rev set content_before = pg_temp.content_rev();
update public.comments set status = 'published'
 where id = '00000000-0000-0000-0000-0000000e0c04';

select cmp_ok(
  pg_temp.content_rev(), '>', (select content_before from sc_rev),
  'publishing a comment IS a content change — the body is in the next release');

select * from finish();
rollback;
