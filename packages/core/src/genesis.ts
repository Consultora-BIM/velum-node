// Parámetros de génesis de la mainnet: reserva (cartera fría), autoridad de vUSDT (pasarela) y hora de génesis.
// Fuente, por orden: `setMainnetGenesis()` (tests) → `VELUM_GENESIS_FILE` (Bun/Node) → `genesis/mainnet.json` (embebido).
// En testnet no se usa.
import EMBEDDED from "../genesis/mainnet.json";
import { isAddress } from "./keys";
import { IS_MAINNET, TESTNET_GENESIS_TIME } from "./network";

export interface MainnetGenesis {
  v: 1;
  chain: "velum-mainnet-1";
  /** Hora de génesis (ms, hora en punto). null = aún no fijada (se usa la de referencia, solo para pruebas). */
  genesisTime: number | null;
  reserve: { address: string; fingerprint: string } | null;
  bridge: { address: string } | null;
}


let override: MainnetGenesis | null = null;
let fileCache: { file: string; g: MainnetGenesis } | null = null;

function fromEnvFile(): MainnetGenesis | null {
  const g = globalThis as any;
  const file: string | undefined = g.process?.env?.VELUM_GENESIS_FILE;
  if (!file) return null;
  const hit = fileCache;
  if (hit && hit.file === file) return hit.g;
  const fs = g.process?.getBuiltinModule?.("node:fs");
  if (!fs) return null;
  const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as MainnetGenesis;
  fileCache = { file, g: parsed };
  return parsed;
}

/** Génesis vigente (sin validar). */
export function rawMainnetGenesis(): MainnetGenesis {
  return override ?? fromEnvFile() ?? (EMBEDDED as MainnetGenesis);
}

/** Génesis completa o error claro. La mainnet no arranca con la reserva en el aire. */
export function mainnetGenesis(): MainnetGenesis & { reserve: { address: string; fingerprint: string }; bridge: { address: string } } {
  const g = rawMainnetGenesis();
  if (!g.reserve || !isAddress(g.reserve.address)) throw new Error("Génesis de mainnet incompleta: falta la cartera fría (bun packages/core/scripts/genesis-mainnet.ts)");
  if (!g.bridge || !isAddress(g.bridge.address)) throw new Error("Génesis de mainnet incompleta: falta la clave de la pasarela vUSDT");
  return g as any;
}

/** Fija la génesis en memoria (tests y herramientas). Llamar antes de crear estados. */
export function setMainnetGenesis(g: MainnetGenesis | null) {
  override = g;
}

/** Hora de génesis de la red en curso (ms). */
export function genesisTime(): number {
  return IS_MAINNET ? rawMainnetGenesis().genesisTime ?? TESTNET_GENESIS_TIME : TESTNET_GENESIS_TIME;
}
