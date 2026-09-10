// ============================================================
// P0-SEC-07 — cada bundle deja constancia de haberse aplicado.
//
// El tercer guard mecánico de esta tanda, y el mismo razonamiento que
// los otros dos (route-guards, function-grants): la regla no se
// sostiene pidiéndole a la gente que se acuerde.
//
// Aquí el olvido es especialmente silencioso. Un bundle sin bloque de
// registro se aplica perfectamente y no falla nada — simplemente deja
// de constar, y `check-applied.sql` dirá "APPLIED, sin registrar" para
// siempre. Nadie lo mira hasta que hay que responder "¿qué le falta a
// este cliente?" con seis proyectos y una lista incompleta.
//
// Se comprueba sobre el texto de los bundles, que es lo que de verdad
// se pega en el editor de Supabase — no sobre el generador. Los dos
// bundles escritos a mano no pasan por él, y son justo los que se
// habrían quedado fuera.
// ============================================================

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

const DEPLOY_DIR = join(process.cwd(), "docs", "deploy");

/** `check-applied.sql` consulta el registro, no lo escribe. */
const NOT_A_BUNDLE = new Set(["check-applied.sql"]);

const bundles = readdirSync(DEPLOY_DIR)
  .filter((f) => f.endsWith(".sql") && !NOT_A_BUNDLE.has(f))
  .map((file) => ({ file, sql: readFileSync(join(DEPLOY_DIR, file), "utf8") }));

describe("bundles de despliegue · registro de aplicación", () => {
  it("encuentra bundles que auditar", () => {
    // Guarda del guard: si el glob se rompe, todo lo de abajo pasaría
    // sin comprobar nada.
    expect(bundles.length).toBeGreaterThanOrEqual(10);
  });

  it("todos crean la tabla del registro si falta", () => {
    // Sin esto, un bundle solo funcionaría en un proyecto donde alguien
    // recordó correr la 053 antes — y los bundles se aplican en el
    // orden que le convenga a cada cliente.
    const offenders = bundles
      .filter((b) => !/CREATE TABLE IF NOT EXISTS public\.schema_release/i.test(b.sql))
      .map((b) => b.file);

    expect(
      offenders,
      "Estos bundles insertan en el registro sin crearlo:\n" +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("todos registran al menos una versión", () => {
    const offenders = bundles
      .filter((b) => !/INSERT INTO public\.schema_release/i.test(b.sql))
      .map((b) => b.file);

    expect(
      offenders,
      `Estos bundles no dejan constancia de haberse aplicado.\n\n` +
        `Si lo generó scripts/deploy/bundle-migrations.sh, regenéralo — el\n` +
        `bloque lo emite el generador. Si está escrito a mano, copia el\n` +
        `bloque del final de docs/deploy/revoke-public-execute.sql.\n\n` +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("el registro es idempotente en todos", () => {
    // Sin ON CONFLICT, reaplicar un bundle —cosa que el README invita a
    // hacer, porque son idempotentes— reventaría con violación de clave
    // primaria a mitad del script.
    const offenders = bundles
      .filter((b) => !/ON CONFLICT \(version\) DO NOTHING/i.test(b.sql))
      .map((b) => b.file);

    expect(offenders).toEqual([]);
  });

  it("el registro va al final, no al principio", () => {
    // Si el editor de Supabase corta el script —pasa, y el README
    // explica cómo correrlo por tramos— un registro al principio daría
    // por aplicado un bundle que quedó a medias.
    const offenders = bundles
      .filter((b) => {
        // La ÚLTIMA aparición, no la primera. El bundle de la propia
        // 053 lleva además el relleno retroactivo, que también inserta
        // en la tabla y aparece antes: buscar la primera lo marcaba
        // como infractor cuando su bloque de registro está donde debe.
        const matches = [...b.sql.matchAll(/INSERT INTO public\.schema_release/gi)];
        if (matches.length === 0) return false; // ya lo cubre otro test
        const last = matches[matches.length - 1].index ?? 0;
        return last < b.sql.length * 0.66;
      })
      .map((b) => b.file);

    expect(
      offenders,
      "El registro debe ir al final del bundle:\n" +
        offenders.map((f) => `  - ${f}`).join("\n"),
    ).toEqual([]);
  });

  it("cada versión registrada corresponde a una migración real", () => {
    // Un typo en el número ('05' por '050') registra algo que no
    // existe, y check-applied nunca lo cruzaría con su fila.
    const known = new Set(
      readdirSync(join(process.cwd(), "supabase", "migrations"))
        .filter((f) => f.endsWith(".sql"))
        .map((f) => f.slice(0, 3)),
    );

    const bogus: string[] = [];
    for (const b of bundles) {
      const re = /\(\s*'(\d{1,4})'\s*,\s*'docs\/deploy\/[^']+'\s*\)/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(b.sql)) !== null) {
        if (!known.has(m[1])) bogus.push(`${b.file}: '${m[1]}'`);
      }
    }

    expect(
      bogus,
      "Versiones registradas que no existen en supabase/migrations:\n" +
        bogus.map((x) => `  - ${x}`).join("\n"),
    ).toEqual([]);
  });
});
