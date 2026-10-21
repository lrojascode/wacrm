'use client';
import { useEffect, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { subscribeInboxChannel } from '@/lib/inbox/realtime';
import { useAuth } from '@/hooks/use-auth';
import { mergeUnreadState, type UnreadState } from '@/lib/inbox/unread';
import {
  INBOX_READ_EVENT,
  INBOX_SNAPSHOT_EVENT,
  INBOX_RECONCILE_MS,
  subscribeInboxRecovery,
  type InboxReadReceipt,
} from '@/lib/inbox/read-queue';

/** Shared conversation count, recovered independently of the inbox route. */
export function useTotalUnread(): number {
  const [state, setState] = useState({ scope: '', total: 0 });
  const { user, accountId } = useAuth();
  const userId = user?.id;
  const scope = userId && accountId ? `${userId}:${accountId}` : null;
  useEffect(() => {
    if (!userId || !accountId) return;
    const client = createClient();
    let disposed = false;
    let active = false;
    let pending = false;
    const counts = new Map<string, UnreadState>();
    const changed = new Map<string, number>();
    let generation = 0;
    const publish = () => {
      setState({
        scope: scope!,
        total: [...counts.values()].filter((row) => row.unread_count > 0)
          .length,
      });
      window.dispatchEvent(
        new CustomEvent(INBOX_SNAPSHOT_EVENT, { detail: [...counts.values()] })
      );
    };
    const apply = (row: UnreadState) => {
      counts.set(
        row.id,
        mergeUnreadState(counts.get(row.id), { ...counts.get(row.id), ...row })
      );
      changed.set(row.id, ++generation);
      publish();
    };
    const resync = async () => {
      if (disposed) return;
      if (active) {
        pending = true;
        return;
      }
      active = true;
      try {
        do {
          pending = false;
          const before = generation;
          const rows: UnreadState[] = [];
          for (let offset = 0; ; offset += 500) {
            const { data, error } = await client
              .from('conversations')
              .select(
                'id, unread_count, unread_revision, last_message_at, last_message_text'
              )
              .order('id')
              .range(offset, offset + 499);
            if (disposed || error) return;
            rows.push(...data);
            if (data.length < 500) break;
          }
          const fetched = new Set(rows.map((row) => row.id));
          for (const row of rows) {
            if ((changed.get(row.id) ?? 0) > before && !counts.has(row.id))
              continue;
            counts.set(
              row.id,
              mergeUnreadState(counts.get(row.id), {
                ...counts.get(row.id),
                ...row,
              })
            );
          }
          for (const id of counts.keys())
            if (!fetched.has(id) && (changed.get(id) ?? 0) <= before)
              counts.delete(id);
          publish();
        } while (pending && !disposed);
      } finally {
        active = false;
      }
    };
    const recover = subscribeInboxRecovery(() => {
      void resync();
    });
    const acknowledge = (event: Event) => {
      const receipt = (event as CustomEvent<InboxReadReceipt>).detail;
      apply({
        id: receipt.conversation_id,
        unread_count: receipt.unread_count,
        unread_revision: receipt.unread_revision,
      });
    };
    window.addEventListener(INBOX_READ_EVENT, acknowledge);
    const stop = subscribeInboxChannel(
      client,
      'total-unread-realtime',
      (channel) =>
        channel.on(
          'postgres_changes',
          {
            event: '*',
            schema: 'public',
            table: 'conversations',
          },
          (payload) => {
            if (payload.eventType === 'DELETE') {
              const id = payload.old.id as string;
              counts.delete(id);
              changed.set(id, ++generation);
              publish();
            } else apply(payload.new as UnreadState);
          }
        )
    );
    // A connected socket can silently miss a change (e.g. server-side
    // rate limiting). One shared, compact reconciliation while visible bounds
    // that staleness without polling full histories or writing any data.
    const interval = setInterval(() => {
      if (document.visibilityState === 'visible' && navigator.onLine)
        void resync();
    }, INBOX_RECONCILE_MS);
    void resync();
    return () => {
      clearInterval(interval);
      disposed = true;
      recover();
      window.removeEventListener(INBOX_READ_EVENT, acknowledge);
      stop();
    };
  }, [userId, accountId, scope]);
  return scope && state.scope === scope ? state.total : 0;
}
