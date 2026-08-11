/**
 * Handlers for Meta's WhatsApp incoming call webhook events.
 *
 * Incoming calls arrive when Meta delivers a change entry with field 'calls'.
 * Events include:
 *   - 'connect' / 'offer' — Customer initiated a call. Creates or updates
 *     a live call_sessions row for ringing without touching messages.
 *   - 'terminate' — Call ended (accepted, missed, or rejected). Updates the
 *     call_sessions row and inserts a single terminal row into `messages`
 *     (content_type = 'call').
 */

import { supabaseAdmin } from '@/lib/flows/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { isUniqueViolation } from '@/lib/contacts/dedupe'

export function isCallsWebhookField(field: string): boolean {
  return field === 'calls'
}

export interface WhatsAppCallContact {
  profile?: { name?: string }
  wa_id?: string
}

export interface WhatsAppCall {
  id?: string
  call_id?: string
  event: 'connect' | 'terminate' | 'offer' | string
  from: string
  to?: string
  timestamp?: string | number
  sdp?: string
  reason?: string
  status?: string
  start_time?: string | number
  end_time?: string | number
  duration?: number
  contacts?: WhatsAppCallContact[]
}

export interface HandleCallsWebhookOptions {
  phoneNumberId: string
  calls: WhatsAppCall[]
  contacts?: WhatsAppCallContact[]
}

function formatCallDuration(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins}:${secs < 10 ? '0' : ''}${secs}`
}

export async function handleCallsWebhookChange(options: HandleCallsWebhookOptions): Promise<void> {
  const { phoneNumberId, calls, contacts } = options

  if (!calls || calls.length === 0) return

  // 1. Fetch account's whatsapp_config
  const { data: config, error: configError } = await supabaseAdmin()
    .from('whatsapp_config')
    .select('id, account_id, user_id')
    .eq('phone_number_id', phoneNumberId)
    .maybeSingle()

  if (configError || !config) {
    console.error('[call-webhook] No whatsapp_config found for phone_number_id:', phoneNumberId, configError)
    return
  }

  const accountId = config.account_id

  for (const call of calls) {
    const waCallId = call.call_id || call.id
    if (!waCallId) {
      console.warn('[call-webhook] Skipping call event missing call_id/id:', call)
      continue
    }

    const fromPhone = call.from || call.contacts?.[0]?.wa_id || contacts?.[0]?.wa_id
    if (!fromPhone) {
      console.warn('[call-webhook] Skipping call event missing customer phone number:', call)
      continue
    }

    const contactName =
      call.contacts?.[0]?.profile?.name ||
      contacts?.[0]?.profile?.name ||
      undefined

    // 2. Resolve contact + conversation
    let conversationId: string | null = null
    let contactId: string | null = null

    try {
      const resolved = await resolveConversationByPhone(
        supabaseAdmin(),
        accountId,
        fromPhone,
        contactName
      )
      conversationId = resolved.conversationId
      contactId = resolved.contactId
    } catch (err) {
      console.error('[call-webhook] Failed to resolve conversation for phone:', fromPhone, err)
    }

    // 3. Determine ring_user_ids (assigned agent or all team members)
    let ringUserIds: string[] = []
    if (conversationId) {
      const { data: conv } = await supabaseAdmin()
        .from('conversations')
        .select('assigned_agent_id')
        .eq('id', conversationId)
        .maybeSingle()

      if (conv?.assigned_agent_id) {
        ringUserIds = [conv.assigned_agent_id]
      }
    }

    if (ringUserIds.length === 0) {
      const { data: members } = await supabaseAdmin()
        .from('account_members')
        .select('user_id')
        .eq('account_id', accountId)

      if (members && members.length > 0) {
        ringUserIds = members.map((m: { user_id: string }) => m.user_id)
      }

      const { data: acc } = await supabaseAdmin()
        .from('accounts')
        .select('owner_user_id')
        .eq('id', accountId)
        .maybeSingle()

      if (acc?.owner_user_id && !ringUserIds.includes(acc.owner_user_id)) {
        ringUserIds.push(acc.owner_user_id)
      }
    }

    const eventName = call.event?.toLowerCase()

    if (eventName === 'connect' || eventName === 'offer') {
      // 4. Handle incoming call offer / connect
      const expiresAt = new Date(Date.now() + 45000).toISOString()

      const { error: upsertErr } = await supabaseAdmin()
        .from('call_sessions')
        .upsert(
          {
            account_id: accountId,
            conversation_id: conversationId,
            contact_id: contactId,
            wa_call_id: waCallId,
            direction: 'USER_INITIATED',
            offer_sdp: call.sdp || '',
            ring_user_ids: ringUserIds,
            status: 'ringing',
            expires_at: expiresAt,
          },
          { onConflict: 'wa_call_id' }
        )

      if (upsertErr) {
        console.error('[call-webhook] Error upserting call_sessions row:', upsertErr)
      }
    } else if (eventName === 'terminate') {
      // 5. Handle call termination
      const rawReason = (call.reason || call.status || '').toLowerCase()
      const duration = typeof call.duration === 'number' ? call.duration : 0

      let outcome: 'accepted' | 'missed' | 'rejected' | 'failed' = 'missed'
      if (rawReason.includes('accepted') || rawReason.includes('completed')) {
        outcome = 'accepted'
      } else if (rawReason.includes('rejected') || rawReason.includes('declined')) {
        outcome = 'rejected'
      } else if (rawReason.includes('missed')) {
        outcome = 'missed'
      } else if (duration > 0) {
        outcome = 'accepted'
      }

      // 5a. Update call_sessions row if exists
      const { error: sessionUpdateErr } = await supabaseAdmin()
        .from('call_sessions')
        .update({
          status: outcome === 'accepted' ? 'ended' : outcome === 'rejected' ? 'rejected' : 'ended',
          end_reason: call.reason || call.status || outcome,
          duration_seconds: duration,
          ended_at: new Date().toISOString(),
        })
        .eq('wa_call_id', waCallId)

      if (sessionUpdateErr) {
        console.error('[call-webhook] Error updating call_sessions on terminate:', sessionUpdateErr)
      }

      // 5b. Insert terminal message into `messages`
      if (conversationId) {
        let contentText = 'Llamada'
        if (outcome === 'missed') contentText = 'Llamada perdida'
        else if (outcome === 'rejected') contentText = 'Llamada rechazada'
        else if (outcome === 'accepted') contentText = `Llamada · ${formatCallDuration(duration)}`

        const { error: msgInsertErr } = await supabaseAdmin()
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_type: 'customer',
            content_type: 'call',
            content_text: contentText,
            call_outcome: outcome,
            call_duration_seconds: duration,
            message_id: waCallId,
            status: 'delivered',
          })

        if (msgInsertErr) {
          if (isUniqueViolation(msgInsertErr)) {
            console.log('[call-webhook] Terminal call message already inserted for waCallId:', waCallId)
          } else {
            console.error('[call-webhook] Error inserting terminal call message:', msgInsertErr)
          }
        } else {
          // 5c. Atomic update for conversation unread_count & preview
          const incrementUnread = outcome === 'missed'
          const { error: rpcErr } = await supabaseAdmin().rpc('update_conversation_last_message', {
            p_conversation_id: conversationId,
            p_last_message_text: contentText,
            p_last_message_at: new Date().toISOString(),
            p_increment_unread: incrementUnread,
          })

          if (rpcErr) {
            console.error('[call-webhook] Error executing update_conversation_last_message RPC:', rpcErr)
          }
        }
      }
    }
  }
}
