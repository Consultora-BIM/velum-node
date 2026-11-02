// Colas de espera: transacciones, recibos de entrega y señales de vida que aún no están en un bloque.
import {
  applyTx, checkTxAt, cloneState, receiptId, verifyReceipt, verifyObj, txId, RECEIPT_WINDOW_MS,
  type ChainState, type Presence, type Receipt, type Tx,
} from "@velum/core";

const TX_TTL_MS = 30 * 60_000;
const MAX_PENDING_PER_SENDER = 64;
const MAX_MEMPOOL = 20_000;

/**
 * Mempool v2. La admisión prueba cada transacción con `applyTx` sobre un estado de prueba
 * (cabeza + lo ya admitido, en orden de llegada). `applyTx` es atómica: si falla, no toca nada.
 * Así valen todas las reglas (saldos por token, mercado, bolsas, atestación) sin duplicarlas aquí.
 */
export class Mempool {
  private txs = new Map<string, { tx: Tx; at: number }>();
  private trial: ChainState | null = null;
  private trialHash = "";

  get size() { return this.txs.size; }
  has(id: string) { return this.txs.has(id); }
  all(): Tx[] { return [...this.txs.values()].sort((a, b) => a.at - b.at).map((e) => e.tx); }

  pendingFrom(addr: string): Tx[] {
    return [...this.txs.values()].map((e) => e.tx).filter((t) => t.from === addr).sort((a, b) => a.nonce - b.nonce);
  }

  /** Estado de prueba = cabeza + transacciones en cola (se rehace al cambiar de cabeza). */
  private trialFor(s: ChainState): ChainState {
    if (this.trial && this.trialHash === s.hash) return this.trial;
    const t = cloneState(s);
    t.height = s.height + 1; // como si fueran al próximo bloque
    for (const e of [...this.txs.values()].sort((a, b) => a.at - b.at || a.tx.nonce - b.tx.nonce)) {
      if (applyTx(t, e.tx) !== null) this.txs.delete(txId(e.tx));
    }
    this.trial = t;
    this.trialHash = s.hash;
    return t;
  }

  /** Valida contra el estado y lo que ya hay en cola. Devuelve el id o un error. */
  add(tx: Tx, s: ChainState): { id: string } | { error: string } {
    const id = txId(tx);
    if (this.txs.has(id)) return { id };
    const err = checkTxAt(tx, s.height + 1); // formato v3 antes de la altura de la v4, v4 desde ella
    if (err) return { error: err };
    if (this.txs.size >= MAX_MEMPOOL) return { error: "Cola llena; vuelve a intentarlo en unos segundos" };
    const pend = this.pendingFrom(tx.from);
    if (pend.length >= MAX_PENDING_PER_SENDER) return { error: "Demasiadas transacciones en cola para esta cuenta" };
    const t = this.trialFor(s);
    const expected = t.accounts[tx.from]?.nonce ?? 0;
    if (tx.nonce < expected) return { error: pend.some((p) => p.nonce === tx.nonce) ? "Ya hay otra transacción con ese nonce en cola" : `Nonce ya usado (esperado ${expected})` };
    if (tx.nonce > expected) return { error: `Nonce con hueco (esperado ${expected})` };
    const e = applyTx(t, tx);
    if (e) return { error: e };
    this.txs.set(id, { tx, at: Date.now() });
    return { id };
  }

  /** Para el próximo bloque: por remitente, nonces seguidos desde el del estado; en orden de llegada. */
  select(s: ChainState, max = 1000): Tx[] {
    const bySender = new Map<string, { tx: Tx; at: number }[]>();
    for (const e of this.txs.values()) (bySender.get(e.tx.from) ?? bySender.set(e.tx.from, []).get(e.tx.from)!).push(e);
    const groups: { at: number; txs: Tx[] }[] = [];
    for (const [from, list] of bySender) {
      list.sort((a, b) => a.tx.nonce - b.tx.nonce);
      let n = s.accounts[from]?.nonce ?? 0;
      const ok: Tx[] = [];
      for (const e of list) {
        if (e.tx.nonce !== n) break;
        ok.push(e.tx);
        n++;
      }
      if (ok.length) groups.push({ at: Math.min(...list.map((e) => e.at)), txs: ok });
    }
    groups.sort((a, b) => a.at - b.at);
    return groups.flatMap((g) => g.txs).slice(0, max);
  }

  /** Tras un cambio de cabeza: fuera lo ya aplicado y lo caducado; el estado de prueba se rehará. */
  prune(s: ChainState) {
    const now = Date.now();
    for (const [id, e] of this.txs) {
      const acc = s.accounts[e.tx.from];
      if ((acc && e.tx.nonce < acc.nonce) || now - e.at > TX_TTL_MS) this.txs.delete(id);
    }
    this.trial = null;
  }

  delete(id: string) { this.txs.delete(id); this.trial = null; }
}

export class ReceiptPool {
  private m = new Map<string, Receipt>();
  get size() { return this.m.size; }
  has(id: string) { return this.m.has(id); }

  /** Comprobación sin estado: formato, prueba (sha512(secret) == rh) y plazo. Los recibos v2 no llevan firma. */
  static check(r: Receipt): string | null {
    if (!r || typeof r !== "object") return "Recibo no válido";
    if (!verifyReceipt(r)) return "Recibo no válido (el secreto no corresponde a la huella)";
    if (r.ts > Date.now() + 30_000 || r.ts < Date.now() - RECEIPT_WINDOW_MS + 60_000) return "Recibo fuera de plazo";
    return null;
  }

  add(r: Receipt): boolean {
    const id = receiptId(r);
    if (this.m.has(id)) return false;
    this.m.set(id, r);
    return true;
  }

  select(s: ChainState, ts: number, max = 2000): Receipt[] {
    const out: Receipt[] = [];
    for (const [id, r] of this.m) {
      if (s.seenReceipts[id] !== undefined || s.seenReceipts["s:" + r.shard] !== undefined) continue;
      if (r.ts > ts + 30_000 || r.ts < ts - RECEIPT_WINDOW_MS + 5_000) continue;
      out.push(r);
      if (out.length >= max) break;
    }
    return out;
  }

  prune(s: ChainState) {
    const now = Date.now();
    for (const [id, r] of this.m) if (s.seenReceipts[id] !== undefined || r.ts < now - RECEIPT_WINDOW_MS) this.m.delete(id);
  }
}

export class PresencePool {
  private m = new Map<string, Presence>();
  get size() { return this.m.size; }

  add(p: Presence): boolean {
    if (!p || typeof p.node !== "string" || typeof p.ts !== "number" || typeof p.height !== "number") return false;
    if (Math.abs(p.ts - Date.now()) > 30_000) return false;
    const cur = this.m.get(p.node);
    if (cur && cur.ts >= p.ts) return false;
    if (!verifyObj(p.node, p)) return false;
    this.m.set(p.node, p);
    return true;
  }

  select(s: ChainState, ts: number): Presence[] {
    return [...this.m.values()].filter((p) => s.nodes[p.node] && Math.abs(p.ts - ts) <= 30_000);
  }

  /** Quita las ya incluidas en un bloque y las viejas. */
  prune(included: Presence[]) {
    for (const p of included) {
      const cur = this.m.get(p.node);
      if (cur && cur.ts <= p.ts) this.m.delete(p.node);
    }
    const now = Date.now();
    for (const [k, p] of this.m) if (now - p.ts > 30_000) this.m.delete(k);
  }
}
