// Puerta de admisión de trozos del nodo (antispam, fuera de consenso): cupo por remitente (quota.ts),
// topes por buzón (trozos y bytes) y topes por remitente dentro de un buzón. Todo con errores claros.
import {
  QuotaLedger, SenderMailboxCaps, senderKeyOf, MAX_SHARDS_PER_MAILBOX, MAX_BYTES_PER_MAILBOX,
  type CreditBook, type QuotaContext, type Shard,
} from "@velum/core";
import { shardBytes, type Store } from "./store";

export const MAILBOX_FULL = "Ese buzón está lleno; inténtalo más tarde";
export const MAILBOX_FULL_BYTES = "Ese buzón tiene demasiados datos pendientes; inténtalo más tarde";

export class ShardGate {
  readonly quota: QuotaLedger;
  readonly caps: SenderMailboxCaps;
  constructor(private store: Store, credits: CreditBook | null, private now: () => number = Date.now) {
    this.quota = new QuotaLedger(credits, now);
    this.caps = new SenderMailboxCaps(now);
  }

  /** Solo cupo (para llamadas que este nodo reenvía a otro sin guardarlas). */
  quotaOnly(shard: Shard, ctx: QuotaContext): string | null {
    return typeof shard?.msg === "string" ? this.quota.check(shard.msg, ctx) : null;
  }

  /**
   * Admisión completa de un `shard.put` de cliente. `ctx.conn` que empieza por "d:" = reenvío de otro nodo
   * (ese ya aplicó el cupo): aquí solo cuentan los topes de buzón, y por remitente solo si trae pase.
   */
  admit(shard: Shard, ctx: QuotaContext): string | null {
    const forwarded = ctx.conn.startsWith("d:");
    const full = this.mailboxProblem(shard);
    if (full) return full;
    if (!forwarded) {
      const q = this.quota.check(shard.msg, ctx);
      if (q) return q;
    }
    if (forwarded && !ctx.pass) return null;
    return this.caps.add(senderKeyOf(ctx, shard.msg, this.now()), shard.mailbox, shard.id, shardBytes(shard), shard.exp);
  }

  /** Topes por buzón (también para trozos que llegan por gossip). */
  mailboxProblem(shard: Shard): string | null {
    if (this.store.hasShard(shard.id)) return null;
    const u = this.store.mailboxUsage(shard.mailbox, this.now());
    if (u.n >= MAX_SHARDS_PER_MAILBOX) return MAILBOX_FULL;
    if (u.bytes + shardBytes(shard) > MAX_BYTES_PER_MAILBOX) return MAILBOX_FULL_BYTES;
    return null;
  }

  delivered(id: string) { this.caps.remove(id); }

  sweep() { this.quota.sweep(); this.caps.sweep(); }
}

/**
 * Libro de créditos del nodo: comprados (estado, solo lectura) menos gastados aquí (en `meta`, fuera de la
 * cadena). Lo gastado se guarda por lotes para no escribir en cada trozo.
 */
export class NodeCreditBook implements CreditBook {
  private used = new Map<string, number>();
  private dirty = false;
  constructor(private bought: (address: string) => number, private store: Store) {
    try {
      const raw = JSON.parse(store.getMeta("credits.used") ?? "{}") as Record<string, number>;
      for (const [a, n] of Object.entries(raw)) if (Number.isSafeInteger(n) && n > 0) this.used.set(a, n);
    } catch { /* libro dañado: se empieza de cero */ }
  }
  available(address: string) { return Math.max(0, this.bought(address) - (this.used.get(address) ?? 0)); }
  consume(address: string) { this.used.set(address, (this.used.get(address) ?? 0) + 1); this.dirty = true; }
  usedBy(address: string) { return this.used.get(address) ?? 0; }
  flush() {
    if (!this.dirty) return;
    this.store.setMeta("credits.used", JSON.stringify(Object.fromEntries(this.used)));
    this.dirty = false;
  }
}
