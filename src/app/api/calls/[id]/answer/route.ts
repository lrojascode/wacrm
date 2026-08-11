import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { preAcceptCall } from '@/lib/whatsapp/calls-api'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent')
    const { id: callSessionId } = await params

    const body = (await request.json().catch(() => null)) as { userSdp?: string } | null
    if (!body?.userSdp) {
      return NextResponse.json({ error: 'userSdp is required' }, { status: 400 })
    }

    // 1. Verify tenant membership & ring authorization for this call session
    const { data: existingSession, error: fetchErr } = await supabaseAdmin()
      .from('call_sessions')
      .select('account_id, ring_user_ids, status')
      .eq('id', callSessionId)
      .eq('account_id', ctx.accountId)
      .maybeSingle()

    if (fetchErr || !existingSession) {
      return NextResponse.json({ error: 'Call session not found' }, { status: 404 })
    }

    const ringUserIds: string[] = existingSession.ring_user_ids || []
    if (ringUserIds.length > 0 && !ringUserIds.includes(ctx.userId)) {
      return NextResponse.json(
        { error: 'User is not authorized to answer this call' },
        { status: 403 }
      )
    }

    // 2. Atomic claim in Postgres via service role scoped to account_id
    const now = new Date().toISOString()
    const { data: updatedSessions, error: claimErr } = await supabaseAdmin()
      .from('call_sessions')
      .update({
        answered_by: ctx.userId,
        status: 'claimed',
        answered_at: now,
        answer_sdp: body.userSdp,
      })
      .eq('id', callSessionId)
      .eq('account_id', ctx.accountId)
      .eq('status', 'ringing')
      .is('answered_by', null)
      .select()

    if (claimErr) {
      console.error('[calls/answer] Claim error:', claimErr)
      return NextResponse.json({ error: 'Database error claiming call' }, { status: 500 })
    }

    if (!updatedSessions || updatedSessions.length === 0) {
      // 409 Conflict: call was already claimed by another agent or ended
      return NextResponse.json(
        { error: 'Call already claimed or no longer ringing' },
        { status: 409 }
      )
    }

    const session = updatedSessions[0]

    // 3. Pre-accept call via Meta Graph API v23.0
    try {
      await preAcceptCall({
        accountId: session.account_id,
        waCallId: session.wa_call_id,
        userSdp: body.userSdp,
      })
    } catch (metaErr: unknown) {
      const msg = metaErr instanceof Error ? metaErr.message : 'Meta preAcceptCall failed'
      console.error('[calls/answer] Meta preAcceptCall failed:', metaErr)
      // Revert session status to failed
      await supabaseAdmin()
        .from('call_sessions')
        .update({ status: 'failed', end_reason: msg })
        .eq('id', callSessionId)
        .eq('account_id', ctx.accountId)

      return NextResponse.json({ error: msg }, { status: 502 })
    }

    return NextResponse.json({ success: true, callSession: session })
  } catch (err) {
    return toErrorResponse(err)
  }
}
