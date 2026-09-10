// ============================================================
// P0-SEC-06 — la 034 sostiene lo que promete, contra una base viva.
//
// La 034 impide que el cliente del navegador se escriba a sí mismo
// `account_role` o `account_id`. Sin ella, un `viewer` se asciende a
// `owner` con un PATCH, o se muda al inquilino de otro:
//
//   PATCH /rest/v1/profiles?user_id=eq.<self>  {"account_role":"owner"}
//
// Ambos pasan el WITH CHECK de la política RLS, porque `user_id` no
// cambia: RLS acota QUÉ FILAS puedes tocar, no QUÉ COLUMNAS.
//
// POR QUÉ ESTE ARCHIVO EXISTE
//
// La cabecera de la migración lo decía con todas las letras:
// «this migration was not run against a live database», y dejaba una
// lista de comprobaciones manuales. Una defensa no verificada contra
// escalada de privilegios es indistinguible de no tener defensa hasta
// que alguien la prueba, y nadie la había probado.
//
// Se ataca PostgREST directamente, no la UI, porque la UI ni siquiera
// ofrece este campo: el ataque es un `fetch` desde la consola del
// navegador de cualquiera que ya tenga sesión de viewer. Eso es
// exactamente lo que reproduce cada caso.
//
// El discriminador de la 034 es `current_user = 'authenticated'`, así
// que la prueba tiene que llegar como llega el navegador —un JWT de
// usuario contra PostgREST— y no con la clave de servicio, que pasaría
// por el camino legítimo y no probaría nada.
// ============================================================

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { expect, test } from "@playwright/test";

