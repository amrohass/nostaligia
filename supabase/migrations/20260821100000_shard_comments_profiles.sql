-- 0044 · Comments and profiles reach the read path
--
-- §9 names them both: "Page copy, cards, events, comments, and the info page all read from
-- content_blocks/shards." §2 is what makes that a requirement rather than a preference —
-- "zero database reads for public visitors" — and 0015 grants `anon` SELECT on nothing at
-- all, so a comment a visitor cannot fetch from a shard is a comment they cannot read.
--
-- Until now the item shard carried `comment_count` and no bodies, and there was no profile
-- shard at all. This file adds both to the publisher's read side.
--
-- ── The comment trigger has to split ─────────────────────────
--
-- 0037 put `comments` on the COUNTER branch, and that was right when a comment only ever
-- moved a number. Now a comment's TEXT is in the release, and the counter branch is the
-- throttled one (§6's one-hour floor) which 0042 additionally made non-dispatching. Leaving
-- it there would mean a moderator publishing a comment changes the archive and asks for
-- nothing — the comment would appear whenever some unrelated content change happened to
-- publish, which on a quiet week is days.
--
-- So the branch follows the same rule 0037 wrote for posts: what a shard carries decides.
--
--   status = 'published' involved   content. A moderator's decision, and rare.
--   anything else                   counter. A member posting into the queue, or editing
--                                   text nobody can see yet. Changes no published byte.
--
-- The volume argument that kept likes on the counter branch is untouched: a like still
-- bumps a number and dispatches nothing.

set search_path = public, extensions;

-- ── publishable_posts, now carrying the comments ─────────────
--
-- Replaced, not edited: 0035 is its only definition (grepped, per the trap that cost two
-- silent reverts in M1). The body below is 0035's with one key added to the built object.
--
-- §7 in the comment shape, and it is the same allowlist argument shards.ts makes: the
-- commenter is named by HANDLE and never by created_by, the timestamp is created_on and
-- never created_at, and `status` does not travel because a published comment is the only
-- kind that is here at all.
create or replace function public.publishable_posts()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(item order by item ->> 'created_on' desc, item ->> 'id'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'id',              p.id,
      'kind',            p.kind,
      'title_ar',        p.title_ar,
      'title_en',        p.title_en,
      'body_ar',         p.body_ar,
      'body_en',         p.body_en,
      'date_earliest',   p.date_earliest,
      'date_latest',     p.date_latest,
      'date_precision',  p.date_precision,
      'decade',          p.decade,

      'location_public',
        case when p.location_public is null then null
             else jsonb_build_object(
               'lat', extensions.st_y(p.location_public::extensions.geometry),
               'lon', extensions.st_x(p.location_public::extensions.geometry))
        end,
      'location_precision', p.location_precision,
      'place_name_ar',   pl.name_ar,
      'place_name_en',   pl.name_en,

      'event_starts_at', p.event_starts_at,
      'event_ends_at',   p.event_ends_at,
      'venue_ar',        p.venue_ar,
      'venue_en',        p.venue_en,
      'license',         p.license,
      'provenance',      p.provenance,
      'author_label',    p.author_label,

      'author_handle',       pr.handle,
      'author_display_name', pr.display_name,
      'author_avatar_path',  pr.avatar_path,

      'like_count',    (select count(*) from public.likes l where l.post_id = p.id),
      'comment_count', (select count(*) from public.comments c
                         where c.post_id = p.id and c.status = 'published'),

      -- The bodies. Only 'published' — a pending comment reaching a shard would publish
      -- unreviewed text, and a 'hidden' or 'removed' one would un-moderate a decision
      -- somebody made. Ordered so the shard bytes are stable across rebuilds; an unstable
      -- order would rewrite every item shard on every publish.
      'comments', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'id',                  c.id,
                 'body',                c.body,
                 'lang',                c.lang,
                 'day',                 c.created_on,
                 'author_handle',       cpr.handle,
                 'author_display_name', cpr.display_name,
                 'author_avatar_path',  cpr.avatar_path)
               order by c.created_on, c.id)
          from public.comments c
          left join public.profiles cpr on cpr.id = c.created_by
         where c.post_id = p.id and c.status = 'published'), '[]'::jsonb),

      'created_on',    p.created_on,

      'media', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'role',         m.role,
                 'rendition',    m.rendition,
                 'storage_path', m.storage_path,
                 'bucket',       m.bucket,
                 'mime',         m.mime,
                 'width',        m.width,
                 'height',       m.height,
                 'duration_s',   m.duration_s)
               order by m.role, m.rendition, m.storage_path)
          from public.media_assets m where m.post_id = p.id), '[]'::jsonb),

      'content_hash',  p.content_hash,
      'hash_matches',  p.content_hash is not distinct from public.post_content_hash(p.*)
    ) as item
    from public.posts p
    left join public.places   pl on pl.id = p.place_id
    left join public.profiles pr on pr.id = p.created_by
    where p.status = 'approved'
      and p.takedown = false
      and p.ingest_state = 'ready'
  ) rows;
$$;

comment on function public.publishable_posts() is
  'Everything the publisher needs, with §5''s hash check reported rather than applied (CLAUDE.md §2, §5, §7).';

