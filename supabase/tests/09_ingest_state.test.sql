-- Ingest state (migration 0025).
--
-- Two things are being pinned here, and the second is the reason the file exists.
--
-- One: a member must not be able to write ingest_state or ingest_object_key. Writing
-- the first puts an item with no media in front of a moderator; writing the second
-- claims somebody else's upload.
--
-- Two: the §5 edit-after-approval trigger must NOT fire when the worker records ingest
-- progress. That trigger does not carry a column list -- it diffs
-- post_content_hash(new) against post_content_hash(old) -- so whether a column counts as
-- "content" is decided entirely by whether that function reads it. Today it does not
-- read the ingest columns. Nothing stops a future edit adding them, at which point
-- complete_ingest would silently un-approve posts. These assertions are what makes that
-- edit fail loudly instead.

begin;
create extension if not exists pgtap;

-- 7 structure · 6 privileges · 7 behaviour
select plan(20);

-- ═══ Structure ═══════════════════════════════════════════════

select is(
  (select array_agg(e.enumlabel::text order by e.enumsortorder)
     from pg_enum e
     join pg_type t on t.oid = e.enumtypid
     join pg_namespace n on n.oid = t.typnamespace
    where n.nspname = 'public' and t.typname = 'ingest_state'),
  array['awaiting_bytes','processing','ready','failed'],
  'ingest_state has exactly the four machine states, in order');

select has_column('public', 'posts', 'ingest_state', 'posts.ingest_state exists');
select col_not_null('public', 'posts', 'ingest_state',
  'ingest_state is not null — every row has a definite ingest position');
select has_column('public', 'posts', 'ingest_object_key', 'posts.ingest_object_key exists');
select has_column('public', 'posts', 'ingest_error', 'posts.ingest_error exists');

select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'posts_ingest_object_key_key'),
  'one post per uploaded object is enforced by a unique index, not assumed');

select ok(
  exists (select 1 from pg_indexes
           where schemaname = 'public' and indexname = 'posts_moderation_queue_idx'),
  'the moderation queue predicate is indexed');

-- ═══ Privileges ══════════════════════════════════════════════
-- The uploader's row is created by a SECURITY DEFINER function from values the caller
-- does not choose. Nothing about ingest is client-writable, and these six say so.

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_state', 'UPDATE'),
  'a member cannot mark their own upload ready');

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_state', 'INSERT'),
  'nor set it at insert time');

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_object_key', 'UPDATE'),
  'a member cannot repoint their row at another object');

select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_object_key', 'INSERT'),
  'nor claim one at insert time');

select ok(
  has_column_privilege('authenticated', 'public.posts', 'ingest_state', 'SELECT'),
  'but a member CAN watch their own upload progress');

-- The storage layout is not public information (§7). The uploader already has their own
-- key from request-upload; nobody needs to read anyone else's out of the table.
select ok(
  not has_column_privilege('authenticated', 'public.posts', 'ingest_object_key', 'SELECT'),
  'the R2 key is not readable from the table by anyone');

-- ═══ Behaviour ═══════════════════════════════════════════════

insert into auth.users (id, email)
values ('00000000-0000-0000-0000-0000000000d1', 'ingest@t.local');

-- Three columns here are load-bearing rather than decorative, and each is enforced:
-- body_en because §9 makes the description required archival metadata
-- (posts_has_a_description), and license/provenance because this row gets approved
-- further down and posts_approved_has_rights refuses an approval without them. §7 is
-- explicit about why -- a contributor granting a licence they do not hold is how
-- heritage archives acquire liability.
insert into public.posts (id, kind, title_en, body_en, license, provenance, created_by)
values ('00000000-0000-0000-0000-0000000000e1', 'media', 'ingest fixture',
        'a fixture for the ingest-state assertions',
        'CC-BY-SA-4.0', 'fixture — not a real contribution',
        '00000000-0000-0000-0000-0000000000d1');

select is(
  (select p.ingest_state::text from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  'ready',
  'a post inserted without an upload is ready — the bulk importer needs no ingest');

-- ── The two hash assertions the trigger's behaviour rests on ──
--
-- post_content_hash is an explicit allowlist of columns. If someone adds an ingest
-- column to it, these fail — which is the point, because the next two assertions would
-- then be silently wrong.

create temp table hash_before as
  select public.post_content_hash(p) as v
    from public.posts p where p.id = '00000000-0000-0000-0000-0000000000e1';

update public.posts set ingest_state = 'processing'
 where id = '00000000-0000-0000-0000-0000000000e1';

select is(
  (select public.post_content_hash(p) from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  (select v from hash_before),
  'ingest_state is not part of the content hash');

update public.posts set ingest_object_key = 'user-x/object-y'
 where id = '00000000-0000-0000-0000-0000000000e1';

select is(
  (select public.post_content_hash(p) from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  (select v from hash_before),
  'ingest_object_key is not part of the content hash either');

-- The counterweight. Without this, both assertions above would pass if
-- post_content_hash were broken and returned a constant.
update public.posts set title_en = 'edited'
 where id = '00000000-0000-0000-0000-0000000000e1';

select isnt(
  (select public.post_content_hash(p) from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  (select v from hash_before),
  '...but a real content column does move the hash');

-- ── And the consequence, end to end ──────────────────────────
--
-- This is the assertion that was asked for before complete_ingest gets written: an
-- approved post must survive the worker recording ingest progress. The state is
-- unreachable in the real flow -- the queue only shows ready items, so nothing is
-- approved before ingest finishes -- which is exactly why it needs a test rather than
-- an argument. A reordering that makes it reachable should fail here, not in production.

-- A claim, not a role change: the approval trigger stamps approved_by from auth.uid(),
-- and posts_approved_is_attributable refuses an approved row without one. Staying as the
-- owner keeps RLS out of the way, which is not what this file is testing.
set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-0000000000d1","role":"authenticated"}';

update public.posts set status = 'approved'
 where id = '00000000-0000-0000-0000-0000000000e1';

update public.posts set ingest_state = 'processing', ingest_error = null
 where id = '00000000-0000-0000-0000-0000000000e1';

select is(
  (select p.status::text from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  'approved',
  'recording ingest progress does not send an approved post back to the queue');

select isnt(
  (select p.approved_at from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  null,
  '...and does not erase the approval timestamp');

select isnt(
  (select p.content_hash from public.posts p
    where p.id = '00000000-0000-0000-0000-0000000000e1'),
  null,
  '...or the approved content hash the publisher checks against');

select * from finish();
rollback;
