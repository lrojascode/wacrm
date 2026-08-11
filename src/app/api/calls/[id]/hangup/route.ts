import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { rejectCall, terminateCall } from '@/lib/whatsapp/calls-api'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id: callSessionId } = await params
    const body = (await request.json().catch(() => ({}))) as { action?: 'reject' | 'terminate' }

    // Fetch session via service role (supports beacon / unauthenticated sendBeacon)
    const { data: session, error: fetchErr } = await supabaseAdmin()
      .from('call_sessions')
      .select('*')
      .eq('id', callSessionId)
      .maybeSingle()

    if (fetchErr || !session) {
      return NextResponse.json({ error: 'Call session not found' }, { status: 404 })
    }

    const action = body.action || (session.status === 'ringing' ? 'reject' : 'terminate')

    if (action === 'reject' || session.status === 'ringing') {
      try {
        await rejectCall({
          accountId: session.account_id,
          waCallId: session.wa_call_id,
        })
      } catch (metaErr) {
        console.warn('[calls/hangup] Meta rejectCall warning:', metaErr)
      }

      await supabaseAdmin()
        .from('call_sessions')
        .update({
          status: 'rejected',
          end_reason: 'rejected_by_agent',
          ended_at: new Date().toISOString(),
        })
        .eq('id', callSessionId)
    } else {
      try {
        await terminateCall({
          accountId: session.account_id,
          waCallId: session.wa_call_id,
        })
      } catch (metaErr) {
        console.warn('[calls/hangup] Meta terminateCall warning:', metaErr)
      }

      await supabaseAdmin()
        .from('call_sessions')
        .update({
          status: 'ended',
          end_reason: 'hung_up_by_agent',
          ended_at: new Date().toISOString(),
        })
        .eq('id', callSessionId)
    }

    return NextResponse.json({ success: true })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Hangup failed'
    console.error('[calls/hangup] Error in hangup route:', err)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
