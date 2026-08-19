-- The authorization matrix: 4 roles × 16 tables × 4 operations = 256 cells.
--
-- Every cell is attempted for real and compared against an expectation derived from
-- the policy files, not from a previous run. Outcomes are three-valued, because
-- "denied" has two distinct shapes and conflating them hides bugs:
--
--   allow  the statement succeeded and touched at least one row
--   empty  the statement was permitted but RLS's USING clause matched no rows
--   deny   refused outright with 42501 (no grant, or a WITH CHECK violation)
--
-- The distinction is not pedantry. `media_assets select` read `deny` for every role
-- before 0023 — which looks exactly like a correctly-denied cell, and would have been
-- recorded as a pass by any suite asserting only "anon cannot read". It was a broken
-- policy that no browser role could evaluate.
--
-- One set_eq rather than 256 assertions: on failure pgTAP prints precisely which
-- cells differ, which is the diff you want, and a missing cell is as loud as a wrong one.

begin;
create extension if not exists pgtap;

select plan(3);

-- ── Fixtures ─────────────────────────────────────────────────
insert into auth.users (id,email) values
 ('00000000-0000-0000-0000-0000000000a1','m@t'),
 ('00000000-0000-0000-0000-0000000000a2','mod@t'),
 ('00000000-0000-0000-0000-0000000000a3','adm@t'),
 ('00000000-0000-0000-0000-0000000000a4','oth@t'),
 ('00000000-0000-0000-0000-0000000000a9','spare@t');
insert into public.user_roles (user_id,role) values
 ('00000000-0000-0000-0000-0000000000a2','moderator'),
 ('00000000-0000-0000-0000-0000000000a3','admin');
insert into public.profiles (id,handle) values
 ('00000000-0000-0000-0000-0000000000a1','member_one'),
 ('00000000-0000-0000-0000-0000000000a2','mod_one'),
 ('00000000-0000-0000-0000-0000000000a3','admin_one'),
 ('00000000-0000-0000-0000-0000000000a4','other_one');
insert into public.places (id,name_ar,location) values
 ('00000000-0000-0000-0000-0000000000c1','ميدان',st_setsrid(st_makepoint(35.2,31.9),4326)::geography);
insert into public.posts (id,kind,title_ar,body_ar,status,created_by,location_precision,
                          license,provenance,approved_by,approved_at,content_hash) values
 ('00000000-0000-0000-0000-0000000000b1','media','معتمد','و','approved','00000000-0000-0000-0000-0000000000a1','hidden',
  'CC','album','00000000-0000-0000-0000-0000000000a2',now(),repeat('a',64)),
 ('00000000-0000-0000-0000-0000000000b2','media','معلق','و','pending','00000000-0000-0000-0000-0000000000a1','hidden',
  null,null,null,null,null);
insert into public.media_assets (id,post_id,role,storage_path,bucket,mime) values
 ('00000000-0000-0000-0000-0000000000d1','00000000-0000-0000-0000-0000000000b1','thumb','public/t.jpg','public','image/jpeg');
insert into public.comments (id,post_id,body,status,created_by) values
 ('00000000-0000-0000-0000-0000000000e1','00000000-0000-0000-0000-0000000000b1','تعليق','pending','00000000-0000-0000-0000-0000000000a1');
