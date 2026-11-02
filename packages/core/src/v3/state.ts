// ⚠ CÓDIGO CONGELADO DEL PROTOCOLO v3 (velum-mainnet-1, alturas < H de la v4). NO EDITAR.
// Solo sirve para reaplicar la historia anterior a la actualización v4 byte a byte (mismas raíces de estado).
// Importes en µVEL (number). La conversión a v4 (BigInt, 18 decimales) está en ../era.ts.
// Máquina de estados de la cadena v3. Determinista: todos los nodos (y el indexador del explorador)
// llegan al mismo resultado. Reglas: sin reloj (solo la hora del bloque), sin azar, solo enteros
// (productos grandes con BigInt) y orden de recorrido estable (claves ordenadas).
//
// v3 (docs/protocolo-v3.md + «Notas de implementación»): sin quema (80 % bolsa · 20 % Reserva), comisión 0 bajo
// 1.000 € con sello PoW, niveles por antigüedad continua (×0,50…×1,00), fianza opcional, reclamaciones de
// trabajo con muestreo (los recibos ya no van en los bloques), oráculo EUR/USD/USDT y alias.
import { hashHex, hashObj } from "../bytes";
import {
  ATTESTATION_MODE, BLOCK_MS, BOND_CAP, BOND_UNBOND_EPOCHS, BP, CHAIN_ID, CLAIM_CAP_DEN, CLAIM_CAP_NUM, CLAIM_LEAF_MAX_AGE,
  CLAIM_SAMPLE_LAG, CLAIM_SETTLE_LAG, DIFFICULTY_HISTORY, EPOCH_BLOCKS, ESCROW_ADDRESS, FEE_BP, FEE_FREE_EUR, FEE_SPLIT_BP,
  GENESIS_RESERVE_SUPPLY, HALVING_EPOCHS, IS_MAINNET, FEE_FREE_USDT, LOTTERY_KEEP_EPOCHS, LOTTERY_PRESENCE_BLOCKS, MAX_SUPPLY, MAX_UNBONDING,
  MONTH_EPOCHS, NAME_POW_EXTRA_BITS, NAME_TERM_EPOCHS, POW_MAX_BITS, POW_MIN_BITS, POW_TARGET_PER_EPOCH, PRESENCE_WINDOW,
  PRODUCER_SHARE_BP, R0, RECEIPT_MEMORY_EPOCHS, RECEIPT_WINDOW_MS, RESERVE_ADDRESS, RESERVE_RELEASE_BP, STREAK_GAP_EPOCHS,
  TIERS, UNIT, VEL, pillarMonths, type AttestationMode, type NodeKind, type Region,
} from "./constants";
import { faucetKeyPair, verifyObj, verify } from "../keys";
import {
  type Block, type BlockHeader, type Presence, type ReceiptV2, type Reward, type TokenReward, type Tx,
  blockRoots, checkTx, headerHash, verifyReceipt,
} from "./tx";
import { type TokenInfo, applyTokenCreate, applyTokenMint, bridgeToken, genesisTokens } from "./tokens";
import { genesisTime, mainnetGenesis } from "../genesis";
import { applyUpgrades, protocolAt, latestProtocol } from "../upgrades";
import { type BridgeState, applyBridgeMint, applyBridgeRedeem } from "./bridge";
import { type StakeState, applyCommission, applyDelegate, applyUndelegate, payNode, releaseUndelegations } from "./staking";
import { type DexState, applyOrderCancel, applyOrderPlace, emptyDex, expireOrders } from "./dex";
import { type AttestResult, verifyAppAttest } from "../attest";
import { type EpochSnapshot, lotteryCandidates, lotteryWeight, makeSnapshot, type LotteryRole } from "../lottery";
import { type OracleState, type PriceView, emptyOracle, oracleClose, oracleSample, valueOf } from "./oracle";
import { powBits } from "../pow";
import { claimSamples, leafHash, proofIndices, verifyWorkPath } from "../claims";
import { decodeCard } from "../names";

/** `balance` es el saldo en VEL (espejo de `balances[addr].VEL`, se mantiene por compatibilidad v1). */
export interface Account { balance: number; nonce: number }

export interface Unbonding { amount: number; /** Época al final de la cual vuelve al nodo. */ release: number }

export interface NodeInfo {
  address: string;
  name: string;
  payout: string;
  endpoint?: string;
  version: string;
  kind: NodeKind;
  region?: Region;
  registeredHeight: number;
  registeredEpoch: number;
  lastPresence: number; // altura del último bloque con su señal de vida
  epochsPresent: number;
  lastPresentEpoch: number;
  /** Racha de servicio continuo (v3 §2): época de inicio y épocas con presencia dentro de ella. */
  streakStart: number;
  streakPresent: number;
  /** Créditos verificados acumulados (hojas acreditadas tras muestreo y tope). */
  shardsDelivered: number;
  credits: number;
  blocksProduced: number;
  earned: number; // µVEL acumulados
  tier: string;
  /** Fianza bloqueada (µVEL, en vel_escrow) y desbloqueos en espera. */
  bond: number;
  unbonding: Unbonding[];
  /** Reclamaciones probadas y nulas (historial para el explorador). */
  claimsOk: number;
  claimsVoid: number;
  /** Staking delegado (opcionales: ausentes = 0 / comisión por defecto). */
  delegated?: number;
  commissionBp?: number;
  commissionEpoch?: number;
}

/** Bolsa de un token repartida entre los nodos durante N épocas (`pool.fund`). */
export interface TokenPool {
  id: string;
  token: string;
  funder: string;
  total: number;
  remaining: number;
  epochsLeft: number;
  createdHeight: number;
  paid: number;
}

/** Dispositivo atestado (§11). Solo huellas: nada que identifique a la persona. */
export interface DeviceRecord {
  keyId: string;
  /** sha256(clave pública del dispositivo) — el `device` de la tx. */
  device: string;
  /** Cartera que lo registró. */
  owner: string;
  verified: boolean;
  /** "production" | "development" si se verificó. */
  env: string | null;
  /** Contador de App Attest (0 al atestar; lo suben las aserciones). */
  counter: number;
  /** Motivo si no se pudo verificar (modo soft). */
  reason?: string;
  height: number;
}

export interface DifficultyPoint {
  epoch: number;
  /** Créditos de trabajo verificados de la época. */
  credits: number;
  /** Emisión nominal R(e) en µVEL. */
  emission: number;
  /** Créditos por 1 VEL, ×1000 (entero). null si R(e) = 0. */
  difficulty: number | null;
}

/** Reclamación de trabajo (v3 §4). */
export interface WorkClaim {
  node: string;
  epoch: number;
  count: number;
  root: string;
  height: number;
  status: "pending" | "proved" | "void";
  reason?: string;
}

/** Alias (v3 §7). Activo mientras la época en curso < `expires`. */
export interface NameRecord {
  name: string;
  owner: string;
  /** Tarjeta de contacto (base58, names.ts). */
  card: string;
  /** Identidad de la tarjeta (para buscar por identidad). */
  identity: string;
  height: number;
  expires: number;
}

