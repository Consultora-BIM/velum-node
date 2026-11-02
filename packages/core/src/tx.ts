// Transacciones, recibos de entrega (v2, anónimos) y bloques (cadena v3).
// Todas las transacciones las firma la clave de CARTERA (`from` = dirección de cartera; en las de nodo, la del nodo).
// `checkTx` comprueba formato y firma (sin estado); el saldo, el nonce, la comisión mínima, el sello PoW y
// las reglas con estado van en `applyTx` (state.ts).
// v4: los importes son BigInt (`Amount`). En la red viajan como texto decimal; `normalizeTx` los pasa a BigInt.
// Firma y txId no cambian: la codificación canónica de 5n y de "5" es la misma ("5").
import { canonical, hashObj, merkleRoot } from "./bytes";
import { type Amount, amountOrNull } from "./amount";
import {
  COMMISSION_MAX_BP, CREDIT_MIN_BUY, CARD_MAX_CHARS, CHAIN_ID, CLAIM_MAX_COUNT, CLAIM_SAMPLES, MAX_PRICE, MIN_ORDER, NAME_RE, ORDER_TTL_MAX, POOL_MAX_EPOCHS,
  REGIONS, TOKEN_CREATE_FEE, TOKEN_MAX_DECIMALS, TOKEN_SYMBOL_RE, VEL, type NodeKind, type Region,
} from "./constants";
import { sign, verify, isAddress } from "./keys";
import { type ReceiptV2, checkReceiptProof } from "./proof";
import type { WorkLeaf } from "./claims";
import { cardProblem } from "./names";
import { isBridgeChain, isBridgeDestination, isBridgeRef } from "./bridge";

interface TxBase {
  chain: string;
  /** Dirección de cartera que firma. */
  from: string;
  /** Nº de transacciones previas de `from`. */
  nonce: number;
  /** Hora del cliente (informativa: la máquina de estados usa la del bloque). */
  ts: number;
  /** Sello de prueba de trabajo (pow.ts). Obligatorio en las tx sin comisión. */
  pow?: number;
  sig: string;
}

/** Pago de cartera a cartera, en VEL o en un token. Comisión en VEL: 0 bajo 1.000 € (con sello PoW), 1 pb desde 1.000 €. */
export interface TransferTx extends TxBase {
  type: "transfer";
  to: string;
  amount: Amount; // unidades mínimas del token (velos si es VEL)
  /** Velos. Mínimo `requiredFee` (state.ts); si es 0 hace falta sello PoW. */
  fee: Amount;
  /** Token a enviar; ausente = VEL. */
  token?: string;
  /** Nota opcional (un hash o texto corto; nunca el contenido de un chat). */
  memo?: string;
}

/** Alta de un nodo (gratis). Completo: produce bloques. Ligero (móvil): solo entrega trozos. */
export interface RegisterTx extends TxBase {
  type: "register";
  /** Opcional y decorativo (ni obligatorio ni único). */
  name?: string;
  /** Dirección que cobra las recompensas. */
  payout: string;
  endpoint?: string;
  version: string;
  /** Ausente = "full" (compatibilidad v1). */
  kind?: NodeKind;
  /** Región gruesa (continente) para que el cliente filtre candidatos. Sin efecto en consenso. */
  region?: Region;
}

/** Crea un token propio. Cuesta TOKEN_CREATE_FEE en VEL (a la Reserva). El creador queda como emisor. */
export interface TokenCreateTx extends TxBase {
  type: "token.create";
  symbol: string;
  name: string;
  decimals: number;
  maxSupply: Amount;
  initial: Amount;
  mintable: boolean;
  fee: Amount; // TOKEN_CREATE_FEE
}

/** Emite más unidades (solo el emisor, hasta maxSupply). */
export interface TokenMintTx extends TxBase {
  type: "token.mint";
  symbol: string;
  to: string;
  amount: Amount;
  fee: Amount; // 0 + sello PoW (o lo que quiera pagar)
}

/** Reparte `amount` de un token entre los nodos durante `epochs` épocas, según su trabajo. */
export interface PoolFundTx extends TxBase {
  type: "pool.fund";
  token: string;
  amount: Amount;
  epochs: number;
  fee: Amount; // 0 + sello PoW (o lo que quiera pagar)
}