-- Seeded against b2, so the member's own INSERT probe against b1 cannot collide with
-- it. An earlier run reported err:23505 here — a unique violation from the fixture
-- masquerading as an authorization result.
insert into public.likes (user_id,post_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2');
insert into public.saves (user_id,post_id) values ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b2');
insert into public.content_blocks (key,locale,draft,published) values ('hero.line','ar','د','ن');
insert into public.reports (id,target_type,target_id,reason,reported_by,status) values
 ('00000000-0000-0000-0000-0000000000f1','post','00000000-0000-0000-0000-0000000000b1','سبب','00000000-0000-0000-0000-0000000000a1','open');
insert into public.releases (path,active) values ('/v/2026-08-11T09:00:00Z/',true);
insert into public.upload_quota (user_id,day,count,bytes) values ('00000000-0000-0000-0000-0000000000a1',current_date,1,10);

create temp table stmts(tbl text, op text, sql text);
insert into stmts values
('profiles','select','select count(*) from public.profiles'),
('profiles','insert',$$insert into public.profiles(id,handle) values ('00000000-0000-0000-0000-0000000000a9','probe_one')$$),
('profiles','update',$$update public.profiles set display_name='x' where handle='member_one'$$),
('profiles','delete',$$delete from public.profiles where handle='member_one'$$),
('places','select','select count(*) from public.places'),
('places','insert',$$insert into public.places(name_ar,location) values ('م',st_setsrid(st_makepoint(35.2,31.9),4326)::geography)$$),
('places','update',$$update public.places set name_ar='ي' where id='00000000-0000-0000-0000-0000000000c1'$$),
('places','delete',$$delete from public.places where id='00000000-0000-0000-0000-0000000000c1'$$),
('posts','select','select count(*) from public.posts'),
('posts','insert',$$insert into public.posts(kind,title_ar,body_ar,location_precision) values ('media','ج','و','hidden')$$),
('posts','update',$$update public.posts set title_ar='ز' where id='00000000-0000-0000-0000-0000000000b2'$$),
('posts','delete',$$delete from public.posts where id='00000000-0000-0000-0000-0000000000b2'$$),
('media_assets','select','select count(*) from public.media_assets'),
('media_assets','insert',$$insert into public.media_assets(post_id,role,storage_path,bucket,mime) values ('00000000-0000-0000-0000-0000000000b1','thumb','public/z.jpg','public','image/jpeg')$$),
('media_assets','update',$$update public.media_assets set sort_order=9 where id='00000000-0000-0000-0000-0000000000d1'$$),
('media_assets','delete',$$delete from public.media_assets where id='00000000-0000-0000-0000-0000000000d1'$$),
('comments','select','select count(*) from public.comments'),
('comments','insert',$$insert into public.comments(post_id,body) values ('00000000-0000-0000-0000-0000000000b1','ت')$$),
('comments','update',$$update public.comments set body='ث' where id='00000000-0000-0000-0000-0000000000e1'$$),
('comments','delete',$$delete from public.comments where id='00000000-0000-0000-0000-0000000000e1'$$),
('likes','select','select count(*) from public.likes'),
('likes','insert',$$insert into public.likes(user_id,post_id) select auth.uid(),'00000000-0000-0000-0000-0000000000b1' where auth.uid() is not null$$),
('likes','update',$$update public.likes set created_at=now() where post_id='00000000-0000-0000-0000-0000000000b2'$$),
('likes','delete',$$delete from public.likes where post_id='00000000-0000-0000-0000-0000000000b2'$$),
('saves','select','select count(*) from public.saves'),
('saves','insert',$$insert into public.saves(user_id,post_id) select auth.uid(),'00000000-0000-0000-0000-0000000000b1' where auth.uid() is not null$$),
('saves','update',$$update public.saves set created_at=now() where post_id='00000000-0000-0000-0000-0000000000b2'$$),
('saves','delete',$$delete from public.saves where post_id='00000000-0000-0000-0000-0000000000b2'$$),
('content_blocks','select','select count(*) from public.content_blocks'),
('content_blocks','insert',$$insert into public.content_blocks(key,locale,published) values ('x.y','en','v')$$),
('content_blocks','update',$$update public.content_blocks set published='w' where key='hero.line'$$),
('content_blocks','delete',$$delete from public.content_blocks where key='hero.line'$$),
('reports','select','select count(*) from public.reports'),
('reports','insert',$$insert into public.reports(target_type,target_id,reason) values ('post','00000000-0000-0000-0000-0000000000b1','س')$$),
('reports','update',$$update public.reports set status='closed' where id='00000000-0000-0000-0000-0000000000f1'$$),
('reports','delete',$$delete from public.reports where id='00000000-0000-0000-0000-0000000000f1'$$),
('moderation_actions','select','select count(*) from public.moderation_actions'),
('moderation_actions','insert',$$insert into public.moderation_actions(actor,action,target_type,target_id) values (null,'x','post','00000000-0000-0000-0000-0000000000b1')$$),
('moderation_actions','update',$$update public.moderation_actions set note='n' where true$$),
('moderation_actions','delete',$$delete from public.moderation_actions where true$$),
('audit_log','select','select count(*) from public.audit_log'),
('audit_log','insert',$$insert into public.audit_log(action,target_type) values ('x','post')$$),
('audit_log','update',$$update public.audit_log set action='y' where true$$),
('audit_log','delete',$$delete from public.audit_log where true$$),
('user_roles','select','select count(*) from public.user_roles'),
('user_roles','insert',$$insert into public.user_roles(user_id,role) values ('00000000-0000-0000-0000-0000000000a9','admin')$$),
('user_roles','update',$$update public.user_roles set role='admin' where true$$),
('user_roles','delete',$$delete from public.user_roles where true$$),
('reserved_handles','select','select count(*) from public.reserved_handles'),
('reserved_handles','insert',$$insert into public.reserved_handles(handle,reason) values ('zzz','x')$$),
('reserved_handles','update',$$update public.reserved_handles set reason='y' where true$$),
('reserved_handles','delete',$$delete from public.reserved_handles where true$$),
('releases','select','select count(*) from public.releases'),
('releases','insert',$$insert into public.releases(path,active) values ('/v/2026-01-01T00:00:00Z/',false)$$),
('releases','update',$$update public.releases set active=false where true$$),
('releases','delete',$$delete from public.releases where true$$),
('upload_quota','select','select count(*) from public.upload_quota'),
('upload_quota','insert',$$insert into public.upload_quota(user_id,day,count) values ('00000000-0000-0000-0000-0000000000a9',current_date,0)$$),
('upload_quota','update',$$update public.upload_quota set count=0 where true$$),
('upload_quota','delete',$$delete from public.upload_quota where true$$),
-- The single writer (0034). Every cell is `deny` for all four browser roles: a member who
-- could take the publish lease could stop the archive updating with one RPC every four
-- minutes, which needs no exploit at all. The table was added to this file because the
-- coverage sweep below refused to let it be forgotten.
('publish_lease','select','select count(*) from public.publish_lease'),
('publish_lease','insert',$$insert into public.publish_lease(holder,expires_at) values ('00000000-0000-0000-0000-0000000000a9',now()+interval '1 minute')$$),
('publish_lease','update',$$update public.publish_lease set expires_at=now() where true$$),
('publish_lease','delete',$$delete from public.publish_lease where true$$),

-- The debounce counters (0037). Deny everywhere, and the UPDATE cell is the one that
-- matters: these two integers decide whether the archive republishes at all. A member who
-- could hold them still would stop the site changing; one who could raise them would make
-- it rebuild every two minutes. Neither needs a privileged call, only a default grant
-- nobody revoked.
('publish_revision','select','select count(*) from public.publish_revision'),
('publish_revision','insert',$$insert into public.publish_revision(id) values (false)$$),
('publish_revision','update',$$update public.publish_revision set content_revision=0 where true$$),
('publish_revision','delete',$$delete from public.publish_revision where true$$),

-- The operator hold (0039). Deny everywhere, and INSERT is the cell that matters: one row
-- in this table stops the archive publishing for everybody, with no exploit and no
-- privileged call — only a default grant nobody revoked.
('publish_hold','select','select count(*) from public.publish_hold'),
('publish_hold','insert',$$insert into public.publish_hold(id,reason,held_by) values (true,'x','00000000-0000-0000-0000-0000000000a9')$$),
('publish_hold','update',$$update public.publish_hold set reason='y' where true$$),
('publish_hold','delete',$$delete from public.publish_hold where true$$);

-- Each probe runs in a subtransaction that is always rolled back — plpgsql variables
-- survive that rollback, so the outcome is preserved while the write is not.
create function pg_temp.probe_all() returns table(tbl text, op text, outcome text)
language plpgsql as $fn$
declare r record; n bigint; c bigint;
begin
  for r in select * from stmts order by tbl, op loop
    tbl := r.tbl; op := r.op; n := 0;
    begin
      if r.op = 'select' then
        execute r.sql into c;
        outcome := case when c > 0 then 'allow' else 'empty' end;
      else
        execute r.sql;
        get diagnostics n = row_count;
        outcome := case when n > 0 then 'allow' else 'empty' end;
        raise exception using errcode='ZZ999', message='probe';
      end if;
    exception
      when sqlstate 'ZZ999' then null;
      when insufficient_privilege then outcome := 'deny';
      when others then outcome := 'err:' || sqlstate;
    end;
    return next;
  end loop;
end $fn$;

create temp table actual(role text, tbl text, op text, outcome text);
-- Temp objects belong to the session user; a SET ROLE'd role has no privilege on them
-- and the probe would fail before reaching a single policy.
grant select, insert on actual to anon, authenticated;
grant select on stmts to anon, authenticated;

set local role anon;
set local request.jwt.claims to '';
insert into actual select 'anon', * from pg_temp.probe_all();
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
insert into actual select 'member', * from pg_temp.probe_all();
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
insert into actual select 'moderator', * from pg_temp.probe_all();
reset role;
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
insert into actual select 'admin', * from pg_temp.probe_all();
reset role;

-- ── Expected: every cell is deny unless named here ───────────
create temp table expected(role text, tbl text, op text, outcome text);
insert into expected select r.role, s.tbl, s.op, 'deny'
  from (values ('anon'),('member'),('moderator'),('admin')) r(role), stmts s;

update expected e set outcome = v.outcome from (values
  -- member: browses, contributes, engages, reports. Nothing privileged.
  ('member','profiles','select','allow'),   ('member','profiles','update','allow'),
  ('member','places','select','allow'),     ('member','places','update','empty'),
  ('member','posts','select','allow'),      ('member','posts','insert','allow'),
  ('member','posts','update','allow'),
  ('member','media_assets','select','allow'),
  ('member','comments','select','allow'),   ('member','comments','insert','allow'),
  ('member','comments','update','allow'),
  ('member','likes','select','allow'),      ('member','likes','insert','allow'),
  ('member','likes','delete','allow'),
  ('member','saves','select','allow'),      ('member','saves','insert','allow'),
  ('member','saves','delete','allow'),
  ('member','content_blocks','select','allow'), ('member','content_blocks','update','empty'),
  ('member','reports','select','allow'),    ('member','reports','insert','allow'),
  ('member','reports','update','empty'),
  ('member','moderation_actions','select','empty'),
  ('member','audit_log','select','empty'),

  -- moderator: adds the queue, the gazetteer and reports. Not site copy, not audit,
  -- and NOT other people's likes or saves.
  ('moderator','profiles','select','allow'), ('moderator','profiles','update','empty'),
  ('moderator','places','select','allow'),   ('moderator','places','insert','allow'),
  ('moderator','places','update','allow'),
  ('moderator','posts','select','allow'),    ('moderator','posts','insert','allow'),
  ('moderator','posts','update','allow'),
  ('moderator','media_assets','select','allow'),
  ('moderator','comments','select','allow'), ('moderator','comments','insert','allow'),
  ('moderator','comments','update','allow'),
  ('moderator','likes','select','empty'),    ('moderator','likes','insert','allow'),
  ('moderator','likes','delete','empty'),
  ('moderator','saves','select','empty'),    ('moderator','saves','insert','allow'),
  ('moderator','saves','delete','empty'),
  ('moderator','content_blocks','select','allow'), ('moderator','content_blocks','update','empty'),
  ('moderator','reports','select','allow'),  ('moderator','reports','insert','allow'),
  ('moderator','reports','update','allow'),
  ('moderator','moderation_actions','select','allow'),
  ('moderator','audit_log','select','empty'),

  -- admin: adds site copy and the audit trail. Still cannot write user_roles from a
  -- browser — role changes go through the service role and leave an audit row.
  ('admin','profiles','select','allow'),  ('admin','profiles','update','empty'),
  ('admin','places','select','allow'),    ('admin','places','insert','allow'),
  ('admin','places','update','allow'),
  ('admin','posts','select','allow'),     ('admin','posts','insert','allow'),
  ('admin','posts','update','allow'),
  ('admin','media_assets','select','allow'),
  ('admin','comments','select','allow'),  ('admin','comments','insert','allow'),
  ('admin','comments','update','allow'),
  ('admin','likes','select','empty'),     ('admin','likes','insert','allow'),
  ('admin','likes','delete','empty'),
  ('admin','saves','select','empty'),     ('admin','saves','insert','allow'),
  ('admin','saves','delete','empty'),
  ('admin','content_blocks','select','allow'), ('admin','content_blocks','insert','allow'),
  ('admin','content_blocks','update','allow'),
  ('admin','reports','select','allow'),   ('admin','reports','insert','allow'),
  ('admin','reports','update','allow'),
  ('admin','moderation_actions','select','allow'),
  ('admin','audit_log','select','allow')
) v(role,tbl,op,outcome)
where e.role=v.role and e.tbl=v.tbl and e.op=v.op;

-- ── Assertions ───────────────────────────────────────────────
select is(
  (select count(*) from actual where outcome like 'err:%'), 0::bigint,
  'no cell errored for a non-authorization reason — an err: here is a broken fixture masquerading as a result');

-- §2: "Zero database reads for public visitors." Asserted separately from the matrix
-- because it is the single most load-bearing property in the privilege model: it is
-- what makes a leaked anon key uninteresting.
select is(
  (select count(*) from actual where role='anon' and outcome <> 'deny'), 0::bigint,
  'all 64 anon cells are deny — the anon key reaches nothing at all');

select set_eq(
  'select role||''|''||tbl||''|''||op||''|''||outcome from actual',
  'select role||''|''||tbl||''|''||op||''|''||outcome from expected',
  '256 cells: every allow, empty and deny matches the policy files');

select * from finish();
rollback;
