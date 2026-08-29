-- Withdrawal — 0051's anonymize-in-place, from every angle that could go wrong.
--
-- §7 gives a contributor the right to withdraw; §3 makes audit rows permanent. 0051
-- reconciles them by destroying the IDENTITY and keeping the CONTRIBUTIONS, which means
-- this file has to assert two opposite things at once and would be worthless if it only
-- asserted one:
--
--   the identity is GONE      handle is a tombstone, display_name / avatar / bio are NULL,
--                             visibility is fully private, and none of it comes back
--                             through profile_view() or through a shard.
--   the archive is INTACT     the approved post is still publishable, still carries its
--                             body, and still carries a byline — the tombstone one.
--
-- A test that checked only the first would pass against an implementation that deleted the
-- archive, which is the failure mode this design exists to avoid.
--
-- ── Refusals are asserted on the STORED ROW, not on the return ─
--
-- Every "may not" below re-reads the target and asserts it is unchanged. Asserting that
-- the call returned `forbidden` is not the same claim: a function that refuses AND scrubs
-- would satisfy it, and so would one that scrubs and then reports a refusal. This is the
-- same trap that made a deployed harness assert "a member cannot approve their own upload"
-- by treating any non-2xx as proof — a privilege error is a 403 too, and the assertion
-- stayed green for the wrong reason.
--
-- ── The tombstone is never spelled out here ──────────────────
--
-- 0051 derives it as sha256(id) truncated. A test that recomputed that expression would
-- pass against any implementation computing the same wrong thing, so the handle is read
-- back once into `tomb` and carried by reference everywhere after.
--
-- Shape and distinctness are NOT enough, and that is a measured claim rather than a
-- cautious one: mutation-tested 29 Aug 2026, reverting the derivation to
-- `substr(replace(id, '-', ''), 1, n)` leaves every other assertion in this file green.
-- The collision loop rescues it — it extends 12 characters to 13 and both accounts get a
-- legal, distinct handle. So the derivation has its own assertion, on the property the
-- loop cannot supply: the tombstone must not be a prefix of the uuid it came from.

begin;
create extension if not exists pgtap;

-- 5 authorization · 14 the self-delete · 4 the permanent record · 3 idempotence
-- 5 the admin path · 7 the read paths afterwards · 4 the tombstone
-- 3 permanence and the role · 2 the publish signal
select plan(47);

-- ── Fixtures ─────────────────────────────────────────────────
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'member@t.local'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod@t.local'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin@t.local'),
  ('00000000-0000-0000-0000-0000000000a4', 'other@t.local');

