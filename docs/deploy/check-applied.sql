-- ============================================================
-- CRM — which schema releases are already applied?
--
-- There is no migration runner in this setup: the bundles under
-- docs/deploy/ are pasted into the Supabase SQL editor by hand, and
-- nothing records that they ran. So before a deploy the only honest
-- answer to "did I already apply that one?" comes from looking at the
-- schema itself.
--
-- Paste this into Supabase Cloud -> SQL Editor and run it. Every row
-- should read APPLIED before you redeploy the matching code.
--
-- Read-only: it inspects catalogs and changes nothing.
-- ============================================================

WITH checks AS (
  SELECT
    -- The two de-dup indexes are what stop one customer from
    -- fragmenting into a wall of duplicate contacts and threads. They
    -- predate this file, so a production DB set up before it can be
    -- missing them with nothing to say so — which is exactly how it
    -- went unnoticed. Check them first.
    '022 contact phone dedup' AS release,
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'contacts' AND column_name = 'phone_normalized')
      AND to_regclass('public.idx_contacts_account_phone_normalized') IS NOT NULL
      AS ok,
    'docs/deploy/inbox-dedup.sql' AS bundle
  UNION ALL
  SELECT
    '036 conversation dedup',
    to_regclass('public.idx_conversations_account_contact') IS NOT NULL,
    'docs/deploy/inbox-dedup.sql'
  UNION ALL
  SELECT
    -- 046 repairs merge_duplicate_contacts(), which 036 silently broke:
    -- with both applied, merging any contact group that holds more than
    -- one conversation dies on idx_conversations_account_contact. The
    -- extracted core is the only trace it leaves.
    '046 contact merge fix',
    to_regprocedure('public.merge_contact_group(uuid[])') IS NOT NULL,
    'docs/deploy/fix-contact-merge.sql'
  UNION ALL
  SELECT
    '037 attribution',
    to_regclass('public.attribution_events') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'contacts' AND column_name = 'source'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '038 ad platforms',
    to_regclass('public.ad_accounts') IS NOT NULL
      AND to_regclass('public.ad_campaigns') IS NOT NULL
      AND to_regclass('public.ad_metrics_daily') IS NOT NULL,
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '039 deal closed_at',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'deals' AND column_name = 'closed_at'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '040 tracked links',
    to_regclass('public.tracked_links') IS NOT NULL,
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    -- 041 adds no table or column: it only widens the notifications
    -- type CHECK to accept 'deal_assigned', so the constraint body is
    -- the only trace it leaves.
    '041 deal assignment',
    EXISTS (SELECT 1 FROM pg_constraint
            WHERE conname = 'notifications_type_check'
              AND pg_get_constraintdef(oid) LIKE '%deal_assigned%'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '042 ads hardening',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'ad_entities' AND column_name = 'attempts')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'ad_accounts' AND column_name = 'timezone'),
    'docs/deploy/ads-attribution.sql'
  UNION ALL
  SELECT
    '043 branding',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'brand_name')
      AND EXISTS (SELECT 1 FROM storage.buckets WHERE id = 'brand-assets'),
    'docs/deploy/branding.sql'
  UNION ALL
  SELECT
    '044 meta app per account',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'whatsapp_config' AND column_name = 'webhook_token')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'whatsapp_config' AND column_name = 'meta_app_secret_encrypted'),
    'docs/deploy/meta-app-per-account.sql'
  UNION ALL
  SELECT
    -- 045 tightens conversations_delete to owner-only and rewrites
    -- deals_conversation_id_fkey to ON DELETE SET NULL so a delete no
    -- longer fails against a linked deal — the FK action is the trace
    -- that's cheap to check from the catalog.
    '045 conversation owner delete',
    EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conname = 'deals_conversation_id_fkey'
        AND confdeltype = 'n'
    ),
    'docs/deploy/conversation-delete.sql'
  UNION ALL
  SELECT
    '047 owner-only settings',
    NOT EXISTS (
      SELECT 1 FROM information_schema.column_privileges
      WHERE grantee = 'authenticated'
        AND table_name = 'accounts'
        AND column_name = 'brand_name'
        AND privilege_type = 'UPDATE'
    ),
    'docs/deploy/owner-only-settings.sql'
  UNION ALL
  SELECT
    '048 brand display',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'brand_display_mode')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'brand_logo_size'),
    'docs/deploy/brand-display.sql'
  UNION ALL
  SELECT
    '049 contact tasks',
    to_regclass('public.contact_tasks') IS NOT NULL
      AND to_regprocedure('public.process_due_tasks()') IS NOT NULL,
    'docs/deploy/contact-tasks.sql'
  UNION ALL
  SELECT
    '050 calls',
    to_regclass('public.call_sessions') IS NOT NULL
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'messages' AND column_name = 'call_outcome'),
    'docs/deploy/calls.sql'
  UNION ALL
  SELECT
    -- 051 is the one the app reads on EVERY page load (the account
    -- theme/mode the whole team shares). Missing it does not just
    -- disable appearance: the account select asks for these columns,
    -- fails, and the client falls back to a narrower column list — which
    -- is how a missing 051 also blanked brand_name / logo_url in the
    -- sidebar. The fallback is now progressive, but this row is still
    -- the fastest way to see the real cause.
    '051 account appearance',
    EXISTS (SELECT 1 FROM information_schema.columns
            WHERE table_name = 'accounts' AND column_name = 'theme')
      AND EXISTS (SELECT 1 FROM information_schema.columns
                  WHERE table_name = 'accounts' AND column_name = 'mode'),
    'docs/deploy/account-appearance.sql'
)
SELECT
  release,
  CASE WHEN ok THEN 'APPLIED' ELSE 'MISSING -> run the bundle' END AS status,
  bundle
FROM checks
ORDER BY release;

