-- 0022 · Constrain the jsonb columns
--
-- Promoted into M0 from the weakness list. 0015 spends a hundred lines deciding, per
-- column, what a signed-in stranger may read — and then grants `details`, an
-- unconstrained jsonb blob, to every authenticated user. A blob has no columns to
-- revoke. The moment application code puts a phone number, an exact coordinate or a
-- contributor's real name in there, it walks past the entire privilege model, and no
-- test in this suite would notice.
--
-- The fix is an allowlist, so adding a key requires a migration — which forces the
-- question "should a stranger be able to read this?" to be asked out loud, in a diff,
-- rather than answered by accident in application code.

-- ── The validator ────────────────────────────────────────────
create or replace function public.jsonb_keys_allowed(v jsonb, allowed text[])
returns boolean
language sql
immutable
parallel safe
set search_path = ''
as $$
  select v is not null
     and jsonb_typeof(v) = 'object'
     and not exists (
       select 1 from jsonb_object_keys(v) as k where k <> all (allowed)
     );
$$;

comment on function public.jsonb_keys_allowed(jsonb, text[]) is
  'Key allowlist for jsonb columns — adding a key must be a migration, not an accident.';

-- ── posts.details ────────────────────────────────────────────
--
-- The presentation/extension bag. Everything here is safe for a signed-in stranger to
-- read, because `details` IS granted to authenticated in 0015 — that is the invariant
-- this allowlist exists to hold.
--
-- Note what is deliberately absent: anything identifying. No contributor name, no
-- contact, no device identifiers, no original filename (which routinely carries a
-- person's name or a camera serial), and no coordinates of any kind — location has
-- its own column with its own fuzzing trigger, and a second unfuzzed copy hiding in a
-- jsonb blob would defeat 0021 entirely.
alter table public.posts
  add constraint posts_details_keys
  check (public.jsonb_keys_allowed(details, array[
    'tags',            -- text[]  editorial tags
    'alt_ar',          -- text    accessibility description, Arabic
    'alt_en',          -- text    accessibility description, English
    'source_url',      -- text    public URL this was published at, if any
    'medium',          -- text    'photograph' | 'negative' | 'print' | 'born-digital'
    'condition',       -- text    physical condition of the original
    'transcript_ar',   -- text    voice note transcript
    'transcript_en'
  ]));

-- ── posts.consent ────────────────────────────────────────────
--
-- §7: "Provenance and consent captured at upload, including the right to withdraw and
-- a per-item license."
--
-- consent is NOT granted to authenticated in 0015 — it is reachable only through
-- posts_full(), by the author or a moderator. The allowlist here is therefore about
-- shape rather than exposure: it stops the column becoming an untyped dumping ground
-- whose meaning nobody can reconstruct in five years, which for an archive is its own
-- kind of failure.
alter table public.posts
  add constraint posts_consent_keys
  check (public.jsonb_keys_allowed(consent, array[
    'granted',         -- bool  the contributor affirmed they may share this
    'granted_at',      -- text  ISO timestamp of the affirmation
    'rights_holder',   -- text  who holds the rights, if not the contributor
    'may_withdraw',    -- bool  §7 right to withdraw, acknowledged
    'depicts_people',  -- bool  drives extra care on faces and voices
    'note'             -- text  free text, the escape hatch of last resort
  ]));

-- ── Size ceilings ────────────────────────────────────────────
--
-- An allowlist bounds the KEYS, not the volume — 'note' could hold ten megabytes.
--
-- octet_length, not length. length() counts CHARACTERS, and Arabic is 2 bytes per
-- character in UTF-8 (3 for the presentation forms NFKC folds away) — so a limit of
-- 8192 "length" would have meant ~16-24 KB of actual storage for Arabic content and
-- 8 KB for English. A ceiling whose real value depends on which language the
-- contributor writes in is not a ceiling. These numbers now mean bytes in both.
--
-- pg_column_size() would be the most accurate measure of storage but is not
-- immutable, and a CHECK constraint requires one that is.
alter table public.posts
  add constraint posts_details_size check (octet_length(details::text) <= 8192),
  add constraint posts_consent_size check (octet_length(consent::text) <= 4096);

-- ── profiles.visibility ──────────────────────────────────────
-- Already validated by is_valid_visibility() in 0002, which pins both the exact key
-- set and the permitted values. Listed here so the audit of "every jsonb column in
-- the schema" is complete rather than merely appearing complete.
--
-- The remaining jsonb columns are audit_log.before / audit_log.after. Those are
-- deliberately unconstrained: they are snapshots of whatever a row looked like, they
-- are written only by SECURITY DEFINER triggers, and they are readable only by an
-- admin. Constraining them would mean a schema change could make an old audit row
-- unwritable — and §3 says audit rows are permanent.
