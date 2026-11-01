// Oráculo de precio propio (protocolo-v3 §6): EUR, USD y USDT por VEL, calculados con el mercado de la cadena.
//
//  · En cada bloque, ANTES de sus tx, cada par suma su último precio al acumulado de la época. Una operación
//    solo cuenta desde el bloque siguiente: comprar y deshacer en el mismo bloque no mueve nada, y una operación
//    suelta pesa 1/1.800 de la ventana (60 épocas × 30 bloques).
//  · TWAP = Σ precios / Σ bloques con precio en las últimas 60 épocas. Vale si el par movió ≥ 1.000 VEL.
//  · Si un par no vale: mediana de los otros convertidos (USD↔USDT 1:1; EUR↔USD con el último cambio visto).
//  · Sin ninguno: null → «sin precio» y sin comisión.
// Precios en µunidad del token (6 decimales) por 1 VEL. Todo entero.
import {
  IS_MAINNET, ORACLE_FX_EUR_PER_USD, ORACLE_MAX_PRICE, ORACLE_MIN_VOLUME, ORACLE_PAIRS, ORACLE_TOKENS, ORACLE_WINDOW_EPOCHS, UNIT, VEL,
} from "./constants";
import type { ChainState } from "./state";

// Mainnet: solo VEL/vUSDT. El euro nunca entra en consenso (eur = null); USD = USDT 1:1.
export type OracleCurrency = "eur" | "usd" | "usdt";
const CURRENCIES = ["eur", "usd", "usdt"] as const;

/** Acumulado de un par en una época. */
export interface OracleBucket { e: number; sum: number; blocks: number; vol: number }

export interface OracleState {
  /** Última época cerrada que se tuvo en cuenta (−1 = nunca). */
  epoch: number;
  eur: number | null;
  usd: number | null;
  usdt: number | null;
  /** De dónde sale cada precio: TWAP propio, reserva cruzada o nada. */
  src: Record<OracleCurrency, "twap" | "cross" | null>;
  /** TWAP y volumen (µVEL) de cada par en la ventana. */
  twap: Record<OracleCurrency, number | null>;
  volume: Record<OracleCurrency, number>;
  /** Cambio µEUR por 1 USD (último visto con los dos pares válidos). */
  fx: number;
  /** Época en curso (se suma bloque a bloque). */
  acc: Record<string, OracleBucket>;
  /** Épocas cerradas (las últimas ORACLE_WINDOW_EPOCHS) por par. */
  window: Record<string, OracleBucket[]>;
}

export const emptyOracle = (): OracleState => ({
  epoch: -1, eur: null, usd: null, usdt: null,
  src: { eur: null, usd: null, usdt: null },
  twap: { eur: null, usd: null, usdt: null },
  volume: { eur: 0, usd: 0, usdt: 0 },
  fx: ORACLE_FX_EUR_PER_USD,
  acc: {},
  window: {},
});

const bucket = (o: OracleState, pair: string, e: number) => (o.acc[pair] ??= { e, sum: 0, blocks: 0, vol: 0 });

/** Una muestra por bloque y par con precio (se llama antes de aplicar las tx del bloque). */
export function oracleSample(s: ChainState, epoch: number) {
  for (const c of CURRENCIES) {
    const pair = ORACLE_PAIRS[c];
    if (!pair) continue;
    const last = s.dex.pairs[pair]?.last;
    if (!last) continue;
    const b = bucket(s.oracle, pair, epoch);
    b.sum += Math.min(last, ORACLE_MAX_PRICE);
    b.blocks++;
  }
}

/** Volumen de una operación (µVEL) en los pares del oráculo. */
export function oracleTrade(s: ChainState, pair: string, vel: number, epoch: number) {
  if (!(Object.values(ORACLE_PAIRS) as string[]).includes(pair)) return;
  bucket(s.oracle, pair, epoch).vol += vel;
}

function median(xs: number[]): number | null {
  if (!xs.length) return null;
  const v = xs.slice().sort((a, b) => a - b);
  const m = v.length >> 1;
  return v.length % 2 ? v[m]! : Math.floor((v[m - 1]! + v[m]!) / 2);
}

