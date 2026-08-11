"use client";

import React, { createContext, useContext } from "react";
import { useIncomingCalls, type CallSessionData } from "@/hooks/use-incoming-calls";
import { IncomingCallOverlay } from "./incoming-call-overlay";
import { ActiveCallBar } from "./active-call-bar";

interface CallContextType {
  incomingSession: CallSessionData | null;
  activeSession: CallSessionData | null;
  isMuted: boolean;
  callDuration: number;
  answerCall: () => Promise<void>;
  rejectCall: () => Promise<void>;
  hangupCall: () => Promise<void>;
  toggleMute: () => void;
}

const CallContext = createContext<CallContextType | null>(null);

export function useCallContext() {
  const ctx = useContext(CallContext);
  if (!ctx) {
    throw new Error("useCallContext must be used within a CallProvider");
  }
  return ctx;
}

export function CallProvider({ children }: { children: React.ReactNode }) {
  const callState = useIncomingCalls();

  return (
    <CallContext.Provider value={callState}>
      {/* Active call bar rendered at the top of the container when active call is ongoing */}
      {callState.activeSession && (
        <ActiveCallBar
          session={callState.activeSession}
          durationSeconds={callState.callDuration}
          isMuted={callState.isMuted}
          onToggleMute={callState.toggleMute}
          onHangup={callState.hangupCall}
        />
      )}

      {children}

      {/* Incoming Call Card Overlay rendered only when a call is actively ringing */}
      {callState.incomingSession && (
        <IncomingCallOverlay
          session={callState.incomingSession}
          onAnswer={callState.answerCall}
          onReject={callState.rejectCall}
        />
      )}
    </CallContext.Provider>
  );
}
