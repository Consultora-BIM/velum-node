// Identidad pública v3 (protocolo-v3 §7): tarjetas de contacto, enlaces, solicitudes de contacto e invitaciones.
//
//  · Tarjeta (`ContactCard`): clave de identidad + prellave de primer contacto (X25519 + ML-KEM) + buzón de
//    solicitudes. Firmada por la identidad. Va en el enlace `/c/<tarjeta>` (base58) y, si hay alias, en la cadena.
//    Sus claves salen de la identidad: cualquier dispositivo mío abre las solicitudes.
//  · Solicitud (`contact.request`): sellada a la prellave de la tarjeta, con mi lista de dispositivos firmada.
//  · Invitación: claves nuevas de un solo uso; el emisor deja mensajes cifrados en un buzón derivado durante 24 h.
//    El enlace lleva el secreto: quien lo abre (tras instalar Velum) recoge los mensajes y queda en contacto.
// Sin estado de cadena: las reglas de alias en la cadena viven en state.ts.
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { b58, b64, bytesToHex, bytesToUtf8, canonical, concatBytes, hexToBytes, randomBytes, unb58, unb64, utf8ToBytes } from "./bytes";
import { addressFromPublicKey, publicKeyFromAddress, sign, verify, type KeyPair } from "./keys";
import { hybridKeygen, hybridOpen, hybridSeal, HYBRID_OVERHEAD, KEM_PUB_BYTES } from "./pq";
import { deviceMailbox, mailboxTarget, type DeviceMailbox } from "./mailbox";
import { verifyDeviceList, type DeviceEntry, type DeviceKeys, type DeviceList } from "./devices";
import { padToBucket, unpad } from "./shards";
import { PUBLIC_ORIGIN } from "./constants";

export const DEFAULT_LINK_DOMAIN = new URL(PUBLIC_ORIGIN).host;
/** Las invitaciones y sus mensajes pendientes caducan a las 24 h. */
export const INVITE_TTL_MS = 24 * 3600 * 1000;
const CARD_VERSION = 3;
const ZERO_SALT = "00".repeat(16);

/** Tarjeta de contacto pública (seudónima: no dice quién eres). */
export interface ContactCard {
  v: 3;
  /** Dirección de identidad. */
  identity: string;
  /** Prellave de primer contacto: X25519 (hex) y ML-KEM-768 (base64). */
  x25519: string;
  kem: string;
  /** Buzón de solicitudes (como un dispositivo): semilla y clave de apertura (hex). */
  mailboxSeed: string;
  mbPub: string;
  ts: number;
  /** Firma de la identidad (hex). */
  sig: string;
}

/** Claves privadas de la tarjeta (derivadas de la identidad). */
export interface CardKeys {
  card: ContactCard;
  device: DeviceKeys;
  mailbox: DeviceMailbox;
}

// ---------- Codificación binaria (enlace corto) ----------
// [1 ver][32 identidad][32 x25519][1184 kem][32 semilla buzón][32 mbPub][8 ts][64 firma]
const BODY_BYTES = 1 + 32 + 32 + KEM_PUB_BYTES + 32 + 32 + 8;

function u64(n: number) {
  const b = new Uint8Array(8);
  new DataView(b.buffer).setBigUint64(0, BigInt(n));
  return b;
}

function cardBody(c: Omit<ContactCard, "sig">): Uint8Array {
  return concatBytes(
    new Uint8Array([CARD_VERSION]), publicKeyFromAddress(c.identity), hexToBytes(c.x25519), unb64(c.kem),
    hexToBytes(c.mailboxSeed), hexToBytes(c.mbPub), u64(c.ts),
  );
}
const cardMsg = (body: Uint8Array) => concatBytes(utf8ToBytes("velum/v3/card|"), body);

/** Tarjeta → texto base58 (para `/c/<tarjeta>` y para `name.register`). */
export function encodeCard(c: ContactCard): string {
  return b58(concatBytes(cardBody(c), hexToBytes(c.sig)));
}

/** Texto base58 → tarjeta (comprueba formato y firma; lanza si no vale). */
export function decodeCard(text: string): ContactCard {
  let raw: Uint8Array;
  try { raw = unb58(text.trim()); } catch { throw new Error("Tarjeta no válida"); }
  if (raw.length !== BODY_BYTES + 64 || raw[0] !== CARD_VERSION) throw new Error("Tarjeta no válida");
  let o = 1;
  const take = (n: number) => raw.subarray(o, (o += n));
  const identity = addressFromPublicKey(take(32));
  const x25519 = bytesToHex(take(32));
  const kem = b64(take(KEM_PUB_BYTES));
  const mailboxSeed = bytesToHex(take(32));
  const mbPub = bytesToHex(take(32));
  const ts = Number(new DataView(raw.buffer, raw.byteOffset + o, 8).getBigUint64(0));
  o += 8;
  const sig = bytesToHex(take(64));
  const card: ContactCard = { v: 3, identity, x25519, kem, mailboxSeed, mbPub, ts, sig };
  if (!verifyCard(card)) throw new Error("Firma de la tarjeta no válida");
  return card;
}

