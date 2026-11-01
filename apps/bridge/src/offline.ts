// Cola de retiros y firma SIN CONEXIÓN.
// El puente (en línea) prepara la cola con todo lo que hace falta para firmar: nonce, gas, bloque de referencia.
// El firmante (sin red) reconstruye cada transacción desde los campos, sin fiarse de hashes ya hechos, y la firma
// con la clave derivada de la frase. Nada de aquí abre la red.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { canonical, hashHex } from "@velum/core";
import { addr20Of, derivePrivateKey, accountXpub, deriveAddress, familyOf, type ChainId, type Family } from "./hd";

// ---------- Formato de la cola ----------

export type EntryKind = "payout" | "sweep" | "gas";

export interface EvmParams {
  chainId: number;
  nonce: number;
  maxFeePerGas: string; // wei, decimal
  maxPriorityFeePerGas: string;
  gasLimit: number;
}

export interface TronParams {
  /** 2 bytes (hex) del número de bloque de referencia. */
  refBlockBytes: string;
  /** 8 bytes (hex) del id del bloque de referencia. */
  refBlockHash: string;
  /** Caducidad y hora (ms). TRON no acepta más de 24 h desde la referencia. */
  expiration: number;
  timestamp: number;
  /** Tope de comisión (sun). Solo para llamadas a contrato. */
  feeLimit: number;
}

export interface QueueEntry {
  /** Retiro: id de la tx `bridge.redeem` en Velum. Barrido: `sweep:<cadena>:<índice>`. Gas: `gas:<cadena>:<índice>`. */
  id: string;
  kind: EntryKind;
  chain: ChainId;
  /** Clave que firma: rama/índice bajo la cuenta de la familia (1/0 = tesorería; 0/i = depósito i). */
  from: { branch: number; index: number };
  /** Dirección esperada de esa clave (el firmante la comprueba: frase equivocada = error). */
  fromAddress: string;
  to: string;
  /** Unidades mínimas (USDT: 6 decimales; nativo: sun o wei). Texto decimal para no perder precisión. */
  amount: string;
  asset: "usdt" | "native";
  /** Contrato USDT en esa cadena (si asset = usdt). */
  token?: string;
  evm?: EvmParams;
  tron?: TronParams;
}

export interface PayoutQueue {
  v: 1;
  created: string;
  /** Huella de la cartera fría (cold-wallet.public.json) para la que se preparó. */
  coldFingerprint: string;
  xpubs: Record<Family, string>;
  entries: QueueEntry[];
}

export interface SignedEntry { id: string; kind: EntryKind; chain: ChainId; txid: string; raw: string; to: string; amount: string; asset: "usdt" | "native" }
export interface SignedFile { v: 1; signed: string; queueHash: string; entries: SignedEntry[] }

export const queueHash = (q: PayoutQueue) => hashHex(canonical(q));

// ---------- RLP (Ethereum) ----------

type RlpItem = Uint8Array | RlpItem[];

function bigBytes(n: bigint): Uint8Array {
  if (n < 0n) throw new Error("RLP: negativo");
  if (n === 0n) return new Uint8Array(0);
  let hex = n.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return hexToBytes(hex);
}

function rlpLen(len: number, short: number): Uint8Array {
  if (len <= 55) return new Uint8Array([short + len]);
  const lb = bigBytes(BigInt(len));
  return concatBytes(new Uint8Array([short + 55 + lb.length]), lb);
}

export function rlp(item: RlpItem): Uint8Array {
  if (item instanceof Uint8Array) {
    if (item.length === 1 && item[0]! < 0x80) return item;
    return concatBytes(rlpLen(item.length, 0x80), item);
  }
  const body = concatBytes(...item.map(rlp));
  return concatBytes(rlpLen(body.length, 0xc0), body);
}

const pad32 = (b: Uint8Array) => concatBytes(new Uint8Array(32 - b.length), b);

/** Datos de `transfer(address,uint256)` de ERC-20/TRC-20. */
export function erc20TransferData(to20: Uint8Array, amount: bigint): Uint8Array {
  return concatBytes(hexToBytes("a9059cbb"), pad32(to20), pad32(bigBytes(amount)));
}

/** Transacción EIP-1559 (tipo 2) firmada. Devuelve el crudo y su hash. */
export function signEvm(e: QueueEntry, sk: Uint8Array): { raw: string; txid: string } {
  const p = e.evm!;
  const amount = BigInt(e.amount);
  const to20 = addr20Of(e.chain, e.to);
  const [dest, value, data] = e.asset === "usdt"
    ? [addr20Of(e.chain, e.token!), 0n, erc20TransferData(to20, amount)]
    : [to20, amount, new Uint8Array(0)];
  const fields: RlpItem[] = [
    bigBytes(BigInt(p.chainId)), bigBytes(BigInt(p.nonce)), bigBytes(BigInt(p.maxPriorityFeePerGas)), bigBytes(BigInt(p.maxFeePerGas)),
    bigBytes(BigInt(p.gasLimit)), dest, bigBytes(value), data, [],
  ];
  const unsigned = concatBytes(new Uint8Array([2]), rlp(fields));
  const sig = secp256k1.sign(keccak_256(unsigned), sk, { prehash: false, format: "recovered" });
  const rec = sig[0]!, r = sig.slice(1, 33), s = sig.slice(33, 65);
  const strip0 = (b: Uint8Array) => bigBytes(BigInt("0x" + bytesToHex(b)));
  const raw = concatBytes(new Uint8Array([2]), rlp([...fields, bigBytes(BigInt(rec)), strip0(r), strip0(s)]));
  return { raw: bytesToHex(raw), txid: bytesToHex(keccak_256(raw)) };
}

