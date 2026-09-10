// ============================================================
// P0-DEP-04 — las reglas del gate de dependencias.
//
// Un gate que falla en abierto no se nota: CI sigue verde y nadie
// vuelve a mirar. Por eso lo que se prueba aquí no es tanto "bloquea lo
// malo" como "no deja de bloquear por el camino": una excepción
// caducada que sigue tapando, una fecha puesta a diez años vista, o una
// entrada que ya no corresponde a nada y hace creer que el problema
// sigue vivo.
// ============================================================

import { describe, expect, it } from "vitest";

// El módulo es ESM plano —Node lo ejecuta en CI sin cargador— pero sus
// typedefs JSDoc sí llegan a TypeScript, así que esto está tipado de
// verdad. Se nota: la primera versión de los helpers de abajo pasaba
// `severity: string` y el typecheck lo rechazó.
import {
  MAX_EXCEPTION_DAYS,
  evaluateAudit,
  formatVerdict,
} from "../../../scripts/security/audit-policy.mjs";

type Severity = "info" | "low" | "moderate" | "high" | "critical";

const HOY = new Date("2026-09-10T12:00:00Z");

/** Fecha a N días de HOY, en YYYY-MM-DD. */
const enDias = (n: number) =>
  new Date(HOY.getTime() + n * 86_400_000).toISOString().slice(0, 10);

interface AdvisoryShape {
  id: string;
  module: string;
  severity: Severity;
  title: string;
  paths: string[];
}

const advisory = (over: Partial<AdvisoryShape> = {}): AdvisoryShape => ({
  id: "GHSA-aaaa-bbbb-cccc",
  module: "paquete-vulnerable",
  severity: "high",
  title: "Algo feo",
  paths: [".>eslint>paquete-vulnerable"],
  ...over,
});

interface ExceptionShape {
  advisory: string;
  package: string;
  reason: string;
  closingCondition: string;
  expires: string;
}

const exception = (over: Partial<ExceptionShape> & Record<string, unknown> = {}): ExceptionShape => ({
  advisory: "GHSA-aaaa-bbbb-cccc",
  package: "paquete-vulnerable",
  reason: "Sin versión parcheada todavía",
  closingCondition: "Actualizar cuando salga la 2.1",
  expires: enDias(10),
  ...over,
});

const sinProd = new Set<string>();
const conProd = new Set(["GHSA-aaaa-bbbb-cccc"]);

describe("qué bloquea", () => {
  it("un high sin excepción bloquea", () => {
    const v = evaluateAudit([advisory()], sinProd, [], HOY);
    expect(v.ok).toBe(false);
    expect(v.blocking).toHaveLength(1);
  });

  it("un critical también", () => {
    const v = evaluateAudit([advisory({ severity: "critical" })], sinProd, [], HOY);
    expect(v.ok).toBe(false);
  });

  it("moderate y low no", () => {
    // El umbral es parte del contrato: si bloqueara todo, el gate se
    // desactivaría en una semana y dejaría de proteger de lo que sí
    // importa.
    const v = evaluateAudit(
      [advisory({ severity: "moderate" }), advisory({ id: "X", severity: "low" })],
      sinProd,
      [],
      HOY,
    );
    expect(v.ok).toBe(true);
    expect(v.blocking).toHaveLength(0);
  });

  it("sin advisories, pasa", () => {
    expect(evaluateAudit([], sinProd, [], HOY).ok).toBe(true);
  });
});

describe("excepciones vigentes", () => {
  it("una excepción válida deja pasar el advisory", () => {
    const v = evaluateAudit([advisory()], sinProd, [exception()], HOY);
    expect(v.ok).toBe(true);
    expect(v.excused).toHaveLength(1);
    expect(v.blocking).toHaveLength(0);
  });

  it("solo tapa el advisory que nombra", () => {
    // Una excepción que tapara de más sería peor que no tenerla: daría
    // por revisado algo que nadie miró.
    const v = evaluateAudit(
      [advisory(), advisory({ id: "GHSA-otro-otro-otro" })],
      sinProd,
      [exception()],
      HOY,
    );
    expect(v.ok).toBe(false);
    expect(v.blocking.map((a) => a.id)).toEqual(["GHSA-otro-otro-otro"]);
  });
});

