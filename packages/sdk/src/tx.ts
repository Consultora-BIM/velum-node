// Construir, firmar y verificar transacciones sin estado.
// Lo que se firma = bytes UTF-8 del JSON canónico de la tx sin `sig` (claves ordenadas, sin espacios).
// Es lo que debe mostrar y firmar una cartera física (docs/ecosistema.md §4).
// v4: los importes son BigInt (velos: 1 VEL = 10^18) o texto decimal; nunca `number`.
import { amt, canonical, utf8ToBytes, sign, verify, attachPow, hashObj, makeTransfer, makeCreditsBuy, type FeeContext, type Tx } from "@velum/core";

export type UnsignedTx = Record<string, unknown> & { type: string; chain: string; from: string; nonce: number; ts: number };

/** Bytes exactos que se firman (ed25519 puro, sin prehash). */
export function signingBytes(tx: object): Uint8Array {
  const { sig: _s, ...rest } = tx as Record<string, unknown>;
  return utf8ToBytes(canonical(rest));
}

/** Id de la tx (lo que devuelve `tx.submit` y muestra el explorador). */
export const txHash = (tx: object) => hashObj(tx).slice(0, 48);

/** Firma una tx ya completa (con su sello si lo necesita). */
export function signTxBody<T extends object>(secret: string, tx: T): T & { sig: string } {
  const { sig: _s, ...rest } = tx as any;
  return { ...rest, sig: sign(secret, canonical(rest)) };
}

/** Comprueba la firma de una tx (sin estado). */
export function verifyTxSignature(tx: { from: string; sig: string }): boolean {
  const { sig, ...rest } = tx as any;
  return verify(tx.from, canonical(rest), sig);
}

/**
 * Tx sin comisión que lleva sello de trabajo (stake.*, node.commission, bridge.redeem, order.*).
 * `bits` = `powBits` del `chain.fees` del nodo.
 */
export function buildStamped<T extends UnsignedTx>(secret: string, body: T, bits: number): T & { pow: number; sig: string } {
  return signTxBody(secret, attachPow(body, bits));
}

export interface TransferInput {
  /** Unidades mínimas (velos si es VEL): BigInt o texto decimal. */
  secret: string; from: string; to: string; amount: bigint | string; nonce: number; chain: string;
  token?: string; memo?: string; ctx: FeeContext; ts?: number;
}

/** Pago VEL o token. Comisión según el oráculo del `ctx` (0 bajo el umbral, con sello). */
export function buildTransfer(i: TransferInput): Tx {
  const tx = makeTransfer(i.secret, i.from, i.to, i.amount, i.nonce, { token: i.token, memo: i.memo, ctx: i.ctx, ts: i.ts });
  if (tx.chain !== i.chain) throw new Error(`Este SDK está compilado para ${tx.chain}, no para ${i.chain}`);
  return tx;
}

const base = (chain: string, from: string, nonce: number, ts?: number) => ({ chain, from, nonce, ts: ts ?? Date.now() });

/** Delegar VEL a un nodo (staking). */
export const buildDelegate = (secret: string, chain: string, from: string, nonce: number, node: string, amount: bigint | string, bits: number, ts?: number) =>
  buildStamped(secret, { type: "stake.delegate", ...base(chain, from, nonce, ts), node, amount: amt(amount) }, bits);

/** Retirar delegación (14 días de espera). */
export const buildUndelegate = (secret: string, chain: string, from: string, nonce: number, node: string, amount: bigint | string, bits: number, ts?: number) =>
  buildStamped(secret, { type: "stake.undelegate", ...base(chain, from, nonce, ts), node, amount: amt(amount) }, bits);

/** El nodo fija su comisión sobre las recompensas de sus delegados (puntos básicos, 0–2.000). */
export const buildCommission = (nodeSecret: string, chain: string, node: string, nonce: number, bp: number, bits: number, ts?: number) =>
  buildStamped(nodeSecret, { type: "node.commission", ...base(chain, node, nonce, ts), bp }, bits);

/** Retiro de vUSDT por el puente: canjea vUSDT en Velum y pide el pago en `dst`. */
export const buildBridgeRedeem = (secret: string, chain: string, from: string, nonce: number, dst: "tron" | "polygon" | "ethereum", to: string, amount: bigint | string, bits: number, ts?: number) =>
  buildStamped(secret, { type: "bridge.redeem", ...base(chain, from, nonce, ts), dst, to, amount: amt(amount), fee: 0n }, bits);

/** Créditos de mensajería para empresas y bots (v4): `amount` velos (mín. 1 VEL) → créditos no transferibles para `to`. */
export function buildCreditsBuy(secret: string, chain: string, from: string, nonce: number, amount: bigint | string, ctx: FeeContext, to?: string, ts?: number): Tx {
  const tx = makeCreditsBuy(secret, from, nonce, { amount, to, ctx, ts });
  if (tx.chain !== chain) throw new Error(`Este SDK está compilado para ${tx.chain}, no para ${chain}`);
  return tx;
}
