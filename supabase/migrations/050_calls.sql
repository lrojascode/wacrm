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
