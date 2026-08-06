import { NextResponse, after } from 'next/server'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyMetaWebhookSignature } from '@/lib/whatsapp/webhook-signature'
import { processWebhook, type WhatsAppWebhookEntry } from '@/lib/whatsapp/webhook-processing'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'

/**
 * Per-account WhatsApp webhook — for a client running their own Meta
 * app (their own App ID + App Secret, configured in Settings →
 * WhatsApp → "Aplicación de Meta") rather than the deployment-wide app
 * behind `META_APP_ID` / `META_APP_SECRET`.
 *
 * `token` is `whatsapp_config.webhook_token` (migration 044) — an
 * opaque, unguessable path segment, NOT a bearer credential. It exists
 * because Meta signs the whole request body with the app secret, so
 * the server has to know WHICH secret to check before it can trust
 * anything in the body — a URL segment is the only thing available
 * before that point. The signature itself is what authenticates the
 * request; the token only routes it to the right secret.
 *
 * The legacy `/api/whatsapp/webhook` route (single shared secret) is
 * untouched and keeps working for every account that hasn't set up
 * its own app.
 */
export const maxDuration = 60

interface WebhookConfigRow {
  id: string
  phone_number_id: string
  verify_token: string | null
  meta_app_id: string | null
  meta_app_secret_encrypted: string | null
}

async function findConfigByToken(token: string): Promise<WebhookConfigRow | null> {
  const { data, error } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, phone_number_id, verify_token, meta_app_id, meta_app_secret_encrypted')
    .eq('webhook_token', token)
    .maybeSingle()
  if (error) {
    console.error('[webhook/token] Error looking up config by webhook_token:', error)
    return null
  }
  return data
}

/**
 * The secret this config actually verifies against: its own app
 * secret if it configured one, otherwise the deployment-wide
 * `META_APP_SECRET`. Same fallback semantics as `meta_app_id` in
 * template submission (src/lib/whatsapp/template-header-handle.ts) —
 * a NULL column means "use the shared app", not "no secret at all".
 */
function effectiveSecret(config: { meta_app_secret_encrypted: string | null }): string | undefined {
  if (!config.meta_app_secret_encrypted) return process.env.META_APP_SECRET
  try {
    return decrypt(config.meta_app_secret_encrypted)
  } catch (err) {
    console.error('[webhook/token] Failed to decrypt meta_app_secret_encrypted:', err)
    return undefined
  }
}

// GET - Webhook verification, scoped to the single account this URL
// belongs to (unlike the legacy route, which checks every config's
// verify_token — there's exactly one candidate here by construction).
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await params
    const { searchParams } = new URL(request.url)
    const mode = searchParams.get('hub.mode')
    const challenge = searchParams.get('hub.challenge')
    const verifyToken = searchParams.get('hub.verify_token')

    if (mode !== 'subscribe' || !challenge || !verifyToken) {
      return NextResponse.json(
        { error: 'Missing verification parameters' },
        { status: 400 },
      )
    }

    const config = await findConfigByToken(token)
    if (!config?.verify_token) {
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 },
      )
    }

    let matches: boolean
    try {
      matches = decrypt(config.verify_token) === verifyToken
    } catch {
      matches = false
    }

    if (!matches) {
      return NextResponse.json(
        { error: 'Verification token mismatch' },
        { status: 403 },
      )
    }

    // Fire-and-forget GCM upgrade, same as the legacy route.
    if (isLegacyFormat(config.verify_token)) {
      void supabaseAdmin()
        .from('whatsapp_config')
        .update({ verify_token: encrypt(verifyToken) })
        .eq('id', config.id)
        .then(({ error }: { error: unknown }) => {
          if (error) {
            console.warn(
              '[webhook/token] verify_token GCM upgrade failed:',
              (error as { message?: string })?.message ?? error,
            )
          }
        })
    }

    return new Response(challenge, {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    })
  } catch (error) {
    console.error('Error in webhook GET verification:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 },
    )
  }
}

// POST - Receive messages, verified against this account's own app
// secret (or the shared one, if it hasn't configured its own).
export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params

  const config = await findConfigByToken(token)
  if (!config) {
    // Generic 401, not 404 — don't let the response distinguish "no
    // such token" from "token exists but signature failed", which
    // would let an attacker enumerate valid webhook URLs.
    console.warn('[webhook/token] rejected request for unknown webhook_token')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  // Read raw body first so we can HMAC-verify the exact bytes Meta
  // signed. request.json() would re-encode and break the signature.
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')
  const secret = effectiveSecret(config)

  if (!verifyMetaWebhookSignature(rawBody, signature, secret)) {
    console.warn('[webhook/token] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: { entry?: WhatsAppWebhookEntry[] }
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  // Same ack-then-process pattern as the legacy route — see its
  // comment for why this must use `after()` rather than a detached
  // promise (issue #301).
  after(async () => {
    try {
      await processWebhook(body, {
        // Meta allows several WABAs to share one app's webhook
        // callback, so a single delivery to THIS account's URL can
        // legitimately carry entries for phone numbers connected
        // under a different wacrm account. Only process an entry if
        // its own destination config's effective secret ALSO
        // validates this exact signature — i.e. it was genuinely
        // signed by the same app. An unknown phone_number_id (no
        // config at all) is allowed through so processWebhook's own
        // lookup logs the normal "no config found" message; only a
        // KNOWN config with a DIFFERENT secret is rejected here.
        isEntryAuthorized: async (phoneNumberId) => {
          if (phoneNumberId === config.phone_number_id) return true
          const { data: entryConfig, error } = await supabaseAdmin()
            .from('whatsapp_config')
            .select('meta_app_secret_encrypted')
            .eq('phone_number_id', phoneNumberId)
            .maybeSingle()
          if (error) {
            console.error(
              '[webhook/token] Error resolving entry config for authorization check:',
              error,
            )
            return false
          }
          if (!entryConfig) return true // unknown number — let the normal flow report it
          const entrySecret = effectiveSecret(entryConfig)
          return verifyMetaWebhookSignature(rawBody, signature, entrySecret)
        },
      })
    } catch (error) {
      console.error('Error processing webhook:', error)
    }
  })

  return NextResponse.json({ status: 'received' }, { status: 200 })
}
