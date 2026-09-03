// ============================================================
// PUT /api/account/appearance — owner-only theme + mode
//
// Migration 051 adds `accounts.theme` / `accounts.mode` without a grant
// for the `authenticated` role at all (mirrors brand_name / logo_url
// from 047) — this route, gated by requireRole('owner') and using the
// service-role client, is the only path that can write them.
//
// The written value becomes every member's appearance: `useAuth`
// reads `theme`/`mode` off the account row, and `AccountThemeSync`
// (mounted in the dashboard shell) applies them to `useTheme()` for
// everyone whose role isn't owner. See src/components/layout/
// account-theme-sync.tsx for the client-side half.
// ============================================================

import { NextResponse } from 'next/server'

import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/account/admin-client'
import { isMode, isThemeId } from '@/lib/themes'

export async function PUT(request: Request) {
  try {
    const ctx = await requireRole('owner')

    const body = (await request.json().catch(() => null)) as
      | { theme?: unknown; mode?: unknown }
      | null

    const update: Record<string, unknown> = {}

    if (body && 'theme' in body) {
      if (!isThemeId(body.theme)) {
        return NextResponse.json(
          { error: 'theme must be one of violet, emerald, cobalt, amber, rose' },
          { status: 400 },
        )
      }
      update.theme = body.theme
    }

    if (body && 'mode' in body) {
      if (!isMode(body.mode)) {
        return NextResponse.json(
          { error: "mode must be 'light' or 'dark'" },
          { status: 400 },
        )
      }
      update.mode = body.mode
    }

    if (Object.keys(update).length === 0) {
      return NextResponse.json(
        { error: 'Provide at least one of theme, mode' },
        { status: 400 },
      )
    }

    const { data, error } = await supabaseAdmin()
      .from('accounts')
      .update(update)
      .eq('id', ctx.accountId)
      .select('theme, mode')
      .single()

    if (error) {
      console.error('[PUT /api/account/appearance] update error:', error)
      // The database is running behind the deployed code: migration 051
      // has not been applied to it yet. Say so instead of the generic
      // failure — the generic message sent a real deployment straight
      // into "the save button is broken" when the fix was one bundle
      // away. 503: the request is valid, the backing store just is not
      // ready for it yet.
      //
      // Two codes, because the failure surfaces at two different layers:
      //   PGRST204 — PostgREST rejects the write against its own schema
      //              cache before Postgres ever sees it. This is the one
      //              that actually fires here (verified locally).
      //   42703    — Postgres undefined_column, for the narrower window
      //              where the cache is fresh but the column is not there.
      if (error.code === 'PGRST204' || error.code === '42703') {
        return NextResponse.json(
          {
            error:
              'This database is missing the appearance columns. Apply docs/deploy/account-appearance.sql (migration 051) in the Supabase SQL editor, then try again.',
          },
          { status: 503 },
        )
      }
      return NextResponse.json(
        { error: 'Failed to save appearance settings' },
        { status: 500 },
      )
    }

    return NextResponse.json(data)
  } catch (err) {
    return toErrorResponse(err)
  }
}
