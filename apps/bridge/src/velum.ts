// Lado Velum del puente: transacciones `bridge.mint` / `bridge.redeem` y cliente RPC del nodo.
// La clave del puente (ed25519) vive en línea y SOLO sirve para acuñar vUSDT: la cadena no le deja nada más.
import { canonical, hashObj, sign, type KeyPair } from "@velum/core";
import type { ChainId } from "./hd";

/** Símbolo del token envuelto en Velum: 1 vUSDT = 1 USDT guardado por el puente. 6 decimales. */
export const VUSDT = "vUSDT";

/** Acuñación: solo la firma la clave del puente. `ref` = `<cadena>:<hash>:<índice de registro>` (única en la cadena). */
export interface BridgeMintTx {
  type: "bridge.mint";
  chain: string; // id de la cadena Velum
  from: string;
  nonce: number;
  ts: number;
  to: string;
  /** µvUSDT (6 decimales). BigInt; en la red, texto decimal (v4). */
  amount: bigint | string;
  /** Cadena de origen del depósito. */
  src: ChainId;
  ref: string;
  sig: string;
}

/** Retiro: lo firma el usuario. Canjea `amount` vUSDT (salen de la circulación) y pide que el puente pague `to` en `dst`. */
export interface BridgeRedeemTx {
  type: "bridge.redeem";
  chain: string;
  from: string;
  nonce: number;
  ts: number;
  dst: ChainId;
  to: string;
  /** µvUSDT. Texto decimal desde la v4 (antes de la v4, number). */
  amount: bigint | string | number;
  fee: bigint | string | number;
  pow?: number;
  sig: string;
}

export const velTxId = (tx: object) => hashObj(tx).slice(0, 48);

export function signVelTx<T extends { sig?: string }>(secret: string, tx: Omit<T, "sig">): T {
  const { sig: _d, ...rest } = tx as any;
  return { ...rest, sig: sign(secret, canonical(rest)) } as T;
}

export function makeMint(key: KeyPair, chainId: string, nonce: number, to: string, amount: bigint, src: ChainId, ref: string, ts = Date.now()): BridgeMintTx {
  return signVelTx<BridgeMintTx>(key.secret, { type: "bridge.mint", chain: chainId, from: key.address, nonce, ts, to, amount, src, ref });
}

// ---------- Puerto hacia la cadena Velum ----------

export interface VelumBlockLite { height: number; hash: string; txs: any[] }

/** Lo que el puente necesita de un nodo. Se implementa por WebSocket o con un simulador en tests. */
export interface VelumPort {
  chainId(): Promise<string>;
  head(): Promise<number>;
  blocks(from: number, to: number): Promise<VelumBlockLite[]>;
  nonce(address: string): Promise<{ nonce: number; pending: number }>;
  /** Suministro en µvUSDT (texto decimal en la RPC v4). */
  tokenSupply(symbol: string): Promise<string | number>;
  submit(tx: object): Promise<string>;
}

/** Cliente RPC por WebSocket (`ws://nodo:7420/ws?role=client`). Reconecta solo. */
export class VelumWs implements VelumPort {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private waiting = new Map<string, { ok: (v: any) => void; ko: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private cid: string | null = null;

  /** `chainId` = cadena Velum esperada (velum-mainnet-1). Se comprueba contra el nodo al primer uso. */
  constructor(private url: string, private timeoutMs = 20_000, private expectedChain = "velum-mainnet-1") {}

  private connect(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onmessage = (ev) => {
        let f: any;
        try { f = JSON.parse(String(ev.data)); } catch { return; }
        if (f.t === "welcome") return resolve();
        if (f.t !== "rpc_res") return;
        const w = this.waiting.get(f.id);
        if (!w) return;
        this.waiting.delete(f.id);
        clearTimeout(w.timer);
        f.error ? w.ko(new Error(f.error)) : w.ok(f.result);
      };
      ws.onerror = () => reject(new Error(`No conecta con el nodo Velum (${this.url})`));
      ws.onclose = () => {
        this.ready = null; this.ws = null;
        for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.ko(new Error("Conexión con el nodo cerrada")); this.waiting.delete(id); }
      };
    });
    return this.ready;
  }

  async call<T = any>(method: string, params: any = {}): Promise<T> {
    await this.connect();
    const id = `b${++this.seq}`;
    return new Promise<T>((ok, ko) => {
      const timer = setTimeout(() => { this.waiting.delete(id); ko(new Error(`Velum: ${method} sin respuesta`)); }, this.timeoutMs);
      this.waiting.set(id, { ok, ko, timer });
      this.ws!.send(JSON.stringify({ t: "rpc", id, method, params }));
    });
  }

  close() { try { this.ws?.close(); } catch {} }

  async chainId(): Promise<string> {
    if (this.cid) return this.cid;
    // El génesis no es un bloque guardado: se mira el bloque 1 (si ya existe) y si no, se usa la cadena esperada.
    const b = await this.call<any>("chain.block", { height: 1 }).catch(() => null);
    const seen = b?.header?.chain;
    if (seen && seen !== this.expectedChain) throw new Error(`El nodo es de ${seen}, se esperaba ${this.expectedChain}`);
    const id: string = seen ?? this.expectedChain;
    this.cid = id;
    return id;
  }
  async head() { return (await this.call<{ height: number }>("chain.head")).height; }
  async blocks(from: number, to: number) {
    const bs = await this.call<any[]>("chain.blocks", { from, to });
    return (bs ?? []).map((b) => ({ height: b.header.height, hash: b.hash, txs: b.txs ?? [] }));
  }
  async nonce(address: string) {
    const a = await this.call<{ nonce: number; pending: number }>("account.get", { address });
    return { nonce: a.nonce, pending: a.pending ?? 0 };
  }
  async tokenSupply(symbol: string) { return String((await this.call<{ supply: string } | null>("token.info", { symbol }))?.supply ?? "0"); }
  async submit(tx: object) { return (await this.call<{ id: string }>("tx.submit", { tx })).id; }
}
