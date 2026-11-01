// Parámetros de consenso por red. Cambiarlos rompe el consenso: van con el CHAIN_ID.
// `VELUM_NETWORK=mainnet|testnet` (por defecto mainnet) elige la red al compilar o arrancar (network.ts).
// Toda la economía usa enteros (µVEL, puntos básicos). Nada de decimales en la máquina de estados.
import { IS_MAINNET, NETWORK, TESTNET_GENESIS_TIME } from "./network";

export { NETWORK, IS_MAINNET };
export const CHAIN_ID = IS_MAINNET ? "velum-mainnet-1" : "velum-testnet-3";
/** Versión de protocolo más alta que conoce este núcleo (mainnet empieza en 1; la tabla está en upgrades.ts). */
export const PROTOCOL_VERSION = IS_MAINNET ? 1 : 3;

/** 1 VEL = 1.000.000 µVEL. Todo importe en la cadena va en µVEL (entero). */
export const UNIT = 1_000_000;
/** Símbolo de la moneda nativa. */
export const VEL = "VEL";

// ---------- Oferta limitada (protocolo-v2 §7) ----------
/** Tope absoluto de VEL acuñables en toda la historia (µVEL). `supply.minted` nunca lo supera. */
export const MAX_SUPPLY = 1_000_000_000 * UNIT;
/** Génesis: 100 M VEL (10 %). Mainnet: a la cartera fría (genesis/mainnet.json). Testnet: al grifo. */
export const GENESIS_RESERVE_SUPPLY = 100_000_000 * UNIT;
/** @deprecated nombre de testnet. Es GENESIS_RESERVE_SUPPLY. */
export const GENESIS_FAUCET_SUPPLY = GENESIS_RESERVE_SUPPLY;
/** Lo que se puede ganar trabajando: 900 M VEL. */
export const MINEABLE_SUPPLY = MAX_SUPPLY - GENESIS_RESERVE_SUPPLY;

// ---------- Comisiones (protocolo-v3 §5: sin quema) ----------
/** @deprecated v2 (comisión fija). En v3 la comisión depende del valor en EUR (`requiredFee`). */
export const FEE = 1_000;
/** Por debajo de 1.000 € (µEUR) los pagos y operaciones no pagan comisión: llevan sello PoW. */
export const FEE_FREE_EUR = 1_000 * 1_000_000;
/**
 * Mainnet: el umbral va en USDT dentro del consenso (1.100 vUSDT ≈ 1.000 € a 0,92 €/$; docs/mainnet.md §3).
 * El euro solo se muestra fuera de la cadena. µUSDT.
 */
export const FEE_FREE_USDT = 1_100 * 1_000_000;
/** Desde el umbral: 1 punto básico (0,01 %) del importe en VEL, mínimo 1 µVEL. */
export const FEE_BP = 1;
/** @deprecated v2. El mercado usa la misma regla que los pagos (FEE_BP desde 1.000 €). */
export const MARKET_FEE_BP = FEE_BP;
/** @deprecated v2. */
export const MARKET_FEE_MIN = 1;
/** Crear un token cuesta 100 VEL, que van enteros a la Reserva de la Red (antispam). */
export const TOKEN_CREATE_FEE = 100 * UNIT;
/** Reparto de toda comisión (pb): 80 % bolsa de nodos, 20 % Reserva de la Red. No se quema nada. */
export const FEE_SPLIT_BP = { pool: 8_000, reserve: 2_000 } as const;
/** @deprecated v1 (fracciones). Usa FEE_SPLIT_BP. */
export const FEE_SPLIT = { pool: 0.8, reserve: 0.2 } as const;
/** Base de los puntos básicos. */
export const BP = 10_000;
/** La Reserva devuelve cada época este tanto (pb sobre 10.000 → 10 = 0,1 %) de su saldo a la bolsa de nodos. */
export const RESERVE_RELEASE_BP = 10;

/** Cuentas especiales (no tienen clave privada). */
/** @deprecated v2: en v3 no se quema VEL; la cuenta queda a 0. */
export const BURN_ADDRESS = "vel_burn";
/** @deprecated v2: en v3 las comisiones no van a tesorería. */
export const TREASURY_ADDRESS = "vel_treasury";
/** Reserva de la Red: sin clave; solo la regla de liberación (0,1 %/época) saca de ella. */
export const RESERVE_ADDRESS = "vel_reserve";
export const POOL_ADDRESS = "vel_pool";
/** Donde quedan bloqueados los fondos de órdenes, bolsas de token y fianzas de nodo (contabilidad interna). */
export const ESCROW_ADDRESS = "vel_escrow";

