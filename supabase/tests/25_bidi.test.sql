-- The bidi sweep, on ingest (0045).
--
-- §6: "Bidi: strip U+202A–202E and U+2066–2069 on ingest. Render user strings in <bdi>."
--
-- This file pins the first half. The second is a render rule and is asserted by
-- scripts/frontend-view-test.mjs and supabase/functions/publish/prerender.test.ts.
--
-- ── Why this is worth a file of its own ──────────────────────
--
-- The characters are invisible. Every assertion below would pass by accident against a
-- function that did nothing, if it were written as "the text looks right" — because the
-- text DOES look right, in a terminal, in a diff and in a code review. So every assertion
-- here is on CODEPOINTS, and the fixtures are built with chr() rather than pasted, which is
-- also what stops this file becoming a Trojan Source carrier itself.
--
-- ── What is deliberately NOT stripped ────────────────────────
--
-- U+200E / U+200F (LRM / RLM) and U+061C (ALM) are bidi MARKS, not overrides: they nudge a
-- neutral character at a script boundary and Arabic prose quoting a Latin phrase needs
-- them. §6 names the override and isolate ranges and not the marks. Assertions 8 and 9 pin
-- that distinction, because "strip more" is the obvious-looking change somebody will make.

begin;
create extension if not exists pgtap;

-- 4 the function · 6 the triggers · 2 the marks survive · 2 the ordering
select plan(14);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d1', 'bidi-author@t.local'),
  ('00000000-0000-0000-0000-0000000000d2', 'bidi-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-0000000000d2', 'moderator',
        '00000000-0000-0000-0000-0000000000d2');

/* The eight characters §6 names, built rather than pasted. RLO (U+202E) is the one that
   does the damage a reader would notice: it reverses everything after it. */
create function pg_temp.controls() returns text
language sql immutable as $fn$
  select chr(8234) || chr(8235) || chr(8236) || chr(8237) || chr(8238)   -- 202A..202E
      || chr(8294) || chr(8295) || chr(8296) || chr(8297);               -- 2066..2069
$fn$;

/* True when any of the eight survives. Written as a range test rather than as an equality
   list so a value that lands between them cannot slip through a typo. */
create function pg_temp.has_controls(t text) returns boolean
language sql immutable as $fn$
  select t ~ ('[' || chr(8234) || '-' || chr(8238) || chr(8294) || '-' || chr(8297) || ']');
$fn$;

-- ═══ 1–4 · The function ══════════════════════════════════════

-- CONTROL, first. Every assertion below is "the controls are gone", and a detector that
-- never fires would satisfy all of them against a function that returned its input.
select ok(
  pg_temp.has_controls('safe' || pg_temp.controls()),
  'CONTROL: the detector DOES fire on a string carrying the controls');

select ok(
  not pg_temp.has_controls(public.strip_bidi('safe' || pg_temp.controls() || 'text')),
  'strip_bidi removes every one of §6''s eight');

select is(
  public.strip_bidi('safe' || pg_temp.controls() || 'text'),
  'safetext',
  '...and removes nothing else');

select is(public.strip_bidi(null), null, 'null in, null out — not an empty string');

-- ═══ 5–10 · The triggers ═════════════════════════════════════

-- The title a moderator reads when deciding. RLO here means the sentence they approve is
-- not the sentence that publishes, which is an attack on the decision rather than on the
-- rendering.
insert into public.posts (id, kind, title_ar, title_en, body_en, license, provenance, created_by,
                          ingest_state, status)
values ('00000000-0000-0000-0000-0000000d0001', 'media',
        'عنوان' || pg_temp.controls(),
        'A title' || pg_temp.controls(),
        'A description' || pg_temp.controls(),
        'CC-BY-SA-4.0',
        'family album' || pg_temp.controls(),
        '00000000-0000-0000-0000-0000000000d1', 'ready', 'pending');

select ok(
  not pg_temp.has_controls(
    (select coalesce(title_ar, '') || coalesce(title_en, '') || coalesce(body_en, '')
       || coalesce(provenance, '')
       from public.posts where id = '00000000-0000-0000-0000-0000000d0001')),
  'a post is stripped on INSERT — title, body and provenance');

-- On UPDATE too. An edit is the second way text enters this table and is the one a
-- trigger written only for INSERT would miss entirely.
update public.posts
   set title_en = 'edited' || pg_temp.controls()
 where id = '00000000-0000-0000-0000-0000000d0001';

select ok(
  not pg_temp.has_controls(
    (select title_en from public.posts where id = '00000000-0000-0000-0000-0000000d0001')),
  '...and on UPDATE, which is the other way text arrives');

