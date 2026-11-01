// Verificación ed25519 nativa para el nodo Bun (OpenSSL vía node:crypto, síncrona). noble tarda ~2 ms por
// firma; la nativa, decenas de µs: un bloque con 10.000 reclamaciones se valida en < 1 s.
// WebCrypto (`crypto.subtle.verify("Ed25519")`) también es nativa pero asíncrona y la máquina de estados es
// síncrona, así que se usa node:crypto. Ambas son RFC 8032 estrictas, igual que noble con zip215: false.
import { createPublicKey, verify as nodeVerify, type KeyObject } from "node:crypto";
import { setVerifier, type Ed25519Verifier } from "@velum/core";

const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");
const keys = new Map<string, KeyObject>();

export const nativeVerifier: Ed25519Verifier = (sig, msg, pub) => {
  if (sig.length !== 64 || pub.length !== 32) return false;
  const id = Buffer.from(pub).toString("hex");
  let k = keys.get(id);
  if (!k) {
    k = createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pub]), format: "der", type: "spki" });
    if (keys.size > 100_000) keys.clear();
    keys.set(id, k);
  }
  try {
    return nodeVerify(null, msg, k, sig);
  } catch {
    return false;
  }
};

/** Activa la verificación nativa en el núcleo (llámalo al arrancar el nodo). */
export function useNativeVerifier() {
  setVerifier(nativeVerifier);
}
