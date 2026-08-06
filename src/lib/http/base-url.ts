// ============================================================
// Deriving this deployment's own public origin from an incoming
// request. Shared by every route that has to build a URL pointing
// back at itself — invite links today, /auth/callback's post-
// exchange redirect as of this module's introduction.
//
// Resolution order, first match wins:
//
//   1. `NEXT_PUBLIC_SITE_URL` — operator's explicit config. Trumps
//      everything; if you set this, that's where these URLs point.
//   2. `X-Forwarded-Host` (+ `X-Forwarded-Proto`) — set by every
//      reverse proxy in front of the app: Hostinger Managed
//      Node.js, Vercel, Cloudflare, nginx. This is what makes
//      self-referential URLs Just Work in production without
//      forcing the operator to set an env var.
//   3. `Host` header + the protocol the request arrived on —
//      bare deployments without a proxy.
//   4. Caller-supplied fallback. What's appropriate here is
//      caller-specific (a marketing-site 404 page is fine to fall
//      back to for an invite link nobody will click yet; an auth
//      redirect needs a same-origin fallback or the user's session
//      cookie won't apply) — see individual call sites.
//
// Defense-in-depth: `ALLOWED_INVITE_HOSTS`
//
//   The request-header path (#2 and #3 above) trusts whatever
//   hostname the client (or proxy) puts in the header. On a typical
//   proxied deploy (Vercel / Hostinger / Cloudflare) the proxy
//   overwrites these so they're trustworthy. On a bare deployment
//   exposed to the public internet, an attacker could send a request
//   directly with a crafted `Host: phishing.example` and receive a
//   self-referential URL pointing at their site.
//
//   When `ALLOWED_INVITE_HOSTS` is set (comma-separated hostnames),
//   the derived host is validated against the list; anything not on
//   it falls through to the caller's fallback with a loud
//   console.warn. The env var name predates this module (it started
//   as invite-link-only) but the allow-list question — "which hosts
//   may this deployment claim to be" — is identical for every
//   self-referential URL, so it's kept as the one list rather than
//   growing a second, differently-named var with the same meaning.
// ============================================================

function parseAllowedHosts(): readonly string[] | null {
  const raw = process.env.ALLOWED_INVITE_HOSTS?.trim();
  if (!raw) return null;
  const list = raw
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  return list.length > 0 ? list : null;
}

function isHostAllowed(
  hostname: string,
  allowList: readonly string[] | null,
): boolean {
  if (!allowList) return true; // No allow-list → permissive (legacy behavior).
  return allowList.includes(hostname.toLowerCase());
}

export interface ResolveOriginOptions {
  /**
   * Returned when neither header path yields an allow-listed host
   * (or no Host header was present at all). Caller-specific: pick
   * whatever makes sense to send a user to when the request looked
   * unreliable or the operator locked down `ALLOWED_INVITE_HOSTS`.
   */
  fallback: string;
  /** Prefix on the console.warn logged when the fallback is used, so
   *  the operator can tell which route hit it. */
  logContext: string;
}

/**
 * Resolve this deployment's own origin (scheme + host, no trailing
 * slash) from an incoming request, per the resolution order above.
 */
export function resolveRequestOrigin(
  request: Request,
  { fallback, logContext }: ResolveOriginOptions,
): string {
  const explicit = process.env.NEXT_PUBLIC_SITE_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");

  const allowList = parseAllowedHosts();
  const forwardedHost = request.headers
    .get("x-forwarded-host")
    ?.split(",")[0]
    ?.trim();
  const forwardedProto = request.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim();
  if (forwardedHost && isHostAllowed(forwardedHost, allowList)) {
    return `${forwardedProto || "https"}://${forwardedHost}`;
  }

  const host = request.headers.get("host")?.trim();
  if (host && isHostAllowed(host, allowList)) {
    // The protocol on `request.url` is whatever the framework saw —
    // reliable for bare deployments where no proxy is rewriting it.
    const reqProto = new URL(request.url).protocol.replace(":", "");
    return `${reqProto}://${host}`;
  }

  // Falls through here when EITHER no Host header was present at all
  // (essentially impossible from a real browser) OR an
  // ALLOWED_INVITE_HOSTS list was set and neither candidate matched
  // it. The warning is the operator's signal that someone is probing
  // with a spoofed Host header.
  if (allowList && (forwardedHost || host)) {
    console.warn(
      `[${logContext}] rejected non-allow-listed host:`,
      { forwardedHost, host, allowList },
    );
  } else {
    console.warn(
      `[${logContext}] could not derive base URL from request; using fallback`,
    );
  }
  return fallback;
}
