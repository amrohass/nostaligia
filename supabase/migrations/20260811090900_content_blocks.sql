-- 0009 · content_blocks
--
-- §9: "All content comes from the store, never hardcoded in views. Page copy, cards,
-- events, comments, and the info page all read from content_blocks/shards so the
-- dashboard is the single source of truth."
--
-- This is the durable form of what assets/js/store.js currently keeps in
-- localStorage under `copy` and `pages`. One row per (key, locale) — the existing
-- store holds {ar, en} pairs in a single record, but a locale column is what lets an
-- editor publish the Arabic while the English is still in draft.
--
-- draft/published are text, not jsonb: the locale is already a column, so a block is
-- one string in one language.

create table public.content_blocks (
  key         text not null
                constraint content_blocks_key_format
                check (key ~ '^[a-z0-9]+(\.[a-z0-9_]+)*$'),

  locale      text not null
                constraint content_blocks_locale
                check (locale in ('ar', 'en')),

  draft       text,
  published   text,

  -- Bumped on each publish. The publisher stamps shards with it so a stale shard is
  -- identifiable after the fact.
  version     integer not null default 0
                constraint content_blocks_version_nonnegative
                check (version >= 0),

  updated_by  uuid references auth.users (id) on delete set null,
  updated_at  timestamptz not null default now(),

  primary key (key, locale)
);

create trigger content_blocks_touch_updated_at
  before update on public.content_blocks
  for each row execute function public.touch_updated_at();

comment on table public.content_blocks is
  'Editable site copy — the dashboard is the single source of truth (CLAUDE.md §9).';
comment on column public.content_blocks.draft is
  'Editor working copy. Never read by the publisher; only `published` reaches a shard.';

revoke all on public.content_blocks from anon, authenticated;
grant select on public.content_blocks to anon, authenticated;
-- §4: editing site copy is admin-only. The UPDATE/INSERT grants are here rather than
-- withheld because the *role* check belongs in the policy — but note that no
-- moderator-level policy will be written for this table in item 4.
grant insert, update on public.content_blocks to authenticated;

alter table public.content_blocks enable row level security;
