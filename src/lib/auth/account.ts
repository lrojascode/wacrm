// ============================================================
// Server-side account context — for API routes and server
// components. Reads the caller's profile + account in one round
// trip and verifies role on demand.
//
// IMPORTANT: this module is server-only. It imports the Supabase
// SSR client (`@/lib/supabase/server`), which reads `next/headers`
// cookies. Importing it from a client component will fail at
// build time with the standard Next.js "You're importing a
// component that needs `next/headers`" error — that's the
// boundary check; we don't need the `server-only` package.
//
// Calling convention
// ------------------
// API routes don't need to redo `supabase.auth.getUser()` — they
// receive a fully-loaded context from `requireRole`:
//
//   try {
//     const ctx = await requireRole("admin");
//     // ctx.supabase — the SSR client (RLS scoped to this user)
//     // ctx.userId  — auth.uid()
//     // ctx.accountId / ctx.role / ctx.account
//   } catch (err) {
//     return errorResponse(err); // see toErrorResponse() below
//   }
// ============================================================

import { NextResponse } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createClient } from "@/lib/supabase/server";
import {
  deriveMfaStatus,
  hasEnrolledFactor,
  isReauthFresh,
  type MfaStatus,
} from "./mfa";
import { hasMinRole, isAccountRole, type AccountRole } from "./roles";

// ------------------------------------------------------------
// Errors
//
// Custom classes so API routes can map a single `catch` to the
// right HTTP status without sprinkling 401/403 strings everywhere.
// ------------------------------------------------------------

export class UnauthorizedError extends Error {
  readonly status = 401 as const;
  constructor(message = "Unauthorized") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends Error {
  readonly status = 403 as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "ForbiddenError";
  }
}

/**
 * The caller is signed in but has never proved they control the
 * address they signed up with (P0-SEC-08).
 *
 * A subclass of ForbiddenError so every existing `catch` keeps
 * mapping it to 403, but it carries a machine-readable `code` so the
 * UI can say "check your inbox" instead of the generic "forbidden",
 * which would send someone hunting for a permissions problem they do
 * not have.
 */
export class EmailNotVerifiedError extends ForbiddenError {
  readonly code = "email_not_verified" as const;
  constructor() {
    super("Verify your email address before using the app");
    this.name = "EmailNotVerifiedError";
  }
}

/**
 * Convert one of the typed errors above (or anything else) into a
 * `NextResponse`. Routes can do:
 *
 *   } catch (err) {
 *     return toErrorResponse(err);
 *   }
 *
 * Unknown errors collapse to 500 with the generic message — we
 * never leak `err.message` for non-classified errors to keep
 * server internals out of the wire.
 */
export function toErrorResponse(err: unknown): NextResponse {
  // Cualquier error clasificado que traiga un `code` legible por la UI
  // lo propaga. Sin esto, "inscribe un segundo factor", "mete el
  // código" y "no tienes permiso" llegarían al cliente como el mismo
  // 403 y no habría forma de ofrecer la acción correcta.
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    const code = (err as unknown as { code?: unknown }).code;
    if (typeof code === "string") {
      return NextResponse.json(
        { error: err.message, code },
        { status: err.status },
      );
    }
  }
  if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
    return NextResponse.json({ error: err.message }, { status: err.status });
  }
  console.error("[toErrorResponse] uncategorized error:", err);
  return NextResponse.json({ error: "Internal server error" }, { status: 500 });
}

/**
 * Falta el segundo factor (P0-SEC-09). 403 con un `code` que la UI
 * traduce en "inscríbete" o "mete el código" — un 403 a secas manda a
 * buscar un problema de permisos que no existe.
 */
export class MfaRequiredError extends ForbiddenError {
  readonly code: "mfa_enrollment_required" | "mfa_challenge_required";
  constructor(status: Exclude<MfaStatus, "satisfied">) {
    super(
      status === "enrollment_required"
        ? "Set up two-factor authentication to manage configuration"
        : "Enter your authentication code to continue",
    );
    this.name = "MfaRequiredError";
    this.code =
      status === "enrollment_required"
        ? "mfa_enrollment_required"
        : "mfa_challenge_required";
  }
}

/** La acción es crítica y la autenticación ya no es reciente. */
export class ReauthRequiredError extends ForbiddenError {
  readonly code = "reauth_required" as const;
  constructor() {
    super("Confirm your identity again to complete this action");
    this.name = "ReauthRequiredError";
  }
}

// ------------------------------------------------------------
// Account context
// ------------------------------------------------------------

