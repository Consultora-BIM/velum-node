// Eras del protocolo en la mainnet: v3 (µVEL, `number`) hasta la altura de la v4 y v4 (velos, BigInt) desde ella.
//
// Cómo se mantiene la historia sin reiniciar:
//  · Los bloques anteriores a la v4 se aplican con el código v3 CONGELADO (./v3), byte a byte: mismas raíces de estado.
//  · En memoria, el estado SIEMPRE tiene forma v4 (BigInt, 18 decimales). Un estado anterior a la v4 es solo la vista
//    v4 de su estado v3: `toV3` lo devuelve exacto (÷10^12) para aplicar el siguiente bloque v3, y `fromV3` lo vuelve a subir.
//  · En la altura de la v4 la vista pasa a ser el estado de consenso (migración: importes VEL ×10^12, se quita `burned`,
//    aparecen los créditos de mensajería). La raíz se calcula ya con la codificación v4 (importes en texto decimal).
// Todo es puro (sin reloj ni azar): un nodo que reaplica desde génesis y uno que actualizó en marcha llegan a lo mismo.
import { amountOrNull, toAmount } from "./amount";
import { VEL } from "./constants";
import { protocolAt } from "./upgrades";
import type { AttestationMode } from "./constants";
import type { BuildInput, ChainState } from "./state";
import { type Block, type Tx, checkTx } from "./tx";
import * as L from "./v3";

/** Versión de protocolo de la economía v4. */
export const V4 = 4;
/** 6 → 18 decimales: cada µVEL son 10^12 velos. */
export const V3_TO_V4 = 10n ** 12n;

export const isV4At = (height: number) => protocolAt(height) >= V4;

type Conv = { vel: (x: any) => any; tok: (x: any) => any };

const UP: Conv = { vel: (x) => BigInt(x) * V3_TO_V4, tok: (x) => BigInt(x) };
const DOWN: Conv = {
  vel: (x: bigint) => {
    if (x % V3_TO_V4 !== 0n) throw new Error("Estado anterior a la v4 con fracciones de µVEL: imposible");
    return Number(x / V3_TO_V4);
  },
  tok: (x: bigint) => Number(x),
};
/** JSON v4 (texto decimal) → BigInt, sin escalar. */
const REVIVE: Conv = { vel: (x) => toAmount(x), tok: (x) => toAmount(x) };

function clone(x: any): any {
  if (x === null || typeof x !== "object") return x;
  if (Array.isArray(x)) return x.map(clone);
  const o: any = {};
  for (const k of Object.keys(x)) if (x[k] !== undefined) o[k] = clone(x[k]);
  return o;
}

const each = (o: any, f: (v: any, k: string) => void) => { if (o) for (const k of Object.keys(o)) f(o[k], k); };

