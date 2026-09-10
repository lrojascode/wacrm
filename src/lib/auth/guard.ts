// ============================================================
// `withRoute` — the single way a route handler declares who may call
// it (P0-SEC-01).
//
// WHY A WRAPPER, WHEN `requireRole` ALREADY EXISTS
//
// It did, and the role predicates in roles.ts even call themselves "the
// single source of truth". The problem was never the logic — it was
// that using it was optional. An audit of the 71 route handlers found
// ten that authenticate with `supabase.auth.getUser()`, scope their
// queries by `account_id`, and then never check the role at all. A
// `viewer` — a role whose whole definition is read-only — could send
// WhatsApp messages, fire a broadcast, and submit templates to Meta.
//
// Nothing in that code looks wrong at a glance. Each route resolves the
// account correctly; the check is simply absent, and absence is
// invisible in review. So the fix is not another helper to remember to
// call: it is a wrapper that every route must go through, plus a CI
// test that fails when one does not (see route-guards.test.ts). The
// declaration becomes part of the route's shape rather than a step in
// its body.
//
// EXTENSION POINTS
//
// Later tasks hang off this same seam rather than touching 71 files
// again: module kill switches and the audit log (P1-OBS-02), and
// re-authentication for critical actions (P0-SEC-09). They are not
// implemented yet and this deliberately takes no options for them —
// an unused parameter invites callers to guess at its meaning.
// ============================================================

import { NextResponse } from 'next/server';

import {
  requireFreshAuth,
  requireRole,
  toErrorResponse,
  type AccountContext,
} from '@/lib/auth/account';
import type { AccountRole } from '@/lib/auth/roles';

export interface RouteGuardOptions {
  /**
   * Minimum role allowed to call this route.
   *
   * The ladder, from the agreed policy:
   *   viewer — reads only. No internal or external effects.
   *   agent  — operates: send, assign, move deals, complete tasks.
   *   admin  — non-critical configuration: automations, templates,
   *            members, appearance.
   *   owner  — secrets and integrations: WhatsApp tokens, Meta app
   *            secret, AI keys, API keys, full exports.
   *
   * `viewer` is not a synonym for "no check": it still requires a
   * signed-in caller with a resolvable account, which is what scopes
   * every downstream query.
   */
  minRole: AccountRole;

  /**
   * La acción es irreversible o entrega un secreto, y exige que quien
   * llama se haya autenticado hace poco (P0-SEC-09).
   *
   * Es opt-in porque no se deduce del rol: rotar el token de WhatsApp
   * y renombrar la cuenta son ambas cosas de owner, y solo una merece
   * volver a pedir el segundo factor. La lista corta —rotar
   * credenciales, exportar todo, transferir propiedad, crear API key,
   * borrar la cuenta— está en la spec, y el criterio es el mismo:
   * ¿puede deshacerse, y qué se lleva quien lo haga?
   *
   * Protege contra una sesión robada, no contra una contraseña
   * robada: la cookie prestada hereda el aal2 de quien la abrió, pero
   * no puede producir un `amr` fresco sin el factor.
   *
   * El segundo factor NO se declara aquí. Se deriva de `minRole` y se
   * aplica en `requireRole`, para que no pueda olvidarse en una ruta
   * nueva ni saltárselo llamando a `requireRole` directamente.
   */
  reauth?: boolean;

}

/**
 * Handler signature. The context is resolved and authorised before the
 * handler runs, so `ctx.accountId` and `ctx.role` are guaranteed —
 * there is no null case to handle.
 */
export type GuardedHandler<TArgs extends unknown[]> = (
  ctx: AccountContext,
  request: Request,
  ...args: TArgs
) => Promise<Response> | Response;

/**
 * Wrap a route handler with authentication and role enforcement.
 *
 *   export const POST = withRoute(
 *     { minRole: "agent" },
 *     async (ctx, request) => { ... }
 *   );
 *
 * Returns 401 without a session, 403 below `minRole`, and 500 for
 * anything unexpected — `toErrorResponse` keeps internals off the wire.
 *
 * The second parameter of a Next route handler (the `{ params }` bag on
 * dynamic segments) is forwarded untouched, so `[id]` routes wrap
 * exactly like static ones.
 */
export function withRoute<TArgs extends unknown[]>(
  options: RouteGuardOptions,
  handler: GuardedHandler<TArgs>
): (request: Request, ...args: TArgs) => Promise<Response> {
  return async (request: Request, ...args: TArgs): Promise<Response> => {
    let ctx: AccountContext;
    try {
      // `requireRole` ya aplica el segundo factor cuando el minRole lo
      // pide — antes que la frescura, porque sin factor inscrito
      // "vuelve a autenticarte" no tiene una acción que ofrecer.
      ctx = await requireRole(options.minRole);
      if (options.reauth) {
        await requireFreshAuth(ctx);
      }
    } catch (err) {
      return toErrorResponse(err);
    }

    try {
      return await handler(ctx, request, ...args);
    } catch (err) {
      // Handler failures are separated from guard failures on purpose.
      // A route that throws must not be reported as an authorisation
      // problem: "403 Forbidden" for what is actually a bug sends
      // whoever debugs it looking at roles for hours.
      console.error('[withRoute] handler threw:', err);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
  };
}
