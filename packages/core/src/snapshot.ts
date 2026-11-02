// Fotos de estado: exportar e importar con comprobación de la raíz.
// Sirven para arrancar un nodo sin reaplicar toda la historia y como copia antes de actualizar el binario.
// En JSON los importes van como texto decimal (v4); `importSnapshot` los devuelve a BigInt.
import { CHAIN_ID } from "./constants";
import { type ChainState, cloneState, stateRoot } from "./state";
import { protocolAt } from "./upgrades";
import { reviveState } from "./era";

export interface StateSnapshot {
  v: 1;
  chain: string;
  height: number;
  hash: string;
  stateRoot: string;
  protocol: number;
  state: ChainState;
}

export function exportSnapshot(s: ChainState): StateSnapshot {
  return { v: 1, chain: s.chain, height: s.height, hash: s.hash, stateRoot: stateRoot(s), protocol: protocolAt(s.height), state: cloneState(s) };
}

/**
 * Comprueba y devuelve el estado de una foto. Recalcula la raíz: si no cuadra, la rechaza.
 * `header` (opcional) = cabecera del bloque a esa altura obtenida de otros nodos: su hash y su raíz deben coincidir.
 */
export function importSnapshot(snap: StateSnapshot, header?: { height: number; stateRoot: string; hash?: string }): ChainState {
  if (!snap || snap.v !== 1) throw new Error("Foto con formato desconocido");
  if (snap.chain !== CHAIN_ID || snap.state?.chain !== CHAIN_ID) throw new Error(`Foto de otra cadena (${snap.chain})`);
  if (snap.state.height !== snap.height || snap.state.hash !== snap.hash) throw new Error("Foto incoherente (altura o hash)");
  // Del JSON: importes v4 en texto decimal → BigInt (o una foto v3 en µVEL → forma v4).
  const state = reviveState(snap.state);
  const root = stateRoot(state);
  if (root !== snap.stateRoot) throw new Error("La raíz de estado de la foto no cuadra");
  if (header) {
    if (header.height !== snap.height || header.stateRoot !== root) throw new Error("La foto no coincide con la cabecera de la red");
    if (header.hash !== undefined && header.hash !== snap.hash) throw new Error("La foto no coincide con el hash del bloque");
  }
  return state;
}
