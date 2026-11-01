// Identidad = cartera. Una sola clave ed25519 firma; de ella sale la clave x25519 que cifra.
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import { b58, unb58, bytesToHex, hexToBytes, randomBytes, sha256, utf8ToBytes, canonical } from "./bytes";
import { FAUCET_SEED_TEXT } from "./constants";

export interface KeyPair {
  /** Semilla privada de 32 bytes (hex). Nunca sale del dispositivo. */
  secret: string;
  /** Clave pública ed25519 (hex). */
  publicKey: string;
  /** Dirección legible: "vel" + base58(clave pública). */
  address: string;
}

const PREFIX = "vel";

export function addressFromPublicKey(pub: Uint8Array): string {
  return PREFIX + b58(pub);
}

export function publicKeyFromAddress(address: string): Uint8Array {
  if (!isAddress(address)) throw new Error("Dirección no válida");
  return unb58(address.slice(PREFIX.length));
}

export function isAddress(address: string): boolean {
  if (typeof address !== "string" || !address.startsWith(PREFIX) || address.startsWith("vel_")) return false;
  try {
    return unb58(address.slice(PREFIX.length)).length === 32;
  } catch {
    return false;
  }
}

export function keyPairFromSecret(secretHex: string): KeyPair {
  const secret = hexToBytes(secretHex);
  const pub = ed25519.getPublicKey(secret);
  return { secret: secretHex, publicKey: bytesToHex(pub), address: addressFromPublicKey(pub) };
}

export function generateKeyPair(): KeyPair {
  return keyPairFromSecret(bytesToHex(randomBytes(32)));
}

/** Clave determinista a partir de un texto (solo para el grifo de pruebas y tests). */
export function keyPairFromText(text: string): KeyPair {
  return keyPairFromSecret(bytesToHex(sha256(utf8ToBytes(text))));
}

export const faucetKeyPair = () => keyPairFromText(FAUCET_SEED_TEXT);

export function sign(secretHex: string, message: Uint8Array | string): string {
  const msg = typeof message === "string" ? utf8ToBytes(message) : message;
  return bytesToHex(ed25519.sign(msg, hexToBytes(secretHex)));
}

// ---------- Verificación de firmas: enchufable y con caché ----------
/** Verifica ed25519 (firma 64 B, mensaje, clave pública 32 B). Debe ser RFC 8032 estricto. */
export type Ed25519Verifier = (sig: Uint8Array, msg: Uint8Array, pub: Uint8Array) => boolean;

/**
 * Por defecto: noble en modo estricto (zip215: false), igual que OpenSSL/WebCrypto. Así un nodo con
 * verificación nativa y uno con noble (móvil, Worker) aceptan exactamente las mismas firmas.
 */
export const nobleVerifier: Ed25519Verifier = (sig, msg, pub) => ed25519.verify(sig, msg, pub, { zip215: false });
let verifier: Ed25519Verifier = nobleVerifier;

/** Cambia el verificador (p. ej. el nativo de node:crypto en el nodo Bun, ~40× más rápido). Vacía la caché. */
export function setVerifier(fn: Ed25519Verifier | null) {
  verifier = fn ?? nobleVerifier;
  verifyCache.clear();
}

/** Caché de resultados: la firma vista al admitir una tx en la cola no se vuelve a verificar en el bloque. */
const VERIFY_CACHE_MAX = 100_000;
const verifyCache = new Map<string, boolean>();
const pubCache = new Map<string, Uint8Array>();

export const verifyCacheStats = () => ({ size: verifyCache.size, max: VERIFY_CACHE_MAX });

export function verify(address: string, message: Uint8Array | string, sigHex: string): boolean {
  try {
    const msg = typeof message === "string" ? utf8ToBytes(message) : message;
    // La clave de la caché ata firma, clave y mensaje (sha256): una firma válida no vale para otro mensaje.
    const key = `${sigHex}|${address}|${bytesToHex(sha256(msg))}`;
    const hit = verifyCache.get(key);
    if (hit !== undefined) return hit;
    let pub = pubCache.get(address);
    if (!pub) {
      pub = publicKeyFromAddress(address);
      if (pubCache.size > VERIFY_CACHE_MAX) pubCache.clear();
      pubCache.set(address, pub);
    }
    const ok = sigHex.length === 128 && verifier(hexToBytes(sigHex), msg, pub);
    if (verifyCache.size >= VERIFY_CACHE_MAX) verifyCache.delete(verifyCache.keys().next().value!);
    verifyCache.set(key, ok);
    return ok;
  } catch {
    return false;
  }
}

/** Firma un objeto (JSON canónico) sin el campo `sig`. */
export function signObj<T extends object>(secretHex: string, obj: T): T & { sig: string } {
  const { sig: _drop, ...rest } = obj as T & { sig?: string };
  return { ...(rest as T), sig: sign(secretHex, canonical(rest)) };
}

export function verifyObj(address: string, obj: { sig: string }): boolean {
  const { sig, ...rest } = obj;
  return verify(address, canonical(rest), sig);
}

// --- Cifrado: conversión a x25519 ---
export const encryptionPublicKey = (address: string) => ed25519.utils.toMontgomery(publicKeyFromAddress(address));
export const encryptionSecret = (secretHex: string) => ed25519.utils.toMontgomerySecret(hexToBytes(secretHex));
export const ecdh = (secret: Uint8Array, pub: Uint8Array) => x25519.getSharedSecret(secret, pub);
export const x25519Keygen = () => {
  const s = randomBytes(32);
  return { secret: s, publicKey: x25519.getPublicKey(s) };
};

/** Huella corta para comparar en persona (como el "número de seguridad" de Signal). */
export function safetyNumber(a: string, b: string): string {
  const [x, y] = [a, b].sort();
  const h = bytesToHex(sha256(utf8ToBytes(x + "|" + y)));
  return (h.match(/.{5}/g) ?? []).slice(0, 6).map((c) => (parseInt(c, 16) % 100000).toString().padStart(5, "0")).join(" ");
}

export const shortAddress = (a: string) => (a.length > 14 ? `${a.slice(0, 7)}…${a.slice(-5)}` : a);
