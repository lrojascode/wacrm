-- ============================================================
-- CRM — calls
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
  end_reason TEXT CHECK (end_reason IS NULL OR end_reason IN ('user_busy', 'timeout', 'rejected', 'hung_up', 'failed', 'cancelled', 'completed', 'rejected_by_agent', 'hung_up_by_agent', 'pre_accept_failed', 'accept_failed', 'accepted', 'missed')),
  duration_seconds INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answered_at TIMESTAMPTZ,
  ended_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '45 seconds')
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

-- Atomic update for conversation last message & unread count
CREATE OR REPLACE FUNCTION public.update_conversation_last_message(
  p_conversation_id UUID,
  p_last_message_text TEXT,
  p_last_message_at TIMESTAMPTZ DEFAULT NOW(),
  p_increment_unread BOOLEAN DEFAULT TRUE
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.conversations WHERE id = p_conversation_id) THEN
    RETURN;
  END IF;

  UPDATE public.conversations
  SET
    last_message_text = p_last_message_text,
    last_message_at = p_last_message_at,
    unread_count = CASE WHEN p_increment_unread THEN COALESCE(unread_count, 0) + 1 ELSE unread_count END,
    updated_at = NOW()
  WHERE id = p_conversation_id;
END;
$$;

-- Restrict RPC execution strictly to service-role (webhook internal helper)
REVOKE EXECUTE ON FUNCTION public.update_conversation_last_message(UUID, TEXT, TIMESTAMPTZ, BOOLEAN) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_conversation_last_message(UUID, TEXT, TIMESTAMPTZ, BOOLEAN) TO service_role;

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
  ('050', 'docs/deploy/calls.sql')
ON CONFLICT (version) DO NOTHING;