revoke execute on function public.publishable_posts() from public, anon, authenticated;
grant  execute on function public.publishable_posts() to service_role;

-- ── The profiles a shard may name ────────────────────────────
--
-- §7, applied to a file served to everyone for a year: "handle is user-chosen and mandatory;
-- avatar is mandatory but defaults to a generated avatar. Handle and avatar are always
-- public. Everything else on a profile (bio, contributions, comments) is governed by
-- profiles.visibility."
--
-- So a profile shard is the PUBLIC projection and nothing else. `bio` is null unless its
-- visibility says public; the two list flags travel as booleans so the publisher can decide
-- whether to build the lists at all. The owner's own view — the private fields, the pending
-- contributions — is profile_view() and posts_full() with the owner's token, and is
-- deliberately not derivable from anything here.
--
-- What is absent: the user id (the join key §7 names as the de-anonymisation vector),
-- created_at (member_since is a YEAR, following 0016), visibility itself ("what this person
-- chose to hide" is not public information), and email, which this schema does not have.
--
-- ── Why only contributors ────────────────────────────────────
--
-- One shard per profile, for tens of thousands of accounts, would be tens of thousands of
-- objects rewritten on every release — and §2's incremental diff is deferred (19 Aug). A
-- profile with nothing published has no page anyone can arrive at by browsing, and its owner
-- reaches their own through profile_view(). So the set is bounded by the archive: anyone who
-- authored an item that is actually in the release, or a comment that is.
create or replace function public.publishable_profiles()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(item order by item ->> 'handle'), '[]'::jsonb)
  from (
    select jsonb_build_object(
      'handle',       pr.handle,
      'display_name', pr.display_name,
      'avatar_path',  pr.avatar_path,
      -- Display only, and named `label` rather than `role` so nothing downstream is tempted
      -- to read it as authorization. §4: role_cache "must never be trusted for
      -- authorization" — a static JSON file even less so.
      'label',        pr.role_cache,
      'bio',          case when pr.visibility ->> 'bio' = 'public' then pr.bio end,
      'member_since', extract(year from pr.created_at)::integer,
      'show_contributions', coalesce(pr.visibility ->> 'contributions', 'public') = 'public',
      'show_comments',      coalesce(pr.visibility ->> 'comments', 'public') = 'public'
    ) as item
    from public.profiles pr
    where exists (
            select 1 from public.posts p
             where p.created_by = pr.id
               and p.status = 'approved' and not p.takedown and p.ingest_state = 'ready')
       or exists (
            select 1 from public.comments c
              join public.posts p2 on p2.id = c.post_id
             where c.created_by = pr.id
               and c.status = 'published'
               and p2.status = 'approved' and not p2.takedown and p2.ingest_state = 'ready')
  ) rows;
$$;

comment on function public.publishable_profiles() is
  'The public projection of every profile the archive names — CLAUDE.md §7.';

revoke execute on function public.publishable_profiles() from public, anon, authenticated;
grant  execute on function public.publishable_profiles() to service_role;

-- ── The comment signal, split by what a shard carries ────────
--
-- 0037's single trigger covered insert, update and delete on the counter branch. It is
-- dropped and replaced by four, mirroring the shape 0037 already uses on `posts`: a WHEN
-- clause per transition, because a trigger handling both INSERT and DELETE may not reference
-- NEW or OLD in its WHEN clause.
drop trigger if exists comments_bump_publish_revision on public.comments;

-- A member posting into the moderation queue. Changes no published byte, and must not send
-- an HTTP request from inside the database on an ordinary member's write (0042's rule).
create trigger comments_bump_counter_insert
  after insert on public.comments
  for each row when (new.status <> 'published')
  execute function public.bump_publish_revision('counter');

-- Present for completeness rather than for the browser: policy 0019 forbids a member
-- inserting anything but 'pending', so this fires only for the service role — the importer,
-- or a repair script. If it ever fires, the text IS in the next release and the archive has
-- to be asked for one.
create trigger comments_bump_content_insert
  after insert on public.comments
  for each row when (new.status = 'published')
  execute function public.bump_publish_revision('content');

-- The moderator's decision, in both directions: publishing a pending comment, and hiding or
-- removing a published one. Also an edit to a published comment's body, which changes the
-- bytes without changing the status.
create trigger comments_bump_content_update
  after update on public.comments
  for each row when (old.status = 'published' or new.status = 'published')
  execute function public.bump_publish_revision('content');

-- An update between two non-published states — an author fixing their own pending comment.
-- Counter, for the same reason as the insert.
create trigger comments_bump_counter_update
  after update on public.comments
  for each row when (old.status <> 'published' and new.status <> 'published')
  execute function public.bump_publish_revision('counter');

-- 0019 writes no DELETE policy and 0015 grants no DELETE, so this is the service role or a
-- cascade from a deleted post. Either way a published body leaves the archive.
create trigger comments_bump_content_delete
  after delete on public.comments
  for each row when (old.status = 'published')
  execute function public.bump_publish_revision('content');

create trigger comments_bump_counter_delete
  after delete on public.comments
  for each row when (old.status <> 'published')
  execute function public.bump_publish_revision('counter');