// ---------- Protobuf mínimo (TRON) ----------

function varint(n: number | bigint): Uint8Array {
  let v = BigInt(n);
  if (v < 0n) throw new Error("varint negativo");
  const out: number[] = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; out.push(b); } while (v);
  return new Uint8Array(out);
}
const key = (field: number, wire: number) => varint((field << 3) | wire);
const pbBytes = (field: number, b: Uint8Array) => concatBytes(key(field, 2), varint(b.length), b);
const pbInt = (field: number, n: number | bigint) => concatBytes(key(field, 0), varint(n));

const TRON_TRIGGER = 31;
const TRON_TRANSFER = 1;
const tron21 = (chain: ChainId, a: string) => concatBytes(new Uint8Array([0x41]), addr20Of(chain, a));

/** `raw_data` de una transacción TRON (TriggerSmartContract para USDT, TransferContract para TRX). */
export function tronRawData(e: QueueEntry): Uint8Array {
  const p = e.tron!;
  const owner = tron21("tron", e.fromAddress);
  let type: number, typeUrl: string, value: Uint8Array;
  if (e.asset === "usdt") {
    type = TRON_TRIGGER; typeUrl = "type.googleapis.com/protocol.TriggerSmartContract";
    value = concatBytes(pbBytes(1, owner), pbBytes(2, tron21("tron", e.token!)), pbBytes(4, erc20TransferData(addr20Of("tron", e.to), BigInt(e.amount))));
  } else {
    type = TRON_TRANSFER; typeUrl = "type.googleapis.com/protocol.TransferContract";
    value = concatBytes(pbBytes(1, owner), pbBytes(2, tron21("tron", e.to)), pbInt(3, BigInt(e.amount)));
  }
  const any = concatBytes(pbBytes(1, utf8ToBytes(typeUrl)), pbBytes(2, value));
  const contract = concatBytes(pbInt(1, type), pbBytes(2, any));
  const parts = [
    pbBytes(1, hexToBytes(p.refBlockBytes)), pbBytes(4, hexToBytes(p.refBlockHash)), pbInt(8, p.expiration),
    pbBytes(11, contract), pbInt(14, p.timestamp),
  ];
  if (e.asset === "usdt") parts.push(pbInt(18, p.feeLimit));
  return concatBytes(...parts);
}

export function signTron(e: QueueEntry, sk: Uint8Array): { raw: string; txid: string } {
  const raw = tronRawData(e);
  const txid = sha256(raw);
  const sig = secp256k1.sign(txid, sk, { prehash: false, format: "recovered" });
  const sig65 = concatBytes(sig.slice(1, 65), new Uint8Array([sig[0]! + 27]));
  const tx = concatBytes(pbBytes(1, raw), pbBytes(2, sig65));
  return { raw: bytesToHex(tx), txid: bytesToHex(txid) };
}

/** Referencia de bloque de TRON desde el número y el id (hash) del último bloque. */
export function tronRef(blockNumber: number, blockIdHex: string): Pick<TronParams, "refBlockBytes" | "refBlockHash"> {
  const n = new Uint8Array(8);
  new DataView(n.buffer).setBigUint64(0, BigInt(blockNumber));
  return { refBlockBytes: bytesToHex(n.slice(6, 8)), refBlockHash: blockIdHex.replace(/^0x/, "").slice(16, 32) };
}

// ---------- Revisión y firma ----------

export interface SignLimits {
  /** Máximo por retiro y suma de retiros (USDT, 6 decimales). Los fija quien firma, no la cola. */
  maxPayout: bigint;
  maxTotalPayout: bigint;
}

