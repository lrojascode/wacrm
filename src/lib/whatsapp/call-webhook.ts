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

import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import { derivePresence, type StoredPresence } from '@/lib/presence'
import type { AccountRole } from '@/lib/auth/roles'

export function isCallsWebhookField(field: string): boolean {
  return field === 'calls'
}

export interface WhatsAppCallContact {
  profile?: { name?: string }
  wa_id?: string
}

export interface WhatsAppCall {
  id?: string
  from?: string
  session_id?: string
  event?: string
  reason?: string
  status?: string
  duration?: number | string
  sdp?: string
}

export interface WhatsAppCallsWebhookChange {
  field: 'calls'
  value: {
    messaging_product: 'whatsapp'
    metadata: {
      display_phone_number?: string
      phone_number_id: string
    }
    contacts?: WhatsAppCallContact[]
    calls?: WhatsAppCall[]
  }
}


function isUserConnected(
  userId: string,
  presenceMap: Map<string, { status: StoredPresence; last_seen_at: string }>,
  now: number = Date.now()
): boolean {
  const row = presenceMap.get(userId)
  if (!row) return false
  return derivePresence(row.status, row.last_seen_at, now) !== 'offline'
}

export async function handleCallsWebhookChange(
  accountId: string,
  change: WhatsAppCallsWebhookChange
): Promise<void> {
  const calls = change.value.calls || []
  if (calls.length === 0) return

  const contact = change.value.contacts?.[0]
  const contactName = contact?.profile?.name

  for (const call of calls) {
    const waCallId = call.id || call.session_id
    if (!waCallId) continue

    const fromPhone = call.from || contact?.wa_id
    if (!fromPhone) {
      console.warn('[call-webhook] Skipping call missing from phone number:', call)
      continue
    }

    // 1. Resolve or create conversation & contact
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

    // 2. Fetch presence rows for account members
    const { data: presenceRows, error: presenceErr } = await supabaseAdmin()
      .from('member_presence')
      .select('user_id, status, last_seen_at')
      .eq('account_id', accountId)

    if (presenceErr) {
      console.error('[call-webhook] Error fetching member_presence:', presenceErr)
    }

    const presenceMap = new Map<string, { status: StoredPresence; last_seen_at: string }>()
    if (presenceRows) {
      for (const p of presenceRows) {
        presenceMap.set(p.user_id, {
          status: p.status as StoredPresence,
          last_seen_at: p.last_seen_at,
        })
      }
    }

    const now = Date.now()

    // 3. Determine ring_user_ids (presence-aware)
    let assignedAgentId: string | null = null
    if (conversationId) {
      const { data: conv, error: convErr } = await supabaseAdmin()
        .from('conversations')
        .select('assigned_agent_id')
        .eq('id', conversationId)
        .maybeSingle()

      if (convErr) {
        console.error('[call-webhook] Error fetching conversation assigned_agent_id:', convErr)
      } else if (conv?.assigned_agent_id) {
        assignedAgentId = conv.assigned_agent_id
      }
    }

    let ringUserIds: string[] = []

    if (assignedAgentId && isUserConnected(assignedAgentId, presenceMap, now)) {
      // Assigned agent is connected -> ring assigned agent only
      ringUserIds = [assignedAgentId]
    } else {
      // Assigned agent is disconnected or null -> ring all connected agent+ members from profiles
      const { data: profiles, error: profErr } = await supabaseAdmin()
        .from('profiles')
        .select('user_id, account_role')
        .eq('account_id', accountId)

      if (profErr) {
        console.error('[call-webhook] Error fetching profiles for account:', profErr)
      } else if (profiles) {
        const connectedAgents = profiles
          .filter((p) => {
            const role = p.account_role as AccountRole
            const isAgentOrHigher = role === 'agent' || role === 'admin' || role === 'owner'
            return isAgentOrHigher && isUserConnected(p.user_id, presenceMap, now)
          })
          .map((p) => p.user_id)

        ringUserIds = connectedAgents
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
        console.error('[call-webhook] Error upserting call_sessions:', upsertErr)
      } else {
        console.log(`[call-webhook] Call session ringing created for waCallId=${waCallId}, ringUserIds=${ringUserIds.join(',')}`)
      }
    } else if (eventName === 'terminate' || eventName === 'end' || eventName === 'rejected') {
      // 5. Handle call termination
      const duration = typeof call.duration === 'number'
        ? call.duration
        : typeof call.duration === 'string'
        ? parseInt(call.duration, 10) || 0
        : 0

      let outcome: 'accepted' | 'missed' | 'rejected' | 'failed' = 'failed'
      if (call.reason === 'rejected' || call.status === 'rejected') {
        outcome = 'rejected'
      } else if (call.reason === 'timeout' || call.reason === 'user_busy' || duration === 0) {
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

      // 5b. Insert terminal message into `messages` with content_text = NULL
      if (conversationId) {
        const lastMessageToken = outcome === 'accepted'
          ? `[call:accepted:${duration}]`
          : `[call:${outcome}]`

        const { error: msgInsertErr } = await supabaseAdmin()
          .from('messages')
          .insert({
            conversation_id: conversationId,
            sender_type: 'customer',
            content_type: 'call',
            content_text: null,
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
          // 5c. Atomic update for conversation unread_count & last_message_text (neutral token)
          const incrementUnread = outcome === 'missed'
          const { error: rpcErr } = await supabaseAdmin().rpc('update_conversation_last_message', {
            p_conversation_id: conversationId,
            p_last_message_text: lastMessageToken,
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
