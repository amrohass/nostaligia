-- 0053 · M5 item 2 — the removal request, and why it is a `reports` row
--
-- CLAUDE.md §10 M5 lists "removal-request control". 0004's profiles table already named the
-- shape it was waiting for: "No DELETE: account removal is a request flow with an audit
-- trail (M5), not a [delete]".
--
-- ── Why not a new table ──────────────────────────────────────
--
-- §12 asks for the smallest change that satisfies the task, and `reports` already IS this
-- table: a target_type/target_id pair, a free-text reason bounded at 2000 characters, a
-- reporter stamped by trigger rather than trusted from the client, an open/reviewing/closed
-- lifecycle, an RLS policy that shows a row to its author and to moderators AND TO NOBODY
-- ELSE, and a dashboard panel already rendering it. A second table would duplicate every
-- one of those and add a second queue for a moderator to forget to look at.
--
-- What it lacked is the distinction a moderator needs in the first second of triage, so
-- that is all this adds.
--
-- ── Why the distinction is not cosmetic ──────────────────────
--
-- An abuse report and a removal request are different obligations. An abuse report asks
-- "does this break a rule?", and the answer may legitimately be no. A removal request is
-- somebody asserting a right over material about themselves — §7's whole subject — and §8
-- puts a named human and a stated response time behind it as a launch gate. A queue that
-- renders both as "report" invites the second to be triaged at the speed of the first.
--
-- ── Anyone may ask, and that is deliberate ───────────────────
--
-- The INSERT policy is unchanged and already admits any signed-in user against any target.
-- That is exactly right here and worth stating so nobody "fixes" it: the person with the
-- strongest claim to have a photograph removed is frequently NOT its uploader. They are the
-- person in it. An author-only control would serve everyone except the people §7 is about.
--
-- An author removing their OWN post still does not need this: 0018's posts_update policy
-- lets them set status='withdrawn' directly. This is for the material they do not control —
-- and note what it does NOT do on its own: withdrawal leaves the bytes in the bucket, and
-- only §8's takedown deletes them. This raises the request; a moderator runs the takedown.

create type public.report_kind as enum ('abuse', 'removal');

comment on type public.report_kind is
  'CLAUDE.md §7/§10 — an abuse report asks whether a rule was broken; a removal request asserts a right.';

-- DEFAULT 'abuse' so every existing row keeps the meaning it was filed under, and so a
-- client that has never heard of this column still files a valid report.
alter table public.reports
  add column kind public.report_kind not null default 'abuse';

-- 0015 grants this table column by column; a column absent from the grant is one PostgREST
-- refuses with `permission denied` regardless of what the policy says.
grant insert (kind) on public.reports to authenticated;

-- Moderators open this queue filtered, and `status` alone does not narrow it. Partial,
-- because a closed removal request is history rather than work.
create index if not exists reports_open_removals_idx
  on public.reports (created_at desc)
  where kind = 'removal' and status <> 'closed';

-- ── The audit trail 0004 promised ────────────────────────────
--
-- Only removal requests are audited, and the asymmetry is intentional rather than lazy. An
-- abuse report is already its own permanent record in this table — §3's "audit rows are
-- permanent" is about privileged actions and about the archival record, and duplicating
-- every report into audit_log would double the row count of the table that must never be
-- rotated in order to record something already recorded beside it.
--
-- A removal request is different in one specific way: it starts a clock that §8 attaches a
-- named human and a response time to. The audit row is what makes "when was this asked?"
-- answerable from the permanent record rather than from a table a moderator can close.
--
-- SECURITY DEFINER because audit_log takes no INSERT grant from any browser role (0020:
-- "rows arrive from SECURITY DEFINER triggers"), which is the property that stops a member
-- writing their own history.
create or replace function public.reports_audit_removal()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.kind <> 'removal' then
    return new;
  end if;

  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (
    new.reported_by,
    'removal.requested',
    new.target_type::text,
    new.target_id,
    null,
    -- The REASON is deliberately not copied here. It is the requester's own words about
    -- their own safety, it already lives on the row this points at under an RLS policy
    -- that shows it to the requester and to moderators only, and audit_log is readable by
    -- every moderator forever and can never be rotated (§3). Recording that a request
    -- exists is the archival fact; recording what somebody said about their own
    -- circumstances, permanently, is a §7 exposure dressed as diligence.
    jsonb_build_object('report_id', new.id, 'kind', new.kind::text, 'status', new.status::text)
  );

  return new;
end;
$$;

comment on function public.reports_audit_removal() is
  'CLAUDE.md §7 (M5) — a removal request enters the permanent record; its reason does not.';

drop trigger if exists reports_audit_removal on public.reports;

-- AFTER, so the row exists and carries the id the audit entry points at, and so a rejected
-- INSERT never leaves an audit row for a request that was not filed.
create trigger reports_audit_removal
  after insert on public.reports
  for each row
  execute function public.reports_audit_removal();
