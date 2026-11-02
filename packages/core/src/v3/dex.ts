// ⚠ CÓDIGO CONGELADO DEL PROTOCOLO v3 (velum-mainnet-1, alturas < H de la v4). NO EDITAR.
// Solo sirve para reaplicar la historia anterior a la actualización v4 byte a byte (mismas raíces de estado).
// Importes en µVEL (number). La conversión a v4 (BigInt, 18 decimales) está en ../era.ts.
// Mercado en la cadena (protocolo-v2 §9): libro de órdenes determinista por par `VEL/<token>`.
// Precio-tiempo; se ejecuta al precio del que ya estaba en el libro (maker); restos quedan en el libro.
// price = unidades mínimas del token por 1 VEL; amount = µVEL. Todo entero (productos con BigInt).
// Los fondos de cada orden quedan bloqueados en ESCROW_ADDRESS hasta que se ejecutan, se cancelan o caducan.
// v3: la comisión del taker sigue la regla de los pagos (0 bajo 1.000 €, 1 pb desde 1.000 €) y las operaciones
// alimentan el oráculo (oracle.ts).
import { ESCROW_ADDRESS, MAX_OPEN_ORDERS, ORDER_TTL_DEFAULT, TRADE_LOG, UNIT, VEL } from "./constants";
import { type OrderCancelTx, type OrderPlaceTx, tokenOfPair } from "./tx";
import { type ChainState, balanceOf, chargeFee, credit, curEpoch, debit, epochOf, feeForVel, mulDiv, nextId } from "./state";
import { oracleTrade, type PriceView } from "./oracle";

export type Side = "buy" | "sell";

export interface Order {
  id: string;
  /** Orden de llegada (prioridad temporal). */
  seq: number;
  owner: string;
  pair: string;
  side: Side;
  price: number;
  amount: number; // µVEL original
  remaining: number; // µVEL por ejecutar
  /** Bloqueado: µVEL (venta) o unidades del token (compra). */
  escrow: number;
  height: number;
  /** Época en la que caduca (se devuelve al cerrar esa época). */
  expires: number;
}

export interface Trade {
  pair: string;
  price: number;
  amount: number; // µVEL
  quote: number; // unidades del token
  /** Lado de quien llegó (taker). */
  side: Side;
  maker: string;
  taker: string;
  makerOrder: string;
  height: number;
  ts: number;
}

export interface PairStats {
  last: number; // último precio
  /** Volumen por hora (para 24 h): h = floor(ts / 1 h). */
  hours: { h: number; vel: number; quote: number; trades: number }[];
}

export interface DexState {
  orders: Record<string, Order>;
  /** Ids ordenados: bids precio desc + llegada; asks precio asc + llegada. */
  books: Record<string, { bids: string[]; asks: string[] }>;
  trades: Trade[];
  pairs: Record<string, PairStats>;
  /** Órdenes abiertas por cuenta. */
  open: Record<string, number>;
}

export const emptyDex = (): DexState => ({ orders: {}, books: {}, trades: [], pairs: {}, open: {} });

/** Coste en token de `amount` µVEL a `price` (suelo: el redondeo nunca deja un depósito en negativo). */
export const quoteOf = (amount: number, price: number) => mulDiv(amount, price, UNIT);
/** Comisión del taker sobre el VEL ejecutado: 0 si vale menos de 1.000 € (o no hay precio), 1 pb si no. */
export const marketFee = (velExecuted: number, prices?: PriceView | null) => (velExecuted <= 0 ? 0 : feeForVel(prices ?? null, velExecuted));
/** Máximo de contrapartes por orden entrante (acota el cómputo de un bloque). */
export const MAX_FILLS = 100;

const HOUR = 3_600_000;

function bookOfPair(s: ChainState, pair: string) {
  return (s.dex.books[pair] ??= { bids: [], asks: [] });
}

