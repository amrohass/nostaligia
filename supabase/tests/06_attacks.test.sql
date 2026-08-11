-- Adversarial pass. §5: "Assume the attacker has your client JS, your anon key, and a
-- free account." Everything here is attempted as an ordinary signed-in member.

begin;
create extension if not exists pgtap;

-- 8 forged columns · 5 handles · 3 originals · 2 escalation · 2 approval · 1 meta
select plan(21);

insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-0000000000a1','m@t'),
 ('00000000-0000-0000-0000-0000000000a2','mod@t'),
 ('00000000-0000-0000-0000-0000000000a4','oth@t');
insert into public.user_roles (user_id,role) values ('00000000-0000-0000-0000-0000000000a2','moderator');
insert into public.profiles (id,handle) values
 ('00000000-0000-0000-0000-0000000000a1','member_one'),
 ('00000000-0000-0000-0000-0000000000a2','mod_one'),
 ('00000000-0000-0000-0000-0000000000a4','other_one');

insert into public.posts (id,kind,title_ar,body_ar,status,created_by,location_precision,
                          license,provenance,approved_by,approved_at,content_hash) values
 ('00000000-0000-0000-0000-0000000000b1','media','معتمد','و','approved','00000000-0000-0000-0000-0000000000a1','hidden',
  'CC','album','00000000-0000-0000-0000-0000000000a2',now(),repeat('a',64)),
 ('00000000-0000-0000-0000-0000000000b4','media','لغيري','و','approved','00000000-0000-0000-0000-0000000000a4','hidden',
  'CC','album','00000000-0000-0000-0000-0000000000a2',now(),repeat('b',64));
-- A 4 GB master belonging to somebody else (§6 — restricted, never CDN-fronted).
insert into public.media_assets (post_id,role,storage_path,bucket,mime) values
 ('00000000-0000-0000-0000-0000000000b4','master','originals/secret-master.mp4','originals','video/mp4'),
 ('00000000-0000-0000-0000-0000000000b4','thumb','public/ok-thumb.jpg','public','image/jpeg');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

-- ── Forging the columns that decide who said what ────────────
select throws_ok(
  $q$ insert into public.posts(kind,title_ar,body_ar,location_precision,author_label)
      values ('media','ادعاء','و','hidden','admin') $q$,
  '42501', null, 'cannot badge a post author_label=admin — impersonating the archive team');

select throws_ok(
  $q$ insert into public.posts(kind,title_ar,body_ar,location_precision,author_label)
      values ('media','ادعاء','و','hidden','moderator') $q$,
  '42501', null, 'cannot badge a post author_label=moderator');

select throws_ok(
  $q$ insert into public.posts(kind,title_ar,body_ar,location_precision,created_by)
      values ('media','انتحال','و','hidden','00000000-0000-0000-0000-0000000000a4') $q$,
  '42501', null, 'cannot attribute a post to another member');

select throws_ok(
  $q$ insert into public.posts(kind,title_ar,body_ar,location_precision,status)
      values ('media','نشر ذاتي','و','hidden','approved') $q$,
  '42501', null, 'cannot insert a post already approved');

select throws_ok(
  $q$ update public.posts set approved_by='00000000-0000-0000-0000-0000000000a1'
      where id='00000000-0000-0000-0000-0000000000b1' $q$,
  '42501', null, 'cannot forge approved_by');

select throws_ok(
  $q$ update public.posts set approved_at=now()
      where id='00000000-0000-0000-0000-0000000000b1' $q$,
  '42501', null, 'cannot forge approved_at');

select throws_ok(
  $q$ update public.posts set content_hash=repeat('c',64)
      where id='00000000-0000-0000-0000-0000000000b1' $q$,
  '42501', null, 'cannot forge content_hash — the publisher trusts it');

-- author_label is STAMPED, so a member's post is labelled member whatever they intend.
insert into public.posts(kind,title_ar,body_ar,location_precision)
  values ('media','عادي','و','hidden');
select is((select author_label from public.posts where title_ar='عادي'),
          'member'::public.author_label,
          'author_label is stamped from authz_role(), not taken from the request');

-- ── Escalation ───────────────────────────────────────────────
select throws_ok(
  $q$ update public.profiles set role_cache='admin' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '42501', null, 'cannot write profiles.role_cache — the column grant binds every signed-in role');

select throws_ok(
  $q$ insert into public.user_roles(user_id,role) values ('00000000-0000-0000-0000-0000000000a1','admin') $q$,
  '42501', null, 'cannot write user_roles at all');

-- ── Approval ─────────────────────────────────────────────────
select throws_ok(
  $q$ update public.posts set status='approved' where id='00000000-0000-0000-0000-0000000000b1' $q$,
  '42501', null, 'a member cannot re-approve even their own already-approved post');

-- Editing an approved post must NOT leave it approved (§5). The member is allowed to
-- make this edit; the trigger is what pulls it back into the queue.
update public.posts set body_ar='وصف معدّل' where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.posts where id='00000000-0000-0000-0000-0000000000b1'),
          'pending'::public.post_status,
          'editing an approved post returns it to the queue — it cannot stay approved');

-- ── §6 originals ─────────────────────────────────────────────
select is((select count(*) from public.media_assets
           where storage_path='originals/secret-master.mp4'), 0::bigint,
          'a member cannot see another member''s master in originals/ (§6)');

select is((select count(*) from public.media_assets
           where storage_path='public/ok-thumb.jpg'), 1::bigint,
          '...while the public-bucket derivative of the same post IS visible');

select is((select count(*) from public.media_assets where bucket='originals'), 0::bigint,
          'no row with bucket=originals is reachable by a member at all');

reset role;

-- ── Handle forging ───────────────────────────────────────────
insert into auth.users (id,email) values ('00000000-0000-0000-0000-0000000000a9','h@t');
insert into public.profiles (id,handle) values ('00000000-0000-0000-0000-0000000000a9','محمد');

select throws_ok(
  $q$ update public.profiles set handle='admin' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null, 'a reserved Latin handle is refused');

select throws_ok(
  $q$ update public.profiles set handle='الإدارة' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null, 'a reserved Arabic handle is refused');

select throws_ok(
  $q$ update public.profiles set handle='aمحمد' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null, 'a mixed-script handle is refused — the classic confusable vector');

select throws_ok(
  $q$ update public.profiles set handle='١٢٣٤٥' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null, 'Arabic-Indic digits are refused — they would pair off against ASCII digits');

-- The tatweel variant normalises onto the taken handle, so it collides rather than
-- registering as a second identity.
select throws_ok(
  $q$ update public.profiles set handle='مـحـمـد' where id='00000000-0000-0000-0000-0000000000a1' $q$,
  '23514', null, 'a tatweel-padded variant of a taken handle is refused');

-- ── Meta: does structural test 5 actually catch a regression? ─
-- Re-add the exact grant 0015 removes, and confirm the assertion that guards it fires.
grant select on public.posts to authenticated;
select isnt_empty(
  $q$
    select acl.privilege_type
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    cross join lateral aclexplode(c.relacl) acl
    where n.nspname='public' and c.relname='posts'
      and acl.grantee='authenticated'::regrole::oid and acl.privilege_type='SELECT'
  $q$,
  'a re-added table-level grant IS visible to the query structural test 5 uses');
revoke select on public.posts from authenticated;

select * from finish();
rollback;
