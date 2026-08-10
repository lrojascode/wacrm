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

vi.mock('@/lib/account/admin-client', () => ({
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

describe('GET /api/contacts/export', () => {
  it('rejects non-owner callers with 403', async () => {
    mocks.requireRole.mockRejectedValue(new ForbiddenError('Owner role required'));

    const response = await GET();
    expect(response.status).toBe(403);
    expect(mocks.requireRole).toHaveBeenCalledWith('owner');
  });

  it('exports contacts in CSV format on happy path', async () => {
    mocks.requireRole.mockResolvedValue(context);

    const mockAdmin = {
      from: vi.fn().mockImplementation((table: string) => {
        if (table === 'contacts') {
          const query = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({
              data: [
                {
                  id: 'c-1',
                  phone: '+123456',
                  name: 'Alice',
                  email: 'alice@test.com',
                  company: 'Acme',
                  source: 'organic',
                  source_campaign_id: null,
                  created_at: '2026-08-01',
                  contact_tags: [{ tags: { name: 'VIP' } }],
                },
              ],
              error: null,
            }),
          };
          return query;
        }
        if (table === 'ad_campaigns') {
          const query = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            range: vi.fn().mockResolvedValue({ data: [], error: null }),
          };
          return query;
        }
        return {};
      }),
    };
    mocks.supabaseAdmin.mockReturnValue(mockAdmin);

    const response = await GET();
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toContain('text/csv');
    const text = await response.text();
    expect(text).toContain('"phone","name","email","company","tags","source","origin_campaign","created_at"');
    expect(text).toContain('Alice');
    expect(text).toContain('VIP');
  });
});
