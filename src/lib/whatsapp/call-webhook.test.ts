import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  isCallsWebhookField,
  handleCallsWebhookChange,
  type WhatsAppCall,
} from './call-webhook'

// Mock admin-client and resolve-conversation
vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: vi.fn(),
}))

vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: vi.fn(),
}))

import { supabaseAdmin } from '@/lib/flows/admin-client'
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

  it('handles connect event by upserting call_sessions', async () => {
    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'cfg_1', account_id: 'acc_100', user_id: 'usr_owner' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'conversations') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { assigned_agent_id: 'agent_42' },
                error: null,
              }),
            }),
          }),
        }
      }
      if (table === 'call_sessions') {
        return {
          upsert: vi.fn().mockResolvedValue({ data: { id: 'cs_1' }, error: null }),
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
        sdp: 'v=0\r\no=- 12345 2 IN IP4 127.0.0.1...',
        contacts: [{ profile: { name: 'Alice' }, wa_id: '14155552671' }],
      },
    ]

    await handleCallsWebhookChange({
      phoneNumberId: 'phone_999',
      calls,
    })

    expect(resolveConversationByPhone).toHaveBeenCalledWith(
      expect.anything(),
      'acc_100',
      '+14155552671',
      'Alice'
    )

    expect(mockFrom).toHaveBeenCalledWith('call_sessions')
  })

  it('handles terminate event by updating call_sessions and inserting message', async () => {
    const mockUpsertMessage = vi.fn().mockResolvedValue({ data: { id: 'msg_777' }, error: null })
    const mockRpc = vi.fn().mockResolvedValue({ data: null, error: null })

    const mockFrom = vi.fn().mockImplementation((table: string) => {
      if (table === 'whatsapp_config') {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: { id: 'cfg_1', account_id: 'acc_100', user_id: 'usr_owner' },
                error: null,
              }),
            }),
          }),
        }
      }
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
      if (table === 'account_members') {
        return {
          select: () => ({
            eq: async () => ({
              data: [{ user_id: 'usr_1' }, { user_id: 'usr_2' }],
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

    await handleCallsWebhookChange({
      phoneNumberId: 'phone_999',
      calls,
    })

    expect(mockUpsertMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation_id: 'conv_123',
        sender_type: 'customer',
        content_type: 'call',
        content_text: 'Llamada perdida',
        call_outcome: 'missed',
        message_id: 'wacid_001',
      })
    )

    expect(mockRpc).toHaveBeenCalledWith('update_conversation_last_message', {
      p_conversation_id: 'conv_123',
      p_last_message_text: 'Llamada perdida',
      p_last_message_at: expect.any(String),
      p_increment_unread: true,
    })
  })
})
