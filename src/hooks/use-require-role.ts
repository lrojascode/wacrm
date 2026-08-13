"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { hasMinRole, type AccountRole } from "@/lib/auth/roles";

/**
 * Page-level counterpart to `<RequireRole>` for routes that shouldn't
 * be reachable at all below a given role (as opposed to a section
 * within an otherwise-shared page). Redirects to `/dashboard` once the
 * role is known and insufficient.
 *
 * Returns `true` only once we've confirmed the caller may see the
 * page — `false` covers both "still loading" and "redirecting", so
 * callers can gate their render on it and never flash gated content:
 *
 *   const allowed = useRequireRole("admin");
 *   if (!allowed) return null; // or a loading spinner
 */
export function useRequireRole(min: AccountRole): boolean {
  const router = useRouter();
  const { profileLoading, accountRole } = useAuth();

  const allowed = !profileLoading && !!accountRole && hasMinRole(accountRole, min);

  useEffect(() => {
    if (!profileLoading && accountRole && !hasMinRole(accountRole, min)) {
      router.replace("/dashboard");
    }
  }, [profileLoading, accountRole, min, router]);

  return allowed;
}
