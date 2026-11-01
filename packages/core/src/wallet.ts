// Cartera: constructores de transacciones (app, cliente, nodo) y lecturas sobre el estado (explorador, RPC).
// Los constructores usan Date.now() solo para el campo informativo `ts` (la cadena usa la hora del bloque).
// v3: calculan la comisión con el oráculo (0 bajo 1.000 €) y, si es 0, añaden el sello de trabajo (pow.ts).
// El contexto (`FeeContext`) sale del estado (`feeContext(s)`) o de la RPC `chain.fees` del nodo.
import {
  CHAIN_ID, HALVING_EPOCHS, MAX_SUPPLY, NAME_POW_EXTRA_BITS, POOL_ADDRESS, POW_MIN_BITS, RESERVE_ADDRESS, TOKEN_CREATE_FEE, TIERS,
  VEL, pillarMonths, MONTH_EPOCHS, type NodeKind, type Region,
} from "./constants";
import {
  type DeviceAttestTx, type NameRegisterTx, type NameReleaseTx, type NameRenewTx, type NodeBondTx, type NodeUnbondTx,
  type OrderCancelTx, type OrderPlaceTx, type PoolFundTx, type RegisterTx, type TokenCreateTx, type TokenMintTx, type TransferTx,
  type WorkClaimTx, type WorkProveTx, pairOf, signTx,
} from "./tx";
import { type ChainState, balanceOf, bondFactorBp, emissionFor, epochOf, curEpoch, nameInfo, nameOfAddress, streakOf, tierFor, transferFee } from "./state";
import { bookDepth, lastPrice, marketFee, ordersOf, volume24h } from "./dex";
import { decimalsOf } from "./tokens";
import { attachPow } from "./pow";
import { valueOf, type PriceView } from "./oracle";
import type { WorkLeaf } from "./claims";

/** Lo que un constructor necesita saber de la cadena: precios del oráculo y dificultad del sello. */
export interface FeeContext {
  oracle: PriceView | null;
  /** Bits del sello a resolver (la dificultad actual). */
  powBits: number;
}

/** Contexto de comisiones a partir del estado (o de la RPC `chain.fees`). */
export const feeContext = (s: Pick<ChainState, "oracle" | "pow">): FeeContext => ({
  oracle: { eur: s.oracle.eur, usd: s.oracle.usd, usdt: s.oracle.usdt },
  powBits: s.pow.bits,
});

type CtxLike = FeeContext | Pick<ChainState, "oracle" | "pow"> | null | undefined;
const ctxOf = (c: CtxLike): FeeContext => (!c ? { oracle: null, powBits: POW_MIN_BITS } : "powBits" in c ? c : feeContext(c));

const base = (from: string, nonce: number, ts?: number) => ({ chain: CHAIN_ID, from, nonce, ts: ts ?? Date.now() });

/** Firma la tx; antes, si hace falta, le pone el sello de `bits`. */
function finish<T extends object>(secret: string, body: T, bits: number) {
  return signTx(secret, (bits > 0 ? attachPow(body, bits) : body) as any) as unknown as T & { sig: string };
}

/**
 * Pago firmado. Compatible con la firma v1 (`memo` como 6º argumento) y con opciones `{ token, memo, ctx }`.
 * La comisión sale del oráculo de `ctx` (0 si vale menos de 1.000 € o no hay precio); si es 0 lleva sello.
 */
export function makeTransfer(
  secret: string, from: string, to: string, amount: number, nonce: number,
  opts?: string | { token?: string; memo?: string; ts?: number; ctx?: CtxLike; fee?: number },
): TransferTx {
  const o = typeof opts === "string" ? { memo: opts } : opts ?? {};
  const token = o.token && o.token !== VEL ? o.token : undefined;
  const ctx = ctxOf("ctx" in o ? o.ctx : undefined);
  const fee = "fee" in o && o.fee !== undefined ? o.fee : transferFee(ctx.oracle, token ?? VEL, Math.floor(amount));
  const body = {
    type: "transfer" as const, ...base(from, nonce, o.ts), to, amount: Math.floor(amount), fee,
    ...(token ? { token } : {}), ...(o.memo ? { memo: o.memo } : {}),
  };
  return finish(secret, body, fee === 0 ? ctx.powBits : 0);
}