/** Orden en el libro `VEL/<token>`. price (number entero) en unidades mínimas del token por 1 VEL; amount en velos. Lleva sello PoW. */
export interface OrderPlaceTx extends TxBase {
  type: "order.place";
  pair: string;
  side: "buy" | "sell";
  price: number;
  amount: Amount;
  /** Caducidad en épocas (por defecto ORDER_TTL_DEFAULT). */
  ttl?: number;
}

export interface OrderCancelTx extends TxBase {
  type: "order.cancel";
  id: string;
}

/** Registra un dispositivo auténtico (App Attest). Solo se guarda el hash de su clave. */
export interface DeviceAttestTx extends TxBase {
  type: "device.attest";
  /** sha256(clave pública del dispositivo), hex. Es el `clientDataHash` que la app pasó a App Attest. */
  device: string;
  /** keyId de App Attest (base64 = sha256 de la clave del Secure Enclave). */
  keyId: string;
  /** Objeto de atestación CBOR en base64. */
  attestation: string;
}

/** Fianza opcional de un nodo (`from` = nodo): sube su peso en el sorteo hasta ×2. */
export interface NodeBondTx extends TxBase {
  type: "node.bond";
  amount: Amount;
}

/** Desbloquea fianza: vuelve al nodo tras 14 días. */
export interface NodeUnbondTx extends TxBase {
  type: "node.unbond";
  amount: Amount;
}

/** Reclamación de trabajo de la época `epoch` (`from` = nodo): nº de hojas y raíz de Merkle SHA-512. */
export interface WorkClaimTx extends TxBase {
  type: "work.claim";
  epoch: number;
  count: number;
  root: string;
}

/** Prueba de las hojas que eligió la baliza y sus vecinas (orden de `proofIndices(claimSamples(…))`). */
export interface WorkProveTx extends TxBase {
  type: "work.prove";
  epoch: number;
  leaves: WorkLeaf[];
  paths: string[][];
}

/** Alias único (uno por cartera, 1 año). `card` = tarjeta de contacto (base58, names.ts). Sello PoW grande. */
export interface NameRegisterTx extends TxBase {
  type: "name.register";
  name: string;
  card: string;
}

export interface NameRenewTx extends TxBase {
  type: "name.renew";
  name: string;
  /** Tarjeta nueva (opcional): así se rota la prellave de primer contacto. */
  card?: string;
}

export interface NameReleaseTx extends TxBase {
  type: "name.release";
  name: string;
}

/** Pasarela: acuña vUSDT por un depósito confirmado. Solo la autoridad de la pasarela. `ref` única. */
export interface BridgeMintTx extends TxBase {
  type: "bridge.mint";
  to: string;
  /** µvUSDT (6 decimales). */
  amount: Amount;
  /** Cadena del depósito. */
  src: "tron" | "polygon" | "ethereum";
  /** `<cadena>:<hash>:<índice>` o `refund:<id de canje>`. */
  ref: string;
}

/** Canje: el usuario cambia vUSDT por USDT en `dst`. Ese vUSDT sale de la circulación (se paga fuera). Lleva sello. */
export interface BridgeRedeemTx extends TxBase {
  type: "bridge.redeem";
  dst: "tron" | "polygon" | "ethereum";
  to: string;
  /** µvUSDT (6 decimales). */
  amount: Amount;
  fee: Amount;
}

/** Staking: delegar VEL a un nodo (suma a su peso en el sorteo). Lleva sello. */
export interface StakeDelegateTx extends TxBase { type: "stake.delegate"; node: string; amount: Amount }
/** Staking: retirar delegación (vuelve tras 14 días). Lleva sello. */
export interface StakeUndelegateTx extends TxBase { type: "stake.undelegate"; node: string; amount: Amount }
/** El nodo (`from`) fija su comisión sobre lo que descubre con delegación: 0–2.000 pb. Lleva sello. */
export interface NodeCommissionTx extends TxBase { type: "node.commission"; bp: number }
/**
 * Créditos de mensajería (v4): convierte `amount` velos en créditos NO transferibles para `to` (por defecto `from`).
 * Para empresas y bots que envían por encima del cupo gratuito. El VEL va entero a la bolsa de nodos de la época.
 * Créditos = floor(amount × precio USDT del oráculo / 10^18 / CREDIT_PRICE_USDT). Sin precio no entra. Lleva sello.
 */
