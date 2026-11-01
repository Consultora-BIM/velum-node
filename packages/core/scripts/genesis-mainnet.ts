#!/usr/bin/env bun
// Génesis de la mainnet a partir de los archivos públicos de la cartera fría y de la pasarela USDT.
// Falla (y no escribe nada) si falta alguno o si la huella de la cartera fría no cuadra.
//
//   bun packages/core/scripts/genesis-mainnet.ts [--cold cold-wallet.public.json] [--bridge bridge.public.json]
//                                                [--time 2027-01-01T00:00:00Z] [--out packages/core/genesis/mainnet.json] [--check]
//
// --check: solo comprueba que la génesis embebida está completa (lo usa la compilación de binarios).
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { canonical, hashHex, isAddress } from "../src/index";

const here = dirname(new URL(import.meta.url).pathname);
const root = resolve(here, "../../..");
const arg = (n: string, d?: string) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const fail = (m: string): never => { console.error(`Génesis de mainnet: ${m}`); process.exit(1); };

export interface MainnetGenesisFile {
  v: 1;
  chain: "velum-mainnet-1";
  genesisTime: number | null;
  reserve: { address: string; fingerprint: string } | null;
  bridge: { address: string } | null;
}

export function genesisProblem(g: MainnetGenesisFile): string | null {
  if (g.v !== 1 || g.chain !== "velum-mainnet-1") return "formato o cadena incorrectos";
  if (!g.reserve || !isAddress(g.reserve.address)) return "falta la dirección de la cartera fría (cold-wallet.public.json)";
  if (!g.bridge || !isAddress(g.bridge.address)) return "falta la clave pública de la pasarela (bridge.public.json)";
  if (g.reserve.address === g.bridge.address) return "la cartera fría y la pasarela no pueden ser la misma clave";
  if (g.genesisTime !== null && (!Number.isSafeInteger(g.genesisTime) || g.genesisTime % 3_600_000 !== 0)) return "genesisTime debe caer en una hora en punto (ms)";
  return null;
}

/** Construye la génesis desde los dos archivos públicos. Lanza con un mensaje claro si algo falta. */
export function buildGenesis(coldPath: string, bridgePath: string, time: number | null): MainnetGenesisFile {
  if (!existsSync(coldPath)) throw new Error(`falta ${coldPath}. Lo genera el propietario con apps/node/scripts/cold-wallet.ts`);
  if (!existsSync(bridgePath)) throw new Error(`falta ${bridgePath}. Se genera con apps/bridge/scripts/clave-puente.ts`);
  const cold = JSON.parse(readFileSync(coldPath, "utf8"));
  const { v: _v, fingerprint, created: _c, ...body } = cold;
  if (!fingerprint || hashHex(canonical(body)).slice(0, 16) !== fingerprint) throw new Error(`${coldPath}: la huella no cuadra`);
  const bridge = JSON.parse(readFileSync(bridgePath, "utf8"));
  const g: MainnetGenesisFile = {
    v: 1, chain: "velum-mainnet-1", genesisTime: time,
    reserve: { address: cold.velum?.address, fingerprint }, bridge: { address: bridge.address },
  };
  const p = genesisProblem(g);
  if (p) throw new Error(p);
  return g;
}

if (import.meta.main) {
  const out = resolve(arg("--out", join(here, "../genesis/mainnet.json"))!);
  if (process.argv.includes("--check")) {
    const g = JSON.parse(readFileSync(out, "utf8")) as MainnetGenesisFile;
    const p = genesisProblem(g) ?? (g.genesisTime === null ? "falta la hora de génesis (--time)" : null);
    if (p) fail(`${p}. Ejecuta: bun packages/core/scripts/genesis-mainnet.ts --time <hora en punto>`);
    console.log("Génesis de mainnet completa.");
  } else {
    const t = arg("--time");
    const time = t ? Date.parse(t) : null;
    if (t && !Number.isFinite(time)) fail("--time no es una fecha válida");
    try {
      const g = buildGenesis(resolve(arg("--cold", join(root, "cold-wallet.public.json"))!), resolve(arg("--bridge", join(root, "bridge.public.json"))!), time);
      writeFileSync(out, JSON.stringify(g, null, 2) + "\n");
      console.log(`Génesis escrita en ${out}\nReserva: ${g.reserve!.address} (huella ${g.reserve!.fingerprint})\nPasarela vUSDT: ${g.bridge!.address}`);
    } catch (e) {
      fail((e as Error).message);
    }
  }
}