export interface PowState {
  /** Dificultad en bits del sello normal. */
  bits: number;
  /** La de la época anterior (se acepta la menor de las dos: los sellos hechos justo antes del cambio valen). */
  prev: number;
  /** Tx con sello en la época en curso (presión: sube o baja la dificultad al cerrar). */
  used: number;
}

export interface ChainState {
  chain: string;
  height: number;
  hash: string;
  ts: number;
  accounts: Record<string, Account>;
  /** Saldos por token: balances[dirección][símbolo]. Incluye VEL. Las entradas a 0 se borran. */
  balances: Record<string, Record<string, number>>;
  tokens: Record<string, TokenInfo>;
  nodes: Record<string, NodeInfo>;
  devices: Record<string, DeviceRecord>;
  pools: Record<string, TokenPool>;
  dex: DexState;
  /** `burned` queda a 0 en v3 (no se destruye VEL). `reserveIn/Out`: entradas y liberaciones de la Reserva. */
  supply: { minted: number; burned: number; feesCollected: number; transfers: number; shards: number; reserveIn: number; reserveOut: number };
  epoch: {
    pool: number; // µVEL esperando reparto (comisiones + restos)
    produced: Record<string, number>; // bloques producidos en la época
    present: Record<string, true>;
  };
  /** Bolsas de trabajo por época (85 %), pendientes de liquidar cuando se cierren sus pruebas. */
  workPots: Record<string, number>;
  /** Reclamaciones por época y nodo. */
  claims: Record<string, Record<string, WorkClaim>>;
  stats: {
    /** Dificultad de la última época liquidada (créditos por VEL ×1000). */
    difficulty: number | null;
    difficultyEpoch: number;
    history: DifficultyPoint[];
  };
  /** Contadores para ids deterministas (órdenes, bolsas). */
  seq: number;
  /**
   * Fotos de nodos para el sorteo de rutas (lottery.ts), por época (clave = nº de época).
   * Se toma al abrir cada época; se guardan las últimas LOTTERY_KEEP_EPOCHS.
   */
  epochNodes: Record<string, EpochSnapshot>;
  /** Hojas ya probadas («p:rh|papel» → altura). Se poda tras RECEIPT_MEMORY_EPOCHS. */
  seenReceipts: Record<string, number>;
  oracle: OracleState;
  pow: PowState;
  names: Record<string, NameRecord>;
  /** Cartera → su alias (uno por cartera). */
  nameOf: Record<string, string>;
  /** Época de caducidad → alias que caducan entonces. */
  nameExpiry: Record<string, string[]>;
  /** Pasarela USDT ⇄ vUSDT (solo mainnet; ausente hasta el primer uso). */
  bridge?: BridgeState;
  /** Staking delegado (ausente hasta la primera delegación). */
  stake?: StakeState;
}

export const epochOf = (height: number) => Math.floor(height / EPOCH_BLOCKS);
/**
 * Época en la que acumula el bloque en curso (`s.height` = altura del bloque que se aplica): los bloques
 * 30e+1 … 30e+30 son de la época e (el 30(e+1) la cierra tras aplicar sus tx).
 */
export const curEpoch = (s: { height: number }) => Math.max(0, epochOf(s.height - 1));

/** R(e) = floor(R0 / 2^floor(e / HALVING)). Llega a 0 tras 29 mitades (~58 años). */
export function emissionFor(epoch: number): number {
  const k = Math.floor(Math.max(0, epoch) / HALVING_EPOCHS);
  if (k >= 52) return 0;
  return Math.floor(R0 / 2 ** k);
}

/** a × b / c con enteros grandes (suelo). */
export const mulDiv = (a: number, b: number, c: number): number => Number((BigInt(a) * BigInt(b)) / BigInt(c));

// ---------- Saldos ----------
export const balanceOf = (s: ChainState, addr: string, token: string = VEL): number => s.balances[addr]?.[token] ?? 0;

const acct = (s: ChainState, a: string) => (s.accounts[a] ??= { balance: 0, nonce: 0 });

function setBalance(s: ChainState, addr: string, token: string, v: number) {
  if (!Number.isSafeInteger(v) || v < 0) throw new Error(`Saldo imposible ${addr} ${token} ${v}`);
  const m = (s.balances[addr] ??= {});
  if (v === 0) delete m[token];
  else m[token] = v;
  if (Object.keys(m).length === 0) delete s.balances[addr];
  if (token === VEL) acct(s, addr).balance = v;
}

/** Suma a un saldo (uso interno de la máquina de estados). */
export function credit(s: ChainState, addr: string, token: string, amount: number) {
  if (amount === 0) return;
  setBalance(s, addr, token, balanceOf(s, addr, token) + amount);
}

/** Resta de un saldo. Lanza si no hay suficiente: quien llama lo comprueba antes (las tx son atómicas). */
export function debit(s: ChainState, addr: string, token: string, amount: number) {
  if (amount === 0) return;
  const b = balanceOf(s, addr, token);
  if (b < amount) throw new Error(`Saldo insuficiente ${addr} ${token}`);
  setBalance(s, addr, token, b - amount);
}

// ---------- Comisiones (v3 §5) ----------
/** Reparto de una comisión: 80 % bolsa de nodos · 20 % Reserva de la Red. Nada se quema. */
export function splitFee(fee: number) {
  const pool = Math.floor((fee * FEE_SPLIT_BP.pool) / BP);
  return { pool, reserve: fee - pool };
}

/** Cobra una comisión en VEL a `payer` y la reparte (80/20). */
export function chargeFee(s: ChainState, payer: string, fee: number) {
  if (fee <= 0) return;
  debit(s, payer, VEL, fee);
  const p = splitFee(fee);
  credit(s, RESERVE_ADDRESS, VEL, p.reserve);
  s.epoch.pool += p.pool;
  s.supply.reserveIn += p.reserve;
  s.supply.feesCollected += fee;
}

/** Cobra un importe que va entero a la Reserva (crear token). */
export function chargeToReserve(s: ChainState, payer: string, amount: number) {
  if (amount <= 0) return;
  debit(s, payer, VEL, amount);
  credit(s, RESERVE_ADDRESS, VEL, amount);
  s.supply.reserveIn += amount;
  s.supply.feesCollected += amount;
}

/**
 * Comisión por mover `vel` µVEL: 1 pb (mín. 1 µVEL) si supera el umbral según el oráculo; si no (o sin precio), 0.
 * Umbral: testnet 1.000 € (EUR del oráculo); mainnet 1.100 USDT (FEE_FREE_USDT, sin euros en consenso).
 */
export function feeForVel(prices: PriceView | null, vel: number): number {
  if (vel <= 0) return 0;
  if (IS_MAINNET) {
    if (!prices?.usdt) return 0;
    return mulDiv(vel, prices.usdt, UNIT) >= FEE_FREE_USDT ? Math.max(1, Math.floor((vel * FEE_BP) / BP)) : 0;
  }
  if (!prices?.eur) return 0;
  const eur = mulDiv(vel, prices.eur, UNIT);
  return eur >= FEE_FREE_EUR ? Math.max(1, Math.floor((vel * FEE_BP) / BP)) : 0;
}

