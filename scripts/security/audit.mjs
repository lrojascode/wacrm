#!/usr/bin/env node
// ============================================================
// Gate de dependencias (P0-DEP-04).
//
// Corre `pnpm audit` dos veces —el árbol completo y solo el de
// producción— y aplica la política de src/lib/security/audit-policy.ts.
// Dos pasadas porque el ámbito de un advisory no se declara a mano: se
// deriva de dónde aparece. Una vulnerabilidad en eslint no llega al
// navegador de nadie; una en una dependencia de producción sí, y sus
// excepciones caducan antes.
//
// Este archivo solo hace de fontanería: ejecutar, parsear y presentar.
// Las decisiones están en el módulo de política, que se prueba sin red
// ni disco — es donde se equivocaría uno en silencio.
//
//   pnpm audit:ci     falla si hay algo que bloquee
// ============================================================

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { evaluateAudit, formatVerdict } from "./audit-policy.mjs";
/** `pnpm audit` sale con código != 0 cuando encuentra algo: eso no es un error. */
function runAudit(args) {
  try {
    return execFileSync("pnpm", ["audit", "--json", ...args], {
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (err) {
    if (typeof err.stdout === "string" && err.stdout.trim()) return err.stdout;
    throw err;
  }
}

function parseAdvisories(raw) {
  const parsed = JSON.parse(raw);
  const out = new Map();
  for (const entry of Object.values(parsed.advisories ?? {})) {
    const id = entry.github_advisory_id;
    if (!id) continue;
    const existing = out.get(id);
    const paths = (entry.findings ?? []).flatMap((f) => f.paths ?? []);
    if (existing) {
      existing.paths.push(...paths);
      continue;
    }
    out.set(id, {
      id,
      module: entry.module_name,
      severity: entry.severity,
      title: entry.title,
      paths,
    });
  }
  return [...out.values()];
}

const full = parseAdvisories(runAudit([]));
const prodIds = new Set(parseAdvisories(runAudit(["--prod"])).map((a) => a.id));

const config = JSON.parse(readFileSync("security/audit-exceptions.json", "utf8"));
const exceptions = config.exceptions ?? [];

const verdict = evaluateAudit(full, prodIds, exceptions, new Date());

const counts = full.reduce((acc, a) => {
  acc[a.severity] = (acc[a.severity] ?? 0) + 1;
  return acc;
}, {});
console.log(
  `Árbol completo: ${full.length} advisor(y|ies) — ` +
    Object.entries(counts)
      .map(([s, n]) => `${n} ${s}`)
      .join(", ") || "ninguno",
);
console.log(`De ellos, en el árbol de producción: ${prodIds.size}\n`);
console.log(formatVerdict(verdict));

if (!verdict.ok) {
  console.error(
    "\nLa auditoría de dependencias bloquea.\n" +
      "Arreglar es siempre la primera opción: `pnpm update`, o un override en\n" +
      "package.json (pnpm.overrides) si el paquete vulnerable es transitivo.\n" +
      "Si de verdad no se puede hoy, añade la excepción en\n" +
      "security/audit-exceptions.json con su fecha de caducidad.\n",
  );
  process.exit(1);
}
