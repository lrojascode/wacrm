import type { SupabaseClient } from '@supabase/supabase-js';

export interface InboxReadReceipt {
  conversation_id: string;
  acknowledged_ids: string[];
  unread_count: number;
  unread_revision: number;
}
export const INBOX_SNAPSHOT_EVENT = 'inbox-conversation-snapshot';
export const INBOX_RECONCILE_MS = 15_000;
export const INBOX_READ_EVENT = 'inbox-read-acknowledged';
export const INBOX_RECOVERY_EVENT = 'inbox-reconnected';
export const READ_QUEUE_PREFIX = 'wacrm:inbox:pending-reads:';
const TERMINAL_CODES = new Set(['42501', '22023', '22P02', 'PGRST202']);

/** One queue per authenticated scope. Only IDs that were presented are queued.
 * Durable across route changes/reloads; uncertain successes can safely replay. */
export class InboxReadQueue {
  private pending = new Map<string, Set<string>>();
  private confirmed = new Set<string>();
  private active = new Set<string>();
  private failures = new Map<string, number>();
  private lastAttempt = new Map<string, number>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;
  private controllers = new Set<AbortController>();
  constructor(
    readonly key: string,
    private client: SupabaseClient,
    private receipt: (value: InboxReadReceipt) => void
  ) {}
  private persist() {
    try {
      if (this.pending.size)
        sessionStorage.setItem(
          this.key,
          JSON.stringify([...this.pending].map(([id, ids]) => [id, [...ids]]))
        );
      else sessionStorage.removeItem(this.key);
    } catch {
      /* Restricted storage: the in-memory queue still recovers. */
    }
  }
  start() {
    this.running = true;
    try {
      const rows: unknown = JSON.parse(
        sessionStorage.getItem(this.key) ?? '[]'
      );
      if (Array.isArray(rows))
        for (const row of rows) {
          if (
            Array.isArray(row) &&
            typeof row[0] === 'string' &&
            Array.isArray(row[1])
          )
            this.add(
              row[0],
              row[1].filter(
                (id: unknown): id is string => typeof id === 'string'
              )
            );
        }
    } catch {
      /* Corrupt/missing storage must not break the inbox. */
    }
    this.retry();
  }
  stop() {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    for (const controller of this.controllers) controller.abort();
  }
  add(conversation: string, ids: string[]) {
    const pending = this.pending.get(conversation) ?? new Set<string>();
    let changed = false;
    for (const id of ids)
      if (!this.confirmed.has(id) && !pending.has(id)) {
        pending.add(id);
        changed = true;
      }
    if (!changed) return;
    this.pending.set(conversation, pending);
    this.persist();
    this.schedule(conversation, 250);
  }
  retry = (fromRealtime = false) => {
    if (!this.available()) return;
    for (const id of this.pending.keys()) {
      // Initial readiness pulses from multiple channels are not evidence that
      // an HTTP operation which just failed can succeed now. Keep its backoff.
      if (fromRealtime && Date.now() - (this.lastAttempt.get(id) ?? 0) < 1000)
        continue;
      this.failures.delete(id);
      this.schedule(id, 0);
    }
  };
  private available() {
    return (
      this.running && document.visibilityState === 'visible' && navigator.onLine
    );
  }
  private schedule(id: string, delay: number) {
    if (!this.available() || this.active.has(id)) return;
    if (this.timers.has(id)) {
      if (delay !== 0) return;
      clearTimeout(this.timers.get(id));
    }
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.flush(id);
      }, delay)
    );
  }
  private async flush(id: string) {
    if (!this.available() || this.active.has(id)) return;
    const batch = [...(this.pending.get(id) ?? [])].slice(0, 500);
    if (!batch.length) return;
    this.active.add(id);
    this.lastAttempt.set(id, Date.now());
    const controller = new AbortController();
    this.controllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), 10_000);
    const aborted = new Promise<never>((_, reject) =>
      controller.signal.addEventListener(
        'abort',
        () =>
          reject(
            new DOMException('Inbox acknowledgement timed out', 'AbortError')
          ),
        { once: true }
      )
    );
    let nextDelay: number | undefined;
    try {
      const { data, error } = await Promise.race([
        this.client
          .rpc('acknowledge_inbox_messages', {
            p_conversation_id: id,
            p_message_ids: batch,
          })
          .abortSignal(controller.signal),
        aborted,
      ]);
      if (error) throw error;
      if (!data || !Array.isArray(data.acknowledged_ids))
        throw new Error('Invalid inbox receipt');
      // An old scope may finish after account change/unmount. Its durable
      // pending batch is deliberately retained for an idempotent retry.
      if (!this.running) return;
      for (const messageId of data.acknowledged_ids as string[]) {
        this.pending.get(id)?.delete(messageId);
        this.confirmed.add(messageId);
      }
      this.failures.delete(id);
      if (!this.pending.get(id)?.size) this.pending.delete(id);
      this.persist();
      this.receipt(data as InboxReadReceipt);
      nextDelay = 250;
    } catch (error) {
      if (!this.running) return;
      const code = (error as { code?: string })?.code;
      if (code && TERMINAL_CODES.has(code)) {
        this.pending.delete(id);
        this.persist();
        console.error('Inbox acknowledgement rejected:', {
          conversationId: id,
          code,
        });
      } else {
        const attempts = (this.failures.get(id) ?? 0) + 1;
        this.failures.set(id, attempts);
        console.error('Inbox acknowledgement pending:', {
          conversationId: id,
          attempts,
          code,
        });
        // Five bounded retries; after exhaustion a recovery signal restarts it.
        if (attempts <= 5) nextDelay = 1000 * 2 ** (attempts - 1);
      }
    } finally {
      clearTimeout(timeout);
      this.controllers.delete(controller);
      this.active.delete(id);
      if (nextDelay !== undefined && this.pending.has(id))
        this.schedule(id, nextDelay);
    }
  }
}

/** Visibility/online/pageshow/reconnect commonly arrive together on mobile. */
export function subscribeInboxRecovery(callback: (event?: Event) => void) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let trigger: Event | undefined;
  const recover = (event: Event) => {
    if (document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (!trigger || trigger.type === INBOX_RECOVERY_EVENT) trigger = event;
    if (timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      const reason = trigger;
      trigger = undefined;
      callback(reason);
    }, 0);
  };
  document.addEventListener('visibilitychange', recover);
  for (const event of ['online', 'pageshow', 'focus', INBOX_RECOVERY_EVENT])
    window.addEventListener(event, recover);
  return () => {
    if (timer !== undefined) clearTimeout(timer);
    document.removeEventListener('visibilitychange', recover);
    for (const event of ['online', 'pageshow', 'focus', INBOX_RECOVERY_EVENT])
      window.removeEventListener(event, recover);
  };
}
