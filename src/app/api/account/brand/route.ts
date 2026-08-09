// ============================================================
// PUT /api/account/brand — owner-only account name + logo
//
// Migration 047 revokes UPDATE on accounts.brand_name / logo_url from
// the `authenticated` role entirely (accounts.name / default_currency
// keep a narrower column grant so Deals & currency, which is not
// owner-only, keeps working). That means even the account owner's own
// browser session can no longer write these two columns directly —
// this route, gated by requireRole('owner') and using the service-role
// client, is the only remaining path. See migration 047's comment for
// the full reasoning.
//
// The logo file itself is still uploaded client-side straight to
// Storage (src/lib/storage/upload-media.ts) — the brand-assets bucket's
// RLS policies (043, tightened to owner-only by 047) already gate that
// write. This route only persists the resulting URL (or its removal)
// on the accounts row.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/account/admin-client'
import { MAX_BRAND_NAME_LEN, normalizeBrandName } from '@/lib/branding/brand'

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('owner')

    const body = (await request.json().catch(() => null)) as
      | { name?: unknown; logo_url?: unknown }
      | null

    const rawName = typeof body?.name === 'string' ? body.name : ''
    const brandName = normalizeBrandName(rawName)
    if (rawName.trim().length > MAX_BRAND_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_BRAND_NAME_LEN} characters or fewer` },
        { status: 400 },
      )
    }

    // logo_url is optional in the body: omitted means "leave as is",
    // null means "remove it", a string means "set it". Distinguish
    // omitted from null via `in`, the same way PUT /api/whatsapp/meta-app
    // does for its optional fields.
    const update: Record<string, unknown> = {
      // `name` is NOT NULL on accounts — fall back to the current
      // value (fetched below) rather than writing an empty string,
      // mirroring brand-settings.tsx's prior client-side behavior.
    }
    if (body && 'logo_url' in body) {
      const raw = body.logo_url
      if (raw === null) {
        update.logo_url = null
      } else if (typeof raw === 'string' && raw.startsWith('http')) {
        update.logo_url = raw
      } else {
        return NextResponse.json(
          { error: 'logo_url must be an http(s) URL, or null to remove it' },
          { status: 400 },
        )
      }
    }

    const { data: existing, error: fetchError } = await supabaseAdmin()
      .from('accounts')
      .select('name')
      .eq('id', ctx.accountId)
      .maybeSingle()
    if (fetchError || !existing) {
      console.error('[PUT /api/account/brand] fetch error:', fetchError)
      return NextResponse.json({ error: 'Account not found' }, { status: 404 })
    }

    update.name = brandName ?? existing.name ?? ''
    update.brand_name = brandName

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update(update)
      .eq('id', ctx.accountId)
      .select('name, brand_name, logo_url')
      .single()

    if (error) {
      console.error('[PUT /api/account/brand] update error:', error)
      return NextResponse.json({ error: 'Failed to save brand settings' }, { status: 500 })
    }

    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}
