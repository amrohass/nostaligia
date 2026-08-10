-- 0015 · Column privileges — the whole model, in one file
--
-- WHY THIS FILE EXISTS
--
-- RLS is row-level. §7's threat model is columnar. If a caller can read a row, RLS
-- hands them every column of it — so `select location, created_by, created_at from
-- posts where status = 'approved'` returns precise coordinates, the author→post
-- mapping and exact submission times in ONE request. §7 names that exact aggregate
-- as the de-anonymization vector. §2's shard design hides it from the website;
-- PostgREST does not care about the website, and §5 says to assume the attacker has
-- the anon key and a free account.
--
-- Everything below restates privileges from `revoke all`, deliberately. A delta
-- would be easier to read and impossible to audit; this way the file IS the model,
-- and a column added later is denied until someone names it here.
--
-- THE PRINCIPLE, applied uniformly:
--
--   anon           SELECT on nothing. §2 already says public visitors cause zero
--                  database reads — the grant was never load-bearing, and removing
--                  it closes the class rather than patching column by column. A
--                  column added in M4 cannot leak by being forgotten.
--   authenticated  SELECT on what is safe for any signed-in STRANGER — because
--                  moderator and admin are not database roles, and a column grant
--                  binds every signed-in user identically.
--   narrower       Owner-only fields, moderator views and visibility-gated fields go
--                  through the SECURITY DEFINER accessors in 0016.
--
-- Write privileges follow the same rule: a column that must not be forgeable is not
-- granted, and a trigger sets it (0014). approved_by, content_hash, created_by and
-- author_label are unwritable from a browser by any role.

-- ── profiles ─────────────────────────────────────────────────
-- §7: "Handle and avatar are always public. Everything else on a profile (bio,
-- contributions, comments) is governed by profiles.visibility."
--
-- `bio` is therefore NOT grantable: whether it may be read depends on a per-row
-- jsonb value, which a column grant cannot express and RLS cannot express either.
-- It comes back through public.profile_view() in 0016, which reads the visibility
-- map. `visibility` itself is withheld because "what this person chose to hide" is
-- not public information. created_at is withheld under the day-precision rule; the
-- accessor returns a joined YEAR, which is all "Member since ٢٠٢٤" ever needed.
revoke all on public.profiles from anon, authenticated;

grant select (id, handle, display_name, avatar_path, role_cache)
  on public.profiles to authenticated;

grant insert (id, handle, display_name, avatar_path, bio, visibility)
  on public.profiles to authenticated;

grant update (handle, display_name, avatar_path, bio, visibility)
  on public.profiles to authenticated;

-- ── places ───────────────────────────────────────────────────
-- Gazetteer entries are not personal data; the restriction here is uniformity, not
-- secrecy. Public map data reaches visitors through shards.
revoke all on public.places from anon, authenticated;

grant select (id, name_ar, name_en, aliases, location, geohash, unconfirmed)
  on public.places to authenticated;

-- Moderators curate the gazetteer (M4). RLS decides who; this decides what.
grant insert (name_ar, name_en, aliases, location, geohash, unconfirmed)
  on public.places to authenticated;
grant update (name_ar, name_en, aliases, location, geohash, unconfirmed)
  on public.places to authenticated;

-- ── posts ────────────────────────────────────────────────────
-- The four withheld from SELECT, and why each one alone justifies it:
--
--   location      §7 — "Publish location_public, NEVER location." Precise
--                 coordinates for every approved item in one query.
--   created_by    §7 — the author→post mapping, readable even when that member has
--                 marked their contributions private.
--   created_at    §7 — exact submission times. Same correlation vector as
--                 coordinates; created_on carries the day, which is all §7 allows.
--   consent       the contributor's stated relationship to the material, which can
--                 name people who are not users of this site at all.
--
-- Also withheld: approved_by (which moderator approved what is team information),
-- content_hash and updated_at (no browser use case, so no grant).
revoke all on public.posts from anon, authenticated;

grant select (
  id, kind,
  title_ar, title_en, body_ar, body_en,
  date_earliest, date_latest, date_precision, decade,
  location_public, location_precision, location_source, place_id,
  event_starts_at, event_ends_at, venue_ar, venue_en,
  details, status, takedown,
  license, provenance, author_label,
  created_on
) on public.posts to authenticated;

-- created_by, author_label and status are absent: 0014 stamps all three. A member
-- cannot name them in an INSERT, so there is nothing to smuggle.
grant insert (
  kind,
  title_ar, title_en, body_ar, body_en,
  date_earliest, date_latest, date_precision,
  location, location_precision, location_public, location_source, place_id,
  event_starts_at, event_ends_at, venue_ar, venue_en,
  details, license, provenance, consent
) on public.posts to authenticated;

