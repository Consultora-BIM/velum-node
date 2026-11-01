// Sobre v2 (docs/protocolo-v2.md §2): híbrido X25519 + ML-KEM-768, remitente sellado y
// contenido cifrado UNA vez (la clave se sella para cada dispositivo). Todas las copias —1 a 1,
// grupo o sincronización con mis otros dispositivos— tienen el mismo formato y tamaño de cubo:
// fuera no se distingue un grupo de un chat.
//
// Formato: [1 versión=2][32 eph][1088 kemCt][24 nonce][80 envoltorio][24 nonce2][cuerpo cifrado]
//   envoltorio = AEAD(clave híbrida, clave del cuerpo 32 B ‖ rseed 32 B, AAD = cabecera)
//   cuerpo     = AEAD(clave del cuerpo, relleno([1 compresión][JSON { p, cert }]))  compresión: 0 nada, 1 deflate
import { b64, bytesToHex, bytesToUtf8, concatBytes, hashHex, randomBytes, utf8ToBytes } from "./bytes";
import { aeadOpen, aeadSeal, HYBRID_HEADER_BYTES, hybridDecap, hybridEncap, NONCE_BYTES, TAG_BYTES } from "./pq";
import { deviceSign, deviceVerify, prekeyPublic, prekeySecret, verifyDeviceCert, type DeviceCert, type DeviceEntry, type DeviceKeys, type DeviceList } from "./devices";
import { padToBucket, unpad } from "./shards";
import { ENVELOPE_VERSION, INFO } from "./msgconst";
import { deflateSync, inflateSync } from "fflate";

export type ContentKind =
  | "text" | "image" | "audio" | "file" | "receipt" | "group" | "payment" | "profile" | "typing" | "sync" | "security";

/** Lo que va dentro del sobre. Solo lo ve el destinatario. */
export interface Payload {
  v: 2;
  /** Id del mensaje (hex). */
  id: string;
  /** Identidad del remitente. */
  from: string;
  /** Dispositivo del remitente. */
  dev: string;
  /** Destino lógico: identidad del destinatario o id del grupo. Así mis otros dispositivos saben de qué chat es. */
  to: string;
  ts: number;
  kind: ContentKind;
  body?: string;
  /** Adjunto binario en base64. */
  blob?: string;
  mime?: string;
  group?: string;
  refs?: string[];
  status?: "delivered" | "read";
  meta?: Record<string, number | string>;
  replyTo?: string;
}

export interface SignedPayload extends Payload {
  /** Firma de la CLAVE DE DISPOSITIVO sobre el JSON canónico sin `sig`. */
  sig: string;
}

/** Quién envía: su clave de dispositivo y el certificado de su identidad. */
export interface Sender {
  device: DeviceKeys;
  cert: DeviceCert;
}

export interface SealedCopy {
  device: DeviceEntry;
  bytes: Uint8Array;
  /** Semilla de recibos de ESTA copia (cada copia tiene la suya). */
  rseed: string;
}

export interface Opened {
  payload: SignedPayload;
  cert: DeviceCert;
  rseed: string;
}

const WRAP_BYTES = 64 + TAG_BYTES;
/** Bytes fijos del sobre fuera del cuerpo en claro. */
export const ENVELOPE_OVERHEAD = HYBRID_HEADER_BYTES + NONCE_BYTES + WRAP_BYTES + NONCE_BYTES + TAG_BYTES;

export function newMessageId(): string {
  return hashHex(randomBytes(32)).slice(0, 32);
}

export function signPayload(deviceSignSecret: string, p: Payload): SignedPayload {
  return { ...p, sig: deviceSign(deviceSignSecret, p) };
}

/** Comprueba la firma del dispositivo y que el certificado de identidad lo respalda. */
export function verifyPayload(p: SignedPayload, cert: DeviceCert): boolean {
  if (!verifyDeviceCert(cert) || cert.identity !== p.from || cert.device !== p.dev) return false;
  const { sig, ...rest } = p;
  return deviceVerify(cert.sign, rest, sig);
}

/** Cifra el cuerpo una vez. Devuelve la clave y el cuerpo [24 nonce][ct]. */
/** Hasta este tamaño se intenta comprimir (los textos caben así en el cubo de 2 KB; los adjuntos ya van comprimidos). */
const COMPRESS_MAX = 64 * 1024;

