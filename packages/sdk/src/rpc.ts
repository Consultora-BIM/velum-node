// Cliente RPC de un nodo Velum (JSON sobre WebSocket). Funciona en Bun, Node 22+, navegadores y Workers.
//   ws://<nodo>:7420/ws?role=client   (nodo propio, lo recomendado para exchanges)
//   wss://velumprotocol.org/hub?role=client   (puerta pública: elige nodo)
type Pending = { ok: (v: any) => void; ko: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export interface BlockLite { height: number; hash: string; ts: number; txs: any[] }

export class VelumRpc {
  private ws: WebSocket | null = null;
  private ready: Promise<void> | null = null;
  private seq = 0;
  private waiting = new Map<string, Pending>();

  constructor(readonly url: string, private timeoutMs = 20_000) {}

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
      ws.onerror = () => reject(new Error(`No conecta con ${this.url}`));
      ws.onclose = () => {
        this.ready = null; this.ws = null;
        for (const [id, w] of this.waiting) { clearTimeout(w.timer); w.ko(new Error("Conexión cerrada")); this.waiting.delete(id); }
      };
    });
    return this.ready;
  }

  /** Llamada genérica. Métodos: `packages/core/src/wire.ts › RpcMap`. */
  async call<T = any>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    await this.connect();
    const id = `s${++this.seq}`;
    return new Promise<T>((ok, ko) => {
      const timer = setTimeout(() => { this.waiting.delete(id); ko(new Error(`${method}: sin respuesta`)); }, this.timeoutMs);
      this.waiting.set(id, { ok, ko, timer });
      this.ws!.send(JSON.stringify({ t: "rpc", id, method, params }));
    });
  }

  close() { try { this.ws?.close(); } catch {} }

  head() { return this.call<{ height: number; hash: string; ts: number }>("chain.head"); }
  async blocks(from: number, to: number): Promise<BlockLite[]> {
    const bs = await this.call<any[]>("chain.blocks", { from, to });
    return (bs ?? []).map((b) => ({ height: b.header.height, hash: b.hash, ts: b.header.ts, txs: b.txs ?? [] }));
  }
  /** `balance` en texto decimal (velos). Pásalo a BigInt con `toAmount`. */
  account(address: string) { return this.call<{ balance: string; nonce: number; pending: number }>("account.get", { address }); }
  /** Saldos por token en texto decimal (unidades mínimas). */
  balances(address: string) { return this.call<Record<string, string>>("account.balances", { address }); }
  /** Créditos de mensajería comprados para una dirección (v4). */
  credits(address: string) { return this.call<{ address: string; credits: number }>("credits.of", { address }); }
  /** Contexto para construir tx: oráculo y bits del sello. */
  fees() { return this.call<{ oracle: any; powBits: number }>("chain.fees"); }
  submit(tx: object) { return this.call<{ id: string }>("tx.submit", { tx }); }
  token(symbol: string) { return this.call<any>("token.info", { symbol }); }
  delegations(params: { node?: string; address?: string }) { return this.call<any[]>("stake.delegations", params); }

  /** Siguiente nonce libre de una cuenta (confirmadas + pendientes en el mempool del nodo). */
  async nextNonce(address: string) { const a = await this.account(address); return a.nonce + a.pending; }
}
