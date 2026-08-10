-- 0019 · RLS — comments, likes, saves
--
-- §1: "Browsing is open; all engagement requires sign-in." Everything here is
-- authenticated-only, and anon holds no grant on any of it.

-- ── comments ─────────────────────────────────────────────────
-- Published comments on published posts are visible to any signed-in user; your own
-- are always visible to you, whatever their status, so "awaiting review" is honest
-- rather than a comment that appears to have vanished. Moderators see everything,
-- for the same reason they see the post queue.
create policy comments_select on public.comments
  for select to authenticated
  using (
       public.is_moderator()
    or created_by = (select auth.uid())
    or (
         status = 'published'
         and exists (
           select 1 from public.posts p
           where p.id = comments.post_id
             and p.status = 'approved'
             and not p.takedown
         )
       )
  );

-- You may only comment on something actually published — not on a pending item you
-- happen to be able to see because you wrote it, and not on a taken-down one.
-- created_by and status are stamped by trigger (0014) and are not in the grant.
create policy comments_insert on public.comments
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and created_by = (select auth.uid())
    and status = 'pending'
    and exists (
      select 1 from public.posts p
      where p.id = comments.post_id
        and p.status = 'approved'
        and not p.takedown
    )
  );

-- An author may fix their own comment while it is still in the queue. Once it is
-- published, editing is a moderator action — otherwise "reviewed before it appears"
-- means nothing, because the text could change afterwards.
--
-- The WITH CHECK is what stops a member self-publishing: `status` is in the UPDATE
-- grant (it has to be — moderators are `authenticated` too), so this clause is the
-- only thing between a member and status = 'published'.
create policy comments_update on public.comments
  for update to authenticated
  using (
       public.is_moderator()
    or (created_by = (select auth.uid()) and status = 'pending')
  )
  with check (
       public.is_moderator()
    or (created_by = (select auth.uid()) and status = 'pending')
  );

-- No DELETE. §4's "view / delete comments" is served by status='removed', so the
-- moderation record survives the removal.

-- ── likes ────────────────────────────────────────────────────
-- Owner-only reads. Counts are public information and come from
-- public.post_like_count() or from shards; WHO liked WHAT is the correlation §7
-- warns about, and nothing needs it. Moderators are deliberately NOT given a read
-- here — reviewing content does not require knowing who liked it.
create policy likes_select on public.likes
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy likes_insert on public.likes
  for insert to authenticated
  with check (
        user_id = (select auth.uid())
    and exists (
      select 1 from public.posts p
      where p.id = likes.post_id and p.status = 'approved' and not p.takedown
    )
  );

-- Unliking is a delete, and only of your own row.
create policy likes_delete on public.likes
  for delete to authenticated
  using (user_id = (select auth.uid()));

-- No UPDATE: a like has nothing to change. Absence here is intentional.

-- ── saves ────────────────────────────────────────────────────
-- Strictly private, including from moderators. What someone bookmarked is a profile
-- of their interests, and in this archive that is political information about them.
create policy saves_select on public.saves
  for select to authenticated
  using (user_id = (select auth.uid()));

create policy saves_insert on public.saves
  for insert to authenticated
  with check (
        user_id = (select auth.uid())
    and exists (
      select 1 from public.posts p
      where p.id = saves.post_id and p.status = 'approved' and not p.takedown
    )
  );

create policy saves_delete on public.saves
  for delete to authenticated
  using (user_id = (select auth.uid()));
