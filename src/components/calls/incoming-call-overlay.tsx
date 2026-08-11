"use client";

import { useEffect, useState } from "react";
import { Phone, PhoneOff, MessageSquare } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { CallSessionData } from "@/hooks/use-incoming-calls";

interface IncomingCallOverlayProps {
  session: CallSessionData;
  onAnswer: () => void;
  onReject: () => void;
}

export function IncomingCallOverlay({
  session,
  onAnswer,
  onReject,
}: IncomingCallOverlayProps) {
  const [secondsLeft, setSecondsLeft] = useState(30);

  useEffect(() => {
    const interval = window.setInterval(() => {
      setSecondsLeft((prev) => {
        if (prev <= 1) {
          window.clearInterval(interval);
          onReject();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => window.clearInterval(interval);
  }, [onReject]);

  const contactName = session.contact?.name || session.contact?.phone || "Contacto desconocido";
  const contactPhone = session.contact?.phone || "";
  const contextLine = session.contact?.lastMessageText;
  const initial = contactName.charAt(0).toUpperCase();

  const secondsElapsed = 30 - secondsLeft;
  const formattedSeconds = `0:${secondsElapsed < 10 ? "0" : ""}${secondsElapsed}`;
  const strokeDashoffset = 125.6 * (1 - secondsLeft / 30);

  return (
    <div className="fixed top-4 right-4 z-50 w-full max-w-sm px-4 sm:px-0 transition-all duration-300 animate-in fade-in slide-in-from-top-4">
      <div className="relative overflow-hidden rounded-2xl border border-border bg-card p-5 shadow-2xl backdrop-blur-md">
        <div className="flex items-start gap-4">
          {/* Pulsing Ring & Circular Countdown Progress Arc */}
          <div className="relative flex-shrink-0">
            <span className="absolute -inset-1.5 animate-ping rounded-full bg-emerald-500/30 opacity-75" />
            <div className="relative flex h-14 w-14 items-center justify-center rounded-full bg-emerald-600/10 text-emerald-600 dark:text-emerald-400">
              <svg className="absolute inset-0 h-14 w-14 -rotate-90 transform" viewBox="0 0 48 48">
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  className="stroke-muted/30"
                  strokeWidth="3"
                  fill="none"
                />
                <circle
                  cx="24"
                  cy="24"
                  r="20"
                  className="stroke-emerald-500 transition-all duration-1000 ease-linear"
                  strokeWidth="3"
                  strokeDasharray="125.6"
                  strokeDashoffset={strokeDashoffset}
                  strokeLinecap="round"
                  fill="none"
                />
              </svg>
              {session.contact?.avatarUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={session.contact.avatarUrl}
                  alt={contactName}
                  className="h-10 w-10 rounded-full object-cover"
                />
              ) : (
                <span className="text-lg font-bold">{initial}</span>
              )}
            </div>
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-center justify-between">
              <span className="inline-flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-500 animate-pulse" />
                Llamada entrante
              </span>
              <span className="text-xs font-mono text-muted-foreground">{formattedSeconds}</span>
            </div>

            <h4 className="mt-1 truncate text-base font-semibold text-foreground">
              {contactName}
            </h4>
            {contactPhone && contactPhone !== contactName && (
              <p className="truncate text-xs text-muted-foreground">{contactPhone}</p>
            )}

            {/* Context line — last message or thread topic */}
            {contextLine && (
              <div className="mt-2.5 flex items-center gap-1.5 rounded-lg bg-muted/60 px-2.5 py-1.5 text-xs text-muted-foreground">
                <MessageSquare className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground/80" />
                <span className="truncate italic">&quot;{contextLine}&quot;</span>
              </div>
            )}
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-4 flex items-center justify-end gap-2 pt-2 border-t border-border/50">
          <Button
            variant="ghost"
            size="sm"
            onClick={onReject}
            className="flex-1 text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            <PhoneOff className="mr-1.5 h-4 w-4" />
            Rechazar
          </Button>

          <Button
            size="sm"
            onClick={onAnswer}
            className="flex-1 bg-emerald-600 hover:bg-emerald-700 text-white shadow-md"
          >
            <Phone className="mr-1.5 h-4 w-4" />
            Contestar
          </Button>
        </div>
      </div>
    </div>
  );
}
