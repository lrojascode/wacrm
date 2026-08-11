import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@/types'
import { buildReplyPreview } from './reply-quote'

describe('Call Timeline Chip & Reply Preview', () => {
  it('builds reply preview for call content type', () => {
    const mockT = vi.fn().mockImplementation((key: string) => {
      if (key === 'call') return '[Llamada]'
      return key
    })

    const callMessage: Message = {
      id: 'msg_1',
      conversation_id: 'conv_1',
      sender_type: 'customer',
      content_type: 'call',
      status: 'delivered',
      created_at: new Date().toISOString(),
      call_outcome: 'missed',
    }

    const preview = buildReplyPreview(callMessage, mockT as unknown as Parameters<typeof buildReplyPreview>[1])
    expect(preview).toBe('[Llamada]')
    expect(mockT).toHaveBeenCalledWith('call')
  })
})
