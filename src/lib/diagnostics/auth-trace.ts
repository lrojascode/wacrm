// ============================================================
// Auth transition tracing — diagnostic for the inbox expulsion bug
// (task P0-BUG-01).
//
// What it answers: when a signed-in user is thrown out of the inbox
// and lands back on the dashboard, which auth event preceded it, and
// was the session cookie still present at that moment?
//
// That last question is the one that matters. A `SIGNED_OUT` arriving
// while the auth cookie is still in the jar is not a sign-out — it is
// a transient event that the app is treating as one. Distinguishing
// the two is the whole point of this instrumentation, and neither the
// browser console nor a server log can tell them apart on its own.
//
// WHY sessionStorage AND NOT AN IN-MEMORY ARRAY
//
// The failure being traced ends in a full-page navigation:
// dashboard-shell pushes /login, the proxy bounces that to /dashboard,
// and the document is replaced. Anything held in a module-level
// variable dies exactly at the moment of interest, leaving a log that
// stops just before the event it was written to capture.
// sessionStorage survives same-tab navigation, so the record of "what
// happened right before the bounce" is still there afterwards.
//
// Off unless NEXT_PUBLIC_AUTH_TRACE=1. This writes on every auth event
// and reads document.cookie; it is a staging diagnostic, not something
// to leave running for every customer.
// ============================================================

const STORAGE_KEY = "wacrm:diag:auth-trace";

/** Bounded so a long-lived tab cannot grow the entry without limit. */
const MAX_ENTRIES = 200;

export type AuthTraceKind =
  /** An event from supabase auth-js `onAuthStateChange`. */
  | "auth-event"
  /** The dashboard shell decided the user is signed out and redirected. */
  | "expulsion"
  /** Tab visibility changed — the suspected trigger. */
  | "visibility";

export interface AuthTraceEntry {
  kind: AuthTraceKind;
  /** Event name for `auth-event`; a short reason for the others. */
  label: string;
  /** Wall clock, so entries can be correlated with server logs. */
  at: string;
  /** Monotonic, for measuring the gap between two entries precisely. */
  t: number;
  /** `document.visibilityState` at the time. */
  visibility: string;
  /** `location.pathname` — tells us whether the user was in the inbox. */
  path: string;
  /**
   * Whether supabase's auth cookie was still present.
   *
   * The discriminator between a real sign-out (cookie gone) and a
   * spurious one (cookie intact, so the proxy will happily bounce the
   * resulting /login visit straight back to /dashboard).
   */
  hasAuthCookie: boolean;
  /** For `auth-event`: whether the event carried a session at all. */
  hasSession?: boolean;
}

export function isAuthTraceEnabled(): boolean {
  return process.env.NEXT_PUBLIC_AUTH_TRACE === "1";
}

/**
 * Supabase's browser client stores the session in a cookie named
 * `sb-<project-ref>-auth-token`, chunked with `.0` / `.1` suffixes when
 * it is large. Match on the prefix rather than reconstructing the exact
 * name, which depends on the project URL.
 */
function hasAuthCookie(): boolean {
  if (typeof document === "undefined") return false;
  return document.cookie
    .split(";")
    .some((c) => /^\s*sb-.*-auth-token(\.\d+)?=/.test(c) && !/=\s*$/.test(c));
}

function read(): AuthTraceEntry[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as AuthTraceEntry[]) : [];
  } catch {
    // Corrupt or unavailable storage must never break the app it is
    // only observing.
    return [];
  }
}

function write(entries: AuthTraceEntry[]): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(-MAX_ENTRIES)));
  } catch {
    // Quota or private-browsing failures are not worth surfacing.
  }
}

export function recordAuthTrace(
  kind: AuthTraceKind,
  label: string,
  extra: { hasSession?: boolean } = {},
): void {
  if (!isAuthTraceEnabled() || typeof window === "undefined") return;

  const entry: AuthTraceEntry = {
    kind,
    label,
    at: new Date().toISOString(),
    t: Math.round(performance.now()),
    visibility: typeof document === "undefined" ? "unknown" : document.visibilityState,
    path: window.location.pathname,
    hasAuthCookie: hasAuthCookie(),
    ...extra,
  };

  write([...read(), entry]);

  // An expulsion is the event under investigation, so it is loud. The
  // rest stay in storage and are read on demand — logging every auth
  // event would bury the one line that matters.
  if (kind === "expulsion") {
    const recent = read().slice(-6);
    console.warn(
      `[auth-trace] EXPULSION from ${entry.path} — reason=${label}, ` +
        `auth cookie ${entry.hasAuthCookie ? "STILL PRESENT" : "gone"}, ` +
        `visibility=${entry.visibility}`,
      { recent },
    );
  }
}

export function readAuthTrace(): AuthTraceEntry[] {
  return read();
}

export function clearAuthTrace(): void {
  if (typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

/**
 * Expose a read handle on `window` so an operator reproducing the bug
 * on staging can paste the trace into a report without a debugger, and
 * so E2E specs can assert on it.
 */
export function installAuthTraceHandle(): void {
  if (!isAuthTraceEnabled() || typeof window === "undefined") return;
  (window as unknown as Record<string, unknown>).__authTrace = readAuthTrace;
  (window as unknown as Record<string, unknown>).__authTraceClear = clearAuthTrace;
}
