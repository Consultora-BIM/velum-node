#!/usr/bin/env bun
// Cartera fría de la mainnet. Todo sin conexión.
//
//   bun apps/node/scripts/cold-wallet.ts [--out <carpeta>]       crea frase nueva + cold-wallet.public.json
//   bun apps/node/scripts/cold-wallet.ts --verificar [--out …]   pide la frase (sin eco) y comprueba el JSON público
//
// Reglas:
// - La frase de 24 palabras se muestra UNA vez y solo en la terminal (/dev/tty). Nunca va a disco, a stdout ni a un log.
// - Tras copiarla en papel, se borra la pantalla y el historial de la terminal.
// - El archivo `cold-wallet.public.json` solo lleva datos públicos: dirección Velum y xpub de cuenta.
// - Lo ejecuta el propietario en su terminal, en un ordenador sin red. Nunca un agente ni un CI.
import { existsSync, writeFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generatePhrase, seedFromPhrase, validatePhrase, walletFromSeed, walletPath, hashHex, canonical } from "@velum/core";
import { accountXpub, treasuryAddress, ACCOUNT_PATH } from "../../bridge/src/hd";
import { hasTty, ttyClear, ttyReadLine, ttyWrite } from "../../bridge/src/terminal";

export const COLD_WALLET_FILE = "cold-wallet.public.json";

export interface ColdWalletPublic {
  v: 1;
  /** Dirección de cartera Velum (índice 0, igual que la app). Recibe la reserva de génesis. */
  /** Cartera Velum SLIP-10 `m/44'/7420'/0'/0'/0'` (la misma que abre la app y una cartera física). */
  velum: { path: string; address: string; publicKey: string };
  tron: { path: string; xpub: string; treasury: string };
  evm: { path: string; xpub: string; treasury: string };
  /** Huella corta de todo lo anterior: para comprobar a ojo que dos copias son la misma. */
  fingerprint: string;
  created: string;
}

/** Datos públicos a partir de la frase. Pura: no escribe nada. La usan este script y los tests (con frases de prueba). */
export function publicFromPhrase(phrase: string, created = new Date().toISOString()): ColdWalletPublic {
  const seed = seedFromPhrase(phrase);
  try {
    const w = walletFromSeed(seed, 0);
    const tronX = accountXpub(seed, "tron");
    const evmX = accountXpub(seed, "evm");
    const body = {
      velum: { path: walletPath(0, 0), address: w.address, publicKey: w.publicKey },
      tron: { path: ACCOUNT_PATH.tron, xpub: tronX, treasury: treasuryAddress("tron", tronX) },
      evm: { path: ACCOUNT_PATH.evm, xpub: evmX, treasury: treasuryAddress("evm", evmX) },
    };
    return { v: 1, ...body, fingerprint: hashHex(canonical(body)).slice(0, 16), created };
  } finally {
    seed.fill(0);
  }
}

/** Lee y valida `cold-wallet.public.json`. Lanza con un mensaje claro si falta o está mal. */
export function readColdWalletPublic(path: string): ColdWalletPublic {
  if (!existsSync(path)) throw new Error(`Falta ${path}. Créalo con apps/node/scripts/cold-wallet.ts (lo ejecuta el propietario).`);
  const j = JSON.parse(readFileSync(path, "utf8")) as ColdWalletPublic;
  if (j.v !== 1 || !j.velum?.address?.startsWith("vel") || !j.tron?.xpub?.startsWith("xpub") || !j.evm?.xpub?.startsWith("xpub"))
    throw new Error(`${path} no tiene el formato esperado`);
  const { v: _v, fingerprint, created: _c, ...body } = j;
  if (hashHex(canonical(body)).slice(0, 16) !== fingerprint) throw new Error(`${path}: la huella no cuadra (archivo alterado)`);
  return j;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function crear(outDir: string) {
  const out = join(outDir, COLD_WALLET_FILE);
  if (existsSync(out)) throw new Error(`${out} ya existe. No piso una cartera fría: muévelo antes si de verdad quieres otra.`);
  const phrase = generatePhrase("en");
  const words = phrase.split(" ");
  const pub = publicFromPhrase(phrase);

  ttyClear();
  ttyWrite("\nCARTERA FRÍA DE VELUM — FRASE DE 24 PALABRAS\n");
  ttyWrite("Cópiala a mano, en papel, en orden. No hagas foto. No la escribas en ningún ordenador.\n\n");
  for (let i = 0; i < 24; i += 4)
    ttyWrite(words.slice(i, i + 4).map((w, j) => `${String(i + j + 1).padStart(2)}. ${w.padEnd(10)}`).join("  ") + "\n");
  ttyWrite(`\nHuella de esta cartera: ${pub.fingerprint}\n\n`);
  ttyReadLine("Cuando la tengas copiada, pulsa Intro. Se borrará la pantalla. ");
  ttyClear();

  // Comprobación: dos palabras al azar, sin eco.
  const picks = new Set<number>();
  while (picks.size < 2) picks.add(crypto.getRandomValues(new Uint32Array(1))[0]! % 24);
  for (const i of picks) {
    for (let tries = 0; ; tries++) {
      const w = ttyReadLine(`Escribe la palabra nº ${i + 1} (no se verá): `, true).trim().toLowerCase();
      if (w === words[i]) break;
      if (tries >= 2) throw new Error("La copia en papel no coincide. No se ha guardado nada: vuelve a empezar.");
      ttyWrite("No coincide. Mira tu papel y prueba otra vez.\n");
    }
  }
  words.fill("");

  writeFileSync(out, JSON.stringify(pub, null, 2) + "\n", { mode: 0o644 });
  ttyWrite(`\nListo. Guardado ${out} (solo datos públicos).\n`);
  ttyWrite(`Dirección Velum: ${pub.velum.address}\nTesorería TRON: ${pub.tron.treasury}\nTesorería EVM:  ${pub.evm.treasury}\nHuella: ${pub.fingerprint}\n`);
  ttyWrite("Guarda el papel en dos sitios seguros. Sin él, los fondos no se recuperan.\n");
}

function verificar(outDir: string) {
  const path = join(outDir, COLD_WALLET_FILE);
  const pub = readColdWalletPublic(path);
  const phrase = ttyReadLine("Escribe la frase de 24 palabras (no se verá): ", true);
  if (!validatePhrase(phrase)) throw new Error("Frase no válida");
  const again = publicFromPhrase(phrase, pub.created);
  const ok = again.fingerprint === pub.fingerprint;
  ttyWrite(ok ? `Correcto: la frase corresponde a ${path} (huella ${pub.fingerprint}).\n` : "NO coincide: esa frase es de otra cartera.\n");
  if (!ok) process.exit(1);
}

if (import.meta.main) {
  try {
    if (!hasTty()) throw new Error("Hace falta una terminal interactiva: la frase solo se muestra en pantalla.");
    const outDir = resolve(arg("--out") ?? process.cwd());
    if (process.argv.includes("--verificar")) verificar(outDir);
    else crear(outDir);
  } catch (e) {
    process.stderr.write(`Error: ${(e as Error).message}\n`);
    process.exit(1);
  }
}
