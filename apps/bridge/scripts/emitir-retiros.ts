#!/usr/bin/env bun
// Emite (en línea) un archivo firmado por scripts/firmar-retiros.ts. No tiene claves: solo reenvía transacciones firmadas.
//
//   bun scripts/emitir-retiros.ts <firmados.json>
//
// Orden: primero el gas (y espera a que entre), después barridos y retiros. Apunta cada pago en el estado del puente.
import { readFileSync } from "node:fs";
import { loadConfig } from "../src/config";
import { ChainClient } from "../src/chains";
import { buildBridge } from "../src/main";
import type { SignedFile } from "../src/offline";

const file = process.argv[2];
if (!file) { console.error("Uso: bun scripts/emitir-retiros.ts <firmados.json>"); process.exit(1); }
const signed = JSON.parse(readFileSync(file, "utf8")) as SignedFile;
const cfg = loadConfig();
const { bridge, velum } = buildBridge(cfg);
const clients = new Map<string, ChainClient>();
const cli = (c: string) => { if (!clients.has(c)) clients.set(c, new ChainClient(cfg.chains[c as keyof typeof cfg.chains])); return clients.get(c)!; };

const sent: Record<string, string> = {};
const send = async (e: SignedFile["entries"][number]) => {
  try {
    sent[e.id] = await cli(e.chain).broadcast(e.raw);
    console.log(`  ✓ ${e.kind} ${e.chain} ${e.id} → ${sent[e.id]}`);
  } catch (err) {
    console.error(`  ✗ ${e.kind} ${e.chain} ${e.id}: ${(err as Error).message}`);
  }
};

const gas = signed.entries.filter((e) => e.kind === "gas");
for (const e of gas) await send(e);
for (const e of gas) {
  if (!sent[e.id]) continue;
  for (let i = 0; i < 120; i++) { if (await cli(e.chain).receipt(sent[e.id]!)) break; await Bun.sleep(5_000); }
}
for (const e of signed.entries.filter((e) => e.kind !== "gas")) await send(e);
bridge.markSent(signed, sent);
velum.close();
console.log(`\nEmitidas ${Object.keys(sent).length} de ${signed.entries.length}. El puente confirmará los pagos solo.`);
