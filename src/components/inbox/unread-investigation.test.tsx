// Regression evidence: baseline 6549392 failed these four behaviors before the fix.
import { useEffect, type ReactNode } from 'react';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@/types';

const mocks = vi.hoisted(() => ({
  routeId: null as string | null,
  server: [] as Conversation[],
  reset: vi.fn(),
  onMessage: vi.fn(),
  onConversation: vi.fn(),
  push: vi.fn(),
  translate: (key: string) => key,
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({
    conversationId: mocks.routeId ? [mocks.routeId] : undefined,
  }),
  useRouter: () => ({ push: mocks.push, replace: vi.fn() }),
}));
vi.mock('next-intl', () => ({
  useTranslations: () => mocks.translate,
  useLocale: () => 'es',
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'agent' },
    accountId: 'account',
    accountRole: 'agent',
    profileLoading: false,
    loading: false,
  }),
}));
vi.mock('@/hooks/use-presence', () => ({
  usePresence: () => ({
    getPresence: () => 'offline',
    getRow: () => null,
    now: Date.now(),
  }),
}));
vi.mock('@/hooks/use-realtime', () => ({
  useRealtime: ({
    onMessageEvent,
    onConversationEvent,
  }: {
    onMessageEvent: typeof mocks.onMessage;
    onConversationEvent: typeof mocks.onConversation;
  }) => {
    mocks.onMessage = onMessageEvent;
    mocks.onConversation = onConversationEvent;
    return { isConnected: true };
  },
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
    rpc: (
      _name: string,
      params: { p_conversation_id: string; p_message_ids: string[] }
    ) => ({
      abortSignal: () =>
        mocks.reset(params.p_conversation_id, params.p_message_ids),
    }),
    from: (table: string) => {
      let patch: unknown;
      let id: string;
      const query = {
        select: () => query,
        abortSignal: () => query,
        update: (value: unknown) => {
          patch = value;
          return query;
        },
        eq: (_key: string, value: string) => {
          id = value;
          if (table === 'conversations' && patch) return mocks.reset(id, patch);
          return query;
        },
        order: () => query,
        limit: () => query,
        or: () => query,
        then: (resolve: (value: unknown) => unknown) =>
          Promise.resolve({
            data: table === 'messages' ? [message(id)] : [],
            error: null,
          }).then(resolve),
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
vi.mock('./conversation-list', () => ({
  ConversationList: ({
    conversations,
    onSelect,
    onConversationsLoaded,
    resyncToken,
  }: {
    conversations: Conversation[];
    onSelect: (row: Conversation) => void;
    onConversationsLoaded: (rows: Conversation[]) => void;
    resyncToken: number;
  }) => {
    useEffect(() => {
      onConversationsLoaded(mocks.server.map((row) => ({ ...row })));
    }, [resyncToken]); // eslint-disable-line react-hooks/exhaustive-deps
    return (
      <>
        {conversations.map((row) => (
          <button key={row.id} onClick={() => onSelect(row)}>
            {row.id}: unread {row.unread_count}
          </button>
        ))}
      </>
    );
  },
}));
vi.mock('./contact-sidebar', () => ({ ContactSidebar: () => null }));
vi.mock('./message-bubble', () => ({
  MessageBubble: ({ message }: { message: Message }) => (
    <p>{message.content_text}</p>
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
  MessageComposer: ({ onSend }: { onSend: (text: string) => void }) => (
    <button onClick={() => onSend('agent reply')}>send reply</button>
  ),
  CHAT_MEDIA_BUCKET: 'media',
}));
vi.mock('./template-picker', () => ({ TemplatePicker: () => null }));
vi.mock('./ai-thread-banner', () => ({ AiThreadBanner: () => null }));

const { InboxWorkspace } = await import('./inbox-workspace');
const { InboxReadProvider } = await import('./inbox-read-provider');
const Workspace = () => (
  <InboxReadProvider>
    <InboxWorkspace />
  </InboxReadProvider>
);
function message(id = 'A'): Message {
  return {
    id: `message-${id}`,
    inbox_unread: id === 'B',
    conversation_id: id,
    sender_type: 'customer',
    content_type: 'text',
    content_text: `customer ${id}`,
    status: 'delivered',
    created_at: new Date().toISOString(),
  };
}
async function settle() {
  await act(async () => {});
}
async function navigate(view: ReturnType<typeof render>, id: string | null) {
  mocks.routeId = id;
  view.rerender(<Workspace />);
  await settle();
}
function resume() {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  fireEvent(document, new Event('visibilitychange'));
}
beforeEach(() => {
  mocks.routeId = null;
  sessionStorage.clear();
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    value: 'visible',
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    bottom: 200,
    right: 320,
    width: 320,
    height: 200,
    toJSON() {},
  });
  mocks.server = ['A', 'B'].map((id) => ({
    id,
    status: 'open',
    unread_count: id === 'B' ? 1 : 0,
    contact: { id: `contact-${id}`, name: `Client ${id}`, phone: '123' },
  })) as Conversation[];
  mocks.reset
    .mockReset()
    .mockImplementation(async (id: string, ids: string[]) => {
      mocks.server = mocks.server.map((row) =>
        row.id === id ? { ...row, unread_count: 0, unread_revision: 2 } : row
      );
      return {
        error: null,
        data: {
          conversation_id: id,
          acknowledged_ids: ids,
          unread_count: 0,
          unread_revision: 2,
        },
      };
    });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it('control: a direct load of an unread conversation persists its read state', async () => {
  mocks.routeId = 'B';
  render(<Workspace />);
  await screen.findByText('customer B');
  await waitFor(() =>
    expect(mocks.reset).toHaveBeenCalledWith('B', ['message-B'])
  );
  expect(mocks.server.find((row) => row.id === 'B')?.unread_count).toBe(0);
});

it('opening from the list and replying should persist read state before returning to the list', async () => {
  const view = render(<Workspace />);
  fireEvent.click(await screen.findByRole('button', { name: 'B: unread 1' }));
  await navigate(view, 'B');
  await screen.findByText('customer B');
  await waitFor(() =>
    expect(mocks.reset).toHaveBeenCalledWith('B', ['message-B'])
  );
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ message_id: 'reply-id' }),
    })
  );
  fireEvent.click(screen.getByRole('button', { name: 'send reply' }));
  await screen.findByText('agent reply');
  await navigate(view, null);
  resume();
  await settle();
  // The existing implementation resurrects unread=1 from the server here.
  await waitFor(() =>
    expect(mocks.server.find((row) => row.id === 'B')?.unread_count).toBe(0)
  );
  expect(screen.getByRole('button', { name: 'B: unread 0' })).toBeVisible();
});

it('an inbound message while reading should persist its acknowledgement', async () => {
  mocks.routeId = 'A';
  render(<Workspace />);
  await screen.findByText('customer A');
  act(() =>
    mocks.onMessage({
      eventType: 'INSERT',
      new: {
        ...message(),
        id: 'live',
        content_text: 'live customer',
        inbox_unread: true,
      },
      old: {},
    })
  );
  act(() =>
    mocks.onConversation({
      eventType: 'UPDATE',
      new: { ...mocks.server[0], unread_count: 1 },
      old: {},
    })
  );
  await screen.findByText('live customer');
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledWith('A', ['live']));
});

