// Dispositivos (docs/protocolo-v2.md §1): cada uno con sus claves, que nunca salen de él.
// La identidad firma la lista de dispositivos; los contactos la reciben dentro de mensajes `profile`.
import { ed25519 } from "@noble/curves/ed25519.js";
import { b64, bytesToHex, canonical, hexToBytes, randomBytes, unb64, utf8ToBytes } from "./bytes";
import { signObj, verifyObj } from "./keys";
import { hybridKeygen, type HybridPublic, type HybridSecret } from "./pq";
import { deviceMailbox, newMailboxSalt, type DeviceMailbox } from "./mailbox";
import { MAX_DEVICES, PREKEY_RETAIN_MS, PREKEY_ROTATE_MS } from "./msgconst";

/** Prellave X25519 + ML-KEM-768. Rota cada 24 h; las viejas se guardan 7 días. */
export interface Prekey {
  id: string;
  x25519: string; // pública, hex
  kem: string; // pública, base64
  x25519Secret: string; // hex
  kemSecret: string; // base64
  created: number;
  /** Cuándo dejó de ser la actual (para borrarla a los 7 días). */
  retired?: number;
}

/** Claves privadas de ESTE dispositivo. La app las guarda en Keychain/Keystore (solo este dispositivo). */
export interface DeviceKeys {
  id: string;
  name: string;
  created: number;
  /** Clave de firma ed25519 (semilla hex 32 B). */
  signSecret: string;
  signPub: string;
  /** Prellaves: la primera es la actual. */
  prekeys: Prekey[];
  /** Sal aleatoria del buzón (rotarla = buzón nuevo). */
  mailboxSalt: string;
}

/** Entrada pública de un dispositivo en la DeviceList. */
export interface DeviceEntry {
  id: string;
  name: string;
  /** Clave pública de firma (hex). */
  sign: string;
  /** Prellave actual: X25519 (hex) y ML-KEM-768 (base64). */
  x25519: string;
  kem: string;
  /** Id de esa prellave. */
  pk: string;
  /** Semilla de direcciones de buzón (hex). */
  mailboxSeed: string;
  /** Clave pública de apertura de buzón (hex). */
  mbPub: string;
  added: number;
}

export interface DeviceList {
  v: 2;
  identity: string;
  devices: DeviceEntry[];
  /** Versión creciente: gana la lista con `seq` mayor. */
  seq: number;
  ts: number;
  sig: string;
}

/** Certificado: la identidad dice «este dispositivo es mío». Va dentro de cada sobre. */
export interface DeviceCert {
  identity: string;
  device: string;
  sign: string;
  ts: number;
  sig: string;
}

function newPrekey(now: number): Prekey {
  const k = hybridKeygen();
  return {
    id: bytesToHex(randomBytes(8)),
    x25519: bytesToHex(k.publicKey.x25519),
    kem: b64(k.publicKey.kem),
    x25519Secret: bytesToHex(k.secretKey.x25519),
    kemSecret: b64(k.secretKey.kem),
    created: now,
  };
}

/** Claves nuevas para este dispositivo. */
export function createDevice(name: string, now = Date.now()): DeviceKeys {
  const signSecret = randomBytes(32);
  return {
    id: bytesToHex(randomBytes(8)),
    name,
    created: now,
    signSecret: bytesToHex(signSecret),
    signPub: bytesToHex(ed25519.getPublicKey(signSecret)),
    prekeys: [newPrekey(now)],
    mailboxSalt: newMailboxSalt(),
  };
}

export const currentPrekey = (d: DeviceKeys) => d.prekeys[0]!;

export const prekeyPublic = (p: { x25519: string; kem: string }): HybridPublic => ({ x25519: hexToBytes(p.x25519), kem: unb64(p.kem) });
export const prekeySecret = (p: Prekey): HybridSecret => ({ x25519: hexToBytes(p.x25519Secret), kem: unb64(p.kemSecret) });

export const mailboxOfDevice = (d: DeviceKeys, mailboxBase: string): DeviceMailbox => deviceMailbox(mailboxBase, d.id, d.mailboxSalt);

/** Entrada pública para la DeviceList. */
export function deviceEntry(d: DeviceKeys, mailboxBase: string, added = d.created): DeviceEntry {
  const pk = currentPrekey(d);
  const mb = mailboxOfDevice(d, mailboxBase);
  return { id: d.id, name: d.name, sign: d.signPub, x25519: pk.x25519, kem: pk.kem, pk: pk.id, mailboxSeed: mb.seed, mbPub: mb.pub, added };
}

