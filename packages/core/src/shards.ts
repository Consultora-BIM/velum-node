// Relleno y fragmentos (docs/protocolo-v2.md §3).
// El sobre mide siempre un cubo fijo (2 KB … 8 MB) y se parte en franjas de k = 3 de n = 5
// con Reed–Solomon: basta con 3 trozos cualesquiera de cada 5. Los trozos no llevan el tamaño real.
import { sha512 } from "@noble/hashes/sha2.js";
import { b64, bytesToHex, concatBytes, randomBytes, unb64, utf8ToBytes } from "./bytes";
import { receiptHash, receiptSecret } from "./proof";
import { rsDecode, rsEncode } from "./rs";
import { BUCKETS, MAX_ENVELOPE_BYTES, MAX_SHARD_BYTES, RS_K, RS_N, SHARD_TTL_V2_MS } from "./msgconst";

export interface Shard {
  /** sha512(msg ‖ stripe ‖ idx)[0..32] en hex. */
  id: string;
  /** Aleatorio por envío (no es el id del payload). */
  msg: string;
  /** Buzón del día del dispositivo destinatario. */
  mailbox: string;
  stripe: number;
  /** 0..n-1 dentro de la franja (0..k-1 datos, k..n-1 paridad). */
  idx: number;
  k: number;
  n: number;
  /** Tamaño del cubo (bytes del sobre completo). */
  bucket: number;
  data: string; // base64
  /** SHA-512 (hex) del secreto de recibo de este trozo. */
  rh: string;
  /** Clave pública de apertura del buzón (§5): solo quien firma con ella lo recoge. */
  mbAuth: string;
  exp: number;
  /** Época de la foto del sorteo con la que el emisor enrutó este trozo (lottery.ts). Va también en el recibo. */
  ep?: number;
}

/** Cubo más pequeño en el que cabe `len`. Lanza si supera 8 MB. */
export function bucketFor(len: number): number {
  for (const b of BUCKETS) if (len <= b) return b;
  throw new Error(`El mensaje supera el máximo (${MAX_ENVELOPE_BYTES / 1024 / 1024} MB)`);
}

/** Tamaño de trozo para un cubo: cubo/3 redondeado a 1 KB, máx. 24 KB. */
export function shardSizeFor(bucket: number): number {
  return Math.min(MAX_SHARD_BYTES, Math.ceil(bucket / RS_K / 1024) * 1024);
}

export function stripesFor(bucket: number): number {
  return Math.ceil(bucket / (RS_K * shardSizeFor(bucket)));
}

/**
 * Relleno interno (antes de cifrar): [4 bytes longitud BE][datos][bytes aleatorios] hasta que
 * `overhead + resultado` sea exactamente un cubo. Así la longitud real va cifrada (el relleno, a ceros, también).
 */
export function padToBucket(data: Uint8Array, overhead = 0): Uint8Array {
  const bucket = bucketFor(data.length + 4 + overhead);
  // Ceros: el relleno va cifrado, así que no se distingue de datos (y randomBytes tiene tope de 64 KB).
  const out = new Uint8Array(bucket - overhead);
  new DataView(out.buffer, out.byteOffset).setUint32(0, data.length);
  out.set(data, 4);
  return out;
}

export function unpad(padded: Uint8Array): Uint8Array {
  const len = new DataView(padded.buffer, padded.byteOffset, padded.byteLength).getUint32(0);
  if (len > padded.length - 4) throw new Error("Relleno no válido");
  return padded.subarray(4, 4 + len);
}

export function shardId(msg: string, stripe: number, idx: number): string {
  return bytesToHex(sha512(utf8ToBytes(`${msg}|${stripe}|${idx}`)).slice(0, 32));
}

export interface SplitOptions {
  mailbox: string;
  mbAuth: string;
  /** Semilla de recibos (hex 32 B) que va dentro del sobre. */
  rseed: string;
  msg?: string;
  now?: number;
  /** Época de la foto del sorteo usada para enrutar (se copia en cada trozo). */
  ep?: number;
}

