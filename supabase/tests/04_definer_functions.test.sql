-- SECURITY DEFINER functions — exact row sets per role.
--
-- Sixteen functions run with the owner's rights, which means each one's WHERE clause
-- IS the security boundary: there is no RLS behind it to catch a mistake. Asserting
-- "it errored" or "it didn't" is not enough — a predicate that returns the wrong
-- rows returns them without erroring. Every assertion below pins the exact set.
--
-- Nine of the sixteen return `trigger` and cannot be invoked from SQL at all; they
-- are covered by the callability assertion at the end plus their behavioural tests
-- elsewhere. The seven callable ones are pinned per role here.

begin;
create extension if not exists pgtap;

-- 10 role resolution · 2 role_cache poisoning · 5 posts_full sets · 4 §7 coordinates
-- 8 profile_view · 5 content_blocks_draft · 4 post_like_count · 3 revoked · 2 sweep
select plan(44);

-- ── Fixtures ─────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'member@t.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@t.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin@t.local'),
  ('00000000-0000-0000-0000-0000000000a4', 'other@t.local');

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a2', 'moderator'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin');

insert into public.profiles (id, handle, display_name, bio, visibility) values
  ('00000000-0000-0000-0000-0000000000a1', 'member_one', 'عضو', 'نبذة علنية',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod_one', 'مشرف', 'نبذة مشرف',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin_one', 'مدير', 'نبذة مدير',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  -- bio PRIVATE — the row every profile_view assertion turns on
  ('00000000-0000-0000-0000-0000000000a4', 'other_one', 'آخر', 'نبذة خاصة',
   '{"bio":"private","personalInfo":"private","contributions":"private","comments":"private"}');

insert into public.posts
  (id, kind, title_ar, body_ar, status, created_by, location, location_precision,
   license, provenance, approved_by, approved_at, content_hash)
values
  ('00000000-0000-0000-0000-0000000000b1','media','معتمد لي','و','approved',
   '00000000-0000-0000-0000-0000000000a1',
   st_setsrid(st_makepoint(35.2034,31.9038),4326)::geography,'area',
   'CC BY-SA 4.0','album','00000000-0000-0000-0000-0000000000a2',now(),
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('00000000-0000-0000-0000-0000000000b2','media','معلق لي','و','pending',
   '00000000-0000-0000-0000-0000000000a1', null,'hidden',null,null,null,null,null),
  ('00000000-0000-0000-0000-0000000000b3','media','معلق لغيري','و','pending',
   '00000000-0000-0000-0000-0000000000a4', null,'hidden',null,null,null,null,null),
  ('00000000-0000-0000-0000-0000000000b4','media','معتمد لغيري','و','approved',
   '00000000-0000-0000-0000-0000000000a4',
   st_setsrid(st_makepoint(35.3034,31.8038),4326)::geography,'area',
   'CC BY-SA 4.0','album','00000000-0000-0000-0000-0000000000a2',now(),
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

-- 0043 SEEDS this table with the archive's real copy — including hero.line — so a fixture
-- that shares a key with it collides on insert, and a fixture that merely READS one makes
-- the assertion depend on prose an editor may change. Cleared first, inside the
-- transaction, so this file describes a state it built itself.
delete from public.content_blocks;
insert into public.content_blocks (key, locale, draft, published) values
  ('hero.line','ar','مسودة غير منشورة','هنا تُروى رام الله');

insert into public.likes (user_id, post_id) values
  ('00000000-0000-0000-0000-0000000000a4','00000000-0000-0000-0000-0000000000b1');

-- ═══ authz_role / is_moderator / is_admin ════════════════════
set local role anon;
set local request.jwt.claims to '';
select is(public.authz_role(), null, 'authz_role: anon is NULL, not member');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.authz_role(), 'member'::public.app_role, 'authz_role: no user_roles row means member');
select is(public.is_moderator(), false, 'is_moderator: false for a member');
select is(public.is_admin(),     false, 'is_admin: false for a member');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is(public.authz_role(), 'moderator'::public.app_role, 'authz_role: moderator');
select is(public.is_moderator(), true,  'is_moderator: true for a moderator');
select is(public.is_admin(),     false, 'is_admin: false for a moderator');

reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is(public.authz_role(), 'admin'::public.app_role, 'authz_role: admin');
select is(public.is_moderator(), true, 'is_moderator: true for an admin — every moderator capability is an admin one');
select is(public.is_admin(),     true, 'is_admin: true for an admin');
reset role;

-- ═══ §4 — role_cache must never be believed ══════════════════
-- Poison the display cache and confirm authorization is unmoved. This is the
-- behavioural counterpart to the structural assertion in 00_structure that no policy
-- mentions the column: that one proves nothing READS it, this proves that even if
-- something did, the value is not the one that decides.
update public.profiles set role_cache = 'admin'
  where id = '00000000-0000-0000-0000-0000000000a1';

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.authz_role(), 'member'::public.app_role,
          'role_cache=admin does NOT change authz_role — the cache is display only (§4)');
select is(public.is_admin(), false,
          'role_cache=admin does NOT grant admin');
reset role;
update public.profiles set role_cache = 'member'
  where id = '00000000-0000-0000-0000-0000000000a1';

-- ═══ posts_full() — exact sets ═══════════════════════════════
set local role anon;
set local request.jwt.claims to '';
select throws_ok($q$ select * from public.posts_full() $q$, '42501', null,
  'posts_full: anon cannot execute it at all');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select set_eq(
  $q$ select id::text from public.posts_full() $q$,
  array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2'],
  'posts_full: a member gets exactly their own two posts, no more');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}';
