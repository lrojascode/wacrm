import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  InboxReadQueue,
  subscribeInboxRecovery,
  INBOX_RECOVERY_EVENT,
  type InboxReadReceipt,
} from './read-queue';

let request: ReturnType<
  typeof vi.fn<
    (params: {
      p_conversation_id: string;
      p_message_ids: string[];
    }) => Promise<unknown>
  >
>;
let receipt: ReturnType<typeof vi.fn<(receipt: InboxReadReceipt) => void>>;
let queue: InboxReadQueue;
const key = 'read-queue-test';
function makeQueue() {
  return new InboxReadQueue(
    key,
    {
      rpc: (
        _: string,
        params: { p_conversation_id: string; p_message_ids: string[] }
      ) => ({ abortSignal: () => request(params) }),
    } as unknown as SupabaseClient,
    receipt
  );
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.spyOn(console, 'error').mockImplementation(() => {});
  request = vi.fn(
    async (params: { p_conversation_id: string; p_message_ids: string[] }) => ({
      data: {
        conversation_id: params.p_conversation_id,
        acknowledged_ids: params.p_message_ids,
        unread_count: 0,
        unread_revision: 1,
      },
      error: null,
    })
  );
  receipt = vi.fn();
  queue = makeQueue();
  queue.start();
});
afterEach(() => {
  queue.stop();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it('batches and deduplicates IDs independently of optimistic UI and performs no repeated writes', async () => {
  queue.add('A', ['one', 'one']);
  queue.add('A', ['two']);
  await vi.advanceTimersByTimeAsync(250);
  expect(request).toHaveBeenCalledExactlyOnceWith({
    p_conversation_id: 'A',
    p_message_ids: ['one', 'two'],
  });
  queue.add('A', ['one']);
  queue.retry();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('keeps new arrivals outside an in-flight acknowledgement and splits batches at 500', async () => {
  queue.add(
    'A',
    Array.from({ length: 501 }, (_, i) => `id-${i}`)
  );
  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.calls[0][0].p_message_ids).toHaveLength(500);
  await vi.advanceTimersByTimeAsync(250);
  expect(request.mock.calls[1][0].p_message_ids).toEqual(['id-500']);
});

it('persists uncertain/failing acknowledgements across reload, never message content', async () => {
  request.mockResolvedValueOnce({ error: { code: 'network' } });
  queue.add('A', ['observed']);
  await vi.advanceTimersByTimeAsync(250);
  expect(JSON.parse(sessionStorage.getItem(key)!)).toEqual([
    ['A', ['observed']],
  ]);
  queue.stop();
  queue = makeQueue();
  queue.start();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
  expect(receipt).toHaveBeenCalledTimes(1);
});

it('bounds retries, pauses hidden/offline, and retries on a recovery signal', async () => {
  request.mockResolvedValue({ error: { code: 'network' } });
  queue.add('A', ['one']);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(request).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(100_000);
  expect(request).toHaveBeenCalledTimes(6);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  queue.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(6);
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(false);
  queue.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(6);
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  const unsubscribe = subscribeInboxRecovery(() => queue.retry());
  window.dispatchEvent(new Event('online'));
  window.dispatchEvent(new Event('pageshow'));
  window.dispatchEvent(new Event(INBOX_RECOVERY_EVENT));
  await vi.advanceTimersByTimeAsync(5);
  expect(request).toHaveBeenCalledTimes(7);
  unsubscribe();
});

it('does not retry terminal permission failures', async () => {
  request.mockResolvedValue({ error: { code: '42501' } });
  queue.add('A', ['one']);
  await vi.advanceTimersByTimeAsync(250);
  queue.retry();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(request).toHaveBeenCalledTimes(1);
  expect(sessionStorage.getItem(key)).toBeNull();
});
it('a transport that ignores abort cannot hold the single-flight slot forever', async () => {
  request.mockImplementationOnce(() => new Promise(() => {}));
  queue.add('A', ['one']);
  await vi.advanceTimersByTimeAsync(11_250);
  expect(request).toHaveBeenCalledTimes(2);
  expect(receipt).toHaveBeenCalledTimes(1);
});
it('initial stream readiness does not short-circuit a recent HTTP failure backoff', async () => {
  request.mockResolvedValue({ error: { code: 'network' } });
  queue.add('A', ['one']);
  await vi.advanceTimersByTimeAsync(250);
  queue.retry(true);
  await vi.advanceTimersByTimeAsync(10);
  expect(request).toHaveBeenCalledTimes(1);
  queue.retry();
  await vi.advanceTimersByTimeAsync(0);
  expect(request).toHaveBeenCalledTimes(2);
});
