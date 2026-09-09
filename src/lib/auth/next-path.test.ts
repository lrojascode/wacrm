import { describe, expect, it } from "vitest";

import { buildLoginPath, sanitizeNextPath } from "./next-path";

describe("sanitizeNextPath", () => {
  it("acepta rutas internas, conservando query y hash", () => {
    expect(sanitizeNextPath("/inbox")).toBe("/inbox");
    expect(sanitizeNextPath("/inbox?c=abc-123")).toBe("/inbox?c=abc-123");
    expect(sanitizeNextPath("/contacts?tag=a&tag=b#top")).toBe("/contacts?tag=a&tag=b#top");
  });

  it("normaliza el recorrido de directorios", () => {
    expect(sanitizeNextPath("/inbox/../contacts")).toBe("/contacts");
    // No puede escapar de la raíz.
    expect(sanitizeNextPath("/../../etc/passwd")).toBe("/etc/passwd");
  });

  describe("rechaza destinos externos", () => {
    it("URLs absolutas", () => {
      expect(sanitizeNextPath("https://evil.example/x")).toBeNull();
      expect(sanitizeNextPath("http://evil.example")).toBeNull();
    });

    it("esquemas peligrosos", () => {
      expect(sanitizeNextPath("javascript:alert(1)")).toBeNull();
      expect(sanitizeNextPath("data:text/html,<script>")).toBeNull();
    });

    // El caso que sobrevive a una comprobación ingenua de "empieza por /".
    it("relativo al protocolo", () => {
      expect(sanitizeNextPath("//evil.example")).toBeNull();
      expect(sanitizeNextPath("//evil.example/path")).toBeNull();
    });

    it("variantes con barra invertida que algunos navegadores normalizan", () => {
      expect(sanitizeNextPath("/\\evil.example")).toBeNull();
      expect(sanitizeNextPath("/\\\\evil.example")).toBeNull();
    });
  });

  it("rechaza espacios y caracteres de control", () => {
    expect(sanitizeNextPath("/inbox with space")).toBeNull();
    expect(sanitizeNextPath("/inbox\nSet-Cookie: x=1")).toBeNull();
    expect(sanitizeNextPath("/inbox\r\n")).toBeNull();
    expect(sanitizeNextPath("/inbox\t")).toBeNull();
  });

  it("rechaza las propias páginas de auth para no crear un bucle", () => {
    expect(sanitizeNextPath("/login")).toBeNull();
    expect(sanitizeNextPath("/login?next=/login")).toBeNull();
    expect(sanitizeNextPath("/signup")).toBeNull();
    expect(sanitizeNextPath("/forgot-password")).toBeNull();
    expect(sanitizeNextPath("/reset-password")).toBeNull();
    expect(sanitizeNextPath("/auth/callback")).toBeNull();
  });

  it("no confunde rutas que solo empiezan igual", () => {
    // `/logins` no es `/login`.
    expect(sanitizeNextPath("/logins")).toBe("/logins");
    expect(sanitizeNextPath("/authors")).toBe("/authors");
  });

  it("rechaza valores vacíos o ausentes", () => {
    expect(sanitizeNextPath(null)).toBeNull();
    expect(sanitizeNextPath(undefined)).toBeNull();
    expect(sanitizeNextPath("")).toBeNull();
  });
});

describe("buildLoginPath", () => {
  it("adjunta un next válido, codificado", () => {
    expect(buildLoginPath("/inbox?c=abc")).toBe("/login?next=%2Finbox%3Fc%3Dabc");
  });

  it("omite next cuando el origen no sirve como destino", () => {
    expect(buildLoginPath("//evil.example")).toBe("/login");
    expect(buildLoginPath("/login")).toBe("/login");
    expect(buildLoginPath(null)).toBe("/login");
  });
});