it('an outgoing message in another conversation should not create unread messages', async () => {
  mocks.routeId = 'A';
  mocks.server[1].unread_count = 0;
  render(<Workspace />);
  await screen.findByText('customer A');
  act(() =>
    mocks.onMessage({
      eventType: 'INSERT',
      new: { ...message('B'), sender_type: 'agent' },
      old: {},
    })
  );
  expect(screen.getByRole('button', { name: 'B: unread 0' })).toBeVisible();
});

it('control: an outgoing INSERT and its conversation UPDATE both preserve the correct count', async () => {
  mocks.routeId = 'A';
  mocks.server[1].unread_count = 0;
  render(<Workspace />);
  await screen.findByText('customer A');
  act(() =>
    mocks.onMessage({
      eventType: 'INSERT',
      new: { ...message('B'), sender_type: 'agent' },
      old: {},
    })
  );
  expect(screen.getByRole('button', { name: 'B: unread 0' })).toBeVisible();
  act(() =>
    mocks.onConversation({ eventType: 'UPDATE', new: mocks.server[1], old: {} })
  );
  expect(screen.getByRole('button', { name: 'B: unread 0' })).toBeVisible();
});

it('a failed read acknowledgement should be retried on resume even if unread remains positive', async () => {
  mocks.routeId = 'B';
  mocks.reset.mockResolvedValue({
    error: { message: 'temporary network failure' },
  });
  render(<Workspace />);
  await screen.findByText('customer B');
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  resume();
  await settle();
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2));
});

it('manual refresh retries an already pending receipt without waiting for backoff', async () => {
  mocks.routeId = 'B';
  mocks.reset.mockResolvedValue({
    error: { message: 'temporary network failure' },
  });
  render(<Workspace />);
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole('button', { name: 'refreshConversation' }));
  await waitFor(() => expect(mocks.reset).toHaveBeenCalledTimes(2), {
    timeout: 300,
  });
});
