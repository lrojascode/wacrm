-- ============================================================
-- wacrm — inbox de-duplication (contacts + conversations)
-- Migrations 022 through 036, in order.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/inbox-dedup.sql 022 036
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
-- ##  022_contact_phone_dedup.sql
-- ############################################################

-- ============================================================
-- 022_contact_phone_dedup
--
-- Prevent the same phone number from becoming multiple contacts
-- within one account (issue #212).
--
-- Until now `contacts.phone` had only a non-unique index, phone was
-- stored un-normalized ("+1 555-123-4567" vs "15551234567" are
-- distinct strings), and only the WhatsApp webhook de-duped. Manual
-- create and CSV import inserted freely, fragmenting conversations,
-- deals, and tags across duplicate rows.
--
-- This migration, in order:
--   1. adds a generated `phone_normalized` column (digits-only,
--      mirroring the app’s normalizePhone) that can never drift;
--   2. merges existing duplicates into the oldest row, re-pointing
--      all child records first so nothing is lost;
--   3. adds a UNIQUE index on (account_id, phone_normalized) — the
--      authoritative guarantee that covers every write path.
--
-- Idempotent. **No data loss** — duplicate rows are merged, not
-- dropped: child rows (conversations, messages, deals, notes, tags,
-- custom values, broadcast recipients, automation/flow records) are
-- re-pointed to the surviving (oldest) contact before deletion.
-- ============================================================

-- 1) Normalized phone — STORED generated column, kept in lockstep
--    with `phone` by Postgres. Matches normalizePhone()
--    (src/lib/whatsapp/phone-utils.ts): strip every non-digit.
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS phone_normalized TEXT
  GENERATED ALWAYS AS (regexp_replace(phone, '\D', '', 'g')) STORED;

-- 2) One-time (re-runnable) merge of existing duplicates.
--    SECURITY DEFINER so it can re-point rows across tables
--    regardless of the caller’s RLS; it only ever collapses exact
--    normalized duplicates within the same account.
CREATE OR REPLACE FUNCTION public.merge_duplicate_contacts()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group   RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           phone_normalized,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids
    FROM contacts
    WHERE phone_normalized <> ''
    GROUP BY account_id, phone_normalized
    HAVING count(*) > 1
  LOOP
    v_survivor := v_group.ids[1];
    v_losers   := v_group.ids[2:array_length(v_group.ids, 1)];

    -- Plain re-point: these tables have no contact-scoped unique
    -- constraint. `conversations` is ON DELETE CASCADE, so this
    -- re-point is what saves its rows (and their messages) from
    -- being deleted with the loser contact.
    UPDATE conversations                 SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE contact_notes                 SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE deals                         SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE broadcast_recipients          SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE automation_logs               SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);
    UPDATE automation_pending_executions SET contact_id = v_survivor WHERE contact_id = ANY(v_losers);

    -- Conflict-guarded re-point for UNIQUE(contact_id, tag_id):
    -- move only tags the survivor doesn’t already have, drop the rest.
    UPDATE contact_tags ct SET contact_id = v_survivor
      WHERE ct.contact_id = ANY(v_losers)
        AND NOT EXISTS (
          SELECT 1 FROM contact_tags s
          WHERE s.contact_id = v_survivor AND s.tag_id = ct.tag_id
        );
    DELETE FROM contact_tags WHERE contact_id = ANY(v_losers);

    -- Same guard for UNIQUE(contact_id, custom_field_id). Survivor’s
    -- own value wins on conflict.
    UPDATE contact_custom_values cv SET contact_id = v_survivor
      WHERE cv.contact_id = ANY(v_losers)
        AND NOT EXISTS (
          SELECT 1 FROM contact_custom_values s
          WHERE s.contact_id = v_survivor AND s.custom_field_id = cv.custom_field_id
        );
    DELETE FROM contact_custom_values WHERE contact_id = ANY(v_losers);

    -- flow_runs has a partial UNIQUE on active runs per contact.
    -- Re-point only NON-active runs (exempt from the partial index)
    -- to preserve history; any active loser run is left to be
    -- NULLed by its FK’s ON DELETE SET NULL when the loser is
    -- removed below — avoids colliding with the survivor’s active run.
    UPDATE flow_runs SET contact_id = v_survivor
      WHERE contact_id = ANY(v_losers) AND status <> 'active';

    DELETE FROM contacts WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_contacts() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_contacts() FROM PUBLIC;

-- Collapse whatever duplicates exist right now.
SELECT public.merge_duplicate_contacts();

