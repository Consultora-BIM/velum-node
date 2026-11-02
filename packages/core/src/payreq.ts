// Estándar de cobro de Velum (docs/pagos.md): URI `velum:pay`, factura firmada por quien cobra, QR y NFC (NDEF).
// No toca el consenso: un cobro se liquida con un `transfer` normal (con `memo = "pay:<ref>"`).
//
//   velum:pay?to=<dirección>&amount=<VEL con punto decimal>&ref=<id>&label=<texto>&exp=<ms>&ts=<ms>&sig=<hex>
//
// · `amount` va en VEL para personas ("12.5"); la firma cubre el importe en velos (texto decimal, sin ambigüedad).
// · La firma es de `to` (quien cobra) sobre el JSON canónico de la factura: quien paga sabe que el QR no se ha cambiado.
// · Un QR o una etiqueta NFC caben de sobra: la URI firmada ronda los 250 caracteres.
import { canonical, utf8ToBytes, bytesToUtf8 } from "./bytes";
import { BLOCK_MS, CHAIN_ID, VEL } from "./constants";
import { sign, verify, isAddress, keyPairFromSecret } from "./keys";
import { VEL_DECIMALS, amountOrNull } from "./amount";

export const PAY_SCHEME = "velum:pay";
/** Referencia del cobro: la pone el comercio (nº de ticket, pedido…). Va en el `memo` del pago. */
export const PAY_REF_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const PAY_LABEL_MAX = 64;
/** Prefijo del `memo` que enlaza un pago con su factura. */
export const PAY_MEMO_PREFIX = "pay:";
/** Bloques recomendados para dar un cobro por firme (docs/ecosistema.md §2.3): 30 ≈ 1 min. Importes grandes: 1.800 (1 época). */
export const PAY_FINAL_CONFIRMATIONS = 30;
export const PAY_LARGE_CONFIRMATIONS = 1_800;

export interface Invoice {
  v: 1;
  t: "velum-invoice";
  chain: string;
  /** Quien cobra (y firma). */
  to: string;
  /** Unidades mínimas del token (velos si es VEL). */
  amount: bigint;
  /** Ausente = VEL. */
  token?: string;
  /** Decimales del token (solo si no es VEL; vUSDT = 6). */
  dec?: number;
  ref?: string;
  label?: string;
  /** Caducidad (ms desde 1970). Pasada esa hora, la app no deja pagar. */
  exp?: number;
  /** Hora de creación (ms). */
  ts: number;
  sig?: string;
}

export interface CreateInvoiceOptions {
  to: string;
  /** BigInt en unidades mínimas, o texto decimal en unidades mínimas. */
  amount: bigint | string;
  token?: string;
  dec?: number;
  ref?: string;
  label?: string;
  exp?: number;
  ts?: number;
  /** Clave de `to`. Sin ella la factura va sin firmar (el pagador lo verá como «sin verificar»). */
  secret?: string;
}

const decOf = (inv: Pick<Invoice, "token" | "dec">) => (inv.token && inv.token !== VEL ? inv.dec ?? 6 : VEL_DECIMALS);

/** Campos firmados (sin `sig`). El importe va como texto (canonical lo hace igual con BigInt). */
const body = (inv: Invoice) => {
  const { sig: _s, ...rest } = inv;
  return rest;
};

/** Problema de formato de una factura, o null. */
export function invoiceProblem(inv: Invoice): string | null {
  if (!inv || inv.v !== 1 || inv.t !== "velum-invoice") return "No es una factura de Velum";
  if (inv.chain !== CHAIN_ID) return "La factura es de otra red";
  if (!isAddress(inv.to)) return "Dirección de cobro no válida";
  if (typeof inv.amount !== "bigint" || inv.amount <= 0n) return "Importe no válido";
  if (inv.token !== undefined && (typeof inv.token !== "string" || !/^[A-Za-z0-9]{3,8}$/.test(inv.token) || inv.token === VEL)) return "Token no válido";
  if (inv.dec !== undefined && (!Number.isInteger(inv.dec) || inv.dec < 0 || inv.dec > 18)) return "Decimales no válidos";
  if (inv.ref !== undefined && !PAY_REF_RE.test(inv.ref)) return "Referencia no válida (1–64: letras, números, _ y -)";
  if (inv.label !== undefined && (typeof inv.label !== "string" || inv.label.length > PAY_LABEL_MAX)) return "Concepto demasiado largo";
  if (inv.exp !== undefined && !Number.isSafeInteger(inv.exp)) return "Caducidad no válida";
  if (!Number.isSafeInteger(inv.ts)) return "Hora no válida";
  return null;
}

