-- 0020 · RLS — reports, moderation_actions, audit_log, content_blocks,
--               and the four tables with no policy at all
--
-- ── reports ──────────────────────────────────────────────────
-- A reporter sees their own report; moderators see all. Nobody else sees any,
-- which is the entire protection: revealing a reporter to the person they reported
-- is how you get retaliation, and in this archive retaliation is not hypothetical.
create policy reports_select on public.reports
  for select to authenticated
  using (
       reported_by = (select auth.uid())
    or public.is_moderator()
  );

-- reported_by and status are stamped by trigger (0014); neither is in the grant.
create policy reports_insert on public.reports
  for insert to authenticated
  with check (
        (select auth.uid()) is not null
    and reported_by = (select auth.uid())
    and status = 'open'
  );

-- Only a moderator changes a report's state. A reporter cannot close their own
-- report, and cannot reopen one that was closed.
create policy reports_update on public.reports
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

-- No DELETE: a closed report is a record.

-- ── moderation_actions ───────────────────────────────────────
-- §4 and the existing dashboard both describe this as team-visible: "the decision is
-- written to the admin log, visible to the team only".
create policy moderation_actions_select on public.moderation_actions
  for select to authenticated
  using (public.is_moderator());

-- No INSERT policy and no INSERT grant. Rows arrive from SECURITY DEFINER triggers
-- on the tables where decisions actually happen. A moderator who can INSERT here can
-- fabricate a record of someone else's decision — or, worse, of their own.

-- ── audit_log ────────────────────────────────────────────────
-- Admin-only. §4 does not extend audit access to moderators, and the audit trail
-- contains the before/after of every content change including raw coordinates.
create policy audit_log_select on public.audit_log
  for select to authenticated
  using (public.is_admin());

-- No INSERT/UPDATE/DELETE policy. Inserts come from SECURITY DEFINER triggers;
-- UPDATE, DELETE and TRUNCATE are refused for EVERY role by the append-only trigger
-- in 0010, service_role and the table owner included.

-- ── content_blocks ───────────────────────────────────────────
-- §4: editing site copy is the one capability that is admin-only and not shared with
-- moderators. Published copy is readable by any signed-in user; `draft` is not in
-- the grant at all and comes back through content_blocks_draft().
create policy content_blocks_select on public.content_blocks
  for select to authenticated
  using (true);

create policy content_blocks_insert on public.content_blocks
  for insert to authenticated
  with check (public.is_admin());

create policy content_blocks_update on public.content_blocks
  for update to authenticated
  using (public.is_admin())
  with check (public.is_admin());

-- No DELETE: a copy block referenced by a view that disappears is a blank page.

-- ── No policy, by decision ───────────────────────────────────
--
-- These four have RLS enabled and NO policy, plus no grant — locked twice over. RLS
-- with no policy is deny-all for anon and authenticated; service_role carries
-- BYPASSRLS and is the only thing that reads or writes them.
--
--   user_roles     Reading it tells you who the moderators are; writing it makes you
--                  one. Role changes go through the service role and leave rows in
--                  audit_log AND moderation_actions by trigger (0013).
--   reserved_handles  Checked by SECURITY DEFINER trigger. Nothing needs to read it.
--   releases       Publisher state. The active-release pointer is not a client
--                  concern; clients read manifest.json from the CDN.
--   upload_quota   §6, cost-ceiling layer three. A member who can read their own
--                  counter learns the ceiling; one who can write it removes it.
--
-- Stated here so that the absence of a policy is legible as a decision. The
-- structural test in supabase/tests/00_structure.test.sql pins this list, so adding
-- a table without deciding one way or the other fails CI.
