import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '@/lib/auth/account';

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  supabaseAdmin: vi.fn(),
}));

vi.mock('@/lib/auth/account', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/auth/account')>();
  return {
    ...actual,
    requireRole: mocks.requireRole,
  };
});

vi.mock('@/lib/supabase/admin', () => ({
  supabaseAdmin: mocks.supabaseAdmin,
}));

import { GET } from './route';

const context = {
  supabase: {},
  accountId: 'account-1',
  userId: 'user-owner',
  role: 'owner',
  account: { id: 'account-1', name: 'Acme' },
};

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.supabaseAdmin.mockReset();
});

describe('GET /api/export/full', () => {
  it('rejects non-owner callers with 403', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('Owner role required'));

    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
  });

  it('exports full CRM data in JSONL format for owner', async () => {
    mocks.requireRole.mockResolvedValue(context);

    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'ad_campaigns') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'c-1',
                  phone: '+123456',
                  name: 'Bob',
                  email: 'bob@test.com',
                  company: 'Corp',
                  avatar_url: null,
                  source: 'ad',
                  source_ad_id: 'ad-123',
                  source_campaign_id: null,
                  source_meta: null,
                  source_captured_at: '2026-08-01',
                  created_at: '2026-08-01',
                  updated_at: '2026-08-01',
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'contact_tags') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'contact_custom_values') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'deals') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'conversations') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'conv-1',
                  contact_id: 'c-1',
                  status: 'open',
                  unread_count: 0,
                  created_at: '2026-08-01',
                  updated_at: '2026-08-01',
                },
              ],
              error: null,
            }),
          };
        }
        if (table === 'messages') {
          return {
            select: vi.fn().mockReturnThis(),
            in: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'msg-1',
                  conversation_id: 'conv-1',
                  direction: 'inbound',
                  content_type: 'audio',
                  content: null,
                  media_url: 'http://example.com/voice.ogg',
                  status: 'delivered',
                  created_at: '2026-08-01',
                },
              ],
              error: null,
            }),
          };
        }
        return {};
      }),
    };
    mocks.supabaseAdmin.mockReturnValue(mockAdmin);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('application/x-ndjson');
    const text = await response.text();
    expect(text).toContain('Bob');
    expect(text).toContain('voice.ogg');
    expect(text).toContain('audio');
  });

  it('aborts stream on database error during export', async () => {
    mocks.requireRole.mockResolvedValue(context);

    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'ad_campaigns') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
        }
        if (table === 'contacts') {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            limit: vi.fn().mockResolvedValue({
              data: null,
              error: new Error('Database failure mid-stream'),
            }),
          };
        }
        return {};
      }),
    };
    mocks.supabaseAdmin.mockReturnValue(mockAdmin);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.body).toBeDefined();

    // Reading stream should reject due to controller.error
    await expect(response.text()).rejects.toThrow();
  });
});