/** Crea (y firma, si se da la clave de `to`) una factura. */
export function createInvoice(o: CreateInvoiceOptions): Invoice {
  const amount = typeof o.amount === "bigint" ? o.amount : amountOrNull(o.amount);
  if (amount === null) throw new Error("Importe no válido (unidades mínimas)");
  const inv: Invoice = {
    v: 1, t: "velum-invoice", chain: CHAIN_ID, to: o.to, amount,
    ...(o.token && o.token !== VEL ? { token: o.token, dec: o.dec ?? 6 } : {}),
    ...(o.ref ? { ref: o.ref } : {}), ...(o.label ? { label: o.label } : {}), ...(o.exp ? { exp: o.exp } : {}),
    ts: o.ts ?? Date.now(),
  };
  const e = invoiceProblem(inv);
  if (e) throw new Error(e);
  return o.secret ? signInvoice(o.secret, inv) : inv;
}

export function signInvoice(secret: string, inv: Invoice): Invoice {
  if (keyPairFromSecret(secret).address !== inv.to) throw new Error("La clave no es la de la dirección de cobro");
  return { ...body(inv), sig: sign(secret, canonical(body(inv))) };
}

/** ¿La firma es de `to`? (false si no lleva firma). */
export function verifyInvoice(inv: Invoice): boolean {
  return typeof inv.sig === "string" && invoiceProblem(inv) === null && verify(inv.to, canonical(body(inv)), inv.sig);
}

/** Unidades mínimas → texto con punto decimal y sin ceros sobrantes ("12.5"). Para la URI (no para pantallas). */
export function unitsToDecimal(u: bigint, dec: number): string {
  const d = 10n ** BigInt(dec);
  const f = dec ? (u % d).toString().padStart(dec, "0").replace(/0+$/, "") : "";
  return (u / d).toString() + (f ? "." + f : "");
}

/** Texto con punto decimal → unidades mínimas. null si no vale o tiene más decimales de los que admite. */
export function decimalToUnits(t: string, dec: number): bigint | null {
  if (!/^\d{1,30}(\.\d{1,30})?$/.test(t)) return null;
  const [i, f = ""] = t.split(".");
  if (f.length > dec) return null;
  return BigInt(i!) * 10n ** BigInt(dec) + BigInt(f.padEnd(dec, "0") || "0");
}

/** URI `velum:pay?…` de una factura (para QR, enlace o NFC). */
export function paymentURI(inv: Invoice): string {
  const p = new URLSearchParams();
  p.set("to", inv.to);
  p.set("amount", unitsToDecimal(inv.amount, decOf(inv)));
  if (inv.token) { p.set("token", inv.token); p.set("dec", String(decOf(inv))); }
  if (inv.ref) p.set("ref", inv.ref);
  if (inv.label) p.set("label", inv.label);
  if (inv.exp) p.set("exp", String(inv.exp));
  p.set("ts", String(inv.ts));
  if (inv.chain !== CHAIN_ID) p.set("chain", inv.chain);
  if (inv.sig) p.set("sig", inv.sig);
  return `${PAY_SCHEME}?${p.toString().replace(/\+/g, "%20")}`;
}

export type ParsedPayment =
  | { ok: true; invoice: Invoice; signed: boolean; verified: boolean; expired: boolean }
  | { ok: false; error: string };

/**
 * Lee una URI `velum:pay` (de un QR, un enlace o una etiqueta NFC). También acepta `velum:<dirección>` a secas
 * (pago libre, sin importe → error «Falta el importe» para que la app pida la cifra).
 */