describe("la caducidad tiene dientes", () => {
  it("una excepción caducada bloquea, aunque cubra el advisory", () => {
    // El caso central. Sin esto, una excepción escrita una vez tapa el
    // problema para siempre y el gate se convierte en decoración.
    const v = evaluateAudit([advisory()], sinProd, [exception({ expires: enDias(-1) })], HOY);
    expect(v.ok).toBe(false);
    expect(v.expired).toHaveLength(1);
    expect(v.blocking).toHaveLength(1);
  });

  it("el día de caducidad todavía vale", () => {
    const v = evaluateAudit([advisory()], sinProd, [exception({ expires: enDias(0) })], HOY);
    expect(v.ok).toBe(true);
  });

  it("una fecha demasiado lejana bloquea", () => {
    // Sin tope, basta escribir 2099 y el problema desaparece para
    // siempre — que es exactamente lo que la caducidad debía impedir.
    const v = evaluateAudit(
      [advisory()],
      sinProd,
      [exception({ expires: enDias(MAX_EXCEPTION_DAYS.dev + 1) })],
      HOY,
    );
    expect(v.ok).toBe(false);
    expect(v.badDate).toHaveLength(1);
    expect(v.badDate[0].why).toMatch(/máximo en dev/);
  });

  it("producción tiene menos cuerda que desarrollo", () => {
    // Un advisory que alcanza el árbol de producción viaja al servidor
    // que atiende a los clientes; uno de eslint, no.
    const dias = MAX_EXCEPTION_DAYS.prod + 5;
    expect(dias).toBeLessThanOrEqual(MAX_EXCEPTION_DAYS.dev);

    const enDev = evaluateAudit([advisory()], sinProd, [exception({ expires: enDias(dias) })], HOY);
    const enProd = evaluateAudit([advisory()], conProd, [exception({ expires: enDias(dias) })], HOY);

    expect(enDev.ok).toBe(true);
    expect(enProd.ok).toBe(false);
    expect(enProd.badDate[0].why).toMatch(/máximo en prod/);
  });

  it("el ámbito se deriva, no se declara", () => {
    // Una excepción no puede llamarse a sí misma "de desarrollo" para
    // ganar plazo: manda dónde aparece el advisory de verdad.
    const conEtiquetaFalsa = exception({ scope: "dev", expires: enDias(MAX_EXCEPTION_DAYS.prod + 5) });
    const v = evaluateAudit([advisory()], conProd, [conEtiquetaFalsa], HOY);
    expect(v.ok).toBe(false);
  });

  it("una fecha que no es una fecha bloquea", () => {
    for (const malo of ["", "pronto", "10-09-2026", "2026-9-1", "2026-02-31"]) {
      const v = evaluateAudit([advisory()], sinProd, [exception({ expires: malo })], HOY);
      expect(v.ok, `"${malo}" no debería valer`).toBe(false);
      expect(v.badDate.length + v.expired.length).toBeGreaterThan(0);
    }
  });
});

describe("excepciones muertas", () => {
  it("una que ya no corresponde a nada bloquea", () => {
    // Mismo criterio que la allowlist de route-guards: una entrada
    // muerta se queda ahí y hace creer que el advisory sigue vivo.
    const v = evaluateAudit([], sinProd, [exception()], HOY);
    expect(v.ok).toBe(false);
    expect(v.unused).toHaveLength(1);
  });

  it("una caducada no se cuenta además como muerta", () => {
    // Contarla dos veces daría dos mensajes para un solo problema, y
    // el segundo apunta a la acción equivocada (borrar en vez de
    // renovar o arreglar).
    const v = evaluateAudit([], sinProd, [exception({ expires: enDias(-1) })], HOY);
    expect(v.expired).toHaveLength(1);
    expect(v.unused).toHaveLength(0);
  });
});

describe("el informe dice qué hacer", () => {
  it("nombra el advisory que bloquea", () => {
    const texto = formatVerdict(evaluateAudit([advisory()], sinProd, [], HOY));
    expect(texto).toContain("GHSA-aaaa-bbbb-cccc");
    expect(texto).toContain("paquete-vulnerable");
  });

  it("una caducada recuerda su condición de cierre", () => {
    // Quien la lea seis meses después necesita saber qué esperaba la
    // persona que la escribió, no solo que venció.
    const texto = formatVerdict(
      evaluateAudit([advisory()], sinProd, [exception({ expires: enDias(-1) })], HOY),
    );
    expect(texto).toContain("Actualizar cuando salga la 2.1");
  });

  it("en verde no inventa alarmas", () => {
    expect(formatVerdict(evaluateAudit([], sinProd, [], HOY))).toMatch(/Sin advisories high\+/);
  });
});
