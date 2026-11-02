// Búsqueda de teléfonos sin enseñar los números a la puerta («PSI ligero», fuera de consenso).
//
// OPRF de RFC 9497 sobre ristretto255 (noble): la app «ciega» cada número (E.164) y la puerta lo evalúa con su
// clave secreta sin verlo. Con el resultado, la app saca dos huellas que solo puede calcular quien tenga el
// número Y pase por la puerta (que limita cuántos se evalúan):
//   · tag   (8 B): corta; la puerta da todas las del «cubo» del número para que la app vea si está.
//   · claim (32 B): larga; la app la presenta para recibir la tarjeta de contacto (solo si coincide).
// Lo que la puerta ve de cada número: un punto aleatorio (nada) y un prefijo de 12 bits de sha256(número):
// cada prefijo lo comparten ~1/4096 de todos los números posibles (k-anonimato). De los que SÍ coinciden,
// la puerta sabe qué tarjetas se pidieron (igual que antes).
// Rotación: cada clave tiene un `kid`. La puerta evalúa con todas las activas y la app prueba con todas.
import { ristretto255_oprf } from "@noble/curves/ed25519.js";
import { bytesToHex, hexToBytes, sha256, utf8ToBytes } from "./bytes";

export const PHONE_PSI_PREFIX_BITS = 12;
export const PHONE_PSI_MAX_PER_REQUEST = 50;
const oprf = ristretto255_oprf.oprf;
const PREFIX_TAG = "velum/phone/prefix|";
const KEY_INFO = "velum/phone/oprf|";

const enc = (e164: string) => utf8ToBytes(e164);
const hashed = (label: string, out: Uint8Array) => sha256(new Uint8Array([...utf8ToBytes(label), ...out]));

/** Prefijo público del número (lo único que la puerta aprende de él). */
export function phonePrefix(e164: string): number {
  const h = sha256(utf8ToBytes(PREFIX_TAG + e164));
  return ((h[0]! << 8) | h[1]!) >> (16 - PHONE_PSI_PREFIX_BITS);
}

export interface PhoneTokens {
  prefix: number;
  /** 8 B en hex: aparece en los cubos. */
  tag: string;
  /** 32 B en hex: se presenta para pedir la tarjeta. */
  claim: string;
}

function tokensFrom(e164: string, out: Uint8Array): PhoneTokens {
  return { prefix: phonePrefix(e164), tag: bytesToHex(hashed("tag|", out)).slice(0, 16), claim: bytesToHex(hashed("claim|", out)) };
}

// ---------- App ----------
export interface PhoneBlind {
  phone: string;
  prefix: number;
  /** Escalar secreto: no sale del teléfono. */
  blind: Uint8Array;
  /** Punto cegado (hex) que va a la puerta. */
  blinded: string;
}

export function phoneBlind(e164: string): PhoneBlind {
  const b = oprf.blind(enc(e164));
  return { phone: e164, prefix: phonePrefix(e164), blind: b.blind, blinded: bytesToHex(b.blinded) };
}

/** Con la evaluación de la puerta, las huellas del número (lanza si el punto no es válido). */
export function phoneFinalize(b: PhoneBlind, evaluatedHex: string): PhoneTokens {
  return tokensFrom(b.phone, oprf.finalize(enc(b.phone), b.blind, hexToBytes(evaluatedHex)));
}

// ---------- Puerta ----------
/** Clave secreta de un `kid` a partir de una semilla del servidor (≥ 32 B). */
export function phoneOprfKey(seed: Uint8Array, kid: string): Uint8Array {
  return oprf.deriveKeyPair(seed, utf8ToBytes(KEY_INFO + kid)).secretKey;
}

/** Evalúa un punto cegado (lanza si no es un punto válido). */
export function phoneEvaluate(secretKey: Uint8Array, blindedHex: string): string {
  if (typeof blindedHex !== "string" || !/^[0-9a-f]{64}$/.test(blindedHex)) throw new Error("Punto no válido");
  return bytesToHex(oprf.blindEvaluate(secretKey, hexToBytes(blindedHex)));
}

/** Huellas de un número conocido (alta, o búsqueda antigua en claro mientras dure la transición). */
export function phoneServerTokens(secretKey: Uint8Array, e164: string): PhoneTokens {
  // Igual que `evaluate` de RFC 9497 (cegar, evaluar y quitar el cegado da la misma salida).
  const b = oprf.blind(enc(e164));
  return tokensFrom(e164, oprf.finalize(enc(e164), b.blind, oprf.blindEvaluate(secretKey, b.blinded)));
}

// ---------- Respuesta de `/api/phone/lookup2` ----------
export interface PhoneLookup2Response {
  v: 1;
  keys: { kid: string; e: string[]; buckets: Record<string, string[]> }[];
}

/**
 * Del lado de la app: con los números cegados (mismo orden que la consulta) y la respuesta de la puerta,
 * los que están en el directorio y la huella larga para pedir su tarjeta (`/api/phone/match`).
 */
export function phonePsiCandidates(blinds: PhoneBlind[], res: PhoneLookup2Response): { phone: string; kid: string; claim: string }[] {
  const out: { phone: string; kid: string; claim: string }[] = [];
  const seen = new Set<string>();
  for (const k of res?.keys ?? []) {
    if (!k || !Array.isArray(k.e) || k.e.length !== blinds.length) continue;
    blinds.forEach((b, i) => {
      if (seen.has(b.phone)) return;
      let t: PhoneTokens;
      try { t = phoneFinalize(b, k.e[i]!); } catch { return; }
      if ((k.buckets?.[String(b.prefix)] ?? []).includes(t.tag)) {
        seen.add(b.phone);
        out.push({ phone: b.phone, kid: k.kid, claim: t.claim });
      }
    });
  }
  return out;
}
