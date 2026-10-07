import { useState, type ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Contact, Message } from '@/types';
import { useInboxMessages } from '@/hooks/use-inbox-messages';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('next-intl', () => ({
  useTranslations: () => mocks.translate,
  useLocale: () => 'es',
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ user: { id: 'user' } }),
}));
vi.mock('@/hooks/use-presence', () => ({
  usePresence: () => ({
    getPresence: () => 'offline',
    getRow: () => null,
    now: Date.now(),
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      let id: string;
      const query = {
        select: () => query,
        abortSignal: () => query,
        eq: (_key: string, value: string) => {
          id = value;
          return table === 'message_reactions'
            ? Promise.resolve({ data: [], error: null })
            : query;
        },
        order: () =>
          table === 'messages'
            ? mocks.query(id)
            : Promise.resolve({ data: [], error: null }),
      };
      return query;
    },
    channel: () => {
      const channel = { on: () => channel, subscribe: () => channel };
      return channel;
    },
    removeChannel: vi.fn(),
  }),
}));
vi.mock('./message-bubble', () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <p data-testid={message.id} data-status={message.status}>
      {message.content_text}
    </p>
  ),
}));
vi.mock('./message-actions', () => ({
  MessageActions: ({
    children,
    message,
  }: {
    children: ReactNode;
    message: Message;
  }) => <div data-message-id={message.id}>{children}</div>,
}));
vi.mock('./message-composer', () => ({
  MessageComposer: ({ onSend }: { onSend: (text: string) => void }) => {
    const [draft, setDraft] = useState('');
    return (
      <>
        <textarea
          aria-label="draft"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
        <button onClick={() => onSend(draft)}>send</button>
      </>
    );
  },
  CHAT_MEDIA_BUCKET: 'media',
}));
vi.mock('./template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('./ai-thread-banner', () => ({ AiThreadBanner: () => null }));

const { MessageThread } = await import('./message-thread');
const row = (id = 'original', conversationId = 'A', minute = 0): Message => ({
  id,
  conversation_id: conversationId,
  sender_type: 'customer',
  content_type: 'text',
  content_text: id,
  created_at: `2026-10-06T12:${String(minute).padStart(2, '0')}:00Z`,
  status: 'delivered',
});
const contact = { id: 'contact', name: 'Cliente', phone: '123' } as Contact;
function Harness({ id = 'A' }: { id?: string }) {
  const [token, setToken] = useState(0);
  const state = useInboxMessages(id);
  return (
    <>
      <button onClick={() => setToken((n) => n + 1)}>resync</button>
      <button onClick={() => state.onNewMessage(row('live', id, 2))}>
        live
      </button>
      <button
        onClick={() => state.onUpdateMessage('original', { status: 'read' })}
      >
        status
      </button>
      <button
        onClick={() =>
          state.onNewMessage({
            ...row('temp-pending', id, 3),
            status: 'sending',
          })
        }
      >
        pending
      </button>
      <MessageThread
        conversation={{ id, status: 'open', unread_count: 0 } as Conversation}
        contact={{ ...contact, name: `Cliente ${id}` }}
        {...state}
        onStatusChange={vi.fn()}
        onAssignChange={vi.fn()}
        resyncToken={token}
        onRefresh={() => setToken((n) => n + 1)}
      />
    </>
  );
}

function deferred() {
  let resolve!: (value: { data: Message[] | null; error: unknown }) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<{ data: Message[] | null; error: unknown }>(
    (yes, no) => {
      resolve = yes;
      reject = no;
    }
  );
  return { promise, resolve, reject };
}
const result = (data: Message[]) => ({ data, error: null });
async function openThread(rows = [row()]) {
  mocks.query.mockResolvedValueOnce(result(rows));
  const view = render(<Harness />);
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'refreshConversation' })
    ).toBeEnabled()
  );
  return view;
}
function readingGeometry(top = 200, height = 1000) {
  const thread = screen.getByTestId('message-thread');
  Object.defineProperty(thread, 'scrollHeight', {
    configurable: true,
    value: height,
  });
  Object.defineProperty(thread, 'clientHeight', {
    configurable: true,
    value: 300,
  });
  thread.scrollTop = top;
  fireEvent.scroll(thread);
  return thread;
}

