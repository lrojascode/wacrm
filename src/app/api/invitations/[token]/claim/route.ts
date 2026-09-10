// ============================================================
// POST /api/invitations/[token]/claim — create an account from an
// invitation, now that public signup is closed (P0-SEC-08).
//
// WHY THIS ROUTE HAS TO EXIST
//
// `supabase.auth.signUp()` runs in the browser and talks to Supabase
// directly. Gating it in this app — hiding the form, checking a token
// in the page, adding a rule to the proxy — is theatre: the anon key
// ships inside the JS bundle, so anyone can POST to
// `/auth/v1/signup` themselves. Measured before this change, that one
// request returned an access token AND made the caller `owner` of a
// brand-new tenant.
//
// The only control that actually closes it is Supabase's own
// `enable_signup = false`. But that switch blocks every self-serve
// signup, invited people included, and GoTrue's admin endpoints are
// explicitly exempt from it ("block all signups (invites still
// work)"). So the invited path has to move server-side — here — where
// the invitation token can be checked before an account exists.
//
// THE TOKEN IS THE AUTHORISATION
//
// `account_invitations` has no email column: an invite is a bearer
// secret, and whoever holds a valid link picks the address they
// register with. That is unchanged from the previous flow — before
// this route, holding the link plus public signup got you exactly the
// same thing. What changes is that WITHOUT a valid link you now get
// nothing at all.
//
// WHAT THIS ROUTE DELIBERATELY DOES NOT DO
//
// It does not redeem. Joining the account stays the job of
// `redeem_invitation` (migration 019), which runs as the new user and
// is what marks the token used. Creating the user here and redeeming
// there keeps one source of truth for membership, and leaves the
// order of events identical to the old signup → redeem flow.
// ============================================================

import { NextResponse } from "next/server";

import { hashInviteToken } from "@/lib/auth/invitations";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import { createClient } from "@/lib/supabase/server";
import { supabaseAdmin } from "@/lib/supabase/admin";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LEN = 8;
const MAX_FULL_NAME_LEN = 100;

function getClientIp(request: Request): string {
  const xff = request.headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0].trim();
  const xri = request.headers.get("x-real-ip");
  if (xri) return xri.trim();
  return "unknown";
}

interface PeekResult {
  ok: boolean;
  reason?: string;
  account_name?: string;
  role?: string;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> },
) {
  const { token } = await params;
  if (!token || typeof token !== "string") {
    return NextResponse.json({ error: "Missing invitation token" }, { status: 400 });
  }

  const tokenHash = hashInviteToken(token);

  // Two buckets, not one. Per-IP bounds a scripted attacker; per-token
  // bounds the holder of one valid link from minting accounts in bulk.
  const ip = getClientIp(request);
  for (const key of [`claim:ip:${ip}`, `claim:token:${tokenHash}`]) {
    const limit = checkRateLimit(key, RATE_LIMITS.invitationClaim);
    if (!limit.success) return rateLimitResponse(limit);
  }

  const body = (await request.json().catch(() => null)) as
    | { email?: unknown; password?: unknown; fullName?: unknown }
    | null;

  const email = typeof body?.email === "string" ? body.email.trim() : "";
  if (!EMAIL_RE.test(email)) {
    return NextResponse.json({ error: "A valid email is required" }, { status: 400 });
  }

  const password = typeof body?.password === "string" ? body.password : "";
  if (password.length < MIN_PASSWORD_LEN) {
    return NextResponse.json(
      { error: `Password must be at least ${MIN_PASSWORD_LEN} characters` },
      { status: 400 },
    );
  }

  let fullName = "";
  if (typeof body?.fullName === "string") {
    const trimmed = body.fullName.trim();
    if (trimmed.length > MAX_FULL_NAME_LEN) {
      return NextResponse.json(
        { error: `Name must be ${MAX_FULL_NAME_LEN} characters or fewer` },
        { status: 400 },
      );
    }
    fullName = trimmed;
  }

  // Validate the invitation BEFORE creating anything. `peek_invitation`
  // is the same SECURITY DEFINER function the /join page already uses,
  // so "valid" means exactly what it means there: exists, unused, and
  // not expired.
  const supabase = await createClient();
  const { data: peek, error: peekError } = await supabase.rpc("peek_invitation", {
    p_token_hash: tokenHash,
  });

  if (peekError) {
    console.error("[claim] peek rpc error:", peekError);
    return NextResponse.json({ error: "Could not verify the invitation" }, { status: 500 });
  }

  const result = peek as PeekResult | null;
  if (!result?.ok) {
    // One shape for every rejection reason. Distinguishing "expired"
    // from "not found" here would confirm to a guesser that a token
    // exists, which is the one bit a 256-bit token is meant to hide.
    // The /join page still shows the precise reason -- it asks `peek`,
    // which is rate-limited and creates nothing.
    return NextResponse.json(
      { error: "This invitation is not valid. Ask for a fresh link." },
      { status: 403 },
    );
  }

  // `email_confirm: true` matches the direct-add path in
  // /api/account/members: the invitation link is what proves this
  // person was meant to have access, and requiring a second round trip
  // through an inbox would strand them if SMTP is not configured --
  // which is the default. The verified-email gate in
  // `getCurrentAccount` still applies to everyone; this is what makes
  // an invited user satisfy it.
  const admin = supabaseAdmin();
  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
    user_metadata: { full_name: fullName },
  });

  if (createError || !created?.user) {
    const alreadyExists = /already.*registered|already.*exists/i.test(
      createError?.message ?? "",
    );
    if (alreadyExists) {
      // Not an error worth hiding: the person is trying to join with an
      // address that already has a login, and the fix is to sign in and
      // open the same link.
      return NextResponse.json(
        {
          error: "An account with that email already exists. Sign in, then open the invitation link again.",
          code: "email_exists",
        },
        { status: 409 },
      );
    }
    console.error("[claim] createUser error:", createError);
    return NextResponse.json({ error: "Could not create the account" }, { status: 500 });
  }

  // The caller signs in next, then POSTs to .../redeem, which is what
  // actually joins them to the account and consumes the token.
  return NextResponse.json({ ok: true }, { status: 201 });
}
