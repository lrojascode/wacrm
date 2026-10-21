'use client';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  type ReactNode,
} from 'react';
import { useAuth } from '@/hooks/use-auth';
import { createClient } from '@/lib/supabase/client';
import {
  INBOX_READ_EVENT,
  INBOX_RECOVERY_EVENT,
  InboxReadQueue,
  READ_QUEUE_PREFIX,
  subscribeInboxRecovery,
} from '@/lib/inbox/read-queue';

const Context = createContext<InboxReadQueue | null>(null);
export const useInboxReadQueue = () => useContext(Context);

/** Above /inbox so leaving the inbox does not discard observed receipts. */
export function InboxReadProvider({ children }: { children: ReactNode }) {
  const { user, accountId, accountRole, profileLoading, loading } = useAuth();
  const allowed = !profileLoading && !!accountRole && accountRole !== 'viewer';
  const scope = user && accountId ? `${user.id}:${accountId}` : null;
  const previousScope = useRef<string | null>(null);
  const queue = useMemo(
    () =>
      scope && allowed
        ? new InboxReadQueue(
            READ_QUEUE_PREFIX + scope,
            createClient(),
            (receipt) =>
              window.dispatchEvent(
                new CustomEvent(INBOX_READ_EVENT, { detail: receipt })
              )
          )
        : null,
    [scope, allowed]
  );
  useEffect(() => {
    if ((scope && scope !== previousScope.current) || (!user && !loading)) {
      if (previousScope.current) {
        try {
          sessionStorage.removeItem(READ_QUEUE_PREFIX + previousScope.current);
        } catch {}
      }
      previousScope.current = scope;
    }
  }, [scope, user, loading]);
  useEffect(() => {
    if (!queue) return;
    queue.start();
    const unsubscribe = subscribeInboxRecovery((event) =>
      queue.retry(event?.type === INBOX_RECOVERY_EVENT)
    );
    return () => {
      unsubscribe();
      queue.stop();
    };
  }, [queue]);
  return <Context.Provider value={queue}>{children}</Context.Provider>;
}