/** Comisión mínima de un pago de `amount` unidades de `token` (0 bajo 1.000 € o sin precio). */
export function transferFee(prices: PriceView | null, token: string, amount: number): number {
  const v = valueOf(prices, token, amount);
  if (IS_MAINNET) {
    if (v.vel === null || v.usdt === null) return 0;
    return v.usdt >= FEE_FREE_USDT ? Math.max(1, Math.floor((v.vel * FEE_BP) / BP)) : 0;
  }
  if (v.vel === null || v.eur === null) return 0;
  return v.eur >= FEE_FREE_EUR ? Math.max(1, Math.floor((v.vel * FEE_BP) / BP)) : 0;
}

/** Comisión mínima exigida a una tx con el oráculo actual. */
export function requiredFee(s: Pick<ChainState, "oracle">, tx: Tx): number {
  if (tx.type === "transfer") return transferFee(s.oracle, tx.token ?? VEL, tx.amount);
  if (tx.type === "token.create") return tx.fee;
  return 0;
}

/** Bits de sello exigidos a una tx (0 = no hace falta). */
export function powRequired(s: Pick<ChainState, "pow">, tx: Tx): number {
  const base = Math.min(s.pow.bits, s.pow.prev);
  switch (tx.type) {
    case "transfer": case "token.mint": case "pool.fund": return tx.fee === 0 ? base : 0;
    case "order.place": case "order.cancel": case "name.release": return base;
    case "bridge.redeem": case "stake.delegate": case "stake.undelegate": case "node.commission": return base;
    case "name.register": case "name.renew": return base + NAME_POW_EXTRA_BITS;
    default: return 0;
  }
}

export const nextId = (s: ChainState, prefix: string) => prefix + (s.seq++).toString(36);

// ---------- Génesis ----------
export function genesisState(): ChainState {
  // Mainnet: 100 M VEL a la cartera fría y vUSDT con la pasarela como única emisora. Sin grifo ni tokens de prueba.
  // Testnet: 100 M VEL + tEUR/tUSD/tUSDT al grifo.
  const g = IS_MAINNET ? mainnetGenesis() : null;
  const holder = g ? g.reserve.address : faucetKeyPair().address;
  const s: ChainState = {
    chain: CHAIN_ID,
    height: 0,
    hash: "",
    ts: genesisTime(),
    accounts: {},
    balances: {},
    tokens: {},
    nodes: {},
    devices: {},
    pools: {},
    dex: emptyDex(),
    supply: { minted: GENESIS_RESERVE_SUPPLY, burned: 0, feesCollected: 0, transfers: 0, shards: 0, reserveIn: 0, reserveOut: 0 },
    epoch: { pool: 0, produced: {}, present: {} },
    workPots: {},
    claims: {},
    stats: { difficulty: null, difficultyEpoch: -1, history: [] },
    seq: 0,
    epochNodes: {},
    seenReceipts: {},
    oracle: emptyOracle(),
    pow: { bits: POW_MIN_BITS, prev: POW_MIN_BITS, used: 0 },
    names: {},
    nameOf: {},
    nameExpiry: {},
  };
  credit(s, holder, VEL, GENESIS_RESERVE_SUPPLY);
  if (g) {
    const t = bridgeToken(g.bridge.address);
    s.tokens[t.symbol] = t;
  } else {
    for (const t of genesisTokens(holder)) {
      s.tokens[t.symbol] = t;
      credit(s, holder, t.symbol, t.supply);
    }
  }
  s.hash = hashHex(`genesis|${CHAIN_ID}|${stateRoot(s)}`);
  return s;
}

/** Raíz del estado: todo lo que es consenso. */
export function stateRoot(s: ChainState): string {
  return hashObj({
    accounts: s.accounts, balances: s.balances, tokens: s.tokens, nodes: s.nodes, devices: s.devices, pools: s.pools,
    dex: s.dex, supply: s.supply, epoch: s.epoch, workPots: s.workPots, claims: s.claims, stats: s.stats, seq: s.seq,
    epochNodes: s.epochNodes, seenReceipts: s.seenReceipts, oracle: s.oracle, pow: s.pow, names: s.names, nameOf: s.nameOf,
    nameExpiry: s.nameExpiry, bridge: s.bridge, stake: s.stake,
  });
}

export const cloneState = (s: ChainState): ChainState => JSON.parse(JSON.stringify(s));

const sortedKeys = (o: Record<string, unknown>) => Object.keys(o).sort();

// ---------- Niveles, racha y peso (v3 §2) ----------
/** Marca presencia de un nodo en la época `ep` (señal de vida o bloque producido). Reinicia la racha tras > 48 h. */
export function markPresent(n: NodeInfo, ep: number) {
  if (n.lastPresentEpoch === ep) return;
  if (n.lastPresentEpoch < 0 || ep - n.lastPresentEpoch - 1 > STREAK_GAP_EPOCHS) {
    n.streakStart = ep;
    n.streakPresent = 0;
  }
  n.streakPresent++;
  n.lastPresentEpoch = ep;
  n.epochsPresent++;
}

/** Racha efectiva en la época `ep`: épocas, épocas presentes y meses (0 si se rompió). */
export function streakOf(n: Pick<NodeInfo, "lastPresentEpoch" | "streakStart" | "streakPresent">, ep: number) {
  if (n.lastPresentEpoch < 0 || ep - n.lastPresentEpoch > STREAK_GAP_EPOCHS || ep < n.streakStart) return { epochs: 0, present: 0, months: 0 };
  const epochs = ep - n.streakStart + 1;
  return { epochs, present: n.streakPresent, months: Math.floor(epochs / MONTH_EPOCHS) };
}

/** Nivel de un nodo en la época `ep`. */
export function tierFor(n: Pick<NodeInfo, "lastPresentEpoch" | "streakStart" | "streakPresent">, ep: number) {
  const st = streakOf(n, ep);
  let t: (typeof TIERS)[number] = TIERS[0];
  if (st.epochs === 0) return t;
  for (const tier of TIERS) {
    const months = tier.minMonths < 0 ? pillarMonths(Math.floor(ep / MONTH_EPOCHS)) : tier.minMonths;
    if (st.months >= months && st.present * 100 >= tier.minPresencePct * st.epochs) t = tier;
  }
  return t;
}

/** Factor de fianza (pb): 10.000 + min(fianza, 10.000 VEL) × 10.000 / 10.000 VEL → ×1 … ×2. */
export const bondFactorBp = (bond: number) => BP + mulDiv(Math.min(Math.max(0, bond), BOND_CAP), BP, BOND_CAP);

/** Peso en el sorteo: tipo (2 completo / 1 ligero) × floor(nivel × fianza / 10⁶). Completo nuevo sin fianza = 100. */
export function nodeWeight(n: NodeInfo, ep: number): number {
  // La delegación suma a la fianza propia, con el mismo tope (BOND_CAP).
  return lotteryWeight(n.kind) * Math.floor((tierFor(n, ep).multBp * bondFactorBp(n.bond + (n.delegated ?? 0))) / 1_000_000);
}

