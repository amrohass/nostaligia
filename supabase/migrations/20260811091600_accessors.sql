-- 0016 · Accessors — the narrow paths back to withheld columns
--
-- 0015 withheld columns that a column grant cannot express conditionally, because
-- `moderator` and `admin` are not database roles and `visibility` is per-row. Each
-- function below restores exactly one of those, with the condition in its body.
--
-- Every one is SECURITY DEFINER, which means the WHERE clause IS the security
-- boundary — there is no RLS behind it to catch a mistake. They are deliberately
-- short for that reason. Each has a matching denial test.

set search_path = public, extensions;

-- ── posts: the full row, for those entitled to it ────────────
--
-- Serves both "my contributions" and the moderation queue, because the entitlement
-- is the same sentence: your own, or everything if you moderate. A moderator's own
-- pending submission matches both halves and looks identical either way — which is
-- the answer to "what does a moderator's own pending post look like to them".
--
-- The auth.uid() IS NOT NULL guard is not redundant. Without it, a signed-out caller
-- would compare created_by to NULL — and rows whose author has since deleted their
-- account have created_by IS NULL. `= NULL` never matches, so the guard is belt and
-- braces, but it is the kind of belt worth wearing on a definer function.
create or replace function public.posts_full()
returns setof public.posts
language sql
stable
security definer
set search_path = ''
as $$
  select p.*
  from public.posts p
  where (select auth.uid()) is not null
    and (p.created_by = (select auth.uid()) or public.is_moderator());
$$;

comment on function public.posts_full() is
  'Own posts, or everything for a moderator. The only path to location, consent and created_by.';

revoke execute on function public.posts_full() from public, anon;
grant  execute on function public.posts_full() to authenticated, service_role;

-- ── profiles: visibility-aware ───────────────────────────────
--
-- §7 in one function. Handle, display name, avatar and role badge are always
-- returned — they are how attribution stays intact. Bio comes back only when its
-- visibility says public, or the caller owns the profile, or the caller moderates.
-- `member_since` is a YEAR: the existing UI only ever rendered "Member since ٢٠٢٤",
-- and a year cannot be correlated with anything.
--
-- Granted to anon as well. That is not a widening — a controlled accessor that
-- honours the visibility map is strictly safer than the table grant it replaces.
create or replace function public.profile_view(p_handle text)
returns table (
  id            uuid,
  handle        text,
  display_name  text,
  avatar_path   text,
  role_cache    public.app_role,
  bio           text,
  visibility    jsonb,
  member_since  integer,
  is_own        boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    p.id,
    p.handle,
    p.display_name,
    p.avatar_path,
    p.role_cache,
    case
      when p.id = (select auth.uid()) then p.bio
      when public.is_moderator()      then p.bio
      when p.visibility ->> 'bio' = 'public' then p.bio
      else null
    end as bio,
    case
      when p.id = (select auth.uid()) or public.is_moderator() then p.visibility
      else null
    end as visibility,
    extract(year from p.created_at)::integer as member_since,
    -- coalesce is not decoration, for the same reason as in is_moderator(): for a
    -- signed-out caller auth.uid() is NULL, so `p.id = NULL` is NULL rather than
    -- false. A NULL here is falsy in JavaScript so the UI would look right, but
    -- `not is_own` is ALSO falsy on NULL — anything negating this would conclude the
    -- profile belongs to the caller. Caught by an assertion that expected false and
    -- got NULL.
    coalesce(p.id = (select auth.uid()), false) as is_own
  from public.profiles p
  where public.normalized_handle(p.handle) = public.normalized_handle(p_handle);
$$;

comment on function public.profile_view(text) is
  'CLAUDE.md §7 — handle and avatar always public, everything else per visibility.';

revoke execute on function public.profile_view(text) from public;
grant  execute on function public.profile_view(text) to anon, authenticated, service_role;

-- ── content_blocks: drafts, for admins ───────────────────────
-- §4 makes editing site copy admin-only, so reading unpublished copy is too.
create or replace function public.content_blocks_draft()
returns setof public.content_blocks
language sql
stable
security definer
set search_path = ''
as $$
  select c.* from public.content_blocks c where public.is_admin();
$$;

comment on function public.content_blocks_draft() is
  'Unpublished editorial copy. Admin only (CLAUDE.md §4).';

revoke execute on function public.content_blocks_draft() from public, anon;
grant  execute on function public.content_blocks_draft() to authenticated, service_role;

-- ── posts: like counts without reading likes ─────────────────
--
-- 0015 restricts `likes` to its owner, because "who liked what" is exactly the
-- correlation §7 warns about. Counts are still public information, and are baked
-- into shards at publish time — this is the same number for anything that needs it
-- before a publish runs, computed without exposing a single row.
create or replace function public.post_like_count(p_post_id uuid)
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select count(*)::integer
  from public.likes l
  join public.posts p on p.id = l.post_id
  where l.post_id = p_post_id
    and p.status = 'approved'
    and not p.takedown;
$$;

revoke execute on function public.post_like_count(uuid) from public;
grant  execute on function public.post_like_count(uuid) to anon, authenticated, service_role;
