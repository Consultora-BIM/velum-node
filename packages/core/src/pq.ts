// Cifrado híbrido X25519 + ML-KEM-768 (docs/protocolo-v2.md §2).
// La clave sale de los DOS secretos: para romperlo hay que romper la curva Y el retículo.
import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { concatBytes, randomBytes, utf8ToBytes } from "./bytes";
import { ENVELOPE_VERSION, INFO } from "./msgconst";

export const X25519_BYTES = 32;
export const KEM_PUB_BYTES = 1184;
export const KEM_SECRET_BYTES = 2400;
export const KEM_CT_BYTES = 1088;
export const NONCE_BYTES = 24;
export const TAG_BYTES = 16;
/** Cabecera híbrida: [1 versión][32 eph][1088 kemCt]. */
export const HYBRID_HEADER_BYTES = 1 + X25519_BYTES + KEM_CT_BYTES;
/** Sobrecoste de `hybridSeal`: cabecera + nonce + etiqueta. */
export const HYBRID_OVERHEAD = HYBRID_HEADER_BYTES + NONCE_BYTES + TAG_BYTES;

export interface HybridPublic {
  x25519: Uint8Array;
  kem: Uint8Array;
}
export interface HybridSecret {
  x25519: Uint8Array;
  kem: Uint8Array;
}
export interface HybridKeyPair {
  publicKey: HybridPublic;
  secretKey: HybridSecret;
}

/** Par híbrido nuevo (o determinista a partir de 96 bytes: 32 X25519 + 64 ML-KEM). */
export function hybridKeygen(seed?: Uint8Array): HybridKeyPair {
  const xs = seed ? seed.slice(0, 32) : randomBytes(32);
  const k = ml_kem768.keygen(seed ? seed.slice(32, 96) : randomBytes(64));
  return {
    publicKey: { x25519: x25519.getPublicKey(xs), kem: k.publicKey },
    secretKey: { x25519: xs, kem: k.secretKey },
  };
}

function kdf(dh: Uint8Array, kemSs: Uint8Array, ephPub: Uint8Array, kemCt: Uint8Array, info: string): Uint8Array {
  return hkdf(sha512, concatBytes(dh, kemSs), concatBytes(ephPub, kemCt), utf8ToBytes(info), 32);
}

/** Encapsula una clave para `pub`. Devuelve la cabecera [ver][eph][kemCt] y la clave de 32 B. */
export function hybridEncap(pub: HybridPublic, info: string = INFO.envelope, version = ENVELOPE_VERSION) {
  const ephS = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephS);
  const dh = x25519.getSharedSecret(ephS, pub.x25519);
  const { cipherText, sharedSecret } = ml_kem768.encapsulate(pub.kem);
  const key = kdf(dh, sharedSecret, ephPub, cipherText, info);
  const header = concatBytes(new Uint8Array([version]), ephPub, cipherText);
  return { header, key };
}

/** Recupera la clave de una cabecera híbrida. Con la clave equivocada sale otra clave (el AEAD fallará después). */
export function hybridDecap(sec: HybridSecret, header: Uint8Array, info: string = INFO.envelope): Uint8Array {
  if (header.length < HYBRID_HEADER_BYTES) throw new Error("Cabecera híbrida corta");
  const ephPub = header.subarray(1, 1 + X25519_BYTES);
  const kemCt = header.subarray(1 + X25519_BYTES, HYBRID_HEADER_BYTES);
  const dh = x25519.getSharedSecret(sec.x25519, ephPub);
  const ss = ml_kem768.decapsulate(kemCt, sec.kem);
  return kdf(dh, ss, ephPub, kemCt, info);
}

/** Formato exacto §2: [1 versión][32 eph][1088 kemCt][24 nonce][ct]. */
export function hybridSeal(pub: HybridPublic, plain: Uint8Array, info: string = INFO.envelope, version = ENVELOPE_VERSION): Uint8Array {
  const { header, key } = hybridEncap(pub, info, version);
  const nonce = randomBytes(NONCE_BYTES);
  return concatBytes(header, nonce, xchacha20poly1305(key, nonce, header).encrypt(plain));
}

/** Abre un sobre híbrido. Lanza si no es para esta clave o si se ha manipulado (también la cabecera: va como AAD). */
export function hybridOpen(sec: HybridSecret, sealed: Uint8Array, info: string = INFO.envelope): Uint8Array {
  if (sealed.length < HYBRID_OVERHEAD) throw new Error("Sobre demasiado corto");
  const header = sealed.subarray(0, HYBRID_HEADER_BYTES);
  const key = hybridDecap(sec, header, info);
  const nonce = sealed.subarray(HYBRID_HEADER_BYTES, HYBRID_HEADER_BYTES + NONCE_BYTES);
  return xchacha20poly1305(key, nonce, header).decrypt(sealed.subarray(HYBRID_HEADER_BYTES + NONCE_BYTES));
}

/** Cifrado simétrico [24 nonce][ct] con AAD opcional. */
export function aeadSeal(key: Uint8Array, plain: Uint8Array, aad?: Uint8Array): Uint8Array {
  const nonce = randomBytes(NONCE_BYTES);
  return concatBytes(nonce, xchacha20poly1305(key, nonce, aad).encrypt(plain));
}
export function aeadOpen(key: Uint8Array, data: Uint8Array, aad?: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, data.subarray(0, NONCE_BYTES), aad).decrypt(data.subarray(NONCE_BYTES));
}
