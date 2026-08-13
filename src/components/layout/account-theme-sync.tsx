"use client";

import { useEffect } from "react";

import { useAuth } from "@/hooks/use-auth";
import { useTheme } from "@/hooks/use-theme";

/**
 * Headless — applies the account's stored appearance (migration 051)
 * to this session's `useTheme()` state once the account loads.
 *
 * The owner is the only one who can change `account.theme` /
 * `account.mode` (see AppearancePanel + PUT /api/account/appearance),
 * so for everyone else this is the whole mechanism by which "the
 * owner's choice becomes everyone's choice": each session starts from
 * its own localStorage (for the no-flash boot script), then this
 * effect immediately reconciles it to the account's value and
 * persists that back to localStorage so the next boot starts correct
 * too. Only runs once account data is loaded, and only when the
 * values actually differ, so it doesn't fight the owner's own live
 * edits in AppearancePanel.
 */
export function AccountThemeSync() {
  const { profileLoading, account } = useAuth();
  const { theme, setTheme, mode, setMode } = useTheme();

  useEffect(() => {
    if (profileLoading || !account) return;
    if (account.theme && account.theme !== theme) setTheme(account.theme);
    if (account.mode && account.mode !== mode) setMode(account.mode);
    // Only re-run when the account's own values change (or once loading
    // settles) — intentionally excludes the local theme/mode/setters so
    // a member's own stale localStorage doesn't retrigger this loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileLoading, account?.theme, account?.mode]);

  return null;
}
