import { useEffect } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '@/types';

const mocks = vi.hoisted(() => ({
  routeId: 'A',
  push: vi.fn(),
  replace: vi.fn(),
  translate: (key: string) => key,
  onMessage: (_event: {
    eventType: string;
    new: Message;
    old: Partial<Message>;
  }) => {
    void _event;
  },
}));
vi.mock('next/navigation', () => ({
  useParams: () => ({ conversationId: [mocks.routeId] }),
  useRouter: () => ({ push: mocks.push, replace: mocks.replace }),
}));
vi.mock('next-intl', () => ({ useTranslations: () => mocks.translate }));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    auth: { getSession: async () => ({ data: { session: null } }) },
  }),
}));
vi.mock('@/hooks/use-realtime', () => ({
  useRealtime: ({
    onMessageEvent,
  }: {
    onMessageEvent: typeof mocks.onMessage;
  }) => {
    mocks.onMessage = onMessageEvent;
    return { isConnected: true };
  },
}));
const conversations = ['A', 'B'].map((id) => ({
  id,
  status: 'open',
  unread_count: 0,
  contact: { id: `contact-${id}`, name: `Cliente ${id}`, phone: '123' },
})) as Conversation[];
const row = (id: string, conversationId: string): Message => ({
  id,
  conversation_id: conversationId,
  sender_type: 'customer',
  content_type: 'text',
  content_text: id,
  status: 'delivered',
  created_at: '2026-10-06T12:00:00Z',
});
vi.mock('@/components/inbox/conversation-list', () => ({
  ConversationList: ({
    onSelect,
    onConversationsLoaded,
  }: {
    onSelect: (conversation: Conversation) => void;
    onConversationsLoaded: (conversations: Conversation[]) => void;
  }) => {
    useEffect(() => {
      onConversationsLoaded(conversations);
    }, [onConversationsLoaded]);
    return <button onClick={() => onSelect(conversations[1])}>select B</button>;
  },
}));
vi.mock('@/components/inbox/contact-sidebar', () => ({
  ContactSidebar: () => null,
}));
vi.mock('@/components/inbox/message-thread', () => ({
  MessageThread: ({
    conversation,
    messages,
    messagesLoaded,
    onMessagesLoaded,
    onNewMessage,
    onBack,
  }: {
    conversation: Conversation | null;
    messages: Message[];
    messagesLoaded: boolean;
    onMessagesLoaded: (
      id: string,
      rows: Message[],
      baseline: Message[]
    ) => void;
    onNewMessage: (message: Message) => void;
    onBack: () => void;
  }) => {
    const id = conversation?.id;
    useEffect(() => {
      if (id)
        void Promise.resolve().then(() =>
          onMessagesLoaded(id, [row(`message ${id}`, id)], [])
        );
    }, [id, onMessagesLoaded]);
    return (
      <div>
        <p>{conversation?.contact?.name}</p>
        {messagesLoaded ? (
          messages.map((message) => (
            <p key={message.id}>{message.content_text}</p>
          ))
        ) : (
          <p>initial loading</p>
        )}
        <button onClick={onBack}>close</button>
        <button
          onClick={() =>
            onNewMessage({ ...row('temp-send', id!), status: 'sending' })
          }
        >
          pending
        </button>
      </div>
    );
  },
}));

const { default: InboxPage } = await import('./page');
beforeEach(() => {
  mocks.routeId = 'A';
});

it.each(['select B', 'close'])(
  'keeps the current messages until the route commits after %s',
  async (action) => {
    render(<InboxPage />);
    expect(await screen.findByText('message A')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: action }));
    expect(mocks.push).toHaveBeenCalledWith(
      action === 'close' ? '/inbox' : '/inbox/B',
      { scroll: false }
    );
    expect(screen.getByText('message A')).toBeVisible();
    expect(screen.queryByText('initial loading')).toBeNull();
  }
);

it('never pairs the next contact with the previous messages during a committed navigation', async () => {
  const view = render(<InboxPage />);
  await screen.findByText('message A');
  fireEvent.click(screen.getByRole('button', { name: 'select B' }));
  mocks.routeId = 'B';
  view.rerender(<InboxPage />);
  expect(screen.getByText('Cliente B')).toBeVisible();
  expect(screen.queryByText('message A')).toBeNull();
  expect(screen.getByText('initial loading')).toBeVisible();
  expect(await screen.findByText('message B')).toBeVisible();
});

it('an incoming customer message does not delete a pending send', async () => {
  render(<InboxPage />);
  await screen.findByText('message A');
  fireEvent.click(screen.getByRole('button', { name: 'pending' }));
  act(() =>
    mocks.onMessage({
      eventType: 'INSERT',
      new: row('live customer', 'A'),
      old: {},
    })
  );
  expect(screen.getByText('temp-send')).toBeVisible();
  expect(screen.getByText('live customer')).toBeVisible();
});
