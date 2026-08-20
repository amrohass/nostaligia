-- 0045 · The bidi sweep, on ingest
--
-- §6: "Bidi: strip U+202A–202E and U+2066–2069 on ingest. Render user strings in <bdi>."
--
-- Two halves, and this is the first. The second is a render-time rule and lives in
-- assets/js/ui.js.
--
-- ── What these characters do ─────────────────────────────────
--
-- They are the explicit bidirectional formatting controls: LRE, RLE, PDF, LRO, RLO
-- (U+202A–U+202E) and LRI, RLI, FSI, PDI (U+2066–U+2069). Every one of them changes the
-- ORDER in which the characters after it are displayed, and none of them is visible.
--
-- On an Arabic-first site that matters more than it does elsewhere. RLO in particular
-- reverses a run outright, so a title that reads
--
--     "Municipality building, 1958"
--
-- to a moderator approving it can be authored to read as something else entirely once
-- published — or to hide a URL's real host in a provenance line. The moderation queue is a
-- screen where a human decides based on what they can see, which makes an invisible
-- reordering control an attack on the decision, not on the rendering.
--
-- Trojan Source (CVE-2021-42574) is the same trick against source code. The defence there
-- and here is identical: refuse to store them.
--
-- ── What is NOT stripped, deliberately ───────────────────────
--
-- U+200E / U+200F (LRM / RLM) and U+061C (Arabic Letter Mark) are bidi MARKS, not overrides.
-- They nudge the placement of a neutral character — a bracket, a digit, a full stop — at the
-- boundary between scripts, and Arabic prose that quotes a Latin phrase legitimately needs
-- them. §6 names the override and isolate ranges and not the marks, and that distinction is
-- the correct one rather than an oversight: stripping the marks would corrupt honest text on
-- exactly the pages this archive is made of.
--
-- ── Where ────────────────────────────────────────────────────
--
-- Every column that carries text a user typed AND that another human later reads as evidence
-- for a decision or as archive content. Not `places` (moderator-curated gazetteer, M4), and
-- not `content_blocks` (§4 makes site copy admin-only; an admin who wants to reverse a run in
-- their own site copy is not an attacker on their own site, and silently deleting their
-- isolate would be a bug rather than a defence).
--
-- ── Existing rows ────────────────────────────────────────────
--
-- A trigger cleans what is written from here; it does not clean what is already stored, and
-- this migration deliberately does not sweep. An UPDATE over `posts` would fire
-- posts_enforce_approval on every row and return the entire approved archive to the
-- moderation queue — a data-loss-shaped event to fix a problem that does not exist yet. The
-- database is pre-launch and holds no contributed content; the M5 bulk importer INSERTs
-- through this same trigger, so the ~300 seed items arrive clean.

set search_path = public, extensions;

