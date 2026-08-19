-- 0036 · Takedown — the database half
--
-- §8: "On takedown: (1) delete/rename the object in R2 immediately, (2) purge the CDN path,
-- (3) add the ID to the short-TTL redactions.json that clients filter against, (4) write an
-- audit row. The next scheduled publish removes it from the shards as a formality — the
-- bytes are already gone."
--
-- Steps 1–3 need R2 and Cloudflare credentials and live in the takedown Edge Function.
-- This file is step 4 and the thing that makes steps 1–3 possible: marking the post, under
-- a role check, and handing back the exact list of objects to delete.
--
-- ── Order: the mark first, then the bytes ────────────────────
--
-- §8 says "immediately" about the bytes, and the Edge Function does delete them within the
-- same request. But the DATABASE is marked first, and the order is deliberate. The two
-- possible half-done states are not equally bad:
--
--   bytes deleted, not marked   the archive still lists the item, its media 404s, and
--                               every visitor sees a broken card. Public, immediate, and
--                               it stays that way until someone notices.
--
--   marked, bytes not deleted   the item is gone from redactions-filtered clients and from
--                               the next release, and the bytes sit at an unguessable v4
--                               path that nothing links to. Recoverable by retrying, and
--                               invisible in the meantime.
--
-- So: mark, then delete, then report which deletions failed.
--
-- ── A capability that was reachable and should not have been ─
--
-- Before this migration, `takedown` was in the column-UPDATE grant to `authenticated`, and
-- posts_update's USING clause is `created_by = auth.uid() OR is_moderator()`. A member
-- could therefore set takedown = true on their own post — and 0012's audit trigger would
-- faithfully write `actor = <that member>, action = 'post.takedown'` into
-- moderation_actions.
--
-- §4's capability table grants "Trigger takedown" to moderator and admin, and not to
-- member. Nothing catastrophic followed from the gap — a member could only affect their own
-- post, and the Edge Function checks the role before deleting any bytes — but the
-- moderation ledger is a record other people rely on, and a row in it saying a moderation
-- action happened when a member pressed something is a false entry in the one place that is
-- supposed to be true.
--
-- Members who want their own content gone still have `status = 'withdrawn'`, which is what
-- that enum value is for and which the ledger records as the author's act rather than a
-- moderator's.

set search_path = public, extensions;

revoke update (takedown) on public.posts from authenticated;

comment on column public.posts.takedown is
  'CLAUDE.md §8. Set only through request_takedown() — moderator and admin (§4).';

-- ── The reason, carried to the ledger ────────────────────────
--
-- 0012's trigger writes moderation_actions without a note, because it cannot know one: it
-- sees a row change, not why. A takedown without a recorded reason is a poor record of a
-- decision that may later need explaining to the person it affected.
--
-- A transaction-local GUC rather than an argument, because the writer is a TRIGGER and a
-- trigger takes no arguments. `set_config(..., true)` is transaction-scoped, so it cannot
-- leak into the next statement on a pooled connection — which a session-scoped setting
-- absolutely would, and would then attach one takedown's reason to an unrelated later one.
--
-- ── The body below is 0026's, not 0012's ─────────────────────
--
-- posts_write_audit has been replaced three times: 0012 created it, 0014 added the
-- `.self` suffix for a moderator approving their own post, and 0026 added the `ingest.*`
-- action names. CREATE OR REPLACE takes whatever text it is given, so rebuilding this
-- function from the ORIGINAL migration silently reverts every later one — which is exactly
-- what the first version of this file did, and what 07_triggers and 10_ingest_rpcs caught:
-- self-approvals stopped reaching moderation_actions and ingest failures stopped being
-- named in the audit log.
--
-- 0026's comment says it outright: "approved.self is here because 0014 put it here;
-- dropping it would silently stop self-approvals reaching moderation_actions." So the body
-- below is copied from 0026 and altered in exactly two places — the v_note declaration and
-- the moderation_actions insert.
create or replace function public.posts_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_action     text;
  v_before     jsonb;
  v_privileged boolean;
  v_note       text;
