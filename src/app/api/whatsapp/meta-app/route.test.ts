import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt } from '@/lib/whatsapp/encryption'

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
}))

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: vi.fn(() => Response.json({ error: 'auth failed' }, { status: 403 })),
}))

// Row currently "in the database" for the test — mutated by PUT/DELETE so
// consecutive calls in one test see their own writes, same as a real table.
let row: {
  id: string
  meta_app_id: string | null
  webhook_token: string | null
  meta_app_secret_encrypted: string | null
} | null

function fakeSupabase() {
  return {
    from(table: string) {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table: ${table}`)
      return {
        select() {
          return {
            eq() {
              return {
                maybeSingle: async () => ({ data: row, error: null }),
              }
            },
          }
        },
        update(patch: Record<string, unknown>) {
          return {
            eq() {
              if (row) row = { ...row, ...patch }
              return {
                select() {
                  return {
                    single: async () => ({ data: row, error: null }),
                    maybeSingle: async () => ({ data: row, error: null }),
                  }
                },
              }
            },
          }
        },
      }
    },
  }
}

const context = () => ({
  supabase: fakeSupabase(),
  accountId: 'account-1',
  userId: 'user-1',
  role: 'owner' as const,
  account: { id: 'account-1', name: 'Acme' },
})

import { DELETE, GET, PUT } from './route'

function putRequest(body: unknown) {
  return new Request('http://localhost/api/whatsapp/meta-app', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  mocks.requireRole.mockReset()
  mocks.requireRole.mockImplementation(async () => context())
  row = {
    id: 'cfg-1',
    meta_app_id: null,
    webhook_token: 'abc123',
    meta_app_secret_encrypted: null,
  }
})

describe('GET /api/whatsapp/meta-app', () => {
  it('requires the owner role, not just admin', async () => {
    await GET()
    expect(mocks.requireRole).toHaveBeenCalledWith('owner')
  })

  it('reports configured:false when no whatsapp_config row exists yet', async () => {
    row = null
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({ configured: false })
  })

  it('never returns the encrypted secret, only a has_app_secret flag', async () => {
    row = {
      id: 'cfg-1',
      meta_app_id: '123456',
      webhook_token: 'abc123',
      meta_app_secret_encrypted: 'enc:whatever',
    }
    const res = await GET()
    const body = await res.json()
    expect(body).toEqual({
      configured: true,
      meta_app_id: '123456',
      webhook_token: 'abc123',
      has_app_secret: true,
    })
    expect(JSON.stringify(body)).not.toContain('enc:whatever')
  })
})

describe('PUT /api/whatsapp/meta-app', () => {
  it('requires the owner role', async () => {
    await PUT(putRequest({ meta_app_id: '123456' }))
    expect(mocks.requireRole).toHaveBeenCalledWith('owner')
  })

  it('rejects a non-numeric meta_app_id', async () => {
    const res = await PUT(putRequest({ meta_app_id: 'not-a-number' }))
    expect(res.status).toBe(400)
  })

  it('rejects an empty body (nothing to update)', async () => {
    const res = await PUT(putRequest({}))
    expect(res.status).toBe(400)
  })

  it('rejects when no whatsapp_config row exists yet', async () => {
    row = null
    const res = await PUT(putRequest({ meta_app_id: '123456' }))
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error).toMatch(/connect your whatsapp number/i)
  })

  it('encrypts the secret before storing it, and never echoes it back', async () => {
    const res = await PUT(putRequest({ meta_app_id: '123456', meta_app_secret: 'super-secret-value' }))
    expect(res.status).toBe(200)

    const body = await res.json()
    expect(body).toEqual({
      configured: true,
      meta_app_id: '123456',
      webhook_token: 'abc123',
      has_app_secret: true,
    })
    expect(JSON.stringify(body)).not.toContain('super-secret-value')

    // The stored value round-trips through the real encryption module —
    // proves it was actually encrypted, not stored as-is.
    expect(row!.meta_app_secret_encrypted).not.toBe('super-secret-value')
    expect(decrypt(row!.meta_app_secret_encrypted!)).toBe('super-secret-value')
  })

  it('clears the secret when meta_app_secret is explicitly null', async () => {
    row!.meta_app_secret_encrypted = 'enc:old-secret'
    const res = await PUT(putRequest({ meta_app_secret: null }))
    expect(res.status).toBe(200)
    expect(row!.meta_app_secret_encrypted).toBeNull()
  })

  it('clears meta_app_id when set to an empty string', async () => {
    row!.meta_app_id = '999'
    const res = await PUT(putRequest({ meta_app_id: '' }))
    expect(res.status).toBe(200)
    expect(row!.meta_app_id).toBeNull()
  })
})

describe('DELETE /api/whatsapp/meta-app', () => {
  it('requires the owner role', async () => {
    await DELETE()
    expect(mocks.requireRole).toHaveBeenCalledWith('owner')
  })

  it('clears both meta_app_id and the secret, reverting to the shared app', async () => {
    row = {
      id: 'cfg-1',
      meta_app_id: '123456',
      webhook_token: 'abc123',
      meta_app_secret_encrypted: 'enc:secret',
    }
    const res = await DELETE()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      configured: true,
      meta_app_id: null,
      webhook_token: 'abc123',
      has_app_secret: false,
    })
  })
})
