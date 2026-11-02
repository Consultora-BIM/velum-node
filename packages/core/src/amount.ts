// Importes (protocolo v4). Todo importe es un BigInt en unidades mínimas.
//  · VEL: 18 decimales. La unidad mínima se llama «velo»: 1 VEL = 10^18 velos.
//  · Otros tokens: sus propios decimales (vUSDT: 6).
//  · En JSON y en la codificación canónica (firmas, hashes) un importe va SIEMPRE como texto decimal sin signo,
//    sin ceros a la izquierda y sin decimales: "1500000000000000000" = 1,5 VEL. Un número JSON NO es un importe válido.
// Nada de coma flotante: formatear y leer se hace con texto y BigInt.

export type Amount = bigint;

/** Decimales de VEL. */
export const VEL_DECIMALS = 18;
/** 1 VEL en velos. */
export const UNIT: bigint = 10n ** 18n;
/** Nombre de la unidad mínima de VEL. */
export const VELO = "velo";

/** Texto decimal canónico de un importe: sin signo, sin ceros a la izquierda, hasta 78 cifras (< 2^256). */
export const AMOUNT_RE = /^(0|[1-9][0-9]{0,77})$/;

/** ¿Es un importe en forma válida (BigInt ≥ 0 o texto decimal canónico)? Los `number` no valen. */
export function isAmount(x: unknown): x is bigint | string {
  if (typeof x === "bigint") return x >= 0n && x < 1n << 256n;
  return typeof x === "string" && AMOUNT_RE.test(x);
}

/** BigInt a partir de un importe válido; null si no lo es (incluye `number`). */
export function amountOrNull(x: unknown): bigint | null {
  if (typeof x === "bigint") return isAmount(x) ? x : null;
  if (typeof x === "string" && AMOUNT_RE.test(x)) return BigInt(x);
  return null;
}

/** Como `amountOrNull`, pero lanza. Para lecturas de JSON en las que el campo debe estar bien. */
export function toAmount(x: unknown): bigint {
  const v = amountOrNull(x);
  if (v === null) throw new Error(`Importe no válido: ${String(x)}`);
  return v;
}

/** Acepta también enteros `number` seguros (entradas de API y pruebas, NUNCA consenso). */
export function looseAmount(x: unknown): bigint | null {
  if (typeof x === "number") return Number.isSafeInteger(x) && x >= 0 ? BigInt(x) : null;
  return amountOrNull(x);
}

/** Texto decimal (formato de red) de un importe. */
export const amountText = (x: bigint) => x.toString();

/** a × b / c con suelo (BigInt). */
export const mulDivBig = (a: bigint, b: bigint, c: bigint): bigint => (a * b) / c;
export const minBig = (a: bigint, b: bigint) => (a < b ? a : b);
export const maxBig = (a: bigint, b: bigint) => (a > b ? a : b);
export const sumBig = (xs: Iterable<bigint>) => { let t = 0n; for (const x of xs) t += x; return t; };

// ---------- Formato y lectura para personas ----------
/** Separadores de miles y decimales de un locale (por defecto es-ES: «1.234,5»). */
export function separators(locale = "es-ES"): { group: string; decimal: string } {
  try {
    const parts = new Intl.NumberFormat(locale).formatToParts(1234567.5);
    const group = parts.find((p) => p.type === "group")?.value ?? ".";
    const decimal = parts.find((p) => p.type === "decimal")?.value ?? ",";
    return { group: group === " " || group === " " ? " " : group, decimal };
  } catch {
    return locale.startsWith("en") ? { group: ",", decimal: "." } : { group: ".", decimal: "," };
  }
}

export interface FormatOptions {
  /** Decimales del token (VEL: 18). */
  decimals?: number;
  /** Máximo de decimales a mostrar (se TRUNCA, nunca se redondea hacia arriba). Por defecto, todos los significativos. */
  maxDecimals?: number;
  /** Mínimo de decimales a mostrar (rellena con ceros). */
  minDecimals?: number;
  /** Locale para los separadores. Por defecto es-ES. */
  locale?: string;
  /** Símbolo detrás ("VEL"). Vacío o ausente: sin símbolo. */
  symbol?: string;
}

/**
 * Unidades mínimas → texto para personas. `formatUnits(1500000000000000000n)` → "1,5".
 * Acepta BigInt, texto decimal o `number` entero (solo por comodidad de UI antigua).
 */
export function formatUnits(units: bigint | string | number, o: FormatOptions = {}): string {
  const decimals = o.decimals ?? VEL_DECIMALS;
  let v: bigint;
  if (typeof units === "bigint") v = units;
  else if (typeof units === "number") v = BigInt(Math.trunc(units));
  else v = /^-?\d+$/.test(units) ? BigInt(units) : 0n;
  const neg = v < 0n;
  if (neg) v = -v;
  const { group, decimal } = separators(o.locale);
  const div = 10n ** BigInt(decimals);
  const int = (v / div).toString().replace(/\B(?=(\d{3})+(?!\d))/g, group);
  let frac = decimals > 0 ? (v % div).toString().padStart(decimals, "0") : "";
  frac = frac.slice(0, Math.min(decimals, o.maxDecimals ?? decimals)).replace(/0+$/, "");
  if (o.minDecimals && frac.length < o.minDecimals) frac = frac.padEnd(Math.min(o.minDecimals, decimals), "0");
  const txt = (neg ? "-" : "") + int + (frac ? decimal + frac : "");
  return o.symbol ? `${txt} ${o.symbol}` : txt;
}

/**
 * Texto de una persona → unidades mínimas (BigInt). null si no es válido o tiene más decimales de los que admite el token.
 *  · Con `locale`: se quitan sus separadores de miles y se usa su separador decimal ("1.234,56" en es-ES).
 *  · Sin `locale`: si aparecen «.» y «,», el último es el decimal y el otro de miles; si aparece uno solo, es el decimal.
 */
export function parseUnits(text: string, decimals = VEL_DECIMALS, locale?: string): bigint | null {
  let t = String(text ?? "").trim().replace(/[\s  ']/g, "");
  if (!t) return null;
  let dec: string | null = null;
  if (locale) {
    const sep = separators(locale);
    if (sep.group.trim()) t = t.split(sep.group).join("");
    dec = sep.decimal;
  } else {
    const lastDot = t.lastIndexOf("."), lastComma = t.lastIndexOf(",");
    if (lastDot >= 0 && lastComma >= 0) {
      dec = lastDot > lastComma ? "." : ",";
      t = t.split(dec === "." ? "," : ".").join("");
    } else dec = lastDot >= 0 ? "." : lastComma >= 0 ? "," : null;
  }
  const parts = dec ? t.split(dec) : [t];
  if (parts.length > 2) return null;
  const [i, f = ""] = parts as [string, string?];
  if (!/^\d*$/.test(i) || !/^\d*$/.test(f) || (i === "" && f === "")) return null;
  if (f.length > decimals) return null;
  return BigInt(i || "0") * 10n ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
}
