import { describe, it, expect, vi, beforeEach } from 'vitest'
import { CallPeerSession } from './peer'

describe('CallPeerSession WebRTC Core', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    global.fetch = vi.fn()
  })

  it('fails early at Step 1 if getUserMedia is denied without calling Meta answer route', async () => {
    const mockGetUserMedia = vi.fn().mockRejectedValue(new Error('Permission denied'))
    Object.defineProperty(global, 'navigator', {
      value: { mediaDevices: { getUserMedia: mockGetUserMedia } },
      configurable: true,
      writable: true,
    })

    const onStateChange = vi.fn()
    const session = new CallPeerSession({
      callSessionId: 'cs_100',
      offerSdp: 'v=0...',
      onStateChange,
    })

    const result = await session.answer()
    expect(result).toBe(false)
    expect(mockGetUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(global.fetch).not.toHaveBeenCalled()
    expect(session.getState()).toBe('failed')
  })

  it('executes 10-step handshake sequence on success', async () => {
    const mockStop = vi.fn()
    const mockTrack = { stop: mockStop, enabled: true } as unknown as MediaStreamTrack
    const mockStream = {
      getTracks: () => [mockTrack],
      getAudioTracks: () => [mockTrack],
    } as unknown as MediaStream

    const mockGetUserMedia = vi.fn().mockResolvedValue(mockStream)
    Object.defineProperty(global, 'navigator', {
      value: { mediaDevices: { getUserMedia: mockGetUserMedia }, sendBeacon: vi.fn() },
      configurable: true,
      writable: true,
    })

    class MockRTCPeerConnection {
      iceGatheringState = 'complete'
      connectionState = 'connected'
      localDescription = { sdp: 'v=0...local_sdp' }
      onconnectionstatechange: (() => void) | null = null
      onicegatheringstatechange: (() => void) | null = null
      ontrack: ((event: unknown) => void) | null = null

      addTrack = vi.fn()
      setRemoteDescription = vi.fn().mockResolvedValue(undefined)
      createAnswer = vi.fn().mockResolvedValue({ type: 'answer', sdp: 'v=0...local_sdp' })
      setLocalDescription = vi.fn().mockResolvedValue(undefined)
      close = vi.fn()
    }

    Object.defineProperty(global, 'RTCPeerConnection', {
      value: MockRTCPeerConnection,
      configurable: true,
      writable: true,
    })

    Object.defineProperty(global, 'RTCSessionDescription', {
      value: class {
        constructor(public init: unknown) {}
      },
      configurable: true,
      writable: true,
    })

    vi.mocked(global.fetch).mockImplementation(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : input.toString()
      if (url.includes('/answer')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response
      }
      if (url.includes('/connected')) {
        return { ok: true, status: 200, json: async () => ({ success: true }) } as Response
      }
      return { ok: false, status: 404 } as Response
    })

    const stateHistory: string[] = []
    const session = new CallPeerSession({
      callSessionId: 'cs_100',
      offerSdp: 'v=0...remote_sdp',
      onStateChange: (state) => stateHistory.push(state),
    })

    const result = await session.answer()
    expect(result).toBe(true)

    expect(stateHistory).toContain('requesting_media')
    expect(stateHistory).toContain('gathering_ice')
    expect(stateHistory).toContain('answering')
    expect(stateHistory).toContain('pre_accepted')
  })
})
