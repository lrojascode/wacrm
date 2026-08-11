/**
 * WebRTC Peer Connection State Machine for WhatsApp Incoming Calls.
 *
 * Enforces strict 10-step handshake sequence:
 * 1. getUserMedia({audio: true}) -> fail before touching Meta if mic denied
 * 2. new RTCPeerConnection({iceServers})
 * 3. addTrack(...) -> BEFORE createAnswer
 * 4. ontrack -> remote audio stream callback
 * 5. setRemoteDescription(offer)
 * 6. createAnswer() -> setLocalDescription()
 * 7. wait iceGatheringState === 'complete' (timeout 3s)
 * 8. POST /api/calls/[id]/answer -> claim + pre_accept
 * 9. wait connectionState === 'connected'
 * 10. POST /api/calls/[id]/connected -> accept with saved SDP
 */

export type CallPeerState =
  | 'idle'
  | 'requesting_media'
  | 'gathering_ice'
  | 'answering'
  | 'pre_accepted'
  | 'connecting'
  | 'connected'
  | 'ended'
  | 'failed'

export interface CallPeerOptions {
  callSessionId: string
  offerSdp: string
  iceServers?: RTCIceServer[]
  onStateChange?: (state: CallPeerState, error?: string) => void
  onRemoteTrack?: (track: MediaStreamTrack, stream: MediaStream) => void
}

const DEFAULT_ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
]

export class CallPeerSession {
  private callSessionId: string
  private offerSdp: string
  private iceServers: RTCIceServer[]
  private onStateChange?: (state: CallPeerState, error?: string) => void
  private onRemoteTrack?: (track: MediaStreamTrack, stream: MediaStream) => void

  private pc: RTCPeerConnection | null = null
  private localStream: MediaStream | null = null
  private currentState: CallPeerState = 'idle'
  private isMuted = false

  constructor(options: CallPeerOptions) {
    this.callSessionId = options.callSessionId
    this.offerSdp = options.offerSdp
    this.iceServers = options.iceServers || DEFAULT_ICE_SERVERS
    this.onStateChange = options.onStateChange
    this.onRemoteTrack = options.onRemoteTrack
  }

  public getState(): CallPeerState {
    return this.currentState
  }

  private setState(newState: CallPeerState, error?: string) {
    this.currentState = newState
    if (this.onStateChange) {
      this.onStateChange(newState, error)
    }
  }

