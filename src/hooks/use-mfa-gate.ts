"use client";

// ============================================================
// Lleva a /mfa a quien TIENE el segundo factor activado y aún no lo ha
// usado en esta sesión (P0-SEC-09).
//
// NO fuerza a inscribirse. El segundo factor es opcional y se activa
// desde Ajustes; quien no lo tenga no pasa por aquí nunca, sea cual sea
// su rol. La primera versión sí lo forzaba a todo admin y owner, y el
// día del despliegue dejó al owner del proyecto delante de un QR sin
// más salida que escanearlo.
//
// Lo que queda es la otra mitad, que sí hace falta: si lo activaste,
// tienes que usarlo. Sin este redirect, una sesión en aal1 aterrizaría
// en el panel y cada petición devolvería 403 sin explicar por qué.
//
// El control real está en `requireRole` (src/lib/auth/account.ts), que
// devuelve 403 `mfa_challenge_required` venga de esta UI o no.
//
// `getAuthenticatorAssuranceLevel()` se resuelve contra la sesión
// local, sin red: `nextLevel` es 'aal2' exactamente cuando hay un
// factor verificado, así que la decisión no necesita consultar nada.
// ============================================================

import { useEffect } from "react";
import { usePathname, useRouter } from "next/navigation";

import { useAuth } from "@/hooks/use-auth";
import { createClient } from "@/lib/supabase/client";

/** Rutas que no deben redirigir: son la salida, o no piden nada. */
const EXEMPT = ["/mfa", "/login", "/signup", "/join", "/forgot-password", "/reset-password"];

export function useMfaGate(): void {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();

  useEffect(() => {
    if (!user) return;
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
      let current: string | null = null;
      let next: string | null = null;
      for (let i = 0; i < 40 && !cancelled; i++) {
        const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
        if (error) return;
        if (typeof data?.currentLevel === "string") {
          current = data.currentLevel;
          next = data.nextLevel ?? null;
          break;
        }
        await new Promise((r) => setTimeout(r, 150));
      }
      if (cancelled || current === null) return;

      // `nextLevel === 'aal2'` significa "tiene un factor verificado".
      // Si no lo tiene, no hay reto que superar y no se le molesta.
      if (next !== "aal2") return;
      if (current === "aal2") return;

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
  }, [pathname, router, user]);
}
