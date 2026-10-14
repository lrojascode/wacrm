import { useState } from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  user: { id: 'user' } as { id: string } | null,
  accountId: 'A' as string | null,
  loading: false,
}));
vi.mock('@/hooks/use-auth', () => ({ useAuth: () => auth }));
vi.mock('@/components/inbox/inbox-workspace', () => ({
  InboxWorkspace: () => {
    const [count, setCount] = useState(0);
    return (
      <button onClick={() => setCount((n) => n + 1)}>workspace {count}</button>
    );
  },
}));
const { default: InboxLayout } = await import('./layout');
beforeEach(() => {
  auth.user = { id: 'user' };
  auth.accountId = 'A';
  auth.loading = false;
});

it('preserves the workspace when the route child or transient auth state changes', () => {
  const view = render(
    <InboxLayout>
      <div>A</div>
    </InboxLayout>
  );
  fireEvent.click(screen.getByText('workspace 0'));
  const workspace = screen.getByText('workspace 1');
  view.rerender(
    <InboxLayout>
      <div>B</div>
    </InboxLayout>
  );
  expect(screen.getByText('workspace 1')).toBe(workspace);
  auth.accountId = null;
  auth.loading = true;
  view.rerender(
    <InboxLayout>
      <div>C</div>
    </InboxLayout>
  );
  expect(screen.getByText('workspace 1')).toBe(workspace);
});

it('discards private state on account changes and confirmed sign-out', () => {
  const view = render(<InboxLayout>{null}</InboxLayout>);
  fireEvent.click(screen.getByText('workspace 0'));
  auth.accountId = 'B';
  view.rerender(<InboxLayout>{null}</InboxLayout>);
  expect(screen.getByText('workspace 0')).toBeVisible();
  auth.user = null;
  view.rerender(<InboxLayout>{null}</InboxLayout>);
  expect(screen.queryByText('workspace 0')).toBeNull();
  auth.user = { id: 'another' };
  view.rerender(<InboxLayout>{null}</InboxLayout>);
  expect(screen.getByText('workspace 0')).toBeVisible();
});
