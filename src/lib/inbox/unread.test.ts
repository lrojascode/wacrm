import { expect, it } from 'vitest';
import type { Conversation } from '@/types';
import { mergeConversationSnapshot, mergeUnreadState } from './unread';
const row = (id: string, count: number, revision: number) =>
  ({ id, unread_count: count, unread_revision: revision }) as Conversation;
it('rejects older unread revisions from events, snapshots and late receipts', () => {
  expect(mergeUnreadState(row('A', 1, 3), row('A', 0, 2))).toEqual(
    row('A', 1, 3)
  );
  expect(mergeUnreadState(row('A', 1, 3), row('A', 0, 4))).toEqual(
    row('A', 0, 4)
  );
});
it('preserves concurrent updates, additions and deletions while replacing an old snapshot', () => {
  const a = row('A', 1, 1);
  const b = row('B', 1, 1);
  expect(
    mergeConversationSnapshot([row('A', 0, 2), row('C', 1, 1)], [a, b], [a, b])
  ).toEqual([row('A', 0, 2), row('C', 1, 1)]);
});
it('a concurrent local metadata edit cannot suppress a newer server counter', () => {
  const baseline = row('A', 1, 1);
  const local = { ...baseline, status: 'pending' as const };
  const fetched = { ...row('A', 2, 2), status: 'open' as const };
  expect(mergeConversationSnapshot([local], [fetched], [baseline])).toEqual([
    { ...local, unread_count: 2, unread_revision: 2 },
  ]);
});
