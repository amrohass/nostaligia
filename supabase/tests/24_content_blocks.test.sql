-- Editorial copy, from the dashboard to the shard (0043).
--
-- §9: "All content comes from the store, never hardcoded in views. Page copy, cards, events,
-- comments, and the info page all read from content_blocks/shards so the dashboard is the
-- single source of truth."
--
-- 0009 built the table in M0 and nothing read it until M3. What this file pins is the three
-- things that make the sentence above true rather than aspirational:
--
--   · only `published` reaches a shard, never `draft`
--   · publishing bumps the content revision, so an edit actually goes live
--   · typing into a draft does NOT, because a draft appears in no shard and is the
--     highest-volume write this table takes
--
-- ── The privilege boundary, restated ─────────────────────────
--
-- §4 makes editing site copy admin-only. 05_matrix already walks content_blocks × role ×
-- operation; the assertions here are about the ACCESSORS — that published_content_blocks()
-- is not reachable from a browser at all, and that content_blocks_draft() answers a
-- moderator with nothing rather than with unpublished prose.

begin;
create extension if not exists pgtap;

-- 5 the accessor · 3 the signal · 3 grants · 2 the seed
select plan(13);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'cb-admin@t.local'),
  ('00000000-0000-0000-0000-0000000000c2', 'cb-mod@t.local');

insert into public.user_roles (user_id, role, granted_by) values
  ('00000000-0000-0000-0000-0000000000c1', 'admin',
   '00000000-0000-0000-0000-0000000000c1'),
  ('00000000-0000-0000-0000-0000000000c2', 'moderator',
   '00000000-0000-0000-0000-0000000000c1');

create function pg_temp.content_rev() returns bigint
language sql stable as $fn$
  select content_revision from public.publish_revision where id;
$fn$;

-- ═══ 1–5 · What the publisher may read ═══════════════════════

insert into public.content_blocks (key, locale, draft, published) values
  ('t.line', 'ar', 'مسوّدة عربية', 'منشور عربي'),
  ('t.line', 'en', 'an english draft', 'published english'),
  -- Drafted, never published. The case the accessor must not leak.
  ('t.unpublished', 'ar', 'مسوّدة لم تُنشر', null),
  ('t.unpublished', 'en', 'an unpublished draft', null),
  -- Published in one language only, which is the ordinary state of a block an editor is
  -- part-way through translating.
  ('t.half', 'ar', 'نصف', 'نصف منشور');

select is(
  public.published_content_blocks() -> 't.line' ->> 'ar',
  'منشور عربي',
  'the published Arabic side reaches the publisher');

select is(
  public.published_content_blocks() -> 't.line' ->> 'en',
  'published english',
  '...and the English side beside it');

-- THE assertion of this file. `draft` is unpublished prose and a shard is served to
-- everyone for a year; a builder that read the wrong column would publish a paragraph
-- somebody was still working on, and nothing about the output would look wrong.
select ok(
  public.published_content_blocks()::text not like '%مسوّدة%'
    and public.published_content_blocks()::text not like '%an english draft%',
  'no draft text reaches the publisher, in either language');

select ok(
  not (public.published_content_blocks() ? 't.unpublished'),
  'a block with nothing published is ABSENT, not present and empty');

-- Present-and-empty would blank the page the block appears on, which reads as a rendering
-- bug rather than as an editor who has not finished. The half-translated case proves the
-- shape: one side present, the other absent, and the front end falls back.
select is(
  (select count(*)::int from jsonb_object_keys(public.published_content_blocks() -> 't.half')),
  1,
  'a half-translated block carries only the side that is published');

-- ═══ 6–8 · The signal ════════════════════════════════════════
--
-- 0037's rule applied to a new table: everything the publisher reads must say when it
-- changed, or the archive serves that column's first value forever.
--
-- Measured as a DELTA, in a temporary table, because every insert above also moved the
-- number and an absolute value would encode the order of this file rather than the rule.

create temporary table cb_rev (rev_before bigint);
insert into cb_rev select pg_temp.content_rev();

update public.content_blocks set draft = 'a second draft edit'
 where key = 't.line' and locale = 'en';

select is(
  pg_temp.content_rev(),
  (select rev_before from cb_rev),
  'typing into a DRAFT publishes nothing — it appears in no shard');

update public.content_blocks set published = 'a published edit'
 where key = 't.line' and locale = 'en';

select cmp_ok(
  pg_temp.content_rev(), '>', (select rev_before from cb_rev),
  'publishing DOES move the content revision, so the edit goes live');

-- The other direction: UN-publishing a block changes the archive too. A block set back to
-- null disappears from content.json, and a page that silently kept its old paragraph would
-- be the archive ignoring an editor's decision to withdraw it.
update cb_rev set rev_before = pg_temp.content_rev();
update public.content_blocks set published = null
 where key = 't.half' and locale = 'ar';

select cmp_ok(
  pg_temp.content_rev(), '>', (select rev_before from cb_rev),
  'withdrawing a published block moves it too');

-- ═══ 9–11 · Who may call what ════════════════════════════════

-- Same posture as publishable_posts: not secret, and not a browser endpoint either. §2's
-- read path is "zero database reads for public visitors", and an RPC returning every block
-- in one call is the most convenient way to violate that by accident.
set local role anon;
set local request.jwt.claims to '';
select throws_ok(
  $q$ select public.published_content_blocks() $q$,
  '42501', null,
  'anon cannot call published_content_blocks');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000c2","role":"authenticated"}';
select throws_ok(
  $q$ select public.published_content_blocks() $q$,
  '42501', null,
  'nor can a signed-in member — the shard is the read path, not this');

-- §4: editing site copy is admin-only, so READING unpublished copy is too. A moderator gets
-- an empty set rather than an error, which is the honest answer: the function exists, they
-- may call it, and they are entitled to nothing from it.
select is(
  (select count(*)::int from public.content_blocks_draft()),
  0,
  'content_blocks_draft returns nothing to a moderator — §4 makes site copy admin-only');
reset role;

-- ═══ 12–13 · The copy 0043 moved out of store.js ═════════════

-- The migration carries the archive's Arabic and English prose out of a JavaScript file and
-- into the table. If it did not land, the site renders with no hero, no footer and no info
-- page — and that failure looks like a front-end bug rather than a missing migration.
select ok(
  public.published_content_blocks() ? 'hero.line'
    and public.published_content_blocks() ? 'footer.blurb'
    and public.published_content_blocks() ? 'page.about.body',
  'the copy 0043 moved out of store.js is in the table');

-- page.order is what the info page's section list is built from, and archive.js skips a slug
-- whose title is missing — so a slug named here with no title silently loses a whole section
-- of the site, with nothing anywhere reporting it.
select ok(
  (select bool_and(
     public.published_content_blocks() ? ('page.' || slug || '.title')
     and public.published_content_blocks() ? ('page.' || slug || '.body'))
   from unnest(string_to_array(
          public.published_content_blocks() -> 'page.order' ->> 'ar', ',')) as slug),
  'every slug page.order names has both a title and a body');

select * from finish();
rollback;