export interface CreditsBuyTx extends TxBase { type: "credits.buy"; amount: Amount; to?: string; fee: Amount }
/**
 * HTLC (htlc.ts, docs/intercambio-p2p.md): bloquea `amount` para `to` hasta la época `expiresEpoch`. Lo cobra `to` con el
 * secreto cuyo sha256 es `hash`; si caduca, vuelve a `from`. Las tres llevan sello y no tienen comisión.
 */
export interface HtlcLockTx extends TxBase { type: "htlc.lock"; to: string; amount: Amount; token?: string; hash: string; expiresEpoch: number }
export interface HtlcClaimTx extends TxBase { type: "htlc.claim"; id: string; preimage: string }
export interface HtlcRefundTx extends TxBase { type: "htlc.refund"; id: string }

export type Tx =
  | TransferTx | RegisterTx | TokenCreateTx | TokenMintTx | PoolFundTx | OrderPlaceTx | OrderCancelTx | DeviceAttestTx
  | NodeBondTx | NodeUnbondTx | WorkClaimTx | WorkProveTx | NameRegisterTx | NameRenewTx | NameReleaseTx
  | BridgeMintTx | BridgeRedeemTx | StakeDelegateTx | StakeUndelegateTx | NodeCommissionTx | CreditsBuyTx
  | HtlcLockTx | HtlcClaimTx | HtlcRefundTx;
export type TxType = Tx["type"];

export const txId = (tx: Tx) => hashObj(tx).slice(0, 48);

export function signTx<T extends Omit<Tx, "sig">>(secret: string, tx: T): T & { sig: string } {
  const { sig: _drop, ...rest } = tx as T & { sig?: string };
  return { ...(rest as T), sig: sign(secret, canonical(rest)) };
}

export function verifyTxSig(tx: Tx): boolean {
  const { sig, ...rest } = tx;
  return typeof sig === "string" && verify(tx.from, canonical(rest), sig);
}

export const isSafeUint = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Campos de importe (BigInt en memoria, texto decimal en la red) de cada tipo de tx. */
export const TX_AMOUNT_FIELDS: Partial<Record<TxType, readonly string[]>> = {
  "transfer": ["amount", "fee"],
  "token.create": ["maxSupply", "initial", "fee"],
  "token.mint": ["amount", "fee"],
  "pool.fund": ["amount", "fee"],
  "order.place": ["amount"],
  "node.bond": ["amount"],
  "node.unbond": ["amount"],
  "bridge.mint": ["amount"],
  "bridge.redeem": ["amount", "fee"],
  "stake.delegate": ["amount"],
  "stake.undelegate": ["amount"],
  "credits.buy": ["amount", "fee"],
  "htlc.lock": ["amount"],
};

/**
 * Copia de la tx con los importes en BigInt (desde texto decimal o BigInt). Un `number` en un campo de importe
 * es un error: así una tx v3 (µVEL) nunca se confunde con una v4 (velos). La firma no cambia (canonical).
 */
export function normalizeTx<T extends Tx>(tx: T): { tx: T } | { error: string } {
  if (!tx || typeof tx !== "object") return { error: "Tx mal formada" };
  const fields = TX_AMOUNT_FIELDS[tx.type];
  if (!fields) return { tx };
  const out: any = { ...tx };
  for (const f of fields) {
    const v = (tx as any)[f];
    if (v === undefined) continue;
    const a = amountOrNull(v);
    if (a === null) return { error: `Importe no válido (${f}: texto decimal en velos)` };
    out[f] = a;
  }
  return { tx: out };
}

/** Importe ya normalizado y positivo. */
const isPositive = (n: unknown): n is bigint => typeof n === "bigint" && n > 0n;
/** Importe ya normalizado (≥ 0). */
const isAmt = (n: unknown): n is bigint => typeof n === "bigint" && n >= 0n;
/** Símbolo de token válido como clave (incluye los de génesis `tEUR`/`tUSD`/`tUSDT`, que no se pueden crear). */
export const isTokenKey = (s: unknown): s is string => typeof s === "string" && /^[A-Za-z0-9]{3,8}$/.test(s);
export const isNewTokenSymbol = (s: unknown): s is string => typeof s === "string" && TOKEN_SYMBOL_RE.test(s) && s !== VEL;
export const pairOf = (token: string) => `${VEL}/${token}`;
export function tokenOfPair(pair: unknown): string | null {
  if (typeof pair !== "string" || !pair.startsWith(VEL + "/")) return null;
  const t = pair.slice(VEL.length + 1);
  return isTokenKey(t) && t !== VEL ? t : null;
}
const B64_RE = /^[A-Za-z0-9+/=_-]+$/;
const H128_RE = /^[0-9a-f]{128}$/;

