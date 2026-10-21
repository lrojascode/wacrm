-- Shared inbox receipts. Message identity, rather than provider timestamps,
-- bounds acknowledgements; a concurrent/new/backdated message stays unread.
BEGIN;
SET LOCAL lock_timeout = '10s';
-- Acquire both table locks without waiting: a partial lock acquisition must
-- not deadlock an ingress/receipt already holding the other table. Abort this
-- migration harmlessly if busy; retry in the agreed maintenance window.
LOCK TABLE public.conversations, public.messages IN ACCESS EXCLUSIVE MODE NOWAIT;

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS inbox_unread boolean NOT NULL DEFAULT false;
ALTER TABLE public.conversations ADD COLUMN IF NOT EXISTS unread_revision bigint NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_messages_inbox_pending ON public.messages(conversation_id, id) WHERE inbox_unread;
CREATE INDEX IF NOT EXISTS idx_messages_inbound_delivery ON public.messages(conversation_id, message_id) WHERE sender_type = 'customer' AND message_id IS NOT NULL;

-- Preserve the old aggregate once. The precise historical read identities are
-- unknowable; choose the latest N eligible rows without claiming read times.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.schema_release WHERE version = '054') THEN
    IF EXISTS (
      SELECT 1 FROM public.conversations c WHERE coalesce(c.unread_count, 0) < 0
        OR coalesce(c.unread_count, 0) > (
          SELECT count(*) FROM public.messages m WHERE m.conversation_id = c.id
            AND m.sender_type = 'customer'
            AND (m.content_type <> 'call' OR m.call_outcome = 'missed')
        )
    ) THEN
      RAISE EXCEPTION '054: unread counters cannot be reconciled with eligible history; investigate before migrating';
    END IF;
    WITH ranked AS (
      SELECT m.id, c.unread_count,
        row_number() OVER (PARTITION BY m.conversation_id ORDER BY m.created_at DESC, m.id DESC) AS n
      FROM public.messages m JOIN public.conversations c ON c.id = m.conversation_id
      WHERE m.sender_type = 'customer' AND (m.content_type <> 'call' OR m.call_outcome = 'missed')
    )
    UPDATE public.messages m SET inbox_unread = true FROM ranked r
      WHERE m.id = r.id AND r.n <= coalesce(r.unread_count, 0);
    UPDATE public.conversations SET unread_count = coalesce(unread_count, 0);
  END IF;
END $$;
ALTER TABLE public.conversations ALTER COLUMN unread_count SET NOT NULL;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='public.conversations'::regclass AND conname='conversations_unread_nonnegative') THEN
    ALTER TABLE public.conversations ADD CONSTRAINT conversations_unread_nonnegative CHECK (unread_count >= 0);
  END IF;
END $$;

-- Invoker guards distinguish direct API writes from the narrowly granted
-- SECURITY DEFINER receipt/aggregate functions. No caller-controlled GUC bypass.
CREATE OR REPLACE FUNCTION public.guard_inbox_aggregate() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated', 'service_role') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.unread_count := 0;
      NEW.unread_revision := 0;
    ELSE
      -- Legacy clients/webhooks may still send zero or a stale N+1. Ignore
      -- just these fields so unrelated preview/status updates keep working.
      NEW.unread_count := OLD.unread_count;
      NEW.unread_revision := OLD.unread_revision;
    END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_inbox_aggregate ON public.conversations;
CREATE TRIGGER guard_inbox_aggregate BEFORE INSERT OR UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION public.guard_inbox_aggregate();

CREATE OR REPLACE FUNCTION public.guard_inbox_message_update() RETURNS trigger
LANGUAGE plpgsql SET search_path = public AS $$
BEGIN
  IF current_user IN ('anon', 'authenticated', 'service_role') AND
    (NEW.inbox_unread IS DISTINCT FROM OLD.inbox_unread OR
     NEW.conversation_id IS DISTINCT FROM OLD.conversation_id OR
     NEW.sender_type IS DISTINCT FROM OLD.sender_type OR
     NEW.content_type IS DISTINCT FROM OLD.content_type OR
     NEW.call_outcome IS DISTINCT FROM OLD.call_outcome) THEN
    RAISE EXCEPTION 'Use the inbox receipt operation for protected message state' USING ERRCODE = '42501';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS guard_inbox_message_update ON public.messages;
CREATE TRIGGER guard_inbox_message_update BEFORE UPDATE ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.guard_inbox_message_update();