export interface AccountContext {
  /** Supabase SSR client, RLS scoped to the calling user. */
  supabase: SupabaseClient;
  /** `auth.uid()` for the caller. Always defined when this resolves. */
  userId: string;
  /** Caller's account_id from their profile row. */
  accountId: string;
  /** Caller's role within their account. */
  role: AccountRole;
  /** Lightweight account meta — id + name. */
  account: { id: string; name: string };
  /**
   * Factores MFA del usuario, tal como vinieron en el `getUser()` que
   * ya se hizo para resolver la sesión. Se guardan para que la
   * comprobación de segundo factor no repita esa ida y vuelta.
   */
  factors: Array<{ status?: string }>;
  /**
   * Claims verificadas (`aal`, `amr`), presentes solo si algo las
   * pidió. `requireRole` las deja aquí cuando comprueba el segundo
   * factor, para que una acción crítica no vuelva a pedirlas.
   */
  assurance?: { aal: unknown; amr: unknown };
}

/**
 * Resolve the caller's user + account + role in one round trip.
 *
 * Throws `UnauthorizedError` if there's no Supabase session.
 * Throws `ForbiddenError` if the profile is missing account
 * fields (shouldn't happen post-017 migration; defensive guard
 * against profile rows that pre-date the backfill or were
 * inserted by hand).
 *
 * Use `requireRole(min)` instead when the route also needs a
 * minimum-role check — it's a thin wrapper over this.
 */
export async function getCurrentAccount(): Promise<AccountContext> {
  const supabase = await createClient();

  const {
    data: { user },
    error: userErr,
  } = await supabase.auth.getUser();
  if (userErr || !user) {
    throw new UnauthorizedError();
  }

  // Email verificado antes de cualquier uso real de la app
  // (P0-SEC-08).
  //
  // Va aquí y no solo en el proxy porque el proxy protege PÁGINAS, y
  // la documentación de Next es explícita en que no debe ser la
  // solución de autorización: quien llame a la API directamente no
  // pasa por él. Esta función sí es el cuello de botella real — las 71
  // rutas la atraviesan vía requireRole/withRoute (P0-SEC-01/02), así
  // que el control se aplica una vez y vale para todas.
  //
  // No bloquea a nadie que ya exista: con `enable_confirmations = false`
  // GoTrue autoconfirma, así que toda cuenta creada hasta hoy tiene
  // `email_confirmed_at` puesto — verificado contra la base antes de
  // añadir esto. El control existe para el día en que se activen las
  // confirmaciones, y para cualquier usuario creado por una vía que no
  // marque el correo como verificado.
  if (!user.email_confirmed_at) {
    throw new EmailNotVerifiedError();
  }

  const { data, error } = await supabase
    .from("profiles")
    .select("account_id, account_role")
    .eq("user_id", user.id)
    .maybeSingle();

  if (error) {
    console.error("[getCurrentAccount] profile fetch error:", error);
    throw new ForbiddenError("Could not load account context");
  }
  if (!data || !data.account_id || !data.account_role) {
    // Pre-migration profile, or a manual insert that skipped the
    // signup trigger. The user is authenticated but the app has
    // no way to scope their queries — treat as forbidden.
    throw new ForbiddenError("Profile is not linked to an account");
  }
  if (!isAccountRole(data.account_role)) {
    // The DB enum should make this impossible, but a future
    // migration that broadens the enum without updating TS would
    // hit this — surface it rather than silently widening.
    throw new ForbiddenError(`Unknown account role: ${data.account_role}`);
  }

  // Load the account with a plain point lookup by id rather than an
  // embedded FK join (`account:accounts!inner(...)`). The embed forces
  // PostgREST to resolve the profiles.account_id → accounts.id
  // relationship from its schema cache; when that cache is stale — a
  // common Supabase state right after a migration adds the FK, or when
  // migrations are applied out of band — the embed fails hard with
  // PGRST200 ("could not find a relationship … in the schema cache")
  // and takes down the entire account context (issue #294). A lookup by
  // id needs no relationship inference and is gated by the same accounts
  // RLS, so it stays robust against cache staleness and older schemas.
  const { data: account, error: accountErr } = await supabase
    .from("accounts")
    .select("id, name")
    .eq("id", data.account_id)
    .maybeSingle();

  if (accountErr) {
    console.error("[getCurrentAccount] account fetch error:", accountErr);
    throw new ForbiddenError("Could not load account context");
  }
  if (!account) {
    // account_id points at no readable account row — orphaned profile
    // or an RLS gap. Same "can't scope this user" outcome as above.
    throw new ForbiddenError("Profile is not linked to an account");
  }

  return {
    supabase,
    userId: user.id,
    accountId: data.account_id,
    role: data.account_role,
    account: { id: account.id, name: account.name },
    factors: (user.factors ?? []) as Array<{ status?: string }>,
  };
}

