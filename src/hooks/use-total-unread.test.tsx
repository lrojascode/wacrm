import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { INBOX_READ_EVENT } from '@/lib/inbox/read-queue';
import { useTotalUnread } from './use-total-unread';
const mocks = vi.hoisted(() => ({
  snapshot: vi.fn(),
  event: (payload: unknown) => {
    void payload;
  },
  system: (payload: unknown) => {
    void payload;
  },
  accountId: 'A',
  user: { id: 'user' },
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: mocks.user, accountId: mocks.accountId }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: () => {
      const query = {
        select: () => query,
        order: () => query,
        range: () => mocks.snapshot(),
      };
      return query;
    },
    channel: () => {
      const channel = {
        on: (type: string, _filter: unknown, callback: typeof mocks.event) => {
          if (type === 'postgres_changes') mocks.event = callback;
          if (type === 'system') mocks.system = callback;
          return channel;
        },
        subscribe: () => channel,
      };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));
const Harness = () => <output data-testid="total">{useTotalUnread()}</output>;
const row = { id: 'conversation', unread_count: 2, unread_revision: 1 };
beforeEach(() => {
  mocks.accountId = 'A';
  mocks.snapshot.mockReset().mockResolvedValue({ data: [row], error: null });
});
it('reconciles receipts and ignores stale events without summing messages', async () => {
  render(<Harness />);
  await waitFor(() =>
    expect(screen.getByTestId('total')).toHaveTextContent('1')
  );
  fireEvent(
    window,
    new CustomEvent(INBOX_READ_EVENT, {
      detail: {
        conversation_id: row.id,
        acknowledged_ids: ['id'],
        unread_count: 0,
        unread_revision: 2,
      },
    })
  );
  expect(screen.getByTestId('total')).toHaveTextContent('0');
  act(() => mocks.event({ eventType: 'UPDATE', new: row }));
  expect(screen.getByTestId('total')).toHaveTextContent('0');
});
it('never exposes the previous account total while the next account loads', async () => {
  const view = render(<Harness />);
  await waitFor(() =>
    expect(screen.getByTestId('total')).toHaveTextContent('1')
  );
  mocks.snapshot.mockImplementation(() => new Promise(() => {}));
  mocks.accountId = 'B';
  view.rerender(<Harness />);
  expect(screen.getByTestId('total')).toHaveTextContent('0');
});
it('a snapshot started before deletion cannot resurrect the deleted conversation', async () => {
  render(<Harness />);
  await waitFor(() =>
    expect(screen.getByTestId('total')).toHaveTextContent('1')
  );
  let release!: (value: unknown) => void;
  mocks.snapshot.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      })
  );
  fireEvent(window, new Event('online'));
  await waitFor(() => expect(mocks.snapshot).toHaveBeenCalledTimes(2));
  act(() => mocks.event({ eventType: 'DELETE', old: { id: row.id } }));
  await act(async () => release({ data: [row], error: null }));
  expect(screen.getByTestId('total')).toHaveTextContent('0');
});
it('bounds silent event loss with a compact visible-only reconciliation', async () => {
  vi.useFakeTimers();
  const view = render(<Harness />);
  try {
    act(() => mocks.system({ extension: 'postgres_changes', status: 'ok' }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(screen.getByTestId('total')).toHaveTextContent('1');
    mocks.snapshot.mockResolvedValue({
      data: [{ ...row, unread_count: 0, unread_revision: 2 }],
      error: null,
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(screen.getByTestId('total')).toHaveTextContent('0');
    const calls = mocks.snapshot.mock.calls.length;
    const visibility = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue('hidden');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(mocks.snapshot).toHaveBeenCalledTimes(calls);
    visibility.mockRestore();
  } finally {
    view.unmount();
    vi.useRealTimers();
  }
});
