"use client";

import { useState, useCallback, useEffect, useRef } from "react";
import { useParams, useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from "@/lib/inbox/conversations";
import {
  looksLikeConversationId,
  resolveConversation,
} from "@/lib/inbox/resolve-conversation";
import {
  mergeConversationSnapshot,
  mergeUnreadState,
  type UnreadState,
} from "@/lib/inbox/unread";
import {
  INBOX_READ_EVENT,
  INBOX_SNAPSHOT_EVENT,
  subscribeInboxRecovery,
  type InboxReadReceipt,
} from "@/lib/inbox/read-queue";
import { toast } from "sonner";
import type { Conversation, Message, ConversationStatus } from "@/types";
import { useInboxReadQueue } from "./inbox-read-provider";
import { useRealtime } from "@/hooks/use-realtime";
import { useInboxMessages } from "@/hooks/use-inbox-messages";
import { ConversationList } from "@/components/inbox/conversation-list";
import { MessageThread } from "@/components/inbox/message-thread";
import { ContactSidebar } from "@/components/inbox/contact-sidebar";
import { WifiOff } from "lucide-react";
import { cn } from "@/lib/utils";

// Remembers the agent's show/hide choice for the desktop contact panel
// across reloads and sessions (device-scoped, like the theme prefs).
const CONTACT_PANEL_STORAGE_KEY = "wacrm:inbox:contact-panel-open";

// Owned by the static /inbox layout, above the dynamic route identity.
export function InboxWorkspace() {
  const t = useTranslations("Inbox.page");
  const readQueue = useInboxReadQueue();
  const router = useRouter();
  const params = useParams<{ conversationId?: string[] }>();
  /**
   * The open conversation, taken from the URL rather than held only in
   * state. The URL is the source of truth: back/forward, a refresh and
   * a pasted link all go through this one value.
   *
   * The segment is an optional catch-all, so `params.conversationId` is
   * `undefined` on `/inbox` and `["<id>"]` on `/inbox/<id>`. Anything
   * deeper is somebody hand-editing the URL; take the first segment and
   * ignore the rest.
   */
  const routeConvId = params?.conversationId?.[0] ?? null;

  const [conversations, setConversations] = useState<Conversation[]>([]);

  const activeConversation = routeConvId
    ? (conversations.find((c) => c.id === routeConvId) ?? null)
    : null;
  const activeContact = activeConversation?.contact ?? null;

  /**
   * Derived, never stored.
   *
   * Holding the open conversation in state as well as in the URL meant
   * two sources of truth that had to be kept in step by hand — which is
   * why every realtime patch below had to be written twice, once into
   * `conversations` and once into `activeConversation`. Deriving it
   * removes that duplication and, more importantly, makes back/forward
   * work for free: the browser changes the URL, and the selection
   * follows.
   */
  const {
    messages,
    messagesLoaded,
    onMessagesLoaded: handleMessagesLoaded,
    onNewMessage: handleNewMessage,
    onUpdateMessage: handleUpdateMessage,
    onMessagesAcknowledged: handleMessagesAcknowledged,
    draft,
    onDraftChange,
    readingPositions,
  } = useInboxMessages(routeConvId);
  const visibleHistory = useRef({
    id: routeConvId,
    messages,
    loaded: messagesLoaded,
  });
  useEffect(() => {
    visibleHistory.current = {
      id: routeConvId,
      messages,
      loaded: messagesLoaded,
    };
  });
  const [whatsappConnected, setWhatsappConnected] = useState<boolean | null>(
    null,
  );
  /**
   * Bumped whenever we want children (ConversationList, MessageThread)
   * to refetch from the DB — used as a safety net against missed
   * realtime events. Bumped on WS reconnect and on tab visibility →
   * visible. The initial mount fetches don't depend on this; they fire
   * once on conversationId-change as usual.
   */
  const [resyncToken, setResyncToken] = useState(0);

  /**
   * Has the conversation list finished its first load?
   *
   * Needed so the resolver below does not judge a URL before there is
   * anything to judge it against — on a cold load the list is empty for
   * a moment, and treating that as "this conversation does not exist"
   * would bounce every deep link straight back to /inbox.
   */
  const [conversationsLoaded, setConversationsLoaded] = useState(false);

  /**
   * Whether the desktop contact sidebar (tags / deals / notes) is shown.
   * Defaults to `true` (the historical behaviour) and is restored from
   * localStorage after mount. We deliberately do NOT read localStorage in
   * the initializer: the server renders with `true`, so reading a stored
   * `false` synchronously would produce a hydration mismatch. The effect
   * below reconciles to the stored value right after mount instead.
   */
  const [contactPanelOpen, setContactPanelOpen] = useState(true);
  useEffect(() => {
    try {
      const stored = localStorage.getItem(CONTACT_PANEL_STORAGE_KEY);
      if (stored !== null) setContactPanelOpen(stored === "true");
    } catch {
      // localStorage can throw in private-browsing / sandboxed contexts.
    }
  }, []);

  const handleToggleContactPanel = useCallback(() => {
    setContactPanelOpen((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(CONTACT_PANEL_STORAGE_KEY, String(next));
      } catch {
        // Persistence is best-effort; ignore storage failures.
      }
      return next;
    });
  }, []);

  // Tracks conversations whose hydrate fetch is currently in flight. The
  // conv-INSERT and the first-message-INSERT events both call into
  // hydrateConversation; the dedupe here keeps it at one refetch per
  // new conversation even when both events arrive within milliseconds.
  const hydratingConvIdsRef = useRef<Set<string>>(new Set());

  /**
   * Synchronous mirror of the conversation ids currently in `conversations`
   * state. Event handlers need to know "do we already have this conv?"
   * without waiting for a setState updater to run — updaters fire during
   * reconciliation, *after* the synchronous handler code returns, so a
   * `let foundInList = false; setState(p => { foundInList = ...; return ... })`
   * flag reads as `false` in the same tick (this exact bug shipped in #105
   * and caused #106: every incoming message and every status flip fired a
   * redundant DB hydrate, swamping the supabase client and starving the
   * realtime channel). The ref is kept in sync via the effect below.
   */
  const knownConvIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const next = new Set<string>();
    for (const c of conversations) next.add(c.id);
    knownConvIdsRef.current = next;
  }, [conversations]);

  // Pull the conversation row with its `contact` joined and merge it
  // into state. Needed because Supabase Realtime payloads only carry the
  // row's own columns — a brand-new conversation arrives without a
  // contact, which surfaced as "Unknown" names, empty avatars, and
  // (when the conv-INSERT event was delayed past the message-INSERT)
  // conversations stuck on "No messages yet" until the user reloaded.
  // Also self-heals if a realtime event was missed: callers can invoke
  // this whenever they reference a conversation id they don't recognise.
  const hydrateConversation = useCallback(async (convId: string) => {
    if (hydratingConvIdsRef.current.has(convId)) return;
    hydratingConvIdsRef.current.add(convId);
    try {
      const supabase = createClient();
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .eq("id", convId)
        .maybeSingle();
      if (error) {
        // Supabase errors have non-enumerable properties — log fields
        // explicitly so the console message isn't just `{}`.
        console.error("Failed to hydrate conversation:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        return;
      }
      if (!data) return;
      const fetched = normalizeConversation(data);
      setConversations((prev) => {
        const existing = prev.find((c) => c.id === fetched.id);
        if (existing) {
          // Already in state — keep its fields (a realtime UPDATE may
          // have landed while the fetch was in flight and patched
          // last_message_text / unread_count to fresher values than
          // the row we just read). Only backfill `contact`, which the
          // realtime payloads never carry.
          return prev.map((c) =>
            c.id === fetched.id
              ? { ...c, contact: c.contact ?? fetched.contact }
              : c,
          );
        }
        return [fetched, ...prev];
      });
    } finally {
      hydratingConvIdsRef.current.delete(convId);
    }
  }, []);

  // Check WhatsApp connection status on mount
  useEffect(() => {
    const checkConnection = async () => {
      const supabase = createClient();
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const user = session?.user;

      if (!user) return;

      // whatsapp_config is one-row-per-account post-multi-user, so
      // the previous `.eq('user_id', user.id)` would miss the row
      // for any teammate who didn't personally save the config —
      // the "WhatsApp not connected" banner would show in the
      // shared inbox even though the admin had it configured.
      // Resolve account_id via the profile and query by that.
      const { data: profile } = await supabase
        .from("profiles")
        .select("account_id")
        .eq("user_id", user.id)
        .maybeSingle();
      const accountId = profile?.account_id as string | undefined;
      if (!accountId) {
        setWhatsappConnected(false);
        return;
      }

      const { data } = await supabase
        .from("whatsapp_config")
        .select("status")
        .eq("account_id", accountId)
        .maybeSingle();

      setWhatsappConnected(data?.status === "connected");
    };

    checkConnection();
  }, []);

  // Handle realtime message events
  const handleMessageEvent = useCallback(
    (event: { eventType: string; new: Message; old: Partial<Message> }) => {
      const newMsg = event.new;

      if (event.eventType === "INSERT") {
        // Add to messages if it belongs to active conversation
        handleNewMessage(newMsg);

        // Update conversation list preview. We need to know *synchronously*
        // whether the conv is already in state to decide between patching
        // the preview and triggering a hydrate — see the comment on
        // knownConvIdsRef for why a closure flag inside the updater would
        // always read false here.
        if (knownConvIdsRef.current.has(newMsg.conversation_id)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === newMsg.conversation_id
                ? {
                    ...c,
                    last_message_text: newMsg.content_text ?? "",
                    last_message_at: newMsg.created_at,
                  }
                : c,
            ),
          );
        } else {
          // First time we're seeing this conv: the conv-INSERT event
          // hasn't landed yet, or was missed. Hydrate from the DB so
          // the row surfaces with its `contact` joined; the conv-UPDATE
          // event the webhook emits right after the message INSERT will
          // converge state when it arrives.
          hydrateConversation(newMsg.conversation_id);
        }
      }

      if (event.eventType === "UPDATE") {
        // Update message status
        handleUpdateMessage(newMsg.id, newMsg);
      }
    },
    [hydrateConversation, handleNewMessage, handleUpdateMessage],
  );

  // A conversation is gone — either this tab deleted it, or realtime
  // told us another member did. Same cleanup either way, so both paths
  // land here. Declared above `handleConversationEvent` because that
  // callback lists it as a dependency.
  const handleConversationDeleted = useCallback(
    (conversationId: string) => {
      setConversations((prev) => prev.filter((c) => c.id !== conversationId));
      // The effect above rebuilds this from `conversations`, but not
      // until after this render — drop it now so a realtime event
      // arriving in between doesn't treat the row as still known.
      knownConvIdsRef.current.delete(conversationId);

      if (routeConvId === conversationId) {
        // Someone else deleted the thread the user was reading. Say so
        // rather than silently emptying the pane.
        toast.error(t("conversationDeleted"));
        // `replace`, not `push`: the deleted thread must not stay in
        // history, or Back would walk the user straight back into a
        // conversation that no longer exists.
        router.replace("/inbox", { scroll: false });
      }
    },
    [routeConvId, router, t],
  );

  // Handle realtime conversation events
  const handleConversationEvent = useCallback(
    (event: {
      eventType: string;
      new: Conversation;
      old: Partial<Conversation>;
    }) => {
      const conv = event.new;

      if (event.eventType === "INSERT") {
        // Prepend immediately for snappy UX so the new conv shows in the
        // list right away, then hydrate to fill in the `contact` join
        // (realtime payloads never include joins). Skip both if we
        // already have the row — that shouldn't happen normally, but
        // out-of-order delivery would have us prepending a duplicate.
        if (!knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) => {
            if (prev.some((c) => c.id === conv.id)) return prev;
            return [conv, ...prev];
          });
          hydrateConversation(conv.id);
        }
      }

      if (event.eventType === "UPDATE") {
        if (knownConvIdsRef.current.has(conv.id)) {
          setConversations((prev) =>
            prev.map((c) =>
              c.id === conv.id ? mergeUnreadState(c, { ...c, ...conv }) : c,
            ),
          );
        } else {
          // UPDATE arrived before the INSERT (or after a missed INSERT)
          // — fetch the row so it surfaces with its contact joined. The
          // patch contained in `conv` will already be reflected in what
          // the hydrate fetch returns.
          hydrateConversation(conv.id);
        }

        // Update active conversation if it changed
      }

      if (event.eventType === "DELETE") {
        // Another member (an owner) deleted it. Postgres sends only the
        // replica identity on DELETE, which for this table is the primary
        // key — so `old.id` is all we get, and all we need.
        const deletedId = event.old?.id;
        if (deletedId) handleConversationDeleted(deletedId);
      }
    },
    [hydrateConversation, handleConversationDeleted],
  );

  // Subscribe to realtime. The `isConnected` flag below feeds the
  // reconnect resync: realtime is best-effort and events sent while the
  // WS was disconnected (laptop sleep, network blip, background-tab
  // throttle) are simply lost. We need a way to catch up.
  const { isConnected } = useRealtime({
    channelName: "inbox-realtime",
    onMessageEvent: handleMessageEvent,
    onConversationEvent: handleConversationEvent,
    enabled: true,
  });

  /**
   * Resolve a conversation id that is not in the loaded list.
   *
   * The list is paginated and filtered, so a perfectly valid deep link
   * often points at a conversation that simply is not in it. Fetch that
   * one row and, if the user may see it, splice it in. If they may not,
   * send them back to the list WITH an explanation — the old behaviour
   * was an empty pane and no clue why.
   *
   * `resolvedIdRef` keeps this to one attempt per id, so a failed
   * lookup does not retry on every re-render.
   */
  const resolvedIdRef = useRef<string | null>(null);
  const [lookupErrorId, setLookupErrorId] = useState<string | null>(null);
  useEffect(() => {
    if (!routeConvId || !conversationsLoaded) return;
    if (activeConversation?.id === routeConvId) return;
    if (resolvedIdRef.current === routeConvId) return;
    resolvedIdRef.current = routeConvId;

    // A hand-edited URL never reaches the database: PostgREST would
    // reject a non-uuid with a cast error, which reads as a transport
    // failure and would keep the user waiting on a thread that cannot
    // load.
    if (!looksLikeConversationId(routeConvId)) {
      toast.error(t("conversationUnavailable"));
      router.replace("/inbox", { scroll: false });
      return;
    }

    let cancelled = false;
    void (async () => {
      const result = await resolveConversation(createClient(), routeConvId);
      if (cancelled) return;

      if (result.status === "ok") {
        setLookupErrorId(null);
        setConversations((prev) =>
          prev.some((c) => c.id === result.conversation.id)
            ? prev
            : [result.conversation, ...prev],
        );
        return;
      }

      if (result.status === "unauthenticated") {
        // The session is going. Leave the outcome to the auth layer:
        // redirecting here would send the user to /inbox first, and the
        // `?next=` written on the way to /login would then point at the
        // list instead of the conversation they were reading.
        resolvedIdRef.current = null;
        return;
      }

      if (result.status === "error") {
        // Do NOT redirect. The lookup failed, which says nothing about
        // whether the conversation exists — throwing the user out here
        // would repeat the mistake P0-BUG-03 fixed for sign-outs.
        // Allow a retry by clearing the guard.
        console.error("[inbox] conversation lookup failed:", result.message);
        setLookupErrorId(routeConvId);
        resolvedIdRef.current = null;
        return;
      }

      // Deleted, or belonging to another account. RLS makes those
      // indistinguishable on purpose — see resolve-conversation.ts.
      toast.error(t("conversationUnavailable"));
      router.replace("/inbox", { scroll: false });
    })();

    return () => {
      cancelled = true;
      if (resolvedIdRef.current === routeConvId) resolvedIdRef.current = null;
    };
  }, [
    routeConvId,
    conversationsLoaded,
    activeConversation?.id,
    router,
    t,
    resyncToken,
  ]);

  /**
   * Refetch when the tab regains focus. Background tabs may have their
   * WS throttled by the browser even without a full disconnect, so a
   * visibilitychange → visible is a reliable signal that we may have
   * missed events. Cheap to fire; the children dedupe on their own.
   */
  useEffect(
    () => subscribeInboxRecovery(() => setResyncToken((n) => n + 1)),
    [],
  );

  useEffect(() => {
    const acknowledge = (event: Event) => {
      const receipt = (event as CustomEvent<InboxReadReceipt>).detail;
      setConversations((rows) =>
        rows.map((row) =>
          row.id === receipt.conversation_id
            ? mergeUnreadState(row, {
                ...row,
                unread_count: receipt.unread_count,
                unread_revision: receipt.unread_revision,
              })
            : row,
        ),
      );
      handleMessagesAcknowledged(
        receipt.conversation_id,
        receipt.acknowledged_ids,
      );
    };
    window.addEventListener(INBOX_READ_EVENT, acknowledge);
    return () => window.removeEventListener(INBOX_READ_EVENT, acknowledge);
  }, [handleMessagesAcknowledged]);

  useEffect(() => {
    let gapTimer: ReturnType<typeof setTimeout> | undefined;
    const snapshot = (event: Event) => {
      const rows = (event as CustomEvent<UnreadState[]>).detail;
      const byId = new Map(rows.map((row) => [row.id, row]));
      setConversations((previous) =>
        previous.map((row) => {
          const incoming = byId.get(row.id);
          return incoming
            ? mergeUnreadState(row, { ...row, ...incoming })
            : row;
        }),
      );
      clearTimeout(gapTimer);
      gapTimer = setTimeout(() => {
        if (document.visibilityState !== "visible" || !navigator.onLine) return;
        const history = visibleHistory.current;
        const current = history.id ? byId.get(history.id) : undefined;
        if (
          history.loaded &&
          history.messages
            .filter((message) => message.sender_type === "customer")
            .every((message) => typeof message.inbox_unread === "boolean") &&
          current &&
          current.unread_count >
            history.messages.filter((message) => message.inbox_unread).length
        ) {
          setResyncToken((token) => token + 1);
        }
      }, 250);
    };
    window.addEventListener(INBOX_SNAPSHOT_EVENT, snapshot);
    return () => {
      clearTimeout(gapTimer);
      window.removeEventListener(INBOX_SNAPSHOT_EVENT, snapshot);
    };
  }, []);

  /**
   * Manual refresh trigger for the thread-header refresh button.
   * Bumps the same resyncToken the reconnect / visibility paths use,
   * so it goes through the existing dedupe & refetch plumbing — no
   * separate code path to keep in sync.
   */
  const handleManualRefresh = useCallback(() => {
    setLookupErrorId(null);
    readQueue?.retry();
    setResyncToken((n) => n + 1);
  }, [readQueue]);

  const handleConversationsLoaded = useCallback(
    (loaded: Conversation[], baseline: Conversation[] = []) => {
      // Keep the selected row if a refreshed/filtered list omits it.
      setConversations((previous) => {
        const active = previous.find((row) => row.id === routeConvId);
        const merged = mergeConversationSnapshot(previous, loaded, baseline);
        return active && !merged.some((row) => row.id === active.id)
          ? [...merged, active]
          : merged;
      });
      setConversationsLoaded(true);
      // No deep-link resolution here any more. The open conversation is
      // derived from the URL, so a list refresh — realtime, resync or
      // manual — cannot change the selection, and there is no ref to keep
      // in step. That whole class of "the list reloaded and snapped me
      // back to another thread" bug is gone by construction.
    },
    [routeConvId],
  );

  const handleSelectConversation = useCallback(
    (conv: Conversation) => {
      // Re-clicking the open conversation would push a duplicate history
      // entry, so Back would appear to do nothing once per extra click.
      if (routeConvId === conv.id) return;
      // `push`, not `replace` — this is the fix for defect C. Every
      // selection used to overwrite the same history entry, so after
      // opening a few conversations the stack still held only whatever
      // preceded /inbox. Pressing Back therefore left the inbox
      // entirely and landed on the dashboard, which is the third
      // symptom in the bug report and happens deterministically, with
      // no auth involved at all.
      router.push(`/inbox/${conv.id}`, { scroll: false });
    },
    [routeConvId, router],
  );

  // The thread's close / back control. Goes to the inbox list, never
  // to whatever happens to be behind this page in history — using
  // `router.back()` here would land on the dashboard whenever the user
  // arrived from there, which is precisely the reported complaint.
  const handleCloseConversation = useCallback(() => {
    router.push("/inbox", { scroll: false });
  }, [router]);

  const handleStatusChange = useCallback(
    (conversationId: string, status: ConversationStatus) => {
      setConversations((prev) =>
        prev.map((c) => (c.id === conversationId ? { ...c, status } : c)),
      );
    },
    [],
  );

  const handleAssignChange = useCallback(
    (conversationId: string, assignedAgentId: string | null) => {
      setConversations((prev) =>
        prev.map((c) =>
          c.id === conversationId
            ? { ...c, assigned_agent_id: assignedAgentId ?? undefined }
            : c,
        ),
      );
    },
    [],
  );

  // On mobile (<lg) we show a SINGLE pane — either the list or the
  // thread — rather than cramming both side-by-side. Selecting a
  // conversation slides the thread in; the thread's back button pops
  // it back to the list. On lg+ both panes render side-by-side as
  // before, unchanged.
  const hasActiveConv = !!routeConvId;

  return (
    <div
      data-realtime-connected={isConnected}
      className="-m-4 flex h-[calc(100dvh-3.5rem)] flex-col overflow-hidden sm:-m-6"
    >
      {/* WhatsApp connection banner — in the flex column, not absolute,
          so it pushes the panels down instead of overlapping them. */}
      {whatsappConnected === false && (
        <div className="flex shrink-0 items-center justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2">
          <WifiOff className="h-4 w-4 text-amber-400" />
          <p className="text-xs text-amber-400">{t("whatsappNotConnected")}</p>
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/* Left panel: Conversation list.
            Hidden on mobile when a conversation is selected so the
            thread can occupy the full width. Always visible on lg+. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex-none",
            hasActiveConv ? "hidden lg:flex" : "flex",
          )}
        >
          <ConversationList
            activeConversationId={activeConversation?.id ?? null}
            onSelect={handleSelectConversation}
            conversations={conversations}
            onConversationsLoaded={handleConversationsLoaded}
            resyncToken={resyncToken}
            onDeleted={handleConversationDeleted}
          />
        </div>

        {/* Center panel: Message thread.
            Hidden on mobile when no conversation is selected so the
            list can occupy the full width. Always visible on lg+
            (shows its own empty-state if no thread is picked yet).

            `min-w-0` is load-bearing: without it, a single wide piece
            of content inside the thread (long quote preview, very
            long URL in a message body) forces the flex child past
            its share and pushes the contact-sidebar panel off-screen
            on the right. Issue #165. */}
        <div
          className={cn(
            "flex h-full min-w-0 flex-1 lg:flex",
            hasActiveConv ? "flex" : "hidden lg:flex",
          )}
        >
          <MessageThread
            initialLookupError={lookupErrorId === routeConvId && !!routeConvId}
            requestedConversationId={routeConvId}
            draft={draft}
            onDraftChange={onDraftChange}
            readingPositions={readingPositions}
            conversation={activeConversation}
            contact={activeContact}
            messages={messages}
            messagesLoaded={messagesLoaded}
            onMessagesLoaded={handleMessagesLoaded}
            onNewMessage={handleNewMessage}
            onUpdateMessage={handleUpdateMessage}
            onStatusChange={handleStatusChange}
            onAssignChange={handleAssignChange}
            onBack={handleCloseConversation}
            resyncToken={resyncToken}
            onRefresh={handleManualRefresh}
            contactPanelOpen={contactPanelOpen}
            onToggleContactPanel={handleToggleContactPanel}
          />
        </div>

        {/* Three panels need xl width. At lg the contact panel would leave
            only ~34px for typing; retain list + thread until xl. */}
        {contactPanelOpen && (
          <div className="hidden xl:block">
            <ContactSidebar
              contact={activeContact}
              conversationId={activeConversation?.id ?? null}
            />
          </div>
        )}
      </div>
    </div>
  );
}
