// Configuración del puente. Todo por variables de entorno o por un JSON (`BRIDGE_CONFIG=ruta`).
// Por defecto el puente está CERRADO (`BRIDGE_ENABLED=false`): no da direcciones ni acuña.
// Los límites de abajo son de partida y prudentes: los fija el propietario tras la revisión legal (docs/mainnet.md).
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ChainId } from "./hd";

export interface ChainConfig {
  id: ChainId;
  enabled: boolean;
  /** JSON-RPC compatible con Ethereum. TRON lo ofrece en `https://api.trongrid.io/jsonrpc`. */
  rpc: string;
  /** Solo TRON: API HTTP para emitir (`/wallet/broadcasthex`). */
  http?: string;
  /** Contrato USDT en esa cadena (TRON en base58 «T…», EVM en 0x…). */
  usdt: string;
  /** Decimales de USDT en esa cadena (6 en TRON, Polygon y Ethereum). vUSDT usa 6. */
  decimals: number;
  /** Confirmaciones antes de acuñar. */
  confirmations: number;
  /** Bloques por consulta de registros (eth_getLogs). */
  logRange: number;
  /** EVM: id de cadena (137 Polygon, 1 Ethereum). */
  chainId?: number;
  /** TRON: tope de comisión por pago (sun). EVM: gas por pago. */
  feeLimit?: number;
  gasLimit?: number;
}

export interface BridgeConfig {
  /** Interruptor general. false = «puente aún no abierto». Lo cambia el propietario tras la revisión legal. */
  enabled: boolean;
  dataDir: string;
  /** Archivo público de la cartera fría (xpub y dirección Velum). */
  coldWalletFile: string;
  /** Clave ed25519 del puente en Velum (única autorizada a acuñar vUSDT). Archivo con la semilla hex, permisos 600. */
  bridgeKeyFile: string;
  /** Nodo Velum (WebSocket de cliente). */
  velumUrl: string;
  /** Bloques Velum de espera antes de encolar un retiro. */
  velumConfirmations: number;
  /** Puerto HTTP del puente (RPC bridge.* y reservas). Solo escucha en local salvo que se diga otra cosa. */
  port: number;
  host: string;
  pollMs: number;
  limits: {
    /** Importe mínimo y máximo por retiro (unidades de 6 decimales). */
    minWithdrawal: number;
    maxWithdrawal: number;
    /** Tope diario de retiros encolados para firmar (suma). */
    dailyWithdrawalCap: number;
    /** Tope diario de acuñación (suma). Por encima, los depósitos esperan al día siguiente. */
    dailyMintCap: number;
    /** Retiros por cartera Velum y día. */
    withdrawalsPerAddressPerDay: number;
    /** Direcciones nuevas por hora (todas las carteras): frena el abuso del índice. */
    newAddressesPerHour: number;
    /** Comisión fija de retiro por cadena (unidades de 6 decimales). 0 por defecto: decisión del propietario. */
    withdrawalFee: Record<ChainId, number>;
  };
  chains: Record<ChainId, ChainConfig>;
}

const U = 1_000_000;

export const DEFAULT_CHAINS: Record<ChainId, ChainConfig> = {
  tron: {
    id: "tron", enabled: true,
    rpc: "https://api.trongrid.io/jsonrpc", http: "https://api.trongrid.io",
    usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", decimals: 6, confirmations: 20, logRange: 1_000,
    feeLimit: 30_000_000,
  },
  polygon: {
    id: "polygon", enabled: true,
    rpc: "https://polygon-rpc.com",
    usdt: "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", decimals: 6, confirmations: 128, logRange: 1_000,
    chainId: 137, gasLimit: 100_000,
  },
  ethereum: {
    id: "ethereum", enabled: false,
    rpc: "https://ethereum-rpc.publicnode.com",
    usdt: "0xdAC17F958D2ee523a2206206994597C13D831ec7", decimals: 6, confirmations: 12, logRange: 500,
    chainId: 1, gasLimit: 100_000,
  },
};

export function defaultConfig(): BridgeConfig {
  return {
    enabled: false,
    dataDir: resolve(".velum-bridge"),
    coldWalletFile: resolve("cold-wallet.public.json"),
    bridgeKeyFile: resolve(".velum-bridge/bridge.key"),
    velumUrl: "ws://127.0.0.1:7420/ws?role=client",
    velumConfirmations: 30,
    port: 7430,
    host: "127.0.0.1",
    pollMs: 15_000,
    limits: {
      minWithdrawal: 10 * U,
      maxWithdrawal: 10_000 * U,
      dailyWithdrawalCap: 50_000 * U,
      dailyMintCap: 100_000 * U,
      withdrawalsPerAddressPerDay: 5,
      newAddressesPerHour: 500,
      withdrawalFee: { tron: 0, polygon: 0, ethereum: 0 },
    },
    chains: structuredClone(DEFAULT_CHAINS),
  };
}

const bool = (v: string | undefined, d: boolean) => (v === undefined ? d : /^(1|true|s[ií]|yes)$/i.test(v));

/** Mezcla profunda sencilla (objetos planos). */
function merge<T>(base: T, over: any): T {
  if (!over || typeof over !== "object") return base;
  const out: any = Array.isArray(base) ? [...(base as any)] : { ...(base as any) };
  for (const [k, v] of Object.entries(over)) out[k] = v && typeof v === "object" && !Array.isArray(v) ? merge((base as any)?.[k] ?? {}, v) : v;
  return out;
}

/** Configuración final: valores por defecto ← JSON ← entorno. */
export function loadConfig(env: Record<string, string | undefined> = process.env): BridgeConfig {
  let cfg = defaultConfig();
  if (env.BRIDGE_CONFIG && existsSync(env.BRIDGE_CONFIG)) cfg = merge(cfg, JSON.parse(readFileSync(env.BRIDGE_CONFIG, "utf8")));
  cfg.enabled = bool(env.BRIDGE_ENABLED, cfg.enabled);
  if (env.BRIDGE_DATA) cfg.dataDir = resolve(env.BRIDGE_DATA);
  if (env.BRIDGE_COLD_WALLET) cfg.coldWalletFile = resolve(env.BRIDGE_COLD_WALLET);
  if (env.BRIDGE_KEY_FILE) cfg.bridgeKeyFile = resolve(env.BRIDGE_KEY_FILE);
  if (env.BRIDGE_VELUM_URL) cfg.velumUrl = env.BRIDGE_VELUM_URL;
  if (env.BRIDGE_PORT) cfg.port = Number(env.BRIDGE_PORT);
  if (env.BRIDGE_HOST) cfg.host = env.BRIDGE_HOST;
  for (const id of Object.keys(cfg.chains) as ChainId[]) {
    const up = id.toUpperCase();
    if (env[`BRIDGE_${up}_RPC`]) cfg.chains[id].rpc = env[`BRIDGE_${up}_RPC`]!;
    if (env[`BRIDGE_${up}_HTTP`]) cfg.chains[id].http = env[`BRIDGE_${up}_HTTP`]!;
    cfg.chains[id].enabled = bool(env[`BRIDGE_${up}_ENABLED`], cfg.chains[id].enabled);
  }
  return cfg;
}
