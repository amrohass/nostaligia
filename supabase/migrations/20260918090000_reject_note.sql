-- 0064 · A rejection carries a reason, and the contributor can read it
--
-- Until now a moderator rejected by PATCHing `status = 'rejected'` and nothing else, so a
-- member's own list said "لم تُقبل" and nothing more — indistinguishable from a verdict with
-- no reasoning behind it. `moderation_actions.note` has existed since 0010 and was wired by
-- 0036 for takedown only: posts_write_audit reads it from the transaction-local GUC
-- `rma.moderation_note`, and nothing on the rejection path ever set it.
--
-- Three pieces, no table, column or type change:
--
--   1  posts_rejection_needs_note   the rule, as a trigger — a transition INTO 'rejected'
--                                   made from a user session is refused without a note.
--   2  reject_post(id, note)        how a note gets to that trigger. PostgREST cannot set
--                                   an arbitrary GUC, so a PATCH cannot carry one.
--   3  my_rejections()              how the author reads it back: note and DAY, nothing else.
--
-- ── Why the rule is a trigger and not only the RPC ───────────
--
-- §5: admin.js is hostile too. If reject_post were the only place a note was required, the
-- PATCH admin.js used until today would still reject silently — from a stale tab, from
-- curl, from anybody holding a moderator's token. The trigger makes the note a property of
-- the TRANSITION, whichever door it came through; the RPC is merely the one door that can
-- satisfy it. `UPDATE OF status` is exact rather than approximate: posts_enforce_approval
-- can move a row to 'pending' on its own, never to 'rejected', so a row only becomes
-- rejected when a caller names the column.
--
-- A session with no auth.uid() is exempt, and that is the posts_stamp_authorship
-- precedent rather than a gap. anon holds no UPDATE on posts at all, so every write a
-- browser can make arrives WITH a uid; the only writers without one are the service role
-- and a maintainer at psql, who are outside §5's boundary by definition.
--
-- ── Why the author's read is a function and not a policy ─────
--
-- The request was an RLS SELECT policy on moderation_actions, and it would have leaked the
-- one thing it was told not to. RLS chooses ROWS; which COLUMNS a role may read is a grant,
-- and 0015 grants `authenticated` SELECT on moderation_actions.actor because moderators and
-- members are the same database role. A policy admitting the author to their own rejection
-- row therefore admits them to `select=actor` on it — the uuid of the moderator who turned
-- them down. The only ways to close that are to withdraw `actor` from every moderator too,
-- or not to hand out the row at all.
--
-- my_rejections() does the second, the way posts_full() and profile_view() already do for
-- their tables. It returns exactly three columns, and the date is a DATE — §7 publishes
-- days, not times, and a rejection timestamp to the second is a fact about when a
-- particular moderator was at their desk.

set search_path = public, extensions;

-- ── 1 · The rule ─────────────────────────────────────────────
--
-- Reads the GUC exactly as posts_write_audit does — trimmed, empty as absent — so the check
-- and the write can never disagree about what counts as a note. A note that passes here is
-- the note that lands in moderation_actions.
create or replace function public.posts_require_rejection_note()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null
     and nullif(btrim(coalesce(current_setting('rma.moderation_note', true), '')), '') is null then
    raise exception 'a rejection must carry a note for the contributor — use reject_post()'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.posts_require_rejection_note() is
  'CLAUDE.md §5 — a transition into rejected from a user session needs rma.moderation_note set (0064).';

-- Sorts after posts_bidi_strip, which 25_bidi requires to stay the first BEFORE trigger.
create trigger posts_rejection_needs_note
  before update of status on public.posts
  for each row
  when (new.status = 'rejected' and old.status is distinct from 'rejected')
  execute function public.posts_require_rejection_note();

