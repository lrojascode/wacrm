// ============================================================
// P0-DEP-04 — qué advisory bloquea el merge y cuál se tolera.
//
// ESM plano y no TypeScript, a propósito: el gate lo ejecuta Node
// directamente en CI, y Node no importa `.ts` sin un cargador. Añadir
// uno habría metido una dependencia más en la cadena de suministro
// justo para hacer funcionar el control que existe para vigilarla.
// Los tipos van en JSDoc y la corrección la sostienen los tests, que
// es lo que de verdad hacía falta.
//
// La lógica va aparte del script que la ejecuta, y sin tocar red ni
// disco, porque es donde viven las decisiones que se pueden equivocar
// en silencio: una excepción caducada que sigue tapando un fallo, una
// que ya no corresponde a nada, o una fecha puesta a diez años vista.
// Un `pnpm audit | grep` no se puede probar; esto sí.
//
// DOS ÁMBITOS, PORQUE EL RIESGO NO ES EL MISMO
//
// Una vulnerabilidad en `eslint` no llega al navegador de nadie: corre
// en el portátil de quien programa y en CI. Una en una dependencia de
// producción viaja al servidor que atiende a los clientes. Tratarlas
// igual lleva a uno de dos sitios, ambos malos: o se bloquea el trabajo
// por un plugin de linting, o se acaba tolerando lo que sí importa.
//
// Así que el ámbito se DERIVA del árbol donde aparece el advisory
// (`pnpm audit --prod` contra el completo), no se declara a mano. Una
// excepción que se llame a sí misma "dev" para un advisory que sí está
// en producción es un fallo del gate, y por eso se comprueba.
//
// LA CADUCIDAD ES OBLIGATORIA, Y ACOTADA
//
// Una excepción sin fecha es una decisión que nadie vuelve a tomar.
// Pero una fecha sin tope tampoco sirve: basta escribir 2099 y el
// problema desaparece para siempre. De ahí las dos reglas —caducada
// bloquea, y demasiado lejos también—: conservar una excepción exige
// volver a fecharla, y volver a fecharla es la revisión.
// ============================================================

/** @typedef {"info"|"low"|"moderate"|"high"|"critical"} Severity */

/** A partir de aquí, bloquea. */
const BLOCKING = new Set(["high", "critical"]);

/**
 * Cuánto puede durar una excepción, según dónde viva el advisory.
 *
 * Producción más corto a propósito: es lo que atiende a los clientes,
 * y un mes es tiempo de sobra para actualizar o para decidir que no se
 * puede y escribir por qué otra vez.
 */
export const MAX_EXCEPTION_DAYS = { prod: 30, dev: 90 };

/**
 * @typedef {object} Advisory
 * @property {string} id      Identificador de GitHub, p. ej. GHSA-3jxr-9vmj-r5cp.
 * @property {string} module
 * @property {Severity} severity
 * @property {string} title
 * @property {string[]} paths Rutas de dependencia donde aparece. Solo informativas.
 */

/**
 * @typedef {object} AuditException
 * @property {string} advisory
 * @property {string} package
 * @property {string} reason
 * @property {string} closingCondition
 * @property {string} expires  YYYY-MM-DD. Obligatoria.
 */

/**
 * @typedef {object} AuditVerdict
 * @property {boolean} ok
 * @property {Advisory[]} blocking            high+ sin excepción válida.
 * @property {AuditException[]} expired       Excepciones cuya fecha ya pasó.
 * @property {{exception: AuditException, why: string}[]} badDate  Fecha inválida o demasiado lejana.
 * @property {AuditException[]} unused        Ya no corresponden a ningún advisory high+.
 * @property {{advisory: Advisory, exception: AuditException, scope: "prod"|"dev"}[]} excused
 */

