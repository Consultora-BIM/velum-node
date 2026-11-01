#!/usr/bin/env bun
// Firma SIN CONEXIÓN una cola de retiros o de barrido con la cartera fría.
//
//   bun scripts/firmar-retiros.ts <cola.json> [--salida firmados.json] [--max 10000] [--tope 50000]
//
// 1. Revisa la cola (formato, direcciones, topes) y enseña cada pago.
// 2. Pide confirmación escrita.
// 3. Pide la frase de 24 palabras SIN ECO (no se ve, no se guarda, no va a ningún log).
// 4. Comprueba que la frase es la de la cola (xpub iguales) y firma.
// 5. Escribe el archivo firmado (solo transacciones firmadas, ninguna clave).
//
// Ejecútalo en un ordenador sin red. Los topes (--max, --tope, en USDT) los pone quien firma, no la cola.
import { readFileSync, writeFileSync } from "node:fs";
import { seedFromPhrase, validatePhrase } from "@velum/core";
import { queueHash, reviewQueue, signQueue, summarizeQueue, type PayoutQueue } from "../src/offline";
import { readLine, readSecret } from "../src/terminal";

const argv = process.argv.slice(2);
const opt = (n: string, d: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1]! : d; };
const file = argv.find((a) => !a.startsWith("--") && argv[argv.indexOf(a) - 1]?.startsWith("--") !== true);
if (!file) { console.error("Uso: bun scripts/firmar-retiros.ts <cola.json> [--salida f.json] [--max USDT] [--tope USDT]"); process.exit(1); }

const usdt = (s: string) => BigInt(Math.round(Number(s) * 1_000_000));
const limits = { maxPayout: usdt(opt("--max", "10000")), maxTotalPayout: usdt(opt("--tope", "50000")) };
const out = opt("--salida", file.replace(/\.json$/, "") + ".firmado.json");

const q = JSON.parse(readFileSync(file, "utf8")) as PayoutQueue;
console.log(`Cola: ${file}\nHuella: ${queueHash(q).slice(0, 16)} · cartera fría ${q.coldFingerprint} · ${q.entries.length} transacciones\n`);
console.log(summarizeQueue(q));
const errs = reviewQueue(q, limits);
if (errs.length) { console.error("\nLa cola NO pasa la revisión:\n" + errs.map((e) => "  - " + e).join("\n")); process.exit(1); }

const ok = readLine(`\nRevisa destinos e importes. Para firmar escribe FIRMAR: `).trim();
if (ok !== "FIRMAR") { console.log("Cancelado. No se ha firmado nada."); process.exit(0); }

let phrase = readSecret("Frase de 24 palabras (no se verá): ");
if (!validatePhrase(phrase)) { phrase = ""; console.error("Frase no válida."); process.exit(1); }
const seed = seedFromPhrase(phrase);
phrase = "";
try {
  const signed = signQueue(q, seed, limits);
  writeFileSync(out, JSON.stringify(signed, null, 1));
  console.log(`\nFirmadas ${signed.entries.length} transacciones → ${out}\nLleva este archivo al equipo en línea y emítelo con scripts/emitir-retiros.ts.`);
} catch (e) {
  console.error(`No se ha firmado: ${(e as Error).message}`);
  process.exitCode = 1;
} finally {
  seed.fill(0);
}
