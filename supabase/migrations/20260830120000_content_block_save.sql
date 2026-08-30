-- 0055 · An admin can actually save site copy
--
-- §4 gives an admin "Edit site copy (content_blocks)" and §9 makes the dashboard "the single
-- source of truth" for every string on the public site. Neither has ever been true on a
-- deployed database: **every save and every publish from the copy screen was refused**, and
-- the refusal was a privilege error rather than a policy one, so nothing in the audit trail
-- recorded that an admin had tried.
--
-- == The exact failure =======================================
--
-- admin.js upserts one row per locale, which PostgREST sends with
-- "Prefer: resolution=merge-duplicates" and Postgres executes as
--
--     insert into content_blocks (key, locale, draft) values (...)
--     on conflict (key, locale) do update set draft = excluded.draft
--
-- and that statement needs SELECT on `draft`. EXCLUDED is the target relation's rowtype, so
-- reading excluded.draft is a read of content_blocks.draft as far as the privilege check is
-- concerned -- and 0015 grants `authenticated` SELECT on (key, locale, published, version,
-- updated_at) and deliberately NOT on `draft`:
--
--     42501: permission denied for table content_blocks
--     HINT:  Grant the required privileges ... GRANT SELECT ON public.content_blocks ...
--
-- Reproduced on the hosted database as a real admin, 30 Aug 2026. A plain UPDATE succeeds
-- and a plain INSERT succeeds; only the upsert is refused. It fails BEFORE RLS is consulted,
-- which is why is_admin() being true changes nothing.
--
-- == Why the hint must not be followed =======================
--
-- GRANT SELECT (draft) ON content_blocks TO authenticated would fix the error and open a
-- hole: 0020's content_blocks_select policy is `using (true)`, so every signed-in member
-- would be able to read every unpublished draft -- a paragraph an editor is still working
-- on, served to anyone with an account. The column grant is the ONLY thing withholding it.
-- That is the same reason 0016 reads drafts through content_blocks_draft() instead of the
-- table, and this is that decision applied to the write side.
--
-- == Third instance of one rule ==============================
--
-- M1 hit it as Prefer: return=representation (a SELECT of *), M3 hit it in save_place
-- (RETURNING * in a plpgsql function), and this is the third: **a column-subset grant breaks
-- any statement that reads a column back, however implicitly.** db.js already refuses a
-- representation with no select=; an upsert has no equivalent place to put that rule, so the
-- statement has to move off the table.

set search_path = public, extensions;