/** Nodos que pueden producir bloques ahora: completos, registrados y con señal de vida reciente. */
export function activeValidators(s: ChainState): string[] {
  return Object.values(s.nodes)
    .filter((n) => n.kind !== "light" && s.height - n.lastPresence <= PRESENCE_WINDOW)
    .map((n) => n.address)
    .sort();
}

export const slotOf = (ts: number) => Math.floor((ts - genesisTime()) / BLOCK_MS);

/** Orden de turno para un hueco: 0 = le toca; 1, 2… = suplentes si el titular no aparece. */
export function proposerRank(s: ChainState, slot: number, node: string): number {
  const set = activeValidators(s);
  if (set.length === 0) return 0; // arranque: cualquiera puede empezar
  const order = set.map((a) => ({ a, h: hashHex(`${s.hash}|${slot}|${a}`) })).sort((x, y) => (x.h < y.h ? -1 : 1));
  const i = order.findIndex((o) => o.a === node);
  const rank = i === -1 ? set.length : i;
  // Cada hueco sin bloque adelanta un puesto a todos: si los activos se apagan a la vez,
  // en pocos huecos cualquier nodo registrado puede seguir la cadena (nunca se queda parada).
  const missed = Math.max(0, slot - slotOf(s.ts) - 1);
  return Math.max(0, rank - missed);
}

/** Desde qué instante puede proponer un nodo en un hueco (los suplentes esperan 1/4 de bloque por puesto). */
export const proposeAfter = (slot: number, rank: number) => genesisTime() + slot * BLOCK_MS + rank * (BLOCK_MS / 4);

// ---------- Aplicación de transacciones ----------
/**
 * Aplica una transacción. Atómica: o cambia el estado entero, o devuelve un error sin tocar nada
 * (todas las comprobaciones van antes de la primera escritura).
 */
export function applyTx(s: ChainState, tx: Tx, mode: AttestationMode = ATTESTATION_MODE): string | null {
  const err = checkTx(tx);
  if (err) return err;
  const nonce = s.accounts[tx.from]?.nonce ?? 0;
  if (tx.nonce !== nonce) return `Nonce esperado ${nonce}`;
  const needBits = powRequired(s, tx);
  if (needBits > 0 && powBits(tx) < needBits) return `Falta el sello de trabajo (${needBits} bits)`;
  const minFee = requiredFee(s, tx);
  if ("fee" in tx && tx.fee < minFee) return `Comisión mínima ${minFee} µVEL`;
  const vel = balanceOf(s, tx.from, VEL);
  let e: string | null = null;
  switch (tx.type) {
    case "transfer": {
      const token = tx.token ?? VEL;
      if (token !== VEL && !s.tokens[token]) return "Token desconocido";
      if (token === VEL) {
        if (vel < tx.amount + tx.fee) return "Saldo insuficiente";
      } else {
        if (vel < tx.fee) return "Saldo insuficiente para la comisión";
        if (balanceOf(s, tx.from, token) < tx.amount) return "Saldo de token insuficiente";
      }
      debit(s, tx.from, token, tx.amount);
      credit(s, tx.to, token, tx.amount);
      chargeFee(s, tx.from, tx.fee);
      s.supply.transfers++;
      break;
    }
    case "register": {
      const ep = curEpoch(s);
      const prev = s.nodes[tx.from];
      s.nodes[tx.from] = {
        address: tx.from,
        name: tx.name ?? "",
        payout: tx.payout,
        ...(tx.endpoint !== undefined ? { endpoint: tx.endpoint } : {}),
        version: tx.version,
        kind: tx.kind ?? "full",
        ...(tx.region !== undefined ? { region: tx.region } : {}),
        registeredHeight: prev?.registeredHeight ?? s.height,
        registeredEpoch: prev?.registeredEpoch ?? ep,
        lastPresence: prev?.lastPresence ?? s.height,
        epochsPresent: prev?.epochsPresent ?? 0,
        lastPresentEpoch: prev?.lastPresentEpoch ?? -1,
        streakStart: prev?.streakStart ?? ep,
        streakPresent: prev?.streakPresent ?? 0,
        shardsDelivered: prev?.shardsDelivered ?? 0,
        credits: prev?.credits ?? 0,
        blocksProduced: prev?.blocksProduced ?? 0,
        earned: prev?.earned ?? 0,
        tier: prev?.tier ?? TIERS[0].id,
        bond: prev?.bond ?? 0,
        unbonding: prev?.unbonding ?? [],
        claimsOk: prev?.claimsOk ?? 0,
        claimsVoid: prev?.claimsVoid ?? 0,
        ...(prev?.delegated !== undefined ? { delegated: prev.delegated } : {}),
        ...(prev?.commissionBp !== undefined ? { commissionBp: prev.commissionBp, commissionEpoch: prev.commissionEpoch } : {}),
      };
      break;
    }
    case "token.create": e = applyTokenCreate(s, tx); break;
    case "token.mint": e = applyTokenMint(s, tx); break;
    case "pool.fund": {
      if (tx.token !== VEL && !s.tokens[tx.token]) return "Token desconocido";
      if (tx.token === VEL) {
        if (vel < tx.amount + tx.fee) return "Saldo insuficiente";
      } else {
        if (vel < tx.fee) return "Saldo insuficiente para la comisión";
        if (balanceOf(s, tx.from, tx.token) < tx.amount) return "Saldo de token insuficiente";
      }
      debit(s, tx.from, tx.token, tx.amount);
      credit(s, ESCROW_ADDRESS, tx.token, tx.amount);
      chargeFee(s, tx.from, tx.fee);
      const id = nextId(s, "p");
      s.pools[id] = { id, token: tx.token, funder: tx.from, total: tx.amount, remaining: tx.amount, epochsLeft: tx.epochs, createdHeight: s.height, paid: 0 };
      break;
    }
    case "order.place": e = applyOrderPlace(s, tx); break;
    case "order.cancel": e = applyOrderCancel(s, tx); break;
    case "device.attest": e = applyDeviceAttest(s, tx, mode); break;
    case "node.bond": {
      const n = s.nodes[tx.from];
      if (!n) return "Solo un nodo dado de alta puede dar fianza";
      if (vel < tx.amount) return "Saldo insuficiente";
      debit(s, tx.from, VEL, tx.amount);
      credit(s, ESCROW_ADDRESS, VEL, tx.amount);
      n.bond += tx.amount;
      break;
    }
    case "node.unbond": {
      const n = s.nodes[tx.from];
      if (!n) return "Nodo desconocido";
      if (n.bond < tx.amount) return "Fianza insuficiente";
      if (n.unbonding.length >= MAX_UNBONDING) return "Demasiados desbloqueos en espera";
      n.bond -= tx.amount;
      n.unbonding.push({ amount: tx.amount, release: curEpoch(s) + BOND_UNBOND_EPOCHS });
      break;
    }
    case "work.claim": e = applyWorkClaim(s, tx); break;
    case "work.prove": e = applyWorkProve(s, tx); break;
    case "name.register": e = applyNameRegister(s, tx); break;
    case "name.renew": e = applyNameRenew(s, tx); break;
    case "name.release": e = applyNameRelease(s, tx); break;
    case "bridge.mint": e = applyBridgeMint(s, tx); break;
    case "bridge.redeem": e = applyBridgeRedeem(s, tx); break;
    case "stake.delegate": e = applyDelegate(s, tx); break;
    case "stake.undelegate": e = applyUndelegate(s, tx); break;
    case "node.commission": e = applyCommission(s, tx); break;
  }
  if (e) return e;
  if (needBits > 0) s.pow.used++;
  acct(s, tx.from).nonce++;
  return null;
}

