-- ============================================================
-- 051_account_appearance.sql
--
-- Account-wide appearance (accent theme + light/dark mode). Previously
-- each user's choice lived in their own browser's localStorage only
-- (see src/hooks/use-theme.tsx) — this adds a shared default on the
-- account row so the owner's pick becomes what every member sees.
--
-- Write access
--   These columns are deliberately left OUT of the `GRANT UPDATE
--   (name, default_currency) ON accounts TO authenticated` from
--   migration 047 — no GRANT statement here means `authenticated`
--   cannot write them at all, session or not. The only path is
--   PUT /api/account/appearance, which is owner-gated
--   (requireRole('owner')) and writes through the service-role client,
--   the same shape as /api/account/brand for brand_name / logo_url.
--
-- Read access is unaffected: accounts_update is the only revoked verb,
-- so accounts_select (`is_account_member(id)`) already lets every
-- member read these two columns, which is what lets everyone's
-- session pick up the owner's choice.
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
