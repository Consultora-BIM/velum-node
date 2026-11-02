// Cupo de envío y topes de buzón en la capa de relé (puerta y nodos). FUERA DE CONSENSO: no toca bloques,
// transacciones ni estado; cada relé lleva su propia cuenta en memoria.
//
// Unidad: una «copia» = un sobre sellado para un dispositivo (todos sus trozos comparten `msg`). Un mensaje
// 1 a 1 son tantas copias como dispositivos del destinatario más mis otros dispositivos (≤ 10).
// Cupo gratis: FREE_MESSAGES_PER_10MIN × COPIES_PER_MESSAGE copias cada 10 min por remitente.
//
// ¿Quién es el «remitente» sin romper el remitente sellado? Un pase de envío opcional (`RatePass`) que viaja
// junto al trozo en `shard.put` (no dentro del trozo, que no cambia). Lo firma una «clave de cupo» que el
// dispositivo deriva cada día de su clave de firma: el relé ve un seudónimo diario, no la identidad ni el
// dispositivo, y no puede unir el de hoy con el de ayer. Sin pase (app 2.1.0), el remitente es la conexión.
//
// Créditos (`credits.buy`, v4): el estado guarda solo lo comprado (`msgCredits`); el consumo se cuenta fuera
// de la cadena (state.ts › msgCredits). Quien quiera pasar del cupo añade `cr`: su dirección y una firma que
// la ata a la clave de cupo del día. Eso SÍ revela la dirección al relé: es opcional y pensado para bots y
// empresas. Cada relé descuenta en su propio libro (no hay contabilidad global todavía).
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "./bytes";
import { FREE_MESSAGES_PER_10MIN } from "./constants";
import { isAddress, keyPairFromSecret, sign, verify } from "./keys";
import { CLOCK_SKEW_MS, DAY_MS } from "./msgconst";

export const QUOTA_WINDOW_MS = 10 * 60_000;
/** Copias que cuenta un «mensaje» del cupo: hasta 5 dispositivos del destinatario + 5 míos. */
export const COPIES_PER_MESSAGE = 10;
/** Copias gratis por remitente cada 10 min (20 mensajes × 10 copias). */
export const FREE_COPIES_PER_WINDOW = FREE_MESSAGES_PER_10MIN * COPIES_PER_MESSAGE;
/** Claves de cupo distintas que una conexión puede usar por ventana (frena rotar seudónimos). */
export const MAX_PASS_KEYS_PER_CONN = 4;
/** Una IP puede llevar mucha gente detrás (CGNAT móvil): su tope es holgado, solo corta abusos claros. */
export const IP_COPIES_FACTOR = 25;
export const MAX_PASS_KEYS_PER_IP = 200;

// ---------- Topes de buzón (pendiente de entrega) ----------
/** Trozos pendientes por buzón y bytes pendientes por buzón. */
export const MAX_SHARDS_PER_MAILBOX = 2_000;
export const MAX_BYTES_PER_MAILBOX = 40 * 1024 * 1024;
/** Lo que un mismo remitente puede tener pendiente en un buzón (un sobre de 8 MB ≈ 570 trozos, ~13,4 MB). */
export const MAX_SHARDS_PER_SENDER_MAILBOX = 700;
export const MAX_BYTES_PER_SENDER_MAILBOX = 16 * 1024 * 1024;

const PASS_TAG = "velum/v2/pass";
const CREDIT_TAG = "velum/v2/credit";
const QUOTA_INFO = "velum/v2/quota";

export interface RatePass {
  v: 1;
  /** Dirección de la clave de cupo del día (seudónimo). */
  k: string;
  ts: number;
  /** `msg` de la copia a la que acompaña. */
  msg: string;
  sig: string;
  /** Opcional: dirección con créditos y su firma sobre (k, día). Revela la dirección al relé. */
  cr?: { a: string; sig: string };
}

const dayOf = (ts: number) => Math.floor(ts / DAY_MS);
const passMessage = (k: string, msg: string, ts: number) => `${PASS_TAG}|${k}|${msg}|${ts}`;
const creditMessage = (k: string, day: number) => `${CREDIT_TAG}|${k}|${day}`;

/** Clave de cupo del día (hex de 32 B), derivada de la clave de firma del dispositivo. No sirve para nada más. */
export function quotaSecret(deviceSignSecretHex: string, ts = Date.now()): string {
  return bytesToHex(hkdf(sha512, hexToBytes(deviceSignSecretHex), undefined, utf8ToBytes(`${QUOTA_INFO}|${dayOf(ts)}`), 32));
}

