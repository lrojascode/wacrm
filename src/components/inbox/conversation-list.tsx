"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useAuth } from "@/hooks/use-auth";
import {
  EMPTY_FILTER_STATE,
  loadInboxFilterState,
  saveInboxFilterState,
} from "@/lib/inbox/filter-storage";
import { createClient } from "@/lib/supabase/client";
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from "@/lib/inbox/conversations";
import { cn } from "@/lib/utils";
import type { Conversation, ConversationStatus, Tag } from "@/types";
import {
  Search,
  ChevronDown,
  X,
  MoreVertical,
  Trash2,
  AlertTriangle,
  Loader2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useLocale, useTranslations } from "next-intl";
import { toast } from "sonner";
import { dateFnsLocale } from "@/lib/i18n/date-locale";
import { useCan } from "@/hooks/use-can";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ScrollArea } from "@/components/ui/scroll-area";

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (
    conversations: Conversation[],
    baseline?: Conversation[],
  ) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
  /**
   * Called after a conversation has been deleted server-side, so the
   * parent can drop it from its own state and clear the open thread if
   * that's the one that went. Optional — without it the menu still
   * works, the parent just won't react.
   */
  onDeleted?: (conversationId: string) => void;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: "bg-primary",
  pending: "bg-amber-500",
  closed: "bg-muted-foreground",
};

