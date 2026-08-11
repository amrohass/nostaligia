-- Triggers and invariants (§4, §5).
--
-- The premise of putting these in triggers rather than application code is that they
-- cannot be bypassed by WHICH path performed the write. So the service-role path is
-- exercised here too, not only the browser path — that is the whole point of them
-- being triggers and it is the case application-level checks would miss.

begin;
create extension if not exists pgtap;

-- 2 content-column sweep · 3 hash · 2 approval · 3 audit permanence
-- 4 role logs · 1 self-approval · 2 service role
select plan(17);

insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-0000000000a1','m@t'),
 ('00000000-0000-0000-0000-0000000000a2','mod@t');
insert into public.user_roles (user_id,role) values ('00000000-0000-0000-0000-0000000000a2','moderator');
insert into public.profiles (id,handle) values
 ('00000000-0000-0000-0000-0000000000a1','member_one'),
 ('00000000-0000-0000-0000-0000000000a2','mod_one');

create function pg_temp.mk_approved(p_id uuid) returns void language sql as $fn$
  -- date_earliest is seeded because the sweep sets date_precision, and
  -- posts_date_precision_needs_a_date correctly refuses a precision with no date.
  insert into public.posts (id,kind,title_ar,body_ar,status,created_by,location_precision,
                            date_earliest,
                            license,provenance,approved_by,approved_at,content_hash)
  values (p_id,'media','عنوان','وصف','approved','00000000-0000-0000-0000-0000000000a1','hidden',
          date '1960-01-01',
          'CC BY-SA 4.0','album','00000000-0000-0000-0000-0000000000a2',now(),repeat('a',64));
$fn$;

-- ── Every content column resets; no non-content column does ──
-- Driven off the column list rather than a hand-picked sample, so a column added to
-- posts later is covered without anyone remembering to add a case.
create function pg_temp.reset_sweep() returns table(col text, verdict text)
language plpgsql as $fn$
declare c text; v text; st public.post_status;
begin
  for c, v in
    select * from (values
      ('kind','''voice'''), ('title_ar','''جديد'''), ('title_en','''new'''),
      ('body_ar','''وصف جديد'''), ('body_en','''new body'''),
      ('date_earliest','date ''1967-01-01'''), ('date_latest','date ''1969-12-31'''),
      ('date_precision','''decade'''),
      ('location','st_setsrid(st_makepoint(35.2,31.9),4326)::geography'),
      ('location_precision','''area'''), ('location_source','''admin'''),
      ('details','''{"tags":["x"]}''::jsonb'), ('license','''CC0'''),
      ('provenance','''donor'''), ('consent','''{"granted":true}''::jsonb')
    ) t(c,v)
  loop
    delete from public.posts where id='00000000-0000-0000-0000-0000000000b1';
    perform pg_temp.mk_approved('00000000-0000-0000-0000-0000000000b1');
    execute format('update public.posts set %I = %s where id = %L',
                   c, v, '00000000-0000-0000-0000-0000000000b1');
    select p.status into st from public.posts p where p.id='00000000-0000-0000-0000-0000000000b1';
    col := c;
    verdict := case when st = 'pending' then 'reset' else 'STAYED ' || st::text end;
    return next;
  end loop;
end $fn$;

select is((select count(*) from pg_temp.reset_sweep() where verdict <> 'reset'), 0::bigint,
  'every content column on posts resets an approved row to pending (§5)');

-- takedown is moderation state, not content: flagging a post must not silently
-- un-approve it, or a takedown would look like a rejection in the audit trail.
delete from public.posts where id='00000000-0000-0000-0000-0000000000b1';
select pg_temp.mk_approved('00000000-0000-0000-0000-0000000000b1');
update public.posts set takedown=true where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.posts where id='00000000-0000-0000-0000-0000000000b1'),
          'approved'::public.post_status,
          'takedown is NOT a content column — it does not reset status');

-- ── Content hash stability ───────────────────────────────────
delete from public.posts where id='00000000-0000-0000-0000-0000000000b1';
select pg_temp.mk_approved('00000000-0000-0000-0000-0000000000b1');
update public.posts set event_starts_at=null, date_earliest=date '1967-06-01'
  where id='00000000-0000-0000-0000-0000000000b1';

set local timezone to 'Asia/Hebron';
create temp table h1 as select public.post_content_hash(p.*) as h from public.posts p
  where p.id='00000000-0000-0000-0000-0000000000b1';
set local timezone to 'Pacific/Kiritimati';
create temp table h2 as select public.post_content_hash(p.*) as h from public.posts p
  where p.id='00000000-0000-0000-0000-0000000000b1';
set local timezone to 'UTC';
select is((select h from h1), (select h from h2),
  'content hash is identical across sessions 14 hours apart — timestamps are pinned to UTC');

-- Two independently created rows with identical content must hash identically, or the
-- publisher's comparison is meaningless.
insert into public.posts (id,kind,title_ar,body_ar,created_by,location_precision,details,consent)
values ('00000000-0000-0000-0000-0000000000b7','media','توأم','وصف','00000000-0000-0000-0000-0000000000a1','hidden','{}','{}'),
       ('00000000-0000-0000-0000-0000000000b8','media','توأم','وصف','00000000-0000-0000-0000-0000000000a1','hidden','{}','{}');
