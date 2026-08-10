-- 0006 · posts
--
-- ONE table with a `kind` enum, per §3: "Do not split by type — one feed, one
-- moderation queue, one comment model; splitting turns every feed read into a UNION."
--
-- Several of §5's and §7's rules are enforced here as CHECK constraints rather than
-- left to application code. The reasoning is the same each time: the browser is
-- hostile and Edge Functions can be bypassed by a compromised key, but a CHECK
-- constraint is refused by the database itself. Specifically —
--   · an approved row MUST carry its approver, its approval time and its content hash
--   · an approved row MUST carry provenance and a license (§7: "a contributor
--     granting a license they do not hold is how heritage archives acquire liability")
--   · location_precision 'hidden' MUST publish no coordinates

set search_path = public, extensions;

create table public.posts (
  id                 uuid primary key default gen_random_uuid(),

  kind               public.post_kind not null,

  title_ar           text,
  title_en           text,
  body_ar            text,
  body_en            text,

  -- ── EDTF-lite dates (§3) ───────────────────────────────────
  -- A range plus how precisely it is known. "Sometime in the 60s" is
  -- (1960-01-01, 1969-12-31, 'decade') — never a forced single date.
  date_earliest      date,
  date_latest        date,
  date_precision     public.date_precision,

  -- Generated from date_earliest for the decade slider (§3). The expression is
  -- immutable: EXTRACT over a `date` resolves to the immutable timestamp variant.
  decade             smallint generated always as (
                       case
                         when date_earliest is null then null
                         else ((extract(year from date_earliest)::int / 10) * 10)::smallint
                       end
                     ) stored,

  -- ── Location (§7) ──────────────────────────────────────────
  -- `location` is the truth and is NEVER published. `location_public` is the fuzzed
  -- point the publisher writes into shards. The publisher reads location_public and
  -- has no reason to read location at all.
  location           extensions.geography(Point, 4326),
  location_precision public.location_precision not null default 'hidden',
  location_public    extensions.geography(Point, 4326),
  location_source    public.location_source,
  place_id           uuid references public.places (id) on delete set null,

  -- ── kind = 'event' only ────────────────────────────────────
  event_starts_at    timestamptz,
  event_ends_at      timestamptz,
  venue_ar           text,
  venue_en           text,

  details            jsonb not null default '{}'::jsonb,

  -- ── Moderation state (§5) ──────────────────────────────────
  status             public.post_status not null default 'pending',
  takedown           boolean not null default false,

  -- ── Rights (§7) ────────────────────────────────────────────
  license            text,
  provenance         text,
  consent            jsonb not null default '{}'::jsonb,
  author_label       public.author_label not null default 'member',

  -- Recorded at approval; the publisher refuses any row whose hash no longer
  -- matches (M2). See the approval trigger in item 2.
  content_hash       text,
  approved_by        uuid references auth.users (id) on delete set null,
  approved_at        timestamptz,

  -- Nullable only so that deleting an auth user does not delete the archive. The
  -- INSERT policy in item 4 pins this to auth.uid(), so it can never be null at
  -- insert time — only later, if the account is erased. Attribution then falls back
  -- to author_label, and audit_log retains who it was.
  created_by         uuid references auth.users (id) on delete set null,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),

  -- ── Shape ──────────────────────────────────────────────────
  constraint posts_has_a_title
    check (title_ar is not null or title_en is not null),

  -- §9 frames the description as required archival metadata. Either language counts.
  constraint posts_has_a_description
    check (body_ar is not null or body_en is not null),

  constraint posts_date_range_ordered
    check (date_earliest is null or date_latest is null or date_latest >= date_earliest),

  constraint posts_date_precision_needs_a_date
    check (date_precision is null or date_earliest is not null),

  constraint posts_event_columns_only_on_events
    check (
      kind = 'event'
      or (event_starts_at is null and event_ends_at is null
          and venue_ar is null and venue_en is null)
    ),

  constraint posts_event_needs_a_start
    check (kind <> 'event' or event_starts_at is not null),

  constraint posts_event_range_ordered
    check (event_ends_at is null or event_starts_at is null or event_ends_at >= event_starts_at),

  -- §7 — 'hidden' publishes no coordinates at all.
  constraint posts_hidden_location_publishes_nothing
    check (location_precision <> 'hidden' or location_public is null),

  constraint posts_details_is_object
    check (jsonb_typeof(details) = 'object'),

  constraint posts_consent_is_object
    check (jsonb_typeof(consent) = 'object'),

  constraint posts_content_hash_is_sha256_hex
    check (content_hash is null or content_hash ~ '^[0-9a-f]{64}$'),

  -- §5 — approval is not a flag, it is a record of who approved what.
  constraint posts_approved_is_attributable
    check (
      status <> 'approved'
      or (approved_by is not null and approved_at is not null and content_hash is not null)
    ),

  -- §7 — nothing goes public without recorded provenance and a license.
  constraint posts_approved_has_rights
    check (
      status <> 'approved'
      or (license is not null and provenance is not null)
    )
);

create trigger posts_touch_updated_at
  before update on public.posts
  for each row execute function public.touch_updated_at();

comment on column public.posts.location is
  'Raw location. NEVER published — the publisher reads location_public (CLAUDE.md §7).';
comment on column public.posts.location_public is
  'Fuzzed point. This is the only coordinate that may reach a shard.';
comment on column public.posts.decade is
  'Generated from date_earliest for the decade slider (CLAUDE.md §3).';

revoke all on public.posts from anon, authenticated;
grant select on public.posts to anon, authenticated;
grant insert, update on public.posts to authenticated;
-- No DELETE for anyone in the browser. §4 gives moderators "delete content", which
-- is served by status='rejected' plus takedown — a heritage archive does not lose
-- the audit trail of what was removed and by whom.

alter table public.posts enable row level security;
