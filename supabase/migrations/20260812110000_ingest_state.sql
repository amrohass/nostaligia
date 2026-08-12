-- 0025 · Ingest state — the gap between "a URL was signed" and "media exists"
--
-- request-upload hands out a presigned URL. Between that moment and the moment a
-- processed derivative exists there is a window in which a posts row is real but its
-- media is not: the bytes may still be uploading, may be mid-transcode, may have been
-- refused by the sniffer, or may never arrive at all. Today the schema cannot express
-- any of that, so a half-ingested item is indistinguishable from a finished one and
-- would surface in the moderation queue with nothing to look at.
--
-- ── Why not reuse `status` ───────────────────────────────────
--
-- Because they answer different questions and are decided by different actors. `status`
-- is a HUMAN judgement made by a moderator; ingest_state is a MACHINE fact reported by
-- the worker. Folding an 'uploading' value into post_status would put the worker inside
-- the moderation state machine — every RLS policy and every §5 approval rule would then
-- have to reason about a state no moderator ever chooses. Two orthogonal axes, kept
-- orthogonal.
--
-- The moderation queue becomes `status = 'pending' and ingest_state = 'ready'`.

set search_path = public, extensions;

create type public.ingest_state as enum (
  'awaiting_bytes',  -- a URL was signed; the object may or may not exist yet
  'processing',      -- the worker has it
  'ready',           -- derivatives exist and media_assets rows are written
  'failed'           -- refused by the sniffer, or the decode did not survive
);

-- The default is 'ready', which reads oddly until you consider who inserts without
-- going through an upload: the M5 bulk importer, and any admin composing a post whose
-- media already exists. Those rows have no ingest to wait for, and defaulting them to
-- 'awaiting_bytes' would strand ~300 seed items outside the moderation queue on launch
-- week. Only the upload path sets 'awaiting_bytes', and it does so explicitly.
alter table public.posts
  add column ingest_state      public.ingest_state not null default 'ready',
  add column ingest_object_key text,
  add column ingest_error      text;

comment on column public.posts.ingest_state is
  'Machine fact from the media worker. Orthogonal to status, which is a human judgement.';
comment on column public.posts.ingest_object_key is
  'The quarantine/ key this row is waiting on. NULL for posts that never had an upload.';
comment on column public.posts.ingest_error is
  'Why ingest failed. Shown to the uploader, never to the public.';

-- One post per uploaded object, enforced rather than assumed. Without this, a bug that
-- replayed complete_ingest against a second row would attach the same derivative to two
-- posts and the takedown path would only find one of them. NULLs are not compared, so
-- the ~300 seed items and every admin-composed post coexist freely.
create unique index posts_ingest_object_key_key
  on public.posts (ingest_object_key)
  where ingest_object_key is not null;

-- The queue predicate changed, so its index has to change with it. 0011 created this
-- name as `(created_at) where status = 'pending'`; narrowing it to exclude items whose
-- media has not landed keeps the index matching what the dashboard actually asks for.
--
-- Replaced rather than supplemented: two partial indexes on the same predicate would
-- both be maintained on every write and the planner would pick one. The ascending sort
-- is preserved deliberately -- 0011 records that the queue is oldest-first, and an index
-- that disagrees with the ORDER BY is an index the planner cannot use.
drop index public.posts_moderation_queue_idx;

create index posts_moderation_queue_idx
  on public.posts (created_at)
  where status = 'pending' and ingest_state = 'ready';

-- ── Privileges ───────────────────────────────────────────────
--
-- 0015 revoked everything on posts and granted back column by column, so these three
-- columns are already unreachable by anon and authenticated and this block only widens
-- SELECT. That is deliberate and load-bearing:
--
--   · ingest_state must not be member-writable. A member who can set it to 'ready'
--     puts an item with no media, or with unprocessed media, in front of a moderator.
--   · ingest_object_key must not be member-writable in any way. A member who can point
--     their row at somebody else's quarantine key claims another person's upload.
--
-- Neither is granted here, so neither is possible. The uploader's row is created by
-- claim_upload_slot (next migration), which sets both under SECURITY DEFINER from
-- values the caller does not choose.
grant select (ingest_state, ingest_error) on public.posts to authenticated;

-- ingest_object_key is deliberately NOT selectable. It is an R2 storage path, and §7
-- treats the archive's internal layout as something the public has no reason to see.
-- The uploader already knows their own key -- request-upload returned it to them.
