import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isCallsWebhookField,
  handleCallsWebhookChange,
  type WhatsAppCall,
} from './call-webhook'

// Mock admin-client and resolve-conversation
vi.mock('@/lib/whatsapp/admin-client', () => ({
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(),
}))

import { supabaseAdmin } from '@/lib/whatsapp/admin-client'
import { resolveConversationByPhone } from '@/lib/whatsapp/resolve-conversation'

describe('call-webhook', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('identifies calls webhook field', () => {
    expect(isCallsWebhookField('calls')).toBe(true)
    expect(isCallsWebhookField('messages')).toBe(false)
    expect(isCallsWebhookField('statuses')).toBe(false)
  })

  it('handles connect event with presence-aware ring_user_ids', async () => {
    const mockUpsert = vi.fn().mockResolvedValue({ data: { id: 'cs_1' }, error: null })

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { assigned_agent_id: 'agent_online' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'member_presence') {
        return {
          select: () => ({
            eq: async () => ({
              data: [
                { user_id: 'agent_online', status: 'online', last_seen_at: new Date().toISOString() },
                { user_id: 'agent_offline', status: 'offline', last_seen_at: new Date(Date.now() - 200000).toISOString() },
              ],
              error: null,
            }),
          }),
        }
      }
      if (table === 'call_sessions') {
        return {
          upsert: mockUpsert,
        }
      }
      return {}
    })

    vi.mocked(supabaseAdmin).mockReturnValue({
      from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
    } as unknown as ReturnType<typeof supabaseAdmin>)

    vi.mocked(resolveConversationByPhone).mockResolvedValue({
      conversationId: 'conv_123',
      contactId: 'cnt_456',
      contactCreated: false,
    })

    const calls: WhatsAppCall[] = [
      {
        id: 'wacid_001',
        event: 'connect',
        from: '+14155552671',
        sdp: 'v=0...',
      },
    ]

    await handleCallsWebhookChange('acc_100', {
      field: 'calls',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'pn_1' },
        calls,
      },
    })

    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acc_100',
      '+14155552671',
      undefined
    )

    expect(mockUpsert).toHaveBeenCalledWith(
      expect.objectContaining({
        account_id: 'acc_100',
        ring_user_ids: ['agent_online'],
        status: 'ringing',
      }),
      { onConflict: 'wa_call_id' }
    )
  })

  it('handles terminate event by updating call_sessions and inserting message with null content_text', async () => {
    const mockUpsertMessage = vi.fn().mockResolvedValue({ data: { id: 'msg_777' }, error: null })
    const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null })

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { assigned_agent_id: null },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'member_presence') {
        return {
          select: () => ({
            eq: async () => ({
              data: [],
              error: null,
            }),
          }),
        }
      }
      if (table === 'profiles') {
        return {
          select: () => ({
            eq: async () => ({
              data: [{ user_id: 'usr_1', account_role: 'agent' }],
              error: null,
            }),
          }),
        }
      }
      if (table === 'call_sessions') {
        return {
          update: () => ({
            eq: async () => ({ data: null, error: null }),
          }),
        }
      }
      if (table === 'messages') {
        return {
          insert: mockUpsertMessage,
        }
      }
      return {}
    })

    vi.mocked(supabaseAdmin).mockReturnValue({
      from: mockFrom as unknown as ReturnType<typeof supabaseAdmin>['from'],
      rpc: mockRpc,
    } as unknown as ReturnType<typeof supabaseAdmin>)

    vi.mocked(resolveConversationByPhone).mockResolvedValue({
      conversationId: 'conv_123',
      contactId: 'cnt_456',
      contactCreated: false,
    })

    const calls: WhatsAppCall[] = [
      {
        id: 'wacid_001',
        event: 'terminate',
        from: '+14155552671',
        reason: 'missed',
        duration: 0,
      },
    ]

    await handleCallsWebhookChange('acc_100', {
      field: 'calls',
      value: {
        messaging_product: 'whatsapp',
        metadata: { phone_number_id: 'pn_1' },
        calls,
      },
    })

    expect(mockUpsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv_123',
        sender_type: 'customer',
        content_type: 'call',
        content_text: null,
        call_outcome: 'missed',
        message_id: 'wacid_001',
      })
    )

    expect(mockRpc).toHaveBeenCalledWith('update_conversation_last_message', {
      p_conversation_id: 'conv_123',
      p_last_message_text: '[call:missed]',
      p_last_message_at: expect.any(String),
      p_increment_unread: true,
    })
  })
})