-- ── 2 · reject_post ──────────────────────────────────────────
--
-- SECURITY INVOKER, like set_post_location (0049): it grants nobody anything. The UPDATE
-- runs as the caller, so 0018's posts_update policy and 0015's column grants decide
-- exactly as they would for the PATCH it replaces. What the function adds is the note, in
-- the one place a trigger can read it.
--
-- The moderator check is a courtesy in the same sense: without it a member calling this on
-- their own post is refused by posts_update's WITH CHECK anyway, as a raw 42501. With it
-- they get a reason.
--
-- Bidi controls are stripped because this string crosses from one person to another — it
-- is written by a moderator and read by a contributor, which is §6's case exactly.
--
-- Trimmed as [[:space:]], NOT with btrim(). btrim's default set is the space character
-- alone, so a note of one tab survived it, passed as a reason, and reached the contributor
-- as a blank line under "not accepted". 41_reject_note assertion 2 found it.
create or replace function public.reject_post(p_post_id uuid, p_note text)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  v_note   text := regexp_replace(public.strip_bidi(coalesce(p_note, '')),
                                  '^[[:space:]]+|[[:space:]]+$', '', 'g');
  v_status public.post_status;
begin
  if not public.is_moderator() then
    return jsonb_build_object('ok', false, 'reason', 'forbidden');
  end if;

  if v_note = '' then
    return jsonb_build_object('ok', false, 'reason', 'note_required');
  end if;

  -- The table's own ceiling (moderation_actions_note_length), answered by name rather than
  -- as a constraint violation from inside an AFTER trigger.
  if char_length(v_note) > 4000 then
    return jsonb_build_object('ok', false, 'reason', 'note_too_long');
  end if;

  select status into v_status from public.posts where id = p_post_id;
  if not found then
    return jsonb_build_object('ok', false, 'reason', 'unknown_post');
  end if;

  -- A second rejection is not a transition: no trigger fires, no action is written, and the
  -- note would go nowhere. Said, rather than reported as a success that recorded nothing.
  if v_status = 'rejected' then
    return jsonb_build_object('ok', false, 'reason', 'already_rejected');
  end if;

  perform set_config('rma.moderation_note', v_note, true);

  update public.posts set status = 'rejected' where id = p_post_id
  returning status into v_status;

  if v_status is distinct from 'rejected' then
    return jsonb_build_object('ok', false, 'reason', 'not_found_or_refused');
  end if;

  return jsonb_build_object('ok', true, 'post_id', p_post_id, 'status', v_status);
end;
$$;

comment on function public.reject_post(uuid, text) is
  'A moderator rejects a post with a note the contributor will read (0064). Runs as the caller.';

revoke execute on function public.reject_post(uuid, text) from public, anon;
grant  execute on function public.reject_post(uuid, text) to authenticated, service_role;

-- ── 3 · my_rejections ────────────────────────────────────────
--
-- The author's own CURRENTLY rejected posts, each with its latest rejection. Scoped by
-- auth.uid() inside the function, so the caller supplies nothing that could name somebody
-- else's post. A rejection recorded before 0064 has no note and comes back with note NULL
-- and its date — true, and more than the member had.
--
-- `action = 'post.status.rejected'` is the filter that keeps a TAKEDOWN note out of this:
-- 0036's notes are written for the moderation ledger, not for the person whose photograph
-- was removed, and the same post can carry both.
create or replace function public.my_rejections()
returns table (post_id uuid, note text, rejected_on date)
language sql
stable
security definer
set search_path = ''
as $$
  select distinct on (p.id)
         p.id,
         m.note,
         (m.created_at at time zone 'UTC')::date
    from public.posts p
    join public.moderation_actions m
      on m.target_type = 'post'
     and m.target_id   = p.id
     and m.action      = 'post.status.rejected'
   where (select auth.uid()) is not null
     and p.created_by = (select auth.uid())
     and p.status = 'rejected'
   order by p.id, m.created_at desc;
$$;

comment on function public.my_rejections() is
  'The caller''s own rejected posts: note and day only — never the moderator (0064).';

revoke execute on function public.my_rejections() from public, anon;
grant  execute on function public.my_rejections() to authenticated, service_role;
