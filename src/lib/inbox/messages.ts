import type { Message } from '@/types';

/** Apply a DB snapshot without losing edits/events received during its fetch. */
export function mergeMessageSnapshot(
  current: Message[],
  fetched: Message[],
  baseline: Message[]
): Message[] {
  const before = new Map(baseline.map((message) => [message.id, message]));
  const merged = new Map(fetched.map((message) => [message.id, message]));
  for (const message of current) {
    if (message.id.startsWith('temp-') || before.get(message.id) !== message) {
      merged.set(message.id, message);
    }
  }
  return sortMessages([...merged.values()]);
}

export function sortMessages(messages: Message[]): Message[] {
  return messages
    .slice()
    .sort(
      (a, b) =>
        Date.parse(a.created_at) - Date.parse(b.created_at) ||
        a.id.localeCompare(b.id)
    );
}

/** Replace only the acknowledged optimistic row, never unrelated pending sends. */
export function updateMessage(
  messages: Message[],
  id: string,
  updates: Partial<Message>
): Message[] {
  if (
    updates.id &&
    updates.id !== id &&
    messages.some((m) => m.id === updates.id)
  ) {
    return messages.filter((m) => m.id !== id);
  }
  return sortMessages(
    messages.map((m) => (m.id === id ? { ...m, ...updates } : m))
  );
}
