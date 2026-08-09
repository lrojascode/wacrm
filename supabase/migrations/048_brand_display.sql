-- ============================================================
-- 048_brand_display.sql
--
-- Brand display mode and logo size options for white-label branding.
-- Allows accounts to configure whether to display logo, text, or both,
-- and select logo display size (sm, md, lg).
-- Also increases brand-assets storage bucket limit to 5 MB for larger logos.
--
-- Idempotent - safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Add brand_display_mode and brand_logo_size columns
-- ============================================================
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS brand_display_mode TEXT DEFAULT 'both';

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_brand_display_mode_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_brand_display_mode_check
  CHECK (brand_display_mode IN ('logo', 'text', 'both'));

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS brand_logo_size TEXT DEFAULT 'sm';

ALTER TABLE accounts
  DROP CONSTRAINT IF EXISTS accounts_brand_logo_size_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_brand_logo_size_check
  CHECK (brand_logo_size IN ('sm', 'md', 'lg'));

-- ============================================================
-- 2. Update brand-assets storage bucket file size limit (5 MB)
-- ============================================================
UPDATE storage.buckets
SET file_size_limit = 5242880
WHERE id = 'brand-assets';

-- ============================================================
-- 3. Reload schema cache for PostgREST
-- ============================================================
NOTIFY pgrst, 'reload schema';