function daysBetween(from, to) {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/** Medianoche UTC del día de `date`, para comparar fechas sin horas. */
function startOfDay(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function parseExpiry(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  // Rechaza fechas que existen como cadena pero no como día
  // ('2026-02-31' se desliza a marzo si no se comprueba).
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/**
 * Decide si la auditoría pasa.
 *
 * @param {Advisory[]} advisories      Todo lo encontrado en el árbol completo.
 * @param {ReadonlySet<string>} prodIds  Ids que además aparecen en el árbol de producción.
 * @param {AuditException[]} exceptions  Las excepciones declaradas.
 * @param {Date} [now]                 Inyectable para poder probar el paso del tiempo.
 * @returns {AuditVerdict}
 */
export function evaluateAudit(advisories, prodIds, exceptions, now = new Date()) {
  const today = startOfDay(now);
  const blockingAdvisories = advisories.filter((a) => BLOCKING.has(a.severity));

  /** @type {Map<string, AuditException>} */
  const byId = new Map();
  /** @type {AuditVerdict["badDate"]} */
  const badDate = [];
  /** @type {AuditException[]} */
  const expired = [];

  for (const ex of exceptions) {
    const expiry = parseExpiry(ex.expires);
    if (expiry === null) {
      badDate.push({
        exception: ex,
        why: `"${ex.expires}" no es una fecha YYYY-MM-DD válida`,
      });
      continue;
    }
    if (expiry < today) {
      expired.push(ex);
      continue;
    }
    // El ámbito no se declara: se mira dónde está el advisory de verdad.
    const scope = prodIds.has(ex.advisory) ? "prod" : "dev";
    const limit = MAX_EXCEPTION_DAYS[scope];
    const life = daysBetween(today, expiry);
    if (life > limit) {
      badDate.push({
        exception: ex,
        why:
          `caduca dentro de ${life} días y el máximo en ${scope} es ${limit}. ` +
          `Una excepción que se puede aparcar no es una excepción.`,
      });
      continue;
    }
    byId.set(ex.advisory, ex);
  }

  /** @type {Advisory[]} */
  const blocking = [];
  /** @type {AuditVerdict["excused"]} */
  const excused = [];
  const used = new Set();

  for (const advisory of blockingAdvisories) {
    const ex = byId.get(advisory.id);
    if (!ex) {
      blocking.push(advisory);
      continue;
    }
    used.add(ex.advisory);
    excused.push({
      advisory,
      exception: ex,
      scope: prodIds.has(advisory.id) ? "prod" : "dev",
    });
  }

  // Una excepción que ya no tapa nada es ruido que acaba tapando algo:
  // se queda ahí, alguien la ve y asume que ese advisory sigue vivo.
  // Mismo criterio que la allowlist de route-guards.
  const unused = exceptions.filter(
    (ex) =>
      !used.has(ex.advisory) &&
      !expired.includes(ex) &&
      !badDate.some((b) => b.exception === ex),
  );

  return {
    ok:
      blocking.length === 0 &&
      expired.length === 0 &&
      badDate.length === 0 &&
      unused.length === 0,
    blocking,
    expired,
    badDate,
    unused,
    excused,
  };
}

/**
 * Informe legible del veredicto, para la salida de CI.
 * @param {AuditVerdict} verdict
 * @returns {string}
 */
export function formatVerdict(verdict) {
  /** @type {string[]} */
  const lines = [];

  for (const a of verdict.blocking) {
    lines.push(
      `BLOQUEA  ${a.severity.toUpperCase()}  ${a.module}  ${a.id}\n` +
        `         ${a.title}\n` +
        `         ${a.paths[0] ?? "(sin ruta)"}\n`,
    );
  }
  for (const ex of verdict.expired) {
    lines.push(
      `CADUCADA ${ex.advisory} (${ex.package}) venció el ${ex.expires}.\n` +
        `         Condición de cierre: ${ex.closingCondition}\n` +
        `         Arréglalo, o vuelve a fecharla explicando por qué sigue abierta.\n`,
    );
  }
  for (const { exception, why } of verdict.badDate) {
    lines.push(`FECHA    ${exception.advisory} (${exception.package}): ${why}\n`);
  }
  for (const ex of verdict.unused) {
    lines.push(
      `SOBRA    ${ex.advisory} (${ex.package}) ya no corresponde a ningún advisory high+.\n` +
        `         Bórrala: una excepción muerta hace creer que el problema sigue vivo.\n`,
    );
  }

  if (lines.length === 0) {
    const excused = verdict.excused.length;
    return excused === 0
      ? "Sin advisories high+ y sin excepciones abiertas."
      : `Sin advisories high+ sin justificar. ${excused} excepción(es) vigente(s):\n` +
          verdict.excused
            .map(
              (e) =>
                `  ${e.advisory.id} (${e.advisory.module}, ${e.scope}) hasta ${e.exception.expires}`,
            )
            .join("\n");
  }

  return lines.join("\n");
}
