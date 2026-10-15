import { act, renderHook } from '@testing-library/react';
import { expect, it } from 'vitest';
import { INBOX_CACHE_LIMIT, useInboxMessages } from './use-inbox-messages';
import type { Message } from '@/types';

const row = (
  id: string,
  conversation_id: string,
  status: Message['status'] = 'delivered'
): Message => ({
  id,
  conversation_id,
  status,
  sender_type: 'customer',
  content_type: 'text',
  content_text: id,
  created_at: '2026-10-14T12:00:00Z',
});

it('restores a cached empty or populated thread and its own draft synchronously', () => {
  const { result, rerender } = renderHook(({ id }) => useInboxMessages(id), {
    initialProps: { id: 'A' },
  });
  act(() => {
    result.current.onMessagesLoaded('A', [row('a', 'A')], []);
    result.current.onDraftChange('draft A');
  });
  rerender({ id: 'B' });
  expect(result.current.messagesLoaded).toBe(false);
  expect(result.current.messages).toEqual([]);
  expect(result.current.draft).toBe('');
  act(() => result.current.onMessagesLoaded('B', [], []));
  rerender({ id: 'A' });
  expect(result.current.messages.map((m) => m.id)).toEqual(['a']);
  expect(result.current.draft).toBe('draft A');
  rerender({ id: 'B' });
  expect(result.current.messagesLoaded).toBe(true);
  expect(result.current.messages).toEqual([]);
});

it('updates inactive cached threads without affecting the selected one, including late send acknowledgements', () => {
  const { result, rerender } = renderHook(({ id }) => useInboxMessages(id), {
    initialProps: { id: 'A' },
  });
  act(() => {
    result.current.onMessagesLoaded('A', [row('a', 'A')], []);
    result.current.onNewMessage(row('temp-a', 'A', 'sending'));
  });
  const updateA = result.current.onUpdateMessage;
  rerender({ id: 'B' });
  act(() => result.current.onMessagesLoaded('B', [row('b', 'B')], []));
  act(() => {
    result.current.onNewMessage(row('live-a', 'A'));
    updateA('temp-a', { id: 'sent-a', status: 'sent' }, 'A');
  });
  expect(result.current.messages.map((m) => m.id)).toEqual(['b']);
  rerender({ id: 'A' });
  expect(result.current.messages.map((m) => m.id)).toEqual([
    'a',
    'live-a',
    'sent-a',
  ]);
  act(() => result.current.onUpdateMessage('a', { status: 'read' }, 'B'));
  expect(result.current.messages[0].status).toBe('delivered');
});

it('evicts the least recently visited thread while protecting active and pending sends', () => {
  const { result, rerender } = renderHook(({ id }) => useInboxMessages(id), {
    initialProps: { id: 'pending' },
  });
  act(() => {
    result.current.onMessagesLoaded('pending', [], []);
    result.current.onNewMessage(row('temp-p', 'pending', 'sending'));
  });
  for (let i = 0; i < INBOX_CACHE_LIMIT + 1; i++) {
    rerender({ id: `thread-${i}` });
    act(() => result.current.onMessagesLoaded(`thread-${i}`, [], []));
  }
  rerender({ id: 'thread-0' });
  expect(result.current.messagesLoaded).toBe(false);
  rerender({ id: 'pending' });
  expect(result.current.messages[0].id).toBe('temp-p');
  rerender({ id: `thread-${INBOX_CACHE_LIMIT}` });
  expect(result.current.messagesLoaded).toBe(true);
});
