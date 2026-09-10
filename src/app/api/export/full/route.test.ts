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

/**
 * Cuándo se autenticó quien llama, en segundos. Por defecto, hace un
 * momento: la exportación exige reautenticación reciente (P0-SEC-09),
 * así que un contexto sin esto describiría a alguien a quien la ruta
 * ya no dejaría pasar.
 */
let authTimestamp = () => Math.floor(Date.now() / 1000);

const context = {
  supabase: {
    auth: {
      getClaims: async () => ({
        data: { claims: { aal: 'aal2', amr: [{ method: 'totp', timestamp: authTimestamp() }] } },
        error: null,
      }),
    },
  },
  accountId: 'account-1',
  userId: 'user-owner',
  role: 'owner',
  account: { id: 'account-1', name: 'Acme' },
  factors: [{ status: 'verified' }],
};

beforeEach(() => {
  mocks.requireRole.mockReset();
  mocks.supabaseAdmin.mockReset();
  authTimestamp = () => Math.floor(Date.now() / 1000);
  // El contexto es un objeto compartido por todo el archivo, y
  // `requireRole` deja ahí las claims que leyó. Sin limpiarlo, un caso
  // heredaría la sesión "recién autenticada" del anterior.
  delete (context as { assurance?: unknown }).assurance;
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

describe('GET /api/export/full — reautenticación (P0-SEC-09)', () => {
  it('rechaza una sesión que lleva rato abierta', async () => {
    // Esta ruta entrega TODO el contenido de la cuenta en un archivo.
    // Que el owner iniciara sesión esta mañana no basta.
    mocks.requireRole.mockResolvedValue(context);
    authTimestamp = () => Math.floor(Date.now() / 1000) - 3600;

    const res = await GET();
    const body = (await res.json()) as { code?: string };

    expect(res.status).toBe(403);
    expect(body.code).toBe('reauth_required');
    // Lo que importa: no llegó a tocar la base para exportar nada.
    expect(mocks.supabaseAdmin).not.toHaveBeenCalled();
  });
});
