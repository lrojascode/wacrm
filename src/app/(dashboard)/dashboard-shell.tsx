"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { AccountThemeSync } from "@/components/layout/account-theme-sync";
import { CallProvider } from "@/components/calls/call-provider";
import { recordAuthTrace } from "@/lib/diagnostics/auth-trace";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Sidebar drawer state — only used on mobile. On lg+ the sidebar is
  // always visible and this stays at `false` (ignored by the component).
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  /**
   * Has a session ever resolved during this mount?
   *
   * This is the latch that separates "the app has not loaded yet" from
   * "the app is loaded and something momentarily went wrong with auth".
   * The two need opposite handling: the first should not render the
   * dashboard at all, the second must never stop rendering it.
   *
   * Deliberately one-way. It is not reset when `user` goes null,
   * because that is exactly the moment the guarantee is needed. A real
   * sign-out replaces the document anyway (`signOut` in use-auth.tsx
   * uses `window.location.href`), so a stale latch cannot outlive the
   * session it refers to.
   */
  // Set during render, not in an effect. This is React's documented
  // "adjusting state while rendering" pattern: the update is applied
  // before the browser paints, so the shell never renders one frame in
  // the pre-auth branch after the session has already arrived. Doing it
  // in an effect would both flash that frame and trip
  // react-hooks/set-state-in-effect.
  const [hasAuthenticated, setHasAuthenticated] = useState(false);
  if (user && !hasAuthenticated) {
    setHasAuthenticated(true);
  }

  useEffect(() => {
    if (!loading && !user) {
      // P0-BUG-01. This is the exact decision under investigation: the
      // shell has concluded the user is signed out and is about to
      // leave the page. The trace entry records whether the auth cookie
      // was still in the jar — if it was, the proxy will bounce this
      // /login visit straight to /dashboard and the user experiences it
      // as "the app threw me out of the inbox" rather than as a logout.
      recordAuthTrace("expulsion", "shell:no-user");
      router.push("/login");
    }
  }, [user, loading, router]);

  // Before the first successful session there is nothing to preserve,
  // so the cheap path is fine: show a spinner, or nothing at all while
  // the redirect to /login runs. `children` are deliberately NOT
  // rendered here — an anonymous visitor should never mount the whole
  // dashboard tree, and on a cold load no state exists to lose.
  if (!hasAuthenticated) {
    if (loading) {
      return (
        <div className="flex h-screen items-center justify-center bg-background">
          <div className="flex flex-col items-center gap-3">
            <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
            <p className="text-sm text-muted-foreground">Loading...</p>
          </div>
        </div>
      );
    }
    return null;
  }

  // Past this point the user HAS been authenticated at least once in
  // this mount, so `children` stay mounted no matter what auth does
  // next.
  //
  // This is the fix for the state loss in the inbox expulsion bug
  // (P0-BUG-02, defect A). The previous version returned a spinner or
  // `null` in place of `children`, which unmounts the whole subtree —
  // and with it the open conversation, the loaded messages, the list
  // filters, the search box and the scroll position. A transient auth
  // blip therefore destroyed the user's working context irrecoverably,
  // even when the session came straight back.
  //
  // The measurement in docs/p0-bug-01-informe.md showed the expulsion
  // can fire while the tab is hidden, so the user never sees it happen;
  // they return to find their work gone. Keeping the tree mounted means
  // that even if a redirect does fire, nothing is lost in the meantime.
  const showSessionOverlay = loading || !user;

  return (
    <CallProvider>
      <div className="relative flex h-screen overflow-hidden bg-background">
        {/* Reports this tab's online/away presence once we know a user is
            signed in. Headless — renders nothing. */}
        <PresenceHeartbeat />
        {/* Applies the account's stored appearance once it loads.
            Headless — renders nothing. */}
        <AccountThemeSync />
        <Sidebar open={sidebarOpen} onClose={closeSidebar} />
        <div className="flex flex-1 flex-col overflow-hidden">
          <Header onOpenSidebar={() => setSidebarOpen(true)} />
          {/* Thinner horizontal padding on mobile so cards have room to breathe. */}
          <main className="flex-1 overflow-y-auto p-4 sm:p-6">{children}</main>
        </div>

        {/* Covers the app while the session is being re-established.
            An overlay rather than a replacement: it hides the UI from
            the user without taking it away from React. `aria-hidden` on
            the content is not needed because the overlay traps nothing
            — it is transient and non-interactive by design. */}
        {showSessionOverlay && (
          <div
            data-testid="session-overlay"
            className="absolute inset-0 z-50 flex items-center justify-center bg-background/80 backdrop-blur-sm"
          >
            <div className="flex flex-col items-center gap-3">
              <div className="h-8 w-8 animate-spin rounded-full border-2 border-primary border-t-transparent" />
              <p className="text-sm text-muted-foreground">Loading...</p>
            </div>
          </div>
        )}
      </div>
    </CallProvider>
  );
}

export function DashboardShell({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <DashboardShellInner>{children}</DashboardShellInner>
    </AuthProvider>
  );
}
