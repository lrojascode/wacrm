import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { subscribeInboxChannel } from './realtime';
import { INBOX_RECOVERY_EVENT } from './read-queue';
const channels: Array<{
  system?: (payload: unknown) => void;
  status?: (status: string) => void;
}> = [];
let stop: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  channels.length = 0;
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function start() {
  const connected = vi.fn();
  const client = {
    channel: () => {
      const callbacks = {} as (typeof channels)[number];
      channels.push(callbacks);
      const channel = {
        on: (
          _: string,
          _filter: unknown,
          callback: (payload: unknown) => void
        ) => {
          callbacks.system = callback;
          return channel;
        },
        subscribe: (callback: (status: string) => void) => {
          callbacks.status = callback;
          return channel;
        },
      };
      return channel;
    },
    removeChannel: vi.fn(async () => 'ok'),
  };
  stop = subscribeInboxChannel(
    client as unknown as SupabaseClient,
    'inbox',
    (channel) => channel,
    connected
  );
  return { connected, client };
}
it('does not report readiness at socket join; the PostgreSQL system confirmation closes the fetch gap', () => {
  const { connected } = start();
  channels[0].status?.('SUBSCRIBED');
  expect(connected).not.toHaveBeenCalledWith(true);
  channels[0].system?.({ extension: 'postgres_changes', status: 'ok' });
  expect(connected).toHaveBeenLastCalledWith(true);
});
it('backs off and rejoins a silent or failed changes subscription without tight loops', async () => {
  const { connected, client } = start();
  channels[0].system?.({ extension: 'postgres_changes', status: 'error' });
  await vi.advanceTimersByTimeAsync(0);
  expect(channels).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(channels).toHaveLength(2);
  expect(client.removeChannel).toHaveBeenCalledTimes(1);
  channels[1].system?.({ extension: 'postgres_changes', status: 'ok' });
  expect(connected).toHaveBeenLastCalledWith(true);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(channels).toHaveLength(2);
});
it('pauses rejoining offline and recovers on a network signal', async () => {
  start();
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  channels[0].status?.('CHANNEL_ERROR');
  await vi.advanceTimersByTimeAsync(5000);
  expect(channels).toHaveLength(1);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  window.dispatchEvent(new Event('online'));
  await vi.advanceTimersByTimeAsync(5);
  expect(channels).toHaveLength(2);
});
it('a stopped subscription never rejoins on a later recovery event', async () => {
  start();
  stop();
  window.dispatchEvent(new Event(INBOX_RECOVERY_EVENT));
  await vi.advanceTimersByTimeAsync(30_000);
  expect(channels).toHaveLength(1);
});
