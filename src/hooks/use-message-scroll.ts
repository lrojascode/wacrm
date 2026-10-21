'use client';

import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { Message } from '@/types';

export interface ReadingPosition {
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
  loaded: boolean,
  savedPositions?: RefObject<Map<string, ReadingPosition>>
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
  const onScroll = () => {
    if (scrollRef.current) {
      position.current = readPosition(scrollRef.current);
      if (conversationId && loaded)
        savedPositions?.current.set(conversationId, position.current);
    }
  };

  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const before = previous.current;
    const firstLoad =
      before.id !== conversationId || (!before.loaded && loaded);
    const saved =
      firstLoad && conversationId
        ? savedPositions?.current.get(conversationId)
        : undefined;
    if (firstLoad) {
      position.current = saved ?? null;
      ownSend.current = false;
    }
    const appended = messages.some((message) => !before.ids.has(message.id));
    if (
      (firstLoad && !saved) ||
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
    if (loaded && conversationId)
      savedPositions?.current.set(conversationId, position.current);
  }, [conversationId, messages, loaded, savedPositions]);

  // Banners, the composer, keyboard/viewport changes and media can resize
  // after the initial scroll. Keep the end only if the reader was following;
  // otherwise preserve the visible anchor, never pull them out of history.
  useLayoutEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      const saved = position.current;
      if (!saved) return;
      if (saved.atBottom) element.scrollTop = element.scrollHeight;
      else if (saved.anchorId && saved.anchorOffset !== undefined) {
        const anchor = [
          ...element.querySelectorAll<HTMLElement>('[data-message-id]'),
        ].find((node) => node.dataset.messageId === saved.anchorId);
        if (anchor)
          element.scrollTop +=
            anchor.getBoundingClientRect().top -
            element.getBoundingClientRect().top -
            saved.anchorOffset;
      }
      position.current = readPosition(element);
      if (loaded && conversationId)
        savedPositions?.current.set(conversationId, position.current);
    });
    observer.observe(element);
    if (element.firstElementChild) observer.observe(element.firstElementChild);
    return () => observer.disconnect();
  }, [conversationId, loaded, messages, savedPositions]);

  return { scrollRef, onScroll, followOwnSend };
}