function packInner(json: Uint8Array): Uint8Array {
  if (json.length <= COMPRESS_MAX) {
    const z = deflateSync(json, { level: 9 });
    if (z.length < json.length) return concatBytes(new Uint8Array([1]), z);
  }
  return concatBytes(new Uint8Array([0]), json);
}

function unpackInner(b: Uint8Array): Uint8Array {
  if (b[0] === 0) return b.subarray(1);
  if (b[0] === 1) return inflateSync(b.subarray(1));
  throw new Error("Compresión desconocida");
}

function sealBody(signed: SignedPayload, cert: DeviceCert) {
  const plain = padToBucket(packInner(utf8ToBytes(JSON.stringify({ p: signed, cert }))), ENVELOPE_OVERHEAD);
  const key = randomBytes(32);
  return { key, body: aeadSeal(key, plain) };
}

function wrapFor(device: DeviceEntry, bodyKey: Uint8Array, body: Uint8Array): SealedCopy {
  const { header, key } = hybridEncap(prekeyPublic(device), INFO.envelope, ENVELOPE_VERSION);
  const rseed = randomBytes(32);
  const wrap = aeadSeal(key, concatBytes(bodyKey, rseed), header);
  return { device, bytes: concatBytes(header, wrap, body), rseed: bytesToHex(rseed) };
}

/**
 * Firma el payload con la clave de dispositivo y lo sella para cada dispositivo destino.
 * El contenido se cifra una sola vez; cada copia lleva su propia clave sellada y su `rseed`.
 */
export function sealMessage(sender: Sender, targets: DeviceEntry[], p: Payload): SealedCopy[] {
  const signed = signPayload(sender.device.signSecret, p);
  const { key, body } = sealBody(signed, sender.cert);
  return targets.map((d) => wrapFor(d, key, body));
}

/**
 * Abre un sobre con las prellaves de este dispositivo (la actual primero, luego las de los últimos 7 días).
 * Lanza si no es para mí, si se ha manipulado o si las firmas no cuadran.
 */
export function openMessage(me: DeviceKeys, bytes: Uint8Array): Opened {
  if (bytes[0] !== ENVELOPE_VERSION) throw new Error("Versión de sobre desconocida");
  const header = bytes.subarray(0, HYBRID_HEADER_BYTES);
  const wrap = bytes.subarray(HYBRID_HEADER_BYTES, HYBRID_HEADER_BYTES + NONCE_BYTES + WRAP_BYTES);
  const body = bytes.subarray(HYBRID_HEADER_BYTES + NONCE_BYTES + WRAP_BYTES);
  let inner: Uint8Array | null = null;
  for (const pk of me.prekeys) {
    try {
      inner = aeadOpen(hybridDecap(prekeySecret(pk), header, INFO.envelope), wrap, header);
      break;
    } catch {
      /* siguiente prellave */
    }
  }
  if (!inner) throw new Error("Este sobre no es para este dispositivo");
  const plain = unpackInner(unpad(aeadOpen(inner.subarray(0, 32), body)));
  const { p, cert } = JSON.parse(bytesToUtf8(plain)) as { p: SignedPayload; cert: DeviceCert };
  if (!verifyPayload(p, cert)) throw new Error("Firma del remitente no válida");
  return { payload: p, cert, rseed: bytesToHex(inner.subarray(32, 64)) };
}

/**
 * Dispositivos a los que mandar una copia: todos los de los destinatarios y mis otros dispositivos
 * (para que el historial sea igual en todos). Sin duplicados y sin el dispositivo que envía.
 */
export function fanOutTargets(recipients: DeviceList[], mine: DeviceList | undefined, myDeviceId: string): DeviceEntry[] {
  const seen = new Set<string>([myDeviceId]);
  const out: DeviceEntry[] = [];
  for (const list of [...recipients, ...(mine ? [mine] : [])]) {
    for (const d of list.devices) {
      const key = `${list.identity}/${d.id}`;
      if (seen.has(d.id) || seen.has(key)) continue;
      seen.add(key);
      out.push(d);
    }
  }
  return out;
}

export const sealedToB64 = b64;