function insertOrder(s: ChainState, o: Order) {
  const book = bookOfPair(s, o.pair);
  const list = o.side === "buy" ? book.bids : book.asks;
  // Primera posición con peor precio: así, a igual precio, manda quien llegó antes.
  let i = 0;
  while (i < list.length) {
    const p = s.dex.orders[list[i]!]!.price;
    if (o.side === "buy" ? p < o.price : p > o.price) break;
    i++;
  }
  list.splice(i, 0, o.id);
  s.dex.orders[o.id] = o;
  s.dex.open[o.owner] = (s.dex.open[o.owner] ?? 0) + 1;
}

/** Saca una orden del libro y devuelve lo que quede bloqueado a su dueño. */
function closeOrder(s: ChainState, o: Order) {
  const book = bookOfPair(s, o.pair);
  const list = o.side === "buy" ? book.bids : book.asks;
  const i = list.indexOf(o.id);
  if (i >= 0) list.splice(i, 1);
  if (book.bids.length === 0 && book.asks.length === 0) delete s.dex.books[o.pair];
  if (o.escrow > 0) {
    const token = o.side === "sell" ? VEL : tokenOfPair(o.pair)!;
    debit(s, ESCROW_ADDRESS, token, o.escrow);
    credit(s, o.owner, token, o.escrow);
    o.escrow = 0;
  }
  delete s.dex.orders[o.id];
  const n = (s.dex.open[o.owner] ?? 1) - 1;
  if (n <= 0) delete s.dex.open[o.owner];
  else s.dex.open[o.owner] = n;
}

function recordTrade(s: ChainState, t: Trade) {
  s.dex.trades.push(t);
  if (s.dex.trades.length > TRADE_LOG) s.dex.trades.splice(0, s.dex.trades.length - TRADE_LOG);
  const st = (s.dex.pairs[t.pair] ??= { last: t.price, hours: [] });
  st.last = t.price;
  const h = Math.floor(t.ts / HOUR);
  let b = st.hours[st.hours.length - 1];
  if (!b || b.h !== h) {
    b = { h, vel: 0, quote: 0, trades: 0 };
    st.hours.push(b);
  }
  b.vel += t.amount;
  b.quote += t.quote;
  b.trades++;
  oracleTrade(s, t.pair, t.amount, curEpoch(s));
  while (st.hours.length && st.hours[0]!.h <= h - 24) st.hours.shift();
}

export function applyOrderPlace(s: ChainState, tx: OrderPlaceTx): string | null {
  const token = tokenOfPair(tx.pair)!;
  if (!s.tokens[token]) return "Token desconocido";
  if ((s.dex.open[tx.from] ?? 0) >= MAX_OPEN_ORDERS) return "Demasiadas órdenes abiertas";
  const ttl = tx.ttl ?? ORDER_TTL_DEFAULT;
  if (tx.side === "sell") {
    // Bloquea los VEL y reserva la comisión máxima posible (se cobra solo lo ejecutado).
    if (balanceOf(s, tx.from, VEL) < tx.amount + marketFee(tx.amount, s.oracle)) return "Saldo insuficiente (cantidad + comisión)";
  } else {
    const cost = quoteOf(tx.amount, tx.price);
    if (cost <= 0) return "Importe en token demasiado pequeño";
    if (balanceOf(s, tx.from, token) < cost) return "Saldo de token insuficiente";
  }
  // --- A partir de aquí no puede fallar ---
  const o: Order = {
    id: nextId(s, "o"), seq: s.seq, owner: tx.from, pair: tx.pair, side: tx.side, price: tx.price, amount: tx.amount,
    remaining: tx.amount, escrow: tx.side === "sell" ? tx.amount : quoteOf(tx.amount, tx.price),
    height: s.height, expires: epochOf(s.height) + ttl,
  };
  const escrowToken = tx.side === "sell" ? VEL : token;
  debit(s, tx.from, escrowToken, o.escrow);
  credit(s, ESCROW_ADDRESS, escrowToken, o.escrow);

  const book = bookOfPair(s, tx.pair);
  const opposite = tx.side === "buy" ? book.asks : book.bids;
  let executed = 0;
  let fills = 0;
  while (o.remaining > 0 && opposite.length > 0 && fills < MAX_FILLS) {
    const m = s.dex.orders[opposite[0]!]!;
    if (tx.side === "buy" ? m.price > o.price : m.price < o.price) break;
    const q = Math.min(o.remaining, m.remaining);
    const quote = quoteOf(q, m.price); // al precio del maker
    const [buyer, seller] = tx.side === "buy" ? [o, m] : [m, o];
    // Comprador: paga `quote` en token desde su depósito. Vendedor: entrega `q` VEL desde el suyo.
    buyer.escrow -= quote;
    debit(s, ESCROW_ADDRESS, token, quote);
    credit(s, seller.owner, token, quote);
    seller.escrow -= q;
    debit(s, ESCROW_ADDRESS, VEL, q);
    credit(s, buyer.owner, VEL, q);
    m.remaining -= q;
    o.remaining -= q;
    executed += q;
    fills++;
    recordTrade(s, { pair: tx.pair, price: m.price, amount: q, quote, side: tx.side, maker: m.owner, taker: tx.from, makerOrder: m.id, height: s.height, ts: s.ts });
    if (m.remaining === 0) closeOrder(s, m);
  }
  // Comisión del taker en VEL: el vendedor la tenía reservada; el comprador la paga de lo que recibe.
  if (executed > 0) {
    const fee = tx.side === "sell" ? marketFee(executed, s.oracle) : Math.min(executed, marketFee(executed, s.oracle));
    chargeFee(s, tx.from, fee);
  }
  if (o.remaining > 0) insertOrder(s, o);
  else if (o.escrow > 0) { // restos de redondeo del comprador
    debit(s, ESCROW_ADDRESS, escrowToken, o.escrow);
    credit(s, o.owner, escrowToken, o.escrow);
  }
  if (bookOfPair(s, tx.pair).bids.length === 0 && bookOfPair(s, tx.pair).asks.length === 0) delete s.dex.books[tx.pair];
  return null;
}

