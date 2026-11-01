// Protocolo de red (JSON sobre WebSocket). Lo hablan: puerta de entrada (Worker), nodos y clientes.
//
//  Cliente ──ws──▶ Puerta /hub?role=client ──▶ Nodo elegido (rpc)        (o directo: ws://nodo:7420/ws?role=client)
//  Nodo    ──ws──▶ Puerta /hub?role=node   ◀─▶ resto de nodos (gossip)   (y directo entre nodos: ?role=node)
//  Web     ──ws──▶ Puerta /hub?role=watch  ◀── bloques y estadísticas en vivo
import type { Block, Presence, Tx } from "./tx";
import type { Shard } from "./shards";
import type { ReceiptV2 } from "./proof";
import type { MailboxOpen } from "./mailbox";
import type { NodeKind } from "./constants";
import type { EpochSnapshot } from "./lottery";

export type Role = "node" | "client" | "watch";

export interface NodeHello {
  t: "hello";
  node: string; // dirección del nodo
  name: string;
  version: string;
  height: number;
  ts: number;
  /** Firma de `hello|node|ts` para que nadie se haga pasar por otro nodo. */
  sig: string;
  endpoint?: string;
  /** "light" = nodo ligero (móvil): la puerta no le manda bloques ni transacciones, solo trozos, recibos, cabeza y época. */
  kind?: NodeKind;
}

/** Lo que la puerta conoce de cada nodo conectado. */
export interface PeerInfo {
  node: string;
  name: string;
  version: string;
  height: number;
  since: number;
  endpoint?: string;
  kind?: NodeKind;
}

/** Foto del sorteo de rutas + qué nodos ve en línea quien responde (para enrutar a nodos vivos). */
export interface EpochInfo extends EpochSnapshot {
  online: string[];
}

/** Métodos que también sirve un nodo ligero (el resto, solo los completos). */
export const LIGHT_METHODS = ["shard.put", "mailbox.open", "receipt.submit", "node.info", "chain.head", "chain.epoch"] as const;

/**
 * RPC entre nodos por mensaje directo (`direct`), para nodos ligeros y para reenviar la llamada de un
 * cliente conectado a un nodo hacia otro nodo (`rpc` con `node`).
 */
export type DirectRpc =
  | { kind: "rpc"; id: string; method: RpcMethod; params: any }
  | { kind: "rpc_res"; id: string; result?: any; error?: string };

export type GossipItem =
  | { kind: "block"; block: Block }
  | { kind: "tx"; tx: Tx }
  | { kind: "shard"; shard: Shard; carrier: string }
  | { kind: "receipt"; receipt: ReceiptV2 }
  | { kind: "presence"; presence: Presence };

// ---------- Tramas ----------
export type HubToNode =
  | { t: "welcome"; peers: PeerInfo[] }
  | { t: "peer"; op: "join" | "leave"; peer: PeerInfo }
  | { t: "gossip"; from: string; item: GossipItem }
  | { t: "rpc"; from: string; id: string; method: RpcMethod; params: any }
  | { t: "direct"; from: string; data: any }
  | { t: "client_left"; client: string }
  /** Solo a nodos ligeros: cabeza de la cadena (en vez de bloques). */
  | { t: "head"; height: number; hash: string; ts: number }
  /** Solo a nodos ligeros: foto del sorteo al abrir época. */
  | { t: "epoch"; snapshot: EpochSnapshot };

export type NodeToHub =
  | NodeHello
  | { t: "gossip"; item: GossipItem }
  | { t: "rpc_res"; to: string; id: string; result?: any; error?: string }
  | { t: "push"; to: string; event: PushEvent; data: any }
  | { t: "direct"; to: string; data: any }
  | { t: "status"; height: number; hash: string; mempool: number; mailboxes: number; stats?: Record<string, number> };

export type ClientToHub =
  | { t: "rpc"; node?: string; id: string; method: RpcMethod; params: any }
  | { t: "ping" };

export type HubToClient =
  | { t: "welcome"; client: string; nodes: PeerInfo[] }
  | { t: "nodes"; nodes: PeerInfo[] }
  | { t: "rpc_res"; id: string; result?: any; error?: string; node?: string }
  | { t: "push"; node: string; event: PushEvent; data: any }
  | { t: "pong" };

export type HubToWatch =
  | { t: "snapshot"; head: { height: number; hash: string } | null; nodes: PeerInfo[]; stats: Record<string, number> }
  | { t: "block"; block: Block }
  | { t: "nodes"; nodes: PeerInfo[] }
  /**
   * Tráfico agregado por segundo y nodo (privacidad: sin ids de trozo, sin buzones, sin parejas origen→destino).
   * `sec` = segundo Unix; `nodes` = por nodo que lo puso en la red, cuántos trozos, recibos y transacciones.
   */
  | { t: "traffic"; sec: number; nodes: { node: string; shards: number; receipts: number; txs: number }[] }
  /** @deprecated v1: flujo trozo a trozo. La puerta v2 ya no lo emite (filtraba tiempos). Usa "traffic". */
  | { t: "flow"; kind: "shard" | "receipt" | "tx"; id: string; from?: string; to?: string; ts: number };

