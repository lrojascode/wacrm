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

const { processWebhook, matchContactForMessage } = await import(
  './webhook-processing'
)

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

  it('still resolves the config when the payload carries no contacts array', async () => {
    // The name is the only thing `contacts` ever provided; the sender's
    // number comes from `messages[].from`. A missing/empty `contacts`
    // used to drop the whole entry — a real customer message lost.
    const body = messageEntryBody('PNID-A')
    delete (body.entry[0].changes[0].value as { contacts?: unknown }).contacts

    await processWebhook(body)

    expect(fromCalls).toContain('whatsapp_config')
  })
})

describe('matchContactForMessage', () => {
  const tatiana = { profile: { name: 'Tatiana Vasquez' }, wa_id: '51987654321' }
  const bruno = { profile: { name: 'Bruno Diaz' }, wa_id: '51911223344' }

  it('pairs by wa_id, not by position', () => {
    // Meta sends one contacts entry per unique SENDER, so a batch of
    // three messages from two people has only two contacts. Index 2 is
    // past the end — the old `contacts[i] || contacts[0]` handed this
    // message Tatiana's name.
    const contacts = [tatiana, bruno]

    expect(matchContactForMessage(contacts, { from: '51911223344' }, 2)).toBe(
      bruno,
    )
  })

  it('does not mis-pair when the arrays happen to be the same length', () => {
    // Same length, opposite order — positional pairing looks correct
    // right up until it silently swaps two customers' names.
    const contacts = [bruno, tatiana]

    expect(matchContactForMessage(contacts, { from: '51987654321' }, 0)).toBe(
      tatiana,
    )
  })

  it('tolerates trunk-prefix variance between from and wa_id', () => {
    const mx = { profile: { name: 'Ana' }, wa_id: '5215512345678' }

    expect(matchContactForMessage([mx], { from: '525512345678' }, 0)).toBe(mx)
  })

  it('falls back to the positional guess when no wa_id matches', () => {
    // Undocumented payload shape: keep the old behaviour rather than
    // dropping a message we can still store.
    const contacts = [tatiana, bruno]

    expect(matchContactForMessage(contacts, { from: '51999999999' }, 1)).toBe(
      bruno,
    )
  })

  it('still resolves a contact when `from` is missing entirely', () => {
    // The incident shape: `messages[].from` absent, `contacts[]` intact.
    // Positional lookup is all that is left, and it has to keep working
    // — it is what lets processMessage recover the number from `wa_id`
    // instead of writing a contact with an empty phone.
    expect(matchContactForMessage([tatiana], { from: undefined }, 0)).toBe(
      tatiana,
    )
    expect(matchContactForMessage([tatiana], { from: '' }, 0)).toBe(tatiana)
  })

  it('returns undefined for an absent contacts array', () => {
    expect(matchContactForMessage(undefined, { from: '51987654321' }, 0)).toBe(
      undefined,
    )
    expect(matchContactForMessage([], { from: '51987654321' }, 0)).toBe(
      undefined,
    )
  })
})