-- status and takedown ARE updatable, because moderators are `authenticated` like
-- everyone else and there is no column grant that can tell them apart. Which
-- transitions are legal is the UPDATE policy's job in 0018. approved_by,
-- approved_at and content_hash remain ungranted: approval attribution is written by
-- trigger and is unforgeable at the privilege layer, for every role.
grant update (
  kind,
  title_ar, title_en, body_ar, body_en,
  date_earliest, date_latest, date_precision,
  location, location_precision, location_public, location_source, place_id,
  event_starts_at, event_ends_at, venue_ar, venue_en,
  details, license, provenance, consent,
  status, takedown
) on public.posts to authenticated;

-- ── media_assets ─────────────────────────────────────────────
-- Rows are filtered by RLS so that `bucket = 'originals'` is visible only to the
-- author and moderators (§6 — originals are restricted and never CDN-fronted).
-- Handing a member the storage_path of a 4 GB master is the first half of the abuse
-- vector §6 describes; the second half is R2's own bucket policy.
revoke all on public.media_assets from anon, authenticated;

grant select (
  id, post_id, role, rendition, storage_path, bucket,
  mime, bytes, width, height, duration_s, bitrate_kbps, sort_order
) on public.media_assets to authenticated;

-- No write grants at all. Rows are created by the processing function under the
-- service role, after magic-byte validation and re-encoding. A browser that can
-- INSERT here can claim an arbitrary storage_path.

-- ── comments ─────────────────────────────────────────────────
-- created_by IS granted here, unlike on posts. The distinction is real and
-- intentional: §7 gates the LIST of your comments on your profile, while a comment
-- under a memory is attributed by design — the existing UI says so in as many words
-- ("They stay visible under each memory"). Attribution is the point of a comment.
revoke all on public.comments from anon, authenticated;

grant select (id, post_id, body, lang, status, created_by, created_on)
  on public.comments to authenticated;

grant insert (post_id, body, lang) on public.comments to authenticated;

-- status is updatable for the same reason as on posts — moderators share the role.
-- The policy in 0019 stops a member publishing their own comment.
grant update (body, lang, status) on public.comments to authenticated;

-- ── likes and saves ──────────────────────────────────────────
-- Both are restricted to their owner by RLS. Like COUNTS are baked into shards at
-- publish time by the service role (§10, M2) — nobody needs to read other people's
-- likes to render a number, and "who liked what" is precisely the correlation §7
-- warns about.
revoke all on public.likes from anon, authenticated;
grant select (user_id, post_id, created_at) on public.likes to authenticated;
grant insert (user_id, post_id) on public.likes to authenticated;
grant delete on public.likes to authenticated;

revoke all on public.saves from anon, authenticated;
grant select (user_id, post_id, created_at) on public.saves to authenticated;
grant insert (user_id, post_id) on public.saves to authenticated;
grant delete on public.saves to authenticated;

-- ── content_blocks ───────────────────────────────────────────
-- `draft` is unpublished editorial copy — a paragraph an editor is still working on,
-- readable by every signed-in user if granted. Only `published` is grantable;
-- admins reach drafts through public.content_blocks_draft() in 0016.
revoke all on public.content_blocks from anon, authenticated;

grant select (key, locale, published, version, updated_at)
  on public.content_blocks to authenticated;

grant insert (key, locale, draft, published) on public.content_blocks to authenticated;
grant update (draft, published, version) on public.content_blocks to authenticated;

-- ── reports ──────────────────────────────────────────────────
-- Rows are restricted by RLS to the reporter and moderators, which is the whole
-- protection: revealing a reporter to the person they reported is how you get
-- retaliation. Within those rows every column is legitimate.
revoke all on public.reports from anon, authenticated;

grant select (id, target_type, target_id, reason, reported_by, status, created_at)
  on public.reports to authenticated;

-- reported_by and status are stamped by trigger (0014).
grant insert (target_type, target_id, reason) on public.reports to authenticated;
grant update (status) on public.reports to authenticated;

-- ── moderation_actions ───────────────────────────────────────
-- Team-readable, never client-written: a moderator who can INSERT here can fabricate
-- a record of someone else's decision.
revoke all on public.moderation_actions from anon, authenticated;

grant select (id, actor, action, target_type, target_id, note, created_at)
  on public.moderation_actions to authenticated;

-- ── audit_log ────────────────────────────────────────────────
-- Admin-readable. Writes are refused for every role by the append-only trigger.
revoke all on public.audit_log from anon, authenticated;

grant select (id, actor, action, target_type, target_id, before, after, created_at)
  on public.audit_log to authenticated;

-- ── Never reachable from a browser ───────────────────────────
-- No grant, no policy, twice-locked. Listed explicitly so the absence is a decision
-- rather than an omission.
revoke all on public.user_roles       from anon, authenticated;  -- who is a moderator
revoke all on public.reserved_handles from anon, authenticated;  -- impersonation targets
revoke all on public.releases         from anon, authenticated;  -- publisher state
revoke all on public.upload_quota     from anon, authenticated;  -- own quota = own ceiling