export type PushEvent = "shard" | "head";

// ---------- Métodos RPC del nodo ----------
export interface RpcMap {
  "chain.head": { params: {}; result: { height: number; hash: string; ts: number; node: string } };
  "chain.block": { params: { height?: number; hash?: string }; result: Block | null };
  "chain.blocks": { params: { from: number; to: number }; result: Block[] };
  "account.get": { params: { address: string }; result: { balance: number; nonce: number; pending: number } };
  "account.history": { params: { address: string; limit?: number }; result: { height: number; ts: number; tx: Tx }[] };
  "tx.submit": { params: { tx: Tx }; result: { id: string } };
  "faucet": { params: { address: string }; result: { id: string; amount: number } };
  /** Entrega un fragmento v2 al nodo (este nodo pasa a ser el "carrier"). Lleva `rh` y `mbAuth`. */
  "shard.put": { params: { shard: Shard }; result: { ok: true; carrier: string } };
  /**
   * Abre buzones sin decir quién es (§5): por cada uno, firma ed25519 de `velum/v2/open|<mailbox>|<ts>`
   * verificable con `auth` (= `mbAuth` de sus trozos). El nodo devuelve los trozos de ese buzón con
   * `mbAuth == auth` y desde entonces empuja eventos "shard" de esos buzones. Ver `verifyOpenProof`.
   */
  "mailbox.open": { params: { mailboxes: MailboxOpen[] }; result: { shards: (Shard & { carrier: string })[]; courier: string } };
  /** Recibos anónimos (§4): sin firma; válidos si `sha512(secret) == rh`. */
  "receipt.submit": { params: { receipts: ReceiptV2[] }; result: { accepted: number } };
  "node.info": { params: {}; result: { address: string; name: string; payout: string; version: string; height: number; peers: number; tier: string; earned: number; uptime: number } };
  "node.list": { params: {}; result: any[] };
  "node.get": { params: { address: string }; result: any | null };
  "stats": { params: {}; result: Record<string, number> };
  /** Foto del sorteo de rutas (la última, o la de `epoch` si aún se guarda). */
  "chain.epoch": { params: { epoch?: number }; result: EpochInfo | null };
  "token.info": { params: { symbol: string }; result: any | null };
  "token.list": { params: {}; result: any[] };
  /** Libro `VEL/<token>`: profundidad, último precio y volumen 24 h. */
  "market.book": { params: { pair: string; levels?: number }; result: any };
  "market.trades": { params: { pair?: string; limit?: number }; result: any[] };
  "account.balances": { params: { address: string }; result: Record<string, number> };
  "account.orders": { params: { address: string }; result: any[] };
  "supply": { params: {}; result: any };
  /** v3: contexto de comisiones (oráculo + bits del sello PoW) para construir transacciones (`FeeContext`). */
  "chain.fees": { params: {}; result: { oracle: any; powBits: number } };
  "oracle": { params: {}; result: any };
  /** v3: reclamaciones de trabajo de una época (por defecto la anterior). */
  "claims": { params: { epoch?: number }; result: Record<string, any> };
  "name.info": { params: { name: string }; result: any | null };
  "name.of": { params: { address: string }; result: any | null };
  "difficulty": { params: {}; result: any };
  /** Pasarela USDT ⇄ vUSDT (el nodo reenvía a VELUM_BRIDGE_URL). Cerrada: error «puente aún no abierto». */
  "bridge.address": { params: { chain: "tron" | "polygon" | "ethereum"; velAddress: string }; result: { chain: string; address: string; index: number; confirmations: number; contract: string } };
  "bridge.status": { params: {}; result: any };
  "bridge.reserves": { params: {}; result: any };
  "bridge.lookup": { params: { id?: string; velAddress?: string }; result: any };
  /** Staking: delegaciones de un nodo (`node`) o de una dirección (`address`, con retiradas en espera). */
  "stake.delegations": { params: { node?: string; address?: string }; result: any };
}
export type RpcMethod = keyof RpcMap;

export const helloChallenge = (node: string, ts: number) => `hello|${node}|${ts}`;
export const presenceBody = (node: string, height: number, ts: number) => ({ node, height, ts });

/** @deprecated v1 (apertura firmada con la cuenta). En v2 se usa `openProof` / `verifyOpenProof` (mailbox.ts). */
export const mailboxChallenge = (mailbox: string, address: string, ts: number) => `mailbox|${mailbox}|${address}|${ts}`;
