import { useEffect, useState, useCallback, useRef } from 'react'
import { createClient } from '@/lib/supabase/client'
import { useAuth } from '@/hooks/use-auth'
import { CallPeerSession, type CallPeerState } from '@/lib/calls/peer'
import { startRingtone, stopRingtone, registerAudioUnlockListener } from '@/lib/calls/ringtone'

export interface CallContactContext {
  id?: string
  name?: string
  phone?: string
  avatarUrl?: string | null
  lastMessageText?: string | null
}

export interface CallSessionData {
  id: string
  accountId: string
  conversationId: string | null
  contactId: string | null
  waCallId: string
  offerSdp: string
  status: 'ringing' | 'claimed' | 'connected' | 'ended' | 'rejected' | 'failed'
  expiresAt: string
  contact?: CallContactContext
}

export function useIncomingCalls() {
  const { user, account } = useAuth()
  const [incomingSession, setIncomingSession] = useState<CallSessionData | null>(null)
  const [activeSession, setActiveSession] = useState<CallSessionData | null>(null)
  const [peerState, setPeerState] = useState<CallPeerState>('idle')
  const [isMuted, setIsMuted] = useState(false)
  const [callDuration, setCallDuration] = useState(0)

  const peerRef = useRef<CallPeerSession | null>(null)
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null)

  // Attach persistent hidden audio element for remote WebRTC track
  useEffect(() => {
    if (typeof document !== 'undefined' && !remoteAudioRef.current) {
      const audio = document.createElement('audio')
      audio.autoplay = true
      audio.style.display = 'none'
      document.body.appendChild(audio)
      remoteAudioRef.current = audio
    }

    return () => {
      if (remoteAudioRef.current && remoteAudioRef.current.parentNode) {
        remoteAudioRef.current.parentNode.removeChild(remoteAudioRef.current)
        remoteAudioRef.current = null
      }
    }
  }, [])

  // Audio unlock listener
  useEffect(() => {
    const cleanup = registerAudioUnlockListener()
    return cleanup
  }, [])

  // Fetch contact & conversation context line when ringing call arrives
  const loadCallContext = useCallback(async (session: CallSessionData): Promise<CallSessionData> => {
    const supabase = createClient()
    let contact: CallContactContext = {}

    if (session.contactId) {
      const { data: cnt } = await supabase
        .from('contacts')
        .select('id, name, phone, avatar_url')
        .eq('id', session.contactId)
        .maybeSingle()

      if (cnt) {
        contact = {
          id: cnt.id,
          name: cnt.name || cnt.phone,
          phone: cnt.phone,
          avatarUrl: cnt.avatar_url,
        }
      }
    }

    if (session.conversationId) {
      const { data: conv } = await supabase
        .from('conversations')
        .select('last_message_text')
        .eq('id', session.conversationId)
        .maybeSingle()

      if (conv?.last_message_text) {
        contact.lastMessageText = conv.last_message_text
      }
    }

    return { ...session, contact }
  }, [])

  // Realtime subscription to `call_sessions`
  useEffect(() => {
    if (!user || !account?.id) return

    const supabase = createClient()

    const channel = supabase
      .channel(`call_sessions:${account.id}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'call_sessions',
          filter: `account_id=eq.${account.id}`,
        },
        async (payload) => {
          const row = payload.new as Record<string, unknown> | null
          if (!row || !row.id || typeof row.id !== 'string') return

          const ringUserIds: string[] = (row.ring_user_ids as string[]) || []
          const isTargetUser =
            ringUserIds.length === 0 ||
            ringUserIds.includes(user.id) ||
            row.answered_by === user.id

          if (!isTargetUser) return

          const sessionData: CallSessionData = {
            id: row.id,
            accountId: row.account_id as string,
            conversationId: (row.conversation_id as string) || null,
            contactId: (row.contact_id as string) || null,
            waCallId: row.wa_call_id as string,
            offerSdp: row.offer_sdp as string,
            status: row.status as CallSessionData['status'],
            expiresAt: row.expires_at as string,
          }

          if (row.status === 'ringing') {
            const enriched = await loadCallContext(sessionData)
            setIncomingSession(enriched)
            startRingtone()
          } else if (row.status === 'claimed') {
            if (row.answered_by !== user.id) {
              // Another agent claimed the call
              stopRingtone()
              setIncomingSession(null)
            }
          } else if (row.status === 'ended' || row.status === 'rejected' || row.status === 'failed') {
            stopRingtone()
            setIncomingSession(null)
            if (activeSession?.id === row.id) {
              setActiveSession(null)
              if (peerRef.current) {
                peerRef.current.cleanup()
                peerRef.current = null
              }
            }
          }
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [user, account?.id, loadCallContext, activeSession?.id])

  // Duration timer for active call
  useEffect(() => {
    if (!activeSession || peerState !== 'connected') {
      return
    }

    const interval = window.setInterval(() => {
      setCallDuration((prev) => prev + 1)
    }, 1000)

    return () => {
      window.clearInterval(interval)
    }
  }, [activeSession, peerState])

  // Answer call action
  const answerCall = useCallback(async () => {
    if (!incomingSession) return

    stopRingtone()
    const targetSession = incomingSession
    setIncomingSession(null)
    setActiveSession(targetSession)
    setCallDuration(0)

    const peer = new CallPeerSession({
      callSessionId: targetSession.id,
      offerSdp: targetSession.offerSdp,
      onStateChange: (state) => {
        setPeerState(state)
        if (state === 'ended' || state === 'failed') {
          setActiveSession(null)
        }
      },
      onRemoteTrack: (track, stream) => {
        if (remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = stream
          remoteAudioRef.current.play().catch(() => {})
        }
      },
    })

    peerRef.current = peer
    const success = await peer.answer()
    if (!success) {
      setActiveSession(null)
    }
  }, [incomingSession])

  // Reject call action
  const rejectCall = useCallback(async () => {
    if (!incomingSession) return

    stopRingtone()
    const sessionId = incomingSession.id
    setIncomingSession(null)

    await fetch(`/api/calls/${sessionId}/hangup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'reject' }),
    }).catch(() => {})
  }, [incomingSession])

  // Hangup call action
  const hangupCall = useCallback(async () => {
    stopRingtone()
    setIncomingSession(null)

    if (peerRef.current) {
      peerRef.current.hangup()
      peerRef.current = null
    }

    if (activeSession) {
      const sessionId = activeSession.id
      setActiveSession(null)
      await fetch(`/api/calls/${sessionId}/hangup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'terminate' }),
      }).catch(() => {})
    }
  }, [activeSession])

  // Toggle mute
  const toggleMute = useCallback(() => {
    if (peerRef.current) {
      const muted = peerRef.current.toggleMute()
      setIsMuted(muted)
    }
  }, [])

  return {
    incomingSession,
    activeSession,
    peerState,
    isMuted,
    callDuration,
    answerCall,
    rejectCall,
    hangupCall,
    toggleMute,
  }
}
