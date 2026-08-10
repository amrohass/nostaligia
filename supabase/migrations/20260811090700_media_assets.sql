-- 0007 · media_assets
--
-- §3: "One post → one master (originals/) + N renditions (public/) + thumb + poster.
-- NEVER serve a row with bucket='originals' through the public CDN path."
--
-- §6 separates preservation from delivery and says never to conflate them. The
-- constraint below makes that structural: role='master' if and only if
-- bucket='originals'. There is no way to write a row that puts a master in the
-- public bucket, or a rendition in originals — not from the browser, not from an
-- Edge Function, not from the publisher.

create table public.media_assets (
  id            uuid primary key default gen_random_uuid(),

  post_id       uuid not null references public.posts (id) on delete cascade,

  role          public.media_role not null,

  -- Set exactly when role='rendition'.
  rendition     public.media_rendition,

  storage_path  text not null
                  constraint media_assets_storage_path_nonempty
                  check (char_length(btrim(storage_path)) > 0),

  bucket        public.media_bucket not null,

  mime          text not null,

  bytes         bigint constraint media_assets_bytes_positive check (bytes is null or bytes > 0),
  width         integer constraint media_assets_width_positive check (width is null or width > 0),
  height        integer constraint media_assets_height_positive check (height is null or height > 0),
  duration_s    numeric(10, 3) constraint media_assets_duration_positive check (duration_s is null or duration_s > 0),
  bitrate_kbps  integer constraint media_assets_bitrate_positive check (bitrate_kbps is null or bitrate_kbps > 0),

  sort_order    integer not null default 0,

  created_at    timestamptz not null default now(),

  constraint media_assets_rendition_iff_rendition_role
    check ((role = 'rendition') = (rendition is not null)),

  -- The preservation/delivery split of §6, as a constraint rather than a convention.
  constraint media_assets_master_iff_originals
    check ((role = 'master') = (bucket = 'originals')),

  -- §6: "Reject SVG." The Edge Function validates by magic bytes at ingest; this is
  -- the backstop that catches anything which somehow got past it.
  constraint media_assets_no_svg
    check (mime !~* '^image/svg')
);

-- §3: one master per post.
create unique index media_assets_one_master_per_post
  on public.media_assets (post_id)
  where role = 'master';

-- And one of each rung of the ladder.
create unique index media_assets_one_rendition_per_rung
  on public.media_assets (post_id, rendition)
  where role = 'rendition';

-- An object lives at exactly one path in exactly one bucket.
create unique index media_assets_unique_object
  on public.media_assets (bucket, storage_path);

comment on table public.media_assets is
  'Preservation (originals/) and delivery (public/) are separate paths — CLAUDE.md §6.';
comment on column public.media_assets.bucket is
  'A row with bucket=originals must NEVER be served through the public CDN path.';

revoke all on public.media_assets from anon, authenticated;
grant select on public.media_assets to anon, authenticated;
-- Rows are written by the processing function (service role) after magic-byte
-- validation and re-encoding. A browser never inserts here — if it could, it could
-- claim an arbitrary storage_path.

alter table public.media_assets enable row level security;