/** Ritmo nominal de bloque (el explorador muestra el medido). */
export const BLOCK_MS = 2_000;
/** Bloques por época. Testnet: 30 (≈ 1 min). Mainnet: 1.800 (≈ 1 h, protocolo-v3 §4). */
export const EPOCH_BLOCKS = IS_MAINNET ? 1_800 : 30;
/** Duración nominal de una época y equivalencias (testnet: 1 min). */
export const EPOCH_MS = EPOCH_BLOCKS * BLOCK_MS;
export const EPOCHS_PER_DAY = Math.floor(86_400_000 / EPOCH_MS);
export const MONTH_EPOCHS = 30 * EPOCHS_PER_DAY;
/** Épocas entre mitades ≈ 2 años (testnet: 1.051.200 de 1 min; mainnet: 17.520 de 1 h). */
export const HALVING_EPOCHS = 730 * EPOCHS_PER_DAY;
/**
 * Descubrimiento de la época 0 (µVEL): floor(900 M VEL / (2 × HALVING_EPOCHS)).
 * Testnet 428,082191 VEL por época de 1 min; mainnet 25.684,931506 VEL por época de 1 h.
 * Con suelo entero, Σ HALVING × floor(R0 / 2^k) < 2 × R0 × HALVING ≤ 900 M VEL (se comprueba en los tests).
 */
export const R0 = Math.floor(MINEABLE_SUPPLY / (2 * HALVING_EPOCHS));
/** @deprecated v1. Se mantiene por compatibilidad: es R0. */
export const EPOCH_EMISSION = R0;
/** Un nodo está "activo" si ha dado señal de vida en los últimos N bloques. */
export const PRESENCE_WINDOW = 15;
/** Parte de la bolsa de cada época para quien produce bloques (pb). El resto, por trabajo verificado. */
export const PRODUCER_SHARE_BP = 1_500;
/** @deprecated v1. Usa PRODUCER_SHARE_BP. */
export const PRODUCER_SHARE = 0.15;

// ---------- Nodos ----------
export type NodeKind = "full" | "light";
/** Regiones gruesas que un nodo puede declarar (solo para que el cliente filtre; sin efecto en consenso). */
export const REGIONS = ["AF", "AS", "EU", "NA", "OC", "SA"] as const;
export type Region = (typeof REGIONS)[number];
/** @deprecated v2: en v3 el tipo de nodo pesa en el sorteo (2 completo / 1 ligero), no en el cobro. */
export const LIGHT_NODE_MULT_BP = 5_000;
/** @deprecated v2. */
export const FULL_NODE_MULT_BP = BP;

/**
 * Niveles por antigüedad continua (protocolo-v3 §2). Los multiplicadores (pb) pesan en el sorteo y
 * reparten la misma bolsa: nunca acuñan de más. `minMonths` del Pilar es dinámico (`pillarMonths`).
 * `minPresencePct`: % de épocas con señal de vida dentro de la racha.
 */
export const TIERS = [
  { id: "nuevo", name: "Nuevo", multBp: 5_000, mult: 0.5, minMonths: 0, minPresencePct: 0 },
  { id: "activo", name: "Activo", multBp: 6_500, mult: 0.65, minMonths: 1, minPresencePct: 90 },
  { id: "veterano", name: "Veterano", multBp: 8_500, mult: 0.85, minMonths: 3, minPresencePct: 95 },
  { id: "pilar", name: "Pilar", multBp: 10_000, mult: 1.0, minMonths: -1, minPresencePct: 98 },
] as const;
export type TierId = (typeof TIERS)[number]["id"];
/** Una ausencia de más de 48 h seguidas reinicia la racha de servicio continuo. */
export const STREAK_GAP_EPOCHS = 2 * EPOCHS_PER_DAY;
/** Meses exigidos al Pilar: min(12, 6 + floor(edadRedMeses / 4)). */
export const pillarMonths = (networkAgeMonths: number) => Math.min(12, 6 + Math.floor(Math.max(0, networkAgeMonths) / 4));

/** Fianza opcional: hasta 10.000 VEL suben el peso en el sorteo hasta ×2. Desbloqueo con 14 días de espera. */
export const BOND_CAP = 10_000 * UNIT;
export const BOND_UNBOND_EPOCHS = 14 * EPOCHS_PER_DAY;
/** Desbloqueos pendientes por nodo (acota el estado). */
export const MAX_UNBONDING = 8;

