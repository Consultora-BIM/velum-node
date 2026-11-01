// Génesis de mainnet para tests: cartera fría y pasarela de PRUEBA en una carpeta temporal.
// La frase se genera en memoria y se descarta: nunca se muestra ni se guarda.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as V from "../src";
import { publicFromPhrase, type ColdWalletPublic } from "../../../apps/node/scripts/cold-wallet";
import { buildGenesis } from "../scripts/genesis-mainnet";

export const testBridgeKey = V.keyPairFromText("pasarela-de-prueba");
let made: { dir: string; cold: ColdWalletPublic; file: string } | null = null;

/** Crea (una vez) la génesis de prueba y la activa. Devuelve la carpeta y el JSON público de la cartera fría. */
export function useTestGenesis() {
  if (!made) {
    const dir = mkdtempSync(join(tmpdir(), "velum-mainnet-"));
    const cold = publicFromPhrase(V.generatePhrase());
    writeFileSync(join(dir, "cold-wallet.public.json"), JSON.stringify(cold));
    writeFileSync(join(dir, "bridge.public.json"), JSON.stringify({ address: testBridgeKey.address }));
    const g = buildGenesis(join(dir, "cold-wallet.public.json"), join(dir, "bridge.public.json"), Date.UTC(2026, 9, 1));
    const file = join(dir, "genesis.json");
    writeFileSync(file, JSON.stringify(g));
    made = { dir, cold, file };
  }
  if (V.IS_MAINNET) V.setMainnetGenesis(JSON.parse(require("node:fs").readFileSync(made.file, "utf8")));
  return made;
}
