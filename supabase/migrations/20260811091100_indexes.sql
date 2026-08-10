-- 0011 · Indexes
--
-- Sized for the queries this system actually runs. §2 is explicit that public
-- visitors cause ZERO database reads — they hit static shards on the CDN — so none
-- of these serve the public feed directly. They serve:
--
--   · the PUBLISHER, walking changed rows to rebuild shards (§2)
--   · the MODERATION QUEUE in admin.js (§4)
--   · the MAP and decade slider at publish time (M4)
--   · profile pages, which read a member's own contributions
--
-- Most are partial. At ~300 items on launch and low thousands within a year the
-- planner would often seq-scan anyway; these matter for the moderation and publish
-- paths, which run constantly and filter narrowly.

set search_path = public, extensions;

-- ── posts: the published set ─────────────────────────────────
-- The predicate `status = 'approved' and not takedown` is the definition of
-- "publishable", and it repeats on every publisher query, so it is the partial
-- predicate throughout.
create index posts_published_recent_idx
  on public.posts (created_at desc)
  where status = 'approved' and not takedown;

create index posts_published_decade_idx
  on public.posts (decade)
  where status = 'approved' and not takedown;

create index posts_published_kind_idx
  on public.posts (kind, created_at desc)
  where status = 'approved' and not takedown;

create index posts_published_place_idx
  on public.posts (place_id)
  where status = 'approved' and not takedown and place_id is not null;

-- Upcoming events for the events surface.
create index posts_published_events_idx
  on public.posts (event_starts_at)
  where status = 'approved' and not takedown and kind = 'event';

-- ── posts: moderation and ownership ──────────────────────────
-- The queue: oldest first, which is how the existing dashboard sorts it.
create index posts_moderation_queue_idx
  on public.posts (created_at)
  where status = 'pending';

-- "My contributions" on a profile, and the per-user daily quota check.
create index posts_created_by_idx
  on public.posts (created_by, created_at desc);

-- Takedown sweep (§8) — small and hot during an incident.
create index posts_takedown_idx
  on public.posts (updated_at desc)
  where takedown;

-- ── Geo (§2 — PostGIS is the source of truth) ────────────────
-- location_public is what the publisher reads and shards. It is indexed first
-- because it is the one used in anger.
create index posts_location_public_gix
  on public.posts using gist (location_public);

-- Raw location is indexed for moderator-side review only. It is never published.
create index posts_location_gix
  on public.posts using gist (location);

create index places_location_gix
  on public.places using gist (location);

-- Gazetteer autocomplete resolves against names and aliases (M4).
create index places_aliases_gin
  on public.places using gin (aliases);

-- ── media ────────────────────────────────────────────────────
-- Assembling one post's assets: the ladder in sort order, filtered by role.
create index media_assets_post_idx
  on public.media_assets (post_id, role, sort_order);

-- ── engagement ───────────────────────────────────────────────
create index comments_published_idx
  on public.comments (post_id, created_at desc)
  where status = 'published';

-- The comment moderation queue. Comments default to 'pending', so this is the
-- working list, not an edge case.
create index comments_moderation_queue_idx
  on public.comments (created_at)
  where status = 'pending';

create index comments_created_by_idx
  on public.comments (created_by, created_at desc);

-- Like counts are baked into shards at publish time (§10, M2), which is this scan.
create index likes_post_idx
  on public.likes (post_id);

create index saves_user_idx
  on public.saves (user_id, created_at desc);

-- ── governance ───────────────────────────────────────────────
create index reports_open_idx
  on public.reports (created_at)
  where status <> 'closed';

create index reports_target_idx
  on public.reports (target_type, target_id);

create index moderation_actions_target_idx
  on public.moderation_actions (target_type, target_id, created_at desc);

create index moderation_actions_actor_idx
  on public.moderation_actions (actor, created_at desc);

-- Grant reporting reads by target and by actor; both are named in §3's rationale
-- for keeping audit rows permanently.
create index audit_log_target_idx
  on public.audit_log (target_type, target_id, created_at desc);

create index audit_log_actor_idx
  on public.audit_log (actor, created_at desc);
