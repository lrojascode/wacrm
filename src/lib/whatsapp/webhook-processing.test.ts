import { beforeEach, describe, expect, it, vi } from 'vitest'

// ---------------------------------------------------------------------------
// Only the entry-authorization gate is under test here — the actual
// message/contact/conversation pipeline downstream of it is exercised in
// production traffic and has no unit coverage of its own to preserve; this
// file is scoped to the one new piece of logic migration 044 added:
// `processWebhook` must never touch a change entry's owning account before
// `isEntryAuthorized` (when provided) has cleared it. See
// src/app/api/whatsapp/webhook/[token]/route.test.ts for what constructs
// that hook and decides true/false.
// ---------------------------------------------------------------------------

const fromCalls: string[] = []

function chainable(result: { data: unknown; error: unknown }) {
  // Minimal stand-in for a supabase-js PostgrestFilterBuilder: chainable,
  // and awaitable (thenable) at any point in the chain, matching how the
  // real query builder is used without a trailing `.maybeSingle()`.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const obj: any = {
    then(resolve: (v: typeof result) => void) {
      resolve(result)
    },
  }
  for (const m of ['select', 'eq', 'order', 'limit', 'in', 'update', 'insert', 'delete']) {
    obj[m] = () => obj
  }
  obj.maybeSingle = async () => result
  obj.single = async () => result
  return obj
}

vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      fromCalls.push(table)
      // Empty result for every table — enough for `whatsapp_config` to hit
      // the pipeline's own "no config found" branch and return, which is
      // as far as this test needs to go.
      return chainable({ data: [], error: null })
    },
  }),
}))

const { processWebhook } = await import('./webhook-processing')

function messageEntryBody(phoneNumberId: string) {
  return {
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+1', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Test' }, wa_id: '15550001111' }],
              messages: [
                {
                  id: 'wamid.1',
                  from: '15550001111',
                  timestamp: '1700000000',
                  type: 'text',
                  text: { body: 'hi' },
                },
              ],
            },
          },
        ],
      },
    ],
  }
}

beforeEach(() => {
  fromCalls.length = 0
})

describe('processWebhook — entry authorization gate', () => {
  it('never resolves the entry’s whatsapp_config when isEntryAuthorized rejects it', async () => {
    await processWebhook(messageEntryBody('PNID-VICTIM'), {
      isEntryAuthorized: async () => false,
    })

    expect(fromCalls).not.toContain('whatsapp_config')
  })

  it('proceeds to resolve whatsapp_config when isEntryAuthorized clears the entry', async () => {
    await processWebhook(messageEntryBody('PNID-A'), {
      isEntryAuthorized: async () => true,
    })

    expect(fromCalls).toContain('whatsapp_config')
  })

  it('proceeds unconditionally when no authorization hook is given (the legacy shared-secret route)', async () => {
    await processWebhook(messageEntryBody('PNID-A'))

    expect(fromCalls).toContain('whatsapp_config')
  })
})
