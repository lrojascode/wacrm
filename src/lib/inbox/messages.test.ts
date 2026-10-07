import { describe, expect, it } from 'vitest';
import type { Message } from '@/types';
import { mergeMessageSnapshot, updateMessage } from './messages';

const row = (id: string, minute = 0): Message => ({
  id,
  conversation_id: 'conv',
  sender_type: 'customer',
  content_type: 'text',
  content_text: id,
  status: 'delivered',
  created_at: `2026-10-06T12:${String(minute).padStart(2, '0')}:00Z`,
});

describe('message snapshot reconciliation', () => {
  it('keeps live inserts and edits received after the fetch started', () => {
    const initial = row('initial');
    const edited = { ...initial, status: 'read' as const };
    expect(
      mergeMessageSnapshot(
        [edited, row('live', 2)],
        [{ ...initial }],
        [initial]
      )
    ).toEqual([edited, row('live', 2)]);
  });

  it('uses the DB for unchanged rows, including deletions, and orders/deduplicates by id', () => {
    const initial = row('initial');
    const removed = row('removed');
    const fresh = { ...initial, status: 'read' as const };
    expect(
      mergeMessageSnapshot(
        [initial, removed],
        [row('new', 1), fresh, fresh],
        [initial, removed]
      )
    ).toEqual([fresh, row('new', 1)]);
  });

  it('retains pending/failed sends even when they were present before the request', () => {
    const pending = { ...row('temp-1'), status: 'sending' as const };
    const failed = { ...row('temp-2', 1), status: 'failed' as const };
    expect(
      mergeMessageSnapshot([pending, failed], [], [pending, failed])
    ).toEqual([pending, failed]);
  });

  it('acknowledges one send without deleting another', () => {
    const first = row('temp-1');
    const second = row('temp-2', 1);
    expect(
      updateMessage([first, second], first.id, { id: 'real', status: 'sent' })
    ).toEqual([{ ...first, id: 'real', status: 'sent' }, second]);
  });

  it('deduplicates an acknowledgment after realtime arrived, retaining its newer status', () => {
    const persisted = { ...row('real'), status: 'read' as const };
    expect(
      updateMessage([row('temp-1'), persisted, row('temp-2', 1)], 'temp-1', {
        id: 'real',
        status: 'sent',
      })
    ).toEqual([persisted, row('temp-2', 1)]);
  });
});
