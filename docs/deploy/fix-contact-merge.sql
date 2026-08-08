-- ============================================================
-- wacrm — fix del merge de contactos (046)
-- Migration 046.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/fix-contact-merge.sql 046
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
-- ##  046_fix_contact_merge_conversation_index.sql
-- ############################################################

-- ============================================================
-- 046_fix_contact_merge_conversation_index
--
-- `merge_duplicate_contacts()` (migration 022) has been broken since
-- migration 036 landed, and the breakage only shows up once BOTH are
-- applied — which is why it went unnoticed.
--
-- 022 collapses duplicate contacts by re-pointing their children onto
-- the survivor, conversations included:
--
--     UPDATE conversations SET contact_id = v_survivor
--      WHERE contact_id = ANY(v_losers);
--
-- 036 then added UNIQUE (account_id, contact_id) on conversations. So
-- the moment a contact group holds more than one conversation between
-- its members, that UPDATE drops a second conversation onto the same
-- contact and dies with 23505 — taking the whole merge with it:
--
--     duplicate key value violates unique constraint
--     "idx_conversations_account_contact"
--
-- The two migrations are individually correct and mutually exclusive in
-- effect. Merging contacts REQUIRES merging their conversations first;
-- 022 predates the constraint that made that mandatory.
--
-- This migration:
--   1. extracts the per-group merge into `merge_contact_group(uuid[])`,
--      which collapses the group’s conversations into one BEFORE
--      re-pointing it — the order the unique index demands;
--   2. rewrites `merge_duplicate_contacts()` to drive that core, so the
--      by-phone entry point behaves identically to before, minus the
--      crash.
--
-- `merge_contact_group` is deliberately callable on its own: contacts
-- written with an empty phone are exempt from the partial unique index
-- (022: `WHERE phone_normalized <> ’’`) and therefore invisible to the
-- by-phone grouping, so the only way to collapse them is by id.
--
-- Idempotent. **No data loss** — every conversation-scoped child is
-- re-pointed onto the surviving conversation before the losers are
-- deleted, so ON DELETE CASCADE never reaches a message.
-- ============================================================

-- ------------------------------------------------------------
-- Core: merge an explicit set of contacts into the oldest of them.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_contact_group(p_ids UUID[])
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_all           UUID[];
  v_survivor      UUID;
  v_losers        UUID[];
  v_accounts      INTEGER;
  v_conv_survivor UUID;
  v_conv_unread   INTEGER;
BEGIN
  -- Oldest first: the survivor is the row every other write path already
  -- converges on (see findOrCreateConversation’s `order by created_at`).
  SELECT array_agg(id ORDER BY created_at ASC, id ASC)
    INTO v_all
    FROM contacts
   WHERE id = ANY(p_ids);

  IF v_all IS NULL OR array_length(v_all, 1) < 2 THEN
    RETURN 0;
  END IF;

  -- Refuse to merge across tenants. Nothing should ever call this with a
  -- mixed set, and silently collapsing two accounts’ contacts would be
  -- an unrecoverable tenancy breach — fail loudly instead.
  SELECT count(DISTINCT account_id) INTO v_accounts
    FROM contacts WHERE id = ANY(v_all);
  IF v_accounts > 1 THEN
    RAISE EXCEPTION 'merge_contact_group: refusing to merge contacts across % accounts', v_accounts;
  END IF;

  v_survivor := v_all[1];
  v_losers   := v_all[2:array_length(v_all, 1)];

  -- ---- conversations ---------------------------------------
  -- This block is the whole point of the migration. Re-pointing the
  -- losers’ conversations directly at the survivor violates
  -- idx_conversations_account_contact as soon as the group holds two,
  -- so collapse them into a single conversation FIRST, then move that
  -- one. Children are re-pointed before the delete so the cascade
  -- never takes a message with it.
  SELECT id INTO v_conv_survivor
    FROM conversations
   WHERE contact_id = ANY(v_all)
   ORDER BY created_at ASC, id ASC
   LIMIT 1;

  IF v_conv_survivor IS NOT NULL THEN
    SELECT COALESCE(SUM(unread_count), 0) INTO v_conv_unread
      FROM conversations WHERE contact_id = ANY(v_all);

    UPDATE messages          SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);
    UPDATE message_reactions SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);
    UPDATE deals             SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);
    UPDATE flow_runs         SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);
    UPDATE notifications     SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);
    UPDATE ai_usage_log      SET conversation_id = v_conv_survivor WHERE conversation_id IN (SELECT id FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor);

    DELETE FROM conversations WHERE contact_id = ANY(v_all) AND id <> v_conv_survivor;

    -- One conversation left in the group: now the re-point is safe.
    UPDATE conversations
       SET contact_id   = v_survivor,
           unread_count = v_conv_unread,
           updated_at   = NOW()
     WHERE id = v_conv_survivor;

    -- Re-derive the thread summary from the now-complete message set.
    UPDATE conversations c
       SET last_message_text = lm.content_text,
           last_message_at   = lm.created_at
      FROM (
        SELECT content_text, created_at
          FROM messages
         WHERE conversation_id = v_conv_survivor
         ORDER BY created_at DESC
         LIMIT 1
      ) lm
     WHERE c.id = v_conv_survivor;
  END IF;

  -- ---- every other contact-scoped child --------------------
  -- Unchanged from migration 022; these tables carry no contact-scoped
  -- unique constraint, so a plain re-point is safe.
  UPDATE contact_notes                 SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
  UPDATE deals                         SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
  UPDATE broadcast_recipients          SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
  UPDATE automation_logs               SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
  UPDATE automation_pending_executions SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);

  -- Conflict-guarded for UNIQUE(contact_id, tag_id).
  UPDATE contact_tags ct SET contact_id = v_survivor
    WHERE ct.contact_id = ANY(v_losers)
      AND NOT EXISTS (
        SELECT 1 FROM contact_tags s
        WHERE s.contact_id = v_survivor AND s.tag_id = ct.tag_id
      );
  DELETE FROM contact_tags WHERE contact_id = ANY(v_losers);

  -- Same guard for UNIQUE(contact_id, custom_field_id).
  UPDATE contact_custom_values cv SET contact_id = v_survivor
    WHERE cv.contact_id = ANY(v_losers)
      AND NOT EXISTS (
        SELECT 1 FROM contact_custom_values s
        WHERE s.contact_id = v_survivor AND s.custom_field_id = cv.custom_field_id
      );
  DELETE FROM contact_custom_values WHERE contact_id = ANY(v_losers);

  -- flow_runs has a partial UNIQUE on active runs per contact; move only
  -- non-active ones and let the FK NULL the rest.
  UPDATE flow_runs SET contact_id = v_survivor
    WHERE contact_id = ANY(v_losers) AND status <> 'active';

  DELETE FROM contacts WHERE id = ANY(v_losers);

  RETURN COALESCE(array_length(v_losers, 1), 0);
END;
$$;

ALTER FUNCTION public.merge_contact_group(UUID[]) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_contact_group(UUID[]) FROM PUBLIC;

-- ------------------------------------------------------------
-- By-phone entry point, now driving the fixed core.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.merge_duplicate_contacts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group  RECORD;
  v_merged INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT array_agg(id ORDER BY created_at ASC, id ASC) AS ids
    FROM contacts
    WHERE phone_normalized <> ''
    GROUP BY account_id, phone_normalized
    HAVING count(*) > 1
  LOOP
    v_merged := v_merged + public.merge_contact_group(v_group.ids);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_contacts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC;

-- Collapse whatever is mergeable right now (0 on a healthy DB).
SELECT public.merge_duplicate_contacts();
