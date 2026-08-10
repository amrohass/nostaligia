-- 0003 · Enums
--
-- Every value here comes from CLAUDE.md §3/§4/§6. Where CLAUDE.md did not enumerate
-- a vocabulary (moderation action names, audit target names) the column stays `text`
-- rather than inventing an enum that a later milestone would have to migrate.

-- ── Authorization ────────────────────────────────────────────
-- The three roles of §4. Note app_role and author_label carry identical *values* but
-- are deliberately DIFFERENT types: one decides what you may do, the other is a
-- display badge on a post. Keeping them distinct means no policy can ever be written
-- against a label by mistake.
create type public.app_role as enum ('member', 'moderator', 'admin');

create type public.author_label as enum ('member', 'moderator', 'admin');

-- ── Posts ────────────────────────────────────────────────────
create type public.post_kind as enum ('media', 'voice', 'event');

create type public.post_status as enum ('pending', 'approved', 'rejected', 'withdrawn');

-- EDTF-lite (§3): heritage photos are "sometime in the 60s". A post carries a date
-- RANGE plus how precisely that range is known — never a forced single date.
create type public.date_precision as enum ('day', 'month', 'year', 'decade', 'circa');

-- §7: fuzzing is default-on. 'hidden' publishes no coordinates at all.
create type public.location_precision as enum ('exact', 'street', 'area', 'hidden');

create type public.location_source as enum ('user', 'admin');

-- ── Media ────────────────────────────────────────────────────
create type public.media_role as enum ('master', 'rendition', 'thumb', 'poster');

-- The delivery ladder of §6. 2160p exists in the type because a master may be 4K —
-- but 4K is never a *rendition*: it is the archival original and is not streamed.
create type public.media_rendition as enum ('2160p', '1440p', '1080p', '720p', '480p');

-- `quarantine` is intentionally absent: nothing in quarantine has a row yet. A
-- media_assets row exists only once processing has placed the object in its
-- final bucket.
create type public.media_bucket as enum ('originals', 'public');

-- ── Engagement & governance ──────────────────────────────────
-- 'pending' is the default for new comments — pre-moderation, per your decision.
create type public.comment_status as enum ('pending', 'published', 'hidden', 'removed');

create type public.report_status as enum ('open', 'reviewing', 'closed');

create type public.report_target as enum ('post', 'comment', 'profile');

-- Moderators also act on reports themselves (closing them), which is why this is a
-- superset of report_target rather than the same type.
create type public.moderation_target as enum ('post', 'comment', 'profile', 'report');
