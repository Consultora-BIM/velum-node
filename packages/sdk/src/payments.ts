// Cobros con Velum (docs/pagos.md): crear la factura, leer el QR/NFC del cliente y vigilar el pago hasta que es firme.
// Sirve para un TPV, una tienda web o la propia app («Cobrar»). Sin custodia: el VEL va directo a la cartera de quien cobra.
import {
  createInvoice as coreCreateInvoice, parsePaymentURI as coreParse, paymentURI, paysInvoice, settlementOf, confirmationsFor,
  type CreateInvoiceOptions, type Invoice, type ParsedPayment, type Settlement,
} from "@velum/core";
import { txHash } from "./tx";

export { paymentURI, paysInvoice, settlementOf, verifyInvoice, paymentMemo, ndefMessage, parseNdef, PAY_FINAL_CONFIRMATIONS } from "@velum/core";
export type { Invoice, ParsedPayment, Settlement } from "@velum/core";

/** Factura (firmada si se da `secret`) y su URI lista para el QR o la etiqueta NFC. */
export function createInvoice(o: CreateInvoiceOptions): { invoice: Invoice; uri: string } {
  const invoice = coreCreateInvoice(o);
  return { invoice, uri: paymentURI(invoice) };
}

/** Lee lo que da un QR, un enlace o una etiqueta NFC. */
export const parsePaymentURI = (uri: string, now?: number): ParsedPayment => coreParse(uri, now);

export interface PaymentChain {
  head(): Promise<{ height: number }>;
  blocks(from: number, to: number): Promise<{ height: number; hash: string; ts: number; txs: any[] }[]>;
}

export interface PaymentUpdate {
  state: Settlement | "caducada";
  txId?: string;
  height?: number;
  from?: string;
  confirmations: number;
  need: number;
  /** Espera estimada hasta «firme» (ritmo nominal de bloques). */
  remainingMs: number;
}

export interface WatchOptions {
  /** Altura desde la que buscar (por defecto, la cabeza al empezar menos 5 bloques). */
  from?: number;
  /** Bloques para «firme». Por defecto 30 (o 1.800 si el importe es ≥ 10.000 VEL). */
  confirmations?: number;
  intervalMs?: number;
  onUpdate?: (u: PaymentUpdate) => void;
  signal?: AbortSignal;
  /** Reloj (tests). */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Vigila la cadena hasta que la factura queda pagada y firme. Avisa en cada cambio (`onUpdate`):
 * «pendiente» → «incluido» (ya en un bloque, ~2 s) → «firme». Si el bloque del pago se reorganiza, vuelve a buscar.
 * Resuelve con el último estado («firme» o «caducada»); se para con `signal`.
 */
export async function watchPayment(chain: PaymentChain, inv: Invoice, o: WatchOptions = {}): Promise<PaymentUpdate> {
  const need = o.confirmations ?? confirmationsFor(inv.amount);
  const now = o.now ?? Date.now;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const every = o.intervalMs ?? 1_000;
  let cursor = o.from ?? Math.max(0, (await chain.head()).height - 5);
  let found: { txId: string; height: number; hash: string; from: string } | null = null;
  let last = "";
  const emit = (u: PaymentUpdate) => { const k = `${u.state}:${u.confirmations}:${u.txId ?? ""}`; if (k !== last) { last = k; o.onUpdate?.(u); } return u; };

  for (;;) {
    if (o.signal?.aborted) throw new Error("Vigilancia cancelada");
    const { height } = await chain.head();
    if (found) {
      // ¿Sigue el mismo bloque en esa altura? Si no, reorganización: se vuelve a buscar desde ahí.
      const [b] = await chain.blocks(found.height, found.height);
      if (!b || b.hash !== found.hash) { cursor = found.height - 1; found = null; }
    }
    while (!found && cursor < height) {
      const to = Math.min(height, cursor + 100);
      for (const b of await chain.blocks(cursor + 1, to)) {
        const tx = (b.txs ?? []).find((t) => paysInvoice(t, inv));
        if (tx) { found = { txId: txHash(tx), height: b.height, hash: b.hash, from: tx.from }; break; }
      }
      cursor = found ? found.height : to;
    }
    if (found) {
      const s = settlementOf(height - found.height + 1, need);
      const u = emit({ ...s, txId: found.txId, height: found.height, from: found.from });
      if (s.state === "firme") return u;
    } else {
      if (inv.exp && now() > inv.exp) return emit({ state: "caducada", confirmations: 0, need, remainingMs: 0 });
      emit({ ...settlementOf(0, need) });
    }
    await sleep(every);
  }
}
