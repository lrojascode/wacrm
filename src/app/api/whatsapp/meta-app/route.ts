// ============================================================
// /api/whatsapp/meta-app — an account's own Meta app credentials
//
//   GET    — read back { meta_app_id, webhook_token, has_app_secret }.
//            The secret itself is NEVER returned, same as
//            /api/whatsapp/config never returns access_token.
//   PUT    — set/replace meta_app_id and/or meta_app_secret.
//   DELETE — clear both, reverting to the deployment-wide
//            META_APP_ID / META_APP_SECRET.
//
// Owner only. Unlike the rest of whatsapp_config (admin+ under RLS —
// migration 017), an app secret is credentials for a Meta app the
// AGENCY'S CLIENT owns, not a day-to-day WhatsApp setting; scoping it
// to the account owner keeps a regular admin from being able to swap
// in a different Meta app (and therefore a different webhook
// destination) for the whole account. RLS still allows admin+ to
// UPDATE whatsapp_config, so this route — not a policy — is the only
// place that distinguishes owner from admin; every handler below
// calls `requireRole('owner')` before touching anything.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { encrypt } from '@/lib/whatsapp/encryption'

interface MetaAppRow {
  meta_app_id: string | null
  webhook_token: string | null
  meta_app_secret_encrypted: string | null
}

function shape(row: MetaAppRow | null) {
  if (!row) {
    return { configured: false as const }
  }
  return {
    configured: true as const,
    meta_app_id: row.meta_app_id,
    webhook_token: row.webhook_token,
    has_app_secret: row.meta_app_secret_encrypted != null,
  }
}

export async function GET() {
  try {
    const ctx = await requireRole('owner')

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .select('meta_app_id, webhook_token, meta_app_secret_encrypted')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (error) {
      console.error('[GET /api/whatsapp/meta-app] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load Meta app settings' }, { status: 500 })
    }

    return NextResponse.json(shape(data))
  } catch (err) {
    return toErrorResponse(err)
  }
}

const APP_ID_RE = /^[0-9]{1,32}$/

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('owner')

    const body = (await request.json().catch(() => null)) as
      | { meta_app_id?: unknown; meta_app_secret?: unknown }
      | null

    const update: Record<string, unknown> = {}

    if (body && 'meta_app_id' in body) {
      const raw = body.meta_app_id
      if (raw === null || raw === '') {
        update.meta_app_id = null
      } else if (typeof raw === 'string' && APP_ID_RE.test(raw.trim())) {
        update.meta_app_id = raw.trim()
      } else {
        return NextResponse.json(
          { error: 'meta_app_id must be the numeric App ID from Meta for Developers, or null to clear it.' },
          { status: 400 },
        )
      }
    }

    if (body && 'meta_app_secret' in body) {
      const raw = body.meta_app_secret
      if (raw === null || raw === '') {
        update.meta_app_secret_encrypted = null
      } else if (typeof raw === 'string' && raw.trim().length > 0) {
        try {
          update.meta_app_secret_encrypted = encrypt(raw.trim())
        } catch (err) {
          const message = err instanceof Error ? err.message : 'Unknown encryption error'
          console.error('[PUT /api/whatsapp/meta-app] encryption failed:', message)
          return NextResponse.json(
            { error: 'Failed to encrypt the App Secret. Check ENCRYPTION_KEY on the server.' },
            { status: 500 },
          )
        }
      } else {
        return NextResponse.json(
          { error: 'meta_app_secret must be a non-empty string, or null to clear it.' },
          { status: 400 },
        )
      }
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'Provide meta_app_id and/or meta_app_secret.' },
        { status: 400 },
      )
    }

    // A whatsapp_config row (and therefore webhook_token) only exists
    // once the account has saved its WhatsApp number at least once —
    // there is nothing to attach an app secret to before that.
    const { data: existing } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (!existing) {
      return NextResponse.json(
        { error: 'Connect your WhatsApp number in Settings before configuring a Meta app.' },
        { status: 400 },
      )
    }

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .update(update)
      .eq('account_id', ctx.accountId)
      .select('meta_app_id, webhook_token, meta_app_secret_encrypted')
      .single()

    if (error) {
      console.error('[PUT /api/whatsapp/meta-app] update error:', error)
      return NextResponse.json({ error: 'Failed to save Meta app settings' }, { status: 500 })
    }

    return NextResponse.json(shape(data))
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE() {
  try {
    const ctx = await requireRole('owner')

    const { data, error } = await ctx.supabase
      .from('whatsapp_config')
      .update({ meta_app_id: null, meta_app_secret_encrypted: null })
      .eq('account_id', ctx.accountId)
      .select('meta_app_id, webhook_token, meta_app_secret_encrypted')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/whatsapp/meta-app] update error:', error)
      return NextResponse.json({ error: 'Failed to reset Meta app settings' }, { status: 500 })
    }

    return NextResponse.json(shape(data))
  } catch (err) {
    return toErrorResponse(err)
  }
}
