// P0-SEC-09 — las decisiones puras: quién necesita segundo factor y
// qué cuenta como "autenticado hace poco".
//
// Se prueban aparte del guard porque son donde viven los casos raros
// —un `amr` vacío, un timestamp adelantado, una forma antigua del
// claim— y ahí un fallo abierto no se ve: la petición simplemente pasa.

import { describe, expect, it } from "vitest";

import {
  REAUTH_WINDOW_MS,
  deriveMfaStatus,
  hasEnrolledFactor,
  isReauthFresh,
  lastAuthenticatedAt,
} from "./mfa";

const ahora = Date.UTC(2026, 8, 10, 12, 0, 0);
const segundos = (ms: number) => Math.floor(ms / 1000);

describe("hasEnrolledFactor", () => {
  it("reconoce un factor verificado", () => {
    expect(hasEnrolledFactor([{ status: "verified" }])).toBe(true);
  });

  it("uno a medio inscribir no cuenta", () => {
    // Quien abandonó la inscripción a mitad no tiene con qué superar un
    // reto: tratarlo como activado lo dejaría fuera sin salida.
    expect(hasEnrolledFactor([{ status: "unverified" }])).toBe(false);
  });

  it("sin factores, no", () => {
    expect(hasEnrolledFactor([])).toBe(false);
    expect(hasEnrolledFactor(null)).toBe(false);
    expect(hasEnrolledFactor(undefined)).toBe(false);
  });
});

describe("deriveMfaStatus", () => {
  it("aal2 basta", () => {
    expect(deriveMfaStatus("aal2", [])).toBe("satisfied");
  });

  it("con factor verificado pero sin usarlo, pide el código", () => {
    expect(deriveMfaStatus("aal1", [{ status: "verified" }])).toBe(
      "challenge_required",
    );
  });

  it("sin factor activado no se exige nada", () => {
    // El corazón de que sea opcional: quien no lo activó pasa, y pasa
    // sea cual sea su rol.
    expect(deriveMfaStatus("aal1", [])).toBe("satisfied");
    // Un factor a medio inscribir tampoco cuenta: quien abandonó la
    // inscripción no tiene con qué superar el reto.
    expect(deriveMfaStatus("aal1", [{ status: "unverified" }])).toBe("satisfied");
  });

  it("con factor activado, un aal raro no se toma por bueno", () => {
    // Aquí sí hay que fallar cerrado: si lo activaste, un token sin la
    // claim no puede valer como reto superado.
    expect(deriveMfaStatus(undefined, [{ status: "verified" }])).toBe(
      "challenge_required",
    );
    expect(deriveMfaStatus("aal3", [{ status: "verified" }])).toBe(
      "challenge_required",
    );
    // Y sin factor, cerrado no significa bloquear a quien no eligió nada.
    expect(deriveMfaStatus(null, [])).toBe("satisfied");
  });
});

describe("lastAuthenticatedAt", () => {
  it("toma el evento más reciente, sea cual sea el método", () => {
    const amr = [
      { method: "password", timestamp: segundos(ahora) - 600 },
      { method: "totp", timestamp: segundos(ahora) - 30 },
    ];
    expect(lastAuthenticatedAt(amr)).toBe((segundos(ahora) - 30) * 1000);
  });

  it("no depende del orden", () => {
    const a = [
      { method: "totp", timestamp: segundos(ahora) - 30 },
      { method: "password", timestamp: segundos(ahora) - 600 },
    ];
    expect(lastAuthenticatedAt(a)).toBe((segundos(ahora) - 30) * 1000);
  });

  it("devuelve null cuando no hay nada utilizable", () => {
    expect(lastAuthenticatedAt(undefined)).toBeNull();
    expect(lastAuthenticatedAt([])).toBeNull();
    expect(lastAuthenticatedAt("password")).toBeNull();
    // La forma antigua del claim: strings sin timestamp. Ignorarlos es
    // lo correcto; tomarlos por "ahora" sería fallar en abierto.
    expect(lastAuthenticatedAt(["password", "totp"])).toBeNull();
    expect(lastAuthenticatedAt([{ method: "totp" }])).toBeNull();
    expect(lastAuthenticatedAt([{ method: "totp", timestamp: "hace poco" }])).toBeNull();
  });
});

describe("isReauthFresh", () => {
  const hace = (s: number) => [{ method: "totp", timestamp: segundos(ahora) - s }];

  it("acepta lo reciente y rechaza lo viejo", () => {
    expect(isReauthFresh(hace(10), ahora)).toBe(true);
    expect(isReauthFresh(hace(30 * 60), ahora)).toBe(false);
  });

  it("el borde de la ventana entra", () => {
    const justo = segundos(REAUTH_WINDOW_MS) - 1;
    expect(isReauthFresh(hace(justo), ahora)).toBe(true);
    expect(isReauthFresh(hace(segundos(REAUTH_WINDOW_MS) + 1), ahora)).toBe(false);
  });

  it("sin amr no hay frescura", () => {
    // El caso que importa: ante un token sin la claim, negar. Aceptar
    // dejaría las acciones críticas sin reautenticación y nada lo
    // delataría.
    expect(isReauthFresh(undefined, ahora)).toBe(false);
    expect(isReauthFresh([], ahora)).toBe(false);
  });

  it("un timestamp en el futuro no compra tiempo", () => {
    // Con un reloj adelantado, `now - at` sale negativo y "≤ ventana"
    // sería cierto para siempre.
    expect(isReauthFresh([{ method: "totp", timestamp: segundos(ahora) + 86_400 }], ahora)).toBe(
      false,
    );
  });

  it("tolera el desfase de reloj de un minuto", () => {
    // Servidor y GoTrue no comparten reloj exacto; unos segundos por
    // delante son normales y no deben leerse como manipulación.
    expect(isReauthFresh([{ method: "totp", timestamp: segundos(ahora) + 30 }], ahora)).toBe(
      true,
    );
  });
});
