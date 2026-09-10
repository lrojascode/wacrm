"use client";

// ============================================================
// Lleva a /mfa a quien administra la cuenta y todavía no tiene el
// segundo factor puesto (P0-SEC-09).
//
// Esto es un redirect de conveniencia, no el control. El control está
// en `requireRole` (src/lib/auth/account.ts) y devuelve 403 con
// `mfa_enrollment_required` / `mfa_challenge_required` a cualquiera que
// llame a la API sin cumplirlo, venga de esta UI o no. Lo que hace
// este hook es que la persona aterrice donde puede resolverlo, en vez
// de en un panel donde cada petición falla sin explicar por qué.
//
// Por qué en el cliente y no en el proxy: decidir esto necesita el ROL,
// que vive en `profiles`. El proxy corre en cada navegación, incluidas
// las prefetch, y la guía de Next es explícita en no meter consultas a
// base de datos ahí. El rol ya está cargado en el navegador.
//
// `getAuthenticatorAssuranceLevel()` se resuelve contra la sesión
// local, sin red.
// ============================================================

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";
import { hasMinRole } from "@/lib/auth/roles";

/** Rutas que no deben redirigir: son la salida, o no piden nada. */
const EXEMPT = ["/mfa", "/login", "/signup", "/join", "/forgot-password", "/reset-password"];

export function useMfaGate(): void {
  const { accountRole, profileLoading, user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    // Sin rol conocido no se decide nada: adivinar aquí mandaría a /mfa
    // a un agent durante el primer render, que es justo a quien la
    // aceptación dice que no hay que molestar.
    if (!user || profileLoading || !accountRole) return;
    if (!hasMinRole(accountRole, "admin")) return;
    if (EXEMPT.some((p) => pathname === p || pathname?.startsWith(`${p}/`))) return;

    let cancelled = false;

    (async () => {
      const supabase = createClient();

      // En una carga en frío el cliente todavía puede no haber leído la
      // sesión de las cookies, y entonces `currentLevel` llega null.
      // Hay que ESPERAR una respuesta definida, no darla por buena ni
      // por mala:
      //
      //   - tratar null como "le falta el factor" manda a /mfa a quien
      //     ya está en aal2;
      //   - tratarlo como "todo bien" hace lo contrario, y fue lo que
      //     midió esta sesión: el login pasaba de largo sin retar a
      //     nadie, la cuenta se quedaba en aal1, y el rebote aparecía
      //     en la siguiente navegación.
      //
      // Sabemos que hay sesión (`user` no es null), así que esperar es
      // correcto: la respuesta llega en cuanto el cliente hidrata.
      let level: string | null = null;
      for (let i = 0; i < 40 && !cancelled; i++) {
        const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) return;
        if (typeof data?.currentLevel === "string") {
          level = data.currentLevel;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (cancelled || level === null || level === "aal2") return;

      // Se lleva el destino para volver donde estaba. El servidor no
      // acepta un `next` que no sea una ruta interna (sanitizeNextPath
      // en la página), así que un enlace manipulado no sirve de
      // redirección abierta.
      //
      // La query se lee de `window` y no con `useSearchParams`: ese
      // hook saca del prerender estático a todo componente que lo use,
      // y este hook vive en el shell del dashboard — usarlo obligaba a
      // envolver en Suspense cada página del panel, y el build fallaba
      // al exportar /agents.
      const here = `${pathname ?? ""}${window.location.search}`;
      router.replace(`/mfa?next=${encodeURIComponent(here)}`);
    })();

    return () => {
      cancelled = true;
    };
  }, [accountRole, pathname, profileLoading, router, user]);
}
