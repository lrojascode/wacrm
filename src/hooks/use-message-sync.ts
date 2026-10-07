'use client';

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { createClient } from '@/lib/supabase/client';
import type { Message } from '@/types';
import { mergeMessageSnapshot } from '@/lib/inbox/messages';

export function useMessageSync(
  conversationId: string | undefined,
  messages: Message[],
  onLoaded: (id: string, rows: Message[], baseline: Message[]) => void,
  resyncToken: number
) {
  const latest = useRef({ messages, onLoaded });
  useLayoutEffect(() => {
    latest.current = { messages, onLoaded };
  });
  const runner = useRef<{ request: () => void } | null>(null);
  const [status, setStatus] = useState<{
    id?: string;
    syncing: boolean;
    error: boolean;
  }>({ syncing: false, error: false });

  useEffect(() => {
    if (!conversationId) return;
    let disposed = false;
    let active = false;
    let pending = false;
    const supabase = createClient();
    const abortController = new AbortController();

    const request = async () => {
      if (disposed) return;
      if (active) {
        pending = true;
        return;
      }
      active = true;
      try {
        do {
          pending = false;
          setStatus({ id: conversationId, syncing: true, error: false });
          const baseline = latest.current.messages;
          try {
            const { data, error } = await supabase
              .from('messages')
              .select('*')
              .eq('conversation_id', conversationId)
              .abortSignal(abortController.signal)
              .order('created_at', { ascending: true });
            if (disposed) return;
            if (error) throw error;
            latest.current.onLoaded(conversationId, data ?? [], baseline);
            // A queued query can start before React commits this result.
            // Give it the same baseline the parent is about to render.
            latest.current.messages = mergeMessageSnapshot(
              latest.current.messages,
              data ?? [],
              baseline
            );
            setStatus({ id: conversationId, syncing: true, error: false });
          } catch (error) {
            if (disposed) return;
            console.error('Failed to fetch messages:', error);
            setStatus({ id: conversationId, syncing: true, error: true });
          }
        } while (pending && !disposed);
      } finally {
        active = false;
        if (!disposed) setStatus((prev) => ({ ...prev, syncing: false }));
      }
    };
    const controller = {
      request: () => {
        void request();
      },
    };
    runner.current = controller;
    controller.request();
    return () => {
      disposed = true;
      abortController.abort();
      if (runner.current === controller) runner.current = null;
    };
  }, [conversationId]);

  const tokenRef = useRef(resyncToken);
  useEffect(() => {
    if (tokenRef.current === resyncToken) return;
    tokenRef.current = resyncToken;
    runner.current?.request();
  }, [resyncToken]);

  const retry = useCallback(() => runner.current?.request(), []);
  return {
    syncing: status.id === conversationId && status.syncing,
    error: status.id === conversationId && status.error,
    retry,
  };
}