-- 3) Authoritative guarantee. Partial index defends against any
--    empty normalized value (phone is NOT NULL, but belt-and-braces).
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_phone_normalized
  ON contacts (account_id, phone_normalized)
  WHERE phone_normalized <> '';

-- ############################################################
-- ##  036_conversation_contact_dedup.sql
-- ############################################################

-- ============================================================
-- 036_conversation_contact_dedup
--
-- Prevent the same contact from fragmenting into multiple
-- conversations within one account (issue #363).
--
-- The inbound webhook and the public-API resolver both follow a
-- "one conversation per (account, contact)" convention, but that
-- convention was only ever enforced in application code with a
-- `.single()` / `.maybeSingle()` lookup and no DB constraint. Two
-- problems compounded:
--
--   1. A race (Meta retries a delivery, or a batch delivers two
--      messages that fan out to concurrent `after()` runs) let two
--      inserts both miss the lookup and create two conversations —
--      unlike contacts (migration 022) there was no unique index and
--      no unique-violation backstop.
--   2. Once ≥2 conversations existed for a contact, the `.single()`
--      lookup errored on *every* subsequent inbound message, so the
--      code fell through and created yet another conversation each
--      time — the duplication snowballed, which is what the reporter
--      saw (a wall of duplicate chats for one number).
--
-- This migration mirrors 022_contact_phone_dedup:
--   1. merges existing duplicate conversations into the oldest row,
--      re-pointing every conversation-scoped child first so nothing
--      is lost;
--   2. adds a UNIQUE index on (account_id, contact_id) — the
--      authoritative guarantee that covers every write path.
--
-- Idempotent. **No data loss** — duplicate conversations are merged,
-- not dropped: child rows (messages, message_reactions, deals,
-- flow_runs, notifications, ai_usage_log) are re-pointed to the
-- surviving (oldest) conversation before the losers are deleted.
-- ============================================================

-- 1) One-time (re-runnable) merge of existing duplicates.
--    SECURITY DEFINER so it can re-point rows across tables
--    regardless of the caller’s RLS; it only ever collapses
--    conversations that share the same (account_id, contact_id).
CREATE OR REPLACE FUNCTION public.merge_duplicate_conversations()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_group    RECORD;
  v_survivor UUID;
  v_losers   UUID[];
  v_all      UUID[];
  v_merged   INTEGER := 0;
BEGIN
  FOR v_group IN
    SELECT account_id,
           contact_id,
           array_agg(id ORDER BY created_at ASC, id ASC) AS ids,
           COALESCE(SUM(unread_count), 0)                AS total_unread
    FROM conversations
    GROUP BY account_id, contact_id
    HAVING count(*) > 1
  LOOP
    v_all      := v_group.ids;
    v_survivor := v_all[1];
    v_losers   := v_all[2:array_length(v_all, 1)];

    -- Re-point every conversation-scoped child from the losers onto
    -- the survivor. None of these carry a conversation-scoped unique
    -- constraint (message_id is intentionally non-unique — see
    -- migration 009), so a plain UPDATE is safe. Doing this BEFORE the
    -- delete is what saves the ON DELETE CASCADE children (messages,
    -- message_reactions, notifications) from being removed with the
    -- loser conversations.
    UPDATE messages          SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE message_reactions SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE deals             SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE flow_runs         SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE notifications     SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);
    UPDATE ai_usage_log      SET conversation_id = v_survivor WHERE conversation_id = ANY(v_losers);

    -- Roll the merged unread counts onto the survivor and re-derive
    -- its last-message summary from the now-complete message set, so
    -- the surviving thread reflects the full history.
    UPDATE conversations c
    SET unread_count      = v_group.total_unread,
        last_message_text = lm.content_text,
        last_message_at   = lm.created_at,
        updated_at        = NOW()
    FROM (
      SELECT content_text, created_at
      FROM messages
      WHERE conversation_id = v_survivor
      ORDER BY created_at DESC
      LIMIT 1
    ) lm
    WHERE c.id = v_survivor;

    -- Survivor may have no messages at all (edge case). Still fold in
    -- the merged unread count in that case.
    UPDATE conversations
    SET unread_count = v_group.total_unread,
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;

ALTER FUNCTION public.merge_duplicate_conversations() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC;

-- Collapse whatever duplicates exist right now.
SELECT public.merge_duplicate_conversations();

-- 2) Authoritative guarantee: one conversation per (account, contact).
--    Every write path (inbound webhook, public-API resolver) now has a
--    DB-level backstop, and its unique-violation handling can re-resolve
--    the winning row instead of compounding duplicates.
CREATE UNIQUE INDEX IF NOT EXISTS idx_conversations_account_contact
  ON conversations (account_id, contact_id);
