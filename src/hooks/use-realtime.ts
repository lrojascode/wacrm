"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Message, Conversation } from "@/types";
import { subscribeInboxChannel } from "@/lib/inbox/realtime";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

export function useRealtime({
  channelName,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const stopRef = useRef<(() => void) | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    if (!enabled) return;

    const supabase = createClient();

    const stop = subscribeInboxChannel(
      supabase,
      channelName,
      (channel) =>
        channel
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "messages" },
            (payload) => {
              onMessageRef.current?.({
                eventType:
                  payload.eventType as RealtimeEvent<Message>["eventType"],
                new: payload.new as Message,
                old: payload.old as Partial<Message>,
              });
            },
          )
          .on(
            "postgres_changes",
            { event: "*", schema: "public", table: "conversations" },
            (payload) => {
              onConversationRef.current?.({
                eventType:
                  payload.eventType as RealtimeEvent<Conversation>["eventType"],
                new: payload.new as Conversation,
                old: payload.old as Partial<Conversation>,
              });
            },
          ),
      setIsConnected,
    );
    stopRef.current = stop;
    return () => {
      stop();
      if (stopRef.current === stop) stopRef.current = null;
    };
  }, [channelName, enabled]);

  const unsubscribe = useCallback(() => {
    stopRef.current?.();
    stopRef.current = null;
    setIsConnected(false);
  }, []);

  return { isConnected: enabled && isConnected, unsubscribe };
}
