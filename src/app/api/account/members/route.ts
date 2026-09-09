// ============================================================
// /api/account/members
//
//   GET  — lists every member of the caller's account. Any member
//          can call it (the Members tab is shown to admins+, but
//          agents/viewers see a read-only roster too).
//   POST — owner-only. Creates a teammate's login directly (email +
//          password, chosen by the owner) and drops them straight
//          into the account with the given role. No invite link,
//          no "confirm your email" step.
//
// Field visibility (GET)
//   Sensitive fields (email) are returned only when the caller is
//   admin+. Agents and viewers see name + avatar + role + joined
//   date only. This mirrors the design decision from the planning
//   phase: "agent/viewer sees names only".
// ============================================================

import { NextResponse } from "next/server";

import { getCurrentAccount, requireRole, toErrorResponse } from "@/lib/auth/account";
import { canManageMembers, isAccountRole } from "@/lib/auth/roles";
import { supabaseAdmin } from "@/lib/supabase/admin";
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from "@/lib/rate-limit";
import type { AccountMember } from "@/types";

const MAX_FULL_NAME_LEN = 80;
// Higher than the 6-char floor on the public /signup form: this path
// skips email verification entirely, so the password is the only
// factor standing between the plaintext the owner just typed/shared
// and the account — worth a slightly stronger minimum.
const MIN_PASSWORD_LEN = 8;
// Deliberately loose — Supabase Auth is the real validator and will
// reject anything it doesn't like. This only exists to fail fast with
// a clean 400 instead of round-tripping to the Admin API first.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

interface ProfileRow {
  user_id: string;
  full_name: string | null;
  email: string | null;
  avatar_url: string | null;
  account_role: string;
  created_at: string;
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    // RLS on profiles allows reading any row whose account matches
    // the caller's, so this query is naturally account-scoped.
    const { data, error } = await ctx.supabase
      .from("profiles")
      .select("user_id, full_name, email, avatar_url, account_role, created_at")
      .eq("account_id", ctx.accountId)
      .order("created_at", { ascending: true });

    if (error) {
      console.error("[GET /api/account/members] fetch error:", error);
      return NextResponse.json(
        { error: "Failed to load members" },
        { status: 500 },
      );
    }

    const canSeeEmails = canManageMembers(ctx.role);

    const members: AccountMember[] = (data as ProfileRow[]).flatMap((row) => {
      // Defensive: the DB enum should never let an unknown role
      // through, but if a migration ever broadens the enum without
      // updating TS, skip the row rather than crash the page.
      if (!isAccountRole(row.account_role)) return [];
      return [
        {
          user_id: row.user_id,
          full_name: row.full_name ?? "",
          email: canSeeEmails ? row.email : null,
          avatar_url: row.avatar_url,
          role: row.account_role,
          joined_at: row.created_at,
        },
      ];
    });

    return NextResponse.json({ members });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole("owner");

    const limit = checkRateLimit(
      `admin:memberAdd:${ctx.userId}`,
      RATE_LIMITS.adminAction,
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as
      | { email?: unknown; password?: unknown; fullName?: unknown; role?: unknown }
      | null;

    const email = typeof body?.email === "string" ? body.email.trim() : "";
    if (!EMAIL_RE.test(email)) {
      return NextResponse.json(
        { error: "A valid email is required" },
        { status: 400 },
      );
    }

    const password = typeof body?.password === "string" ? body.password : "";
    if (password.length < MIN_PASSWORD_LEN) {
      return NextResponse.json(
        { error: `Password must be at least ${MIN_PASSWORD_LEN} characters` },
        { status: 400 },
      );
    }

    const role = body?.role;
    if (!isAccountRole(role) || role === "owner") {
      return NextResponse.json(
        { error: "'role' must be one of admin, agent, viewer" },
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

    const admin = supabaseAdmin();

    // `email_confirm: true` is the whole point of this endpoint — it
    // marks the address verified at creation time so the teammate can
    // sign in immediately with the password the owner just set, no
    // "check your inbox" step. The `on_auth_user_created` trigger
    // (migration 017) fires synchronously on this insert and gives the
    // new user a personal account + owner profile, same as a normal
    // signup — we move them out of it below.
    const { data: created, error: createError } =
      await admin.auth.admin.createUser({
        email,
        password,
        email_confirm: true,
        user_metadata: { full_name: fullName },
      });

    if (createError || !created.user) {
      const alreadyExists = /already.*registered|already.*exists/i.test(
        createError?.message ?? "",
      );
      if (alreadyExists) {
        return NextResponse.json(
          { error: "A user with that email already exists" },
          { status: 409 },
        );
      }
      console.error("[POST /api/account/members] createUser error:", createError);
      return NextResponse.json(
        { error: createError?.message || "Failed to create user" },
        { status: 500 },
      );
    }

    const newUserId = created.user.id;

    // Move the fresh profile from its just-created personal account
    // into the caller's account, then drop that now-empty personal
    // account. Mirrors what the `redeem_invitation` RPC does for the
    // token-based flow (migration 019) — this is the direct-add
    // equivalent, safe to do with plain writes because the service-role
    // client bypasses RLS and we know the personal account is empty
    // (the user was created a moment ago).
    const { data: freshProfile, error: profileFetchError } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", newUserId)
      .single();

    if (profileFetchError || !freshProfile) {
      console.error(
        "[POST /api/account/members] profile fetch error:",
        profileFetchError,
      );
      return NextResponse.json(
        {
          error:
            "User was created but could not be linked to the account. Check Settings → Members.",
        },
        { status: 500 },
      );
    }

    const oldAccountId = freshProfile.account_id as string;

    const { error: moveError } = await admin
      .from("profiles")
      .update({ account_id: ctx.accountId, account_role: role, full_name: fullName })
      .eq("user_id", newUserId);

    if (moveError) {
      console.error("[POST /api/account/members] profile move error:", moveError);
      return NextResponse.json(
        {
          error:
            "User was created but could not be linked to the account. Check Settings → Members.",
        },
        { status: 500 },
      );
    }

    if (oldAccountId && oldAccountId !== ctx.accountId) {
      const { error: cleanupError } = await admin
        .from("accounts")
        .delete()
        .eq("id", oldAccountId);
      if (cleanupError) {
        // Non-fatal — an orphaned, empty personal account with no
        // profile pointing at it grants no access to anyone. Log and
        // move on rather than failing a request that already
        // succeeded at the part that matters.
        console.error(
          "[POST /api/account/members] orphan account cleanup error:",
          cleanupError,
        );
      }
    }

    return NextResponse.json(
      {
        ok: true,
        member: {
          user_id: newUserId,
          email,
          full_name: fullName,
          role,
        },
      },
      { status: 201 },
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
