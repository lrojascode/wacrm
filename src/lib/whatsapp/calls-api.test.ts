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

  it('queries getCallSettings on the /settings edge and parses the calling block', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calling: {
          status: 'ENABLED',
          call_icon_visibility: 'DEFAULT',
          callback_permission_status: 'DISABLED',
        },
      }),
    })
    global.fetch = fetchMock

    const res = await getCallSettings({
      phoneNumberId: '12345',
      accessToken: 'test_token',
    })

    expect(res).toEqual({
      status: 'ENABLED',
      callIconVisibility: 'DEFAULT',
      callbackPermissionStatus: 'DISABLED',
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://graph.facebook.com/v23.0/12345/settings',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({
          Authorization: 'Bearer test_token',
        }),
      })
    )
  })

  it('passes NOT_SET through instead of flattening it to DISABLED', async () => {
    // Exactly what a real, never-configured number returned. NOT_SET is
    // not DISABLED: nobody turned Calling off, it was never set up. The
    // previous union omitted this value, so the runtime result escaped
    // its own declared type.
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        calling: {
          status: 'NOT_SET',
          call_icon_visibility: 'NOT_SET',
          callback_permission_status: 'NOT_SET',
        },
        storage_configuration: { status: 'DEFAULT' },
      }),
    })

    const res = await getCallSettings({ phoneNumberId: '12345', accessToken: 't' })

    expect(res).toEqual({
      status: 'NOT_SET',
      callIconVisibility: 'NOT_SET',
      callbackPermissionStatus: 'NOT_SET',
    })
  })

  it('reports NOT_SET when the calling block is absent entirely', async () => {
    // No `calling` key at all is the same situation as NOT_SET.
    global.fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) })

    const res = await getCallSettings({ phoneNumberId: '12345', accessToken: 't' })

    expect(res).toEqual({
      status: 'NOT_SET',
      callIconVisibility: null,
      callbackPermissionStatus: null,
    })
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