/**
 * Rota la prellave si la actual tiene más de 24 h y borra las retiradas hace más de 7 días.
 * Devuelve las claves nuevas (no muta) y si hubo rotación (entonces hay que reenviar el perfil).
 */
export function rotatePrekeys(d: DeviceKeys, now = Date.now()): { keys: DeviceKeys; rotated: boolean } {
  let prekeys = d.prekeys.slice();
  let rotated = false;
  if (now - prekeys[0]!.created >= PREKEY_ROTATE_MS) {
    prekeys = [newPrekey(now), { ...prekeys[0]!, retired: now }, ...prekeys.slice(1)];
    rotated = true;
  }
  prekeys = prekeys.filter((p, i) => i === 0 || now - (p.retired ?? now) < PREKEY_RETAIN_MS);
  return { keys: { ...d, prekeys }, rotated };
}

/** Rota la sal del buzón (tras expulsar un dispositivo). Hay que reenviar el perfil. */
export const rotateMailbox = (d: DeviceKeys): DeviceKeys => ({ ...d, mailboxSalt: newMailboxSalt() });

// ---------- Lista de dispositivos ----------
export function signDeviceList(identitySecret: string, identity: string, devices: DeviceEntry[], seq: number, ts = Date.now()): DeviceList {
  if (devices.length > MAX_DEVICES) throw new Error(`Máximo ${MAX_DEVICES} dispositivos`);
  return signObj(identitySecret, { v: 2 as const, identity, devices, seq, ts });
}

export function verifyDeviceList(list: DeviceList, identity?: string): boolean {
  if (!list || list.v !== 2 || !Array.isArray(list.devices)) return false;
  if (identity && list.identity !== identity) return false;
  if (list.devices.length === 0 || list.devices.length > MAX_DEVICES) return false;
  if (new Set(list.devices.map((d) => d.id)).size !== list.devices.length) return false;
  return verifyObj(list.identity, list);
}

/** ¿Sustituye `next` a `prev`? Solo si es válida, de la misma identidad y más nueva. */
export function isNewerDeviceList(prev: DeviceList | undefined, next: DeviceList): boolean {
  if (!verifyDeviceList(next, prev?.identity)) return false;
  return !prev || next.seq > prev.seq;
}

/** Añade (o actualiza) un dispositivo y firma la lista nueva. */
export function addDevice(identitySecret: string, list: DeviceList, entry: DeviceEntry, ts = Date.now()): DeviceList {
  const others = list.devices.filter((d) => d.id !== entry.id);
  if (others.length >= MAX_DEVICES) throw new Error(`Máximo ${MAX_DEVICES} dispositivos`);
  return signDeviceList(identitySecret, list.identity, [...others, entry], list.seq + 1, ts);
}

/** Expulsa un dispositivo. Los que quedan deben rotar su buzón (`rotateMailbox`) y volver a publicarse. */
export function removeDevice(identitySecret: string, list: DeviceList, deviceId: string, ts = Date.now()): DeviceList {
  const devices = list.devices.filter((d) => d.id !== deviceId);
  if (devices.length === list.devices.length) throw new Error("Ese dispositivo no está en la lista");
  return signDeviceList(identitySecret, list.identity, devices, list.seq + 1, ts);
}

// ---------- Certificado de dispositivo ----------
export function signDeviceCert(identitySecret: string, identity: string, d: { id: string; signPub: string }, ts = Date.now()): DeviceCert {
  return signObj(identitySecret, { identity, device: d.id, sign: d.signPub, ts });
}

export function verifyDeviceCert(c: DeviceCert): boolean {
  return !!c && typeof c.identity === "string" && verifyObj(c.identity, c);
}

// ---------- Firmas con la clave de dispositivo ----------
export function deviceSign(signSecretHex: string, obj: unknown): string {
  return bytesToHex(ed25519.sign(utf8ToBytes(canonical(obj)), hexToBytes(signSecretHex)));
}
export function deviceVerify(signPubHex: string, obj: unknown, sigHex: string): boolean {
  try {
    return ed25519.verify(hexToBytes(sigHex), utf8ToBytes(canonical(obj)), hexToBytes(signPubHex));
  } catch {
    return false;
  }
}
