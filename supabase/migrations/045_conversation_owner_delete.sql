-- ============================================================
-- Conversation deletion: restrict to the account owner, and stop
-- linked deals from blocking it.
--
-- Two independent problems, both on the delete path.
--
-- 1. RLS was more permissive than anyone realised. 017 created
--
--      conversations_delete ... USING (is_account_member(account_id, 'agent'))
--
--    so any agent could already wipe a conversation. The dashboard
--    inbox talks to PostgREST directly from the browser
--    (conversation-list.tsx reads/writes via the browser client), so a
--    role check in a route handler would gate the button and nothing
--    else — the policy is the actual boundary. Deletion is
--    irreversible and takes the whole message history with it, so it
--    belongs with the other owner-only destructive operations
--    (canDeleteAccount / canTransferOwnership in lib/auth/roles.ts).
--
-- 2. deals.conversation_id was declared REFERENCES conversations(id)
--    with no ON DELETE action (001_initial_schema.sql), so Postgres
--    defaults to NO ACTION. Deleting a conversation that was ever
--    attached to a deal fails with:
--
--      ERROR 23503: update or delete on table "conversations" violates
--      foreign key constraint "deals_conversation_id_fkey" on table "deals"
--
--    Same class of bug 004 fixed for contacts, and the same fix: SET
--    NULL, not CASCADE. A deal is history — it holds its own value,
--    stage and close date, and losing it because someone tidied up an
--    old chat would be silent data loss. The column is already
--    nullable, so no DROP NOT NULL is needed here.
--
-- The rest of the conversation subtree already handles the delete:
-- messages / message_reactions / notifications CASCADE, and
-- flow_runs / ai_usage_log / attribution_events SET NULL. Engine-level
-- CASCADE does not run the child tables' RLS, so tightening
-- conversations_delete is enough to gate the whole subtree.
--
-- Idempotent — safe to run multiple times.
-- ============================================================

-- ── conversations delete policy: agent -> owner ────────────────
DROP POLICY IF EXISTS conversations_delete ON conversations;

CREATE POLICY conversations_delete ON conversations
  FOR DELETE USING (is_account_member(account_id, 'owner'));

-- ── deals.conversation_id ──────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'deals_conversation_id_fkey'
      AND conrelid = 'deals'::regclass
  ) THEN
    ALTER TABLE deals
      DROP CONSTRAINT deals_conversation_id_fkey;
  END IF;
END $$;

ALTER TABLE deals
  ADD CONSTRAINT deals_conversation_id_fkey
    FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    ON DELETE SET NULL;
