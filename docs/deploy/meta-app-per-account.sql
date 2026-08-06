-- ============================================================
-- wacrm — a per-account Meta app (App ID / App Secret / dedicated webhook URL)
-- Migration 044.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/meta-app-per-account.sql 044
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
-- ##  044_meta_app_per_account.sql
-- ############################################################

-- ============================================================
-- 044_meta_app_per_account
--
-- Lets an account bring its own Meta app (App ID + App Secret)
-- instead of sharing the one deployment-wide app configured via
-- META_APP_ID / META_APP_SECRET in the environment.
--
-- Why this exists:
--   A client who owns their own Business Manager will not hand admin
--   access to their WABA to the agency’s Meta app — they connect
--   through their own app instead. Until now that meant a second
--   full deployment (its own Coolify service, its own env vars) per
--   such client. These columns let them configure their own app from
--   Settings on the SAME deployment.
--
-- All three columns are nullable except webhook_token:
--   meta_app_id / meta_app_secret_encrypted — NULL means "no app of
--     its own configured yet"; the webhook and template code fall
--     back to the deployment-wide META_APP_ID / META_APP_SECRET env
--     vars. This is what keeps every existing row (and therefore
--     every number in production today) working unchanged.
--   webhook_token — NOT NULL, backfilled below. This is the path
--     segment for this account’s dedicated webhook URL
--     (/api/whatsapp/webhook/<token>), which is what makes a
--     per-account app secret usable at all: Meta signs the whole
--     request body with the app secret, so the server has to know
--     which secret to check BEFORE it can trust anything in that
--     body — a URL segment is the only thing available at that
--     point. It is a routing token, not a bearer credential (the
--     HMAC signature is what actually authenticates), so it is
--     stored as plain, opaque text rather than hashed, the same way
--     phone_number_id is.
--
-- App secret is encrypted the same way whatsapp_config.access_token
-- already is (AES-256-GCM, see src/lib/whatsapp/encryption.ts) —
-- same threat model: a row leak must not hand over a live secret
-- that could be used to forge webhook deliveries.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS meta_app_id TEXT,
  ADD COLUMN IF NOT EXISTS meta_app_secret_encrypted TEXT,
  ADD COLUMN IF NOT EXISTS webhook_token TEXT;

-- Backfill existing rows with a unique token before the NOT NULL /
-- UNIQUE constraints below. gen_random_uuid() is built in since
-- PG13 (pgcrypto not required) and 001_initial_schema.sql already
-- relies on the same guarantee elsewhere.
UPDATE whatsapp_config
SET webhook_token = replace(gen_random_uuid()::text, '-', '')
WHERE webhook_token IS NULL;

ALTER TABLE whatsapp_config
  ALTER COLUMN webhook_token SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'whatsapp_config_webhook_token_key'
      AND conrelid = 'whatsapp_config'::regclass
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_webhook_token_key
      UNIQUE (webhook_token);
  END IF;
END $$;

-- Hot path for the per-account webhook route: look up the config by
-- token on every inbound delivery.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_webhook_token
  ON whatsapp_config (webhook_token);

-- Refresh PostgREST’s schema cache so the new columns are selectable
-- immediately — see migration 043’s note on issue #294 for why this
-- matters rather than being cosmetic.
NOTIFY pgrst, 'reload schema';