/** Pase de envío para una copia (`msg`). `credit` = clave secreta de la dirección con créditos (opcional). */
export function makeRatePass(quotaSecretHex: string, msg: string, ts = Date.now(), credit?: { address: string; secret: string }): RatePass {
  const k = keyPairFromSecret(quotaSecretHex).address;
  const pass: RatePass = { v: 1, k, ts, msg, sig: sign(quotaSecretHex, passMessage(k, msg, ts)) };
  if (credit) pass.cr = { a: credit.address, sig: sign(credit.secret, creditMessage(k, dayOf(ts))) };
  return pass;
}

/** Motivo de rechazo del pase o null si vale para ese `msg`. */
export function ratePassProblem(p: unknown, msg: string, now = Date.now()): string | null {
  const x = p as RatePass;
  if (!x || typeof x !== "object" || x.v !== 1) return "Pase de envío no válido";
  if (typeof x.k !== "string" || !isAddress(x.k)) return "Pase de envío no válido";
  if (typeof x.ts !== "number" || !Number.isFinite(x.ts) || Math.abs(now - x.ts) > CLOCK_SKEW_MS) return "Pase de envío caducado";
  if (x.msg !== msg) return "El pase no corresponde a este trozo";
  if (typeof x.sig !== "string" || !verify(x.k, passMessage(x.k, x.msg, x.ts), x.sig)) return "Firma del pase no válida";
  if (x.cr !== undefined) {
    if (!x.cr || typeof x.cr.a !== "string" || !isAddress(x.cr.a) || typeof x.cr.sig !== "string") return "Prueba de créditos no válida";
    if (!verify(x.cr.a, creditMessage(x.k, dayOf(x.ts)), x.cr.sig)) return "Prueba de créditos no válida";
  }
  return null;
}

/** Créditos de una dirección para el libro: disponibles (comprados − gastados en este relé) y cómo gastar uno. */
export interface CreditBook {
  available(address: string): number;
  consume(address: string): void;
}

export interface QuotaContext {
  /** Conexión del cliente (siempre). */
  conn: string;
  /** Etiqueta opaca de la IP (HMAC con sal en memoria), si el relé la conoce. */
  ip?: string;
  /** Pase de envío (opcional). */
  pass?: unknown;
}

type Win = { start: number; copies: Set<string> };
type KeyWin = { start: number; keys: Set<string> };

/**
 * Libro de cupos de un relé. Todo en memoria, por ventanas fijas de 10 min. No guarda contenido, buzones
 * ni identidades: solo seudónimos de cupo, conexiones, etiquetas de IP y `msg` (aleatorio por copia).
 */
export class QuotaLedger {
  private senders = new Map<string, Win>();
  private ips = new Map<string, Win>();
  private connKeys = new Map<string, KeyWin>();
  private ipKeys = new Map<string, KeyWin>();
  constructor(private credits: CreditBook | null = null, private now: () => number = Date.now) {}

  /** Comprueba y, si cabe, apunta la copia. Devuelve el motivo del rechazo o null. Idempotente por `msg`. */
  check(msg: string, ctx: QuotaContext): string | null {
    const t = this.now();
    let pass: RatePass | null = null;
    if (ctx.pass !== undefined && ctx.pass !== null) {
      const err = ratePassProblem(ctx.pass, msg, t);
      if (err) return err;
      pass = ctx.pass as RatePass;
    }
    const sender = pass ? "k:" + pass.k : "c:" + ctx.conn;
    const sw = this.win(this.senders, sender, t);
    if (sw.copies.has(msg)) return null; // otro trozo de una copia ya contada
    const iw = ctx.ip ? this.win(this.ips, ctx.ip, t) : null;
    if (pass) {
      const ck = this.keyWin(this.connKeys, ctx.conn, t);
      if (!ck.keys.has(pass.k) && ck.keys.size >= MAX_PASS_KEYS_PER_CONN) return "Demasiadas claves de envío en esta conexión; espera unos minutos";
      const ik = ctx.ip ? this.keyWin(this.ipKeys, ctx.ip, t) : null;
      if (ik && !ik.keys.has(pass.k) && ik.keys.size >= MAX_PASS_KEYS_PER_IP) return "Demasiadas claves de envío desde esta red; espera unos minutos";
      ck.keys.add(pass.k);
      ik?.keys.add(pass.k);
    }
    const withCredit = !!pass?.cr && !!this.credits && this.credits.available(pass.cr.a) > 0;
    if (iw && !withCredit && iw.copies.size >= FREE_COPIES_PER_WINDOW * IP_COPIES_FACTOR) return "Demasiados mensajes desde esta red; espera unos minutos";
    if (sw.copies.size >= FREE_COPIES_PER_WINDOW) {
      if (!withCredit) {
        return `Cupo gratis agotado (${FREE_MESSAGES_PER_10MIN} mensajes cada 10 min). Espera o usa créditos de mensajería (credits.buy)`;
      }
      this.credits!.consume(pass!.cr!.a);
    }
    sw.copies.add(msg);
    iw?.copies.add(msg);
    return null;
  }