beforeEach(() => {
  mocks.query.mockReset();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('thread synchronization', () => {
  it.each(['resync', 'refreshConversation'])(
    'keeps bubbles and draft mounted during %s',
    async (trigger) => {
      await openThread();
      const pending = deferred();
      mocks.query.mockReturnValueOnce(pending.promise);
      const bubble = screen.getByTestId('original');
      fireEvent.change(screen.getByLabelText('draft'), {
        target: { value: 'borrador' },
      });
      const thread = readingGeometry();
      fireEvent.click(screen.getByRole('button', { name: trigger }));
      expect(screen.getByTestId('original')).toBe(bubble);
      expect(thread.querySelector('.animate-spin')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'refreshConversation' })
      ).toBeDisabled();
      await act(async () => pending.resolve(result([row()])));
      expect(screen.getByTestId('original')).toBe(bubble);
      expect(screen.getByLabelText('draft')).toHaveValue('borrador');
      expect(thread.scrollTop).toBe(200);
      expect(
        screen.getByRole('button', { name: 'refreshConversation' })
      ).toBeEnabled();
    }
  );

  it.each(['returned', 'thrown'])(
    'retains content and ends the indicator on a %s error',
    async (kind) => {
      await openThread();
      const pending = deferred();
      mocks.query.mockReturnValueOnce(pending.promise);
      fireEvent.change(screen.getByLabelText('draft'), {
        target: { value: 'borrador' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'resync' }));
      await act(async () =>
        kind === 'thrown'
          ? pending.reject(new Error('offline'))
          : pending.resolve({ data: null, error: { message: 'offline' } })
      );
      expect(screen.getByTestId('original')).toBeVisible();
      expect(screen.getByLabelText('draft')).toHaveValue('borrador');
      expect(screen.queryByRole('alert')).toBeNull();
      expect(
        screen.getByRole('button', { name: 'refreshConversation' })
      ).toBeEnabled();
    }
  );

  it('shows a translated initial error, and shows empty only after a successful retry', async () => {
    mocks.query.mockRejectedValueOnce(new Error('offline'));
    render(<Harness />);
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'loadMessagesError'
    );
    expect(screen.queryByText('noMessagesYet')).toBeNull();
    const pending = deferred();
    mocks.query.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'retryLoadMessages' }));
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      screen.getByTestId('message-thread').querySelector('.animate-spin')
    ).not.toBeNull();
    await act(async () => pending.resolve(result([])));
    expect(screen.getByText('noMessagesYet')).toBeVisible();
    const again = deferred();
    mocks.query.mockReturnValueOnce(again.promise);
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    expect(screen.getByText('noMessagesYet')).toBeVisible();
    await act(async () => again.resolve(result([])));
  });

  it('coalesces repeated resyncs into one pending query', async () => {
    await openThread();
    const first = deferred(),
      second = deferred();
    mocks.query
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    for (let i = 0; i < 4; i++)
      fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    expect(mocks.query).toHaveBeenCalledTimes(2);
    await act(async () => first.resolve(result([row()])));
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(
      screen.getByRole('button', { name: 'refreshConversation' })
    ).toBeDisabled();
    await act(async () => second.resolve(result([row()])));
    expect(mocks.query).toHaveBeenCalledTimes(3);
    expect(
      screen.getByRole('button', { name: 'refreshConversation' })
    ).toBeEnabled();
  });

  it('uses the applied snapshot as the baseline of a queued query', async () => {
    await openThread();
    const first = deferred(),
      second = deferred();
    mocks.query
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    await act(async () =>
      first.resolve(result([row(), row('db-added', 'A', 1)]))
    );
    expect(screen.getByTestId('db-added')).toBeVisible();
    await act(async () => second.resolve(result([])));
    expect(screen.queryByTestId('db-added')).toBeNull();
    expect(screen.queryByTestId('original')).toBeNull();
    expect(screen.getByText('noMessagesYet')).toBeVisible();
  });

  it('does not overwrite realtime edits/inserts or pending sends with an old snapshot', async () => {
    await openThread();
    const pending = deferred();
    mocks.query.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    for (const name of ['live', 'status', 'pending'])
      fireEvent.click(screen.getByRole('button', { name }));
    await act(async () => pending.resolve(result([row()])));
    expect(screen.getByTestId('original')).toHaveAttribute(
      'data-status',
      'read'
    );
    expect(screen.getByTestId('live')).toBeVisible();
    expect(screen.getByTestId('temp-pending')).toBeVisible();
  });

  it('ignores out-of-order results across A → B → C', async () => {
    const a = deferred(),
      b = deferred(),
      c = deferred();
    mocks.query
      .mockReturnValueOnce(a.promise)
      .mockReturnValueOnce(b.promise)
      .mockReturnValueOnce(c.promise);
    const view = render(<Harness id="A" />);
    view.rerender(<Harness id="B" />);
    view.rerender(<Harness id="C" />);
    await act(async () => c.resolve(result([row('C message', 'C')])));
    await act(async () => {
      b.resolve(result([row('B message', 'B')]));
      a.resolve(result([row('A message')]));
    });
    expect(screen.getByText('Cliente C')).toBeVisible();
    expect(screen.getByTestId('C message')).toBeVisible();
    expect(screen.queryByTestId('B message')).toBeNull();
    expect(screen.queryByTestId('A message')).toBeNull();
  });

  it('changes contact and starts loading without painting the old conversation or a false empty state', async () => {
    const view = await openThread();
    const pending = deferred();
    mocks.query.mockReturnValueOnce(pending.promise);
    view.rerender(<Harness id="B" />);
    expect(screen.getByText('Cliente B')).toBeVisible();
    expect(screen.queryByTestId('original')).toBeNull();
    expect(screen.queryByText('noMessagesYet')).toBeNull();
    expect(
      screen.getByTestId('message-thread').querySelector('.animate-spin')
    ).not.toBeNull();
    await act(async () => pending.resolve(result([row('B message', 'B')])));
    expect(screen.getByTestId('B message')).toBeVisible();
  });
});