const conv = (x: number, mul: number, div: number) => Number((BigInt(x) * BigInt(mul)) / BigInt(div));

/** Cierre de época: pasa el acumulado a la ventana y recalcula precios. */
export function oracleClose(s: ChainState, epoch: number) {
  const o = s.oracle;
  const tw: Record<OracleCurrency, number | null> = { eur: null, usd: null, usdt: null };
  for (const c of CURRENCIES) {
    const pair = ORACLE_PAIRS[c];
    if (!pair) continue;
    const win = (o.window[pair] ??= []);
    const acc = o.acc[pair];
    if (acc) win.push({ ...acc, e: epoch });
    while (win.length && win[0]!.e <= epoch - ORACLE_WINDOW_EPOCHS) win.shift();
    if (!win.length) delete o.window[pair];
    let sum = 0, blocks = 0, vol = 0;
    for (const b of win) { sum += b.sum; blocks += b.blocks; vol += b.vol; }
    o.volume[c] = vol;
    o.twap[c] = blocks > 0 ? Math.floor(sum / blocks) : null;
    tw[c] = blocks > 0 && vol >= ORACLE_MIN_VOLUME && o.twap[c]! > 0 ? o.twap[c] : null;
  }
  o.acc = {};
  // Cambio implícito EUR/USD cuando hay referencias en las dos monedas.
  const usdRef = median([tw.usd, tw.usdt].filter((x): x is number => x !== null));
  if (tw.eur !== null && usdRef !== null) o.fx = conv(tw.eur, 1_000_000, usdRef) || o.fx;
  const toEur = (usd: number) => conv(usd, o.fx, 1_000_000);
  const toUsd = (eur: number) => conv(eur, 1_000_000, o.fx);
  const cross: Record<OracleCurrency, number | null> = {
    eur: IS_MAINNET ? null : median([tw.usd, tw.usdt].filter((x): x is number => x !== null).map(toEur)),
    usd: median([tw.usdt, tw.eur === null ? null : toUsd(tw.eur)].filter((x): x is number => x !== null)),
    usdt: median([tw.usd, tw.eur === null ? null : toUsd(tw.eur)].filter((x): x is number => x !== null)),
  };
  for (const c of CURRENCIES) {
    const v = tw[c] ?? cross[c];
    o[c] = v && v > 0 ? v : null;
    o.src[c] = tw[c] !== null ? "twap" : o[c] !== null ? "cross" : null;
  }
  o.epoch = epoch;
}

// ---------- Valoración (comisiones, cartera, web) ----------
/** Lo mínimo del oráculo que necesitan las cuentas de valor (también vale el `state.oracle` entero). */
export type PriceView = Pick<OracleState, "eur" | "usd" | "usdt">;

/** Token de génesis → moneda del oráculo (testnet: tEUR/tUSD/tUSDT; mainnet: vUSDT). */
const TOKEN_CURRENCY: Record<string, OracleCurrency> = ORACLE_TOKENS;

export interface Valuation {
  /** Equivalente en µVEL (null si no hay precio). */
  vel: number | null;
  eur: number | null;
  usd: number | null;
  usdt: number | null;
}

/** Valor de `amount` unidades mínimas de `token` en VEL, EUR, USD y USDT (µunidades). */
export function valueOf(p: PriceView | null | undefined, token: string, amount: number): Valuation {
  const out: Valuation = { vel: null, eur: null, usd: null, usdt: null };
  let vel: number | null = null;
  if (token === VEL) vel = amount;
  else {
    const c = TOKEN_CURRENCY[token];
    if (!c) return out;
    out[c] = amount;
    const price = p?.[c];
    if (price) vel = conv(amount, UNIT, price);
  }
  out.vel = vel;
  if (vel === null || !p) return out;
  for (const c of CURRENCIES) if (out[c] === null && p[c]) out[c] = conv(vel, p[c]!, UNIT);
  return out;
}

/** Precio actual (µunidad por VEL) o null. */
export const priceOf = (p: PriceView | null | undefined, c: OracleCurrency) => p?.[c] ?? null;