// ---------- Reclamaciones de trabajo (§4) ----------
/** Hojas que la baliza elige de cada reclamación. */
export const CLAIM_SAMPLES = 16;
/** Tope de verosimilitud: lo acreditado no pasa de esperado × 1,5 (num/den). */
export const CLAIM_CAP_NUM = 3;
export const CLAIM_CAP_DEN = 2;
/** Máximo de hojas por reclamación. */
export const CLAIM_MAX_COUNT = 2 ** 32;
/** Una hoja puede citar fotos de hasta 10 épocas antes de la reclamada (las que aún se guardan al probar). */
export const CLAIM_LEAF_MAX_AGE = 10;
/** Calendario: reclamar en E+1, muestras con la baliza de E+3, probar en E+3/E+4, liquidar al cerrar E+4. */
export const CLAIM_SAMPLE_LAG = 3;
export const CLAIM_SETTLE_LAG = 4;

// ---------- Prueba de trabajo antispam (§5) ----------
export const POW_MIN_BITS = 16;
export const POW_MAX_BITS = 26;
/** Bits extra para registrar o renovar un alias (~1 M hashes: ≈ 5 s en un móvil). */
export const NAME_POW_EXTRA_BITS = 4;
/** Tx con sello por época a partir de las que sube la dificultad (y por debajo de 1/4, baja): 3.000 por minuto. */
export const POW_TARGET_PER_EPOCH = 3_000 * Math.max(1, Math.round(EPOCH_MS / 60_000));

// ---------- Oráculo (§6) ----------
/**
 * Pares del oráculo y moneda que representan (USDT se convierte 1:1 a USD).
 * Mainnet: solo `VEL/vUSDT` (sin EUR en consenso). Testnet: tEUR, tUSD y tUSDT.
 */
export const ORACLE_PAIRS: Partial<Record<"eur" | "usd" | "usdt", string>> = IS_MAINNET
  ? { usdt: "VEL/vUSDT" }
  : { eur: "VEL/tEUR", usd: "VEL/tUSD", usdt: "VEL/tUSDT" };
/** Token que representa cada moneda del oráculo. */
export const ORACLE_TOKENS: Record<string, "eur" | "usd" | "usdt"> = IS_MAINNET ? { vUSDT: "usdt" } : { tEUR: "eur", tUSD: "usd", tUSDT: "usdt" };
/** Ventana TWAP: la última hora (60 épocas de 1 min en testnet; 1 época en mainnet). */
export const ORACLE_WINDOW_EPOCHS = Math.max(1, Math.round(3_600_000 / EPOCH_MS));
/** Volumen mínimo en la ventana para fiarse de un par. */
export const ORACLE_MIN_VOLUME = 1_000 * UNIT;
/** Precio máximo que cuenta (µunidad por VEL): acota sumas y manipulación. */
export const ORACLE_MAX_PRICE = 1e12;
/** Semilla de cambio EUR por USD (µEUR por 1 USD) hasta que la red vea los dos pares a la vez. */
export const ORACLE_FX_EUR_PER_USD = 920_000;

// ---------- Alias (§7) ----------
export const NAME_RE = /^[a-z0-9_.]{3,24}$/;
export const NAME_TERM_EPOCHS = 365 * EPOCHS_PER_DAY;
/** Tarjeta de contacto en la cadena: tamaño máximo (texto base58). */
export const CARD_MAX_CHARS = 2_400;

// ---------- Recibos v2 (§4) ----------
/** Antitrampas: por época, un par (nodo, buzón) suma como máximo estos créditos. */
export const PAIR_CAP_PER_EPOCH = 400;
/** Recibos fuera de ±15 min respecto al bloque no cuentan. */
export const RECEIPT_WINDOW_MS = 15 * 60_000;
/** Cuánto recordamos recibos ya contados (épocas). */
export const RECEIPT_MEMORY_EPOCHS = 20;
/** Fotos de nodos para el sorteo de rutas que guarda el estado (épocas). Un recibo puede citar cualquiera de ellas. */
export const LOTTERY_KEEP_EPOCHS = 16;
/** Un nodo entra en la foto si dio señal de vida en los últimos N bloques (10 min): los apagados no absorben sorteos. */
export const LOTTERY_PRESENCE_BLOCKS = 300;
/** Épocas de historial de dificultad que guarda el estado (para el explorador). */
export const DIFFICULTY_HISTORY = 1_440;

// ---------- Tokens (§8) ----------
export const TOKEN_SYMBOL_RE = /^[A-Z0-9]{3,8}$/;
export const TOKEN_MAX_DECIMALS = 9;
/** Las bolsas de token duran como mucho ~1 año de épocas. */
export const POOL_MAX_EPOCHS = 365 * EPOCHS_PER_DAY;

