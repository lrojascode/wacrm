// ============================================================
// Segundo factor y reautenticación (P0-SEC-09).
//
// OPCIONAL, Y POR USUARIO
//
// El segundo factor NO se impone por rol. Cada persona decide si lo
// activa, desde Ajustes; quien no lo tenga entra con normalidad, sea
// owner, admin, agent o viewer.
//
// Lo que sí se exige, a quien lo haya activado, es usarlo: si tienes un
// factor verificado y la sesión está en aal1, hay que superar el reto.
// Eso no es una barrera nueva — es lo que hace que activarlo signifique
// algo. Sin ello, inscribir un factor sería decorativo.
//
// POR QUÉ SE CAMBIÓ
//
// La primera versión lo exigía a todo `admin` y `owner`, derivándolo
// del `minRole` de cada ruta. Sobre el papel encajaba con la escala de
// roles; en la práctica, el día del despliegue dejó al owner del
// proyecto delante de un QR sin más salida que escanearlo. Una medida
// de seguridad que se activa de golpe para todo el mundo no es una
// medida, es una puerta atascada.
//
// El estado vive donde ya vivía —los factores del usuario en Supabase—
// así que no hace falta ni columna nueva ni migración: "lo tengo
// activado" y "tengo un factor verificado" son la misma cosa.
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

/** ¿Esta persona activó el segundo factor? */
export function hasEnrolledFactor(
  factors: Array<{ status?: string }> | null | undefined,
): boolean {
  return (factors ?? []).some((f) => f?.status === "verified");
}

export interface AmrEntry {
  method: string;
  timestamp: number;
}

/** Estado del segundo factor para quien llama. */
export type MfaStatus =
  /** Reto superado en esta sesión, o no lo tiene activado. */
  | "satisfied"
  /** Lo activó pero no lo ha usado en esta sesión. */
  | "challenge_required"
  /** Lo activó y el factor ya no sirve. Reservado; hoy no se emite. */
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

/**
 * Deriva el estado a partir de las claims y de los factores.
 *
 * Sin factor activado el resultado es `satisfied`: no hay nada que
 * exigir. Es lo que hace que el control sea opcional.
 */
export function deriveMfaStatus(
  aal: unknown,
  factors: Array<{ status?: string }> | null | undefined,
): MfaStatus {
  if (aal === "aal2") return "satisfied";
  return hasEnrolledFactor(factors) ? "challenge_required" : "satisfied";
}
