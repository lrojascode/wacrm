"use client";

// ============================================================
// /signup — invitation only (P0-SEC-08).
//
// This page no longer calls `supabase.auth.signUp()`. That call went
// from the browser straight to Supabase, so nothing rendered here
// could gate it: the anon key ships in the JS bundle, and a single
// anonymous POST to /auth/v1/signup returned an access token and made
// the caller `owner` of a brand-new tenant.
//
// The control that actually closes that is Supabase's own
// `enable_signup = false`. With it off, self-serve signup is gone for
// everyone, so the invited path moves to a server route that can
// check the invitation before an account exists:
// POST /api/invitations/<token>/claim.
//
// What this page does now is honest about that: with no invitation it
// says so plainly instead of showing a form that would fail at submit.
// ============================================================

import { Suspense, useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { CheckCircle, Loader2, ShieldCheck, UsersRound } from "lucide-react";

const MIN_PASSWORD_LEN = 8;

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

interface PeekOk {
  ok: true;
  account_name: string;
  role: string;
}
interface PeekFail {
  ok: false;
  reason: string;
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-md border-border bg-card">{children}</Card>
    </div>
  );
}

function SignupPageInner() {
  const t = useTranslations("SignupPage");
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get("invite");

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [created, setCreated] = useState(false);
  // undefined = still checking; null = no token to check.
  const [peek, setPeek] = useState<PeekOk | PeekFail | null | undefined>(
    inviteToken ? undefined : null,
  );

  // Check the invitation before rendering a form. Without this a dead
  // link would show a full signup form that only fails on submit,
  // after the person has typed everything.
  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(
          `/api/invitations/${encodeURIComponent(inviteToken)}/peek`,
          { cache: "no-store" },
        );
        const body = (await res.json()) as PeekOk | PeekFail;
        if (!cancelled) setPeek(body);
      } catch {
        if (!cancelled) setPeek({ ok: false, reason: "server_error" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inviteToken]);

  const handleSignup = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      setError(null);

      if (password !== confirmPassword) {
        setError(t("errorPasswordMismatch"));
        return;
      }
      if (password.length < MIN_PASSWORD_LEN) {
        setError(t("errorPasswordShort8"));
        return;
      }

      setLoading(true);
      try {
        const res = await fetch(
          `/api/invitations/${encodeURIComponent(inviteToken!)}/claim`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, password, fullName }),
          },
        );
        if (!res.ok) {
          const body = (await res.json().catch(() => null)) as
            | { error?: string }
            | null;
          setError(body?.error ?? "Could not create the account");
          setLoading(false);
          return;
        }
        setCreated(true);
      } catch {
        setError("Could not create the account");
      }
      setLoading(false);
    },
    [confirmPassword, email, fullName, inviteToken, password, t],
  );

  // ── No invitation: say so, don't show a form ──────────────
  if (!inviteToken) {
    return (
      <Shell>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t("inviteOnlyTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("inviteOnlyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t("backToSignIn")}
            </Button>
          </Link>
        </CardContent>
      </Shell>
    );
  }

  if (peek === undefined) {
    return (
      <Shell>
        <CardContent className="flex items-center justify-center gap-2 py-12 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
        </CardContent>
      </Shell>
    );
  }

  // ── Invitation present but not usable ─────────────────────
  if (peek && !peek.ok) {
    return (
      <Shell>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <ShieldCheck className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t("inviteOnlyTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("inviteOnlyDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href="/login">
            <Button
              variant="outline"
              className="w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground"
            >
              {t("backToSignIn")}
            </Button>
          </Link>
        </CardContent>
      </Shell>
    );
  }

  // ── Created ───────────────────────────────────────────────
  if (created) {
    return (
      <Shell>
        <CardHeader className="items-center text-center">
          <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
            <CheckCircle className="h-6 w-6 text-primary" />
          </div>
          <CardTitle className="text-xl text-foreground">
            {t("createdTitle")}
          </CardTitle>
          <CardDescription className="text-muted-foreground">
            {t("createdDesc")}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <Link href={`/login?invite=${encodeURIComponent(inviteToken)}`}>
            <Button
              data-testid="signup-go-to-login"
              className="w-full bg-primary text-primary-foreground hover:bg-primary/90"
            >
              {t("goToSignIn")}
            </Button>
          </Link>
        </CardContent>
      </Shell>
    );
  }

  // ── The form, only for a valid invitation ─────────────────
  return (
    <Shell>
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary/10">
          <UsersRound className="h-6 w-6 text-primary" />
        </div>
        <CardTitle className="text-xl text-foreground">{t("titleJoin")}</CardTitle>
        <CardDescription className="text-muted-foreground">
          {t("descriptionJoin")}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSignup} className="flex flex-col gap-4">
          {error && (
            <div
              data-testid="signup-error"
              className="rounded-lg border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-400"
            >
              {error}
            </div>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor="fullName" className="text-muted-foreground">
              {t("fullNameLabel")}
            </Label>
            <Input
              id="fullName"
              type="text"
              placeholder={t("fullNamePlaceholder")}
              value={fullName}
              onChange={(e) => setFullName(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="email" className="text-muted-foreground">
              {t("emailLabel")}
            </Label>
            <Input
              id="email"
              type="email"
              placeholder={t("emailPlaceholder")}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="password" className="text-muted-foreground">
              {t("passwordLabel")}
            </Label>
            <Input
              id="password"
              type="password"
              placeholder={t("passwordPlaceholder")}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmPassword" className="text-muted-foreground">
              {t("confirmPasswordLabel")}
            </Label>
            <Input
              id="confirmPassword"
              type="password"
              placeholder={t("confirmPasswordPlaceholder")}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
              className="border-border bg-muted text-foreground placeholder:text-muted-foreground focus-visible:border-primary focus-visible:ring-primary/20"
            />
          </div>

          <Button
            type="submit"
            disabled={loading}
            className="mt-2 h-10 w-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {loading ? t("creatingAccount") : t("createAccount")}
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          {t("haveAccount")}{" "}
          <Link
            href={`/login?invite=${encodeURIComponent(inviteToken)}`}
            className="text-primary hover:text-primary/80"
          >
            {t("signIn")}
          </Link>
        </p>
      </CardContent>
    </Shell>
  );
}