type InboxFilter = ConversationStatus | "all" | "unread";

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
  onDeleted,
}: ConversationListProps) {
  const t = useTranslations("Inbox.conversationList");
  const canDelete = useCan("delete-conversation");
  // One dialog for the whole list rather than one per row; the pending
  // conversation is the open/closed state.
  const [pendingDelete, setPendingDelete] = useState<Conversation | null>(null);
  const [deleting, setDeleting] = useState(false);

  const FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t("filterAll"), value: "all" },
      { label: t("filterUnread"), value: "unread" },
      { label: t("filterOpen"), value: "open" },
      { label: t("filterPending"), value: "pending" },
      { label: t("filterClosed"), value: "closed" },
    ],
    [t],
  );

  const { accountId } = useAuth();

  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<InboxFilter>("all");
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  /**
   * Restore the working context after mount (P0-BUG-06).
   *
   * Read here rather than in the `useState` initialisers on purpose:
   * the server renders this component with the defaults, so reading
   * storage synchronously would hydrate with different values and React
   * would flag a mismatch. Same reasoning — and same shape — as the
   * contact-panel toggle in the inbox page.
   *
   * Keyed on `accountId`, so switching accounts restores that account's
   * context rather than inheriting the previous one. `restoredForRef`
   * makes it fire once per account: without it, any later re-render
   * would overwrite a filter the user had just changed.
   */
  const restoredForRef = useRef<string | null>(null);
  useEffect(() => {
    if (!accountId || restoredForRef.current === accountId) return;
    restoredForRef.current = accountId;
    const stored = loadInboxFilterState(accountId);
    setSearch(stored.search);
    setFilter(stored.filter);
    setSelectedTagIds(stored.selectedTagIds);
    setSelectedCompany(stored.selectedCompany);
  }, [accountId]);

  // Persist on every change. Cheap (one small JSON write) and avoids
  // having to find every mutation site — there are six.
  useEffect(() => {
    if (!accountId || restoredForRef.current !== accountId) return;
    saveInboxFilterState(accountId, {
      ...EMPTY_FILTER_STATE,
      search,
      filter,
      selectedTagIds,
      selectedCompany,
    });
  }, [accountId, search, filter, selectedTagIds, selectedCompany]);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const snapshotRef = useRef(conversations);
  useEffect(() => {
    snapshotRef.current = conversations;
  });
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const baseline = snapshotRef.current;
      const { data, error } = await supabase
        .from("conversations")
        .select(CONVERSATION_SELECT)
        .order("last_message_at", { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error("Failed to fetch conversations:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(
        normalizeConversations(data ?? []),
        baseline,
      );
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("tags").select("*").order("name");
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === "unread") {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter !== "all") {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        }),
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const name = c.contact?.name?.toLowerCase() ?? "";
        const phone = c.contact?.phone?.toLowerCase() ?? "";
        const lastMsg = c.last_message_text?.toLowerCase() ?? "";
        return name.includes(q) || phone.includes(q) || lastMsg.includes(q);
      });
    }

    return result;
  }, [conversations, filter, search, selectedTagIds, selectedCompany]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id],
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    [],
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect],
  );

  const handleConfirmDelete = useCallback(async () => {
    if (!pendingDelete) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/conversations/${pendingDelete.id}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.error || `Delete failed: ${res.status}`);
      }
      // The list itself is a controlled view of the parent's state, so
      // the parent does the removal — realtime would eventually deliver
      // the same DELETE, but not fast enough to feel responsive.
      onDeleted?.(pendingDelete.id);
      toast.success(t("deleteSuccess"));
      setPendingDelete(null);
    } catch (err) {
      console.error(err);
      toast.error(err instanceof Error ? err.message : t("deleteError"));
    } finally {
      setDeleting(false);
    }
  }, [pendingDelete, onDeleted, t]);

  const pendingName =
    pendingDelete?.contact?.name ||
    pendingDelete?.contact?.phone ||
    t("unknown");

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full min-w-0 flex-col border-r lg:w-80">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t("searchPlaceholder")}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? t("filterAll")}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    "text-sm",
                    filter === opt.value
                      ? "text-primary"
                      : "text-popover-foreground",
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedTagIds.length > 0
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {t("tags")}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  "hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs",
                  selectedCompany
                    ? "text-primary"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t("company")}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    "text-sm",
                    selectedCompany === null
                      ? "text-primary"
                      : "text-popover-foreground",
                  )}
                >
                  {t("allCompanies")}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      "text-sm",
                      selectedCompany === co
                        ? "text-primary"
                        : "text-popover-foreground",
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? "var(--muted-foreground)",
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t("tags")}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t("clearAll")}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t("noConversations")}
            </p>
          </div>
        ) : (
          // See the note on `message-thread`: the list preview and the
          // thread bubble carry the same text, so tests need to scope.
          <div className="flex flex-col" data-testid="conversation-list">
            {filtered.map((conv) => (
              <ConversationItem
                key={conv.id}
                conversation={conv}
                isActive={conv.id === activeConversationId}
                onSelect={handleSelect}
                onRequestDelete={canDelete ? setPendingDelete : undefined}
                t={t}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      <Dialog
        open={pendingDelete !== null}
        onOpenChange={(open) => {
          // Never let a backdrop click strand an in-flight request.
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-amber-400" />
              {t("deleteTitle")}
            </DialogTitle>
            <DialogDescription>
              {t("deleteDescription", { name: pendingName })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              {t("deleteCancel")}
            </Button>
            <Button
              className="bg-red-600 text-white hover:bg-red-700"
              disabled={deleting}
              onClick={handleConfirmDelete}
            >
              {deleting && <Loader2 className="size-4 animate-spin" />}
              {t("deleteConfirm")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Owner-only. Omitted for everyone else, which hides the menu entirely. */
  onRequestDelete?: (conversation: Conversation) => void;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  onRequestDelete,
  t,
}: ConversationItemProps) {
  // `t` is threaded down as a prop, but the locale is a plain context
  // read — cheap enough to take here rather than widen the props.
  const tCalls = useTranslations("Calls");
  const locale = useLocale();
  const contact = conversation.contact;
  const displayName = contact?.name || contact?.phone || t("unknown");
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
        locale: dateFnsLocale(locale),
      })
    : "";

  const lastMessagePreview = useMemo(() => {
    const text = conversation.last_message_text;
    if (!text) return t("noMessagesYet");
    if (text.startsWith("[call")) {
      const raw =
        text.startsWith("[") && text.endsWith("]") ? text.slice(1, -1) : text;
      const parts = raw.split(":");
      const outcome = parts[1];
      const durationSec = parts[2] ? parseInt(parts[2], 10) : 0;
      if (outcome === "missed") return tCalls("missedCall");
      if (outcome === "rejected") return tCalls("rejectedCall");
      if (outcome === "failed") return tCalls("failedCall");
      if (outcome === "accepted") {
        const mins = Math.floor(durationSec / 60);
        const secs = durationSec % 60;
        const formatted = `${mins}:${secs < 10 ? "0" : ""}${secs}`;
        return `${tCalls("acceptedCall")} · ${formatted}`;
      }
      return tCalls("call");
    }
    return text;
  }, [conversation.last_message_text, t, tCalls]);

  return (
    // The row itself is a <button>, so the menu trigger can't be nested
    // inside it — it sits as an absolutely-positioned sibling instead.
    <div className="group/item relative">
      <button
        onClick={handleClick}
        data-conversation-id={conversation.id}
        className={cn(
          "hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3 text-left transition-colors",
          isActive && "border-primary bg-muted/70 border-l-2",
          // Room for the menu button so a long preview doesn't slide under it.
          onRequestDelete && "pr-9",
        )}
      >
        {/* Avatar */}
        <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
          {contact?.avatar_url ? (
            <img
              src={contact.avatar_url}
              alt={displayName}
              className="h-10 w-10 rounded-full object-cover"
            />
          ) : (
            initials
          )}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <span className="text-foreground min-w-0 flex-1 truncate text-sm font-medium">
              {displayName}
            </span>
            <span className="text-muted-foreground shrink-0 text-[10px]">
              {timeAgo}
            </span>
          </div>
          <div className="mt-0.5 flex items-center justify-between gap-2">
            <p className="text-muted-foreground min-w-0 flex-1 truncate text-xs">
              {lastMessagePreview}
            </p>
            <div className="flex shrink-0 items-center gap-1.5">
              {conversation.unread_count > 0 && (
                <span
                  data-unread-count={conversation.unread_count}
                  className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold"
                >
                  {conversation.unread_count}
                </span>
              )}
              <span
                className={cn(
                  "h-2 w-2 rounded-full",
                  STATUS_COLORS[conversation.status],
                )}
                title={conversation.status}
              />
            </div>
          </div>
        </div>
      </button>

      {onRequestDelete && (
        <DropdownMenu>
          <DropdownMenuTrigger
            aria-label={t("moreActions")}
            className={cn(
              "text-muted-foreground absolute top-2 right-1.5 flex h-6 w-6 items-center justify-center rounded-md transition-opacity",
              "hover:bg-muted hover:text-foreground",
              // Hidden until hover/keyboard focus, but always visible while
              // its own menu is open — otherwise the trigger vanishes the
              // moment focus moves into the popup.
              "opacity-0 group-hover/item:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100",
            )}
          >
            <MoreVertical className="h-4 w-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem
              variant="destructive"
              onClick={() => onRequestDelete(conversation)}
            >
              <Trash2 className="h-4 w-4" />
              {t("deleteAction")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}