select is(
  (select public.post_content_hash(p.*) from public.posts p where p.id='00000000-0000-0000-0000-0000000000b7'),
  (select public.post_content_hash(p.*) from public.posts p where p.id='00000000-0000-0000-0000-0000000000b8'),
  'two independently created identical rows produce the same hash');

-- Media is inside the hash but must not reset status.
delete from public.posts where id='00000000-0000-0000-0000-0000000000b1';
select pg_temp.mk_approved('00000000-0000-0000-0000-0000000000b1');
create temp table hb as select public.post_content_hash(p.*) as h from public.posts p
  where p.id='00000000-0000-0000-0000-0000000000b1';
insert into public.media_assets (post_id,role,rendition,storage_path,bucket,mime)
values ('00000000-0000-0000-0000-0000000000b1','rendition','480p','public/r480.mp4','public','video/mp4');
select isnt((select h from hb),
            (select public.post_content_hash(p.*) from public.posts p where p.id='00000000-0000-0000-0000-0000000000b1'),
  'adding a rendition MOVES the content hash — the publisher will refuse the stale row');
select is((select status from public.posts where id='00000000-0000-0000-0000-0000000000b1'),
          'approved'::public.post_status,
  '...but does NOT reset status — backfilling a rendition must not un-approve an item');

-- ── A moderator cannot edit and re-approve in one statement ──
delete from public.posts where id='00000000-0000-0000-0000-0000000000b1';
select pg_temp.mk_approved('00000000-0000-0000-0000-0000000000b1');
update public.posts set body_ar='نص جديد', status='approved'
  where id='00000000-0000-0000-0000-0000000000b1';
select is((select status from public.posts where id='00000000-0000-0000-0000-0000000000b1'),
          'pending'::public.post_status,
  'edit + re-approve in one UPDATE still lands pending — approval must be a separate act');

-- ── Self-approval is queryable ───────────────────────────────
insert into public.posts (id,kind,title_ar,body_ar,created_by,location_precision)
values ('00000000-0000-0000-0000-0000000000b9','media','ذاتي','وصف','00000000-0000-0000-0000-0000000000a2','hidden');
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
update public.posts set status='approved', license='CC', provenance='self'
  where id='00000000-0000-0000-0000-0000000000b9';
reset role;
select is((select count(*) from public.audit_log
           where action='post.status.approved.self'
             and target_id='00000000-0000-0000-0000-0000000000b9'), 1::bigint,
  'a moderator approving their own post emits post.status.approved.self (§4)');

-- ── audit_log permanence, for EVERY role ─────────────────────
select throws_ok($q$ update public.audit_log set action='x' $q$, '2F003', null,
  'audit_log refuses UPDATE as the table owner');
select throws_ok($q$ delete from public.audit_log $q$, '2F003', null,
  'audit_log refuses DELETE as the table owner');
set local role service_role;
select throws_ok($q$ delete from public.audit_log $q$, '2F003', null,
  'audit_log refuses DELETE as service_role — BYPASSRLS does not bypass a trigger');
reset role;

-- ── Role changes write BOTH logs, every transition ───────────
insert into public.user_roles (user_id,role) values ('00000000-0000-0000-0000-0000000000a1','moderator');
update public.user_roles set role='admin' where user_id='00000000-0000-0000-0000-0000000000a1';
update public.user_roles set role='admin' where user_id='00000000-0000-0000-0000-0000000000a1';
delete from public.user_roles where user_id='00000000-0000-0000-0000-0000000000a1';

select set_eq(
  $q$ select action from public.audit_log
      where target_type='user_role' and target_id='00000000-0000-0000-0000-0000000000a1' $q$,
  array['role.grant','role.change','role.reaffirm','role.revoke'],
  'grant, change, reaffirm and revoke each write an audit_log row');

select is((select count(*) from public.moderation_actions
           where target_type='profile' and target_id='00000000-0000-0000-0000-0000000000a1'), 4::bigint,
  '...and each writes a moderation_actions row too (§4 — both logs, no exceptions)');

select is((select note from public.moderation_actions
           where target_type='profile' and target_id='00000000-0000-0000-0000-0000000000a1'
             and action='role.change'), 'moderator -> admin',
  'the role transition itself is recorded, not merely that one happened');

select is((select role_cache from public.profiles where id='00000000-0000-0000-0000-0000000000a1'),
          'member'::public.app_role,
  'revoking a role syncs role_cache back to member');

-- ── The service-role path fires the same triggers ────────────
set local role service_role;
insert into public.posts (id,kind,title_ar,body_ar,created_by,location_precision,location)
values ('00000000-0000-0000-0000-000000000bb1','media','خدمة','وصف',
        '00000000-0000-0000-0000-0000000000a1','area',
        st_setsrid(st_makepoint(35.2034,31.9038),4326)::geography);
reset role;

select is((select round(st_x(location_public::geometry)::numeric,9) from public.posts
           where id='00000000-0000-0000-0000-000000000bb1'), 35.2::numeric,
  'the fuzzing trigger fires on a service-role insert — §7 has no service-role exemption');

select is((select count(*) from public.audit_log
           where target_id='00000000-0000-0000-0000-000000000bb1' and action='post.create'), 1::bigint,
  'the audit trigger fires on a service-role insert too');

select * from finish();
rollback;