function applyDeviceAttest(s: ChainState, tx: Extract<Tx, { type: "device.attest" }>, mode: AttestationMode): string | null {
  if (s.devices[tx.keyId]) return "Dispositivo ya atestado";
  let res: AttestResult;
  if (mode === "off") res = { ok: false, error: "Atestación desactivada" };
  else res = verifyAppAttest({ attestation: tx.attestation, keyId: tx.keyId, clientDataHashHex: tx.device, now: s.ts });
  if (!res.ok && mode === "strict") return `Atestación no válida: ${res.error}`;
  s.devices[tx.keyId] = {
    keyId: tx.keyId,
    device: tx.device,
    owner: tx.from,
    verified: res.ok,
    env: res.ok ? res.env : null,
    counter: 0,
    ...(res.ok ? {} : { reason: res.error.slice(0, 120) }),
    height: s.height,
  };
  return null;
}

// ---------- Reclamaciones de trabajo (v3 §4) ----------
/** Foto de una época (o undefined si no la hay o ya no se guarda). */
export const snapshotFor = (s: ChainState, ep: unknown): EpochSnapshot | undefined =>
  Number.isSafeInteger(ep) ? s.epochNodes[String(ep)] : undefined;

/**
 * Papeles por los que `node` puede reclamar un recibo: el recibo lo nombra en ese papel y está entre los
 * 3 candidatos del sorteo (lotteryCandidates) con la foto que cita el recibo. Lo usa el nodo para montar hojas.
 */
export function claimableRoles(s: ChainState, r: ReceiptV2, node: string): LotteryRole[] {
  const snap = snapshotFor(s, r.ep);
  if (!snap) return [];
  return (["carrier", "courier"] as const).filter((role) => r[role] === node && lotteryCandidates(snap, r.shard, role).includes(node));
}

/** Comprobación de un recibo para aceptarlo en un nodo (formato, prueba, plazo y que alguien pueda cobrarlo). */
export function checkReceipt(s: ChainState, r: ReceiptV2, now: number): string | null {
  if (!verifyReceipt(r)) return "Recibo no válido (el secreto no corresponde a la huella)";
  if (r.ts > now + RECEIPT_WINDOW_MS || r.ts < now - RECEIPT_WINDOW_MS) return "Recibo fuera de plazo";
  if (!claimableRoles(s, r, r.carrier).length && !claimableRoles(s, r, r.courier).length) return "Recibo sin nodos sorteados que cobren";
  return null;
}

function applyWorkClaim(s: ChainState, tx: Extract<Tx, { type: "work.claim" }>): string | null {
  if (!s.nodes[tx.from]) return "Solo los nodos dados de alta reclaman trabajo";
  if (tx.epoch !== curEpoch(s) - 1) return `Solo se reclama la época anterior (${curEpoch(s) - 1})`;
  const byNode = (s.claims[String(tx.epoch)] ??= {});
  if (byNode[tx.from]) return "Ya reclamaste esa época";
  byNode[tx.from] = { node: tx.from, epoch: tx.epoch, count: tx.count, root: tx.root, height: s.height, status: "pending" };
  return null;
}

/** Índices que la baliza pide probar de una reclamación (null si aún no hay baliza). */
export function samplesFor(s: ChainState, claim: Pick<WorkClaim, "node" | "epoch" | "count">): number[] | null {
  const beacon = snapshotFor(s, claim.epoch + CLAIM_SAMPLE_LAG);
  return beacon ? claimSamples(beacon.beacon, claim.node, claim.epoch, claim.count) : null;
}

function applyWorkProve(s: ChainState, tx: Extract<Tx, { type: "work.prove" }>): string | null {
  const c = s.claims[String(tx.epoch)]?.[tx.from];
  if (!c) return "No hay reclamación de esa época";
  if (c.status !== "pending") return "La reclamación ya se resolvió";
  const cur = curEpoch(s);
  if (cur < tx.epoch + CLAIM_SAMPLE_LAG || cur > tx.epoch + CLAIM_SETTLE_LAG) return "Fuera del plazo de prueba";
  const samples = samplesFor(s, c);
  if (!samples) return "Aún no hay baliza de muestreo";
  const idx = proofIndices(samples, c.count);
  if (tx.leaves.length !== idx.length) return `Hacen falta ${idx.length} hojas (muestras y vecinas)`;
  const seen = new Map<string, number>(); // clave del recibo → índice (una muestra y una vecina pueden coincidir)
  const hashes: string[] = [];
  let reason: string | null = null;
  for (let i = 0; i < idx.length && !reason; i++) {
    const leaf = tx.leaves[i]!;
    const r = leaf.r;
    const key = `p:${r.rh}|${leaf.role}`;
    const h = leafHash(leaf);
    hashes.push(h);
    if (!verifyWorkPath(h, idx[i]!, c.count, tx.paths[i], c.root)) reason = `Hoja ${idx[i]}: camino de Merkle no válido`;
    else if (i > 0 && idx[i] === idx[i - 1]! + 1 && !(hashes[i - 1]! < h)) reason = `Hoja ${idx[i]}: hojas desordenadas o repetidas`;
    else if (r[leaf.role] !== tx.from) reason = `Hoja ${idx[i]}: el recibo no nombra al nodo`;
    else if (r.ep! > tx.epoch || r.ep! < tx.epoch - CLAIM_LEAF_MAX_AGE) reason = `Hoja ${idx[i]}: época del recibo fuera de rango`;
    else if (!claimableRoles(s, r, tx.from).includes(leaf.role)) reason = `Hoja ${idx[i]}: el nodo no estaba entre los candidatos del sorteo`;
    else if (s.seenReceipts[key] !== undefined || (seen.has(key) && seen.get(key) !== idx[i])) reason = `Hoja ${idx[i]}: recibo repetido o ya probado`;
    seen.set(key, idx[i]!);
  }
  if (reason) {
    c.status = "void";
    c.reason = reason.slice(0, 120);
    return null; // la prueba entra (queda constancia) y anula la reclamación
  }
  for (const k of [...seen.keys()].sort()) s.seenReceipts[k] = s.height;
  c.status = "proved";
  return null;
}

