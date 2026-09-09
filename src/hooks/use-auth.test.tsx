// P0-BUG-03 — a null-session event is a question, not an answer.
//
// P0-BUG-01 measured the old behaviour: SIGNED_OUT arrived and 3 ms
// later the shell had already redirected, with no opportunity for
// anything to check whether the session was really gone. These tests
// pin the confirmation step that closes that window.
//
// The distinction that matters throughout: a *definitive* answer from
// the server ends the session; a transport failure does not. Getting
// that backwards is how a flaky network turns into "the app logged me
// out and lost my work".

import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/diagnostics/auth-trace", () => ({
  recordAuthTrace: vi.fn(),
  installAuthTraceHandle: vi.fn(),
}));

/** Captures the callback the provider registers, so tests can fire events. */
let emitAuthEvent: (event: string, session: unknown) => void = () => {};

const getUser = vi.fn();
const getSession = vi.fn();
const signOut = vi.fn();
const maybeSingle = vi.fn();

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    auth: {
      getSession,
      getUser,
      signOut,
      onAuthStateChange: (cb: (event: string, session: unknown) => void) => {
        emitAuthEvent = cb;
        return { data: { subscription: { unsubscribe: vi.fn() } } };
      },
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle, limit: () => ({ maybeSingle }) }),
      }),
    }),
  }),
}));

const { AuthProvider, useAuth } = await import("./use-auth");

function Probe() {
  const { user, loading } = useAuth();
  return (
    <div>
      <span data-testid="user">{user ? user.id : "none"}</span>
      <span data-testid="loading">{String(loading)}</span>
    </div>
  );
}

const SESSION = { user: { id: "u1" } };

/** Definitive "you are not signed in" — an answer, not a failure. */
const UNAUTHORISED = Object.assign(new Error("Unauthorized"), {
  name: "AuthApiError",
  status: 401,
});

/**
 * What supabase-js actually returns when the stored session is gone:
 * AuthSessionMissingError, status 400 (auth-js errors.js:115-118). This
 * is the real-world confirmed-sign-out path, so it is worth pinning by
 * shape rather than trusting the generic 401 above to stand in for it.
 */
const SESSION_MISSING = Object.assign(new Error("Auth session missing!"), {
  name: "AuthSessionMissingError",
  status: 400,
});

/** The network let us down. Says nothing about the session. */
const NETWORK_DOWN = Object.assign(new Error("Failed to fetch"), {
  name: "AuthRetryableFetchError",
  status: 0,
});

async function renderSignedIn() {
  getSession.mockResolvedValue({ data: { session: SESSION }, error: null });
  maybeSingle.mockResolvedValue({ data: null, error: null });

  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  );
  await waitFor(() => expect(screen.getByTestId("user").textContent).toBe("u1"));
}

describe("AuthProvider — confirma el cierre de sesión antes de aplicarlo", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getUser.mockReset();
    getSession.mockReset();
    maybeSingle.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("un SIGNED_OUT transitorio seguido de sesión válida no cierra sesión", async () => {
    await renderSignedIn();

    // The event arrives, but the session is actually fine — this is the
    // rotation race from docs/p0-bug-01-informe.md.
    getUser.mockResolvedValue({ data: { user: SESSION.user }, error: null });
    act(() => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    // Crucially, nothing happens immediately. The old code cleared the
    // user here, which is what destroyed the inbox.
    expect(screen.getByTestId("user").textContent).toBe("u1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    // Confirmation refuted the event; the user was never signed out.
    expect(screen.getByTestId("user").textContent).toBe("u1");
    expect(getUser).toHaveBeenCalled();
  });

  it("un cierre de sesión real confirmado por el servidor sí se aplica", async () => {
    await renderSignedIn();

    getUser.mockResolvedValue({ data: { user: null }, error: UNAUTHORISED });
    act(() => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    await waitFor(() =>
      expect(screen.getByTestId("user").textContent).toBe("none"),
    );
  });

  it("AuthSessionMissingError sí cierra sesión", async () => {
    await renderSignedIn();

    getUser.mockResolvedValue({ data: { user: null }, error: SESSION_MISSING });
    act(() => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    await waitFor(() =>
      expect(screen.getByTestId("user").textContent).toBe("none"),
    );
  });

  it("un fallo de red NO cierra sesión", async () => {
    await renderSignedIn();

    // The same mistake auth-js itself refuses to make. Authorisation is
    // enforced by the proxy and RLS, so keeping a possibly-stale user
    // in state costs nothing but a stale screen; dropping it costs the
    // user their work.
    getUser.mockResolvedValue({ data: { user: null }, error: NETWORK_DOWN });
    act(() => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    expect(screen.getByTestId("user").textContent).toBe("u1");
  });

  it("una sesión que vuelve durante la ventana cancela la confirmación", async () => {
    await renderSignedIn();

    getUser.mockResolvedValue({ data: { user: null }, error: UNAUTHORISED });
    act(() => {
      emitAuthEvent("SIGNED_OUT", null);
    });

    // auth-js recovers and re-emits before the window elapses.
    act(() => {
      emitAuthEvent("SIGNED_IN", SESSION);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2_000);
    });

    // The pending check must not fire and undo the recovery.
    expect(screen.getByTestId("user").textContent).toBe("u1");
    expect(getUser).not.toHaveBeenCalled();
  });
});
