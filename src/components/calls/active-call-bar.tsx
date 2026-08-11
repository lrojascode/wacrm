"use client";

import { useRouter } from "next/navigation";
import { Mic, MicOff, PhoneOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CallSessionData } from "@/hooks/use-incoming-calls";

interface ActiveCallBarProps {
  session: CallSessionData;
  durationSeconds: number;
  isMuted: boolean;
  onToggleMute: () => void;
  onHangup: () => void;
}

function formatTimer(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins < 10 ? "0" : ""}${mins}:${secs < 10 ? "0" : ""}${secs}`;
}

export function ActiveCallBar({
  session,
  durationSeconds,
  isMuted,
  onToggleMute,
  onHangup,
}: ActiveCallBarProps) {
  const router = useRouter();
  const contactName = session.contact?.name || session.contact?.phone || "Contacto";
  const initial = contactName.charAt(0).toUpperCase();

  const handleContactClick = () => {
    if (session.conversationId) {
      router.push(`/dashboard/inbox?conversationId=${session.conversationId}`);
    }
  };

  return (
    <div className="w-full bg-emerald-700 text-white shadow-md transition-all duration-200">
      <div className="mx-auto flex h-11 items-center justify-between px-4 sm:px-6 text-xs sm:text-sm">
        {/* Left: Avatar + Name (Click jumps to conversation) */}
        <button
          type="button"
          onClick={handleContactClick}
          className="flex items-center gap-2.5 hover:opacity-90 transition-opacity focus:outline-none"
        >
          <div className="flex h-7 w-7 items-center justify-center rounded-full bg-white/20 font-semibold text-white">
            {session.contact?.avatarUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={session.contact.avatarUrl}
                alt={contactName}
                className="h-7 w-7 rounded-full object-cover"
              />
            ) : (
              <span>{initial}</span>
            )}
          </div>
          <span className="font-medium truncate max-w-[150px] sm:max-w-[250px]">
            {contactName}
          </span>
          <span className="hidden sm:inline-block text-emerald-200 text-xs">
            (Hacer clic para ver chat)
          </span>
        </button>

        {/* Center: Live Call Duration Timer */}
        <div className="flex items-center gap-2 font-mono font-semibold tracking-wider">
          <span className="h-2 w-2 rounded-full bg-emerald-300 animate-pulse" />
          <span>{formatTimer(durationSeconds)}</span>
        </div>

        {/* Right: Controls (Mute & Hangup) */}
        <div className="flex items-center gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            onClick={onToggleMute}
            className={`h-8 px-2.5 text-white hover:bg-white/20 ${
              isMuted ? "bg-white/20 text-yellow-300" : ""
            }`}
            title={isMuted ? "Desactivar silencio" : "Silenciar micrófono"}
          >
            {isMuted ? <MicOff className="h-4 w-4 text-yellow-300" /> : <Mic className="h-4 w-4" />}
          </Button>

          <Button
            size="sm"
            onClick={onHangup}
            className="h-8 px-3 bg-red-600 hover:bg-red-700 text-white font-medium shadow-sm"
          >
            <PhoneOff className="h-3.5 w-3.5 mr-1" />
            <span>Colgar</span>
          </Button>
        </div>
      </div>
    </div>
  );
}