export function applyOrderCancel(s: ChainState, tx: OrderCancelTx): string | null {
  const o = s.dex.orders[tx.id];
  if (!o) return "Orden no encontrada";
  if (o.owner !== tx.from) return "La orden no es tuya";
  closeOrder(s, o);
  return null;
}

/** Devuelve los fondos de las órdenes caducadas (al cerrar época). Orden estable por id de llegada. */
export function expireOrders(s: ChainState, epoch: number) {
  const due = Object.values(s.dex.orders).filter((o) => o.expires <= epoch).sort((a, b) => a.seq - b.seq);
  for (const o of due) closeOrder(s, o);
}

// ---------- Lectura (explorador / RPC) ----------
export interface DepthLevel { price: number; amount: number; orders: number }

/** Profundidad del libro por nivel de precio (bids de mejor a peor; asks de mejor a peor). */
export function bookDepth(s: ChainState, pair: string, levels = 20): { pair: string; bids: DepthLevel[]; asks: DepthLevel[] } {
  const book = s.dex.books[pair] ?? { bids: [], asks: [] };
  const agg = (ids: string[]) => {
    const out: DepthLevel[] = [];
    for (const id of ids) {
      const o = s.dex.orders[id]!;
      const last = out[out.length - 1];
      if (last && last.price === o.price) { last.amount += o.remaining; last.orders++; }
      else {
        if (out.length >= levels) break;
        out.push({ price: o.price, amount: o.remaining, orders: 1 });
      }
    }
    return out;
  };
  return { pair, bids: agg(book.bids), asks: agg(book.asks) };
}

export const lastPrice = (s: ChainState, pair: string): number | null => s.dex.pairs[pair]?.last ?? null;

/** Volumen de las últimas 24 h (según la hora del último bloque). */
export function volume24h(s: ChainState, pair: string) {
  const h = Math.floor(s.ts / HOUR);
  let vel = 0, quote = 0, trades = 0;
  for (const b of s.dex.pairs[pair]?.hours ?? []) if (b.h > h - 24) { vel += b.vel; quote += b.quote; trades += b.trades; }
  return { vel, quote, trades };
}

export const ordersOf = (s: ChainState, owner: string) =>
  Object.values(s.dex.orders).filter((o) => o.owner === owner).sort((a, b) => a.seq - b.seq);
