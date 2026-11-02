// Transferencias con candado hash-tiempo (HTLC) para intercambios atómicos entre personas (docs/intercambio-p2p.md).
//  · htlc.lock   { to, amount, token?, hash, expiresEpoch }  bloquea el importe en `vel_htlc`.
//  · htlc.claim  { id, preimage }  antes de caducar: si sha256(preimage) = hash, el importe va a `to`.
//  · htlc.refund { id }            desde la época de caducidad: vuelve a quien lo bloqueó.
// Cualquiera puede mandar el claim o el refund (llevan sello PoW): el dinero solo puede ir a `to` o volver a `from`.
// Nada se crea ni se destruye: lo bloqueado está en el saldo de `vel_htlc` (velLedgerGap = 0).
// Se activa con la versión de protocolo HTLC_PROTOCOL (upgrades.ts: la altura la fija el responsable).
import { bytesToHex, hexToBytes, randomBytes, sha256 } from "./bytes";
import { hashObj } from "./bytes";
import type { Amount } from "./amount";

/** Cuenta interna donde esperan los importes bloqueados. */
export const HTLC_ADDRESS = "vel_htlc";
/** Versión de protocolo desde la que existen las tx htlc.* (entrada `{ version: 5, height }` en upgrades.ts). */
export const HTLC_PROTOCOL = 5;
/** Caducidad máxima: 30 días (épocas de 1 h). */
export const HTLC_MAX_EPOCHS = 24 * 30;
/** Candados abiertos a la vez por remitente (acota el estado). */
export const HTLC_MAX_OPEN = 100;
export const HTLC_HASH_RE = /^[0-9a-f]{64}$/;
export const HTLC_PREIMAGE_RE = /^[0-9a-f]{64}$/;
export const HTLC_ID_RE = /^h[0-9a-f]{48}$/;

export interface HtlcRecord {
  id: string;
  from: string;
  to: string;
  token: string;
  amount: Amount;
  hash: string;
  expiresEpoch: number;
  height: number;
}

/** Id del candado: «h» + id de la tx `htlc.lock`. Lo sabe quien bloquea antes de mandarla (para dárselo a la otra parte). */
export const htlcIdOf = (lockTx: object) => "h" + hashObj(lockTx).slice(0, 48);

/** sha256 de un secreto de 32 bytes (hex) → hex. Igual que los contratos HTLC estándar de TRON y Polygon. */
export const htlcHash = (preimageHex: string) => bytesToHex(sha256(hexToBytes(preimageHex)));

/** Secreto nuevo (32 bytes) y su huella. El secreto solo lo guarda quien empieza el intercambio. */
export function newHtlcSecret(): { preimage: string; hash: string } {
  const preimage = bytesToHex(randomBytes(32));
  return { preimage, hash: htlcHash(preimage) };
}
