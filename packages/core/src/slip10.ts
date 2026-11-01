// SLIP-10 para ed25519 (https://github.com/satoshilabs/slips/blob/master/slip-0010.md).
// ed25519 solo admite derivación endurecida: todos los niveles llevan «'».
// Es lo que implementan Trezor y Ledger: una cartera física puede firmar para Velum sin criptografía propia.
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";

/** Número de moneda SLIP-44 de Velum. Libre en el registro a 2026-11-01 (satoshilabs/slips@e2824d0). Ver docs/ecosistema.md. */
export const VELUM_COIN_TYPE = 7420;
export const HARDENED = 0x8000_0000;

export interface Slip10Node { key: Uint8Array; chainCode: Uint8Array }

export function slip10Master(seed: Uint8Array): Slip10Node {
  const I = hmac(sha512, utf8ToBytes("ed25519 seed"), seed);
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

export function slip10Child(parent: Slip10Node, index: number): Slip10Node {
  if (index < HARDENED) index += HARDENED; // ed25519: siempre endurecido
  const ser = new Uint8Array(4);
  new DataView(ser.buffer).setUint32(0, index >>> 0);
  const I = hmac(sha512, parent.chainCode, concatBytes(new Uint8Array([0]), parent.key, ser));
  return { key: I.slice(0, 32), chainCode: I.slice(32) };
}

/** Ruta tipo `m/44'/7420'/0'/0'/0'`. Rechaza niveles sin «'». */
export function parsePath(path: string): number[] {
  if (!/^m(\/\d+')*$/.test(path)) throw new Error("Ruta SLIP-10 no válida (ed25519 exige todos los niveles endurecidos)");
  return path.split("/").slice(1).map((p) => {
    const n = Number(p.slice(0, -1));
    if (!Number.isSafeInteger(n) || n >= HARDENED) throw new Error("Índice fuera de rango");
    return n + HARDENED;
  });
}

export function slip10Derive(seed: Uint8Array, path: string): Slip10Node {
  let node = slip10Master(seed);
  for (const i of parsePath(path)) node = slip10Child(node, i);
  return node;
}

/** Ruta de la cartera Velum: `m/44'/7420'/<cuenta>'/0'/<índice>'`. La app usa cuenta 0, índice 0. */
export const walletPath = (account = 0, index = 0) => `m/44'/${VELUM_COIN_TYPE}'/${account}'/0'/${index}'`;