// ---------- Mercado (§9) ----------
/** Orden mínima: 1 VEL (evita polvo en el libro). */
export const MIN_ORDER = 1 * UNIT;
/** Caducidad por defecto y máxima de una orden (épocas): 7 días y 30 días. */
export const ORDER_TTL_DEFAULT = 7 * EPOCHS_PER_DAY;
export const ORDER_TTL_MAX = 30 * EPOCHS_PER_DAY;
/** Órdenes abiertas por cuenta. */
export const MAX_OPEN_ORDERS = 50;
/** Últimas operaciones que guarda el estado (anillo) para el explorador. */
export const TRADE_LOG = 500;
/** Precio máximo (µtoken por VEL): evita desbordes. */
export const MAX_PRICE = 1e15;

// ---------- Atestación (§11) ----------
export type AttestationMode = "off" | "soft" | "strict";
/** testnet: se registra pero no bloquea (los simuladores no pueden atestar). Mainnet también «soft» en cadena:
 *  el modo estricto se aplica en la puerta y el nodo al dar servicio (docs/mainnet.md §4), no al validar bloques. */
export const ATTESTATION_MODE: AttestationMode = "soft";
export const APP_ATTEST_APP_ID = "D58V3B3XNT.com.consultorabim.velum";

// ---------- Mensajería (los usa shards.ts) ----------
/** Fragmentos: trozos de 24 KB, en franjas de 4 datos + 1 de paridad (se recupera si se pierde uno). */
export const SHARD_BYTES = 24 * 1024;
export const STRIPE = 4;
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;
/** Los fragmentos no entregados caducan a los 7 días. */
export const SHARD_TTL_MS = 7 * 24 * 3600 * 1000;

/** Grifo de la testnet: clave pública conocida, solo existe en pruebas. En mainnet NO hay grifo. */
export const HAS_FAUCET = !IS_MAINNET;
export const FAUCET_SEED_TEXT = "velum-testnet-1/faucet";
export const FAUCET_DRIP = 25 * UNIT;
/** Hora de génesis de testnet. En mainnet la fija genesis/mainnet.json: usa `genesisTime()` (genesis.ts). */
export const GENESIS_TIME = TESTNET_GENESIS_TIME; // 1 nov 2026

// ---------- Pasarela USDT ⇄ vUSDT (docs/mainnet.md §6) ----------
/** Token envuelto: 1 vUSDT = 1 USDT guardado por la pasarela. Solo existe en mainnet. */
export const BRIDGE_TOKEN = "vUSDT";
export const BRIDGE_CHAINS = ["tron", "polygon", "ethereum"] as const;
export type BridgeChain = (typeof BRIDGE_CHAINS)[number];
/** Canje mínimo en consenso (µvUSDT). La pasarela puede pedir más y devuelve lo que no paga. */
export const BRIDGE_MIN_REDEEM = 1_000_000;
export const BRIDGE_REF_MAX = 160;

// ---------- Staking delegado (docs/ecosistema.md §6) ----------
export const MIN_DELEGATION = 1 * UNIT;
/** Delegados por nodo: acota el trabajo de cada cierre de época. */
export const MAX_DELEGATORS_PER_NODE = 1_000;
/** Comisión del nodo sobre lo que descubre con delegación (pb): por defecto 10 %, máximo 20 %. */
export const COMMISSION_DEFAULT_BP = 1_000;
export const COMMISSION_MAX_BP = 2_000;
export const COMMISSION_MAX_STEP_BP = 500;
export const COMMISSION_COOLDOWN_EPOCHS = 7 * EPOCHS_PER_DAY;

/**
 * Puertas de entrada públicas (Worker), en orden: velumprotocol.org (principal), dominio de BIM y workers.dev de respaldo
 * (algunos operadores, p. ej. Digi, no resuelven todos los dominios): clientes y nodos saltan a la siguiente si falla.
 */
export const GATEWAYS = ["wss://velumprotocol.org/hub", "wss://velum.consultorabim.com/hub", "wss://velum.consultora-bim.workers.dev/hub"] as const;
/** Origen público de la web (enlaces /@alias, /c/<tarjeta>, /i/<invitación>, explorador, manifiesto). */
export const PUBLIC_ORIGIN = "https://velumprotocol.org";
export const DEFAULT_GATEWAY = GATEWAYS[0];
export const NODE_PORT = 7420;