describe('reading position', () => {
  it.each([
    [64, true],
    [65, false],
  ])(
    'follows incoming messages at %s px from the bottom: %s',
    async (distance, follows) => {
      await openThread();
      const thread = readingGeometry(700 - Number(distance));
      fireEvent.click(screen.getByRole('button', { name: 'live' }));
      expect(thread.scrollTop).toBe(follows ? 1000 : 700 - Number(distance));
    }
  );

  it('keeps existing bubbles mounted when a snapshot adds earlier messages on the same day', async () => {
    await openThread();
    const bubble = screen.getByTestId('original');
    const pending = deferred();
    mocks.query.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    const older = { ...row('older'), created_at: '2026-10-06T11:59:00Z' };
    await act(async () => pending.resolve(result([older, row()])));
    expect(screen.getByTestId('original')).toBe(bubble);
  });

  it('keeps the reader above, follows when near the bottom, and ignores status edits', async () => {
    await openThread();
    const thread = readingGeometry();
    fireEvent.click(screen.getByRole('button', { name: 'live' }));
    expect(thread.scrollTop).toBe(200);
    thread.scrollTop = 650;
    fireEvent.scroll(thread);
    fireEvent.click(screen.getByRole('button', { name: 'pending' }));
    expect(thread.scrollTop).toBe(1000);
    thread.scrollTop = 500;
    fireEvent.scroll(thread);
    fireEvent.click(screen.getByRole('button', { name: 'status' }));
    expect(thread.scrollTop).toBe(500);
  });

  it('preserves the visible anchor when preceding content changes height', async () => {
    await openThread([row(), row('second', 'A', 1)]);
    const thread = readingGeometry();
    const nodes = thread.querySelectorAll<HTMLElement>('[data-message-id]');
    let secondTop = 150;
    nodes.forEach((node, i) =>
      vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            top: (i ? secondTop : 0) - thread.scrollTop,
            bottom: (i ? secondTop : 0) + 150 - thread.scrollTop,
          }) as DOMRect
      )
    );
    fireEvent.scroll(thread);
    secondTop = 200;
    fireEvent.click(screen.getByRole('button', { name: 'status' }));
    expect(thread.scrollTop).toBe(250);
  });

  it('falls back to the saved scroll position, clamped to the new height, if its anchor is deleted', async () => {
    await openThread([row(), row('second', 'A', 1)]);
    const thread = readingGeometry();
    const nodes = thread.querySelectorAll<HTMLElement>('[data-message-id]');
    nodes.forEach((node, i) =>
      vi.spyOn(node, 'getBoundingClientRect').mockImplementation(
        () =>
          ({
            top: i * 150 - thread.scrollTop,
            bottom: i * 150 + 150 - thread.scrollTop,
          }) as DOMRect
      )
    );
    fireEvent.scroll(thread);
    const pending = deferred();
    mocks.query.mockReturnValueOnce(pending.promise);
    fireEvent.click(screen.getByRole('button', { name: 'resync' }));
    Object.defineProperty(thread, 'scrollHeight', {
      configurable: true,
      value: 400,
    });
    await act(async () => pending.resolve(result([row()])));
    expect(thread.scrollTop).toBe(100);
  });

  it('scrolls a send initiated by this composer to the bottom', async () => {
    await openThread();
    const thread = readingGeometry();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ message_id: 'sent-id' }),
      })
    );
    fireEvent.change(screen.getByLabelText('draft'), {
      target: { value: 'mi mensaje' },
    });
    await act(async () =>
      fireEvent.click(screen.getByRole('button', { name: 'send' }))
    );
    expect(thread.scrollTop).toBe(1000);
    expect(screen.getByTestId('sent-id')).toHaveTextContent('mi mensaje');
  });
});
