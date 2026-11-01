// Estado del puente en un JSON (escritura atómica: archivo temporal + rename). Pequeño, legible y fácil de auditar.
// Sin claves: solo índices de derivación, cursores, depósitos y retiros.
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ChainId, Family } from "./hd";

export type DepositStatus = "seen" | "submitted" | "minted" | "waiting_cap";
export interface DepositRec {
  id: string; // `<cadena>:<hash>:<logIndex>`
  chain: ChainId;
  txHash: string;
  logIndex: number;
  block: number;
  address: string;
  velAddress: string;
  amount: string; // unidades de 6 decimales
  status: DepositStatus;
  mintTx?: string;
  mintedHeight?: number;
  seenAt: number;
  submittedAt?: number;
}

/** queued: espera turno · held: frenado por tope o revisión · exported: en un archivo para firmar · sent: emitido · paid: confirmado · refund: se devuelve en vUSDT. */
export type WithdrawalStatus = "queued" | "held" | "exported" | "sent" | "paid" | "refund" | "refunded";
export interface WithdrawalRec {
  id: string; // id de la tx bridge.redeem
  height: number;
  velAddress: string;
  dst: ChainId;
  to: string;
  amount: string; // lo canjeado
  payout: string; // lo que se paga (amount − comisión de retiro)
  status: WithdrawalStatus;
  reason?: string;
  txid?: string;
  day?: string;
  /** Última vez que se mandó la devolución (para no repetirla en cada vuelta). */
  refundAt?: number;
  updatedAt: number;
}

export interface StoreData {
  v: 1;
  /** Índice de depósito por cartera Velum y familia. */
  indexOf: Record<string, Partial<Record<Family, number>>>;
  /** Dueño de cada índice (inverso). */
  ownerOf: Record<Family, Record<string, string>>;
  nextIndex: Record<Family, number>;
  /** Último bloque revisado por cadena. */
  cursor: Partial<Record<ChainId, number>>;
  /** Altura Velum revisada (canjes y acuñaciones). */
  velumCursor: number;
  deposits: Record<string, DepositRec>;
  withdrawals: Record<string, WithdrawalRec>;
  /** Sumas por día (AAAA-MM-DD). */
  daily: Record<string, { minted: string; queued: string; byAddr: Record<string, number> }>;
  /** Altas de dirección (marcas de tiempo, última hora). */
  newAddrTimes: number[];
}

const empty = (): StoreData => ({
  v: 1, indexOf: {}, ownerOf: { tron: {}, evm: {} }, nextIndex: { tron: 0, evm: 0 }, cursor: {}, velumCursor: 0,
  deposits: {}, withdrawals: {}, daily: {}, newAddrTimes: [],
});

export class Store {
  data: StoreData;
  private file: string | null;

  /** `dir = null` → solo memoria (tests). */
  constructor(dir: string | null) {
    this.file = dir ? join(dir, "puente.json") : null;
    if (dir) mkdirSync(dir, { recursive: true });
    this.data = this.file && existsSync(this.file) ? { ...empty(), ...JSON.parse(readFileSync(this.file, "utf8")) } : empty();
  }

  save() {
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    writeFileSync(tmp, JSON.stringify(this.data, null, 1), { mode: 0o600 });
    renameSync(tmp, this.file);
  }

  day(ts = Date.now()) {
    const k = new Date(ts).toISOString().slice(0, 10);
    return (this.data.daily[k] ??= { minted: "0", queued: "0", byAddr: {} });
  }
}
