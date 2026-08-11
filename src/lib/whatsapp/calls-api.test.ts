import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  preAcceptCall,
  acceptCall,
  rejectCall,
  terminateCall,
  getCallSettings,
  META_CALLS_API_VERSION,
} from './calls-api'

describe('calls-api', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('uses META_CALLS_API_VERSION v23.0', () => {
    expect(META_CALLS_API_VERSION).toBe('v23.0')
  })

  it('sends pre_accept request with SDP payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    global.fetch = fetchMock

    const res = await preAcceptCall({
      phoneNumberId: '12345',
      accessToken: 'test_token',
      waCallId: 'call_999',
      userSdp: 'v=0...',
    })

    expect(res).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345/calls',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer test_token',
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          call_id: 'call_999',
          action: 'pre_accept',
          sdp: 'v=0...',
        }),
      })
    )
  })

  it('sends accept request with SDP payload', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    global.fetch = fetchMock

    const res = await acceptCall({
      phoneNumberId: '12345',
      accessToken: 'test_token',
      waCallId: 'call_999',
      userSdp: 'v=0...',
    })

    expect(res).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345/calls',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          call_id: 'call_999',
          action: 'accept',
          sdp: 'v=0...',
        }),
      })
    )
  })

  it('sends reject request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    global.fetch = fetchMock

    const res = await rejectCall({
      phoneNumberId: '12345',
      accessToken: 'test_token',
      waCallId: 'call_999',
    })

    expect(res).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345/calls',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          call_id: 'call_999',
          action: 'reject',
        }),
      })
    )
  })

  it('sends terminate request', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ success: true }),
    })
    global.fetch = fetchMock

    const res = await terminateCall({
      phoneNumberId: '12345',
      accessToken: 'test_token',
      waCallId: 'call_999',
    })

    expect(res).toEqual({ success: true })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345/calls',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          call_id: 'call_999',
          action: 'terminate',
        }),
      })
    )
  })

  it('queries getCallSettings and parses calling status', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ calling: { status: 'ENABLED' } }),
    })
    global.fetch = fetchMock

    const res = await getCallSettings({
      phoneNumberId: '12345',
      accessToken: 'test_token',
    })

    expect(res).toEqual({ status: 'ENABLED' })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345?fields=calling',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test_token',
        }),
      })
    )
  })

  it('throws error message from Meta error response when fetch fails', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      json: async () => ({ error: { message: 'Invalid call_id' } }),
    })
    global.fetch = fetchMock

    await expect(
      rejectCall({
        phoneNumberId: '12345',
        accessToken: 'test_token',
        waCallId: 'invalid_id',
      })
    ).rejects.toThrow('Invalid call_id')
  })
})
