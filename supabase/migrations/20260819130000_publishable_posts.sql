-- 0035 · What is publishable, decided in SQL
--
-- The publisher needs every approved post with its media, its author, its place and its
-- baked counters. This is that query, and it lives here rather than in the Edge Function
-- for one reason: the predicate for "may the public see this" already exists in 0018's RLS
-- policies, and a second copy written in TypeScript is a second copy that can disagree.
-- When it disagrees, one of two things ships — a post the policies hide, or a hole in the
-- archive nobody can explain — and neither announces itself.
--
-- ── The three conditions, and why ingest_state is one ────────
--
--   status = 'approved'      a moderator decided
--   takedown = false         §8: a takedown is effective immediately and does not wait
--                            for the publish cycle. The bytes are already gone; this stops
--                            the NEXT release re-listing an item whose media 404s.
--   ingest_state = 'ready'   the same pairing 0025 introduced and 15_moderation_queue
--                            pins. An approved post whose transcode never finished has no
--                            derivatives, so publishing it means a card with a broken
--                            image on the front page.
--
-- ── §5's hash check ──────────────────────────────────────────
--
-- "Record content_hash at approval; the publisher refuses rows whose hash ≠ approved hash."
--
-- This function does NOT filter those rows out. It returns them with hash_matches=false and
-- lets the publisher drop them, because a row that silently vanishes from the archive is
-- indistinguishable from one that was never approved — and the case this guards against is
-- content being altered after approval, which is precisely the case somebody needs to be
-- told about rather than quietly protected from.
--
-- ── §7, and what this function does NOT do ───────────────────
--
-- It returns location_public, never location. It returns created_on, never created_at. It
-- returns the author's handle, never their user id.
--
-- That is belt and braces, not the guarantee: shards.ts builds every public shape from an
-- allowlist and its tests scan the emitted bytes for sentinels. Two independent layers,
-- deliberately, because this one is a query somebody will edit to add a field and that one
-- is a gate that fails when they do.

set search_path = public, extensions;

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

      -- §7: the fuzzed point. `location` is not selected anywhere in this function, and
      -- 0021 derives this one by trigger so it cannot be written directly.
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

      -- §7: "handle is user-chosen, NOT a legal name" and is always public. The user id is
      -- not selected — it is the key that joins a contributor's whole history together.
      'author_handle',       pr.handle,
      'author_display_name', pr.display_name,
      'author_avatar_path',  pr.avatar_path,

      -- §2/D20: counters baked at publish time, so a reader never touches the database.
      -- Only PUBLISHED comments count; a pending or hidden one contributing to a visible
      -- number would leak the existence of moderation activity on an item.
      'like_count',    (select count(*) from public.likes l where l.post_id = p.id),
      'comment_count', (select count(*) from public.comments c
                         where c.post_id = p.id and c.status = 'published'),

      -- §7: day precision, from the generated column that exists so nobody has to remember.
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

      -- §5. Returned, not filtered — see the header.
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

-- ── The redaction list ───────────────────────────────────────
--
-- §8: "add the ID to the short-TTL redactions.json that clients filter against". Piece 4
-- owns the takedown path; this is only the read side, and it is here rather than there
-- because the publisher writes redactions.json into every release as well — a client that
-- fetched a release and no redaction list would show a taken-down item until the short-TTL
-- file at the root happened to load.
create or replace function public.redacted_post_ids()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(jsonb_agg(p.id order by p.id), '[]'::jsonb)
  from public.posts p
  where p.takedown = true;
$$;

comment on function public.redacted_post_ids() is
  'Post ids the client must filter out regardless of what a cached release says (CLAUDE.md §8).';

-- ── Grants ───────────────────────────────────────────────────
--
-- publishable_posts is SECURITY DEFINER and returns approved content joined to author
-- handles and baked counters. Nothing about it is secret, but it is also not a browser
-- endpoint: §2's whole read path is "zero database reads for public visitors", and an RPC
-- that returns the entire archive in one call is the most attractive possible way to
-- violate that by accident. The publisher runs with the service key.

revoke execute on function public.publishable_posts()   from public, anon, authenticated;
revoke execute on function public.redacted_post_ids()    from public, anon, authenticated;
grant  execute on function public.publishable_posts()    to service_role;
grant  execute on function public.redacted_post_ids()    to service_role;
