import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ upload: vi.fn(), remove: vi.fn() }));
vi.mock('next-intl', () => ({ useTranslations: () => (key: string) => key }));
vi.mock('@/hooks/use-can', () => ({ useCan: () => true }));
vi.mock('@/lib/storage/upload-media', () => ({
  uploadAccountMedia: mocks.upload,
  deleteAccountMedia: mocks.remove,
  MEDIA_MAX_BYTES_BY_KIND: { image: 1_000_000 },
}));
vi.mock('./quick-reply-picker', () => ({ QuickReplyPicker: () => null }));
const { MessageComposer } = await import('./message-composer');
const props = {
  conversationId: 'A',
  sessionExpired: false,
  onSend: vi.fn(),
  onSendMedia: vi.fn(),
  onSendInteractive: vi.fn(),
  onOpenTemplates: vi.fn(),
};
beforeEach(() => {
  mocks.remove.mockResolvedValue(undefined);
});

it('blocks typing and sending until the initial thread is loaded, but keeps a controlled draft', () => {
  const onDraftChange = vi.fn();
  const view = render(
    <MessageComposer
      {...props}
      loading
      draftText="draft A"
      onDraftChange={onDraftChange}
    />
  );
  expect(screen.getByRole('textbox')).toBeDisabled();
  expect(screen.getByRole('textbox')).toHaveValue('draft A');
  expect(screen.getByRole('button', { name: 'send' })).toBeDisabled();
  view.rerender(
    <MessageComposer
      {...props}
      loading={false}
      draftText="draft A"
      onDraftChange={onDraftChange}
    />
  );
  expect(screen.getByRole('textbox')).toBeEnabled();
  fireEvent.change(screen.getByRole('textbox'), {
    target: { value: 'edited A' },
  });
  expect(onDraftChange).toHaveBeenCalledWith('edited A');
});

it('cleans an upload that finishes after its composer has been abandoned', async () => {
  let resolve!: (value: { publicUrl: string; path: string }) => void;
  mocks.upload.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  const view = render(<MessageComposer {...props} />);
  const input = view.container.querySelector('input[type="file"]')!;
  fireEvent.change(input, {
    target: { files: [new File(['image'], 'test.png', { type: 'image/png' })] },
  });
  expect(mocks.upload).toHaveBeenCalled();
  view.unmount();
  await act(async () =>
    resolve({
      publicUrl: 'https://example.test/test.png',
      path: 'account/test.png',
    })
  );
  expect(mocks.remove).toHaveBeenCalledWith('chat-media', 'account/test.png');
});
