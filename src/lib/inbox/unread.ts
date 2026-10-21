import type { Conversation } from '@/types';

export type UnreadState = Pick<
  Conversation,
  | 'id'
  | 'unread_count'
  | 'unread_revision'
  | 'last_message_at'
  | 'last_message_text'
>;
/** A late fetch/RPC/event must never restore an older unread aggregate. */
export function mergeUnreadState<T extends UnreadState>(
  current: T | undefined,
  incoming: T
): T {
  if (
    current?.last_message_at &&
    incoming.last_message_at &&
    current.last_message_at > incoming.last_message_at
  ) {
    incoming = {
      ...incoming,
      last_message_at: current.last_message_at,
      last_message_text: current.last_message_text,
    };
  }
  return current &&
    (current.unread_revision ?? 0) > (incoming.unread_revision ?? 0)
    ? {
        ...incoming,
        unread_count: current.unread_count,
        unread_revision: current.unread_revision,
      }
    : incoming;
}

export function mergeConversationSnapshot(
  current: Conversation[],
  fetched: Conversation[],
  baseline: Conversation[]
) {
  const before = new Map(baseline.map((row) => [row.id, row]));
  const now = new Map(current.map((row) => [row.id, row]));
  const result = new Map<string, Conversation>();
  for (const row of fetched) {
    if (before.has(row.id) && !now.has(row.id)) continue; // deleted during fetch
    const latest = now.get(row.id);
    const aggregate = mergeUnreadState(latest, row);
    result.set(
      row.id,
      latest && before.get(row.id) !== latest
        ? {
            ...row,
            ...latest,
            unread_count: aggregate.unread_count,
            unread_revision: aggregate.unread_revision,
          }
        : aggregate
    );
  }
  for (const row of current)
    if (!before.has(row.id) && !result.has(row.id)) result.set(row.id, row);
  return [...result.values()];
}
