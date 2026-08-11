-- 0023 · Fix: media_assets was unreadable by every browser role
--
-- FOUND BY the 4x15x4 authorization matrix. `select count(*) from media_assets`
-- returned `permission denied for table posts` (42501) for member, moderator AND
-- admin alike — not "no rows", an outright refusal.
--
-- THE RULE, which is worth writing down because it is not obvious and it silently
-- shaped this schema:
--
--   An RLS policy expression that references ITS OWN table's columns needs no
--   privilege on them — posts_select reads posts.created_by happily, even though
--   created_by is withheld from every browser role by 0015.
--
--   An RLS policy expression that references ANOTHER table's columns is evaluated
--   with the CALLER's privileges on that other table. media_assets_select did
--   `exists (select 1 from public.posts p where ... p.created_by = auth.uid())`,
--   and created_by is not granted — so the policy could not be evaluated at all, and
--   every read of media_assets failed.
--
-- Only this one policy was affected. The others that cross tables — comments_select,
-- comments_insert, likes_insert, saves_insert — reference only posts.id, .status and
-- .takedown, all of which ARE granted. Verified in the matrix: those cells allow.
--
-- The failure mode is the dangerous kind: it looks like RLS working. A deny is what
-- a denial matrix is written to see, so a suite could report this cell "correctly
-- denied" and be measuring a broken policy rather than a working one. It would have
-- surfaced in M3 as "images never load", three milestones from its cause.

-- The check moves into a SECURITY DEFINER function so the policy stops dereferencing
-- columns the caller cannot read. The definer boundary is exactly as wide as the
-- predicate it replaces — it answers one boolean about one post id and returns no
-- data at all.
create or replace function public.can_read_post_media(
  p_post_id uuid,
  p_bucket  public.media_bucket
)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.posts p
    where p.id = p_post_id
      and (
           -- a published item, delivery bucket only
           (p.status = 'approved' and not p.takedown and p_bucket = 'public')
           -- your own material, including the master in originals/
        or p.created_by = (select auth.uid())
           -- review
        or public.is_moderator()
      )
  );
$$;

comment on function public.can_read_post_media(uuid, public.media_bucket) is
  'Media follows its post visibility; originals/ stays with author and moderators (§6).';

revoke execute on function public.can_read_post_media(uuid, public.media_bucket) from public, anon;
grant  execute on function public.can_read_post_media(uuid, public.media_bucket) to authenticated, service_role;

drop policy media_assets_select on public.media_assets;

create policy media_assets_select on public.media_assets
  for select to authenticated
  using (public.can_read_post_media(post_id, bucket));