/**
 * Créditos acreditables de las reclamaciones probadas de una época: min(count, tope), con
 * tope_i = floor(1,5 × w_i × Σ_{j≠i} count_j / (W − w_i)), pesos de la foto de esa época y W = Σ pesos de las
 * reclamaciones probadas (sin tope si nadie más probó).
 */
export function creditedClaims(s: ChainState, epoch: number): { node: string; count: number; cap: number | null; credited: number }[] {
  const byNode = s.claims[String(epoch)] ?? {};
  const snap = snapshotFor(s, epoch);
  const w = new Map((snap?.nodes ?? []).map((n) => [n.node, n.w]));
  const proved = sortedKeys(byNode).map((k) => byNode[k]!).filter((c) => c.status === "proved");
  // W = peso de quienes probaron trabajo (los apagados o anulados no cuentan como «resto de la red»).
  const W = proved.reduce((a, c) => a + (w.get(c.node) ?? 0), 0);
  const total = proved.reduce((a, c) => a + c.count, 0);
  return proved.map((c) => {
    const wi = w.get(c.node) ?? 0;
    const others = total - c.count;
    let cap: number | null = null;
    if (wi === 0) cap = 0;
    else if (W - wi > 0 && others > 0)
      cap = Number((BigInt(CLAIM_CAP_NUM) * BigInt(wi) * BigInt(others)) / (BigInt(CLAIM_CAP_DEN) * BigInt(W - wi)));
    return { node: c.node, count: c.count, cap, credited: cap === null ? c.count : Math.min(c.count, cap) };
  });
}

// ---------- Alias (v3 §7) ----------
/** Alias activo (o null). */
export function nameInfo(s: ChainState, name: string): NameRecord | null {
  const r = s.names[name];
  return r && curEpochRead(s) < r.expires ? r : null;
}
/** Alias activo de una cartera (o null). */
export function nameOfAddress(s: ChainState, owner: string): NameRecord | null {
  const n = s.nameOf[owner];
  return n ? nameInfo(s, n) : null;
}
/** Época «en curso» al leer fuera de un bloque: la del siguiente bloque. */
const curEpochRead = (s: ChainState) => curEpoch({ height: s.height + 1 });

function expiryAdd(s: ChainState, name: string, ep: number) {
  (s.nameExpiry[String(ep)] ??= []).push(name);
}
function expiryRemove(s: ChainState, name: string, ep: number) {
  const k = String(ep);
  const list = s.nameExpiry[k];
  if (!list) return;
  const i = list.indexOf(name);
  if (i >= 0) list.splice(i, 1);
  if (!list.length) delete s.nameExpiry[k];
}
function dropName(s: ChainState, r: NameRecord) {
  expiryRemove(s, r.name, r.expires);
  if (s.nameOf[r.owner] === r.name) delete s.nameOf[r.owner];
  delete s.names[r.name];
}

function applyNameRegister(s: ChainState, tx: Extract<Tx, { type: "name.register" }>): string | null {
  const cur = curEpoch(s);
  const old = s.names[tx.name];
  if (old && cur < old.expires) return old.owner === tx.from ? "Ese alias ya es tuyo: renuévalo" : "Alias ocupado";
  const mine = s.nameOf[tx.from] ? s.names[s.nameOf[tx.from]!] : undefined;
  if (mine && cur < mine.expires) return "Ya tienes un alias (uno por cartera)";
  const identity = decodeCard(tx.card).identity;
  if (old) dropName(s, old);
  if (mine) dropName(s, mine);
  const expires = cur + NAME_TERM_EPOCHS;
  s.names[tx.name] = { name: tx.name, owner: tx.from, card: tx.card, identity, height: s.height, expires };
  s.nameOf[tx.from] = tx.name;
  expiryAdd(s, tx.name, expires);
  return null;
}

function applyNameRenew(s: ChainState, tx: Extract<Tx, { type: "name.renew" }>): string | null {
  const cur = curEpoch(s);
  const r = s.names[tx.name];
  if (!r || cur >= r.expires) return "Alias caducado o inexistente";
  if (r.owner !== tx.from) return "El alias no es tuyo";
  const expires = Math.min(Math.max(r.expires, cur) + NAME_TERM_EPOCHS, cur + 2 * NAME_TERM_EPOCHS);
  if (expires === r.expires && tx.card === undefined) return "Ya está renovado al máximo";
  if (tx.card !== undefined) {
    const identity = decodeCard(tx.card).identity;
    r.card = tx.card;
    r.identity = identity;
  }
  expiryRemove(s, r.name, r.expires);
  r.expires = expires;
  expiryAdd(s, r.name, expires);
  return null;
}

function applyNameRelease(s: ChainState, tx: Extract<Tx, { type: "name.release" }>): string | null {
  const r = s.names[tx.name];
  if (!r || curEpoch(s) >= r.expires) return "Alias caducado o inexistente";
  if (r.owner !== tx.from) return "El alias no es tuyo";
  dropName(s, r);
  return null;
}

// ---------- Presencia ----------
function applyPresence(s: ChainState, p: Presence, height: number) {
  const n = s.nodes[p.node];
  if (!n || !verifyObj(p.node, p)) return;
  n.lastPresence = height;
  s.epoch.present[p.node] = true;
  markPresent(n, curEpoch({ height }));
}

// ---------- Cierre de época ----------
/** Reparto de los productores de la época que se cierra (15 % de la bolsa). */
function payProducers(s: ChainState, ep: number, pot: number): { out: Reward[]; paid: number } {
  const out: Reward[] = [];
  const keys = sortedKeys(s.epoch.produced).filter((k) => s.nodes[k]);
  const total = keys.reduce((a, k) => a + s.epoch.produced[k]!, 0);
  if (!total) return { out, paid: 0 };
  let paid = 0;
  for (const k of keys) {
    const n = s.nodes[k]!;
    const amount = mulDiv(pot, s.epoch.produced[k]!, total);
    if (amount <= 0) continue;
    const toDelegators = payNode(s, n, amount);
    n.earned += amount;
    paid += amount;
    out.push({ node: k, payout: n.payout, amount, shards: 0, tier: n.tier, epoch: ep, kind: "producer", ...(toDelegators ? { delegators: toDelegators } : {}) });
  }
  return { out, paid };
}