/** Formato de una hoja de trabajo (sin estado). */
function leafProblem(l: unknown): string | null {
  if (!l || typeof l !== "object") return "Hoja no válida";
  const { r, role } = l as WorkLeaf;
  if (role !== "carrier" && role !== "courier") return "Papel no válido";
  if (Object.keys(l).length !== 2) return "Hoja con campos de más";
  if (!verifyReceipt(r) || r.ep === undefined) return "Recibo de la hoja no válido";
  return null;
}

/** Comprobación sin estado (formato y firma). El saldo, el nonce y las reglas de negocio van en applyTx. */
export function checkTx(raw: Tx): string | null {
  if (!raw || typeof raw !== "object" || raw.chain !== CHAIN_ID) return "Cadena incorrecta";
  const n = normalizeTx(raw);
  if ("error" in n) return n.error;
  const tx = n.tx;
  if (!isAddress(tx.from)) return "Remitente no válido";
  if (!isSafeUint(tx.nonce)) return "Nonce no válido";
  if (typeof tx.ts !== "number" || !Number.isFinite(tx.ts)) return "Hora no válida";
  if (tx.pow !== undefined && !isSafeUint(tx.pow)) return "Sello no válido";
  switch (tx.type) {
    case "transfer":
      if (!isAddress(tx.to)) return "Destino no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (!isAmt(tx.fee)) return "Comisión no válida";
      if (tx.token !== undefined && (!isTokenKey(tx.token) || tx.token === VEL)) return "Token no válido";
      if (tx.memo !== undefined && (typeof tx.memo !== "string" || tx.memo.length > 128)) return "Nota demasiado larga";
      break;
    case "register":
      if (!isAddress(tx.payout)) return "Cartera de cobro no válida";
      // Nombre opcional y solo decorativo: un nodo es su dirección (no hace falta, no es único).
      if (tx.name !== undefined && (typeof tx.name !== "string" || tx.name.length > 40)) return "Nombre no válido";
      if (typeof tx.version !== "string" || tx.version.length > 32) return "Versión no válida";
      if (tx.endpoint !== undefined && (typeof tx.endpoint !== "string" || tx.endpoint.length > 200)) return "Endpoint no válido";
      if (tx.kind !== undefined && tx.kind !== "full" && tx.kind !== "light") return "Tipo de nodo no válido";
      if (tx.region !== undefined && !(REGIONS as readonly string[]).includes(tx.region)) return "Región no válida";
      break;
    case "token.create":
      if (!isNewTokenSymbol(tx.symbol)) return "Símbolo no válido (3–8 A-Z 0-9)";
      if (typeof tx.name !== "string" || !tx.name || tx.name.length > 40) return "Nombre no válido";
      if (!Number.isInteger(tx.decimals) || tx.decimals < 0 || tx.decimals > TOKEN_MAX_DECIMALS) return "Decimales no válidos";
      if (!isPositive(tx.maxSupply)) return "Suministro máximo no válido";
      if (!isAmt(tx.initial) || tx.initial > tx.maxSupply) return "Emisión inicial no válida";
      if (typeof tx.mintable !== "boolean") return "mintable no válido";
      if (tx.fee !== TOKEN_CREATE_FEE) return "Comisión incorrecta";
      break;
    case "token.mint":
      if (!isTokenKey(tx.symbol) || tx.symbol === VEL) return "Token no válido";
      if (!isAddress(tx.to)) return "Destino no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (!isAmt(tx.fee)) return "Comisión no válida";
      break;
    case "pool.fund":
      if (!isTokenKey(tx.token)) return "Token no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (!Number.isInteger(tx.epochs) || tx.epochs < 1 || tx.epochs > POOL_MAX_EPOCHS) return "Épocas no válidas";
      if (tx.amount < BigInt(tx.epochs)) return "Importe menor que el nº de épocas";
      if (!isAmt(tx.fee)) return "Comisión no válida";
      break;
    case "order.place":
      if (!tokenOfPair(tx.pair)) return "Par no válido";
      if (tx.side !== "buy" && tx.side !== "sell") return "Lado no válido";
      if (!isSafeUint(tx.price) || tx.price <= 0 || tx.price > MAX_PRICE) return "Precio no válido";
      if (!isAmt(tx.amount) || tx.amount < MIN_ORDER) return "Cantidad por debajo del mínimo";
      if (tx.ttl !== undefined && (!Number.isInteger(tx.ttl) || tx.ttl < 1 || tx.ttl > ORDER_TTL_MAX)) return "Caducidad no válida";
      break;
    case "order.cancel":
      if (typeof tx.id !== "string" || !tx.id || tx.id.length > 32) return "Orden no válida";
      break;
    case "device.attest":
      if (typeof tx.device !== "string" || !/^[0-9a-f]{64}$/.test(tx.device)) return "Huella de dispositivo no válida";
      if (typeof tx.keyId !== "string" || tx.keyId.length > 64 || !B64_RE.test(tx.keyId)) return "keyId no válido";
      if (typeof tx.attestation !== "string" || tx.attestation.length > 16_384 || !B64_RE.test(tx.attestation)) return "Atestación no válida";
      break;
    case "node.bond":
    case "node.unbond":
      if (!isPositive(tx.amount)) return "Importe no válido";
      break;
    case "work.claim":
      if (!isSafeUint(tx.epoch)) return "Época no válida";
      if (!isSafeUint(tx.count) || tx.count === 0 || tx.count > CLAIM_MAX_COUNT) return "Nº de hojas no válido";
      if (typeof tx.root !== "string" || !H128_RE.test(tx.root)) return "Raíz no válida";
      break;
    case "work.prove": {
      if (!isSafeUint(tx.epoch)) return "Época no válida";
      if (!Array.isArray(tx.leaves) || !Array.isArray(tx.paths) || tx.leaves.length !== tx.paths.length) return "Prueba mal formada";
      if (tx.leaves.length < 1 || tx.leaves.length > 2 * CLAIM_SAMPLES) return "Nº de hojas de la prueba no válido";
      for (const p of tx.paths) if (!Array.isArray(p) || p.length > 33) return "Camino no válido";
      for (const l of tx.leaves) { const e = leafProblem(l); if (e) return e; }
      break;
    }
    case "name.register":
    case "name.renew":
    case "name.release":
      if (typeof tx.name !== "string" || !NAME_RE.test(tx.name)) return "Alias no válido (3–24: a-z 0-9 _ .)";
      if (tx.type !== "name.release" && (tx.card !== undefined || tx.type === "name.register")) {
        if (typeof tx.card !== "string" || tx.card.length > CARD_MAX_CHARS) return "Tarjeta no válida";
        const e = cardProblem(tx.card);
        if (e) return e;
      }
      break;
    case "bridge.mint":
      if (!isAddress(tx.to)) return "Destino no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (!isBridgeChain(tx.src)) return "Cadena de origen no válida";
      if (!isBridgeRef(tx.ref)) return "Referencia de depósito no válida";
      break;
    case "bridge.redeem":
      if (!isBridgeChain(tx.dst)) return "Cadena de destino no válida";
      if (!isBridgeDestination(tx.dst, tx.to)) return "Dirección de destino no válida para esa cadena";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (tx.fee !== 0n) return "El canje no lleva comisión (lleva sello)";
      break;
    case "stake.delegate":
    case "stake.undelegate":
      if (!isAddress(tx.node)) return "Nodo no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      break;
    case "node.commission":
      if (!Number.isInteger(tx.bp) || tx.bp < 0 || tx.bp > COMMISSION_MAX_BP) return "Comisión no válida (0–2.000 pb)";
      break;
    case "credits.buy":
      if (!isPositive(tx.amount) || tx.amount < CREDIT_MIN_BUY) return "Compra mínima de créditos: 1 VEL";
      if (tx.to !== undefined && !isAddress(tx.to)) return "Destino no válido";
      if (!isAmt(tx.fee)) return "Comisión no válida";
      break;
    case "htlc.lock":
      if (!isAddress(tx.to)) return "Destino no válido";
      if (!isPositive(tx.amount)) return "Importe no válido";
      if (tx.token !== undefined && (!isTokenKey(tx.token) || tx.token === VEL)) return "Token no válido";
      if (typeof tx.hash !== "string" || !/^[0-9a-f]{64}$/.test(tx.hash)) return "Huella no válida (sha256 en hex)";
      if (!isSafeUint(tx.expiresEpoch)) return "Caducidad no válida";
      break;
    case "htlc.claim":
      if (typeof tx.id !== "string" || !/^h[0-9a-f]{48}$/.test(tx.id)) return "Candado no válido";
      if (typeof tx.preimage !== "string" || !/^[0-9a-f]{64}$/.test(tx.preimage)) return "Secreto no válido (32 bytes en hex)";
      break;
    case "htlc.refund":
      if (typeof tx.id !== "string" || !/^h[0-9a-f]{48}$/.test(tx.id)) return "Candado no válido";
      break;
    default:
      return "Tipo desconocido";
  }
  if (!verifyTxSig(raw)) return "Firma no válida";
  return null;
}

