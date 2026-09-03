-- ============================================================
-- CRM — account appearance (tema y modo por cuenta)
-- Migration 051.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/account-appearance.sql 051
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
-- ##  051_account_appearance.sql
-- ############################################################

-- ============================================================
-- 051_account_appearance.sql
--
-- Account-wide appearance (accent theme + light/dark mode). Previously
-- each user’s choice lived in their own browser’s localStorage only
-- (see src/hooks/use-theme.tsx) — this adds a shared default on the
-- account row so the owner’s pick becomes what every member sees.
--
-- Write access
--   These columns are deliberately left OUT of the `GRANT UPDATE
--   (name, default_currency) ON accounts TO authenticated` from
--   migration 047 — no GRANT statement here means `authenticated`
--   cannot write them at all, session or not. The only path is
--   PUT /api/account/appearance, which is owner-gated
--   (requireRole(’owner’)) and writes through the service-role client,
--   the same shape as /api/account/brand for brand_name / logo_url.
--
-- Read access is unaffected: accounts_update is the only revoked verb,
-- so accounts_select (`is_account_member(id)`) already lets every
-- member read these two columns, which is what lets everyone’s
-- session pick up the owner’s choice.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS theme TEXT NOT NULL DEFAULT 'violet';

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_theme_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_theme_check
  CHECK (theme IN ('violet', 'emerald', 'cobalt', 'amber', 'rose'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS mode TEXT NOT NULL DEFAULT 'dark';

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_mode_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_mode_check
  CHECK (mode IN ('light', 'dark'));

NOTIFY pgrst, 'reload schema';
