// Actualizaciones de protocolo SIN reiniciar la cadena (docs/mainnet.md §5).
// Cada versión tiene una altura de activación. Si cambia el formato del estado, trae una migración PURA
// (sin reloj ni azar) que se aplica una sola vez, en el bloque de activación, antes de sus transacciones.
// Así un nodo que reaplica desde génesis y uno que actualizó el binario en marcha llegan a la misma raíz.
import { IS_MAINNET } from "./network";
import type { ChainState } from "./state";
import { migrateV4 } from "./era";

export interface Upgrade {
  /** Versión de protocolo desde `height` (incluida). */
  version: number;
  height: number;
  name: string;
  /** Migración del estado (muta `s`). Debe ser determinista y conservar los saldos. */
  migrate?: (s: ChainState) => void;
}

/**
 * Altura de activación de la economía v4 en velum-mainnet-1: primer cierre de época (múltiplo de 1.800) al menos 2 h
 * después de publicar el nodo v2.1.0. Fijada el 2026-11-02: 64.800 (época 36), hacia las 09:00 UTC del 3 de noviembre de 2026. Desde aquí: importes BigInt de 18 decimales, tope 21.000 M VEL, mitad cada 4 años,
 * sin quema y créditos de mensajería (docs/economia-v4.md). Los bloques anteriores se aplican con las reglas v3 (era.ts).
 */
export const MAINNET_V4_HEIGHT = 64_800;

/**
 * SOLO PRUEBAS de punta a punta con una génesis de prueba: `VELUM_TEST_ONLY_V4_HEIGHT=1` adelanta la v4.
 * Un nodo de la red real con esta variable se saldría solo de la cadena (sus bloques no valdrían para nadie).
 */
const testV4Height = (() => {
  const v = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.VELUM_TEST_ONLY_V4_HEIGHT;
  const n = v ? Number(v) : NaN;
  return Number.isSafeInteger(n) && n >= 1 ? n : null;
})();

/** Mainnet: versión 1 desde génesis y v4 en MAINNET_V4_HEIGHT. Las siguientes se añaden aquí con su altura. */
export const MAINNET_UPGRADES: readonly Upgrade[] = [
  { version: 1, height: 0, name: "génesis velum-mainnet-1" },
  { version: 4, height: testV4Height ?? MAINNET_V4_HEIGHT, name: "economía v4: 18 decimales, 21.000 M VEL, mitad cada 4 años, créditos", migrate: (s) => migrateV4(s) },
];
/** Testnet 4: economía v4 desde génesis (no lleva versión en la cabecera). */
export const TESTNET_UPGRADES: readonly Upgrade[] = [{ version: 4, height: 0, name: "velum-testnet-4" }];

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
