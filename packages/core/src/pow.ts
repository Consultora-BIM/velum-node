// Sello de prueba de trabajo antispam (protocolo-v3 §5).
// Los pagos de menos de 1.000 € no pagan comisión: a cambio llevan un sello pequeño (~65.000 SHA-512,
// unas décimas de segundo en un móvil). Nadie manda spam gratis y nadie paga por pagar poco.
//
//   cuerpo = sha512(JSON canónico de la tx SIN `sig` ni `pow`)
//   sello  = sha512(cuerpo ‖ u64be(pow))      bits = ceros iniciales del sello
//
// El sello se calcula antes de firmar (la firma cubre `pow`) y no se puede reutilizar en otra tx.
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, canonical, utf8ToBytes } from "./bytes";

/** Ceros iniciales (bits) de un hash. */
export function leadingZeroBits(h: Uint8Array): number {
  let n = 0;
  for (const b of h) {
    if (b === 0) { n += 8; continue; }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** Hash del cuerpo de una tx (sin `sig` ni `pow`). */
export function powBody(tx: object): Uint8Array {
  const { sig: _s, pow: _p, ...rest } = tx as Record<string, unknown>;
  return sha512(utf8ToBytes(canonical(rest)));
}

function stampInput(body: Uint8Array, nonce: number): Uint8Array {
  const buf = new Uint8Array(72);
  buf.set(body, 0);
  writeU64(buf, 64, nonce);
  return buf;
}

function writeU64(buf: Uint8Array, off: number, n: number) {
  const hi = Math.floor(n / 2 ** 32), lo = n >>> 0;
  buf[off] = hi >>> 24; buf[off + 1] = (hi >>> 16) & 255; buf[off + 2] = (hi >>> 8) & 255; buf[off + 3] = hi & 255;
  buf[off + 4] = lo >>> 24; buf[off + 5] = (lo >>> 16) & 255; buf[off + 6] = (lo >>> 8) & 255; buf[off + 7] = lo & 255;
}

/** Bits que consigue el sello `pow` de una tx (0 si no lo lleva o no es un entero válido). */
export function powBits(tx: { pow?: unknown }): number {
  const p = tx.pow;
  if (typeof p !== "number" || !Number.isSafeInteger(p) || p < 0) return 0;
  return leadingZeroBits(sha512(stampInput(powBody(tx), p)));
}

/** Hash del sello (hex), para vectores de prueba y el explorador. */
export const powHash = (tx: { pow?: number }) => bytesToHex(sha512(stampInput(powBody(tx), tx.pow ?? 0)));

/**
 * Busca un sello de `bits` ceros para la tx (sin firmar). Devuelve el nonce.
 * Coste medio 2^bits hashes (16 bits ≈ 0,1 s en Bun; 20 bits ≈ 2 s).
 */
export function solvePow(tx: object, bits: number, start = 0): number {
  const buf = stampInput(powBody(tx), 0);
  const full = bits >> 3, rest = bits & 7;
  const mask = rest ? (0xff << (8 - rest)) & 0xff : 0;
  for (let n = start; n < Number.MAX_SAFE_INTEGER; n++) {
    writeU64(buf, 64, n);
    const h = sha512(buf);
    let ok = true;
    for (let i = 0; i < full; i++) if (h[i] !== 0) { ok = false; break; }
    if (ok && rest && (h[full]! & mask) !== 0) ok = false;
    if (ok) return n;
  }
  throw new Error("Sin sello");
}

/** Añade el sello a una tx sin firmar (no la muta). */
export function attachPow<T extends object>(tx: T, bits: number): T & { pow: number } {
  return { ...tx, pow: solvePow(tx, bits) };
}
