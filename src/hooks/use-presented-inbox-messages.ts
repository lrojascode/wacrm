'use client';
import { useEffect, useRef, type RefObject } from 'react';
import type { Message } from '@/types';
import { useInboxReadQueue } from '@/components/inbox/inbox-read-provider';
import { subscribeInboxRecovery } from '@/lib/inbox/read-queue';

export function usePresentedInboxMessages(
  conversationId: string | undefined,
  messages: Message[],
  loaded: boolean,
  scrollRef: RefObject<HTMLDivElement | null>
) {
  const queue = useInboxReadQueue();
  const latest = useRef({ conversationId, messages, loaded });
  useEffect(() => {
    latest.current = { conversationId, messages, loaded };
  });
  useEffect(() => {
    const element = scrollRef.current;
    if (!element || !queue) return;
    let frame = 0;
    const check = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const current = latest.current;
        if (
          !current.conversationId ||
          !current.loaded ||
          document.visibilityState !== 'visible'
        )
          return;
        const bounds = element.getBoundingClientRect();
        if (
          bounds.width <= 0 ||
          bounds.height <= 0 ||
          document.querySelector('[data-testid="session-overlay"]')
        )
          return;
        if (
          [...document.querySelectorAll<HTMLElement>('[role="dialog"]')].some(
            (dialog) => dialog.getBoundingClientRect().height > 0
          )
        )
          return;
        if (element.scrollHeight - element.clientHeight - element.scrollTop > 2)
          return;
        // Capture only the IDs in this committed DOM, never future/hidden rows.
        const rendered = new Set(
          [...element.querySelectorAll<HTMLElement>('[data-message-id]')].map(
            (node) => node.dataset.messageId
          )
        );
        queue.add(
          current.conversationId,
          current.messages
            .filter(
              (message) =>
                message.inbox_unread === true && rendered.has(message.id)
            )
            .map((message) => message.id)
        );
      });
    };
    const unsubscribe = subscribeInboxRecovery(check);
    const observer = new ResizeObserver(check);
    observer.observe(element);
    const modals = new MutationObserver((records) => {
      if (
        records.some((record) =>
          [...record.addedNodes, ...record.removedNodes].some(
            (node) =>
              node instanceof Element &&
              (node.matches('[role="dialog"]') ||
                node.querySelector('[role="dialog"]'))
          )
        )
      )
        check();
    });
    modals.observe(document.body, { childList: true, subtree: true });
    element.addEventListener('scroll', check);
    check();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      modals.disconnect();
      unsubscribe();
      element.removeEventListener('scroll', check);
    };
  }, [queue, scrollRef, conversationId, messages, loaded]);
}
