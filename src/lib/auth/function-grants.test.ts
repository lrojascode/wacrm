// ============================================================
// P0-SEC-05 — ninguna función SECURITY DEFINER queda abierta a PUBLIC.
//
// El gemelo de route-guards.test.ts, una capa más abajo. Aquel impide
// que una ruta HTTP olvide decidir quién puede llamarla; este impide lo
// mismo en la base de datos, donde el olvido es más fácil y más grave:
//
//   - Más fácil, porque Postgres concede EXECUTE a PUBLIC en toda
//     función nueva sin que nadie lo escriba. No hay línea que revisar;
//     el permiso aparece solo.
//   - Más grave, porque una función SECURITY DEFINER se salta RLS por
//     definición. Una que quede abierta es una escritura sin RLS
//     alcanzable con la clave `anon`, que viaja en el bundle del
//     navegador.
//
// Así entraron once funciones, entre ellas `record_webhook_failure`:
// antes de la migración 052, un POST anónimo desactivaba el webhook de
// cualquier inquilino.
//
// El test es estático —lee el SQL, no la base— porque CI no levanta
// Postgres. Eso lo hace más débil que consultar `pg_proc` y más útil
// que nada: detecta el descuido en la revisión, que es donde ocurre. La
// comprobación contra el catálogo vive en docs/deploy/check-applied.sql
// y se ejecuta contra cada proyecto de cliente.
// ============================================================

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const MIGRATIONS_DIR = join(process.cwd(), "supabase", "migrations");
const SEED = join(process.cwd(), "supabase", "seed.sql");

const sqlFiles = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith(".sql"))
  .sort();

const allSql = sqlFiles.map((f) => readFileSync(join(MIGRATIONS_DIR, f), "utf8")).join("\n");

/**
 * Quita comentarios SQL antes de analizar.
 *
 * Sin esto el test se lee a sí mismo: la 052 y el seed explican en sus
 * cabeceras las sentencias que documentan, y un `-- GRANT ALL ON ALL
 * FUNCTIONS ...` citado en una explicación contaba como concesión real.
 */
function stripComments(sql: string): string {
  return sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ");
}

/** `public.foo` / `FOO` → `foo`, para comparar sin ruido. */
function bareName(name: string): string {
  return name.replace(/^public\./i, "").toLowerCase();
}

/**
 * Nombres de las funciones declaradas SECURITY DEFINER.
 *
 * Hay que abarcar la definición ENTERA, no su cabecera: en este repo
 * conviven los dos estilos, y en el más común
 *
 *   CREATE FUNCTION f() RETURNS x AS $$ ... $$ LANGUAGE sql SECURITY DEFINER;
 *
 * la declaración va DESPUÉS del cuerpo. Mirar solo hasta el `$$` de
 * apertura se dejaba cinco funciones fuera —entre ellas
 * `record_webhook_failure`, la que motivó todo esto— y el test pasaba
 * tan tranquilo.
 */
function securityDefinerFunctions(sql: string): Set<string> {
  const found = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([A-Za-z0-9_.]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    // Localiza la etiqueta de dollar-quoting ($$ o $tag$), su cierre, y
    // el `;` que termina la sentencia.
    const tag = /\$[A-Za-z0-9_]*\$/.exec(sql.slice(m.index));
    let end: number;
    if (tag) {
      const openAt = m.index + tag.index;
      const closeAt = sql.indexOf(tag[0], openAt + tag[0].length);
      const semi = closeAt === -1 ? -1 : sql.indexOf(";", closeAt);
      end = semi === -1 ? sql.length : semi;
    } else {
      end = sql.length;
    }
    if (/SECURITY\s+DEFINER/i.test(sql.slice(m.index, end))) found.add(bareName(m[1]));
  }
  return found;
}

/** Funciones con un `REVOKE ... ON FUNCTION x(...) ... FROM ... PUBLIC`. */
function revokedFromPublic(sql: string): Set<string> {
  const found = new Set<string>();
  const re =
    /REVOKE\s+[\s\S]*?ON\s+FUNCTION\s+([A-Za-z0-9_.]+)\s*\([^)]*\)\s*FROM\s+([^;]+);/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    if (/\bPUBLIC\b/i.test(m[2])) found.add(bareName(m[1]));
  }
  return found;
}