/** Liquida la época `E`: reparte su bolsa de trabajo entre las reclamaciones probadas. Devuelve lo que sobra. */
function settleClaims(s: ChainState, E: number): { out: Reward[]; tokenRewards: TokenReward[]; carry: number } {
  const out: Reward[] = [];
  const pot = s.workPots[String(E)] ?? 0;
  const byNode = s.claims[String(E)] ?? {};
  const credited = E >= 0 ? creditedClaims(s, E) : [];
  for (const k of sortedKeys(byNode)) {
    const c = byNode[k]!;
    const n = s.nodes[k];
    if (!n) continue;
    if (c.status === "proved") n.claimsOk++;
    else n.claimsVoid++; // nula o sin prueba a tiempo: pierde la recompensa de la época
  }
  const total = credited.reduce((a, c) => a + c.credited, 0);
  let paid = 0;
  if (total > 0) {
    for (const c of credited) {
      const n = s.nodes[c.node]!;
      n.credits += c.credited;
      n.shardsDelivered += c.credited;
      const amount = mulDiv(pot, c.credited, total);
      if (amount <= 0) continue;
      const toDelegators = payNode(s, n, amount);
      n.earned += amount;
      paid += amount;
      out.push({ node: c.node, payout: n.payout, amount, shards: c.credited, tier: n.tier, epoch: E, kind: "work", ...(toDelegators ? { delegators: toDelegators } : {}) });
    }
  }
  s.supply.shards += total;
  const tokenRewards = distributePools(s, credited, total);
  const R = emissionFor(Math.max(0, E));
  const difficulty = R > 0 ? Number((BigInt(total) * 1000n * BigInt(UNIT)) / BigInt(R)) : null;
  if (E >= 0) {
    s.stats.difficulty = difficulty;
    s.stats.difficultyEpoch = E;
    s.stats.history.push({ epoch: E, credits: total, emission: R, difficulty });
    if (s.stats.history.length > DIFFICULTY_HISTORY) s.stats.history.splice(0, s.stats.history.length - DIFFICULTY_HISTORY);
  }
  delete s.workPots[String(E)];
  delete s.claims[String(E)];
  return { out, tokenRewards, carry: pot - paid };
}

function distributePools(s: ChainState, credited: { node: string; credited: number }[], total: number): TokenReward[] {
  const out: TokenReward[] = [];
  if (total === 0) return out; // sin trabajo, las bolsas esperan (no consumen épocas)
  for (const id of sortedKeys(s.pools)) {
    const p = s.pools[id]!;
    const release = Math.floor(p.remaining / p.epochsLeft);
    let paid = 0;
    for (const c of credited) {
      const n = s.nodes[c.node]!;
      const amount = mulDiv(release, c.credited, total);
      if (amount <= 0) continue;
      debit(s, ESCROW_ADDRESS, p.token, amount);
      credit(s, n.payout, p.token, amount);
      out.push({ pool: id, token: p.token, node: c.node, payout: n.payout, amount });
      paid += amount;
    }
    p.remaining -= paid;
    p.paid += paid;
    p.epochsLeft--;
    if (p.epochsLeft === 0) {
      if (p.remaining > 0) { // restos de redondeo: vuelven a quien la financió
        debit(s, ESCROW_ADDRESS, p.token, p.remaining);
        credit(s, p.funder, p.token, p.remaining);
      }
      delete s.pools[id];
    }
  }
  return out;
}

/**
 * Bolsa de la época que se cierra: comisiones + 0,1 % de la Reserva + emisión R(e) (solo si algún nodo
 * produjo bloques; recortada a MAX_SUPPLY). 15 % a productores ya; 85 % a `workPots[e]` hasta liquidar.
 */
export function computeEpochPot(s: ChainState) {
  const ep = epochOf(s.height) - 1;
  const produced = sortedKeys(s.epoch.produced).reduce((a, k) => a + (s.nodes[k] ? s.epoch.produced[k]! : 0), 0);
  const emission = produced > 0 ? Math.max(0, Math.min(emissionFor(Math.max(0, ep)), MAX_SUPPLY - s.supply.minted)) : 0;
  const release = Math.floor((balanceOf(s, RESERVE_ADDRESS) * RESERVE_RELEASE_BP) / BP);
  const pot = s.epoch.pool + release + emission;
  const producerPot = produced > 0 ? Math.floor((pot * PRODUCER_SHARE_BP) / BP) : 0;
  return { ep, emission, release, pot, producerPot, minted: emission };
}

/** @deprecated v2: el reparto por trabajo se liquida 4 épocas después. Queda para mostrar la bolsa de la época. */
export const computeRewards = computeEpochPot;

function closeEpoch(s: ChainState): { rewards: Reward[]; tokenRewards: TokenReward[] } {
  const p = computeEpochPot(s);
  const X = p.ep;
  if (p.release > 0) {
    debit(s, RESERVE_ADDRESS, VEL, p.release);
    s.supply.reserveOut += p.release;
  }
  s.supply.minted += p.minted;
  const prod = payProducers(s, X, p.producerPot);
  s.workPots[String(X)] = p.pot - prod.paid;
  const settled = settleClaims(s, X - CLAIM_SETTLE_LAG);
  // Niveles, desbloqueos de fianza.
  for (const addr of sortedKeys(s.nodes)) {
    const n = s.nodes[addr]!;
    n.tier = tierFor(n, X).id;
    if (n.unbonding.length && n.unbonding.some((u) => u.release <= X)) {
      const due = n.unbonding.filter((u) => u.release <= X).reduce((a, u) => a + u.amount, 0);
      n.unbonding = n.unbonding.filter((u) => u.release > X);
      debit(s, ESCROW_ADDRESS, VEL, due);
      credit(s, addr, VEL, due);
    }
  }
  releaseUndelegations(s, X);
  // Dificultad del sello: sube si la época fue muy cargada, baja si va holgada.
  const pw = s.pow;
  const old = pw.bits;
  if (pw.used > POW_TARGET_PER_EPOCH) pw.bits = Math.min(POW_MAX_BITS, old + 1);
  else if (pw.used < POW_TARGET_PER_EPOCH / 4) pw.bits = Math.max(POW_MIN_BITS, old - 1);
  pw.prev = old;
  pw.used = 0;
  oracleClose(s, X);
  s.epoch = { pool: settled.carry, produced: {}, present: {} };
  expireOrders(s, epochOf(s.height));
  // Alias que caducan al empezar la época nueva.
  const due = s.nameExpiry[String(X + 1)];
  if (due) for (const name of due.slice()) { const r = s.names[name]; if (r && r.expires <= X + 1) dropName(s, r); }
  delete s.nameExpiry[String(X + 1)];
  takeSnapshot(s);
  const horizon = s.height - EPOCH_BLOCKS * RECEIPT_MEMORY_EPOCHS;
  for (const id of sortedKeys(s.seenReceipts)) if (s.seenReceipts[id]! < horizon) delete s.seenReceipts[id];
  return { rewards: [...prod.out, ...settled.out], tokenRewards: settled.tokenRewards };
}

/**
 * Foto de la época que empieza en este bloque (altura H, H % EPOCH_BLOCKS = 0). Baliza = hash del bloque
 * anterior (el último de la época que se cierra: en buildBlock `s.hash` aún es el del padre).
 * Entran los nodos dados de alta antes de H y con señal de vida en los últimos LOTTERY_PRESENCE_BLOCKS,
 * con peso = tipo × nivel × fianza (nodeWeight).
 */
function takeSnapshot(s: ChainState) {
  const ep = epochOf(s.height);
  const nodes = sortedKeys(s.nodes)
    .map((a) => s.nodes[a]!)
    .filter((n) => n.registeredHeight < s.height && s.height - n.lastPresence <= LOTTERY_PRESENCE_BLOCKS)
    .map((n) => ({ node: n.address, kind: n.kind, w: nodeWeight(n, ep - 1) }));
  s.epochNodes[String(ep)] = makeSnapshot(ep, s.hash, nodes);
  for (const k of sortedKeys(s.epochNodes)) if (Number(k) <= ep - LOTTERY_KEEP_EPOCHS) delete s.epochNodes[k];
}

