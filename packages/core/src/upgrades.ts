// Actualizaciones de protocolo SIN reiniciar la cadena (docs/mainnet.md §5).
// Cada versión tiene una altura de activación. Si cambia el formato del estado, trae una migración PURA
// (sin reloj ni azar) que se aplica una sola vez, en el bloque de activación, antes de sus transacciones.
// Así un nodo que reaplica desde génesis y uno que actualizó el binario en marcha llegan a la misma raíz.
import { IS_MAINNET } from "./network";
import type { ChainState } from "./state";

export interface Upgrade {
  /** Versión de protocolo desde `height` (incluida). */
  version: number;
  height: number;
  name: string;
  /** Migración del estado (muta `s`). Debe ser determinista y conservar los saldos. */
  migrate?: (s: ChainState) => void;
}

/** Mainnet: versión 1 desde génesis. Las siguientes se añaden aquí con su altura (aviso ≥ 14 días). */
export const MAINNET_UPGRADES: readonly Upgrade[] = [{ version: 1, height: 0, name: "génesis velum-mainnet-1" }];
/** Testnet v3: sin tabla (no lleva versión en la cabecera). */
export const TESTNET_UPGRADES: readonly Upgrade[] = [{ version: 3, height: 0, name: "velum-testnet-3" }];

let table: readonly Upgrade[] = IS_MAINNET ? MAINNET_UPGRADES : TESTNET_UPGRADES;

/** Cambia la tabla (tests y simulación de un binario nuevo). Ordenada por altura, sin alturas repetidas. */
export function setUpgrades(t: readonly Upgrade[]) {
  for (let i = 1; i < t.length; i++) {
    if (t[i]!.height <= t[i - 1]!.height) throw new Error("UPGRADES: alturas desordenadas o repetidas");
    if (t[i]!.version <= t[i - 1]!.version) throw new Error("UPGRADES: versiones que no crecen");
  }
  table = t;
}
export const upgrades = () => table;

/** Versión de protocolo vigente en una altura. */
export function protocolAt(height: number): number {
  let v = table[0]?.version ?? 1;
  for (const u of table) if (u.height <= height) v = u.version;
  return v;
}

/** Versión más alta que conoce este binario. */
export const latestProtocol = () => table[table.length - 1]?.version ?? 1;

/** Aplica las migraciones que se activan en `s.height` (la altura del bloque que se está construyendo). */
export function applyUpgrades(s: ChainState) {
  for (const u of table) if (u.height === s.height && u.height > 0 && u.migrate) u.migrate(s);
}