describe("toda función SECURITY DEFINER revoca EXECUTE a PUBLIC", () => {
  const sql = stripComments(allSql);
  const secdef = securityDefinerFunctions(sql);
  const revoked = revokedFromPublic(sql);

  it("encuentra migraciones y funciones que auditar", () => {
    // Guarda del guard: un glob roto o un regex que deje de casar haría
    // que todo lo de abajo pasara sin comprobar nada.
    expect(sqlFiles.length).toBeGreaterThan(40);
    expect(secdef.size).toBeGreaterThanOrEqual(20);
    expect(revoked.size).toBeGreaterThanOrEqual(20);
  });

  it("ninguna queda sin revocar", () => {
    const offenders = [...secdef].filter((fn) => !revoked.has(fn)).sort();

    expect(
      offenders,
      `Estas funciones son SECURITY DEFINER y nadie les revoca EXECUTE a PUBLIC.\n\n` +
        `Postgres se lo concede solo al crearlas, así que quedan invocables por\n` +
        `cualquiera con la clave anon —la que va en el bundle del navegador— y\n` +
        `SECURITY DEFINER significa que además se saltan RLS.\n\n` +
        `Añade a la migración de cada una:\n\n` +
        `  REVOKE ALL ON FUNCTION public.<nombre>(<args>) FROM PUBLIC, anon, authenticated;\n` +
        `  GRANT EXECUTE ON FUNCTION public.<nombre>(<args>) TO <solo el rol que la llama>;\n\n` +
        `Si de verdad la llama un rol concreto, concédeselo nominalmente. Si solo\n` +
        `la invoca un trigger, no concedas nada: dentro de un trigger el usuario\n` +
        `efectivo es el dueño de la función.\n\n` +
        offenders.map((f) => `  - ${f}`).join("\n") +
        "\n",
    ).toEqual([]);
  });
});

describe("el seed de desarrollo no reabre lo que las migraciones cierran", () => {
  const seed = stripComments(readFileSync(SEED, "utf8"));

  // Esta es la regresión que de verdad importa vigilar. El seed corre
  // DESPUÉS de las migraciones, así que un GRANT amplio aquí borra cada
  // REVOKE que se acaba de escribir — y en silencio, porque nada falla.
  //
  // Peor que eso: dejaba la base local MÁS permisiva que producción, de
  // modo que ninguna prueba local podía detectar un fallo de permisos.
  // Once funciones estuvieron abiertas a `anon` durante meses y el
  // entorno donde se probaba no podía enseñarlo.
  it("no concede funciones en bloque", () => {
    expect(
      /GRANT\s+[\s\S]{0,40}ON\s+ALL\s+FUNCTIONS/i.test(seed),
      "supabase/seed.sql vuelve a conceder TODAS las funciones del esquema. " +
        "Eso deshace la migración 052 en cada `supabase db reset`. " +
        "Concede nominalmente en la migración de cada función.",
    ).toBe(false);
  });

  it("no concede funciones por privilegios por defecto", () => {
    expect(
      /ALTER\s+DEFAULT\s+PRIVILEGES[\s\S]{0,120}?GRANT[\s\S]{0,40}?ON\s+FUNCTIONS/i.test(seed),
      "supabase/seed.sql deja privilegios por defecto sobre funciones: toda " +
        "función futura nacería abierta, que es justo cómo pasó desapercibido.",
    ).toBe(false);
  });

  // El contrapeso: los GRANT de tablas SÍ deben seguir ahí. Sobre tablas
  // el argumento original es correcto —RLS sigue aplicando— y quitarlos
  // rompería el stack local entero.
  it("conserva los permisos de tablas, que sí hacen falta", () => {
    expect(/GRANT\s+ALL\s+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public/i.test(seed)).toBe(true);
  });
});