CREATE OR REPLACE FUNCTION public.prepare_inbox_message() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  -- All ingress and receipt operations take this same lock first. NO KEY
  -- UPDATE also avoids conflicting with the message FK's key-share lock.
  PERFORM 1 FROM public.conversations WHERE id = NEW.conversation_id FOR NO KEY UPDATE;
  IF NEW.sender_type = 'customer' AND NEW.message_id IS NOT NULL AND EXISTS (
    SELECT 1 FROM public.messages m WHERE m.conversation_id = NEW.conversation_id
      AND m.sender_type = 'customer' AND m.message_id = NEW.message_id AND m.id <> NEW.id
  ) THEN
    RAISE EXCEPTION 'Inbound delivery already persisted' USING ERRCODE = '23505';
  END IF;
  NEW.inbox_unread := NEW.sender_type = 'customer'
    AND (NEW.content_type <> 'call' OR coalesce(NEW.call_outcome = 'missed', false));
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS prepare_inbox_message ON public.messages;
CREATE TRIGGER prepare_inbox_message BEFORE INSERT ON public.messages
  FOR EACH ROW EXECUTE FUNCTION public.prepare_inbox_message();

-- Statement transition tables make a batch receipt one aggregate write, not
-- one UPDATE per message. Status/reaction edits and idempotent receipts write none.
CREATE OR REPLACE FUNCTION public.apply_inbox_message_delta() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE r record;
BEGIN
  IF TG_OP = 'INSERT' THEN
    FOR r IN SELECT conversation_id, count(*) AS delta FROM new_rows WHERE inbox_unread GROUP BY conversation_id ORDER BY conversation_id LOOP
      UPDATE public.conversations SET unread_count = unread_count + r.delta,
        unread_revision = unread_revision + 1 WHERE id = r.conversation_id;
    END LOOP;
  ELSIF TG_OP = 'DELETE' THEN
    FOR r IN SELECT conversation_id, -count(*) AS delta FROM old_rows WHERE inbox_unread GROUP BY conversation_id ORDER BY conversation_id LOOP
      UPDATE public.conversations SET unread_count = unread_count + r.delta,
        unread_revision = unread_revision + 1 WHERE id = r.conversation_id;
    END LOOP;
  ELSE
    FOR r IN SELECT conversation_id, sum(delta) AS delta FROM (
      SELECT conversation_id, 1 AS delta FROM new_rows WHERE inbox_unread
      UNION ALL SELECT conversation_id, -1 AS delta FROM old_rows WHERE inbox_unread
    ) d GROUP BY conversation_id HAVING sum(delta) <> 0 ORDER BY conversation_id LOOP
      UPDATE public.conversations SET unread_count = unread_count + r.delta,
        unread_revision = unread_revision + 1 WHERE id = r.conversation_id;
    END LOOP;
  END IF;
  RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS inbox_message_insert ON public.messages;
DROP TRIGGER IF EXISTS inbox_message_update ON public.messages;
DROP TRIGGER IF EXISTS inbox_message_delete ON public.messages;
CREATE TRIGGER inbox_message_insert AFTER INSERT ON public.messages REFERENCING NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.apply_inbox_message_delta();
CREATE TRIGGER inbox_message_update AFTER UPDATE ON public.messages REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.apply_inbox_message_delta();
CREATE TRIGGER inbox_message_delete AFTER DELETE ON public.messages REFERENCING OLD TABLE AS old_rows
  FOR EACH STATEMENT EXECUTE FUNCTION public.apply_inbox_message_delta();

