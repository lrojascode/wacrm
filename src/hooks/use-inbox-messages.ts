'use client';

import { useCallback, useState } from 'react';
import type { Message } from '@/types';
import {
  mergeMessageSnapshot,
  sortMessages,
  updateMessage,
} from '@/lib/inbox/messages';

function emptyThread(conversationId: string | null) {
  return { conversationId, messages: [] as Message[], loaded: false };
}

export function useInboxMessages(conversationId: string | null) {
  const [thread, setThread] = useState(() => emptyThread(conversationId));
  // Reset with the committed route, before painting a different contact's header.
  if (thread.conversationId !== conversationId) {
    setThread(emptyThread(conversationId));
  }

  const onMessagesLoaded = useCallback(
    (id: string, rows: Message[], baseline: Message[]) => {
      setThread((current) =>
        current.conversationId !== id
          ? current
          : {
              ...current,
              loaded: true,
              messages: mergeMessageSnapshot(current.messages, rows, baseline),
            }
      );
    },
    []
  );

  const onNewMessage = useCallback((message: Message) => {
    setThread((current) => {
      if (current.conversationId !== message.conversation_id) return current;
      if (current.messages.some((m) => m.id === message.id)) return current;
      return {
        ...current,
        messages: sortMessages([...current.messages, message]),
      };
    });
  }, []);

  const onUpdateMessage = useCallback(
    (id: string, updates: Partial<Message>) => {
      setThread((current) => {
        if (!current.messages.some((m) => m.id === id)) return current;
        return {
          ...current,
          messages: updateMessage(current.messages, id, updates),
        };
      });
    },
    []
  );

  return {
    messages: thread.messages,
    messagesLoaded: thread.loaded,
    onMessagesLoaded,
    onNewMessage,
    onUpdateMessage,
  };
}
