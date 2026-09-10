-- ============================================================
-- CRM — brand-display
-- Migration 048.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/brand-display.sql 048
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
-- ##  048_brand_display.sql
-- ############################################################

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

-- ############################################################
-- ##  REGISTRO DE APLICACION  (P0-SEC-07)
-- ############################################################

-- Deja constancia de que este bundle se aplicó, para que
-- docs/deploy/check-applied.sql pueda responder "que le falta a este
-- proyecto" sin deducirlo del esquema.
--
-- Una fila por MIGRACION, no por bundle: los bundles se solapan
-- (full-install contiene todas), asi que registrar por archivo haria
-- imposible saber si una migracion concreta esta puesta.
--
-- ON CONFLICT DO NOTHING: reejecutar no duplica filas ni reescribe la
-- fecha. La primera aplicacion es el dato con valor; la repeticion no.
CREATE TABLE IF NOT EXISTS public.schema_release (
  version TEXT PRIMARY KEY,
  bundle TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  applied_by TEXT NOT NULL DEFAULT current_user
);
ALTER TABLE public.schema_release ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.schema_release FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT ON TABLE public.schema_release TO service_role;

INSERT INTO public.schema_release (version, bundle) VALUES
  ('048', 'docs/deploy/brand-display.sql')
ON CONFLICT (version) DO NOTHING;
