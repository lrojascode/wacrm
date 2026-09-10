// ============================================================
// Dónde viven los secretos TOTP de los usuarios semilla.
//
// El seed inscribe el factor (necesita la sesión del usuario, así que
// no puede hacerse con la clave de servicio) y `loginAs` necesita el
// secreto para generar el código y superar el reto. Los dos corren en
// procesos distintos —global setup y cada worker de Playwright—, así
// que el traspaso es un archivo.
//
// No se versiona: describe usuarios de un stack local y no sirve para
// nada fuera de él, pero un secreto TOTP en el repositorio es un
// secreto en el repositorio.
// ============================================================

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const FILE = join(process.cwd(), "e2e", ".mfa-secrets.json");

export function readMfaSecrets(): Record<string, string> {
  if (!existsSync(FILE)) return {};
  try {
    const parsed = JSON.parse(readFileSync(FILE, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        ([, v]) => typeof v === "string",
      ) as Array<[string, string]>,
    );
  } catch {
    // Un archivo corrupto se trata como ausente: el seed vuelve a
    // inscribir y sigue. Fallar aquí bloquearía la suite entera por un
    // artefacto local que se regenera solo.
    return {};
  }
}

export function writeMfaSecrets(secrets: Record<string, string>): void {
  mkdirSync(dirname(FILE), { recursive: true });
  writeFileSync(FILE, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}

export function mfaSecretFor(email: string): string | null {
  return readMfaSecrets()[email] ?? null;
}
