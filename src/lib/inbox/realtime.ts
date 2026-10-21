import type { RealtimeChannel, SupabaseClient } from '@supabase/supabase-js';
import { INBOX_RECOVERY_EVENT, subscribeInboxRecovery } from './read-queue';

/** SUBSCRIBED is only the socket join. Wait for PostgreSQL's system/ok
 * confirmation, then reconcile the gap through HTTP. Rejoin degraded channels
 * with bounded backoff; a rate-limited channel can remain otherwise silent. */
export function subscribeInboxChannel(
  client: SupabaseClient,
  name: string,
  configure: (channel: RealtimeChannel) => RealtimeChannel,
  connected: (ready: boolean) => void = () => {}
) {
  let disposed = false;
  let channel: RealtimeChannel | null = null;
  let joining = false;
  let ready = false;
  let attempts = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let readyTimer: ReturnType<typeof setTimeout> | undefined;
  const available = () =>
    document.visibilityState === 'visible' && navigator.onLine;
  const announce = () => window.dispatchEvent(new Event(INBOX_RECOVERY_EVENT));
  const degraded = () => {
    if (disposed) return;
    ready = false;
    joining = false;
    connected(false);
    clearTimeout(readyTimer);
    if (!retryTimer && attempts < 5 && available()) {
      retryTimer = setTimeout(
        () => {
          retryTimer = undefined;
          void join();
        },
        1000 * 2 ** attempts++
      );
    }
    announce();
  };
  const join = async () => {
    if (disposed || joining || !available()) return;
    joining = true;
    ready = false;
    connected(false);
    const previous = channel;
    channel = null;
    if (previous) await client.removeChannel(previous);
    if (disposed) return;
    const next = configure(client.channel(name)).on(
      'system',
      {},
      (payload: { extension?: string; status?: string }) => {
        if (
          disposed ||
          channel !== next ||
          payload.extension !== 'postgres_changes'
        )
          return;
        if (payload.status === 'ok') {
          clearTimeout(readyTimer);
          clearTimeout(retryTimer);
          retryTimer = undefined;
          attempts = 0;
          ready = true;
          joining = false;
          connected(true);
          announce();
        } else degraded();
      }
    );
    channel = next;
    readyTimer = setTimeout(degraded, 10_000);
    next.subscribe((status) => {
      if (disposed || channel !== next) return;
      if (status !== 'SUBSCRIBED') degraded();
    });
  };
  const recover = subscribeInboxRecovery(() => {
    if (!ready && !joining && !retryTimer) {
      attempts = 0;
      void join();
    }
  });
  void join();
  return () => {
    disposed = true;
    recover();
    clearTimeout(retryTimer);
    clearTimeout(readyTimer);
    if (channel) void client.removeChannel(channel);
  };
}