  /** Copias que le quedan a un remitente en esta ventana (sin créditos). */
  remaining(key: { conn?: string; k?: string }): number {
    const id = key.k ? "k:" + key.k : "c:" + key.conn;
    const w = this.senders.get(id);
    if (!w || this.now() - w.start >= QUOTA_WINDOW_MS) return FREE_COPIES_PER_WINDOW;
    return Math.max(0, FREE_COPIES_PER_WINDOW - w.copies.size);
  }

  /** Borra ventanas vencidas (llamar de vez en cuando). */
  sweep() {
    const t = this.now();
    for (const m of [this.senders, this.ips, this.connKeys, this.ipKeys] as Map<string, { start: number }>[]) {
      for (const [k, w] of m) if (t - w.start >= QUOTA_WINDOW_MS) m.delete(k);
    }
  }

  private win(m: Map<string, Win>, k: string, t: number): Win {
    let w = m.get(k);
    if (!w || t - w.start >= QUOTA_WINDOW_MS) m.set(k, (w = { start: t, copies: new Set() }));
    return w;
  }
  private keyWin(m: Map<string, KeyWin>, k: string, t: number): KeyWin {
    let w = m.get(k);
    if (!w || t - w.start >= QUOTA_WINDOW_MS) m.set(k, (w = { start: t, keys: new Set() }));
    return w;
  }
}

/**
 * Pendiente por (remitente, buzón): cuántos trozos y bytes de un mismo remitente esperan en un buzón.
 * En memoria y con caducidad (la del trozo); al entregarse un trozo se descuenta. Lo usa el nodo junto al
 * tope por buzón del almacén; la puerta, que no guarda trozos, lo usa como ritmo por buzón.
 */
export class SenderMailboxCaps {
  private byPair = new Map<string, Map<string, { bytes: number; exp: number }>>();
  private pairOf = new Map<string, string>();
  constructor(private now: () => number = Date.now, private maxShards = MAX_SHARDS_PER_SENDER_MAILBOX, private maxBytes = MAX_BYTES_PER_SENDER_MAILBOX) {}

  /** Motivo de rechazo o null. Si cabe, lo apunta. */
  add(sender: string, mailbox: string, id: string, bytes: number, exp: number): string | null {
    const pair = `${sender}|${mailbox}`;
    let m = this.byPair.get(pair);
    if (m?.has(id)) return null;
    const t = this.now();
    if (m) for (const [k, v] of m) if (v.exp <= t) { m.delete(k); this.pairOf.delete(k); }
    let total = 0;
    if (m) for (const v of m.values()) total += v.bytes;
    if ((m?.size ?? 0) >= this.maxShards || total + bytes > this.maxBytes) return "Demasiados trozos pendientes tuyos en ese buzón; espera a que se entreguen";
    if (!m) this.byPair.set(pair, (m = new Map()));
    m.set(id, { bytes, exp });
    this.pairOf.set(id, pair);
    return null;
  }

  /** Trozo entregado o borrado: deja de contar. */
  remove(id: string) {
    const pair = this.pairOf.get(id);
    if (!pair) return;
    this.pairOf.delete(id);
    const m = this.byPair.get(pair);
    m?.delete(id);
    if (m && m.size === 0) this.byPair.delete(pair);
  }

  sweep() {
    const t = this.now();
    for (const [pair, m] of this.byPair) {
      for (const [id, v] of m) if (v.exp <= t) { m.delete(id); this.pairOf.delete(id); }
      if (m.size === 0) this.byPair.delete(pair);
    }
  }

  size() { return this.pairOf.size; }
}

/** Remitente para los topes de buzón: el seudónimo del pase si es válido, si no la conexión. */
export function senderKeyOf(ctx: QuotaContext, msg: string, now = Date.now()): string {
  if (ctx.pass && !ratePassProblem(ctx.pass, msg, now)) return "k:" + (ctx.pass as RatePass).k;
  return "c:" + ctx.conn;
}
