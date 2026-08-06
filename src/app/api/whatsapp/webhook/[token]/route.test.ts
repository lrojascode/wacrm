import crypto from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '@/lib/whatsapp/encryption'

// ---------------------------------------------------------------------------
// Tests for the per-account webhook route (migration 044). The behavior that
// matters here is entirely about WHICH secret authenticates a request and
// WHICH entries get processed — not the message pipeline itself, which
// webhook-processing.test.ts already covers and which this file mocks away.
// ---------------------------------------------------------------------------

interface FakeConfig {
  id: string
  phone_number_id: string
  verify_token: string | null
  meta_app_id: string | null
  meta_app_secret_encrypted: string | null
}

const configsByToken: Record<string, FakeConfig> = {}
const configsByPhone: Record<string, FakeConfig> = {}

vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      if (table !== 'whatsapp_config') throw new Error(`unexpected table: ${table}`)
      return {
        select() {
          return {
            eq(column: 'webhook_token' | 'phone_number_id', value: string) {
              return {
                maybeSingle: async () => {
                  const row =
                    column === 'webhook_token' ? configsByToken[value] : configsByPhone[value]
                  return { data: row ?? null, error: null }
                },
              }
            },
          }
        },
        update() {
          return { eq: async () => ({ error: null }) }
        },
      }
    },
  }),
}))

let capturedAfter: (() => void | Promise<void>) | null = null
vi.mock('next/server', async (importOriginal) => {
  const actual = await importOriginal<typeof import('next/server')>()
  return {
    ...actual,
    // The real `after()` needs a live Next.js request context this test
    // runtime doesn't provide. Capture the callback instead so tests can
    // run it explicitly and inspect what it did.
    after: (cb: () => void | Promise<void>) => {
      capturedAfter = cb
    },
  }
})

interface CapturedProcessWebhookCall {
  body: unknown
  options: { isEntryAuthorized?: (phoneNumberId: string) => Promise<boolean> }
}
let capturedCall: CapturedProcessWebhookCall | null = null
vi.mock('@/lib/whatsapp/webhook-processing', () => ({
  processWebhook: vi.fn(async (body: unknown, options: CapturedProcessWebhookCall['options'] = {}) => {
    capturedCall = { body, options }
  }),
}))

const { POST, GET } = await import('./route')

const ENV_SECRET = 'test-meta-app-secret' // stubbed in vitest.config.ts

function sign(body: string, secret: string): string {
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex')
}

function postRequest(token: string, body: string, signature: string | null): Request {
  return new Request(`http://localhost/api/whatsapp/webhook/${token}`, {
    method: 'POST',
    headers: signature ? { 'x-hub-signature-256': signature } : {},
    body,
  })
}

function params(token: string) {
  return { params: Promise.resolve({ token }) }
}

beforeEach(() => {
  capturedAfter = null
  capturedCall = null
  for (const k of Object.keys(configsByToken)) delete configsByToken[k]
  for (const k of Object.keys(configsByPhone)) delete configsByPhone[k]
})