export function makeRegister(
  walletSecret: string, from: string, nonce: number,
  o: { name?: string; payout?: string; endpoint?: string; version: string; kind?: NodeKind; region?: Region; ts?: number },
): RegisterTx {
  // Un nodo es su dirección: el nombre es opcional y solo decorativo (no se manda si va vacío).
  return signTx(walletSecret, {
    type: "register", ...base(from, nonce, o.ts), ...(o.name ? { name: o.name } : {}), payout: o.payout ?? from, version: o.version,
    ...(o.endpoint ? { endpoint: o.endpoint } : {}), ...(o.kind ? { kind: o.kind } : {}), ...(o.region ? { region: o.region } : {}),
  });
}

export function makeTokenCreate(
  walletSecret: string, from: string, nonce: number,
  o: { symbol: string; name: string; decimals: number; maxSupply: number; initial: number; mintable: boolean; ts?: number },
): TokenCreateTx {
  return signTx(walletSecret, {
    type: "token.create", ...base(from, nonce, o.ts), symbol: o.symbol, name: o.name, decimals: o.decimals,
    maxSupply: o.maxSupply, initial: o.initial, mintable: o.mintable, fee: TOKEN_CREATE_FEE,
  });
}

export function makeTokenMint(walletSecret: string, from: string, nonce: number, symbol: string, to: string, amount: number, ts?: number, ctx?: CtxLike): TokenMintTx {
  return finish(walletSecret, { type: "token.mint" as const, ...base(from, nonce, ts), symbol, to, amount, fee: 0 }, ctxOf(ctx).powBits);
}

export function makePoolFund(walletSecret: string, from: string, nonce: number, token: string, amount: number, epochs: number, ts?: number, ctx?: CtxLike): PoolFundTx {
  return finish(walletSecret, { type: "pool.fund" as const, ...base(from, nonce, ts), token, amount, epochs, fee: 0 }, ctxOf(ctx).powBits);
}

/** Orden en `VEL/<token>`. price: unidades mínimas del token por 1 VEL. amount: µVEL. Lleva sello. */
export function makeOrder(
  walletSecret: string, from: string, nonce: number,
  o: { token?: string; pair?: string; side: "buy" | "sell"; price: number; amount: number; ttl?: number; ts?: number; ctx?: CtxLike },
): OrderPlaceTx {
  const pair = o.pair ?? pairOf(o.token ?? "");
  return finish(walletSecret, {
    type: "order.place" as const, ...base(from, nonce, o.ts), pair, side: o.side, price: o.price, amount: o.amount,
    ...(o.ttl ? { ttl: o.ttl } : {}),
  }, ctxOf(o.ctx).powBits);
}

export function makeCancel(walletSecret: string, from: string, nonce: number, id: string, ts?: number, ctx?: CtxLike): OrderCancelTx {
  return finish(walletSecret, { type: "order.cancel" as const, ...base(from, nonce, ts), id }, ctxOf(ctx).powBits);
}

/** device = sha256(clave pública del dispositivo) en hex; es el clientDataHash que se pasó a App Attest. */
export function makeAttest(
  walletSecret: string, from: string, nonce: number,
  o: { device: string; keyId: string; attestation: string; ts?: number },
): DeviceAttestTx {
  return signTx(walletSecret, { type: "device.attest", ...base(from, nonce, o.ts), device: o.device, keyId: o.keyId, attestation: o.attestation });
}

// ---------- Nodos: fianza y trabajo (v3 §2 y §4) ----------
export const makeBond = (nodeSecret: string, node: string, nonce: number, amount: number, ts?: number): NodeBondTx =>
  signTx(nodeSecret, { type: "node.bond", ...base(node, nonce, ts), amount });

export const makeUnbond = (nodeSecret: string, node: string, nonce: number, amount: number, ts?: number): NodeUnbondTx =>
  signTx(nodeSecret, { type: "node.unbond", ...base(node, nonce, ts), amount });

/** Reclamación de la época `epoch` (enviar durante la época siguiente). */
export const makeWorkClaim = (nodeSecret: string, node: string, nonce: number, o: { epoch: number; count: number; root: string; ts?: number }): WorkClaimTx =>
  signTx(nodeSecret, { type: "work.claim", ...base(node, nonce, o.ts), epoch: o.epoch, count: o.count, root: o.root });

