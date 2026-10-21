import { useRef } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import type { Message } from '@/types';
import { InboxReadProvider } from '@/components/inbox/inbox-read-provider';
import { usePresentedInboxMessages } from './use-presented-inbox-messages';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), role: 'agent' }));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({
    user: { id: 'agent' },
    accountId: 'account',
    accountRole: mocks.role,
    loading: false,
    profileLoading: false,
  }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    rpc: (_: string, params: unknown) => ({
      abortSignal: () => mocks.rpc(params),
    }),
  }),
}));
const messages = [
  { id: 'one', conversation_id: 'A', inbox_unread: true },
] as Message[];
function Thread({ loaded = true }: { loaded?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  usePresentedInboxMessages('A', messages, loaded, ref);
  return (
    <div ref={ref} data-testid="scroll">
      <div data-message-id="one" />
    </div>
  );
}
const tree = (loaded = true) => (
  <InboxReadProvider>
    <Thread loaded={loaded} />
  </InboxReadProvider>
);
async function paint() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
}
beforeEach(() => {
  vi.useFakeTimers();
  sessionStorage.clear();
  mocks.role = 'agent';
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  vi.spyOn(navigator, 'onLine', 'get').mockReturnValue(true);
  vi.stubGlobal('requestAnimationFrame', (callback: () => void) =>
    setTimeout(callback, 0)
  );
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
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
  mocks.rpc
    .mockReset()
    .mockImplementation(async (params: { p_message_ids: string[] }) => ({
      data: {
        conversation_id: 'A',
        acknowledged_ids: params.p_message_ids,
        unread_count: 0,
        unread_revision: 1,
      },
      error: null,
    }));
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('waits for successful initial history and a painted final position, not the 64px follow threshold', async () => {
  const view = render(tree(false));
  const element = screen.getByTestId('scroll');
  Object.defineProperties(element, {
    scrollHeight: { value: 1000 },
    clientHeight: { value: 200 },
  });
  element.scrollTop = 750;
  await paint();
  expect(mocks.rpc).not.toHaveBeenCalled();
  view.rerender(tree());
  await paint();
  expect(mocks.rpc).not.toHaveBeenCalled();
  element.scrollTop = 800;
  fireEvent.scroll(element);
  await paint();
  expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith({
    p_conversation_id: 'A',
    p_message_ids: ['one'],
  });
});
it('does not recognize hidden documents, then recognizes on returning visible', async () => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
  render(tree());
  await paint();
  expect(mocks.rpc).not.toHaveBeenCalled();
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  fireEvent(document, new Event('visibilitychange'));
  await paint();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
it('viewer does not create a read queue', async () => {
  mocks.role = 'viewer';
  render(tree());
  await paint();
  expect(mocks.rpc).not.toHaveBeenCalled();
});
it('does not recognize messages behind a modal, and rechecks after it closes', async () => {
  const modal = document.createElement('div');
  modal.setAttribute('role', 'dialog');
  document.body.append(modal);
  render(tree());
  await paint();
  expect(mocks.rpc).not.toHaveBeenCalled();
  modal.remove();
  await act(async () => {});
  await paint();
  expect(mocks.rpc).toHaveBeenCalledTimes(1);
});
