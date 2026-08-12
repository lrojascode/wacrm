-- ============================================================
-- wacrm — owner-only settings
-- Migration 047.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/owner-only-settings.sql 047
--
-- HOW TO APPLY
--   1. Supabase Cloud -> SQL Editor -> New query.
--   2. Paste this whole file and run it.
--   3. THEN deploy the new app code (merge to main + redeploy).
--
-- Order matters, and this way round is the safe one: every change here
-- is additive (new tables, new columns with defaults), so the code
-- currently running in production keeps working against the new schema.
-- Deploying first would instead point the new code at tables that do
-- not exist yet.
--
-- Safe to re-run: tables use CREATE TABLE IF NOT EXISTS, columns use
-- ADD COLUMN IF NOT EXISTS, constraints and policies are dropped before
-- being recreated, and functions use CREATE OR REPLACE.
--
-- IF THE EDITOR STILL REPORTS A SYNTAX ERROR
--   It is splitting the script into statements and getting it wrong, not
--   objecting to the SQL. Run the file one section at a time: each
--   `-- ####` banner below starts a migration, and they are independent
--   in that order. The apostrophes in comments that caused this once
--   already are rewritten by the generator (see sanitize-comments.py).
-- ============================================================


-- ############################################################
-- ##  047_owner_only_settings.sql
-- ############################################################

-- ============================================================
-- 047_owner_only_settings
--
-- Six settings sections move from admin+ to owner-only: Brand,
-- WhatsApp connection, Ad accounts, Team members, API keys, and
-- (client-side only — see below) Appearance.
--
-- Why: the agency runs one deployment for several client accounts.
-- The agency owner holds `owner` on every client account; the
-- client’s own staff hold `admin`. Until now `admin` was the actual
-- ceiling everywhere (RLS policies below, and the RPCs in 018), so a
-- client admin could already write API keys, WhatsApp credentials, or
-- swap the ad account straight from the browser console — a UI-only
-- gate would not have stopped that. This migration moves the real
-- ceiling to `owner` for the tables and RPCs that back those five
-- sections. Appearance is excluded here on purpose: the theme choice
-- lives in each browser’s localStorage
-- (src/components/settings/appearance-panel.tsx), never touches the
-- database, so there is nothing here to restrict — it’s hidden at the
-- UI layer only.
--
-- `accounts` needs a finer tool than a table-wide RLS bump: Deals &
-- currency (not on this list) writes `default_currency` straight from
-- the client (src/components/settings/deals-settings.tsx), so an
-- admin must keep write access to THAT column while losing it on
-- `brand_name` / `logo_url`. Postgres column-level GRANTs do this —
-- same mechanism migration 027 already uses to let any member UPDATE
-- `notifications.read_at` but nothing else.
--
-- LOCAL DEV NOTE: `supabase db reset` re-applies the CLI’s own
-- baseline `GRANT ALL ON ALL TABLES IN SCHEMA public` to
-- authenticated/anon/service_role AFTER replaying every migration —
-- that’s supabase-cli’s own safety net, unrelated to this file, and
-- it silently re-widens the REVOKE/GRANT below back to every column.
-- Production is unaffected: this bundle is pasted into the Supabase
-- Cloud SQL editor once (see docs/deploy/) and nothing runs after it.
-- To test the narrower grant locally after a `db reset`, re-run
-- section 5 below by hand as the last statement.
--
-- Idempotent — safe to re-run.
-- ============================================================

-- ============================================================
-- 1. api_keys — admin+ -> owner
-- ============================================================
DROP POLICY IF EXISTS api_keys_insert ON api_keys;
CREATE POLICY api_keys_insert ON api_keys FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS api_keys_update ON api_keys;
CREATE POLICY api_keys_update ON api_keys FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS api_keys_delete ON api_keys;
CREATE POLICY api_keys_delete ON api_keys FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ============================================================
-- 2. ad_accounts — admin+ -> owner
-- ============================================================
DROP POLICY IF EXISTS ad_accounts_insert ON ad_accounts;
CREATE POLICY ad_accounts_insert ON ad_accounts FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS ad_accounts_update ON ad_accounts;
CREATE POLICY ad_accounts_update ON ad_accounts FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS ad_accounts_delete ON ad_accounts;
CREATE POLICY ad_accounts_delete ON ad_accounts FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- Note: ad_campaigns / ad_metrics_daily (manual spend entry) are left
-- at admin+ on purpose — that’s day-to-day Campaigns page work, not a
-- settings-page action, and out of scope here.

