import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { acceptCall } from '@/lib/whatsapp/calls-api'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('agent')
    const { id: callSessionId } = await params

    const { data: session, error: fetchErr } = await supabaseAdmin()
      .from('call_sessions')
      .select('*')
      .eq('id', callSessionId)
      .maybeSingle()

    if (fetchErr || !session) {
      return NextResponse.json({ error: 'Call session not found' }, { status: 404 })
    }

    if (session.answered_by !== ctx.userId) {
      return NextResponse.json({ error: 'Call was not claimed by you' }, { status: 403 })
    }

    if (!session.answer_sdp) {
      return NextResponse.json({ error: 'No saved answer_sdp for this call session' }, { status: 400 })
    }

    // Call Meta acceptCall with byte-identical answer_sdp
    try {
      await acceptCall({
        accountId: session.account_id,
        waCallId: session.wa_call_id,
        userSdp: session.answer_sdp,
      })
    } catch (metaErr: unknown) {
      const msg = metaErr instanceof Error ? metaErr.message : 'Meta acceptCall failed'
      console.error('[calls/connected] Meta acceptCall failed:', metaErr)
      await supabaseAdmin()
        .from('call_sessions')
        .update({ status: 'failed', end_reason: msg })
        .eq('id', callSessionId)

      return NextResponse.json({ error: msg }, { status: 502 })
    }

    // Update status to connected
    await supabaseAdmin()
      .from('call_sessions')
      .update({ status: 'connected' })
      .eq('id', callSessionId)

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