/** Trocea un sobre (su longitud debe ser un cubo). */
export function splitIntoShards(sealed: Uint8Array, o: SplitOptions): Shard[] {
  const bucket = sealed.length;
  if (!BUCKETS.includes(bucket)) throw new Error("El sobre no tiene tamaño de cubo");
  const msg = o.msg ?? bytesToHex(randomBytes(16));
  const size = shardSizeFor(bucket);
  const stripes = stripesFor(bucket);
  const exp = (o.now ?? Date.now()) + SHARD_TTL_V2_MS;
  const out: Shard[] = [];
  for (let s = 0; s < stripes; s++) {
    const data: Uint8Array[] = [];
    for (let j = 0; j < RS_K; j++) {
      const off = (s * RS_K + j) * size;
      const piece = new Uint8Array(size);
      if (off < bucket) piece.set(sealed.subarray(off, Math.min(bucket, off + size)));
      data.push(piece);
    }
    const all = [...data, ...rsEncode(data, RS_N)];
    all.forEach((piece, idx) => {
      const id = shardId(msg, s, idx);
      out.push({ id, msg, mailbox: o.mailbox, stripe: s, idx, k: RS_K, n: RS_N, bucket, data: b64(piece), rh: receiptHash(receiptSecret(o.rseed, id)), mbAuth: o.mbAuth, exp, ...(o.ep !== undefined ? { ep: o.ep } : {}) });
    });
  }
  return out;
}

/** Recompone el sobre con 3 trozos cualesquiera de cada franja. Null si aún faltan. */
export function joinShards(shards: Shard[]): Uint8Array | null {
  if (!shards.length) return null;
  const { bucket, k, n } = shards[0]!;
  if (!BUCKETS.includes(bucket)) return null;
  const stripes = stripesFor(bucket);
  const byStripe: (Uint8Array | null)[][] = Array.from({ length: stripes }, () => Array(n).fill(null));
  for (const s of shards) {
    if (s.bucket !== bucket || s.stripe < 0 || s.stripe >= stripes || s.idx < 0 || s.idx >= n) continue;
    byStripe[s.stripe]![s.idx] = unb64(s.data);
  }
  const parts: Uint8Array[] = [];
  for (const row of byStripe) {
    if (row.filter(Boolean).length < k) return null;
    parts.push(...rsDecode(row, k));
  }
  return concatBytes(...parts).slice(0, bucket);
}

/** Progreso de recepción: trozos útiles (máx. k por franja) frente a los necesarios. */
export function shardProgress(shards: Shard[]): { have: number; total: number } {
  if (!shards.length) return { have: 0, total: 0 };
  const { bucket, k } = shards[0]!;
  const stripes = stripesFor(bucket);
  const per = new Map<number, Set<number>>();
  for (const s of shards) (per.get(s.stripe) ?? per.set(s.stripe, new Set()).get(s.stripe)!).add(s.idx);
  let have = 0;
  for (let s = 0; s < stripes; s++) have += Math.min(k, per.get(s)?.size ?? 0);
  return { have, total: stripes * k };
}

/**
 * Validación sin estado de un trozo v2 (la hacen nodos completos y ligeros al aceptarlo).
 * Devuelve el motivo del rechazo o null si es correcto.
 */
export function shardProblem(s: Shard, now = Date.now()): string | null {
  if (!s || typeof s !== "object") return "Fragmento no válido";
  if (typeof s.msg !== "string" || !s.msg || s.msg.length > 128) return "Fragmento incompleto";
  if (typeof s.mailbox !== "string" || !/^[0-9a-f]{40}$/.test(s.mailbox)) return "Buzón no válido";
  if (!BUCKETS.includes(s.bucket)) return "Cubo no válido";
  if (s.k !== RS_K || s.n !== RS_N) return "Reparto k/n no válido";
  if (!Number.isInteger(s.stripe) || s.stripe < 0 || s.stripe >= stripesFor(s.bucket)) return "Franja no válida";
  if (!Number.isInteger(s.idx) || s.idx < 0 || s.idx >= RS_N) return "Índice no válido";
  const size = shardSizeFor(s.bucket);
  if (typeof s.data !== "string" || s.data.length !== 4 * Math.ceil(size / 3)) return "Tamaño de trozo incorrecto";
  if (typeof s.rh !== "string" || !/^[0-9a-f]{128}$/.test(s.rh)) return "Huella de recibo no válida";
  if (typeof s.mbAuth !== "string" || !/^[0-9a-f]{64}$/.test(s.mbAuth)) return "Clave de buzón no válida";
  if (typeof s.exp !== "number" || s.exp <= now || s.exp > now + SHARD_TTL_V2_MS + 60_000) return "Caducidad no válida";
  if (s.ep !== undefined && (!Number.isSafeInteger(s.ep) || s.ep < 0)) return "Época no válida";
  if (shardId(s.msg, s.stripe, s.idx) !== s.id) return "Id de fragmento no válido";
  return null;
}
