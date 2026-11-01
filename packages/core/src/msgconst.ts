// Constantes de la mitad de mensajería (docs/protocolo-v2.md §1–6). No afectan al consenso.

/** Cubos de relleno: el sobre siempre mide exactamente uno de estos tamaños (§3). */
export const BUCKETS = [2, 8, 32, 128, 512, 2048, 8192].map((k) => k * 1024);
export const MAX_ENVELOPE_BYTES = BUCKETS[BUCKETS.length - 1]!;

/** Reed–Solomon: basta con RS_K trozos cualesquiera de cada RS_N. */
export const RS_K = 3;
export const RS_N = 5;
/** Tamaño máximo de trozo (se redondea a 1 KB). */
export const MAX_SHARD_BYTES = 24 * 1024;
/** Los trozos no entregados caducan a los 7 días. */
export const SHARD_TTL_V2_MS = 7 * 24 * 3600 * 1000;

export const DAY_MS = 86_400_000;
/** Margen de reloj aceptado en pruebas de apertura y recibos (±15 min). */
export const CLOCK_SKEW_MS = 15 * 60 * 1000;

/** Multidispositivo y prellaves. */
export const MAX_DEVICES = 5;
export const PREKEY_ROTATE_MS = 24 * 3600 * 1000;
export const PREKEY_RETAIN_MS = 7 * 24 * 3600 * 1000;

/** Vinculación por QR que rota. */
export const LINK_FRAME_MS = 2_000;
export const LINK_FRAME_TTL_MS = 6_000;
/** Una sesión de vínculo caduca a los 5 minutos. */
export const LINK_SESSION_TTL_MS = 5 * 60 * 1000;
/** Lote de historial por mensaje de vínculo (antes de comprimir). */
export const LINK_BATCH_BYTES = 256 * 1024;

/** Etiquetas de derivación (HKDF / HMAC). */
export const INFO = {
  identity: "velum/v2/identity",
  wallet: (i: number) => `velum/v2/wallet/${i}`,
  mailbox: "velum/v2/mailbox",
  envelope: "velum/v2/envelope",
  wrap: "velum/v2/envelope/wrap",
  link: "velum/v2/link",
} as const;

/** Versión del sobre (primer byte). */
export const ENVELOPE_VERSION = 2;
