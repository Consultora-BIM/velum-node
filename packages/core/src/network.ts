// Red para la que se compila el núcleo: `mainnet` (por defecto) o `testnet`.
//  · Compilación (binario del nodo, app, web): `--define __VELUM_NETWORK__='"testnet"'` (Bun/Vite/Metro). Manda sobre el entorno.
//  · En marcha (Bun/Node): `VELUM_NETWORK=testnet|mainnet`.
// Cambiar de red cambia el consenso: CHAIN_ID, duración de época, génesis, tokens y pares del oráculo.
export type NetworkName = "mainnet" | "testnet";

declare const __VELUM_NETWORK__: string | undefined;

function pick(): NetworkName {
  let v: string | undefined;
  try { v = typeof __VELUM_NETWORK__ !== "undefined" ? __VELUM_NETWORK__ : undefined; } catch { v = undefined; }
  if (v === undefined) v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VELUM_NETWORK;
  if (v === undefined || v === "" || v === "mainnet") return "mainnet";
  if (v === "testnet") return "testnet";
  throw new Error(`VELUM_NETWORK no válida: ${v} (usa mainnet o testnet)`);
}

export const NETWORK: NetworkName = pick();
export const IS_MAINNET = NETWORK === "mainnet";

/** Hora de génesis de la testnet (1 nov 2026). */
export const TESTNET_GENESIS_TIME = Date.UTC(2026, 10, 1);
