-- ============================================================
-- wacrm — contact-tasks
-- Migration 049.
--
-- GENERATED FILE — do not edit. Regenerate with:
--   ./scripts/deploy/bundle-migrations.sh docs/deploy/contact-tasks.sql 049
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
-- ##  049_contact_tasks.sql
-- ############################################################

-- ============================================================
-- 049_contact_tasks.sql
--
-- Scheduled tasks bound to contacts with in-CRM notification on app load.
--
-- Idempotent - safe to re-run.
-- ============================================================

-- ============================================================
-- 1. Create contact_tasks table
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_tasks (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  notes TEXT,
  due_at TIMESTAMPTZ NOT NULL,
  completed_at TIMESTAMPTZ,
  notified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_tasks_contact
  ON contact_tasks(contact_id);

CREATE INDEX IF NOT EXISTS idx_contact_tasks_account_due
  ON contact_tasks(account_id, due_at)
  WHERE completed_at IS NULL AND notified_at IS NULL;

ALTER TABLE contact_tasks ENABLE ROW LEVEL SECURITY;

-- SELECT for any account member (team members can see task context)
DROP POLICY IF EXISTS contact_tasks_select ON contact_tasks;
CREATE POLICY contact_tasks_select ON contact_tasks FOR SELECT
  USING (is_account_member(account_id));

-- INSERT for any account member
DROP POLICY IF EXISTS contact_tasks_insert ON contact_tasks;
CREATE POLICY contact_tasks_insert ON contact_tasks FOR INSERT
  WITH CHECK (is_account_member(account_id) AND auth.uid() = created_by);

-- UPDATE for creator or admin+
DROP POLICY IF EXISTS contact_tasks_update ON contact_tasks;
CREATE POLICY contact_tasks_update ON contact_tasks FOR UPDATE
  USING (
    is_account_member(account_id) AND
    (created_by = auth.uid() OR is_account_member(account_id, 'admin'))
  );

-- DELETE for creator or admin+
DROP POLICY IF EXISTS contact_tasks_delete ON contact_tasks;
CREATE POLICY contact_tasks_delete ON contact_tasks FOR DELETE
  USING (
    is_account_member(account_id) AND
    (created_by = auth.uid() OR is_account_member(account_id, 'admin'))
  );

-- ============================================================
-- 2. Widen notifications_type_check to include ’task_due’
-- ============================================================
ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN ('conversation_assigned', 'deal_assigned', 'task_due'));

-- ============================================================
-- 3. Atomic RPC to process due tasks and create notifications
-- ============================================================
CREATE OR REPLACE FUNCTION process_due_tasks()
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_account_id UUID;
  v_count INTEGER := 0;
  v_task RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RETURN 0;
  END IF;

  SELECT account_id INTO v_account_id
  FROM public.profiles
  WHERE user_id = v_user_id
  LIMIT 1;

  IF v_account_id IS NULL THEN
    RETURN 0;
  END IF;

  FOR v_task IN
    SELECT t.id, t.account_id, t.contact_id, t.conversation_id, t.created_by, t.title, t.notes
    FROM public.contact_tasks t
    WHERE t.account_id = v_account_id
      AND t.created_by = v_user_id
      AND t.due_at <= NOW()
      AND t.completed_at IS NULL
      AND t.notified_at IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    UPDATE public.contact_tasks
    SET notified_at = NOW(),
        updated_at = NOW()
    WHERE id = v_task.id;

    INSERT INTO public.notifications (
      account_id,
      user_id,
      type,
      conversation_id,
      contact_id,
      actor_user_id,
      title,
      body
    ) VALUES (
      v_task.account_id,
      v_task.created_by,
      'task_due',
      v_task.conversation_id,
      v_task.contact_id,
      NULL,
      v_task.title,
      COALESCE(v_task.notes, 'Task due')
    );

    v_count := v_count + 1;
  END LOOP;

  RETURN v_count;
END;
$$;

NOTIFY pgrst, 'reload schema';