-- ============================================================
-- 3. whatsapp_config — admin+ -> owner
-- ============================================================
DROP POLICY IF EXISTS whatsapp_config_insert ON whatsapp_config;
CREATE POLICY whatsapp_config_insert ON whatsapp_config FOR INSERT
  WITH CHECK (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS whatsapp_config_update ON whatsapp_config;
CREATE POLICY whatsapp_config_update ON whatsapp_config FOR UPDATE
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS whatsapp_config_delete ON whatsapp_config;
CREATE POLICY whatsapp_config_delete ON whatsapp_config FOR DELETE
  USING (is_account_member(account_id, 'owner'));

-- ============================================================
-- 4. account_invitations — admin+ -> owner (select + all)
-- ============================================================
DROP POLICY IF EXISTS account_invitations_select ON account_invitations;
CREATE POLICY account_invitations_select ON account_invitations FOR SELECT
  USING (is_account_member(account_id, 'owner'));

DROP POLICY IF EXISTS account_invitations_modify ON account_invitations;
CREATE POLICY account_invitations_modify ON account_invitations FOR ALL
  USING (is_account_member(account_id, 'owner'))
  WITH CHECK (is_account_member(account_id, 'owner'));

-- ============================================================
-- 5. accounts — column-level grants
--
-- REVOKE-then-GRANT-a-subset is the only way to let `admin` keep
-- writing `default_currency` (Deals & currency, not owner-only) while
-- losing `brand_name` / `logo_url` (Brand, owner-only). The
-- `accounts_update` row policy (017) still requires admin+ to reach
-- any row at all; this narrows which COLUMNS that gets you.
--
-- brand_name / logo_url become unreachable through the user’s own
-- session entirely — even the owner now writes them through
-- /api/account/brand’s service-role client, not this grant. That
-- route is the only remaining path, which is what makes this a real
-- boundary instead of a UI convenience.
-- ============================================================
REVOKE UPDATE ON accounts FROM authenticated;
GRANT UPDATE (name, default_currency) ON accounts TO authenticated;

-- ============================================================
-- 6. brand-assets storage — admin+ -> owner
-- ============================================================
-- Both names are dropped, not just the old one: this section RENAMES the
-- policies (Admins -> Owners), so on a re-run the old name is already
-- gone and CREATE would fail on the new name still being there. Dropping
-- only the pre-rename name is what made this file non-idempotent, which
-- the deploy bundles explicitly promise it is not.
DROP POLICY IF EXISTS "Admins can upload brand assets" ON storage.objects;
DROP POLICY IF EXISTS "Owners can upload brand assets" ON storage.objects;
CREATE POLICY "Owners can upload brand assets"
  ON storage.objects FOR INSERT
  WITH CHECK (
    bucket_id = 'brand-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role = 'owner'
    )
  );

DROP POLICY IF EXISTS "Admins can update brand assets" ON storage.objects;
DROP POLICY IF EXISTS "Owners can update brand assets" ON storage.objects;
CREATE POLICY "Owners can update brand assets"
  ON storage.objects FOR UPDATE
  USING (
    bucket_id = 'brand-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role = 'owner'
    )
  );

DROP POLICY IF EXISTS "Admins can delete brand assets" ON storage.objects;
DROP POLICY IF EXISTS "Owners can delete brand assets" ON storage.objects;
CREATE POLICY "Owners can delete brand assets"
  ON storage.objects FOR DELETE
  USING (
    bucket_id = 'brand-assets'
    AND EXISTS (
      SELECT 1 FROM public.profiles p
      WHERE p.user_id = auth.uid()
        AND ('account-' || p.account_id::text) = (storage.foldername(name))[1]
        AND p.account_role = 'owner'
    )
  );

-- ============================================================
-- 7. Member-management RPCs (018_account_member_rpcs.sql) —
-- admin+ -> owner. CREATE OR REPLACE keeps the same signature and
-- error contract; only the role check changes.
-- ============================================================
CREATE OR REPLACE FUNCTION public.set_member_role(
  p_user_id UUID,
  p_new_role account_role_enum
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'This action requires the account owner'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot change your own role'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role
  INTO v_target_account_id, v_target_role
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to demote an owner'
      USING ERRCODE = '22023';
  END IF;
  IF p_new_role = 'owner' THEN
    RAISE EXCEPTION 'Use transfer_account_ownership to promote to owner'
      USING ERRCODE = '22023';
  END IF;

  UPDATE profiles
  SET account_role = p_new_role
  WHERE user_id = p_user_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.remove_account_member(
  p_user_id UUID
) RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_account_id UUID;
  v_caller_role account_role_enum;
  v_target_account_id UUID;
  v_target_role account_role_enum;
  v_target_name TEXT;
  v_target_email TEXT;
  v_new_account_id UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT account_id, account_role
  INTO v_caller_account_id, v_caller_role
  FROM profiles
  WHERE user_id = auth.uid();

  IF v_caller_account_id IS NULL THEN
    RAISE EXCEPTION 'Caller has no account' USING ERRCODE = '42501';
  END IF;

  IF v_caller_role <> 'owner' THEN
    RAISE EXCEPTION 'This action requires the account owner'
      USING ERRCODE = '42501';
  END IF;

  IF p_user_id = auth.uid() THEN
    RAISE EXCEPTION 'Cannot remove yourself; transfer ownership or leave the account instead'
      USING ERRCODE = '22023';
  END IF;

  SELECT account_id, account_role, full_name, email
  INTO v_target_account_id, v_target_role, v_target_name, v_target_email
  FROM profiles
  WHERE user_id = p_user_id;

  IF v_target_account_id IS NULL THEN
    RAISE EXCEPTION 'Target user not found' USING ERRCODE = '22023';
  END IF;

  IF v_target_account_id <> v_caller_account_id THEN
    RAISE EXCEPTION 'Target user is not a member of your account'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_role = 'owner' THEN
    RAISE EXCEPTION 'Cannot remove the account owner; transfer ownership first'
      USING ERRCODE = '22023';
  END IF;

  INSERT INTO accounts (name, owner_user_id)
  VALUES (
    COALESCE(NULLIF(v_target_name, ''), v_target_email, 'My account'),
    p_user_id
  )
  RETURNING id INTO v_new_account_id;

  UPDATE profiles
  SET account_id = v_new_account_id,
      account_role = 'owner'
  WHERE user_id = p_user_id;

  RETURN v_new_account_id;
END;
$$;

NOTIFY pgrst, 'reload schema';