/** Comprueba la cola sin claves: formato, direcciones y topes. Devuelve los problemas (vacío = bien). */
export function reviewQueue(q: PayoutQueue, limits: SignLimits): string[] {
  const errs: string[] = [];
  if (q.v !== 1 || !Array.isArray(q.entries)) return ["Cola con formato desconocido"];
  const ids = new Set<string>();
  let total = 0n;
  for (const e of q.entries) {
    const tag = `${e.id} (${e.chain})`;
    if (ids.has(e.id)) errs.push(`${tag}: repetido`);
    ids.add(e.id);
    if (!["payout", "sweep", "gas"].includes(e.kind)) errs.push(`${tag}: tipo desconocido`);
    let amount = 0n;
    try { amount = BigInt(e.amount); } catch { errs.push(`${tag}: importe no válido`); }
    if (amount <= 0n) errs.push(`${tag}: importe no positivo`);
    try { addr20Of(e.chain, e.to); } catch { errs.push(`${tag}: destino no válido`); }
    if (e.asset === "usdt") { try { addr20Of(e.chain, e.token!); } catch { errs.push(`${tag}: contrato no válido`); } }
    if (e.kind === "payout") {
      if (e.asset !== "usdt" || e.from.branch !== 1 || e.from.index !== 0) errs.push(`${tag}: un retiro sale siempre de la tesorería en USDT`);
      if (amount > limits.maxPayout) errs.push(`${tag}: supera el máximo por retiro`);
      total += amount;
    }
    if (e.kind === "sweep") {
      if (e.asset !== "usdt" || e.from.branch !== 0) errs.push(`${tag}: un barrido sale de una dirección de depósito en USDT`);
      const treasury = deriveAddress(familyOf(e.chain), q.xpubs[familyOf(e.chain)], 1, 0);
      if (e.to !== treasury) errs.push(`${tag}: un barrido solo puede ir a la tesorería`);
    }
    if (e.kind === "gas") {
      if (e.asset !== "native" || e.from.branch !== 1 || e.from.index !== 0) errs.push(`${tag}: el gas sale de la tesorería en moneda nativa`);
      const dep = /^gas:[a-z]+:(\d+)$/.exec(e.id);
      if (!dep || e.to !== deriveAddress(familyOf(e.chain), q.xpubs[familyOf(e.chain)], 0, Number(dep[1]))) errs.push(`${tag}: el gas solo va a direcciones de depósito propias`);
    }
    const expected = deriveAddress(familyOf(e.chain), q.xpubs[familyOf(e.chain)], e.from.branch, e.from.index);
    if (expected !== e.fromAddress) errs.push(`${tag}: la dirección de origen no sale de la xpub`);
    if (e.chain === "tron" ? !e.tron : !e.evm) errs.push(`${tag}: faltan los parámetros de la cadena`);
  }
  if (total > limits.maxTotalPayout) errs.push(`La suma de retiros supera el tope (${total} > ${limits.maxTotalPayout})`);
  return errs;
}

/** Resumen legible para revisar antes de firmar. */
export function summarizeQueue(q: PayoutQueue): string {
  const lines: string[] = [];
  const totals = new Map<string, bigint>();
  for (const e of q.entries) {
    const k = `${e.kind} ${e.chain} ${e.asset}`;
    totals.set(k, (totals.get(k) ?? 0n) + BigInt(e.amount));
    const amt = e.asset === "usdt" ? `${fmt6(BigInt(e.amount))} USDT` : `${e.amount} (nativo, mínima unidad)`;
    lines.push(`  ${e.kind.padEnd(6)} ${e.chain.padEnd(8)} ${amt.padStart(22)} → ${e.to}`);
  }
  lines.push("", "Totales:");
  for (const [k, v] of totals) lines.push(`  ${k}: ${k.endsWith("usdt") ? fmt6(v) + " USDT" : v.toString()}`);
  return lines.join("\n");
}

export const fmt6 = (n: bigint) => `${n / 1_000_000n}.${(n % 1_000_000n).toString().padStart(6, "0")}`;

/**
 * Firma toda la cola con la semilla BIP-39 (64 B). Comprueba que la semilla es la de la cola (xpub iguales).
 * No escribe nada ni toca la red. Borra las claves de memoria al terminar.
 */
export function signQueue(q: PayoutQueue, seed: Uint8Array, limits: SignLimits, now = new Date()): SignedFile {
  for (const f of ["tron", "evm"] as Family[])
    if (accountXpub(seed, f) !== q.xpubs[f]) throw new Error("Esta frase no es la de la cartera fría de la cola");
  const errs = reviewQueue(q, limits);
  if (errs.length) throw new Error("La cola no pasa la revisión:\n" + errs.join("\n"));
  const entries: SignedEntry[] = [];
  for (const e of q.entries) {
    const sk = derivePrivateKey(seed, familyOf(e.chain), e.from.branch, e.from.index);
    try {
      const derived = deriveAddress(familyOf(e.chain), q.xpubs[familyOf(e.chain)], e.from.branch, e.from.index);
      if (derived !== e.fromAddress) throw new Error(`${e.id}: origen inesperado`);
      const { raw, txid } = e.chain === "tron" ? signTron(e, sk) : signEvm(e, sk);
      entries.push({ id: e.id, kind: e.kind, chain: e.chain, txid, raw, to: e.to, amount: e.amount, asset: e.asset });
    } finally {
      sk.fill(0);
    }
  }
  return { v: 1, signed: now.toISOString(), queueHash: queueHash(q), entries };
}
