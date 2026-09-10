"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthProvider, useAuth } from "@/hooks/use-auth";
import { Sidebar } from "@/components/layout/sidebar";
import { Header } from "@/components/layout/header";
import { PresenceHeartbeat } from "@/components/presence/presence-heartbeat";
import { AccountThemeSync } from "@/components/layout/account-theme-sync";
import { CallProvider } from "@/components/calls/call-provider";
import { useMfaGate } from "@/hooks/use-mfa-gate";
import { recordAuthTrace } from "@/lib/diagnostics/auth-trace";
import { buildLoginPath } from "@/lib/auth/next-path";

// Auth-gated dashboard shell. Extracted from the layout so the layout
// itself can stay a server component and export metadata (noindex) —
// client components can't export Next's metadata object.

function DashboardShellInner({ children }: { children: React.ReactNode }) {
  const { user, loading } = useAuth();
  const router = useRouter();

  // Quien administra la cuenta y no tiene segundo factor va a /mfa
  // (P0-SEC-09). Redirect de conveniencia: el control real devuelve
  // 403 en la API. No desmonta nada, así que no toca la garantía de
  // P0-BUG-02 sobre mantener el árbol montado.
  useMfaGate();

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
      // Reaching here now means the sign-out was *confirmed* against
      // the server (see use-auth.tsx), not merely reported. The trace
      // entry stays because it is still the cheapest way to spot a
      // wrong confirmation in staging: an expulsion logged with the
      // auth cookie still present is one that should not have happened.
      recordAuthTrace("expulsion", "shell:no-user");
      // Carry where they were, so signing back in returns them to the
      // same conversation instead of dropping them on the dashboard —
      // which is the "it threw me back to the start" half of the report.
      // `buildLoginPath` drops anything that is not a safe in-app path.
      router.push(
        buildLoginPath(
          typeof window === "undefined"
            ? null
            : `${window.location.pathname}${window.location.search}`,
        ),
      );
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