/**
 * Claims verificadas del token de quien llama.
 *
 * `getClaims()` y no una descodificación a mano: valida la firma
 * (contra el JWKS del proyecto, o contra el servidor de auth cuando la
 * clave es simétrica). Leer el payload sin verificar convertiría `aal`
 * en un campo que elige el cliente, que es lo contrario de lo que hace
 * falta.
 */
export async function readAssurance(
  ctx: AccountContext,
): Promise<{ aal: unknown; amr: unknown }> {
  // Reutiliza lo que `requireRole` ya leyó, si lo leyó. No escribe:
  // el único que rellena `ctx.assurance` es `requireRole`, que es
  // quien construye el contexto.
  //
  // La primera versión sí escribía aquí, y se notó enseguida — un test
  // que compartía un objeto de contexto entre casos arrastraba las
  // claims de la prueba anterior y daba por reciente una sesión que ya
  // no lo era. En producción cada petición trae un contexto nuevo, así
  // que no había fallo real, pero una función llamada "read" que
  // escribe en el objeto de quien la llama es una trampa esperando a
  // que alguien la pise.
  if (ctx.assurance) return ctx.assurance;
  const { data, error } = await ctx.supabase.auth.getClaims();
  if (error || !data?.claims) {
    throw new ForbiddenError("Could not verify the session");
  }
  const claims = data.claims as Record<string, unknown>;
  return { aal: claims.aal, amr: claims.amr };
}

/**
 * Exige que quien llama se haya autenticado dentro de la ventana
 * (P0-SEC-09). Para acciones irreversibles o que entregan un secreto.
 */
export async function requireFreshAuth(ctx: AccountContext): Promise<void> {
  // Solo tiene sentido pedírselo a quien puede cumplirlo.
  //
  // Con el segundo factor activado, reautenticarse es teclear seis
  // dígitos otra vez. Sin él, la única forma de refrescar `amr` sería
  // cerrar sesión y volver a entrar — así que exigirlo dejaría la
  // exportación completa y la creación de API keys inservibles para
  // cualquiera cuya sesión pasara de cinco minutos, que es casi
  // siempre.
  //
  // Es la consecuencia honesta de que el segundo factor sea opcional:
  // esta protección la tiene quien lo activa. Conviene decirlo en vez
  // de aparentar que cubre a todo el mundo.
  if (!hasEnrolledFactor(ctx.factors)) return;

  const { amr } = await readAssurance(ctx);
  if (!isReauthFresh(amr)) throw new ReauthRequiredError();
}

/**
 * Resolve the caller's account context and enforce a minimum role.
 *
 * Throws `UnauthorizedError` / `ForbiddenError` as documented on
 * `getCurrentAccount`, plus `ForbiddenError("Insufficient role")`
 * when the caller is below `min`.
 */
export async function requireRole(min: AccountRole): Promise<AccountContext> {
  const ctx = await getCurrentAccount();
  if (!hasMinRole(ctx.role, min)) {
    throw new ForbiddenError(
      `This action requires the '${min}' role or higher`,
    );
  }

  // Segundo factor para configuración y para secretos (P0-SEC-09).
  //
  // Va aquí, y no en `withRoute`, porque este es el punto por el que
  // pasan las 48 rutas: 18 a través del envoltorio y 30 llamando
  // directamente. En el envoltorio, esas 30 —donde vive buena parte de
  // la configuración— se habrían quedado fuera sin que nada lo dijera.
  //
  // La exigencia se deriva del `minRole` que la ruta ya declara, así
  // que una ruta nueva de admin la hereda sin acordarse de nada.
  //
  // No hace falta escotilla para inscribirse: eso ocurre en el
  // navegador, contra Supabase directamente
  // (`supabase.auth.mfa.enroll`), sin pasar por ninguna ruta de esta
  // app. El punto muerto —inscribir es configuración, la configuración
  // pide aal2, aal2 exige haber inscrito— sencillamente no existe.
  // Segundo factor: OPCIONAL, y solo se exige a quien lo activó.
  //
  // Nadie queda fuera por no tenerlo. Quien sí lo activó tiene que
  // usarlo, que es lo que hace que activarlo signifique algo.
  //
  // Se consulta el token solo si hay factor: sin él no hay nada que
  // comprobar y sería una ida y vuelta por petición a cambio de nada.
  if (hasEnrolledFactor(ctx.factors)) {
    const assurance = await readAssurance(ctx);
    // Se guarda para que una acción crítica (`reauth`) no vuelva a
    // pedir las mismas claims en la misma petición.
    ctx.assurance = assurance;
    const status = deriveMfaStatus(assurance.aal, ctx.factors);
    if (status !== "satisfied") throw new MfaRequiredError(status);
  }

  return ctx;
}