// ---------- Recibos v2 (anónimos, protocolo-v2 §4) ----------
/** En v2 el recibo es la revelación del secreto del trozo: sin firma y sin dirección de quien recibe. */
export type Receipt = ReceiptV2;
export type { ReceiptV2 };

/** Id de un recibo = prefijo de su huella `rh` (= sha512(secret)). Es la clave de `seenReceipts`. */
export const receiptId = (r: ReceiptV2) => (typeof r?.rh === "string" ? r.rh.slice(0, 48) : "");

/** Formato + prueba (sha512(secret) == rh). Sin estado. */
export function verifyReceipt(r: ReceiptV2): boolean {
  return !!r && typeof r === "object"
    && typeof r.shard === "string" && r.shard.length > 0 && r.shard.length <= 128
    && typeof r.mailbox === "string" && r.mailbox.length > 0 && r.mailbox.length <= 128
    && typeof r.rh === "string" && /^[0-9a-f]{128}$/.test(r.rh)
    && typeof r.ts === "number" && Number.isFinite(r.ts)
    && isAddress(r.carrier) && isAddress(r.courier)
    && (r.ep === undefined || (Number.isSafeInteger(r.ep) && r.ep >= 0))
    && checkReceiptProof(r);
}

/** @deprecated Los recibos v1 firmados ya no existen. Usa `receiptSecret` + `ReceiptV2` (proof.ts). */
export function makeReceipt(..._args: unknown[]): never {
  throw new Error("Recibos v1 retirados: construye un ReceiptV2 con receiptSecret()/receiptHash() de proof.ts");
}

