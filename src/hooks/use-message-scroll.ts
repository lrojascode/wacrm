'use client';

import { useCallback, useLayoutEffect, useRef } from 'react';
import type { Message } from '@/types';

interface ReadingPosition {
  top: number;
  atBottom: boolean;
  anchorId?: string;
  anchorOffset?: number;
}

function readPosition(element: HTMLDivElement): ReadingPosition {
  const bounds = element.getBoundingClientRect();
  const anchor = [
    ...element.querySelectorAll<HTMLElement>('[data-message-id]'),
  ].find((node) => node.getBoundingClientRect().bottom > bounds.top);
  return {
    top: element.scrollTop,
    atBottom:
      element.scrollHeight - element.clientHeight - element.scrollTop <= 64,
    anchorId: anchor?.dataset.messageId,
    anchorOffset: anchor
      ? anchor.getBoundingClientRect().top - bounds.top
      : undefined,
  };
}

export function useMessageScroll(
  conversationId: string | undefined,
  messages: Message[],
  loaded: boolean
) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const position = useRef<ReadingPosition | null>(null);
  const previous = useRef<{ id?: string; loaded: boolean; ids: Set<string> }>({
    loaded: false,
    ids: new Set(),
  });
  const ownSend = useRef(false);
  const followOwnSend = useCallback(() => {
    ownSend.current = true;
  }, []);
  const onScroll = useCallback(() => {
    if (scrollRef.current) position.current = readPosition(scrollRef.current);
  }, []);

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const before = previous.current;
    const firstLoad =
      before.id !== conversationId || (!before.loaded && loaded);
    const appended = messages.some((message) => !before.ids.has(message.id));
    if (
      firstLoad ||
      ownSend.current ||
      (appended && position.current?.atBottom)
    ) {
      element.scrollTop = element.scrollHeight;
    } else if (position.current) {
      const saved = position.current;
      const anchor = [
        ...element.querySelectorAll<HTMLElement>('[data-message-id]'),
      ].find((node) => node.dataset.messageId === saved.anchorId);
      if (anchor && saved.anchorOffset !== undefined) {
        element.scrollTop +=
          anchor.getBoundingClientRect().top -
          element.getBoundingClientRect().top -
          saved.anchorOffset;
      } else {
        element.scrollTop = Math.min(
          saved.top,
          Math.max(0, element.scrollHeight - element.clientHeight)
        );
      }
    }
    ownSend.current = false;
    previous.current = {
      id: conversationId,
      loaded,
      ids: new Set(messages.map((m) => m.id)),
    };
    position.current = readPosition(element);
  }, [conversationId, messages, loaded]);

  return { scrollRef, onScroll, followOwnSend };
}