/** Prueba: hojas y caminos en el orden de `claimSamples` (state.ts › samplesFor). */
export const makeWorkProve = (nodeSecret: string, node: string, nonce: number, o: { epoch: number; leaves: WorkLeaf[]; paths: string[][]; ts?: number }): WorkProveTx =>
  signTx(nodeSecret, { type: "work.prove", ...base(node, nonce, o.ts), epoch: o.epoch, leaves: o.leaves, paths: o.paths });

// ---------- Alias (v3 §7) ----------
/** Registra un alias con la tarjeta (base58, `encodeCard`). Sello grande: ~1 M hashes. */
export function makeNameRegister(walletSecret: string, from: string, nonce: number, o: { name: string; card: string; ts?: number; ctx?: CtxLike }): NameRegisterTx {
  return finish(walletSecret, { type: "name.register" as const, ...base(from, nonce, o.ts), name: o.name, card: o.card }, ctxOf(o.ctx).powBits + NAME_POW_EXTRA_BITS);
}

export function makeNameRenew(walletSecret: string, from: string, nonce: number, o: { name: string; card?: string; ts?: number; ctx?: CtxLike }): NameRenewTx {
  return finish(walletSecret, { type: "name.renew" as const, ...base(from, nonce, o.ts), name: o.name, ...(o.card ? { card: o.card } : {}) }, ctxOf(o.ctx).powBits + NAME_POW_EXTRA_BITS);
}

export function makeNameRelease(walletSecret: string, from: string, nonce: number, o: { name: string; ts?: number; ctx?: CtxLike }): NameReleaseTx {
  return finish(walletSecret, { type: "name.release" as const, ...base(from, nonce, o.ts), name: o.name }, ctxOf(o.ctx).powBits);
}

// ---------- Presupuesto de un pago (app y web) ----------
export interface Quote {
  /** Comisión exacta en µVEL (normalmente 0). */
  fee: number;
  /** Lo que recibe el destinatario (unidades del token). La comisión va aparte, en VEL. */
  receive: number;
  /** Lo que sale de la cartera en VEL (importe si es VEL + comisión). */
  totalVel: number;
  /** Valor del importe (µunidades) o null si no hay precio. */
  vel: number | null;
  eur: number | null;
  usd: number | null;
  usdt: number | null;
  /** Bits del sello que hará falta (0 si paga comisión). */
  powBits: number;
}

/** `quote(importe, token, contexto)` → comisión, lo que recibe y su valor en EUR/USD/USDT. */
export function quote(amount: number, token: string = VEL, ctx?: CtxLike): Quote {
  const c = ctxOf(ctx);
  const fee = transferFee(c.oracle, token, amount);
  const v = valueOf(c.oracle, token, amount);
  return { fee, receive: amount, totalVel: (token === VEL ? amount : 0) + fee, ...v, powBits: fee === 0 ? c.powBits : 0 };
}

// ---------- Formato ----------
/** Unidades mínimas → texto "1.234,5 VEL" (sin decimales flotantes). */
export function formatAmount(token: string, units: number, decimals = 6, maxDecimals = decimals, withSymbol = true): string {
  const neg = units < 0;
  const big = BigInt(Math.abs(Math.trunc(units)));
  const div = 10n ** BigInt(decimals);
  const int = (big / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  let frac = decimals > 0 ? (big % div).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "") : "";
  const txt = (neg ? "-" : "") + int + (frac ? "," + frac : "");
  return withSymbol ? `${txt} ${token}` : txt;
}

/** "12,5" o "12.5" → unidades mínimas (entero). null si no es un número válido. */
export function parseAmount(text: string, decimals = 6): number | null {
  const t = text.trim().replace(/\s/g, "");
  const m = t.match(/^(\d+)(?:[.,](\d+))?$/);
  if (!m) return null;
  const frac = (m[2] ?? "").slice(0, decimals).padEnd(decimals, "0");
  const v = BigInt(m[1]!) * 10n ** BigInt(decimals) + BigInt(frac || "0");
  return v > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(v);
}

// ---------- Lecturas ----------
/** Todos los saldos de una dirección (incluye VEL aunque sea 0). */
export function balancesOf(s: ChainState, addr: string): Record<string, number> {
  return { [VEL]: 0, ...(s.balances[addr] ?? {}) };
}

