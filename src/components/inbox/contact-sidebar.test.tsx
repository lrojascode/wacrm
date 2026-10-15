import type { ReactNode } from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { Contact } from '@/types';
const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  signals: [] as AbortSignal[],
}));
vi.mock('next-intl', () => ({
  useTranslations: () => (key: string) => key,
  useLocale: () => 'es',
}));
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'account', isViewer: false }),
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => ({
    from: (table: string) => {
      let id: string;
      const query = {
        select: () => query,
        eq: (_: string, value: string) => {
          id = value;
          return query;
        },
        order: () => query,
        abortSignal: (signal: AbortSignal) => {
          mocks.signals.push(signal);
          return query;
        },
        then: (
          yes: (value: unknown) => unknown,
          no: (error: unknown) => unknown
        ) => mocks.query(table, id).then(yes, no),
      };
      return query;
    },
  }),
}));
const { ContactSidebar } = await import('./contact-sidebar');
const contact = (id: string) =>
  ({ id, name: `Cliente ${id}`, phone: '123' }) as Contact;
const note = (id: string) => ({
  id,
  note_text: `Nota ${id}`,
  created_at: '2026-10-14T12:00:00Z',
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeEach(() => {
  mocks.query.mockReset();
  mocks.signals = [];
});

it('keeps the panel mounted and never shows the previous contact data during a slow lookup', async () => {
  const lateA = deferred(),
    readyB = deferred();
  mocks.query.mockImplementation(async (table: string, id: string) => {
    await (id === 'A' ? lateA.promise : readyB.promise);
    return { data: table === 'contact_notes' ? [note(id)] : [], error: null };
  });
  const view = render(
    <ContactSidebar contact={contact('A')} conversationId="A" />
  );
  const panel = screen.getByTestId('contact-panel');
  view.rerender(<ContactSidebar contact={contact('B')} conversationId="B" />);
  expect(screen.getByTestId('contact-panel')).toBe(panel);
  expect(screen.getByText('Cliente B')).toBeVisible();
  expect(screen.getByTestId('contact-skeleton')).toBeVisible();
  expect(mocks.signals.slice(0, 4).every((signal) => signal.aborted)).toBe(
    true
  );
  await act(async () => lateA.resolve());
  expect(screen.queryByText('Nota A')).toBeNull();
  await act(async () => readyB.resolve());
  expect(screen.getByText('Nota B')).toBeVisible();
  expect(screen.queryByText('Nota A')).toBeNull();
});

it('removes loaded notes and note drafts immediately when selecting a different contact', async () => {
  const next = deferred();
  mocks.query.mockImplementation(async (table: string, id: string) => {
    if (id === 'B') await next.promise;
    return { data: table === 'contact_notes' ? [note(id)] : [], error: null };
  });
  const view = render(
    <ContactSidebar contact={contact('A')} conversationId="A" />
  );
  expect(await screen.findByText('Nota A')).toBeVisible();
  view.rerender(<ContactSidebar contact={contact('B')} conversationId="B" />);
  expect(screen.queryByText('Nota A')).toBeNull();
  expect(screen.getByTestId('contact-skeleton')).toBeVisible();
  await act(async () => next.resolve());
  expect(screen.getByText('Nota B')).toBeVisible();
});
