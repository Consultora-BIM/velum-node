// Prueba de Entrega v2 (docs/protocolo-v2.md §4): recibos anónimos.
// Solo quien abre el sobre conoce `rseed`, así que solo el destinatario puede revelar el secreto de cada trozo.
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "./bytes";

/** Secreto del recibo de un trozo: HMAC-SHA512(rseed, shardId), primeros 32 bytes (hex). */
export function receiptSecret(rseedHex: string, shardId: string): string {
  return bytesToHex(hmac(sha512, hexToBytes(rseedHex), utf8ToBytes(shardId)).slice(0, 32));
}

/** Huella pública que viaja en el trozo y queda en la cadena: SHA-512 del secreto (hex). */
export function receiptHash(secretHex: string): string {
  return bytesToHex(sha512(hexToBytes(secretHex)));
}

export const sha512Hex = (data: Uint8Array | string) =>
  bytesToHex(sha512(typeof data === "string" ? utf8ToBytes(data) : data));

/** Recibo v2: sin firma y sin dirección de quien recibe. */
export interface ReceiptV2 {
  shard: string;
  mailbox: string;
  rh: string;
  secret: string;
  carrier: string;
  courier: string;
  ts: number;
  /** Época de la foto del sorteo con la que se enrutó el trozo (lottery.ts). Sin ella no hay crédito. */
  ep?: number;
}

export function checkReceiptProof(r: ReceiptV2): boolean {
  return typeof r.secret === "string" && r.secret.length === 64 && receiptHash(r.secret) === r.rh;
}