insert into public.user_roles (user_id, role) values
  ('00000000-0000-0000-0000-0000000000a2', 'moderator'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin');

insert into public.profiles (id, handle, display_name, avatar_path, bio, visibility) values
  ('00000000-0000-0000-0000-0000000000a1', 'member_one', 'عضو', 'avatars/a1.webp', 'نبذة علنية',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  ('00000000-0000-0000-0000-0000000000a2', 'mod_one', 'مشرف', null, null,
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  ('00000000-0000-0000-0000-0000000000a3', 'admin_one', 'مدير', null, null,
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}'),
  ('00000000-0000-0000-0000-0000000000a4', 'other_one', 'آخر', 'avatars/a4.webp', 'نبذة أخرى',
   '{"bio":"public","personalInfo":"public","contributions":"public","comments":"public"}');

-- An APPROVED post by the member who is about to withdraw. Everything about "the archive
-- survives" turns on this row.
insert into public.posts
  (id, kind, title_ar, body_ar, status, created_by, location_precision,
   license, provenance, approved_by, approved_at, content_hash)
values
  ('00000000-0000-0000-0000-0000000000b1','media','صورة قديمة','نص المساهمة','approved',
   '00000000-0000-0000-0000-0000000000a1','hidden',
   'CC BY-SA 4.0','ألبوم العائلة','00000000-0000-0000-0000-0000000000a2',now(),
   'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  ('00000000-0000-0000-0000-0000000000b4','media','صورة أخرى','نص آخر','approved',
   '00000000-0000-0000-0000-0000000000a4','hidden',
   'CC BY-SA 4.0','ألبوم','00000000-0000-0000-0000-0000000000a2',now(),
   'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

-- A PUBLISHED comment by the withdrawing member on somebody else's item. It must keep its
-- text and lose its name, exactly like the post above.
insert into public.comments (id, post_id, body, lang, status, created_by) values
  ('00000000-0000-0000-0000-0000000000c1','00000000-0000-0000-0000-0000000000b4',
   'تعليق منشور','ar','published','00000000-0000-0000-0000-0000000000a1');

insert into public.likes (user_id, post_id) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b4');
insert into public.saves (user_id, post_id) values
  ('00000000-0000-0000-0000-0000000000a1','00000000-0000-0000-0000-0000000000b4');
insert into public.upload_quota (user_id, day, count, bytes) values
  ('00000000-0000-0000-0000-0000000000a1', current_date, 3, 1024);
insert into public.reports (id, target_type, target_id, reason, reported_by) values
  ('00000000-0000-0000-0000-0000000000d1','post','00000000-0000-0000-0000-0000000000b4',
   'سبب البلاغ','00000000-0000-0000-0000-0000000000a1');

-- ═══ 1 · Who may call it ═════════════════════════════════════

-- anon is refused at the GRANT, one layer earlier than the others: 0051 revokes EXECUTE
-- rather than relying on the auth.uid() guard inside. That is deliberate and worth pinning
-- as 42501 rather than as 'forbidden' — a signed-out caller has no account to withdraw and
-- no id to name, so there is nothing for the function body to reason about.
set local role anon;
set local request.jwt.claims to '';
select throws_ok(
  $q$ select public.request_account_deletion('00000000-0000-0000-0000-0000000000a1') $q$,
  '42501', null,
  'anon cannot even call it — refused at the grant, not inside the body');
reset role;

-- A member aiming at somebody else. The refusal and the untouched row are two assertions
-- on purpose: see the header.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  public.request_account_deletion('00000000-0000-0000-0000-0000000000a4') ->> 'reason',
  'forbidden',
  'a member may not delete another member''s account');
reset role;

select results_eq(
  $q$ select handle, display_name, deleted_at from public.profiles
      where id = '00000000-0000-0000-0000-0000000000a4' $q$,
  $q$ values ('other_one'::text, 'آخر'::text, null::timestamptz) $q$,
  '...and the target row is byte-identical afterwards, not merely un-reported');

-- §4 gives "Manage users / roles" to admin alone. A moderator has every content power and
-- not this one.
set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select is(
  public.request_account_deletion('00000000-0000-0000-0000-0000000000a4') ->> 'reason',
  'forbidden',
  'a MODERATOR may not delete an account — §4 gives that row of the table to admin');
reset role;

select is(
  (select deleted_at from public.profiles where id = '00000000-0000-0000-0000-0000000000a4'),
  null,
  '...and the moderator''s refusal left deleted_at unset');

-- ═══ 2 · A member withdraws ══════════════════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select is(
  public.request_account_deletion() ->> 'reason',
  'deleted',
  'a member may withdraw their own account with no argument at all');
reset role;

-- Read back once. Every later assertion refers to this rather than respelling 0051's
-- derivation — see the header.
create temp table tomb as
  select handle as h from public.profiles where id = '00000000-0000-0000-0000-0000000000a1';

select matches(
  (select h from tomb),
  '^deleted_user_[0-9a-f]{12,17}$',
  'the handle becomes a tombstone of the documented shape');

select isnt(
  (select h from tomb), 'member_one',
  '...and is not the handle they arrived with');

select results_eq(
  $q$ select display_name, avatar_path, bio from public.profiles
      where id = '00000000-0000-0000-0000-0000000000a1' $q$,
  $q$ values (null::text, null::text, null::text) $q$,
  'display_name, avatar_path and bio are all NULL');

select is(
  (select visibility from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  '{"bio":"private","personalInfo":"private","contributions":"private","comments":"private"}'::jsonb,
  'visibility is fully private — every gateable field closed');

select isnt(
  (select deleted_at from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  null,
  'deleted_at is stamped');

-- The retry list. A deletion whose GoTrue half never ran is findable by exactly this
-- predicate, which is the only reason the two columns are separate.
select is(
  (select auth_scrubbed_at from public.profiles where id = '00000000-0000-0000-0000-0000000000a1'),
  null,
  'auth_scrubbed_at is still NULL — the Edge Function half is owed and findable');

-- What the archive keeps. Both halves of 0051's sentence, adjacent so neither can be
-- weakened without the other going red.
select is(
  (select body_ar from public.posts where id = '00000000-0000-0000-0000-0000000000b1'),
  'نص المساهمة',
  'the withdrawn member''s approved post keeps its body');
select is(
  (select created_by from public.posts where id = '00000000-0000-0000-0000-0000000000b1'),
  '00000000-0000-0000-0000-0000000000a1'::uuid,
  '...and its created_by, which is an opaque uuid no browser role is granted');
select is(
  (select body from public.comments where id = '00000000-0000-0000-0000-0000000000c1'),
  'تعليق منشور',
  '...and their published comment keeps its text');

-- The engagement rows, per the 29 Aug decision.
select is((select count(*) from public.likes
            where user_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint,
  'likes are removed — a surviving user_id→post mapping outlives the identity scrub');
select is((select count(*) from public.saves
            where user_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint,
  'saves are removed');
select is((select count(*) from public.upload_quota
            where user_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint,
  'upload_quota rows are removed');
select results_eq(
  $q$ select reported_by, reason from public.reports
      where id = '00000000-0000-0000-0000-0000000000d1' $q$,
  $q$ values (null::uuid, 'سبب البلاغ'::text) $q$,
  'a report they filed survives, unlinked — a moderator''s queue does not lose items');

-- ═══ 3 · What the permanent record is allowed to remember ════

select is(
  (select count(*) from public.audit_log
    where action = 'account.delete'
      and target_id = '00000000-0000-0000-0000-0000000000a1'), 1::bigint,
  'exactly one audit_log row records the deletion');

-- The 29 Aug decision, asserted rather than trusted: §3 makes this row immortal, so an old
-- handle written into it would survive the erasure it is supposed to record.
select is(
  (select (before ? 'handle') or (before ? 'display_name') or (before ? 'bio')
     from public.audit_log
    where action = 'account.delete'
      and target_id = '00000000-0000-0000-0000-0000000000a1'),
  false,
  'the permanent `before` snapshot carries NO old handle, display name or bio');

select is(
  (select after ->> 'handle' from public.audit_log
    where action = 'account.delete'
      and target_id = '00000000-0000-0000-0000-0000000000a1'),
  (select h from tomb),
  '...and `after` carries the tombstone, which identifies nobody');

-- A member erasing themselves is not a decision anyone made about anybody else. Same line
-- 0036 draws between post.takedown and a member's own withdrawal.
select is(
  (select count(*) from public.moderation_actions
    where action like 'account.delete%'
      and target_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint,
  'a self-deletion writes NO moderation_actions row');

-- ═══ 4 · Idempotence ═════════════════════════════════════════
--
-- The second half runs over HTTP and can fail alone, so the recovery path is calling this
-- again. A refusal here would strand the GoTrue half permanently.

select is(
  (select public.request_account_deletion('00000000-0000-0000-0000-0000000000a1')
     ->> 'reason'),
  'already_deleted',
  'a second call reports already_deleted rather than refusing');

select is(
  (select count(*) from public.audit_log
    where action = 'account.delete'
      and target_id = '00000000-0000-0000-0000-0000000000a1'), 1::bigint,
  '...and writes no second audit row');

-- mark_account_auth_scrubbed refuses to stamp an account nobody anonymized: the ordering
-- IS the safety property, so it is checked rather than assumed.
select is(
  public.mark_account_auth_scrubbed('00000000-0000-0000-0000-0000000000a3') ->> 'reason',
  'not_deleted',
  'the GoTrue receipt refuses an account that was never anonymized');

-- ═══ 5 · An admin deletes somebody else ══════════════════════

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a3","role":"authenticated"}';
select is(
  public.request_account_deletion('00000000-0000-0000-0000-0000000000a4', 'طلب حذف') ->> 'reason',
  'deleted',
  'an admin may delete another account');
reset role;

-- These two fixture uuids differ only in their last byte, so a prefix-derived tombstone
-- hands both accounts the same twelve characters. This is the collision LOOP's assertion:
-- it must extend until the handles differ rather than raise on the unique index in the
-- middle of somebody's erasure.
select isnt(
  (select handle from public.profiles where id = '00000000-0000-0000-0000-0000000000a4'),
  (select h from tomb),
  'two withdrawn accounts get DIFFERENT tombstones, whatever their ids look like');

-- And this is the DERIVATION's, which the loop does not imply — mutation-tested 29 Aug:
-- reverting sha256 to `substr(replace(id, '-', ''), 1, n)` leaves every other assertion in
-- this file green, because the loop simply extends 12 to 13 and both accounts get a legal,
-- distinct handle.
--
-- What the loop cannot rescue is the reason for hashing. `profile/<handle>.json` is a
-- public, CDN-cached, year-immutable file, so its NAME is published to everyone forever.
-- §7 calls the user id the join key and the de-anonymisation vector, and 0044 deliberately
-- keeps it out of the profile shard — a prefix-derived tombstone puts 48 bits of it back
-- into the filename.
select ok(
  replace('00000000-0000-0000-0000-0000000000a1', '-', '')
    not like substr((select h from tomb), 14) || '%',
  'the tombstone is not a prefix of the account uuid — the shard filename is public forever');

select results_eq(
  $q$ select action, note from public.moderation_actions
      where target_id = '00000000-0000-0000-0000-0000000000a4'
        and action like 'account.delete%' $q$,
  $q$ values ('account.delete.admin'::text, 'طلب حذف'::text) $q$,
  '...and THIS one reaches the team-readable ledger, with the reason');

select is(
  (select actor from public.audit_log
    where action = 'account.delete.admin'
      and target_id = '00000000-0000-0000-0000-0000000000a4'),
  '00000000-0000-0000-0000-0000000000a3'::uuid,
  '...and the audit row names the admin who did it, not the person it happened to');

-- ═══ 6 · The read paths, afterwards ══════════════════════════

select is_empty(
  $q$ select 1 from public.profile_view('member_one') $q$,
  'profile_view: the old handle resolves to nobody');

select results_eq(
  $q$ select display_name, bio, is_deleted
        from public.profile_view((select h from tomb))
       where id = '00000000-0000-0000-0000-0000000000a1' $q$,
  $q$ values (null::text, null::text, true) $q$,
  'profile_view: the tombstone reports is_deleted with no name and no bio');

-- The shard side. 0044's publishable_profiles applies §7 at publish time, so a hidden list
-- is an empty list in the file rather than data the browser is asked to be discreet about.
select is(
  (select item ->> 'bio'
     from jsonb_array_elements(public.publishable_profiles()) as t(item)
    where item ->> 'handle' = (select h from tomb)
    limit 1),
  null,
  'publishable_profiles: the tombstone shard carries no bio');

select is(
  (select (item ->> 'show_contributions')::boolean or (item ->> 'show_comments')::boolean
     from jsonb_array_elements(public.publishable_profiles()) as t(item)
    where item ->> 'handle' = (select h from tomb)
    limit 1),
  false,
  '...and both list flags are false, so the shard names none of their items');

select results_eq(
  $q$ select item ->> 'author_display_name', item ->> 'author_avatar_path',
             item ->> 'body_ar'
        from jsonb_array_elements(public.publishable_posts()) as t(item)
       where item ->> 'id' = '00000000-0000-0000-0000-0000000000b1' $q$,
  $q$ values (null::text, null::text, 'نص المساهمة'::text) $q$,
  'publishable_posts: the item keeps its body and loses its author''s name');

select is(
  (select item ->> 'author_handle'
     from jsonb_array_elements(public.publishable_posts()) as t(item)
    where item ->> 'id' = '00000000-0000-0000-0000-0000000000b1'),
  (select h from tomb),
  '...and gains the tombstone byline, so the card still attributes something');

select is(
  (select c ->> 'author_handle'
     from jsonb_array_elements(public.publishable_posts()) as t(item),
          jsonb_array_elements(item -> 'comments') as u(c)
    where item ->> 'id' = '00000000-0000-0000-0000-0000000000b4'
    limit 1),
  (select h from tomb),
  '...and the published comment is attributed to the tombstone, not to a name');

-- ═══ 7 · The tombstone shape is not a handle anyone may claim ═
--
-- The old handle IS released for reuse (29 Aug decision). The marker is not.

select is(
  (select count(*) from public.profiles where handle = 'member_one'), 0::bigint,
  'the released handle is free — nothing holds it after the scrub');

set local role authenticated;
set local request.jwt.claims to '{"sub":"00000000-0000-0000-0000-0000000000a2","role":"authenticated"}';
select throws_ok(
  $q$ update public.profiles set handle = 'deleted_user_0123456789ab'
       where id = '00000000-0000-0000-0000-0000000000a2' $q$,
  '23514', null,
  'a member may not rename themselves into the tombstone shape');
reset role;

-- The exemption is scoped to the row's own id AND to the statement's transaction. A
-- session-scoped GUC would leak onto the next statement of a pooled connection and hand
-- the shape to whoever came next; a GUC not compared against the id would hand it to any
-- row in the same transaction.
select throws_ok(
  $q$ update public.profiles set handle = 'deleted_user_ffffffffffff'
       where id = '00000000-0000-0000-0000-0000000000a2' $q$,
  '23514', null,
  '...and the exemption 0051 set for a DIFFERENT row does not cover this one');

-- 17 hex is the ceiling the loop stops at, and 30 characters is is_allowed_handle()'s.
select is(
  public.is_allowed_handle('deleted_user_' || repeat('a', 17)), true,
  'the longest tombstone the loop can produce is still a legal handle');

-- ═══ 8 · Permanence, and the privilege that goes with it ═════

-- 23001 is restrict_violation, which is what 0010's trigger raises with. Worth pinning by
-- code rather than by message: this is the exact error a deployed DELETE of an auth user
-- surfaces as a bare 500, and it is the reason 0051 anonymizes instead of deleting.
select throws_ok(
  $q$ update public.audit_log set action = 'x' $q$,
  '23001', null,
  'audit_log is still append-only after all of the above');

select is(
  (select count(*) from public.user_roles
    where user_id = '00000000-0000-0000-0000-0000000000a4'), 0::bigint,
  'the deleted account holds no user_roles row');

-- The demotion is not silent: user_roles carries its own audit trigger, so a withdrawing
-- moderator leaves a permanent record of losing the privilege.
select is(
  (select count(*) from public.audit_log
    where action = 'role.revoke'
      and target_id = '00000000-0000-0000-0000-0000000000a4'), 0::bigint,
  'a member who never held a role leaves no role.revoke row');

-- ═══ 9 · The publish signal ══════════════════════════════════
--
-- 0033's WHEN clause named only the three columns a pre-M3 shard carried. 0044 put bio and
-- both visibility flags into profile/{handle}.json, so this is the gap 0051 closes — and
-- the scrub trips the OLD clause anyway, which is exactly why the bio-only case needs its
-- own assertion rather than riding on the deletion's.

select ok(
  (select content_revision from public.publish_revision) > 0,
  'the scrub raised the content revision — the release that carries it is dispatched');

create temp table rev as select content_revision as r from public.publish_revision;
update public.profiles set bio = 'نبذة جديدة'
 where id = '00000000-0000-0000-0000-0000000000a3';

select is(
  (select content_revision from public.publish_revision) - (select r from rev),
  1::bigint,
  'a bio-only edit now signals a publish — since M3 it moved shard bytes and signalled nothing');

select * from finish();
rollback;