import { ACCOUNTS, E2E_PASSWORD, userByKey } from "./support/fixtures";

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/** Un cliente con la sesión real del usuario, como el del navegador. */
async function signInAs(key: string): Promise<{ client: SupabaseClient; userId: string }> {
  const user = userByKey(key);
  const client = createClient(SUPABASE_URL, ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.signInWithPassword({
    email: user.email,
    password: E2E_PASSWORD,
  });
  if (error || !data.user) throw new Error(`login ${user.email}: ${error?.message}`);
  return { client, userId: data.user.id };
}

/** Lee el perfil sin pasar por RLS, para comprobar el efecto real. */
function adminClient(): SupabaseClient {
  return createClient(SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

test.describe("034 · columnas de privilegio en profiles", () => {
  // Restaurar el fixture pase lo que pase.
  //
  // Cada ataque de abajo afirma que NO tuvo efecto, así que en verde no
  // hay nada que limpiar. Esto existe para el caso rojo: si el trigger
  // faltara, el ataque SÍ funciona, y el viewer se queda ascendido y
  // mudado a otro inquilino para todo lo que venga después. Comprobado
  // quitando el trigger a propósito: sin esta limpieza, los tres fallos
  // reales arrastraban un cuarto fallo sin relación —la RPC supervisada,
  // que ya no encontraba a los dos usuarios en la misma cuenta— y ese
  // cuarto fallo es justo el que manda a depurar en la dirección
  // equivocada.
  test.afterEach(async () => {
    const viewer = userByKey("acmeViewer");
    // El login funciona sea cual sea el rol o la cuenta, así que sirve
    // para localizar la fila incluso si un ataque la dejó irreconocible.
    const { userId } = await signInAs("acmeViewer");
    const admin = adminClient();
    const { data: acme } = await admin
      .from("accounts")
      .select("id")
      .eq("name", ACCOUNTS.acme.name)
      .single();
    if (!acme) return;
    await admin
      .from("profiles")
      .update({ account_role: viewer.role, account_id: acme.id, full_name: viewer.fullName })
      .eq("user_id", userId);
  });

  test("un viewer no puede ascenderse a owner", async () => {
    const { client, userId } = await signInAs("acmeViewer");

    const { error } = await client
      .from("profiles")
      .update({ account_role: "owner" })
      .eq("user_id", userId);

    // 42501 = insufficient_privilege, el que lanza el trigger.
    expect(error?.code).toBe("42501");

    // Y lo que de verdad importa: el rol no se movió.
    const { data } = await adminClient()
      .from("profiles")
      .select("account_role")
      .eq("user_id", userId)
      .single();
    expect(data?.account_role).toBe("viewer");
  });

  test("un viewer no puede mudarse al inquilino de otro", async () => {
    const { client, userId } = await signInAs("acmeViewer");
    const admin = adminClient();

    // Las cuentas del seed no tienen id fijo (la FK de profiles impide
    // re-asignarlo), así que se resuelve por nombre en tiempo de test.
    const { data: globex } = await admin
      .from("accounts")
      .select("id")
      .eq("name", ACCOUNTS.globex.name)
      .single();
    expect(globex?.id, "el seed debe haber creado la cuenta Globex").toBeTruthy();

    const { data: before } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .single();

    const { error } = await client
      .from("profiles")
      .update({ account_id: globex!.id })
      .eq("user_id", userId);

    expect(error?.code).toBe("42501");

    const { data: after } = await admin
      .from("profiles")
      .select("account_id")
      .eq("user_id", userId)
      .single();
    expect(after?.account_id).toBe(before?.account_id);
    expect(after?.account_id).not.toBe(globex!.id);
  });

  test("no se cuela escondiendo el ascenso junto a un campo legítimo", async () => {
    // Un guard que solo mirase «¿la petición toca account_role?» sin
    // comparar con el valor anterior podría dejar pasar esto.
    const { client, userId } = await signInAs("acmeViewer");

    const { error } = await client
      .from("profiles")
      .update({ full_name: "Acme Viewer", account_role: "admin" })
      .eq("user_id", userId);

    expect(error?.code).toBe("42501");
  });

  // ── Los contrapesos ───────────────────────────────────────────
  // Sin estos, la suite pasaría igual con un trigger que rechazara
  // TODA escritura sobre profiles, que sería un bug distinto y peor.

  test("la edición de su propio nombre sigue funcionando", async () => {
    const { client, userId } = await signInAs("acmeViewer");
    const nuevo = `Acme Viewer ${Date.now()}`;

    const { error } = await client
      .from("profiles")
      .update({ full_name: nuevo })
      .eq("user_id", userId);

    expect(error).toBeNull();

    const { data } = await adminClient()
      .from("profiles")
      .select("full_name")
      .eq("user_id", userId)
      .single();
    expect(data?.full_name).toBe(nuevo);

    // Deja el fixture como estaba: el seed lo restaura en cada pasada,
    // pero un archivo que ensucia y confía en otro es frágil de leer.
    await adminClient()
      .from("profiles")
      .update({ full_name: userByKey("acmeViewer").fullName })
      .eq("user_id", userId);
  });

  test("la RPC supervisada sí cambia el rol", async () => {
    // set_member_role es SECURITY DEFINER y corre como postgres, así
    // que current_user no es 'authenticated' y el trigger la deja
    // pasar. Este es el camino legítimo que la 034 debe preservar: si
    // se rompiera, la gestión de miembros dejaría de funcionar.
    const { client: owner } = await signInAs("acmeOwner");
    const viewerId = (await signInAs("acmeViewer")).userId;

    const { error } = await owner.rpc("set_member_role", {
      p_user_id: viewerId,
      p_new_role: "agent",
    });
    expect(error).toBeNull();

    const admin = adminClient();
    const { data } = await admin
      .from("profiles")
      .select("account_role")
      .eq("user_id", viewerId)
      .single();
    expect(data?.account_role).toBe("agent");

    // Restaurar: los demás archivos cuentan con que este siga siendo viewer.
    await admin.from("profiles").update({ account_role: "viewer" }).eq("user_id", viewerId);
  });
});