export function verifyCard(c: ContactCard): boolean {
  try {
    const { sig, ...rest } = c;
    return c.v === 3 && Number.isSafeInteger(c.ts) && c.ts >= 0 && verify(c.identity, cardMsg(cardBody(rest)), sig);
  } catch {
    return false;
  }
}

/** Para `checkTx`: null si el texto es una tarjeta válida. */
export function cardProblem(text: string): string | null {
  try { decodeCard(text); return null; } catch (e) { return (e as Error).message; }
}

// ---------- Claves de la tarjeta ----------
/**
 * Claves de mi tarjeta: salen de la identidad (y de `mailboxBase` para el buzón), así que cualquier dispositivo
 * con la identidad las recalcula. `rotation` cambia la prellave (renovar alias con tarjeta nueva).
 */
export function cardKeys(identity: KeyPair, mailboxBase: string, rotation = 0, ts = 0): CardKeys {
  const seed = hkdf(sha512, hexToBytes(identity.secret), utf8ToBytes("velum/v3/card"), utf8ToBytes(`velum/v3/card/${rotation}`), 96);
  const k = hybridKeygen(seed);
  const mailbox = deviceMailbox(mailboxBase, `requests-${rotation}`, ZERO_SALT);
  const body = {
    v: 3 as const, identity: identity.address, x25519: bytesToHex(k.publicKey.x25519), kem: b64(k.publicKey.kem),
    mailboxSeed: mailbox.seed, mbPub: mailbox.pub, ts,
  };
  const card: ContactCard = { ...body, sig: sign(identity.secret, cardMsg(cardBody(body))) };
  return { card, mailbox, device: pseudoDevice(`card-${rotation}`, k, ts) };
}

/** Claves de dispositivo «de mentira» con una sola prellave: así `openMessage` abre lo sellado a ella. */
function pseudoDevice(id: string, k: ReturnType<typeof hybridKeygen>, ts: number): DeviceKeys {
  return {
    id, name: id, created: ts, signSecret: "00".repeat(32), signPub: "", mailboxSalt: ZERO_SALT,
    prekeys: [{ id, x25519: bytesToHex(k.publicKey.x25519), kem: b64(k.publicKey.kem), x25519Secret: bytesToHex(k.secretKey.x25519), kemSecret: b64(k.secretKey.kem), created: ts }],
  };
}

/** Entrada de dispositivo equivalente (para sellar con `sealMessage` hacia una tarjeta o invitación). */
function pseudoEntry(id: string, x25519: string, kem: string, mailboxSeed: string, mbPub: string, added: number): DeviceEntry {
  return { id, name: id, sign: "", x25519, kem, pk: id, mailboxSeed, mbPub, added };
}

// ---------- Enlaces ----------
export const aliasLink = (name: string, domain = DEFAULT_LINK_DOMAIN) => `https://${domain}/@${name}`;
export const cardLink = (card: ContactCard, domain = DEFAULT_LINK_DOMAIN) => `https://${domain}/c/${encodeCard(card)}`;
export const inviteLink = (secret: string, domain = DEFAULT_LINK_DOMAIN) => `https://${domain}/i/${b58(hexToBytes(secret))}`;

export type VelumLink =
  | { kind: "alias"; name: string }
  | { kind: "card"; card: ContactCard }
  | { kind: "invite"; secret: string };