-- ── The function ─────────────────────────────────────────────
--
-- IMMUTABLE and free of I/O, so it can be used in a CHECK, an index or a generated column
-- later without a second definition.
--
-- E'' with \u escapes rather than the characters themselves, and this is not style. Pasting
-- the literal controls into this file would make the migration ITSELF a Trojan Source
-- carrier: eight invisible characters inside a bracket expression, in the one file whose job
-- is to remove them, where nobody reviewing a diff could see what the range actually
-- contained. The escapes are processed by the string literal — the regex engine never sees a
-- backslash — so the class is two ranges of real characters at execution time and eight
-- readable, greppable codepoints on the page.
create or replace function public.strip_bidi(t text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select case when t is null then null
              else regexp_replace(t, E'[\u202A-\u202E\u2066-\u2069]', '', 'g')
         end;
$$;

comment on function public.strip_bidi(text) is
  'CLAUDE.md §6 — removes the bidi override and isolate controls. Marks (200E/200F/061C) are left alone.';

-- ── posts ────────────────────────────────────────────────────
--
-- Named to sort FIRST among this table's BEFORE triggers. PostgreSQL fires them in
-- alphabetical order by name, and `posts_bidi_strip` precedes posts_derive_location_public,
-- posts_enforce_approval, posts_stamp_authorship and posts_touch_updated_at. That ordering
-- is load-bearing in one specific way: posts_enforce_approval compares OLD content against
-- NEW to decide whether an approved item returns to the queue, and post_content_hash() is
-- computed over the stored row. Both must see the cleaned text, or an edit that only added
-- an invisible control would read as a content change — and, worse, the hash recorded at
-- approval would be over text nobody could see.
create or replace function public.posts_strip_bidi()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.title_ar   := public.strip_bidi(new.title_ar);
  new.title_en   := public.strip_bidi(new.title_en);
  new.body_ar    := public.strip_bidi(new.body_ar);
  new.body_en    := public.strip_bidi(new.body_en);
  new.venue_ar   := public.strip_bidi(new.venue_ar);
  new.venue_en   := public.strip_bidi(new.venue_en);
  -- §7 calls provenance the field where liability enters an archive, and it is free text a
  -- contributor writes. A reversed run in "photographed by X, given to the archive by Y" is
  -- an attack on the sentence a moderator is being asked to trust.
  new.provenance := public.strip_bidi(new.provenance);
  return new;
end;
$$;

comment on function public.posts_strip_bidi() is
  'CLAUDE.md §6 — bidi controls never reach storage. Runs before every other BEFORE trigger on posts.';

create trigger posts_bidi_strip
  before insert or update on public.posts
  for each row execute function public.posts_strip_bidi();

-- `license` is deliberately absent: 0032 pins it to a closed vocabulary, so it cannot carry
-- arbitrary text at all. `details` is jsonb with a key allowlist (0022) — the VALUES there
-- are unconstrained and a future milestone that renders alt text or a transcript will have
-- to extend this. Recorded rather than done, because stripping inside jsonb means rebuilding
-- the object key by key, and no view renders those fields today.

-- ── comments ─────────────────────────────────────────────────
create or replace function public.comments_strip_bidi()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.body := public.strip_bidi(new.body);
  return new;
end;
$$;

create trigger comments_bidi_strip
  before insert or update on public.comments
  for each row execute function public.comments_strip_bidi();

-- ── profiles ─────────────────────────────────────────────────
--
-- `handle` is stripped as well as display_name and bio, and it runs before
-- profiles_reject_reserved_handle and before the CHECK constraints — a CHECK fires after
-- every BEFORE trigger, so the value validated by profiles_handle_is_normalized is the
-- cleaned one. A handle is a URL segment and a mention token; two accounts whose handles
-- differ only by an invisible override are two accounts that look identical everywhere they
-- are attributed, which is the impersonation normalized_handle() already exists to prevent.
create or replace function public.profiles_strip_bidi()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.handle       := public.strip_bidi(new.handle);
  new.display_name := public.strip_bidi(new.display_name);
  new.bio          := public.strip_bidi(new.bio);
  return new;
end;
$$;

create trigger profiles_bidi_strip
  before insert or update on public.profiles
  for each row execute function public.profiles_strip_bidi();

-- ── reports ──────────────────────────────────────────────────
--
-- The reason is a member's free text, and the only person who reads it is a moderator
-- deciding what to do about somebody else's content. Same argument as provenance, pointed at
-- the other party.
create or replace function public.reports_strip_bidi()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.reason := public.strip_bidi(new.reason);
  return new;
end;
$$;

create trigger reports_bidi_strip
  before insert or update on public.reports
  for each row execute function public.reports_strip_bidi();

-- ── Grants ───────────────────────────────────────────────────
--
-- strip_bidi is a pure text function and grantable to anything; it is left executable by
-- PUBLIC on purpose, unlike the definer functions 22_rpc_ownership polices. It is not
-- SECURITY DEFINER, it reads nothing, and a caller can already compute it themselves. The
-- trigger functions are not callable in any useful way outside a trigger context, and
-- PostgreSQL's default PUBLIC grant on them is left as it is for the same reason every other
-- trigger function in this schema is: `returns trigger` cannot be invoked directly.
