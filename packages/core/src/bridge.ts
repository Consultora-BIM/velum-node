// Pasarela USDT ⇄ vUSDT en la cadena (docs/mainnet.md §6).
//  · `bridge.mint`  : solo la autoridad de la pasarela (emisor de vUSDT en génesis). `ref` única: un depósito no se acuña dos veces.
//  · `bridge.redeem`: cualquiera canjea su vUSDT por USDT en TRON/Polygon/Ethereum. Ese vUSDT sale de la circulación
//    (se paga fuera). VEL no se toca nunca.
// La validación de direcciones de destino va en consenso: un canje a una dirección imposible no entra.
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, unb58, utf8ToBytes } from "./bytes";
import { BRIDGE_CHAINS, BRIDGE_MIN_REDEEM, BRIDGE_REF_MAX, BRIDGE_TOKEN, type BridgeChain } from "./constants";
import type { BridgeMintTx, BridgeRedeemTx } from "./tx";
import { type ChainState, balanceOf, credit, debit } from "./state";

export function isTronAddress(a: unknown): boolean {
  if (typeof a !== "string" || !/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a)) return false;
  try {
    const raw = unb58(a);
    if (raw.length !== 25 || raw[0] !== 0x41) return false;
    return bytesToHex(sha256(sha256(raw.slice(0, 21))).slice(0, 4)) === bytesToHex(raw.slice(21));
  } catch { return false; }
}

export function isEvmAddress(a: unknown): boolean {
  if (typeof a !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(a)) return false;
  const body = a.slice(2);
  if (body === body.toLowerCase() || body === body.toUpperCase()) return true;
  const h = bytesToHex(keccak_256(utf8ToBytes(body.toLowerCase())));
  for (let i = 0; i < 40; i++) {
    const c = body[i]!;
    if (/[a-f]/i.test(c) && (parseInt(h[i]!, 16) >= 8 ? c !== c.toUpperCase() : c !== c.toLowerCase())) return false;
  }
  return true;
}

export const isBridgeChain = (c: unknown): c is BridgeChain => typeof c === "string" && (BRIDGE_CHAINS as readonly string[]).includes(c);
export const isBridgeDestination = (chain: BridgeChain, to: unknown) => (chain === "tron" ? isTronAddress(to) : isEvmAddress(to));
export const isBridgeRef = (r: unknown) => typeof r === "string" && r.length > 0 && r.length <= BRIDGE_REF_MAX && /^[a-z0-9:_-]+$/i.test(r);

/** `minted`/`redeemed` en µvUSDT (BigInt). */
export interface BridgeState { refs: Record<string, number>; minted: bigint; redeemed: bigint; redeems: number }
const bstate = (s: ChainState): BridgeState => ((s as any).bridge ??= { refs: {}, minted: 0n, redeemed: 0n, redeems: 0 });

export function applyBridgeMint(s: ChainState, tx: BridgeMintTx): string | null {
  const t = s.tokens[BRIDGE_TOKEN];
  if (!t || !t.bridge) return "Pasarela no disponible en esta red";
  if (tx.from !== t.issuer) return "Solo la pasarela acuña vUSDT";
  const b = (s as any).bridge as BridgeState | undefined;
  if (b?.refs[tx.ref] !== undefined) return "Depósito ya acuñado";
  if (t.supply + tx.amount > t.maxSupply) return "Supera el suministro máximo";
  const st = bstate(s);
  st.refs[tx.ref] = s.height;
  st.minted += tx.amount;
  t.supply += tx.amount;
  credit(s, tx.to, BRIDGE_TOKEN, tx.amount);
  return null;
}

export function applyBridgeRedeem(s: ChainState, tx: BridgeRedeemTx): string | null {
  const t = s.tokens[BRIDGE_TOKEN];
  if (!t || !t.bridge) return "Pasarela no disponible en esta red";
  if (tx.amount < BRIDGE_MIN_REDEEM) return "Canje por debajo del mínimo (1 vUSDT)";
  if (balanceOf(s, tx.from, BRIDGE_TOKEN) < tx.amount) return "Saldo de vUSDT insuficiente";
  debit(s, tx.from, BRIDGE_TOKEN, tx.amount);
  t.supply -= tx.amount;
  const st = bstate(s);
  st.redeemed += tx.amount;
  st.redeems++;
  return null;
}
