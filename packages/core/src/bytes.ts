// Utilidades de bytes y codificación. Sin Buffer: funciona igual en Bun, Workers y Hermes (iOS).
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes } from "@noble/hashes/utils.js";
import { base58, base64 } from "@scure/base";

export { bytesToHex, hexToBytes, utf8ToBytes, concatBytes, randomBytes, sha256 };

const dec = new TextDecoder();
export const bytesToUtf8 = (b: Uint8Array) => dec.decode(b);
export const b64 = (b: Uint8Array) => base64.encode(b);
export const unb64 = (s: string) => base64.decode(s);
export const b58 = (b: Uint8Array) => base58.encode(b);
export const unb58 = (s: string) => base58.decode(s);

/** JSON canónico: claves ordenadas, sin espacios. Es lo que se firma y se hashea. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  return (
    "{" +
    Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(obj[k]))
      .join(",") +
    "}"
  );
}

export const hashHex = (data: Uint8Array | string) =>
  bytesToHex(sha256(typeof data === "string" ? utf8ToBytes(data) : data));

export const hashObj = (value: unknown) => hashHex(canonical(value));

/** Raíz de Merkle (sha256) de una lista de hashes hex. Vacía → 64 ceros. */
export function merkleRoot(leaves: string[]): string {
  if (leaves.length === 0) return "0".repeat(64);
  let level = leaves.slice();
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i]!;
      const b = level[i + 1] ?? a;
      next.push(hashHex(a + b));
    }
    level = next;
  }
  return level[0]!;
}
