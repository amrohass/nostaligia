-- 0018 · RLS — posts, media_assets
--
-- THE READ MATRIX, stated rather than derived:
--
--   viewer            approved+live   own pending   others' pending   own rej/wdn   others' rej/wdn
--   anon              (no grant)      —             —                 —             —
--   member            yes             YES           no                yes           no
--   moderator/admin   yes             yes           YES               yes           yes
--
-- Two of those cells are deliberate decisions rather than consequences:
--
--   · AUTHORS SEE THEIR OWN PENDING WORK, in every status. You cannot ask someone to
--     wait for review and then hide what they submitted. A moderator's own pending
--     submission matches this clause and the moderator clause both, and looks
--     identical either way.
--   · MODERATORS GET A BLANKET READ ON EVERYTHING PENDING. §4 grants approve/reject,
--     which is unimplementable without it — the moderation queue IS "read everything
--     pending". A claim/assignment model would be inventing a workflow CLAUDE.md
--     does not describe. What makes it accountable is that every moderator action is
--     audited, not that the read is narrow.
--
--   · WITHDRAWN CONTENT REMAINS VISIBLE TO MODERATORS. Arguable, and decided
--     deliberately: a withdrawal is a request a human has to service and verify, and
--     hiding it from the only people who can act on it would make the right to
--     withdraw weaker, not stronger. What protects the contributor is that the
--     action is audited.
--
-- Written as ONE policy with an explicit OR rather than three permissive policies,
-- so the whole rule reads in one place and "one policy per table × operation" stays
-- literally true.
create policy posts_select on public.posts
  for select to authenticated
  using (
       (status = 'approved' and not takedown)   -- the published archive
    or (created_by = (select auth.uid()))       -- your own, whatever its state
    or public.is_moderator()                    -- the queue
  );

-- The stamping trigger in 0014 has already forced created_by, status and
-- author_label by the time this runs, and none of the three is in the INSERT grant.
-- The check is kept anyway: two independent mechanisms, so a change to either one
-- cannot open the door alone.
create policy posts_insert on public.posts
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and created_by = (select auth.uid())
    and status = 'pending'
    and not takedown
  );

-- USING decides which rows you may touch; WITH CHECK decides what they may become.
--
-- A member may edit their own submission and may withdraw it. They may NOT move it
-- to 'approved' or 'rejected', and they may not set takedown — those are the two
-- verbs §4 reserves for moderators. Note the edit-after-approval trigger fires
-- underneath: a member editing their own approved post sends it back to pending,
-- which this check permits, and the post leaves the public archive until it is
-- reviewed again. That is the intended behaviour, not a side effect.
create policy posts_update on public.posts
  for update to authenticated
  using (
       created_by = (select auth.uid())
    or public.is_moderator()
  )
  with check (
       public.is_moderator()
    or (
             created_by = (select auth.uid())
         and status in ('pending', 'withdrawn')
         and not takedown
       )
  );

-- No DELETE policy and no DELETE grant, for anyone. §4's "delete content" is served
-- by status='rejected' plus takedown, so what was removed — and by whom — survives.

-- ── media_assets ─────────────────────────────────────────────
--
-- Media follows its post's visibility, with one extra restriction: rows in the
-- `originals` bucket are visible only to the author and to moderators. §6 makes
-- originals restricted and never CDN-fronted, and the storage_path of a multi-gigabyte
-- master is the first half of the abuse vector §6 describes.
create policy media_assets_select on public.media_assets
  for select to authenticated
  using (
    exists (
      select 1
      from public.posts p
      where p.id = media_assets.post_id
        and (
             -- published item, delivery bucket only
             (p.status = 'approved' and not p.takedown and media_assets.bucket = 'public')
             -- your own material, including the master
          or p.created_by = (select auth.uid())
          or public.is_moderator()
        )
    )
  );

-- No write policies and no write grants. Rows here are created by the processing
-- function under the service role, after magic-byte validation and re-encoding
-- (§6). A browser that can INSERT can claim an arbitrary storage_path — including
-- one in `originals` — and the CHECK constraints would happily accept it.