CREATE OR REPLACE FUNCTION public.acknowledge_inbox_messages(p_conversation_id uuid, p_message_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE c public.conversations;
BEGIN
  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id FOR NO KEY UPDATE;
  IF NOT FOUND OR NOT public.is_account_member(c.account_id, 'agent') THEN
    RAISE EXCEPTION 'Conversation not available for acknowledgement' USING ERRCODE = '42501';
  END IF;
  IF p_message_ids IS NULL OR cardinality(p_message_ids) > 500 OR array_position(p_message_ids, NULL) IS NOT NULL THEN
    RAISE EXCEPTION 'Expected at most 500 message IDs' USING ERRCODE = '22023';
  END IF;
  IF EXISTS (SELECT 1 FROM public.messages WHERE id = ANY(p_message_ids) AND conversation_id <> p_conversation_id) THEN
    RAISE EXCEPTION 'Message does not belong to conversation' USING ERRCODE = '22023';
  END IF;
  UPDATE public.messages SET inbox_unread = false
    WHERE conversation_id = p_conversation_id AND id = ANY(p_message_ids) AND inbox_unread;
  SELECT * INTO c FROM public.conversations WHERE id = p_conversation_id;
  -- Missing/deleted IDs are terminal too. Retrying an already committed batch
  -- returns the same acknowledgement without touching any row.
  RETURN jsonb_build_object('acknowledged_ids', p_message_ids,
    'conversation_id', c.id, 'unread_count', c.unread_count, 'unread_revision', c.unread_revision);
END $$;
REVOKE ALL ON FUNCTION public.acknowledge_inbox_messages(uuid, uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.acknowledge_inbox_messages(uuid, uuid[]) TO authenticated;
REVOKE ALL ON FUNCTION public.prepare_inbox_message() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.apply_inbox_message_delta() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_inbox_message_update() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.guard_inbox_aggregate() FROM PUBLIC, anon, authenticated;

-- Preserve the old signature for old application instances. Message INSERT
-- now owns the count, including missed-call eligibility.
CREATE OR REPLACE FUNCTION public.update_conversation_last_message(
  p_conversation_id uuid, p_last_message_text text,
  p_last_message_at timestamptz DEFAULT now(), p_increment_unread boolean DEFAULT true
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE public.conversations SET last_message_text = p_last_message_text,
    last_message_at = p_last_message_at, updated_at = now() WHERE id = p_conversation_id;
END $$;
REVOKE ALL ON FUNCTION public.update_conversation_last_message(uuid, text, timestamptz, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.update_conversation_last_message(uuid, text, timestamptz, boolean) TO service_role;


-- Merges lock all parents before moving message rows. Counts now travel with
-- receipts; recompute from those receipts instead of a pre-lock SUM.
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
    PERFORM 1 FROM public.conversations WHERE id = ANY(v_group.ids) ORDER BY id FOR NO KEY UPDATE;
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
    SET unread_count      = (SELECT count(*) FROM public.messages WHERE conversation_id = v_survivor AND inbox_unread),
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
    SET unread_count = (SELECT count(*) FROM public.messages WHERE conversation_id = v_survivor AND inbox_unread),
        updated_at   = NOW()
    WHERE id = v_survivor
      AND NOT EXISTS (SELECT 1 FROM messages WHERE conversation_id = v_survivor);

    DELETE FROM conversations WHERE id = ANY(v_losers);

    v_merged := v_merged + COALESCE(array_length(v_losers, 1), 0);
  END LOOP;

  RETURN v_merged;
END;
$$;
REVOKE ALL ON FUNCTION public.merge_duplicate_conversations() FROM PUBLIC, anon, authenticated;
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
  -- converges on (see findOrCreateConversation's `order by created_at`).
  SELECT array_agg(id ORDER BY created_at ASC, id ASC)
    INTO v_all
    FROM contacts
   WHERE id = ANY(p_ids);

  IF v_all IS NULL OR array_length(v_all, 1) < 2 THEN
    RETURN 0;
  END IF;

  -- Refuse to merge across tenants. Nothing should ever call this with a
  -- mixed set, and silently collapsing two accounts' contacts would be
  -- an unrecoverable tenancy breach — fail loudly instead.
  SELECT count(DISTINCT account_id) INTO v_accounts
    FROM contacts WHERE id = ANY(v_all);
  IF v_accounts > 1 THEN
    RAISE EXCEPTION 'merge_contact_group: refusing to merge contacts across % accounts', v_accounts;
  END IF;

  v_survivor := v_all[1];
  v_losers   := v_all[2:array_length(v_all, 1)];

  PERFORM 1 FROM public.conversations WHERE contact_id = ANY(v_all) ORDER BY id FOR NO KEY UPDATE;

  -- ---- conversations ---------------------------------------
  -- This block is the whole point of the migration. Re-pointing the
  -- losers' conversations directly at the survivor violates
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
           unread_count = (SELECT count(*) FROM public.messages WHERE conversation_id = v_conv_survivor AND inbox_unread),
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
REVOKE ALL ON FUNCTION public.merge_contact_group(uuid[]) FROM PUBLIC, anon, authenticated;

INSERT INTO public.schema_release(version, bundle) VALUES ('054', 'docs/deploy/inbox-read-state.sql') ON CONFLICT DO NOTHING;
COMMIT;
