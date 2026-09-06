-- The removal section reaches the page (0061), and page.order survives being edited.
--
-- §11 gate 4 is discharged by the maintainer being REACHABLE, and on the public site that
-- reduces to one thing: does the "Request removal" section actually render, in both
-- languages. Everything between the decision and the screen is data — two blocks and a slug
-- in a comma-separated list — so this file is where that data is checked.
--
-- ── Why this is not covered by 24_content_blocks ─────────────
--
-- 24's assertion 13 walks page.order and demands that every slug it names has a title and a
-- body. That catches a slug with no copy. It does NOT catch the inverse, which is the
-- failure 0061 could actually produce: copy with no slug. The blocks would sit in the table,
-- correct and bilingual, appearing on no page — and nothing in the suite would say so,
-- because assertion 13 iterates the order and the order would not name them.
--
-- It also cannot see the order MUTATION, which is the genuinely risky part of 0061: two
-- UPDATE statements with regex guards, against a block whose whole purpose is that an editor
-- may have changed it. A mangled order silently loses whole sections of the site.
--
-- ── One deliberately absent assertion ────────────────────────
--
-- Nothing here asserts the prose. Copy is the editor's from the moment they touch it (0043),
-- so an assertion on the wording would be a test that goes red when an admin does exactly
-- what the dashboard is for. What is asserted is that the block EXISTS in both locales and
-- that it names the two intake paths — the reachability the gate is about, not the sentences
-- around it.

begin;
create extension if not exists pgtap;

-- 4 the section · 2 the intake paths · 5 the order mutation
select plan(11);

create function pg_temp.blocks() returns jsonb
language sql stable as $fn$ select public.published_content_blocks() $fn$;

create function pg_temp.order_slugs(col text) returns text[]
language sql stable as $fn$
  select string_to_array(
           (select case when $1 = 'draft' then draft else published end
              from public.content_blocks where key = 'page.order' and locale = 'ar'), ',')
$fn$;

-- ═══ 1–4 · The section is there, in both languages ═══════════
--
-- Both locales, both blocks, separately. A section that exists only in English is an
-- Arabic-first archive telling the population §7 is about to read English (§9), and a title
-- with no body renders a heading over nothing.

select ok(
  pg_temp.blocks() -> 'page.removal.title' ->> 'ar' is not null
    and length(pg_temp.blocks() -> 'page.removal.title' ->> 'ar') > 0,
  'the removal section has an Arabic title');

select ok(
  pg_temp.blocks() -> 'page.removal.title' ->> 'en' is not null
    and length(pg_temp.blocks() -> 'page.removal.title' ->> 'en') > 0,
  '...and an English one');

select ok(
  pg_temp.blocks() -> 'page.removal.body' ->> 'ar' is not null
    and length(pg_temp.blocks() -> 'page.removal.body' ->> 'ar') > 0,
  'the removal section has an Arabic body');

select ok(
  pg_temp.blocks() -> 'page.removal.body' ->> 'en' is not null
    and length(pg_temp.blocks() -> 'page.removal.body' ->> 'en') > 0,
  '...and an English one');

-- ═══ 5–6 · Both intake paths are named ═══════════════════════
--
-- The address is the half of gate 4 that nothing else in this repository can check. §4 puts
-- the report control behind the sign-in gate, so a third-party subject — the person with the
-- strongest claim (0053) and no account — reaches a human through this string or through
-- nothing. A copy edit that dropped it would leave the section reading correctly and
-- close the only door that population has.
--
-- Asserted in BOTH locales, because a monolingual address is the same failure for whichever
-- half of the readership loses it.

select ok(
  pg_temp.blocks() -> 'page.removal.body' ->> 'ar' like '%reports@%'
    and pg_temp.blocks() -> 'page.removal.body' ->> 'en' like '%reports@%',
  'the third-party intake address is published in both languages');

