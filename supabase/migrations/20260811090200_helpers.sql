-- 0002 · Helpers
--
-- Two small functions the table definitions below depend on. Both are IMMUTABLE or
-- trigger-shaped, both pin `search_path` to '' so a hostile schema earlier on a
-- caller's path cannot shadow what they resolve. (pg_catalog is always searched
-- implicitly, so bare core functions still resolve.)

-- Standard updated_at maintenance. Attached to every table carrying the column.
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

comment on function public.touch_updated_at() is
  'BEFORE UPDATE trigger: stamps updated_at. Attached to every table with the column.';

-- profiles.visibility gates the four fields §7 allows a member to hide. Handle,
-- avatar and role badge are never listed — they are always public, so attribution
-- never breaks. This is a function rather than an inline CHECK because a CHECK
-- constraint may not contain a subquery, and validating the values needs one.
create or replace function public.is_valid_visibility(v jsonb)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and v ?& array['bio', 'personalInfo', 'contributions', 'comments']
     and (select count(*) from jsonb_object_keys(v)) = 4
     and not exists (
       select 1
       from jsonb_each_text(v) as entry(k, val)
       where val not in ('public', 'private')
     );
$$;

comment on function public.is_valid_visibility(jsonb) is
  'CLAUDE.md §7 — exactly the four gateable profile fields, each public|private.';

-- ── Handles ──────────────────────────────────────────────────
--
-- A handle is a public identifier that will become a URL segment (/u/<handle> once
-- M3 moves to the History API) and a mention token. On an Arabic-first platform it
-- must accept Arabic — and the moment it does, NFKC alone stops being enough.
--
-- The normalized form folds away everything INVISIBLE or DECORATIVE, and nothing
-- that is orthographically meaningful:
--
--   NFKC          — collapses Arabic presentation forms (ﻣ ﺤ ﻤ ﺪ) onto their base
--                   letters, so a handle cannot be spelled in isolated/initial/medial
--                   glyph variants to impersonate another.
--   lower()       — Latin case folding.
--   tatweel       — U+0640, the kashida. Pure typographic stretching: مـحـمـد and
--                   محمد are the same name, and without this they are two handles.
--   harakat       — U+064B–U+065F and U+0670, the combining vowel marks. Invisible
--                   at most sizes; مُحمد and محمد must not be separate identities.
--
-- What is deliberately NOT folded: alef forms (أ إ آ ا), yeh/alef-maqsura (ي ى) and
-- teh-marbuta/heh (ة ه). Those distinguish genuinely different words, and collapsing
-- them would mean only one of two unrelated names could ever be registered. If you
-- decide impersonation matters more than availability, add them to the translate()
-- below — it is the only place that would change.
--
-- Uniqueness is on THIS function's output, not on the raw string (see the index on
-- public.profiles), and profiles additionally require handle = normalized_handle(handle)
-- so what is stored is what appears in a URL.
create or replace function public.normalized_handle(h text)
returns text
language sql
immutable
parallel safe
strict
set search_path = ''
as $$
  select lower(
           translate(
             normalize(h, nfkc),
             U&'\0640\064B\064C\064D\064E\064F\0650\0651\0652\0653\0654\0655\0656\0657\0658\0659\065A\065B\065C\065D\065E\065F\0670',
             ''
           )
         );
$$;

comment on function public.normalized_handle(text) is
  'Folds NFKC + case + tatweel + harakat. Handle uniqueness is on this output.';

-- Charset and shape. Single-script by design: a handle is all-Latin or all-Arabic,
-- never mixed, because a mixed-script identifier is the classic confusable vector
-- (Latin "a" beside Arabic letters reads as one word and is not one word). ASCII
-- digits and underscore are shared by both scripts; Arabic-Indic digits (٠-٩) are
-- excluded precisely because they would pair off against ASCII digits as homoglyphs.
--
-- The character test is written against CODE POINTS, not regex ranges. A bracket
-- range like [ء-غ] is interpreted using the database collation's sort order, and
-- PostgreSQL's own documentation warns that non-ASCII ranges may not mean what they
-- appear to mean under a locale-aware collation. That is an unacceptable dependency
-- for the function that decides who may call themselves what, so every character is
-- checked by its Unicode value instead:
--
--   97–122      a–z
--   48–57       0–9
--   95          _
--   1569–1594   U+0621–U+063A  hamza through ghain
--   1601–1610   U+0641–U+064A  feh through yeh — note the gap at 1600 (U+0640),
--                              the tatweel, which normalized_handle() strips
--
-- The remaining regexes below are pure ASCII and therefore collation-safe.
create or replace function public.is_allowed_handle(h text)
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  with tally as (
    select
      count(*) filter (where cp between 97 and 122)                                 as latin,
      count(*) filter (where cp between 1569 and 1594 or cp between 1601 and 1610)  as arabic,
      count(*) filter (where cp between 48 and 57 or cp = 95)                       as shared,
      count(*)                                                                      as total
    from (
      select ascii(c) as cp
      from regexp_split_to_table(coalesce(h, ''), '') as t(c)
    ) chars
  )
  select h is not null
     and char_length(h) between 3 and 30
     -- nothing outside the three groups above
     and (select latin + arabic + shared = total from tally)
     -- at least one letter: never only digits and underscores
     and (select latin + arabic > 0 from tally)
     -- single script: all-Latin or all-Arabic, never a mix
     and (select latin = 0 or arabic = 0 from tally)
     -- no leading, trailing or doubled underscore
     and h !~ '^_' and h !~ '_$' and h !~ '__';
$$;

comment on function public.is_allowed_handle(text) is
  'Single-script (all-Latin or all-Arabic), 3–30 chars, at least one letter.';
