import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

// The SSRF guard resolves DNS for real (P0-SEC-04). These tests are
// about the *rest* of the contract, so the guard is held open here and
// exercised for real in template-header-handle.security.test.ts. Held
// open rather than removed: if the helper ever stops consulting it, the
// security file fails and this one keeps passing, which is the split we
// want — one file per question.
vi.mock('@/lib/webhooks/ssrf', () => ({
  isDeliverableUrl: vi.fn(async () => true),
}));

import { ensureImageHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

/**
 * A real `Response`, not a hand-rolled stand-in.
 *
 * The previous double exposed only `ok`, `status`, `headers.get` and
 * `arrayBuffer`. That was enough while the helper buffered the whole
 * body, and it silently stopped modelling reality once the helper
 * started streaming: a double with no `body` cannot show whether the
 * read is capped. Constructing the genuine article keeps the fixture
 * honest for free.
 */
function imgResponse(type = 'image/jpeg', size = 1024, status = 200): Response {
  return new Response(new Uint8Array(size), {
    status,
    headers: { 'content-type': type },
  });
}

describe('ensureImageHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-image headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureImageHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  it('derives + sets header_handle from a valid image URL', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).toHaveBeenCalledOnce();
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('forwards the exact bytes it read', async () => {
    // The streaming reader reassembles chunks by hand; an off-by-one in
    // the offset arithmetic would still produce a plausible-looking
    // buffer of the right length.
    vi.stubEnv('META_APP_ID', 'app-1');
    const source = new Uint8Array([1, 2, 3, 4, 5, 250, 251, 252]);
    const chunked = new ReadableStream<Uint8Array>({
      start(controller) {
        // Split across chunks on purpose: a single-chunk body would not
        // exercise the reassembly at all.
        controller.enqueue(source.slice(0, 3));
        controller.enqueue(source.slice(3, 5));
        controller.enqueue(source.slice(5));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(chunked, { headers: { 'content-type': 'image/png' } })),
    );

    await ensureImageHeaderHandle(payload(), 'tok');

    const sent = vi.mocked(uploadResumableMedia).mock.calls[0][0].bytes;
    expect(Array.from(sent)).toEqual(Array.from(source));
  });

  it('rejects a non-image content type', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('text/html')));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
  });

  it('rejects an image over 5 MB', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/png', 6 * 1024 * 1024)));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
  });

  it('rejects an empty body', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 0)));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/empty/);
  });

  it('surfaces a non-OK response', async () => {
    vi.stubEnv('META_APP_ID', 'app-1');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 10, 404)));
    await expect(ensureImageHeaderHandle(payload(), 'tok')).rejects.toThrow(/returned 404/);
  });

  it('uses the account’s own app id when given, without needing META_APP_ID set', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok', 'account-own-app-id');
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'account-own-app-id' }),
    );
    expect(p.header_handle).toBe('HANDLE123');
  });

  it('prefers the account’s own app id over the shared META_APP_ID', async () => {
    vi.stubEnv('META_APP_ID', 'shared-app-id');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok', 'account-own-app-id');
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'account-own-app-id' }),
    );
  });

  it('falls back to the shared META_APP_ID when the account has none configured (null)', async () => {
    vi.stubEnv('META_APP_ID', 'shared-app-id');
    vi.stubGlobal('fetch', vi.fn(async () => imgResponse('image/jpeg', 2048)));
    const p = payload();
    await ensureImageHeaderHandle(p, 'tok', null);
    expect(uploadResumableMedia).toHaveBeenCalledWith(
      expect.objectContaining({ appId: 'shared-app-id' }),
    );
  });
});
