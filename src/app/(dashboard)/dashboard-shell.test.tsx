// P0-BUG-02 — the dashboard shell must not unmount its children when
// auth wobbles.
//
// The bug this pins: the shell used to return a spinner (or `null`) in
// place of `children`, which unmounts the whole subtree. Everything the
// inbox holds in React state — the open conversation, its messages, the
// list filters, the search box, the scroll position — was destroyed by
// any transient auth event, even one that resolved a moment later.
//
// The test proves it structurally rather than by inspecting the DOM
// alone: the child counts its own mounts. A remount is invisible in a
// snapshot of the markup (the same HTML comes back) but is exactly what
// loses the state, so counting is the only assertion that catches it.

import { render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The shell pulls in the sidebar, header, presence heartbeat, theme
// sync and call provider — all of which reach for supabase, next-intl
// and browser APIs. None of that is under test here; the question is
// purely whether `children` survive an auth transition.
vi.mock("@/components/layout/sidebar", () => ({ Sidebar: () => null }));
vi.mock("@/components/layout/header", () => ({ Header: () => null }));
vi.mock("@/components/presence/presence-heartbeat", () => ({
  PresenceHeartbeat: () => null,
}));
vi.mock("@/components/layout/account-theme-sync", () => ({
  AccountThemeSync: () => null,
}));
vi.mock("@/components/calls/call-provider", () => ({
  CallProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/lib/diagnostics/auth-trace", () => ({
  recordAuthTrace: vi.fn(),
  installAuthTraceHandle: vi.fn(),
}));

const push = vi.fn();
const replace = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push, replace }),
  usePathname: () => "/inbox",
}));

// P0-SEC-09: el shell llama a `useMfaGate`, que consulta el nivel de
// autenticación de la sesión local. Se deja correr el hook DE VERDAD
// —en vez de sustituirlo por un no-op— para que este archivo siga
// respondiendo a su pregunta con el shell completo: si el redirect a
// /mfa desmontara el árbol, sería el mismo bug que P0-BUG-02 arregló,
// entrando por otra puerta.
let assuranceLevel = "aal2";
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: assuranceLevel, nextLevel: assuranceLevel },
          error: null,
        }),
      },
    },
  }),
}));

// Drives `useAuth` from the test body, standing in for the real
// provider so an auth transition can be triggered on demand.
let authState: {
  user: { id: string } | null;
  loading: boolean;
  accountRole?: string | null;
  profileLoading?: boolean;
} = {
  user: null,
  loading: true,
  accountRole: "agent",
  profileLoading: false,
};
vi.mock("@/hooks/use-auth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }: { children: React.ReactNode }) => children,
}));

const { DashboardShell } = await import("./dashboard-shell");

/**
 * A child that records how many times it has been mounted and keeps a
 * piece of state, standing in for the inbox's open conversation.
 */
function StatefulChild({ onMount }: { onMount: () => void }) {
  // The identity of this value is the evidence. It is generated once
  // per mount, so if it changes between assertions the subtree was
  // torn down and rebuilt — which is precisely the state loss under
  // test, and is invisible in the rendered markup alone.
  const [value] = useState(() => `conversación-${Math.random()}`);
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <div data-testid="child">{value}</div>;
}

describe("DashboardShell — el árbol sobrevive a las transiciones de auth", () => {
  beforeEach(() => {
    authState = {
      user: null,
      loading: true,
      accountRole: "agent",
      profileLoading: false,
    };
    assuranceLevel = "aal2";
    replace.mockClear();
    push.mockClear();
  });

  it("no monta children antes de la primera sesión", () => {
    const onMount = vi.fn();
    render(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    // An anonymous visitor must not mount the dashboard tree at all.
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByTestId("child")).toBeNull();
  });

  it("mantiene children montados cuando loading vuelve a true", () => {
    const onMount = vi.fn();
    authState = { ...authState, user: { id: "u1" }, loading: false };

    const { rerender } = render(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    const first = screen.getByTestId("child").textContent;
    expect(onMount).toHaveBeenCalledTimes(1);

    // The transition under test.
    authState = { ...authState, user: { id: "u1" }, loading: true };
    rerender(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    // Still exactly one mount: the subtree was never torn down, so the
    // state it held is the same object it was before.
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("child").textContent).toBe(first);
    // And the user is told something is happening.
    expect(screen.getByTestId("session-overlay")).toBeInTheDocument();
  });

  it("mantiene children montados cuando el usuario se vuelve null", () => {
    const onMount = vi.fn();
    authState = { ...authState, user: { id: "u1" }, loading: false };

    const { rerender } = render(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );
    const first = screen.getByTestId("child").textContent;

    // This is the reproduced expulsion from P0-BUG-01: a SIGNED_OUT
    // arrives and `user` drops to null. The redirect may well fire —
    // that is P0-BUG-03's problem — but the working context must not be
    // destroyed on the way out, because the session often comes back.
    authState = { ...authState, user: null, loading: false };
    rerender(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("child").textContent).toBe(first);
    expect(screen.getByTestId("session-overlay")).toBeInTheDocument();
  });

  it("vuelve a mostrar la app sin remontar cuando la sesión se recupera", () => {
    const onMount = vi.fn();
    authState = { ...authState, user: { id: "u1" }, loading: false };

    const { rerender } = render(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );
    const first = screen.getByTestId("child").textContent;

    authState = { ...authState, user: null, loading: false };
    rerender(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    authState = { ...authState, user: { id: "u1" }, loading: false };
    rerender(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    // The whole point: the user comes back to the same working context,
    // not a freshly reset one.
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("child").textContent).toBe(first);
    expect(screen.queryByTestId("session-overlay")).toBeNull();
  });
});

describe("DashboardShell — el redirect a /mfa no cuesta el árbol (P0-SEC-09)", () => {
  it("un owner sin segundo factor va a /mfa y los children siguen montados", async () => {
    // El redirect es de conveniencia; desmontar para hacerlo tiraría
    // exactamente el estado que P0-BUG-02 protege — y esta vez sin que
    // hubiera pasado nada raro con la sesión.
    authState = {
      user: { id: "u1" },
      loading: false,
      accountRole: "owner",
      profileLoading: false,
    };
    assuranceLevel = "aal1";

    const onMount = vi.fn();
    render(
      <DashboardShell>
        <StatefulChild onMount={onMount} />
      </DashboardShell>,
    );

    await vi.waitFor(() => expect(replace).toHaveBeenCalled());
    expect(String(replace.mock.calls[0][0])).toContain("/mfa");
    // Uno, no cero y no dos: montado una vez y nunca reconstruido.
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("child")).toBeTruthy();
  });

  it("a un agent no lo manda a ninguna parte", async () => {
    // «Un agent no se ve afectado», comprobado en la UI además de en
    // el servidor.
    authState = {
      user: { id: "u1" },
      loading: false,
      accountRole: "agent",
      profileLoading: false,
    };
    assuranceLevel = "aal1";

    render(
      <DashboardShell>
        <StatefulChild onMount={vi.fn()} />
      </DashboardShell>,
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(replace).not.toHaveBeenCalled();
  });
});