/** Copia del estado con cada importe convertido (VEL con `c.vel`, otros tokens con `c.tok`). El resto, igual. */
function mapAmounts(src: any, c: Conv): any {
  const s = clone(src);
  const tk = (token: string) => (token === VEL ? c.vel : c.tok);
  each(s.accounts, (a) => { a.balance = c.vel(a.balance); });
  each(s.balances, (m) => each(m, (v, t) => { m[t] = tk(t)(v); }));
  each(s.tokens, (t) => { t.maxSupply = c.tok(t.maxSupply); t.supply = c.tok(t.supply); });
  each(s.nodes, (n) => {
    n.earned = c.vel(n.earned);
    n.bond = c.vel(n.bond);
    if (n.delegated !== undefined) n.delegated = c.vel(n.delegated);
    for (const u of n.unbonding ?? []) u.amount = c.vel(u.amount);
  });
  each(s.pools, (p) => { const f = tk(p.token); p.total = f(p.total); p.remaining = f(p.remaining); p.paid = f(p.paid); });
  if (s.dex) {
    each(s.dex.orders, (o) => { o.amount = c.vel(o.amount); o.remaining = c.vel(o.remaining); o.escrow = o.side === "sell" ? c.vel(o.escrow) : c.tok(o.escrow); });
    for (const t of s.dex.trades ?? []) { t.amount = c.vel(t.amount); t.quote = c.tok(t.quote); }
    each(s.dex.pairs, (p) => { for (const h of p.hours ?? []) { h.vel = c.vel(h.vel); h.quote = c.tok(h.quote); } });
  }
  if (s.supply) for (const k of ["minted", "feesCollected", "reserveIn", "reserveOut", "creditsPaid"]) if (s.supply[k] !== undefined) s.supply[k] = c.vel(s.supply[k]);
  if (s.epoch) s.epoch.pool = c.vel(s.epoch.pool);
  each(s.workPots, (v, k) => { s.workPots[k] = c.vel(v); });
  for (const h of s.stats?.history ?? []) h.emission = c.vel(h.emission);
  if (s.oracle) {
    each(s.oracle.volume, (v, k) => { s.oracle.volume[k] = c.vel(v); });
    each(s.oracle.acc, (b) => { b.vol = c.vel(b.vol); });
    each(s.oracle.window, (list) => { for (const b of list) b.vol = c.vel(b.vol); });
  }
  if (s.bridge) { s.bridge.minted = c.tok(s.bridge.minted); s.bridge.redeemed = c.tok(s.bridge.redeemed); }
  if (s.stake) {
    each(s.stake.del, (m) => each(m, (d) => { d.amount = c.vel(d.amount); d.earned = c.vel(d.earned); }));
    each(s.stake.unbonding, (list) => { for (const u of list) u.amount = c.vel(u.amount); });
  }
  return s;
}

/** Estado v3 (µVEL) → estado v4 (velos). Es la migración de la v4: ×10^12 en VEL, sin `burned`, con créditos. */
export function fromV3(s3: L.ChainState): ChainState {
  if (s3.supply.burned !== 0) throw new Error("Estado v3 con VEL quemado: no debería existir");
  const s = mapAmounts(s3, UP);
  delete s.supply.burned;
  s.supply.creditsPaid = 0n;
  s.supply.credits = 0;
  s.msgCredits = {};
  return s;
}

/** Estado v4 de una altura anterior a la v4 → su estado v3 exacto. */
export function toV3(s4: ChainState): L.ChainState {
  if (s4.supply.creditsPaid !== 0n || s4.supply.credits !== 0 || Object.keys(s4.msgCredits ?? {}).length) throw new Error("Créditos antes de la v4: imposible");
  const s = mapAmounts(s4, DOWN);
  delete s.supply.creditsPaid;
  delete s.supply.credits;
  delete s.msgCredits;
  s.supply.burned = 0;
  return s;
}

/**
 * Lee un estado de JSON (disco, red, RPC). Si es de antes de la v4 y viene en forma v3 (números), lo sube a v4;
 * si viene en forma v4 (importes en texto decimal), los pasa a BigInt.
 */
export function reviveState(json: any): ChainState {
  if (!json || typeof json !== "object") throw new Error("Estado no válido");
  if (json.supply && "burned" in json.supply && typeof json.supply.minted === "number") return fromV3(json);
  return mapAmounts(json, REVIVE);
}

/** Bloque leído de JSON: recompensas a BigInt. Las tx se quedan como llegaron (la máquina de estados las normaliza). */
export function reviveBlock<B extends Block>(b: B): B {
  if (!b || typeof b !== "object" || !isV4At(b.header?.height ?? 0)) return b;
  const out: any = { ...b };
  if (Array.isArray(b.rewards) && b.rewards.some((r: any) => typeof r.amount === "number")) {
    throw new Error(`Bloque ${b.header.height} con importes v3 en una altura v4: la altura de la v4 de este binario no coincide con la red`);
  }
  if (Array.isArray(b.rewards)) out.rewards = b.rewards.map((r: any) => ({ ...r, amount: toAmount(r.amount), ...(r.delegators !== undefined ? { delegators: toAmount(r.delegators) } : {}) }));
  if (Array.isArray(b.tokenRewards)) out.tokenRewards = b.tokenRewards.map((r: any) => ({ ...r, amount: toAmount(r.amount) }));
  return out;
}

