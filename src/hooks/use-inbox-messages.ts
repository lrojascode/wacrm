'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { Message } from '@/types';
import {
  mergeMessageSnapshot,
  sortMessages,
  updateMessage,
} from '@/lib/inbox/messages';
import type { ReadingPosition } from './use-message-scroll';

export const INBOX_CACHE_LIMIT = 20;
interface Thread {
  messages: Message[];
  loaded: boolean;
  draft: string;
}
const emptyThread = (): Thread => ({ messages: [], loaded: false, draft: '' });

function trim(threads: Map<string, Thread>, activeId: string | null) {
  for (const [id, thread] of threads) {
    if (threads.size <= INBOX_CACHE_LIMIT) break;
    if (id !== activeId && !thread.messages.some((m) => m.status === 'sending'))
      threads.delete(id);
  }
  return threads;
}

// Lifetime and account isolation are owned by the static Inbox layout.
export function useInboxMessages(conversationId: string | null) {
  const readingPositions = useRef(new Map<string, ReadingPosition>());
  const [cache, setCache] = useState(() => ({
    activeId: conversationId,
    threads: new Map<string, Thread>(
      conversationId ? [[conversationId, emptyThread()]] : []
    ),
  }));
  if (cache.activeId !== conversationId) {
    const threads = new Map(cache.threads);
    if (conversationId) {
      const thread = threads.get(conversationId) ?? emptyThread();
      threads.delete(conversationId);
      threads.set(conversationId, thread);
    }
    setCache({
      activeId: conversationId,
      threads: trim(threads, conversationId),
    });
  }

  const onMessagesLoaded = useCallback(
    (id: string, rows: Message[], baseline: Message[]) => {
      setCache((current) => {
        const thread = current.threads.get(id);
        if (!thread) return current;
        const threads = new Map(current.threads);
        threads.set(id, {
          ...thread,
          loaded: true,
          messages: mergeMessageSnapshot(
            thread.messages,
            rows.filter((m) => m.conversation_id === id),
            baseline
          ),
        });
        return { ...current, threads: trim(threads, current.activeId) };
      });
    },
    []
  );

  const onNewMessage = useCallback((message: Message) => {
    setCache((current) => {
      const thread = current.threads.get(message.conversation_id);
      if (!thread || thread.messages.some((m) => m.id === message.id))
        return current;
      const threads = new Map(current.threads);
      threads.set(message.conversation_id, {
        ...thread,
        messages: sortMessages([...thread.messages, message]),
      });
      return { ...current, threads };
    });
  }, []);

  const onUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>, conversation?: string) => {
      setCache((current) => {
        const owner = conversation ?? updates.conversation_id;
        const entry = [...current.threads].find(
          ([convId, thread]) =>
            (!owner || owner === convId) &&
            thread.messages.some((m) => m.id === id)
        );
        if (!entry) return current;
        const [convId, thread] = entry;
        const threads = new Map(current.threads);
        threads.set(convId, {
          ...thread,
          messages: updateMessage(thread.messages, id, updates),
        });
        return { ...current, threads: trim(threads, current.activeId) };
      });
    },
    []
  );

  const onMessagesAcknowledged = useCallback((id: string, ids: string[]) => {
    setCache((current) => {
      const thread = current.threads.get(id);
      const read = new Set(ids);
      if (
        !thread ||
        !thread.messages.some(
          (message) => read.has(message.id) && message.inbox_unread
        )
      )
        return current;
      const threads = new Map(current.threads);
      threads.set(id, {
        ...thread,
        messages: thread.messages.map((message) =>
          read.has(message.id) ? { ...message, inbox_unread: false } : message
        ),
      });
      return { ...current, threads };
    });
  }, []);

  const onDraftChange = useCallback(
    (draft: string) => {
      if (!conversationId) return;
      setCache((current) => {
        const thread = current.threads.get(conversationId);
        if (!thread || thread.draft === draft) return current;
        const threads = new Map(current.threads);
        threads.set(conversationId, { ...thread, draft });
        return { ...current, threads };
      });
    },
    [conversationId]
  );

  const thread =
    (conversationId && cache.threads.get(conversationId)) || emptyThread();
  // Drop scroll records for evicted conversations, without render-time ref reads.
  const retainReadingPositions = useCallback(() => {
    for (const id of readingPositions.current.keys()) {
      if (!cache.threads.has(id)) readingPositions.current.delete(id);
    }
  }, [cache.threads]);
  useEffect(retainReadingPositions, [retainReadingPositions]);
  return {
    messages: thread.messages,
    messagesLoaded: thread.loaded,
    draft: thread.draft,
    onMessagesLoaded,
    onNewMessage,
    onUpdateMessage,
    onMessagesAcknowledged,
    onDraftChange,
    readingPositions,
    retainReadingPositions,
  };
}