-- The in-platform path, named by the enum value the control writes. 0053's INSERT policy
-- admits any signed-in user against any target, so this is a route as real as the address.
select ok(
  exists (select 1 from pg_enum e
           join pg_type t on t.oid = e.enumtypid
          where t.typname = 'report_kind' and e.enumlabel = 'removal'),
  'the in-platform intake path the copy points at still exists');

-- ═══ 7–10 · The order mutation ═══════════════════════════════

select ok(
  'removal' = any (pg_temp.order_slugs('published')),
  'page.order NAMES the slug — copy with no slug appears on no page');

select ok(
  'removal' = any (pg_temp.order_slugs('draft')),
  '...on the draft side too, so the editor opens a list that matches the live one');

-- Placement, on an order nobody has edited: after "support", which is where a person hunting
-- for this looks first, and before the donation ask. Asserted as a RELATION rather than as
-- the literal string, so an editor moving a different section does not turn this red.
select ok(
  array_position(pg_temp.order_slugs('published'), 'removal')
    > array_position(pg_temp.order_slugs('published'), 'support')
  and array_position(pg_temp.order_slugs('published'), 'removal')
    < array_position(pg_temp.order_slugs('published'), 'donate'),
  'it sits between support and donate on an order nobody has reordered');

-- EXACTLY once, and this is the assertion that discriminates. 0061's second statement
-- APPENDS, so a guard that failed open would add the slug again on every re-run and
-- archive.js would render the section twice — with duplicate DOM ids, an accessibility
-- defect as well as a visible one.
--
-- The three assertions above all survive that: `= any` is still true of a duplicated slug,
-- and array_position returns the FIRST match, so the placement check still reads 4 > 3 and
-- 4 < 5 against `…,support,removal,donate,removal`. So does 24's assertion 13, which walks
-- the slugs and asks only whether each has copy. Applying this migration twice was green
-- everywhere until this line existed.
select is(
  (select count(*)::int from unnest(pg_temp.order_slugs('published')) s where s = 'removal'),
  1,
  'exactly once — a second apply must not append it again');

-- ── Re-running it here, rather than trusting the shape ───────
--
-- Everything above measures the STATE 0061 left behind. This runs its order statements a
-- second time and asserts they change nothing, against a DELIBERATELY REORDERED value —
-- the case the second statement exists for and the case the first one must decline to touch.
--
-- Honest about what it is: a COPY of the migration's two statements, because they are
-- statements in a file and not a function anything can call. Editing 0061's guards without
-- editing these leaves this green on logic that is no longer deployed. The check that has no
-- copy in it is to concatenate the migration onto itself as a prelude and re-run this whole
-- file — written up in docs/takedown-runbook.md §6.
update public.content_blocks
   set draft = 'donate,about,removal,contact,support', published = 'donate,about,removal,contact,support'
 where key = 'page.order';

update public.content_blocks
   set draft     = 'about,contact,support,removal,donate',
       published = 'about,contact,support,removal,donate'
 where key = 'page.order'
   and coalesce(published, draft) = 'about,contact,support,donate';

update public.content_blocks
   set draft = case
                 when coalesce(draft, '') = '' then draft
                 when draft ~ '(^|,)\s*removal\s*(,|$)' then draft
                 else draft || ',removal'
               end,
       published = case
                 when coalesce(published, '') = '' then published
                 when published ~ '(^|,)\s*removal\s*(,|$)' then published
                 else published || ',removal'
               end
 where key = 'page.order'
   and (   (coalesce(draft, '')     <> '' and draft     !~ '(^|,)\s*removal\s*(,|$)')
        or (coalesce(published, '') <> '' and published !~ '(^|,)\s*removal\s*(,|$)'));

select is(
  (select published from public.content_blocks where key = 'page.order' and locale = 'ar'),
  'donate,about,removal,contact,support',
  're-running 0061 over an editor''s own order neither duplicates the slug nor imposes an order');

select * from finish();
rollback;