/**
 * Vista v4 de una tx anterior a la v4 (historial, explorador): importes `number` en µVEL → texto decimal en velos.
 * Las tx v4 se devuelven tal cual. Solo para mostrar: la firma de la tx original no vale para la vista.
 */
export function txView<T extends Tx>(tx: T): T {
  const anyTx: any = tx;
  const vel = (token?: string) => !token || token === VEL;
  const out: any = { ...tx };
  const scale = (f: string, isVel: boolean) => {
    const v = anyTx[f];
    if (typeof v === "number") out[f] = (isVel ? BigInt(v) * V3_TO_V4 : BigInt(v)).toString();
    else if (typeof v === "bigint") out[f] = v.toString();
  };
  switch (tx.type) {
    case "transfer": scale("amount", vel(anyTx.token)); scale("fee", true); break;
    case "token.create": scale("maxSupply", false); scale("initial", false); scale("fee", true); break;
    case "token.mint": scale("amount", false); scale("fee", true); break;
    case "pool.fund": scale("amount", vel(anyTx.token)); scale("fee", true); break;
    case "order.place": case "node.bond": case "node.unbond": case "stake.delegate": case "stake.undelegate": case "credits.buy":
      scale("amount", true); scale("fee", true); break;
    case "bridge.mint": case "bridge.redeem": scale("amount", false); scale("fee", true); break;
  }
  return out;
}

/** Recompensa anterior a la v4 (µVEL) → texto decimal en velos (para mostrar). */
export const rewardView = (r: { amount: unknown; delegators?: unknown }, height: number) => {
  const up = (x: unknown) => (typeof x === "number" ? (isV4At(height) ? BigInt(x) : BigInt(x) * V3_TO_V4) : amountOrNull(x) ?? 0n);
  return { ...r, amount: up(r.amount), ...(r.delegators !== undefined ? { delegators: up(r.delegators) } : {}) };
};

/** Comprobación sin estado de una tx que iría en el bloque `height` (formato v3 antes de la v4, v4 después). */
export const checkTxAt = (tx: Tx, height: number): string | null => (isV4At(height) ? checkTx(tx) : L.checkTx(tx as any));

// ---------- Aplicación con reglas v3 (alturas anteriores a la v4) ----------
export const legacyGenesis = (): ChainState => fromV3(L.genesisState());
export const legacyStateRoot = (s: ChainState): string => L.stateRoot(toV3(s));

export function legacyApplyTx(s: ChainState, tx: Tx, mode: AttestationMode): string | null {
  const s3 = toV3(s);
  const e = L.applyTx(s3, tx as any, mode);
  if (e) return e;
  const up = fromV3(s3);
  for (const k of Object.keys(s)) delete (s as any)[k];
  Object.assign(s, up);
  return null;
}

export function legacyBuildBlock(s: ChainState, input: BuildInput): { block: Omit<Block, "sig">; state: ChainState } {
  const r = L.buildBlock(toV3(s), input as L.BuildInput);
  return { block: r.block as any, state: fromV3(r.state) };
}

export function legacyApplyBlock(s: ChainState, b: Block): { state: ChainState } | { error: string } {
  const r = L.applyBlock(toV3(s), b as any);
  return "error" in r ? r : { state: fromV3(r.state) };
}

/**
 * Migración de la v4 sobre el estado en memoria (que ya tiene forma v4: ver cabecera). Deja los campos nuevos en su
 * valor inicial. Idempotente y determinista. El ×10^12 ya lo hizo `fromV3` al aplicar el último bloque v3.
 */
export function migrateV4(s: ChainState) {
  const sup: any = s.supply;
  if ("burned" in sup) delete sup.burned;
  sup.creditsPaid ??= 0n;
  sup.credits ??= 0;
  s.msgCredits ??= {};
}
