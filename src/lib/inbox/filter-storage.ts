// ============================================================
// Remembering the inbox's working context across a reload or a trip to
// another section (P0-BUG-06).
//
// WHAT THIS DOES *NOT* COVER, AND WHY
//
// Switching browser tabs already preserves everything: after P0-BUG-02
// the dashboard tree stays mounted, and after P0-BUG-04 moving between
// conversations re-renders the same route segment rather than
// remounting it. Measured before writing this — the filter survived a
// hidden/visible cycle untouched. What did NOT survive was a reload and
// a navigation to another section and back, because both really do
// remount the page. That is the gap this closes.
//
// `sessionStorage`, not `localStorage`: this is transient working
// context, not a preference. A filter left on "unread" three weeks ago
// should not still be hiding conversations in a fresh tab today. (The
// contact-panel toggle in the inbox page is the opposite case, and
// correctly uses localStorage.)
//
// The key carries the account id so switching accounts starts clean.
// Two people sharing a browser profile, or one person moving between
// their own accounts, must never inherit the other's filters — and a
// stale filter that silently hides conversations is exactly the kind of
// bug that gets reported as "messages are missing".
// ============================================================

/** Matches `InboxFilter` in conversation-list.tsx. */
const VALID_FILTERS = ["all", "unread", "open", "pending", "closed"] as const;
export type StoredFilter = (typeof VALID_FILTERS)[number];

export interface InboxFilterState {
  search: string;
  filter: StoredFilter;
  selectedTagIds: string[];
  selectedCompany: string | null;
}

export const EMPTY_FILTER_STATE: InboxFilterState = {
  search: "",
  filter: "all",
  selectedTagIds: [],
  selectedCompany: null,
};

export function inboxFilterStorageKey(accountId: string): string {
  return `wacrm:inbox:filters:${accountId}`;
}

/**
 * Narrow whatever is in storage into a usable state.
 *
 * Everything is validated field by field rather than trusted: the value
 * may have been written by an older build with a different shape, or
 * edited by hand. A bad `filter` string would silently match no
 * conversations and read as "my inbox is empty".
 */
export function parseInboxFilterState(raw: string | null): InboxFilterState {
  if (!raw) return EMPTY_FILTER_STATE;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return EMPTY_FILTER_STATE;
  }
  if (typeof parsed !== "object" || parsed === null) return EMPTY_FILTER_STATE;

  const value = parsed as Record<string, unknown>;
  const filter = value.filter;
  const tagIds = value.selectedTagIds;

  return {
    search: typeof value.search === "string" ? value.search : "",
    filter: VALID_FILTERS.includes(filter as StoredFilter)
      ? (filter as StoredFilter)
      : "all",
    selectedTagIds: Array.isArray(tagIds)
      ? tagIds.filter((id): id is string => typeof id === "string")
      : [],
    selectedCompany:
      typeof value.selectedCompany === "string" ? value.selectedCompany : null,
  };
}

/** True when the state is indistinguishable from "no filters applied". */
export function isEmptyFilterState(state: InboxFilterState): boolean {
  return (
    state.search === "" &&
    state.filter === "all" &&
    state.selectedTagIds.length === 0 &&
    state.selectedCompany === null
  );
}

export function loadInboxFilterState(accountId: string | null): InboxFilterState {
  if (!accountId || typeof sessionStorage === "undefined") return EMPTY_FILTER_STATE;
  try {
    return parseInboxFilterState(sessionStorage.getItem(inboxFilterStorageKey(accountId)));
  } catch {
    // Storage throws in private-browsing and sandboxed contexts. Losing
    // a filter is not worth breaking the inbox over.
    return EMPTY_FILTER_STATE;
  }
}

export function saveInboxFilterState(
  accountId: string | null,
  state: InboxFilterState,
): void {
  if (!accountId || typeof sessionStorage === "undefined") return;
  try {
    const key = inboxFilterStorageKey(accountId);
    // Remove rather than store an empty object, so a cleared filter
    // leaves nothing behind to resurrect.
    if (isEmptyFilterState(state)) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(state));
  } catch {
    // Best effort; see above.
  }
}
