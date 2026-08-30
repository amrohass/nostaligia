-- M5 item 2 — a removal request is a `reports` row that enters the permanent record.
--
-- 0053 adds one column and one trigger. What is worth testing is not the column but the
-- three properties the column exists to give:
--
--   · **anyone may ask, including a non-author.** §7's subject is frequently the person IN
--     the photograph rather than the person who uploaded it, and a control only its author
--     could reach would serve everyone except them.
--   · **a removal request is audited and an abuse report is not.** The asymmetry is the
--     design (§8 puts a named human and a response time behind removal), so a test that
--     only checked "an audit row appears" would pass against a migration that audited
--     everything and doubled a table §3 forbids rotating.
--   · **the reason does not enter audit_log.** It is somebody's account of their own
--     circumstances; audit_log is moderator-readable forever and cannot be rotated.
--
-- Assertion 3 is the one that would silently rot: it asserts an ABSENCE, and an absence is
-- also what you get from a trigger that never fired. So 2 proves the trigger fires at all
-- before 3 claims it stayed quiet for the right reason.

begin;
create extension if not exists pgtap;

-- 1 who may ask · 3 the audit asymmetry · 2 §7 on the reason · 3 RLS
select plan(9);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-00000000e0c1', 'rm-author@t.local'),
  ('00000000-0000-0000-0000-00000000e0c2', 'rm-subject@t.local'),
  ('00000000-0000-0000-0000-00000000e0c3', 'rm-mod@t.local');

insert into public.user_roles (user_id, role, granted_by)
values ('00000000-0000-0000-0000-00000000e0c3', 'moderator',
        '00000000-0000-0000-0000-00000000e0c3');

-- Somebody else's post, APPROVED: the case the control exists for, since an author can
-- already withdraw their own (0018) and the person with the claim usually is not the author.
--
-- license and provenance are not decoration here: posts_approved_has_rights refuses an
-- approved row without both, which is 0032's whole subject.
insert into public.posts (id, kind, title_en, body_en, status, created_by,
                          license, provenance, consent)
values ('00000000-0000-0000-0000-00000000ef01', 'media', 'a photograph', 'of a street',
        'approved', '00000000-0000-0000-0000-00000000e0c1',
        'CC-BY-SA-4.0', 'family album',
        jsonb_build_object('granted', true, 'may_withdraw', true));

create function pg_temp.audit_rows(p_action text) returns integer
language sql stable security definer as $fn$
  select count(*)::integer from public.audit_log a
   where a.action = p_action
     and a.target_id = '00000000-0000-0000-0000-00000000ef01';
$fn$;

create function pg_temp.audit_after(p_action text) returns jsonb
language sql stable security definer as $fn$
  select a.after from public.audit_log a
   where a.action = p_action
     and a.target_id = '00000000-0000-0000-0000-00000000ef01'
   order by a.created_at desc limit 1;
$fn$;

set local role authenticated;

-- ═══ 1 · The person in the photograph, not its author ════════

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c2","role":"authenticated"}';

select lives_ok(
  $$ insert into public.reports (target_type, target_id, reason, kind)
     values ('post', '00000000-0000-0000-0000-00000000ef01',
             'I am in this photograph and I did not agree to it being published.',
             'removal') $$,
  'somebody who did not upload the post may still ask for it to be removed');

-- ═══ 2–4 · Audited, and only this kind ═══════════════════════

select is(
  pg_temp.audit_rows('removal.requested'),
  1,
  '...and the request enters the permanent record');

-- The other half of the asymmetry. Without this, assertion 4's absence would also be
-- satisfied by a trigger that audits nothing at all.
select lives_ok(
  $$ insert into public.reports (target_type, target_id, reason, kind)
     values ('post', '00000000-0000-0000-0000-00000000ef01',
             'this caption is wrong', 'abuse') $$,
  'an abuse report against the same post is filed the same way');

select is(
  pg_temp.audit_rows('removal.requested'),
  1,
  '...and does NOT add an audit row — only removals are audited');

-- ═══ 5–6 · §7 · the reason stays out of the permanent record ═

select is(
  pg_temp.audit_after('removal.requested') ->> 'kind',
  'removal',
  'the audit row records THAT a removal was asked for');

select is(
  (pg_temp.audit_after('removal.requested')::text ilike '%photograph%'),
  false,
  '...and never the requester''s own words about their own circumstances');

-- ═══ 7 · The default keeps old rows meaning what they meant ══

select is(
  (select r.kind::text from public.reports r
    where r.reason = 'this caption is wrong'),
  'abuse',
  'a client that never heard of `kind` still files a valid abuse report');

-- ═══ 8–9 · RLS · a report is visible to its author and moderators ONLY
--
-- 0020: "revealing a reporter to the person they reported is how you get retaliation, and
-- in this archive retaliation is not hypothetical." The author of the post is exactly the
-- person who must not see who asked.

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c1","role":"authenticated"}';

select is(
  (select count(*)::integer from public.reports r
    where r.target_id = '00000000-0000-0000-0000-00000000ef01'),
  0,
  'the post''s AUTHOR cannot see that a removal was requested, or by whom');

set local request.jwt.claims to
  '{"sub":"00000000-0000-0000-0000-00000000e0c3","role":"authenticated"}';

select is(
  (select count(*)::integer from public.reports r
    where r.target_id = '00000000-0000-0000-0000-00000000ef01'),
  2,
  'a moderator sees both, which is the queue this control feeds');

reset role;
select * from finish();
rollback;
