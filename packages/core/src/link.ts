// Vinculación de dispositivos con QR que rota (docs/protocolo-v2.md §6).
//
//  A (activo)                                   B (nuevo)
//  frame() cada 2 s → QR ─────── cámara ──────▶ new LinkGuest(qr)
//                     ◀── hello {bx, bkem, mac} ── (buzón efímero «toHost»)
//  onHello → accept {kemCt} ─────────────────▶ onAccept
//  código de 6 dígitos  ═══ el usuario compara ═══  código de 6 dígitos
//  confirm() → secretos + lotes comprimidos ──▶ onBox … done
//                     ◀── device {entry, list} ── (B se añade a la lista y la firma)
//  onBox → lista nueva: A la reparte a los contactos.
//
// Todo lo que va por la red tras el hello va cifrado con claves de X25519 + ML-KEM-768.
//
// Modo inverso (protocolo-v3 §8, como WhatsApp Web): el dispositivo NUEVO muestra el QR que rota
// (`LinkGuest.display`) y el activo lo escanea (`LinkHost.scan`). Cambia solo quién muestra y quién saluda:
//  B nuevo: frame() cada 2 s → QR `velum-link:v3r:…` ── cámara ──▶ A: LinkHost.scan(qr)
//                     ◀── hello {bx = X25519 de A, bkem = ML-KEM de A, mac} ── (buzón «toGuest»)
//  B: onHello → accept {kemCt} ─────────────────────────────▶ A: onAccept → código
//  (desde aquí, igual que v2: A confirma y envía secretos; B se añade a la lista y la devuelve)
import { x25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { deflateSync, inflateSync } from "fflate";
import { b64, bytesToHex, bytesToUtf8, canonical, concatBytes, hexToBytes, randomBytes, unb64, utf8ToBytes } from "./bytes";
import { base64urlnopad } from "@scure/base";
import { aeadOpen, aeadSeal } from "./pq";
import { keyPairFromSecret } from "./keys";
import {
  addDevice, createDevice, deviceEntry, signDeviceCert, verifyDeviceList,
  type DeviceCert, type DeviceKeys, type DeviceList,
} from "./devices";
import { deviceMailbox, mailboxFor, mbAuthFor, type DeviceMailbox } from "./mailbox";
import { padToBucket, unpad } from "./shards";
import { INFO, LINK_BATCH_BYTES, LINK_FRAME_TTL_MS, LINK_SESSION_TTL_MS, MAX_DEVICES } from "./msgconst";

/** Margen de red entre que B lee el QR y A recibe el hello. */
export const LINK_NET_GRACE_MS = 20_000;

export interface LinkFrame {
  /** true = QR del modo inverso (lo muestra el dispositivo nuevo). */
  reverse?: boolean;
  sid: string;
  nonce: string;
  ts: number;
  /** X25519 efímera de A (32 B). */
  apub: Uint8Array;
  mac: string;
}

export type LinkMsg =
  | { t: "hello"; sid: string; nonce: string; ts: number; bx: string; bkem: string; mac: string }
  | { t: "accept"; sid: string; ct: string }
  | { t: "box"; sid: string; dir: "h" | "g"; seq: number; c: string };

/** Lo que A transfiere a B. */
export interface LinkSecrets {
  identitySecret: string;
  walletSecret: string;
  mailboxBase: string;
  /** Opcional: la frase (si la app la guarda). */
  phrase?: string;
  deviceList: DeviceList;
}

/** Resultado en B: todo lo que la app debe guardar. */
export interface LinkResult extends LinkSecrets {
  device: DeviceKeys;
  cert: DeviceCert;
  blobs: Record<string, unknown>;
}

type Inner =
  | { t: "secrets"; s: LinkSecrets; blobs: number }
  | { t: "blob"; name: string; part: number; parts: number; data: string }
  | { t: "done" }
  | { t: "device"; list: DeviceList; device: string }
  | { t: "cancel"; reason?: string };

// ---------- QR ----------
const frameMac = (secret: Uint8Array, sid: string, nonce: string, ts: number, apub: Uint8Array) =>
  bytesToHex(hmac(sha512, secret, utf8ToBytes(`${sid}|${nonce}|${ts}|${bytesToHex(apub)}`)).slice(0, 16));

export function formatLinkFrame(f: LinkFrame): string {
  return `velum-link:${f.reverse ? "v3r" : "v2"}:${f.sid}:${f.nonce}:${f.ts.toString(36)}:${base64urlnopad.encode(f.apub)}:${f.mac}`;
}

export function parseLinkFrame(s: string): LinkFrame {
  const parts = s.trim().split(":");
  if (parts.length !== 7 || parts[0] !== "velum-link" || (parts[1] !== "v2" && parts[1] !== "v3r")) throw new Error("QR de vínculo no válido");
  const [, ver, sid, nonce, ts36, apub, mac] = parts as [string, string, string, string, string, string, string];
  const f = { ...(ver === "v3r" ? { reverse: true } : {}), sid, nonce, ts: parseInt(ts36, 36), apub: base64urlnopad.decode(apub), mac };
  if (!/^[0-9a-f]{32}$/.test(sid) || !/^[0-9a-f]{16}$/.test(nonce) || f.apub.length !== 32 || !/^[0-9a-f]{32}$/.test(mac) || !Number.isFinite(f.ts))
    throw new Error("QR de vínculo no válido");
  return f;
}

// ---------- Buzones efímeros ----------
export interface LinkMailbox {
  mb: DeviceMailbox;
  mailbox: string;
  mbAuth: string;
  /** Semilla de recibos para los trozos de este buzón (la conocen los dos lados). */
  rseed: string;
}

/** Buzones de la sesión: «h» = hacia A (host), «g» = hacia B (guest). Fijos durante la sesión. */
export function linkMailbox(sid: string, dir: "h" | "g"): LinkMailbox {
  const base = bytesToHex(sha512(utf8ToBytes(`${INFO.link}/mailbox|${sid}`)).slice(0, 32));
  const mb = deviceMailbox(base, `link-${dir}`, sid);
  const mailbox = mailboxFor(mb.seed, 0);
  return { mb, mailbox, mbAuth: mbAuthFor(mb.pub, mailbox), rseed: bytesToHex(hmac(sha512, hexToBytes(sid), utf8ToBytes("rseed|" + dir)).slice(0, 32)) };
}

/** Mensaje de vínculo → bytes de tamaño de cubo (listos para trocear). */
export const encodeLinkMsg = (m: LinkMsg) => padToBucket(utf8ToBytes(JSON.stringify(m)));
export const decodeLinkMsg = (b: Uint8Array) => JSON.parse(bytesToUtf8(unpad(b))) as LinkMsg;

// ---------- Claves de sesión ----------
interface SessionKeys {
  toGuest: Uint8Array;
  toHost: Uint8Array;
  code: string;
}

/** `apub` = X25519 de quien muestra el QR; `bx` = la de quien lo escanea. El modo inverso usa otra etiqueta. */
function sessionKeys(sid: string, dh: Uint8Array, kemSs: Uint8Array, kemCt: Uint8Array, apub: Uint8Array, bx: Uint8Array, reverse = false): SessionKeys {
  const okm = hkdf(sha512, concatBytes(dh, kemSs), concatBytes(hexToBytes(sid), kemCt, apub, bx), utf8ToBytes(reverse ? `${INFO.link}/reverse` : INFO.link), 96);
  const n = new DataView(okm.buffer, okm.byteOffset + 64, 8).getBigUint64(0);
  return { toGuest: okm.slice(0, 32), toHost: okm.slice(32, 64), code: (n % 1_000_000n).toString().padStart(6, "0") };
}

const helloKey = (mac: string, apub: Uint8Array, sid: string) =>
  hkdf(sha512, concatBytes(hexToBytes(mac), apub), hexToBytes(sid), utf8ToBytes(`${INFO.link}/hello`), 32);

const boxAad = (sid: string, dir: string, seq: number) => utf8ToBytes(`${sid}|${dir}|${seq}`);

class Channel {
  private seqOut = 0;
  private seen = new Set<number>();
  constructor(private sid: string, private dirOut: "h" | "g", private kOut: Uint8Array, private kIn: Uint8Array) {}
  seal(inner: Inner): LinkMsg {
    const seq = this.seqOut++;
    return { t: "box", sid: this.sid, dir: this.dirOut, seq, c: b64(aeadSeal(this.kOut, utf8ToBytes(JSON.stringify(inner)), boxAad(this.sid, this.dirOut, seq))) };
  }
  open(m: LinkMsg): Inner | null {
    if (m.t !== "box" || m.sid !== this.sid || m.dir === this.dirOut || this.seen.has(m.seq)) return null;
    const inner = JSON.parse(bytesToUtf8(aeadOpen(this.kIn, unb64(m.c), boxAad(this.sid, m.dir, m.seq)))) as Inner;
    this.seen.add(m.seq);
    return inner;
  }
}

/** Trocea blobs JSON comprimidos (deflate) en lotes. */
function packBlobs(blobs: Record<string, unknown>): Inner[] {
  const out: Inner[] = [];
  for (const [name, value] of Object.entries(blobs)) {
    const z = deflateSync(utf8ToBytes(JSON.stringify(value)), { level: 6 });
    const parts = Math.max(1, Math.ceil(z.length / LINK_BATCH_BYTES));
    for (let i = 0; i < parts; i++) out.push({ t: "blob", name, part: i, parts, data: b64(z.subarray(i * LINK_BATCH_BYTES, (i + 1) * LINK_BATCH_BYTES)) });
  }
  return out;
}

// ---------- Mostrar y escanear el QR (los usan los dos modos) ----------
/** Quien muestra el QR que rota: genera fotogramas y comprueba el hello de quien lo leyó. */
class QrShow {
  readonly sid = bytesToHex(randomBytes(16));
  private ephS = randomBytes(32);
  readonly apub = x25519.getPublicKey(this.ephS);
  private secret = randomBytes(32);
  private frames = new Map<string, number>();
  constructor(private reverse: boolean) {}

  frame(now: number): string {
    const nonce = bytesToHex(randomBytes(8));
    this.frames.set(nonce, now);
    for (const [n, ts] of this.frames) if (now - ts > LINK_FRAME_TTL_MS + LINK_NET_GRACE_MS) this.frames.delete(n);
    return formatLinkFrame({ ...(this.reverse ? { reverse: true } : {}), sid: this.sid, nonce, ts: now, apub: this.apub, mac: frameMac(this.secret, this.sid, nonce, now, this.apub) });
  }

  /** Comprueba el hello, encapsula a su ML-KEM y deriva las claves. Ya no acepta más lecturas. */
  onHello(m: LinkMsg, now: number): { ct: Uint8Array; keys: SessionKeys } {
    if (m.t !== "hello" || m.sid !== this.sid) throw new Error("Mensaje de vínculo ajeno");
    const shown = this.frames.get(m.nonce);
    if (shown === undefined || shown !== m.ts || now - shown > LINK_FRAME_TTL_MS + LINK_NET_GRACE_MS) throw new Error("QR caducado: vuelve a escanear");
    const mac = frameMac(this.secret, this.sid, m.nonce, m.ts, this.apub);
    const { mac: hm, ...rest } = m;
    const expect = bytesToHex(hmac(sha512, helloKey(mac, this.apub, this.sid), utf8ToBytes(canonical(rest))).slice(0, 32));
    if (expect !== hm) throw new Error("El hello no viene de quien leyó el QR");
    const bx = unb64(m.bx);
    const { cipherText, sharedSecret } = ml_kem768.encapsulate(unb64(m.bkem));
    const keys = sessionKeys(this.sid, x25519.getSharedSecret(this.ephS, bx), sharedSecret, cipherText, this.apub, bx, this.reverse);
    this.frames.clear();
    return { ct: cipherText, keys };
  }
}

/** Quien escanea el QR: saluda con sus claves efímeras y deriva las claves al recibir el accept. */
class QrScan {
  private eph = { s: randomBytes(32), kem: ml_kem768.keygen() };
  constructor(readonly frame: LinkFrame) {}

  hello(): LinkMsg {
    const rest = { t: "hello" as const, sid: this.frame.sid, nonce: this.frame.nonce, ts: this.frame.ts, bx: b64(x25519.getPublicKey(this.eph.s)), bkem: b64(this.eph.kem.publicKey) };
    const mac = bytesToHex(hmac(sha512, helloKey(this.frame.mac, this.frame.apub, this.frame.sid), utf8ToBytes(canonical(rest))).slice(0, 32));
    return { ...rest, mac };
  }

  onAccept(m: LinkMsg): SessionKeys {
    if (m.t !== "accept" || m.sid !== this.frame.sid) throw new Error("Mensaje de vínculo ajeno");
    const ct = unb64(m.ct);
    const bx = x25519.getPublicKey(this.eph.s);
    return sessionKeys(this.frame.sid, x25519.getSharedSecret(this.eph.s, this.frame.apub), ml_kem768.decapsulate(ct, this.eph.kem.secretKey), ct, this.frame.apub, bx, !!this.frame.reverse);
  }
}

// ---------- A: el dispositivo activo ----------
export class LinkHost {
  readonly sid: string;
  readonly created: number;
  /** Modo v2: A muestra el QR. Modo inverso: A escanea el del dispositivo nuevo. */
  private show: QrShow | null = null;
  private scanner: QrScan | null = null;
  private ch: Channel | null = null;
  code: string | null = null;
  state: "waiting" | "code" | "sent" | "done" | "cancelled" = "waiting";

  constructor(now = Date.now(), scanned?: LinkFrame) {
    this.created = now;
    if (scanned) {
      if (!scanned.reverse) throw new Error("Ese QR es para que lo lea el dispositivo nuevo");
      this.scanner = new QrScan(scanned);
      this.sid = scanned.sid;
    } else {
      this.show = new QrShow(false);
      this.sid = this.show.sid;
    }
  }

  /** Modo inverso (v3 §8): el dispositivo activo escanea el QR que muestra el nuevo. Luego `hello()`. */
  static scan(qr: string, now = Date.now()): LinkHost {
    return new LinkHost(now, parseLinkFrame(qr));
  }

  get reverse() { return !!this.scanner; }
  /** X25519 efímera del QR (modo v2). */
  get apub() { return this.show?.apub ?? this.scanner!.frame.apub; }
  get inbox() { return linkMailbox(this.sid, "h"); }
  get outbox() { return linkMailbox(this.sid, "g"); }
  expired(now = Date.now()) { return now - this.created > LINK_SESSION_TTL_MS; }

  /** Fotograma nuevo del QR (llamar cada 2 s). Caduca a los 6 s. Solo modo v2. */
  frame(now = Date.now()): string {
    if (!this.show) throw new Error("En modo inverso el QR lo muestra el dispositivo nuevo");
    return this.show.frame(now);
  }

  /** Modo inverso: saludo para el dispositivo nuevo (enviar a `outbox`). */
  hello(): LinkMsg {
    if (!this.scanner) throw new Error("Solo en modo inverso");
    return this.scanner.hello();
  }

  /** Modo inverso: el nuevo aceptó. Devuelve el código a comparar. */
  onAccept(m: LinkMsg): string {
    if (!this.scanner) throw new Error("Solo en modo inverso");
    const k = this.scanner.onAccept(m);
    this.ch = new Channel(this.sid, "g", k.toGuest, k.toHost);
    this.code = k.code;
    this.state = "code";
    return k.code;
  }

  /** Modo v2: B ha leído un fotograma. Devuelve el `accept` a enviar y el código a mostrar. */
  onHello(m: LinkMsg, now = Date.now()): { reply: LinkMsg; code: string } {
    if (m.t !== "hello" || m.sid !== this.sid || !this.show) throw new Error("Mensaje de vínculo ajeno");
    if (this.state !== "waiting" || this.expired(now)) throw new Error("La sesión de vínculo ya no acepta dispositivos");
    const { ct, keys: k } = this.show.onHello(m, now);
    this.ch = new Channel(this.sid, "g", k.toGuest, k.toHost);
    this.code = k.code;
    this.state = "code";
    return { reply: { t: "accept", sid: this.sid, ct: b64(ct) }, code: k.code };
  }

  /**
   * El usuario ha confirmado que el código coincide. Devuelve los mensajes cifrados a enviar:
   * secretos, lotes comprimidos (contactos, grupos, historial…) y fin.
   */
  confirm(secrets: LinkSecrets, blobs: Record<string, unknown> = {}): LinkMsg[] {
    if (this.state !== "code" || !this.ch) throw new Error("Aún no hay código que confirmar");
    if (secrets.deviceList.devices.length >= MAX_DEVICES) throw new Error(`Ya hay ${MAX_DEVICES} dispositivos: expulsa uno antes`);
    const parts = packBlobs(blobs);
    this.state = "sent";
    return [this.ch.seal({ t: "secrets", s: secrets, blobs: parts.length }), ...parts.map((p) => this.ch!.seal(p)), this.ch.seal({ t: "done" })];
  }

  cancel(reason?: string): LinkMsg | null {
    this.state = "cancelled";
    return this.ch ? this.ch.seal({ t: "cancel", reason }) : null;
  }

  /** Respuesta de B: su lista nueva (ya firmada con la identidad). La devuelve si es válida. */
  onBox(m: LinkMsg, current: DeviceList): { list: DeviceList; device: string } | null {
    if (!this.ch) return null;
    const inner = this.ch.open(m);
    if (!inner || inner.t !== "device") return null;
    const { list, device } = inner;
    if (!verifyDeviceList(list, current.identity) || list.seq <= current.seq || !list.devices.some((d) => d.id === device))
      throw new Error("Lista de dispositivos del nuevo dispositivo no válida");
    this.state = "done";
    return { list, device };
  }
}

// ---------- B: el dispositivo nuevo ----------
export class LinkGuest {
  readonly device: DeviceKeys;
  readonly created: number;
  /** Modo v2: B escanea el QR de A. Modo inverso: B muestra el QR. */
  private scanner: QrScan | null = null;
  private show: QrShow | null = null;
  private ch: Channel | null = null;
  private secrets: LinkSecrets | null = null;
  private expected = -1;
  private chunks = new Map<string, string[]>();
  private gotDone = false;
  code: string | null = null;

  constructor(qr: string | null, deviceName: string, now = Date.now()) {
    this.created = now;
    if (qr === null) this.show = new QrShow(true);
    else {
      const f = parseLinkFrame(qr);
      if (f.reverse) throw new Error("Ese QR lo muestra un dispositivo nuevo: escanéalo desde el activo");
      this.scanner = new QrScan(f);
    }
    this.device = createDevice(deviceName, now);
  }

  /** Modo inverso (v3 §8): el dispositivo nuevo muestra un QR que rota; el activo lo escanea. */
  static display(deviceName: string, now = Date.now()): LinkGuest {
    return new LinkGuest(null, deviceName, now);
  }

  get reverse() { return !!this.show; }
  /** Fotograma leído (modo v2). */
  get frame(): LinkFrame {
    if (!this.scanner) throw new Error("En modo inverso este dispositivo muestra el QR");
    return this.scanner.frame;
  }
  get sid() { return this.scanner ? this.scanner.frame.sid : this.show!.sid; }
  get inbox() { return linkMailbox(this.sid, "g"); }
  get outbox() { return linkMailbox(this.sid, "h"); }
  expired(now = Date.now()) { return now - this.created > LINK_SESSION_TTL_MS; }

  /** Modo inverso: fotograma nuevo del QR (cada 2 s). */
  qr(now = Date.now()): string {
    if (!this.show) throw new Error("Solo en modo inverso");
    return this.show.frame(now);
  }

  /** Modo v2: saludo para A tras leer el QR. */
  hello(): LinkMsg {
    if (!this.scanner) throw new Error("En modo inverso saluda el dispositivo activo");
    return this.scanner.hello();
  }

  /** Modo v2: A aceptó. Devuelve el código. */
  onAccept(m: LinkMsg): string {
    if (!this.scanner) throw new Error("Solo en modo v2");
    const k = this.scanner.onAccept(m);
    this.ch = new Channel(this.sid, "h", k.toHost, k.toGuest);
    this.code = k.code;
    return k.code;
  }

  /** Modo inverso: A leyó mi QR y saluda. Devuelve el `accept` (enviar a `outbox`) y el código. */
  onHello(m: LinkMsg, now = Date.now()): { reply: LinkMsg; code: string } {
    if (!this.show) throw new Error("Solo en modo inverso");
    if (this.ch || this.expired(now)) throw new Error("La sesión de vínculo ya no acepta saludos");
    const { ct, keys: k } = this.show.onHello(m, now);
    this.ch = new Channel(this.sid, "h", k.toHost, k.toGuest);
    this.code = k.code;
    return { reply: { t: "accept", sid: this.sid, ct: b64(ct) }, code: k.code };
  }

  /** Recibe secretos y lotes. Al terminar devuelve todo lo que hay que guardar y la respuesta para A. */
  onBox(m: LinkMsg, now = Date.now()): { result: LinkResult; reply: LinkMsg } | { cancelled: string } | null {
    if (!this.ch) return null;
    const inner = this.ch.open(m);
    if (!inner) return null;
    if (inner.t === "cancel") return { cancelled: inner.reason ?? "Vínculo cancelado" };
    if (inner.t === "secrets") {
      if (!verifyDeviceList(inner.s.deviceList, keyPairFromSecret(inner.s.identitySecret).address)) throw new Error("Lista de dispositivos no válida");
      this.secrets = inner.s;
      this.expected = inner.blobs;
    } else if (inner.t === "blob") {
      const arr = this.chunks.get(inner.name) ?? Array(inner.parts).fill("");
      arr[inner.part] = inner.data;
      this.chunks.set(inner.name, arr);
    } else if (inner.t === "done") this.gotDone = true;
    return this.finish(now);
  }

  private finish(now: number) {
    if (!this.gotDone || !this.secrets || !this.ch) return null;
    let got = 0;
    for (const arr of this.chunks.values()) got += arr.filter(Boolean).length;
    if (got < this.expected) return null;
    const blobs: Record<string, unknown> = {};
    for (const [name, arr] of this.chunks) blobs[name] = JSON.parse(bytesToUtf8(inflateSync(concatBytes(...arr.map(unb64)))));
    const s = this.secrets;
    const id = keyPairFromSecret(s.identitySecret);
    const entry = deviceEntry(this.device, s.mailboxBase, now);
    const list = addDevice(s.identitySecret, s.deviceList, entry, now);
    const cert = signDeviceCert(s.identitySecret, id.address, this.device, now);
    const reply = this.ch.seal({ t: "device", list, device: this.device.id });
    return { result: { ...s, deviceList: list, device: this.device, cert, blobs }, reply };
  }
}