/** Señal de vida firmada por un nodo. Define quién está activo para producir bloques. */
export interface Presence {
  node: string;
  height: number; // última altura que conoce
  ts: number;
  sig: string;
}

export interface BlockHeader {
  chain: string;
  height: number;
  prev: string;
  ts: number;
  slot: number;
  proposer: string;
  txRoot: string;
  receiptRoot: string;
  presenceRoot: string;
  /** Hash del estado tras aplicar el bloque. */
  stateRoot: string;
  /** Versión de protocolo (solo mainnet; ver upgrades.ts). */
  pv?: number;
}

/**
 * Recompensa en VEL. `kind`: "producer" (15 % por bloques de la época que se cierra) o "work" (reparto por
 * trabajo verificado de la época `epoch`, que se liquida 4 épocas después). `shards` = créditos verificados.
 */
export interface Reward { node: string; payout: string; amount: Amount; shards: number; tier: string; epoch?: number; kind?: "producer" | "work"; /** Parte que fue a sus delegados. */ delegators?: Amount }
/** Recompensa de una bolsa de token (`pool.fund`). */
export interface TokenReward { pool: string; token: string; node: string; payout: string; amount: Amount }

export interface Block {
  header: BlockHeader;
  hash: string;
  sig: string; // firma del proponente sobre el hash
  txs: Tx[];
  /** v3: siempre vacío (el trabajo se reclama con `work.claim` y se prueba con `work.prove`). Se mantiene por formato. */
  receipts: ReceiptV2[];
  presence: Presence[];
  /** Recompensas VEL repartidas en este bloque (solo en cierres de época). Informativas: el estado se comprueba por raíz. */
  rewards: Reward[];
  /** Recompensas de bolsas de token (solo en cierres de época). */
  tokenRewards?: TokenReward[];
}

export const headerHash = (h: BlockHeader) => hashObj(h);

export function blockRoots(txs: Tx[], receipts: ReceiptV2[], presence: Presence[]) {
  return {
    txRoot: merkleRoot(txs.map(txId)),
    receiptRoot: merkleRoot(receipts.map((r) => hashObj(r))),
    presenceRoot: merkleRoot(presence.map((p) => hashObj(p))),
  };
}
