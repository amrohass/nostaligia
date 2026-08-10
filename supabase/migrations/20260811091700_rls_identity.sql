-- 0017 · RLS — profiles, places, reserved_handles
--
-- One policy per (table × operation), deny by default, WITH CHECK on every INSERT
-- and UPDATE. Where an operation has no policy that is a decision, and it is stated
-- in a comment rather than left as an absence.

-- ── profiles ─────────────────────────────────────────────────
-- Every profile row is visible; what varies is the COLUMNS, and 0015 settled that.
-- Handle, display name, avatar and role badge are public by §7 because attribution
-- depends on them. bio and visibility are not granted at all and come back through
-- profile_view().
create policy profiles_select on public.profiles
  for select to authenticated
  using (true);

-- You may create exactly one profile, your own. The handle format, normalization and
-- reserved-word checks all fire underneath this.
create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (id = (select auth.uid()));

-- And edit only your own. role_cache is not in the UPDATE grant, so a moderator
-- editing their own profile still cannot promote themselves — the column privilege
-- binds every signed-in role identically.
create policy profiles_update on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No DELETE policy and no DELETE grant. Account removal is a request flow with an
-- audit trail (M5), not a client-issued DELETE that silently orphans an archive.

-- ── places ───────────────────────────────────────────────────
create policy places_select on public.places
  for select to authenticated
  using (true);

-- §4 gives moderators the gazetteer. The grants exist now so M4 has somewhere to
-- land; the authorization is settled here, once.
create policy places_insert on public.places
  for insert to authenticated
  with check (public.is_moderator());

create policy places_update on public.places
  for update to authenticated
  using (public.is_moderator())
  with check (public.is_moderator());

-- No DELETE: places are referenced by posts. Merging is an M4 operation under the
-- service role, not a delete.

-- ── reserved_handles ─────────────────────────────────────────
-- No policies, and no grants either. The list is checked by a SECURITY DEFINER
-- trigger, so nothing needs to read it — and an enumerable inventory of the words
-- worth impersonating is not something to hand out.