export function parsePaymentURI(uri: string, now = Date.now()): ParsedPayment {
  const s = String(uri ?? "").trim();
  if (!/^velum:/i.test(s)) return { ok: false, error: "No es un enlace de pago de Velum" };
  const rest = s.slice(6);
  let path = rest, query = "";
  const q = rest.indexOf("?");
  if (q >= 0) { path = rest.slice(0, q); query = rest.slice(q + 1); }
  const p = new URLSearchParams(query);
  const to = path.replace(/^\/\//, "") === "pay" || path === "" ? p.get("to") ?? "" : path.replace(/^\/\//, "");
  if (!isAddress(to)) return { ok: false, error: "Dirección de cobro no válida" };
  const amountTxt = p.get("amount");
  if (!amountTxt) return { ok: false, error: "Falta el importe" };
  const token = p.get("token") ?? undefined;
  const dec = token && token !== VEL ? Number(p.get("dec") ?? "6") : VEL_DECIMALS;
  const amount = decimalToUnits(amountTxt, dec);
  if (amount === null || amount <= 0n) return { ok: false, error: "Importe no válido" };
  const num = (k: string) => { const v = p.get(k); return v === null ? undefined : /^\d{1,16}$/.test(v) ? Number(v) : NaN; };
  const exp = num("exp"), ts = num("ts");
  const inv: Invoice = {
    v: 1, t: "velum-invoice", chain: p.get("chain") ?? CHAIN_ID, to, amount,
    ...(token && token !== VEL ? { token, dec } : {}),
    ...(p.get("ref") ? { ref: p.get("ref")! } : {}), ...(p.get("label") ? { label: p.get("label")! } : {}),
    ...(exp !== undefined ? { exp } : {}), ts: ts ?? 0,
    ...(p.get("sig") ? { sig: p.get("sig")!.toLowerCase() } : {}),
  };
  const e = invoiceProblem(inv);
  if (e) return { ok: false, error: e };
  const signed = !!inv.sig;
  return { ok: true, invoice: inv, signed, verified: signed && verifyInvoice(inv), expired: !!inv.exp && now > inv.exp };
}

/** `memo` que debe llevar el pago de una factura con referencia. */
export const paymentMemo = (inv: Pick<Invoice, "ref">) => (inv.ref ? PAY_MEMO_PREFIX + inv.ref : undefined);

/**
 * ¿Esta tx paga la factura? Transfer a `to`, mismo token, importe ≥ el pedido y, si hay referencia, `memo = pay:<ref>`.
 * Acepta la tx en memoria (BigInt) o tal como llega de la red (texto decimal).
 */
export function paysInvoice(tx: any, inv: Invoice): boolean {
  if (!tx || tx.type !== "transfer" || tx.to !== inv.to) return false;
  if ((tx.token ?? VEL) !== (inv.token ?? VEL)) return false;
  const a = typeof tx.amount === "bigint" ? tx.amount : amountOrNull(tx.amount);
  if (a === null || a < inv.amount) return false;
  const memo = paymentMemo(inv);
  return memo === undefined || tx.memo === memo;
}

// ---------- Firmeza ----------
export type Settlement = "pendiente" | "incluido" | "firme";

/**
 * Estado de un cobro por sus confirmaciones (bloques desde el suyo, incluido). «incluido» = ya está en un bloque
 * (lo normal en ~2 s); «firme» = con `need` bloques encima. `remainingMs` = espera estimada con el ritmo nominal.
 */
export function settlementOf(confirmations: number, need = PAY_FINAL_CONFIRMATIONS, blockMs = BLOCK_MS) {
  const c = Math.max(0, Math.floor(confirmations));
  const state: Settlement = c <= 0 ? "pendiente" : c >= need ? "firme" : "incluido";
  return { state, confirmations: c, need, remainingMs: Math.max(0, need - c) * blockMs, blockMs };
}

/** Bloques recomendados según el importe en velos (≥ 10.000 VEL → una época). */
export const confirmationsFor = (amount: bigint, large = 10_000n * 10n ** BigInt(VEL_DECIMALS)) =>
  amount >= large ? PAY_LARGE_CONFIRMATIONS : PAY_FINAL_CONFIRMATIONS;

// ---------- NFC (NDEF) ----------
/**
 * Mensaje NDEF con un único registro URI (TNF 1, tipo «U», sin prefijo abreviado: `velum:` no está en la tabla).
 * Es lo que se escribe en una etiqueta NFC o lo que emite un teléfono en modo tarjeta (HCE).
 */
export function ndefMessage(uri: string): Uint8Array {
  const payload = utf8ToBytes(uri);
  const short = payload.length + 1 <= 255;
  const head = 0x80 | 0x40 | (short ? 0x10 : 0) | 0x01; // MB | ME | SR? | TNF=1
  const len = payload.length + 1;
  const out = new Uint8Array(3 + (short ? 1 : 4) + len);
  let i = 0;
  out[i++] = head;
  out[i++] = 1; // longitud del tipo
  if (short) out[i++] = len;
  else { out[i++] = len >>> 24; out[i++] = (len >>> 16) & 255; out[i++] = (len >>> 8) & 255; out[i++] = len & 255; }
  out[i++] = 0x55; // "U"
  out[i++] = 0x00; // sin prefijo
  out.set(payload, i);
  return out;
}

/** URI del primer registro URI de un mensaje NDEF (o null). */
export function parseNdef(msg: Uint8Array): string | null {
  if (msg.length < 5) return null;
  const head = msg[0]!;
  if ((head & 0x07) !== 0x01) return null;
  const short = (head & 0x10) !== 0, il = (head & 0x08) !== 0;
  let i = 1;
  const typeLen = msg[i++]!;
  let len: number;
  if (short) len = msg[i++]!;
  else { len = ((msg[i]! << 24) | (msg[i + 1]! << 16) | (msg[i + 2]! << 8) | msg[i + 3]!) >>> 0; i += 4; }
  if (il) return null; // con identificador: no lo generamos nosotros
  if (typeLen !== 1 || msg[i] !== 0x55) return null;
  i += 1;
  const prefixes = ["", "http://www.", "https://www.", "http://", "https://"];
  const pre = prefixes[msg[i]!] ?? "";
  return pre + bytesToUtf8(msg.slice(i + 1, i + len));
}
