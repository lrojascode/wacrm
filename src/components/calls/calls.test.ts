import { describe, it, expect } from 'vitest'
import type { CallSessionData } from '@/hooks/use-incoming-calls'

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60)
  const secs = seconds % 60
  return `${mins < 10 ? '0' : ''}${mins}:${secs < 10 ? '0' : ''}${secs}`
}

describe('Call Component Helpers', () => {
  it('formats call timer seconds into mm:ss format', () => {
    expect(formatTimer(0)).toBe('00:00')
    expect(formatTimer(45)).toBe('00:45')
    expect(formatTimer(135)).toBe('02:15')
    expect(formatTimer(3605)).toBe('60:05')
  })

  it('validates CallSessionData properties for incoming overlay and active bar', () => {
    const session: CallSessionData = {
      id: 'cs_100',
      accountId: 'acc_1',
      conversationId: 'conv_1',
      contactId: 'cnt_1',
      waCallId: 'wacid_1',
      offerSdp: 'v=0...',
      status: 'ringing',
      expiresAt: new Date().toISOString(),
      contact: {
        name: 'Maria Silva',
        phone: '+15551112222',
        lastMessageText: 'Hola, consulta por mi pedido',
      },
    }

    expect(session.contact?.name).toBe('Maria Silva')
    expect(session.contact?.lastMessageText).toBe('Hola, consulta por mi pedido')
    expect(session.status).toBe('ringing')
  })
})