export function tokenInfo(s: ChainState, symbol: string) {
  if (symbol === VEL) {
    const sup = supplyInfo(s);
    return { symbol: VEL, name: "Velum", decimals: 6, maxSupply: MAX_SUPPLY, supply: sup.circulating, issuer: null, mintable: false, native: true };
  }
  const t = s.tokens[symbol];
  return t ? { ...t, native: false } : null;
}

export const tokenList = (s: ChainState) => Object.keys(s.tokens).sort().map((k) => s.tokens[k]!);

/** Libro de un par con último precio y volumen 24 h. `pair` = "VEL/tEUR" o solo "tEUR". */
export function bookOf(s: ChainState, pair: string, levels = 20) {
  const p = pair.includes("/") ? pair : pairOf(pair);
  return { ...bookDepth(s, p, levels), last: lastPrice(s, p), volume24h: volume24h(s, p) };
}

export const tradesOf = (s: ChainState, pair?: string, limit = 50) =>
  s.dex.trades.filter((t) => !pair || t.pair === pair).slice(-limit).reverse();

export { ordersOf, marketFee, decimalsOf, nameInfo, nameOfAddress };

/** Oferta: acuñado, en circulación (= acuñado: en v3 no se quema), Reserva, emisión actual y próxima mitad. */
export function supplyInfo(s: ChainState) {
  const epoch = epochOf(s.height);
  const halvings = Math.floor(epoch / HALVING_EPOCHS);
  return {
    max: MAX_SUPPLY,
    minted: s.supply.minted,
    burned: s.supply.burned,
    circulating: s.supply.minted - s.supply.burned,
    remainingToMint: MAX_SUPPLY - s.supply.minted,
    feesCollected: s.supply.feesCollected,
    pool: s.epoch.pool,
    workPots: Object.values(s.workPots).reduce((a, x) => a + x, 0),
    reserve: balanceOf(s, RESERVE_ADDRESS),
    reserveAddress: RESERVE_ADDRESS,
    reserveIn: s.supply.reserveIn,
    reserveOut: s.supply.reserveOut,
    epoch,
    emission: emissionFor(epoch),
    halvings,
    nextHalvingEpoch: (halvings + 1) * HALVING_EPOCHS,
    poolAddress: POOL_ADDRESS,
  };
}

/** Oráculo: precios (µunidad por VEL), de dónde salen, TWAP y volumen de la ventana. */
export function oracleInfo(s: ChainState) {
  const o = s.oracle;
  return { epoch: o.epoch, eur: o.eur, usd: o.usd, usdt: o.usdt, src: o.src, twap: o.twap, volume: o.volume, fx: o.fx };
}

/** Nivel de un nodo con su racha (para la app del nodo y el explorador). */
export function tierInfo(s: ChainState, address: string) {
  const n = s.nodes[address];
  if (!n) return null;
  const ep = curEpoch({ height: s.height + 1 });
  const st = streakOf(n, ep);
  const t = tierFor(n, ep);
  return {
    tier: t.id, multBp: t.multBp, streakEpochs: st.epochs, streakMonths: st.months,
    presencePct: st.epochs ? Math.floor((st.present * 100) / st.epochs) : 0,
    pillarMonths: pillarMonths(Math.floor(ep / MONTH_EPOCHS)), bond: n.bond, bondFactorBp: bondFactorBp(n.bond),
    unbonding: n.unbonding, tiers: TIERS,
  };
}

/** Reclamaciones de una época (explorador). */
export const claimsOf = (s: ChainState, epoch: number) => Object.values(s.claims[String(epoch)] ?? {}).sort((a, b) => (a.node < b.node ? -1 : 1));

/** Dificultad: entregas necesarias para ganar 1 VEL (decimal, para mostrar) e historial reciente. */
export function difficulty(s: ChainState) {
  const toNum = (d: number | null) => (d === null ? null : d / 1000);
  return {
    epoch: s.stats.difficultyEpoch,
    value: toNum(s.stats.difficulty),
    history: s.stats.history.map((h) => ({ ...h, value: toNum(h.difficulty) })),
  };
}

export const devicesOf = (s: ChainState, owner: string) => Object.values(s.devices).filter((d) => d.owner === owner);
