import { NextResponse } from "next/server";
import { createClient } from "@/lib/supabase/server";
import { resolveRequestOrigin } from "@/lib/http/base-url";

/**
 * GET /auth/callback — PKCE code-exchange landing page.
 *
 * The only current caller is /forgot-password, which points
 * `resetPasswordForEmail`'s `redirectTo` here with `?next=/reset-password`
 * (src/app/(auth)/forgot-password/page.tsx). Supabase's own
 * `/auth/v1/verify` endpoint validates the emailed token server-side
 * first, then 302s here with a `?code=` param — this route's only job
 * is exchanging that code for a session cookie before handing off to
 * `next`. Written generically (not hardcoded to the recovery flow) so
 * a future magic-link or OAuth flow can reuse it the same way.
 *
 * `origin` is derived via resolveRequestOrigin (@/lib/http/base-url),
 * not read straight off `request.url`: behind Hostinger's (or any)
 * reverse proxy, the URL Next.js sees can differ from the public one a
 * browser needs to land back on, and building the redirect from the
 * wrong origin would send the user to an unreachable internal host
 * instead of finishing the reset. Same helper already used to build
 * invite links (src/app/api/account/invitations/route.ts) — this
 * route's fallback is same-origin instead of the marketing site, since
 * a real session cookie only applies to the host that set it.
 *
 * Reference implementation: https://supabase.com/docs/guides/auth/server-side/nextjs
 */
export async function GET(request: Request) {
  const requestUrl = new URL(request.url);
  const origin = resolveRequestOrigin(request, {
    fallback: requestUrl.origin,
    logContext: "GET /auth/callback",
  });
  const code = requestUrl.searchParams.get("code");

  // Open-redirect guard: `next` must be a same-origin path. `/` alone
  // isn't enough — `//evil.com` also starts with `/` but the browser
  // resolves it as protocol-relative to a different host.
  const rawNext = requestUrl.searchParams.get("next") ?? "/dashboard";
  const next =
    rawNext.startsWith("/") && !rawNext.startsWith("//") ? rawNext : "/dashboard";

  if (code) {
    const supabase = await createClient();
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) {
      return NextResponse.redirect(`${origin}${next}`);
    }
  }

  // Missing or already-used/expired code. Send back to forgot-password
  // (the only sender today) with a flag it reads to show why the link
  // didn't work, rather than a bare redirect to a page expecting an
  // active recovery session that was never established.
  return NextResponse.redirect(`${origin}/forgot-password?error=link_invalid`);
}