describe('POST /api/whatsapp/webhook/[token]', () => {
  it('accepts a request signed with the account’s own configured secret', async () => {
    const config: FakeConfig = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: null,
      meta_app_id: null,
      meta_app_secret_encrypted: encrypt('secret-a'),
    }
    configsByToken['tok-a'] = config

    const body = JSON.stringify({ entry: [] })
    const res = await POST(postRequest('tok-a', body, sign(body, 'secret-a')), params('tok-a'))

    expect(res.status).toBe(200)
  })

  it('rejects a signature made with the shared env secret when the account has its own', async () => {
    const config: FakeConfig = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: null,
      meta_app_id: null,
      meta_app_secret_encrypted: encrypt('secret-a'),
    }
    configsByToken['tok-a'] = config

    const body = JSON.stringify({ entry: [] })
    const res = await POST(postRequest('tok-a', body, sign(body, ENV_SECRET)), params('tok-a'))

    expect(res.status).toBe(401)
  })

  it('falls back to the shared env secret when the account has not configured its own', async () => {
    const config: FakeConfig = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: null,
      meta_app_id: null,
      meta_app_secret_encrypted: null,
    }
    configsByToken['tok-a'] = config

    const body = JSON.stringify({ entry: [] })
    const res = await POST(postRequest('tok-a', body, sign(body, ENV_SECRET)), params('tok-a'))

    expect(res.status).toBe(200)
  })

  it('rejects an unknown webhook token without leaking whether it exists', async () => {
    const body = JSON.stringify({ entry: [] })
    const res = await POST(postRequest('nope', body, sign(body, 'anything')), params('nope'))

    expect(res.status).toBe(401)
  })

  it('rejects a tampered body even with an otherwise-valid signature', async () => {
    const config: FakeConfig = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: null,
      meta_app_id: null,
      meta_app_secret_encrypted: encrypt('secret-a'),
    }
    configsByToken['tok-a'] = config

    const signed = JSON.stringify({ entry: [] })
    const header = sign(signed, 'secret-a')
    const tampered = JSON.stringify({ entry: [{ id: 'injected' }] })
    const res = await POST(postRequest('tok-a', tampered, header), params('tok-a'))

    expect(res.status).toBe(401)
  })

  describe('isEntryAuthorized — cross-account entry filtering', () => {
    async function runAndGetAuthorizer(token: string, secret: string) {
      const body = JSON.stringify({ entry: [] })
      const res = await POST(postRequest(token, body, sign(body, secret)), params(token))
      expect(res.status).toBe(200)
      await capturedAfter?.()
      expect(capturedCall?.options.isEntryAuthorized).toBeInstanceOf(Function)
      return capturedCall!.options.isEntryAuthorized!
    }

    it('authorizes the URL’s own phone_number_id', async () => {
      configsByToken['tok-a'] = {
        id: 'cfg-a',
        phone_number_id: 'PNID-A',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-a'),
      }

      const isEntryAuthorized = await runAndGetAuthorizer('tok-a', 'secret-a')
      await expect(isEntryAuthorized('PNID-A')).resolves.toBe(true)
    })

    it('authorizes a second phone_number_id that shares the same effective secret (multi-WABA, one app)', async () => {
      configsByToken['tok-a'] = {
        id: 'cfg-a',
        phone_number_id: 'PNID-A',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-a'),
      }
      configsByPhone['PNID-B'] = {
        id: 'cfg-b',
        phone_number_id: 'PNID-B',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-a'),
      }

      const isEntryAuthorized = await runAndGetAuthorizer('tok-a', 'secret-a')
      await expect(isEntryAuthorized('PNID-B')).resolves.toBe(true)
    })

    it('rejects an entry whose own config uses a DIFFERENT secret than the one that signed this delivery', async () => {
      configsByToken['tok-a'] = {
        id: 'cfg-a',
        phone_number_id: 'PNID-A',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-a'),
      }
      configsByPhone['PNID-VICTIM'] = {
        id: 'cfg-victim',
        phone_number_id: 'PNID-VICTIM',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-victim'),
      }

      const isEntryAuthorized = await runAndGetAuthorizer('tok-a', 'secret-a')
      await expect(isEntryAuthorized('PNID-VICTIM')).resolves.toBe(false)
    })

    it('authorizes an entry for a phone_number_id with no config at all, so the normal pipeline can log it', async () => {
      configsByToken['tok-a'] = {
        id: 'cfg-a',
        phone_number_id: 'PNID-A',
        verify_token: null,
        meta_app_id: null,
        meta_app_secret_encrypted: encrypt('secret-a'),
      }

      const isEntryAuthorized = await runAndGetAuthorizer('tok-a', 'secret-a')
      await expect(isEntryAuthorized('PNID-UNKNOWN')).resolves.toBe(true)
    })
  })
})

describe('GET /api/whatsapp/webhook/[token]', () => {
  function getRequest(token: string, qs: string): Request {
    return new Request(`http://localhost/api/whatsapp/webhook/${token}?${qs}`)
  }

  it('returns the challenge when hub.verify_token matches this account’s own config', async () => {
    configsByToken['tok-a'] = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: encrypt('my-verify-token'),
      meta_app_id: null,
      meta_app_secret_encrypted: null,
    }

    const res = await GET(
      getRequest('tok-a', 'hub.mode=subscribe&hub.challenge=1234&hub.verify_token=my-verify-token'),
      params('tok-a'),
    )

    expect(res.status).toBe(200)
    expect(await res.text()).toBe('1234')
  })

  it('rejects a verify_token that matches a DIFFERENT account’s config', async () => {
    configsByToken['tok-a'] = {
      id: 'cfg-a',
      phone_number_id: 'PNID-A',
      verify_token: encrypt('token-for-a'),
      meta_app_id: null,
      meta_app_secret_encrypted: null,
    }
    // Not registered under tok-a — even though it's a real token
    // elsewhere, this URL must only ever accept its own account's.
    const res = await GET(
      getRequest('tok-a', 'hub.mode=subscribe&hub.challenge=1234&hub.verify_token=token-for-someone-else'),
      params('tok-a'),
    )

    expect(res.status).toBe(403)
  })

  it('rejects an unknown token', async () => {
    const res = await GET(
      getRequest('nope', 'hub.mode=subscribe&hub.challenge=1234&hub.verify_token=anything'),
      params('nope'),
    )

    expect(res.status).toBe(403)
  })
})