insert into public.profiles (id, handle, display_name, bio)
values ('00000000-0000-0000-0000-0000000000d1',
        'bidi' || pg_temp.controls() || 'user',
        'Display' || pg_temp.controls(),
        'A bio' || pg_temp.controls());

select ok(
  not pg_temp.has_controls(
    (select handle || coalesce(display_name, '') || coalesce(bio, '')
       from public.profiles where id = '00000000-0000-0000-0000-0000000000d1')),
  'a profile is stripped — handle, display name and bio');

-- The handle specifically, and this is why it runs BEFORE the constraints: a handle is a
-- URL segment and a mention token, and two accounts differing only by an invisible
-- override are two accounts that look identical everywhere they are attributed. The stored
-- value has to be the one the CHECK validated.
select is(
  (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000d1'),
  'bidiuser',
  '...and the handle stored is the cleaned one, so it survives profiles_handle_is_normalized');

-- Inserted pending and then approved, rather than inserted as approved:
-- posts_approved_is_attributable requires approved_at and content_hash, and both are
-- written by posts_enforce_approval, which is a BEFORE UPDATE trigger. A row that arrives
-- already approved has neither and violates the constraint.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by,
                          ingest_state, status)
values ('00000000-0000-0000-0000-0000000d0002', 'media', 'commentable', 'a description',
        'CC-BY-SA-4.0', 'family album', '00000000-0000-0000-0000-0000000000d1',
        'ready', 'pending');

update public.posts
   set status = 'approved', approved_by = '00000000-0000-0000-0000-0000000000d2'
 where id = '00000000-0000-0000-0000-0000000d0002';

insert into public.comments (id, post_id, body, created_by)
values ('00000000-0000-0000-0000-0000000d0c01',
        '00000000-0000-0000-0000-0000000d0002',
        'a remark' || pg_temp.controls(),
        '00000000-0000-0000-0000-0000000000d1');

select ok(
  not pg_temp.has_controls(
    (select body from public.comments where id = '00000000-0000-0000-0000-0000000d0c01')),
  'a comment is stripped — and a comment reaches a shard, so this one reaches the public');

insert into public.reports (id, target_type, target_id, reason, reported_by)
values ('00000000-0000-0000-0000-0000000d0f01', 'post',
        '00000000-0000-0000-0000-0000000d0002',
        'this is wrong because' || pg_temp.controls(),
        '00000000-0000-0000-0000-0000000000d1');

select ok(
  not pg_temp.has_controls(
    (select reason from public.reports where id = '00000000-0000-0000-0000-0000000d0f01')),
  'a report reason is stripped — a moderator decides on what they can see');

-- ═══ 11–12 · The marks survive ═══════════════════════════════

-- The distinction §6 draws, and the one somebody will be tempted to erase by "stripping
-- more". These three are how an Arabic sentence keeps a Latin phrase's brackets and
-- punctuation in the right place; removing them corrupts honest text on exactly the pages
-- this archive is made of.
select is(
  public.strip_bidi('a' || chr(8206) || chr(8207) || chr(1564) || 'b'),
  'a' || chr(8206) || chr(8207) || chr(1564) || 'b',
  'LRM, RLM and ALM survive — they are marks, not overrides (§6 names neither)');

select is(
  (select title_en from public.posts where id = '00000000-0000-0000-0000-0000000d0001'),
  'edited',
  'CONTROL: the same column DOES lose the overrides, so the assertion above is not vacuous');

-- ═══ 13–14 · Ordering, which is load-bearing ═════════════════

-- posts_bidi_strip is named to sort first among this table's BEFORE triggers, because
-- posts_enforce_approval compares OLD content against NEW and post_content_hash() is
-- computed over the stored row. If the strip ran later, an edit that only added an
-- invisible control would read as a content change — and the hash recorded at approval
-- would be over text nobody could see.
select is(
  (select t.tgname::text
     from pg_trigger t
     join pg_class c on c.oid = t.tgrelid
     join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relname = 'posts'
      and not t.tgisinternal
      and (t.tgtype & 2) = 2          -- BEFORE
    order by t.tgname
    limit 1),
  'posts_bidi_strip',
  'the strip is the FIRST before-trigger on posts, so every later one sees cleaned text');

-- The consequence, asserted from the outside: an approved post whose only "edit" is an
-- invisible control does not return to the moderation queue, because by the time
-- posts_enforce_approval looks there is no change to see.
update public.posts
   set title_en = 'commentable' || pg_temp.controls()
 where id = '00000000-0000-0000-0000-0000000d0002';

select is(
  (select status::text from public.posts where id = '00000000-0000-0000-0000-0000000d0002'),
  'approved',
  'an edit that adds only invisible controls is not a content change');

select * from finish();
rollback;
