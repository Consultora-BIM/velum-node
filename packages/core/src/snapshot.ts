// Fotos de estado: exportar e importar con comprobación de la raíz.
// Sirven para arrancar un nodo sin reaplicar toda la historia y como copia antes de actualizar el binario.
import { CHAIN_ID } from "./constants";
import { type ChainState, cloneState, stateRoot } from "./state";
import { protocolAt } from "./upgrades";

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
  const root = stateRoot(snap.state);
  if (root !== snap.stateRoot) throw new Error("La raíz de estado de la foto no cuadra");
  if (header) {
    if (header.height !== snap.height || header.stateRoot !== root) throw new Error("La foto no coincide con la cabecera de la red");
    if (header.hash !== undefined && header.hash !== snap.hash) throw new Error("La foto no coincide con el hash del bloque");
  }
  return cloneState(snap.state);
}
