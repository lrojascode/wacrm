// ============================================================
// TOTP (RFC 6238) para las pruebas.
//
// Los usuarios semilla con rol admin u owner llevan segundo factor
// inscrito desde P0-SEC-09, porque en producción lo llevarán: sin él,
// ninguna prueba podría tocar una ruta de configuración, y la suite
// dejaría de cubrir justo la mitad que el control protege.
//
// Se genera el código aquí en vez de simular una app de autenticación
// porque es el mismo algoritmo, en treinta líneas, sin dependencias
// nuevas: HMAC-SHA1 sobre el número de intervalo de 30 s, y seis
// dígitos sacados del offset dinámico.
// ============================================================

import { createHmac } from "node:crypto";

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  let bits = "";
  for (const ch of input.replace(/=+$/, "").toUpperCase()) {
    const idx = BASE32.indexOf(ch);
    if (idx === -1) continue; // espacios y guiones que algunas apps muestran
    bits += idx.toString(2).padStart(5, "0");
  }
  const bytes = (bits.match(/.{8}/g) ?? []).map((b) => parseInt(b, 2));
  return Buffer.from(bytes);
}

/** Código de seis dígitos para `secret` en el instante `when`. */
export function totpCode(secret: string, when: number = Date.now()): string {
  const counter = Math.floor(when / 1000 / 30);
  const message = Buffer.alloc(8);
  message.writeBigUInt64BE(BigInt(counter));

  const digest = createHmac("sha1", base32Decode(secret)).update(message).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const binary = digest.readUInt32BE(offset) & 0x7fffffff;
  return (binary % 1_000_000).toString().padStart(6, "0");
}

/**
 * Cuánto queda del intervalo actual, en ms.
 *
 * Sirve para no verificar un código a un segundo de que caduque: entre
 * generarlo y que el servidor lo compruebe puede cambiar el intervalo,
 * y el fallo aparecería una vez de cada treinta — la clase de prueba
 * intermitente que acaba desactivada en vez de arreglada.
 */
export function msLeftInWindow(when: number = Date.now()): number {
  return 30_000 - (when % 30_000);
}