-- == The write path ==========================================
--
-- SECURITY DEFINER, and the role check is inside it -- the mirror of content_blocks_draft().
-- The function is granted to `authenticated` because that is the role PostgREST arrives as;
-- is_admin() is what actually decides, and a moderator gets a named refusal instead of a 403
-- they cannot distinguish from being signed out.
--
-- Returns jsonb rather than the row, for the reason save_place's header gives: a row is a
-- SELECT of every column, which is the trap this file exists to get out of.
create or replace function public.save_content_block(
  p_key     text,
  p_locale  text,
  p_draft   text,
  p_publish boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_key    text := btrim(coalesce(p_key, ''));
  v_locale text := btrim(coalesce(p_locale, ''));
  -- An empty box is a legitimate draft (an editor clearing a block they are rewriting), so
  -- '' is stored as '' and only a NULL argument becomes NULL.
  v_draft   text := p_draft;
  v_version integer;
begin
  if not public.is_admin() then
    -- Named, not silent. §4 puts this capability behind admin, and a moderator opening the
    -- screen is entitled to be told which of the two things went wrong.
    return jsonb_build_object('saved', false, 'reason', 'denied');
  end if;

  -- Restated from 0009's constraints so the caller gets a reason rather than a constraint
  -- name. The constraints stay where they are; this does not replace them.
  if v_key !~ '^[a-z0-9]+(\.[a-z0-9_]+)*$' then
    return jsonb_build_object('saved', false, 'reason', 'invalid_key');
  end if;
  if v_locale not in ('ar', 'en') then
    return jsonb_build_object('saved', false, 'reason', 'invalid_locale');
  end if;

  -- Publishing an empty string would blank a live block on the public site with one
  -- mis-click, and the two-column design exists to make that hard. Saving it as a draft
  -- stays allowed.
  if p_publish and nullif(btrim(coalesce(v_draft, '')), '') is null then
    return jsonb_build_object('saved', false, 'reason', 'empty_publish');
  end if;

  -- updated_by is deliberately absent: 0014's content_blocks_stamp_editor is a BEFORE
  -- INSERT OR UPDATE trigger that sets it from auth.uid() already. Setting it here as well
  -- would write the same value twice and read as though this function were the thing that
  -- attributes an edit -- which would be wrong the day an importer writes a row without
  -- going through here.
  insert into public.content_blocks as cb (key, locale, draft, published, version)
  values (v_key, v_locale, v_draft,
          case when p_publish then v_draft else null end,
          case when p_publish then 1 else 0 end)
  on conflict (key, locale) do update
     set draft      = excluded.draft,
         -- A save writes the draft and leaves the live string alone. That is the whole point
         -- of the two columns, and it is the branch the Save button takes.
         published  = case when p_publish then excluded.draft else cb.published end,
         version    = case when p_publish then cb.version + 1 else cb.version end
  returning cb.version into v_version;

  return jsonb_build_object('saved', true, 'key', v_key, 'locale', v_locale,
                            'published', p_publish, 'version', v_version);
end;
$fn$;

comment on function public.save_content_block(text, text, text, boolean) is
  'Save or publish one editorial block. Admin only (CLAUDE.md §4); the table itself cannot be upserted -- see 0055.';

revoke execute on function public.save_content_block(text, text, text, boolean) from public, anon;
grant  execute on function public.save_content_block(text, text, text, boolean) to authenticated, service_role;

-- == §4's trail ==============================================
--
-- A trigger rather than a block inside the function above, for the reason 0050's header
-- gives: "no privileged action may bypass this" can only mean a trigger. The seeding in 0043
-- and any future importer are recorded without knowing this exists.
--
-- **audit_log only, and moderation_actions deliberately not.** §4 asks for both, and both is
-- not possible here without a schema change nobody has reviewed: moderation_actions.
-- target_id is `uuid not null`, and this table's primary key is (key, locale). The choices
-- were a synthetic uuid derived from the key -- a value that means nothing and joins to
-- nothing -- or relaxing a not-null on a governance table. audit_log.target_id IS nullable
-- and target_type IS text, precisely so audit "covers every table, including ones not yet
-- created" (0010), so the archival record §3 requires is complete. Which of the two fixes
-- moderation_actions should get is Amro's call and is recorded in the session report.
create or replace function public.content_blocks_write_audit()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_action text;
begin
  v_action := case
    when tg_op = 'INSERT' and new.published is not null then 'content_block.publish'
    when tg_op = 'INSERT'                               then 'content_block.create'
    when old.published is distinct from new.published   then 'content_block.publish'
    else 'content_block.edit'
  end;

  -- The key travels in the payload because target_id cannot carry it. draft and published
  -- are recorded in full: an audit row that said only "copy changed" would not answer the
  -- question the trail exists for, which is what the site used to say.
  insert into public.audit_log (actor, action, target_type, target_id, before, after)
  values (
    (select auth.uid()), v_action, 'content_block', null,
    case when tg_op = 'INSERT' then null
         else jsonb_build_object('key', old.key, 'locale', old.locale,
                                 'draft', old.draft, 'published', old.published,
                                 'version', old.version) end,
    jsonb_build_object('key', new.key, 'locale', new.locale,
                       'draft', new.draft, 'published', new.published,
                       'version', new.version));

  return null;
end;
$fn$;

comment on function public.content_blocks_write_audit() is
  'CLAUDE.md §4 -- every edit to site copy is recorded, by trigger. audit_log only; see 0055 on moderation_actions.';

drop trigger if exists content_blocks_write_audit on public.content_blocks;

create trigger content_blocks_write_audit
  after insert or update on public.content_blocks
  for each row execute function public.content_blocks_write_audit();