  /**
   * Start answer flow adhering to 10-step handshake.
   */
  public async answer(): Promise<boolean> {
    try {
      // Step 1: getUserMedia({ audio: true })
      this.setState('requesting_media')
      try {
        this.localStream = await navigator.mediaDevices.getUserMedia({ audio: true })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Microphone access denied'
        console.error('[peer] Microphone access failed:', err)
        this.setState('failed', `Microphone access denied: ${msg}`)
        return false
      }

      // Step 2: new RTCPeerConnection
      this.pc = new RTCPeerConnection({ iceServers: this.iceServers })

      // Step 3: addTrack BEFORE createAnswer
      this.localStream.getTracks().forEach((track) => {
        if (this.pc && this.localStream) {
          this.pc.addTrack(track, this.localStream)
        }
      })

      // Step 4: ontrack remote audio
      this.pc.ontrack = (event) => {
        if (this.onRemoteTrack && event.track) {
          const stream = event.streams[0] || new MediaStream([event.track])
          this.onRemoteTrack(event.track, stream)
        }
      }

      // Monitor connection state
      this.pc.onconnectionstatechange = () => {
        if (!this.pc) return
        const state = this.pc.connectionState
        if (state === 'connected' && this.currentState === 'pre_accepted') {
          void this.onConnectedStateReached()
        } else if (state === 'failed' || state === 'closed') {
          if (this.currentState !== 'ended' && this.currentState !== 'failed') {
            this.setState('failed', 'WebRTC connection failed')
          }
        }
      }

      // Step 5: setRemoteDescription(offer)
      await this.pc.setRemoteDescription(
        new RTCSessionDescription({ type: 'offer', sdp: this.offerSdp })
      )

      // Step 6: createAnswer() -> setLocalDescription()
      this.setState('gathering_ice')
      const answer = await this.pc.createAnswer()
      await this.pc.setLocalDescription(answer)

      // Step 7: Wait for iceGatheringState === 'complete' (timeout 3s)
      await this.waitForIceGathering(3000)

      const localSdp = this.pc.localDescription?.sdp
      if (!localSdp) {
        throw new Error('Failed to generate local SDP answer')
      }

      // Step 8: POST /api/calls/[id]/answer (claim + pre_accept)
      this.setState('answering')
      const answerRes = await fetch(`/api/calls/${this.callSessionId}/answer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userSdp: localSdp }),
      })

      if (answerRes.status === 409) {
        // Claimed by another agent
        console.log('[peer] Call already claimed by another agent')
        this.cleanup()
        this.setState('ended', 'Claimed by another agent')
        return false
      }

      if (!answerRes.ok) {
        const errJson = await answerRes.json().catch(() => ({}))
        throw new Error(errJson.error || `Answer route failed (${answerRes.status})`)
      }

      // Step 9: State pre_accepted, wait for connectionState === 'connected'
      this.setState('pre_accepted')

      // If connection state already connected, complete step 10 immediately
      if (this.pc.connectionState === 'connected') {
        await this.onConnectedStateReached()
      }

      return true
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Call answer error'
      console.error('[peer] Error during call answer flow:', err)
      this.cleanup()
      this.setState('failed', msg)
      return false
    }
  }

  /**
   * Step 10: Called when connectionState === 'connected' to send accept with saved SDP.
   */
  private async onConnectedStateReached(): Promise<void> {
    if (this.currentState === 'connected') return

    try {
      this.setState('connecting')
      const connectedRes = await fetch(`/api/calls/${this.callSessionId}/connected`, {
        method: 'POST',
      })

      if (!connectedRes.ok) {
        const errJson = await connectedRes.json().catch(() => ({}))
        throw new Error(errJson.error || `Connected route failed (${connectedRes.status})`)
      }

      this.setState('connected')
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Connected route error'
      console.error('[peer] Failed to notify connected endpoint:', err)
      this.setState('failed', msg)
    }
  }

  /**
   * Helper to wait for ICE gathering completion or timeout.
   */
  private waitForIceGathering(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      if (!this.pc || this.pc.iceGatheringState === 'complete') {
        resolve()
        return
      }

      let timeoutId: number | null = null

      const checkState = () => {
        if (this.pc && this.pc.iceGatheringState === 'complete') {
          if (timeoutId !== null) window.clearTimeout(timeoutId)
          if (this.pc) this.pc.onicegatheringstatechange = null
          resolve()
        }
      }

      if (this.pc) {
        this.pc.onicegatheringstatechange = checkState
      }

      timeoutId = window.setTimeout(() => {
        if (this.pc) this.pc.onicegatheringstatechange = null
        resolve()
      }, timeoutMs)
    })
  }

  /**
   * Mute or unmute local audio tracks.
   */
  public toggleMute(muted?: boolean): boolean {
    this.isMuted = muted !== undefined ? muted : !this.isMuted
    if (this.localStream) {
      this.localStream.getAudioTracks().forEach((track) => {
        track.enabled = !this.isMuted
      })
    }
    return this.isMuted
  }

  public getIsMuted(): boolean {
    return this.isMuted
  }

  /**
   * Hangup call and cleanup resources.
   */
  public hangup(): void {
    if (this.currentState === 'ended') return

    // Fire and forget hangup beacon/request
    if (typeof window !== 'undefined' && window.navigator?.sendBeacon) {
      try {
        window.navigator.sendBeacon(`/api/calls/${this.callSessionId}/hangup`, JSON.stringify({}))
      } catch {
        void fetch(`/api/calls/${this.callSessionId}/hangup`, { method: 'POST' })
      }
    } else {
      void fetch(`/api/calls/${this.callSessionId}/hangup`, { method: 'POST' })
    }

    this.cleanup()
    this.setState('ended')
  }

  /**
   * Cleanup RTCPeerConnection and local media streams.
   */
  public cleanup(): void {
    if (this.localStream) {
      this.localStream.getTracks().forEach((track) => track.stop())
      this.localStream = null
    }

    if (this.pc) {
      this.pc.onconnectionstatechange = null
      this.pc.onicegatheringstatechange = null
      this.pc.ontrack = null
      this.pc.close()
      this.pc = null
    }
  }
}
