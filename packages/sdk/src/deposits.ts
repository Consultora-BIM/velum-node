// Vigilante de depósitos para exchanges: una dirección caliente y un `memo` por cliente (como XRP o Stellar),
// o una dirección por cliente. Emite cada pago entrante cuando tiene `confirmations` bloques encima.
import { txHash } from "./tx";
import type { BlockLite } from "./rpc";

export interface DepositEvent {
  txId: string;
  height: number;
  from: string;
  to: string;
  /** Unidades mínimas (µVEL o del token). */
  amount: number;
  token: string;
  memo?: string;
}

export interface ChainReader {
  head(): Promise<{ height: number }>;
  blocks(from: number, to: number): Promise<BlockLite[]>;
}

export interface DepositWatcherOptions {
  /** Direcciones del exchange que reciben. */
  addresses: string[];
  /** Bloques de espera. 30 (≈ 1 min) en mainnet día 1; ver docs/ecosistema.md §2.3. */
  confirmations?: number;
  /** Altura desde la que empezar (guárdala tras cada lote: es el cursor). */
  from?: number;
  /** Solo estos tokens (por defecto todos; VEL = "VEL"). */
  tokens?: string[];
}

export class DepositWatcher {
  cursor: number;
  private to: Set<string>;
  private conf: number;

  constructor(private chain: ChainReader, private o: DepositWatcherOptions) {
    this.cursor = o.from ?? 0;
    this.to = new Set(o.addresses);
    this.conf = o.confirmations ?? 30;
  }

  /** Revisa bloques nuevos con confirmaciones suficientes. Devuelve los depósitos encontrados (en orden). */
  async poll(batch = 100): Promise<DepositEvent[]> {
    const { height } = await this.chain.head();
    const safe = height - this.conf;
    const out: DepositEvent[] = [];
    while (this.cursor < safe) {
      const from = this.cursor + 1, to = Math.min(safe, this.cursor + batch);
      for (const b of await this.chain.blocks(from, to)) {
        for (const tx of b.txs) {
          if (tx?.type !== "transfer" || !this.to.has(tx.to)) continue;
          const token = tx.token ?? "VEL";
          if (this.o.tokens && !this.o.tokens.includes(token)) continue;
          out.push({ txId: txHash(tx), height: b.height, from: tx.from, to: tx.to, amount: tx.amount, token, memo: tx.memo });
        }
      }
      this.cursor = to;
    }
    return out;
  }
}