/** Foto más reciente (la que usan clientes y nodos para enrutar). */
export function currentSnapshot(s: ChainState): EpochSnapshot | null {
  let best: EpochSnapshot | null = null;
  for (const k of Object.keys(s.epochNodes)) if (!best || Number(k) > best.epoch) best = s.epochNodes[k]!;
  return best;
}

// ---------- Bloques ----------
export interface BuildInput {
  proposer: string;
  ts: number;
  txs: Tx[];
  /** v3: se ignoran (el trabajo va en `work.claim`). Se acepta el campo por compatibilidad. */
  receipts?: ReceiptV2[];
  presence: Presence[];
}

/**
 * Construye el siguiente bloque sobre `s` (no modifica `s`). Descarta lo inválido.
 * Devuelve el bloque sin firmar y el estado resultante.
 */
export function buildBlock(s: ChainState, input: BuildInput): { block: Omit<Block, "sig">; state: ChainState } {
  const next = cloneState(s);
  next.height = s.height + 1;
  next.ts = input.ts;
  applyUpgrades(next as any); // migraciones que se activan en esta altura (upgrades.ts), antes de todo lo demás
  oracleSample(next, curEpoch(next)); // precio previo a las tx del bloque
  const txs: Tx[] = [];
  for (const tx of input.txs) if (applyTx(next, tx) === null) txs.push(tx);
  const presence: Presence[] = [];
  const pseen = new Set<string>();
  for (const p of input.presence) {
    if (!p || pseen.has(p.node) || !next.nodes[p.node] || !verifyObj(p.node, p) || Math.abs(p.ts - input.ts) > 30_000) continue;
    pseen.add(p.node);
    applyPresence(next, p, next.height);
    presence.push(p);
  }
  const prop = next.nodes[input.proposer];
  if (prop && prop.kind !== "light") {
    prop.blocksProduced++;
    next.epoch.produced[input.proposer] = (next.epoch.produced[input.proposer] ?? 0) + 1;
    prop.lastPresence = next.height;
    markPresent(prop, curEpoch(next));
  }
  let rewards: Reward[] = [];
  let tokenRewards: TokenReward[] = [];
  if (next.height % EPOCH_BLOCKS === 0) ({ rewards, tokenRewards } = closeEpoch(next));
  const header: BlockHeader = {
    chain: CHAIN_ID,
    height: next.height,
    prev: s.hash,
    ts: input.ts,
    slot: slotOf(input.ts),
    proposer: input.proposer,
    // Mainnet: versión de protocolo en la cabecera (un binario viejo se para en vez de bifurcar).
    ...(IS_MAINNET ? { pv: protocolAt(next.height) } : {}),
    ...blockRoots(txs, [], presence),
    stateRoot: stateRoot(next),
  };
  const hash = headerHash(header);
  next.hash = hash;
  return { block: { header, hash, txs, receipts: [], presence, rewards, ...(tokenRewards.length ? { tokenRewards } : {}) }, state: next };
}

/**
 * Comprueba un bloque recibido contra el estado `s` y devuelve el estado nuevo, o un error.
 * Reconstruye el bloque con las mismas entradas: si algo no cuadra (raíces, estado), se rechaza.
 * (El único uso del reloj es rechazar bloques del futuro; reaplicar bloques viejos no depende de él.)
 */
export function applyBlock(s: ChainState, b: Block): { state: ChainState } | { error: string } {
  const h = b.header;
  if (!h || h.chain !== CHAIN_ID) return { error: "Cadena incorrecta" };
  if (h.height !== s.height + 1) return { error: `Altura ${h.height}, esperada ${s.height + 1}` };
  if (IS_MAINNET) {
    const want = protocolAt(h.height);
    if (typeof h.pv !== "number") return { error: "Falta la versión de protocolo" };
    if (h.pv > latestProtocol()) return { error: `${UPGRADE_NEEDED}: el bloque ${h.height} es de protocolo v${h.pv}` };
    if (h.pv !== want) return { error: `Versión de protocolo v${h.pv}, se esperaba v${want} a esa altura` };
  }
  if (h.prev !== s.hash) return { error: "No encadena con el anterior" };
  if (h.ts <= s.ts || h.ts > Date.now() + 5_000) return { error: "Hora no válida" };
  if (h.slot !== slotOf(h.ts)) return { error: "Hueco no válido" };
  if (headerHash(h) !== b.hash) return { error: "Hash no válido" };
  if (!verify(h.proposer, b.hash, b.sig)) return { error: "Firma del proponente no válida" };
  if (s.nodes[h.proposer]?.kind === "light") return { error: "Los nodos ligeros no producen bloques" };
  if (!Array.isArray(b.txs) || !Array.isArray(b.presence)) return { error: "Bloque mal formado" };
  if (Array.isArray(b.receipts) && b.receipts.length) return { error: "En v3 los recibos no van en los bloques (usa work.claim)" };
  const rank = proposerRank(s, h.slot, h.proposer);
  const set = activeValidators(s);
  if (set.length > 0 && !set.includes(h.proposer) && s.nodes[h.proposer] === undefined) return { error: "Proponente no registrado" };
  if (h.ts < proposeAfter(h.slot, Math.min(rank, 8)) - 1_000) return { error: "Se adelantó a su turno" };
  const { block, state } = buildBlock(s, { proposer: h.proposer, ts: h.ts, txs: b.txs, presence: b.presence });
  if (block.txs.length !== b.txs.length) return { error: "Transacción inválida en el bloque" };
  if (block.presence.length !== b.presence.length) return { error: "Señal de vida inválida en el bloque" };
  if (block.hash !== b.hash) return { error: "El estado resultante no coincide" };
  return { state };
}

/** Prefijo del error cuando llega un bloque de una versión que este binario no conoce: hay que actualizar. */
export const UPGRADE_NEEDED = "Actualización necesaria";

/** Puntuación para elegir entre dos ramas: más alta gana; a igual altura, la de menor hash. */
export function betterHead(a: { height: number; hash: string }, b: { height: number; hash: string }) {
  if (a.height !== b.height) return a.height > b.height ? a : b;
  return a.hash < b.hash ? a : b;
}

/**
 * Invariante de conservación (tests y auditoría): Σ saldos VEL (incluye vel_escrow y vel_reserve) + bolsa de
 * la época + bolsas de trabajo pendientes = acuñado. Devuelve la diferencia (debe ser 0 siempre).
 */
export function velLedgerGap(s: ChainState): number {
  let sum = s.epoch.pool;
  for (const k of sortedKeys(s.workPots)) sum += s.workPots[k]!;
  for (const a of sortedKeys(s.balances)) sum += s.balances[a]![VEL] ?? 0;
  return s.supply.minted - sum;
}
