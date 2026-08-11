-- ============================================================
-- wacrm — calls
-- Migration 050.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/calls.sql 050
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
-- ##  050_calls.sql
-- ############################################################

-- ============================================================
-- 050_calls.sql
--
-- Schema for WhatsApp incoming calls support.
-- Idempotent - safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Widen messages content_type check & add call metadata columns
-- ============================================================

ALTER TABLE messages
  DROP CONSTRAINT IF EXISTS messages_content_type_check;

ALTER TABLE messages
  ADD CONSTRAINT messages_content_type_check
  CHECK (content_type IN (
    'text', 'image', 'document', 'audio', 'video',
    'location', 'template', 'interactive', 'call'
  ));

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS call_outcome TEXT CHECK (call_outcome IS NULL OR call_outcome IN ('accepted', 'missed', 'rejected', 'failed')),
  ADD COLUMN IF NOT EXISTS call_duration_seconds INTEGER;

-- Unique partial index for idempotency on terminal call messages
CREATE UNIQUE INDEX IF NOT EXISTS messages_call_wacid_key
  ON messages(message_id) WHERE content_type = 'call';

-- ============================================================
-- 2. Create call_sessions table (ephemeral live state)
-- ============================================================

CREATE TABLE IF NOT EXISTS call_sessions (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  contact_id UUID REFERENCES contacts(id) ON DELETE CASCADE,
  wa_call_id TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL DEFAULT 'USER_INITIATED' CHECK (direction = 'USER_INITIATED'),
  offer_sdp TEXT NOT NULL,
  answer_sdp TEXT,
  ring_user_ids UUID[] NOT NULL DEFAULT '{}',
  answered_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'ringing' CHECK (status IN ('ringing', 'claimed', 'connected', 'ended', 'rejected', 'failed')),
  end_reason TEXT,
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_call_sessions_account_status
  ON call_sessions(account_id, status);

CREATE INDEX IF NOT EXISTS idx_call_sessions_wa_call_id
  ON call_sessions(wa_call_id);

-- Enable RLS
ALTER TABLE call_sessions ENABLE ROW LEVEL SECURITY;

-- Only SELECT policy for authenticated users (writes strictly via service-role)
DROP POLICY IF EXISTS call_sessions_select ON call_sessions;
CREATE POLICY call_sessions_select ON call_sessions FOR SELECT TO authenticated
  USING (
    is_account_member(account_id) AND
    (auth.uid() = ANY(ring_user_ids) OR answered_by = auth.uid())
  );

-- Add to Realtime publication
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'call_sessions'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE call_sessions;
  END IF;
END $$;