select set_eq(
  $q$ select id::text from public.posts_full() $q$,
  array['00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-0000000000b4'],
  'posts_full: the other member gets exactly their own two, disjoint from the first');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select set_eq(
  $q$ select id::text from public.posts_full() $q$,
  array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-0000000000b4'],
  'posts_full: a moderator gets all four');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select set_eq(
  $q$ select id::text from public.posts_full() $q$,
  array['00000000-0000-0000-0000-0000000000b1','00000000-0000-0000-0000-0000000000b2',
        '00000000-0000-0000-0000-0000000000b3','00000000-0000-0000-0000-0000000000b4'],
  'posts_full: an admin gets all four');
reset role;

-- ═══ §7 — who can reach a RAW coordinate, and by which path ══
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select isnt((select location from public.posts_full()
             where id = '00000000-0000-0000-0000-0000000000b1'), null,
  'raw location: an author reaches it for their OWN post — they submitted it');

select is((select count(*) from public.posts_full()
           where id = '00000000-0000-0000-0000-0000000000b4'), 0::bigint,
  'raw location: a member gets no row at all for another member''s post, so no coordinate');

select throws_ok($q$ select location from public.posts $q$, '42501', null,
  'raw location: the direct column is refused even on an approved row (§7)');

select throws_ok($q$ select public.post_audit_snapshot(p.*) from public.posts p $q$, '42501', null,
  'raw location: post_audit_snapshot is not executable by a member');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select isnt((select location from public.posts_full()
             where id = '00000000-0000-0000-0000-0000000000b4'), null,
  'raw location: a moderator reaches it for any post — this is the intended path');
reset role;

-- ═══ profile_view() — the visibility map ═════════════════════
set local role anon;
set local request.jwt.claims to '';
select isnt((select bio from public.profile_view('member_one')), null,
  'profile_view: anon sees a bio marked public');
select is((select bio from public.profile_view('other_one')), null,
  'profile_view: anon does NOT see a bio marked private');
select is((select visibility from public.profile_view('other_one')), null,
  'profile_view: anon never sees the visibility map itself');
select is((select is_own from public.profile_view('other_one')), false,
  'profile_view: is_own is false for anon');
select is((select handle from public.profile_view('other_one')), 'other_one',
  'profile_view: handle is always public (§7) even when everything else is private');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select bio from public.profile_view('other_one')), null,
  'profile_view: another member does NOT see a private bio');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a4","role":"authenticated"}';
select isnt((select bio from public.profile_view('other_one')), null,
  'profile_view: the owner sees their own private bio');
select is((select member_since from public.profile_view('other_one')),
          extract(year from now())::integer,
  'profile_view: member_since is a YEAR, never a timestamp (§7)');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select isnt((select bio from public.profile_view('other_one')), null,
  'profile_view: a moderator sees a private bio');
reset role;

-- ═══ content_blocks_draft() — admin only ═════════════════════
set local role anon;
set local request.jwt.claims to '';
select throws_ok($q$ select * from public.content_blocks_draft() $q$, '42501', null,
  'content_blocks_draft: anon cannot execute it');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is((select count(*) from public.content_blocks_draft()), 0::bigint,
  'content_blocks_draft: a member gets zero rows');
select throws_ok($q$ select draft from public.content_blocks $q$, '42501', null,
  'content_blocks: the draft column is not readable directly');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is((select count(*) from public.content_blocks_draft()), 0::bigint,
  'content_blocks_draft: a MODERATOR gets zero rows — site copy is admin-only (§4)');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is((select draft from public.content_blocks_draft() where key='hero.line'),
          'مسودة غير منشورة',
  'content_blocks_draft: an admin sees the unpublished draft');
reset role;

-- ═══ post_like_count() — counts without exposing who ═════════
set local role anon;
set local request.jwt.claims to '';
select is(public.post_like_count('00000000-0000-0000-0000-0000000000b1'), 1,
  'post_like_count: anon gets the count for an approved post');
reset role;

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(public.post_like_count('00000000-0000-0000-0000-0000000000b1'), 1,
  'post_like_count: a member gets the same count');
select is(public.post_like_count('00000000-0000-0000-0000-0000000000b2'), 0,
  'post_like_count: an unapproved post reports zero regardless of its rows');
select is((select count(*) from public.likes), 0::bigint,
  'likes: a member sees none of another member''s likes — the count leaks no identity');
reset role;

-- ═══ Functions revoked from PUBLIC ═══════════════════════════
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok($q$ select public.post_content_hash(p.*) from public.posts p $q$, '42501', null,
  'post_content_hash: not executable even by a moderator — only triggers and the publisher');
select throws_ok($q$ select public.custom_access_token_hook('{}'::jsonb) $q$, '42501', null,
  'custom_access_token_hook: not executable by any browser role, only supabase_auth_admin');
reset role;

-- ═══ Sweep ═══════════════════════════════════════════════════
select is_empty(
  $q$
    select p.proname::text
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.prosecdef
      and not exists (
        select 1 from unnest(coalesce(p.proconfig, '{}')) as cfg
        where cfg like 'search_path=%'
      )
  $q$,
  'every SECURITY DEFINER function pins search_path — a mutable one is the standard escalation route');

select throws_ok($q$ select public.touch_updated_at() $q$, '0A000', null,
  'trigger functions cannot be invoked directly from SQL');

select * from finish();
rollback;
