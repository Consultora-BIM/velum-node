// Tokens propios en la red (protocolo-v2 §8). Las comisiones se pagan siempre en VEL.
import { BRIDGE_TOKEN, TOKEN_CREATE_FEE, TOKEN_SYMBOL_RE, VEL } from "./constants";
import type { TokenCreateTx, TokenMintTx } from "./tx";
import { type ChainState, balanceOf, chargeFee, chargeToReserve, credit } from "./state";

export interface TokenInfo {
  symbol: string;
  name: string;
  decimals: number;
  maxSupply: number;
  /** Unidades emitidas hasta ahora. */
  supply: number;
  issuer: string;
  mintable: boolean;
  createdHeight: number;
  /** Solo los de génesis de la testnet (tEUR, tUSD, tUSDT): de prueba, no representan dinero. */
  test?: boolean;
  /** vUSDT de mainnet: solo lo acuña la pasarela (`bridge.mint`) y se canjea con `bridge.redeem`. */
  bridge?: boolean;
}

/** Tokens de prueba de la testnet: 6 decimales, 1.000 M de unidades enteras al grifo. NO son dinero. */
export const GENESIS_TOKENS = [
  { symbol: "tEUR", name: "Euro de prueba (testnet, sin valor)" },
  { symbol: "tUSD", name: "Dólar de prueba (testnet, sin valor)" },
  { symbol: "tUSDT", name: "Tether de prueba (testnet, sin valor)" },
] as const;
export const GENESIS_TOKEN_DECIMALS = 6;
export const GENESIS_TOKEN_SUPPLY = 1_000_000_000 * 10 ** GENESIS_TOKEN_DECIMALS;

export function genesisTokens(faucet: string): TokenInfo[] {
  return GENESIS_TOKENS.map((t) => ({
    symbol: t.symbol, name: t.name, decimals: GENESIS_TOKEN_DECIMALS, maxSupply: GENESIS_TOKEN_SUPPLY, supply: GENESIS_TOKEN_SUPPLY,
    issuer: faucet, mintable: false, createdHeight: 0, test: true,
  }));
}

/** Token envuelto de la pasarela (mainnet): 6 decimales, suministro 0, emisor = autoridad de la pasarela. */
export function bridgeToken(authority: string): TokenInfo {
  return {
    symbol: BRIDGE_TOKEN, name: "Tether USD envuelto (1:1, pasarela Velum)", decimals: 6, maxSupply: Number.MAX_SAFE_INTEGER, supply: 0,
    issuer: authority, mintable: false, createdHeight: 0, bridge: true,
  };
}

/** Reglas de símbolo: 3–8 A-Z 0-9, no `VEL`, y sin chocar (sin distinguir mayúsculas) con uno existente. */
export function symbolProblem(s: ChainState, symbol: string): string | null {
  if (!TOKEN_SYMBOL_RE.test(symbol)) return "Símbolo no válido (3–8 caracteres A-Z 0-9)";
  const up = symbol.toUpperCase();
  if (up === VEL) return "Símbolo reservado";
  for (const k of Object.keys(s.tokens)) if (k.toUpperCase() === up) return "Símbolo ya existe";
  return null;
}

export function applyTokenCreate(s: ChainState, tx: TokenCreateTx): string | null {
  const p = symbolProblem(s, tx.symbol);
  if (p) return p;
  if (balanceOf(s, tx.from, VEL) < TOKEN_CREATE_FEE) return "Hacen falta 100 VEL para crear un token";
  chargeToReserve(s, tx.from, TOKEN_CREATE_FEE); // 100 VEL enteros a la Reserva de la Red (antispam)
  s.tokens[tx.symbol] = {
    symbol: tx.symbol, name: tx.name, decimals: tx.decimals, maxSupply: tx.maxSupply, supply: tx.initial,
    issuer: tx.from, mintable: tx.mintable, createdHeight: s.height,
  };
  credit(s, tx.from, tx.symbol, tx.initial);
  return null;
}

export function applyTokenMint(s: ChainState, tx: TokenMintTx): string | null {
  const t = s.tokens[tx.symbol];
  if (!t) return "Token desconocido";
  if (t.issuer !== tx.from) return "Solo el emisor puede emitir";
  if (!t.mintable) return "Token sin emisión adicional";
  if (t.supply + tx.amount > t.maxSupply) return "Supera el suministro máximo";
  if (balanceOf(s, tx.from, VEL) < tx.fee) return "Saldo insuficiente para la comisión";
  chargeFee(s, tx.from, tx.fee); // normalmente 0 (va con sello PoW)
  t.supply += tx.amount;
  credit(s, tx.to, tx.symbol, tx.amount);
  return null;
}

/** Decimales de un token (VEL = 6). */
export const decimalsOf = (s: ChainState | null, token: string) => (token === VEL ? 6 : s?.tokens[token]?.decimals ?? 6);
