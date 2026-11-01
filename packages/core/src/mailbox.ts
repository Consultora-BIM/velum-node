// Buzones que rotan cada día (docs/protocolo-v2.md §5).
//
// Cada dispositivo tiene:
//  - `mailboxSeed` (lo conocen sus contactos): con él calculan el buzón del día.
//  - una clave de apertura secreta (escalar `s`, pública `mbPub = s·G`, también en la DeviceList).
// El emisor pone en cada trozo `mbAuth = mbPub + t·G` con `t = H(mbPub ‖ buzón)`: una clave pública
// distinta cada día que los nodos no pueden relacionar entre días. Para abrir, el dueño firma con
// `s + t` (firma ed25519 estándar), así que solo él recoge — ni siquiera sus contactos — y el nodo
// verifica con `ed25519.verify` sin aprender quién es.
import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, concatBytes, hashHex, hexToBytes, randomBytes, utf8ToBytes } from "./bytes";
import { CLOCK_SKEW_MS, DAY_MS, INFO } from "./msgconst";

const L = ed25519.Point.Fn.ORDER;
const G = ed25519.Point.BASE;

const leToBig = (b: Uint8Array) => {
  let n = 0n;
  for (let i = b.length - 1; i >= 0; i--) n = (n << 8n) | BigInt(b[i]!);
  return n;
};
const bigToLe32 = (n: bigint) => {
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) { out[i] = Number(n & 0xffn); n >>= 8n; }
  return out;
};
const modL = (b: Uint8Array) => leToBig(b) % L;

export const dayOf = (ts: number) => Math.floor(ts / DAY_MS);

/** Buzón del día: hex(HMAC-SHA512(mailboxSeed, "day:" + día))[0..40]. */
export function mailboxFor(mailboxSeedHex: string, day: number): string {
  return bytesToHex(hmac(sha512, hexToBytes(mailboxSeedHex), utf8ToBytes("day:" + day))).slice(0, 40);
}

/** Secretos de buzón de un dispositivo. Nunca salen de él (salvo `seed` y `pub`, que van en la DeviceList). */
export interface DeviceMailbox {
  /** Semilla de direcciones (hex 32 B). Se comparte con los contactos. */
  seed: string;
  /** Clave pública de apertura (hex 32 B). Se comparte con los contactos. */
  pub: string;
  /** Escalar secreto de apertura (hex LE 32 B). */
  scalar: string;
  /** Clave para nonces deterministas de firma (hex 32 B). */
  nonceKey: string;
}

/**
 * Deriva los secretos de buzón de un dispositivo: HKDF(mailboxBase, salt = sal del dispositivo, "velum/v2/mailbox/<id>").
 * La sal es aleatoria y vive solo en el dispositivo: cambiarla rota el buzón (expulsar un dispositivo).
 */
export function deviceMailbox(mailboxBaseHex: string, deviceId: string, saltHex: string): DeviceMailbox {
  const okm = hkdf(sha512, hexToBytes(mailboxBaseHex), hexToBytes(saltHex), utf8ToBytes(`${INFO.mailbox}/${deviceId}`), 128);
  const seed = okm.slice(0, 32);
  let s = modL(okm.slice(32, 96));
  if (s === 0n) s = 1n;
  return { seed: bytesToHex(seed), pub: bytesToHex(G.multiply(s).toBytes()), scalar: bytesToHex(bigToLe32(s)), nonceKey: bytesToHex(okm.slice(96, 128)) };
}

const tweak = (pubHex: string, mailbox: string) => {
  const t = modL(sha512(concatBytes(utf8ToBytes("velum/v2/mbauth|"), hexToBytes(pubHex), utf8ToBytes(mailbox))));
  return t === 0n ? 1n : t;
};

/** Lo que el emisor pone en cada trozo: clave pública de apertura de ese buzón (hex 32 B). */
export function mbAuthFor(mbPubHex: string, mailbox: string): string {
  return bytesToHex(ed25519.Point.fromBytes(hexToBytes(mbPubHex)).add(G.multiply(tweak(mbPubHex, mailbox))).toBytes());
}

/** Mensaje que se firma para abrir un buzón. */
export const openChallenge = (mailbox: string, ts: number) => `velum/v2/open|${mailbox}|${ts}`;

/** Prueba de apertura: `{ mailbox, auth, ts, sig }`. El nodo comprueba `ed25519.verify(sig, reto, auth)`. */
export interface MailboxOpen {
  mailbox: string;
  /** = mbAuth de los trozos de ese buzón. */
  auth: string;
  ts: number;
  sig: string;
}

/** Firma ed25519 (RFC 8032) con un escalar arbitrario: verificable con `ed25519.verify`. */
function signWithScalar(a: bigint, A: Uint8Array, nonceKey: Uint8Array, msg: Uint8Array): Uint8Array {
  let r = modL(sha512(concatBytes(nonceKey, A, msg)));
  if (r === 0n) r = 1n;
  const R = G.multiply(r).toBytes();
  const k = modL(sha512(concatBytes(R, A, msg)));
  const S = (r + k * a) % L;
  return concatBytes(R, bigToLe32(S));
}

export function openProof(mb: DeviceMailbox, mailbox: string, ts = Date.now()): MailboxOpen {
  const a = (leToBig(hexToBytes(mb.scalar)) + tweak(mb.pub, mailbox)) % L;
  const A = G.multiply(a).toBytes();
  const sig = signWithScalar(a, A, hexToBytes(mb.nonceKey), utf8ToBytes(openChallenge(mailbox, ts)));
  return { mailbox, auth: bytesToHex(A), ts, sig: bytesToHex(sig) };
}

/** Lo que hace el nodo antes de entregar trozos de `mailbox` con `mbAuth == auth`. */
export function verifyOpenProof(p: MailboxOpen, now = Date.now()): boolean {
  if (!p || typeof p.mailbox !== "string" || typeof p.auth !== "string" || typeof p.sig !== "string") return false;
  if (Math.abs(now - p.ts) > CLOCK_SKEW_MS) return false;
  try {
    return ed25519.verify(hexToBytes(p.sig), utf8ToBytes(openChallenge(p.mailbox, p.ts)), hexToBytes(p.auth));
  } catch {
    return false;
  }
}

/** Buzones a abrir: hoy y ayer (los rezagados del cambio de día). */
export function mailboxesToOpen(mb: DeviceMailbox, now = Date.now()): MailboxOpen[] {
  const d = dayOf(now);
  return [d, d - 1].map((day) => openProof(mb, mailboxFor(mb.seed, day), now));
}

/** Buzón del día en curso de un dispositivo destinatario + su mbAuth. */
export function mailboxTarget(dev: { mailboxSeed: string; mbPub: string }, now = Date.now()) {
  const mailbox = mailboxFor(dev.mailboxSeed, dayOf(now));
  return { mailbox, mbAuth: mbAuthFor(dev.mbPub, mailbox) };
}

/** Sal nueva para rotar el buzón. */
export const newMailboxSalt = () => bytesToHex(randomBytes(16));

/** @deprecated v1: buzón fijo por dirección. Solo para pruebas antiguas de la cadena. */
export function mailboxOf(address: string): string {
  return hashHex("velum/mailbox/" + address).slice(0, 40);
}