begin
  if tg_op = 'INSERT' then
    v_action := 'post.create';
    v_before := null;
  else
    v_before := public.post_audit_snapshot(old);
    if old.status is distinct from new.status then
      v_action := 'post.status.' || new.status::text;
      -- From 0014, and preserved verbatim. §4 permits a moderator to publish their own
      -- content; a separation-of-duties gap you cannot close, you make queryable.
      if new.status = 'approved'
         and new.approved_by is not null
         and new.approved_by is not distinct from new.created_by then
        v_action := v_action || '.self';
      end if;
    elsif old.takedown is distinct from new.takedown then
      v_action := case when new.takedown then 'post.takedown' else 'post.restore' end;
    elsif old.ingest_state is distinct from new.ingest_state then
      -- Named for the outcome rather than the state, because that is what a human
      -- reading the log wants: 'ingest.complete', not 'ingest.ready'.
      v_action := case new.ingest_state
                    when 'ready'  then 'ingest.complete'
                    when 'failed' then 'ingest.failed'
                    else 'ingest.' || new.ingest_state::text
                  end;
    else
      v_action := 'post.edit';
    end if;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (auth.uid(), v_action, 'post', new.id, v_before, public.post_audit_snapshot(new));

  -- Ingest is not a moderation decision and does not belong in the team-readable log.
  -- approved.self is here because 0014 put it here; dropping it would silently stop
  -- self-approvals reaching moderation_actions.
  v_privileged := v_action in (
    'post.status.approved', 'post.status.approved.self',
    'post.status.rejected', 'post.status.withdrawn',
    'post.takedown', 'post.restore'
  );

  if v_privileged then
    -- The reason, when the caller supplied one. `true` as the second argument: an unset
    -- GUC yields NULL rather than raising, and every write to this table other than a
    -- takedown happens without one.
    v_note := nullif(btrim(coalesce(current_setting('rma.moderation_note', true), '')), '');
    insert into public.moderation_actions (actor, action, target_type, target_id, note)
    values (auth.uid(), v_action, 'post', new.id, v_note);
  end if;

  return null;
end;
$$;

comment on function public.posts_write_audit() is
  'CLAUDE.md §4 — no privileged action bypasses the audit trail, because it is a trigger.';

-- ── The RPC ──────────────────────────────────────────────────

/*
 * Mark a post taken down and return what has to be deleted.
 *
 * SECURITY DEFINER with an explicit is_moderator() check rather than relying on RLS, for
 * two reasons: the column grant is now revoked so RLS could not permit it anyway, and the
 * caller needs a NAMED refusal — a member who pressed something that silently did nothing
 * learns less than one who is told they may not.
 *
 * Returns every asset, in BOTH buckets. The archival master goes too. §6 keeps originals/
 * off the CDN and calls it the preservation copy, and it is — right up until the moment
 * someone asks for the material to be removed, at which point "we still hold it, just
 * privately" is not what was asked for and not what was agreed.
 */
create or replace function public.request_takedown(p_post_id uuid, p_note text default null)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_post    public.posts%rowtype;
  v_objects jsonb;
begin
  if not public.is_moderator() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  select * into v_post from public.posts where id = p_post_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_post');
  end if;

  -- Collected BEFORE the update, though nothing about the update touches media_assets —
  -- so that the list returned is unambiguously the state the decision was made against.
  select coalesce(jsonb_agg(jsonb_build_object(
           'bucket', m.bucket, 'path', m.storage_path, 'role', m.role)
         order by m.bucket, m.storage_path), '[]'::jsonb)
    into v_objects
    from public.media_assets m where m.post_id = p_post_id;

  -- Idempotent. A moderator who retries after a failed byte deletion must get the object
  -- list back, not a refusal — retrying IS the recovery path for the half-done state this
  -- function's ordering deliberately chooses.
  if v_post.takedown then
    return jsonb_build_object('ok', true, 'reason', 'already_taken_down',
                              'post_id', p_post_id, 'objects', v_objects);
  end if;

  perform set_config('rma.moderation_note', coalesce(p_note, ''), true);

  update public.posts set takedown = true where id = p_post_id;

  return jsonb_build_object('ok', true, 'reason', 'taken_down',
                            'post_id', p_post_id, 'objects', v_objects);
end;
$$;

comment on function public.request_takedown(uuid, text) is
  'CLAUDE.md §8 step 4 — mark the post and return the objects the caller must delete.';

-- authenticated, because it runs as the caller and checks is_moderator() from the database
-- rather than from anything the caller said. A member calling it directly gets 'forbidden'.
revoke execute on function public.request_takedown(uuid, text) from public, anon;
grant execute on function public.request_takedown(uuid, text) to authenticated, service_role;
