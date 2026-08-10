-- 0008 · comments, likes, saves
--
-- §1: "Browsing is open; all engagement requires sign-in." Everything here is
-- authenticated-only, enforced by the policies in item 4.

-- ── comments ─────────────────────────────────────────────────
-- Default status is 'pending': pre-moderation, per your decision. Note this differs
-- from the mock's default in assets/js/admin.js, which posts comments immediately —
-- that screen's toggle becomes a content_blocks/setting later, but the DEFAULT is
-- the safe one, so a bug that forgets to set status cannot publish unreviewed text.
create table public.comments (
  id          uuid primary key default gen_random_uuid(),

  post_id     uuid not null references public.posts (id) on delete cascade,

  body        text not null
                constraint comments_body_length
                check (char_length(btrim(body)) between 1 and 4000),

  lang        text constraint comments_lang check (lang is null or lang in ('ar', 'en')),

  status      public.comment_status not null default 'pending',

  created_by  uuid references auth.users (id) on delete set null,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create trigger comments_touch_updated_at
  before update on public.comments
  for each row execute function public.touch_updated_at();

revoke all on public.comments from anon, authenticated;
grant select on public.comments to anon, authenticated;
grant insert, update on public.comments to authenticated;

alter table public.comments enable row level security;

-- ── likes ────────────────────────────────────────────────────
-- §3 specifies UNIQUE(user_id, post_id); a composite primary key gives that and the
-- lookup index in one object.
create table public.likes (
  user_id     uuid not null references auth.users (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

revoke all on public.likes from anon, authenticated;
grant select on public.likes to anon, authenticated;
grant insert, delete on public.likes to authenticated;

alter table public.likes enable row level security;

-- ── saves ────────────────────────────────────────────────────
-- A save is private to the member who made it — §7's aggregate concern applies:
-- what someone has bookmarked is a profile of their interests. The SELECT policy in
-- item 4 is owner-only, unlike likes, whose counts are baked into shards at publish.
create table public.saves (
  user_id     uuid not null references auth.users (id) on delete cascade,
  post_id     uuid not null references public.posts (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (user_id, post_id)
);

comment on table public.saves is
  'Private to the owner. What a member saved is not public information (CLAUDE.md §7).';

revoke all on public.saves from anon, authenticated;
grant select, insert, delete on public.saves to authenticated;

alter table public.saves enable row level security;
