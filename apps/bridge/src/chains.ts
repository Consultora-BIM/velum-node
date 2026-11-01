// Acceso a las cadenas de depósito por JSON-RPC (estilo Ethereum). TRON también lo ofrece (TronGrid /jsonrpc),
// así que un mismo cliente sirve para las tres. Solo lectura y emisión de transacciones ya firmadas: aquí no hay claves.
// `fetch` se inyecta para poder probar con cadenas simuladas (sin red ni fondos reales).
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import type { ChainConfig } from "./config";
import { addr20Of, type ChainId } from "./hd";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;

/** keccak256("Transfer(address,address,uint256)") */
export const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const BALANCE_OF = "70a08231";

export interface Deposit {
  chain: ChainId;
  txHash: string; // sin 0x, minúsculas
  logIndex: number;
  block: number;
  /** 20 bytes en hex (minúsculas) del destinatario. */
  to20: string;
  amount: bigint;
}

const pad32 = (hex: string) => hex.replace(/^0x/, "").padStart(64, "0");
const strip = (h: string) => h.replace(/^0x/, "").toLowerCase();
const num = (h: string) => Number(BigInt(h));

export class ChainClient {
  private id = 0;
  constructor(readonly cfg: ChainConfig, private fetcher: Fetch = fetch) {}

  get chain(): ChainId { return this.cfg.id; }

  async rpc<T = any>(method: string, params: unknown[]): Promise<T> {
    const res = await this.fetcher(this.cfg.rpc, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++this.id, method, params }),
    });
    if (!res.ok) throw new Error(`${this.chain}: RPC ${method} respondió ${res.status}`);
    const j = (await res.json()) as { result?: T; error?: { message: string } };
    if (j.error) throw new Error(`${this.chain}: ${method}: ${j.error.message}`);
    return j.result as T;
  }

  /** Contrato USDT en hex de 20 bytes con 0x. */
  get token20(): string { return "0x" + bytesToHex(addr20Of(this.chain, this.cfg.usdt)); }

  async head(): Promise<number> { return num(await this.rpc<string>("eth_blockNumber", [])); }

  /** Transferencias de USDT hacia cualquiera de `to20s` en [from, to]. Parte la lista para no pasar del límite de temas. */
  async transfersTo(to20s: string[], from: number, to: number): Promise<Deposit[]> {
    const out: Deposit[] = [];
    for (let i = 0; i < to20s.length; i += 100) {
      const topicTo = to20s.slice(i, i + 100).map((a) => "0x" + pad32(a));
      const logs = await this.rpc<any[]>("eth_getLogs", [{
        address: this.token20, fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16),
        topics: [TRANSFER_TOPIC, null, topicTo],
      }]);
      for (const l of logs ?? []) {
        if (l.removed) continue;
        if (strip(l.address) !== strip(this.token20) || l.topics?.[0]?.toLowerCase() !== TRANSFER_TOPIC) continue;
        out.push({
          chain: this.chain, txHash: strip(l.transactionHash), logIndex: num(l.logIndex), block: num(l.blockNumber),
          to20: strip(l.topics[2]).slice(-40), amount: BigInt(l.data === "0x" ? 0 : l.data),
        });
      }
    }
    return out;
  }

  /** Saldo de USDT (unidades mínimas) de una dirección de esa cadena. */
  async usdtBalance(addr: string): Promise<bigint> {
    const data = "0x" + BALANCE_OF + pad32(bytesToHex(addr20Of(this.chain, addr)));
    const r = await this.rpc<string>("eth_call", [{ to: this.token20, data }, "latest"]);
    return BigInt(!r || r === "0x" ? 0 : r);
  }

  async nonce(addr: string): Promise<number> {
    return num(await this.rpc<string>("eth_getTransactionCount", ["0x" + bytesToHex(addr20Of(this.chain, addr)), "pending"]));
  }

  async gasPrice(): Promise<bigint> { return BigInt(await this.rpc<string>("eth_gasPrice", [])); }

  /** Último bloque: número, hash y hora (s). Para la referencia de bloque de TRON. */
  async latestBlock(): Promise<{ number: number; hash: string; ts: number }> {
    const b = await this.rpc<any>("eth_getBlockByNumber", ["latest", false]);
    return { number: num(b.number), hash: strip(b.hash), ts: num(b.timestamp) };
  }

  /** Estado de una transacción emitida: null si aún no está en un bloque. */
  async receipt(txHash: string): Promise<{ ok: boolean; block: number } | null> {
    const r = await this.rpc<any>("eth_getTransactionReceipt", ["0x" + strip(txHash)]);
    if (!r || !r.blockNumber) return null;
    return { ok: r.status === undefined || num(r.status) === 1, block: num(r.blockNumber) };
  }

  /** Emite una transacción ya firmada (sin conexión). Devuelve su hash. */
  async broadcast(rawHex: string): Promise<string> {
    if (this.chain === "tron") {
      if (!this.cfg.http) throw new Error("TRON: falta la URL HTTP para emitir");
      const res = await this.fetcher(this.cfg.http.replace(/\/$/, "") + "/wallet/broadcasthex", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ transaction: strip(rawHex) }),
      });
      const j = (await res.json()) as { result?: boolean; txid?: string; code?: string; message?: string };
      if (!j.result) throw new Error(`TRON rechazó la transacción: ${j.code ?? ""} ${j.message ? tronMsg(j.message) : ""}`.trim());
      return strip(j.txid ?? "");
    }
    return strip(await this.rpc<string>("eth_sendRawTransaction", ["0x" + strip(rawHex)]));
  }
}

/** TronGrid devuelve el mensaje en hex a veces. */
function tronMsg(m: string): string {
  if (!/^[0-9a-f]+$/i.test(m)) return m;
  try { return new TextDecoder().decode(hexToBytes(m)); } catch { return m; }
}
