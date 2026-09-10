// ============================================================
// Segundo factor y reautenticación (P0-SEC-09).
//
// QUÉ SE EXIGE, Y A QUIÉN
//
// La política de roles ya dice quién hace qué:
//
//   viewer  lectura
//   agent   operación        ← trabajo diario, sin fricción añadida
//   admin   configuración    ← a partir de aquí, segundo factor
//   owner   secretos         ← y además reautenticación en lo crítico
//
// Así que la exigencia de MFA **se deriva del `minRole` que la ruta ya
// declara**, no de una bandera nueva por ruta. Es deliberado: marcar a
// mano las rutas de configuración repetiría el error que P0-SEC-01
// arregló — un olvido es invisible en revisión, y aquí el olvido deja
// la configuración de un inquilino detrás de una sola contraseña.
//
// De ahí sale gratis lo que pide la aceptación: «un agent no se ve
// afectado». Ninguna ruta de agent o viewer pide segundo factor, ni
// siquiera cuando quien llama es el owner — puede seguir leyendo el
// inbox y respondiendo mensajes sin haber inscrito nada.
//
// DOS PREGUNTAS DISTINTAS
//
//   ¿Tiene segundo factor?   → el reto se completó en ESTA sesión (aal2)
//   ¿Se autenticó hace poco? → el evento más reciente de `amr`
//
// La segunda es la que protege las acciones irreversibles frente a una
// sesión robada: una cookie prestada arrastra el aal2 de quien la
// abrió, pero no puede producir un `amr` fresco sin el factor.
//
// DÓNDE VIVE CADA COSA
//
// Este archivo es solo decisión pura: recibe claims y devuelve un
// veredicto. Los errores y las llamadas a Supabase están en
// account.ts, junto a `requireRole`, que es el punto por el que pasan
// las 48 rutas — las 18 que usan `withRoute` y las 30 que llaman
// directamente. Poner la comprobación en el envoltorio habría dejado
// esas 30 fuera, que es precisamente la mitad donde vive la
// configuración.
//
// El corte también evita un ciclo de imports (account.ts necesita
// estas funciones; ellas no necesitan nada de account.ts) y deja los
// casos raros —un `amr` vacío, un timestamp adelantado— comprobables
// sin levantar un cliente.
//
// POR QUÉ `amr` Y NO UNA MARCA PROPIA
//
// El access token trae `amr: [{ method, timestamp }]`, lo escribe
// GoTrue al verificar y no es editable por el cliente. Comprobado
// contra el stack local: volver a verificar el TOTP estando ya en aal2
// **refresca** el timestamp de `totp`, que es justo lo que convierte a
// `amr` en un reloj de reautenticación utilizable en vez de un simple
// registro de cómo entró la sesión.
// ============================================================

import type { AccountRole } from "./roles";

/**
 * Cuánto dura una reautenticación.
 *
 * Cinco minutos: de sobra para leer un diálogo de confirmación y
 * teclear seis dígitos, y corto frente a un portátil desbloqueado que
 * alguien deja sin vigilancia. No se hace configurable a propósito —
 * un despliegue que lo suba a un día tendría el control sin tener la
 * protección, y nadie lo notaría.
 */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

/** Roles cuyas rutas exigen segundo factor. */
const MFA_REQUIRED_FROM: AccountRole = "admin";

const RANK: Record<AccountRole, number> = {
  viewer: 1,
  agent: 2,
  admin: 3,
  owner: 4,
};

/**
 * ¿Una ruta con este `minRole` exige segundo factor?
 *
 * Se mira el mínimo de la RUTA, no el rol de quien llama: un owner
 * leyendo el inbox (`minRole: 'viewer'`) no debe tropezar con el
 * segundo factor, y un admin tocando plantillas (`minRole: 'admin'`)
 * sí.
 */
export function routeRequiresMfa(minRole: AccountRole): boolean {
  return RANK[minRole] >= RANK[MFA_REQUIRED_FROM];
}

export interface AmrEntry {
  method: string;
  timestamp: number;
}

/** Estado del segundo factor para quien llama. */
export type MfaStatus =
  /** Reto superado en esta sesión. */
  | "satisfied"
  /** Tiene factor inscrito pero no lo ha usado en esta sesión. */
  | "challenge_required"
  /** No tiene ningún factor verificado. */
  | "enrollment_required";

/**
 * Momento (ms) de la autenticación más reciente, sea cual sea el
 * método.
 *
 * Se toma el máximo y no la entrada de `totp`: reautenticarse con la
 * contraseña también es reautenticarse, y quien todavía no tiene
 * segundo factor no tendría ninguna entrada de `totp` que mirar.
 *
 * `amr` puede llegar como array de strings en tokens antiguos; esos no
 * traen timestamp y se ignoran en vez de asumir "ahora", que sería
 * fallar en abierto.
 */
export function lastAuthenticatedAt(amr: unknown): number | null {
  if (!Array.isArray(amr)) return null;
  let latest: number | null = null;
  for (const entry of amr) {
    if (typeof entry !== "object" || entry === null) continue;
    const ts = (entry as AmrEntry).timestamp;
    if (typeof ts !== "number" || !Number.isFinite(ts)) continue;
    // GoTrue los emite en segundos.
    const ms = ts * 1000;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest;
}

/** ¿La autenticación más reciente entra en la ventana? */
export function isReauthFresh(
  amr: unknown,
  now: number = Date.now(),
  windowMs: number = REAUTH_WINDOW_MS,
): boolean {
  const at = lastAuthenticatedAt(amr);
  if (at === null) return false;
  // Un timestamp en el futuro no cuenta como fresco: sería la forma de
  // comprar tiempo indefinido con un reloj adelantado.
  if (at > now + 60_000) return false;
  return now - at <= windowMs;
}

/** Deriva el estado a partir de las claims y de los factores inscritos. */
export function deriveMfaStatus(
  aal: unknown,
  factors: Array<{ status?: string }> | null | undefined,
): MfaStatus {
  if (aal === "aal2") return "satisfied";
  const verified = (factors ?? []).some((f) => f?.status === "verified");
  return verified ? "challenge_required" : "enrollment_required";
}