/** Entiende `https://<dominio>/@alias`, `/c/<tarjeta>` e `/i/<invitación>` (y `velum://` con la misma ruta). */
export function parseVelumLink(url: string): VelumLink {
  const m = url.trim().match(/^(?:https?:\/\/[^/]+|velum:\/\/)\/?(@|c\/|i\/)([^?#/]+)/);
  if (!m) throw new Error("Enlace de Velum no válido");
  const [, kind, rest] = m as unknown as [string, string, string];
  if (kind === "@") {
    const name = decodeURIComponent(rest).toLowerCase();
    if (!/^[a-z0-9_.]{3,24}$/.test(name)) throw new Error("Alias no válido");
    return { kind: "alias", name };
  }
  if (kind === "c/") return { kind: "card", card: decodeCard(rest) };
  let secret: Uint8Array;
  try { secret = unb58(rest); } catch { throw new Error("Invitación no válida"); }
  if (secret.length !== 32) throw new Error("Invitación no válida");
  return { kind: "invite", secret: bytesToHex(secret) };
}

// ---------- Solicitud de contacto ----------
export interface ContactRequest {
  t: "contact.request";
  /** Identidad de quien pide. */
  from: string;
  /** Su lista de dispositivos (firmada): con ella ya se le puede escribir. */
  list: DeviceList;
  note?: string;
  /** Identidad de la tarjeta a la que va (evita reenviarla a otro). */
  to: string;
  ts: number;
  /** Semilla de recibos de los trozos (para pagar a los nodos). */
  rseed: string;
  sig: string;
}

const requestInfo = "velum/v3/request";

/**
 * Sella una solicitud para la tarjeta. Devuelve el sobre (tamaño de cubo), su semilla de recibos y el buzón de
 * destino: el cliente lo trocea con `splitIntoShards(bytes, { ...target, rseed })`.
 */
export function sealContactRequest(from: { identity: KeyPair; deviceList: DeviceList }, card: ContactCard, note?: string, now = Date.now()) {
  if (!verifyCard(card)) throw new Error("Tarjeta no válida");
  const rseed = bytesToHex(randomBytes(32));
  const body = { t: "contact.request" as const, from: from.identity.address, list: from.deviceList, to: card.identity, ts: now, rseed, ...(note ? { note: note.slice(0, 280) } : {}) };
  const req: ContactRequest = { ...body, sig: sign(from.identity.secret, canonical(body)) };
  const plain = padToBucket(utf8ToBytes(JSON.stringify(req)), HYBRID_OVERHEAD);
  const bytes = hybridSeal({ x25519: hexToBytes(card.x25519), kem: unb64(card.kem) }, plain, requestInfo);
  return { bytes, rseed, target: mailboxTarget(card, now) };
}

/** Abre una solicitud con las claves de mi tarjeta. Lanza si no es para mí o no está firmada. */
export function openContactRequest(keys: CardKeys, bytes: Uint8Array): ContactRequest {
  const pk = keys.device.prekeys[0]!;
  const plain = hybridOpen({ x25519: hexToBytes(pk.x25519Secret), kem: unb64(pk.kemSecret) }, bytes, requestInfo);
  const req = JSON.parse(bytesToUtf8(unpad(plain))) as ContactRequest;
  const { sig, ...rest } = req;
  if (req.t !== "contact.request" || req.to !== keys.card.identity) throw new Error("La solicitud no es para esta tarjeta");
  if (!verify(req.from, canonical(rest), sig)) throw new Error("Firma de la solicitud no válida");
  if (!verifyDeviceList(req.list, req.from)) throw new Error("Lista de dispositivos de la solicitud no válida");
  return req;
}

// ---------- Invitaciones de un solo uso ----------
export interface Invite {
  /** Secreto (hex 32 B): va en el enlace y no en ningún otro sitio. */
  secret: string;
  /** Entrada a la que sellar los mensajes pendientes (`sealMessage`). */
  entry: DeviceEntry;
  /** Claves para abrirlos (las usa quien canjea). */
  device: DeviceKeys;
  mailbox: DeviceMailbox;
  link: string;
}

/** Deriva todo lo de una invitación a partir de su secreto (lo hacen el emisor y quien la canjea). */
export function inviteFromSecret(secret: string, domain = DEFAULT_LINK_DOMAIN): Invite {
  const s = hexToBytes(secret);
  if (s.length !== 32) throw new Error("Invitación no válida");
  const okm = hkdf(sha512, s, utf8ToBytes("velum/v3/invite"), utf8ToBytes("velum/v3/invite/keys"), 128);
  const k = hybridKeygen(okm.slice(0, 96));
  const mailbox = deviceMailbox(bytesToHex(okm.slice(96, 128)), "invite", ZERO_SALT);
  const entry = pseudoEntry("invite", bytesToHex(k.publicKey.x25519), b64(k.publicKey.kem), mailbox.seed, mailbox.pub, 0);
  return { secret, entry, device: pseudoDevice("invite", k, 0), mailbox, link: inviteLink(secret, domain) };
}

/** Invitación nueva (claves nuevas). */
export const createInvite = (domain = DEFAULT_LINK_DOMAIN) => inviteFromSecret(bytesToHex(randomBytes(32)), domain);

/** Entrada para sellar a una tarjeta con el formato normal de sobre (no se usa en solicitudes, que van aparte). */
export const cardEntry = (c: ContactCard) => pseudoEntry("card", c.x25519, c.kem, c.mailboxSeed, c.mbPub, c.ts);
