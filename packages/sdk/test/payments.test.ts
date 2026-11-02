// Cobros: createInvoice, parsePaymentURI y watchPayment con una cadena simulada (con reorganización).
import { describe, expect, test } from "bun:test";
import { generateKeyPair, makeTransfer, UNIT } from "@velum/core";
import { createInvoice, parsePaymentURI, watchPayment, paymentMemo, type PaymentChain, type PaymentUpdate } from "../src";

const tienda = generateKeyPair();
const cliente = generateKeyPair();
const ctx = { oracle: null, powBits: 1 };

class Cadena implements PaymentChain {
  bloques: { height: number; hash: string; ts: number; txs: any[] }[] = [{ height: 0, hash: "g", ts: 0, txs: [] }];
  async head() { return { height: this.bloques.length - 1 }; }
  async blocks(from: number, to: number) { return this.bloques.slice(from, to + 1); }
  minar(txs: any[] = [], rama = "a") { const h = this.bloques.length; this.bloques.push({ height: h, hash: `${rama}${h}`, ts: h * 2000, txs: JSON.parse(JSON.stringify(txs)) }); }
}

describe("SDK de cobros", () => {
  test("crear → leer → pagar → incluido → firme (y reorganización por el camino)", async () => {
    const { invoice, uri } = createInvoice({ to: tienda.address, amount: 7n * UNIT, ref: "caja1-0001", label: "Pan", secret: tienda.secret });
    const leido = parsePaymentURI(uri);
    expect(leido.ok && leido.verified).toBe(true);
    if (!leido.ok) return;

    const c = new Cadena();
    for (let i = 0; i < 3; i++) c.minar();
    const pago = makeTransfer(cliente.secret, cliente.address, leido.invoice.to, leido.invoice.amount, 0, { memo: paymentMemo(leido.invoice), ctx });
    const otros = makeTransfer(cliente.secret, cliente.address, tienda.address, 7n * UNIT, 1, { memo: "pay:otra", ctx });
    const estados: PaymentUpdate[] = [];
    let paso = 0;
    const r = await watchPayment(c, invoice, {
      from: 0, confirmations: 5, onUpdate: (u) => estados.push(u),
      sleep: async () => {
        paso++;
        if (paso === 1) c.minar([otros]);
        else if (paso === 2) c.minar([pago]); // altura 5
        else if (paso === 4) { c.bloques.length = 5; c.minar([], "b"); c.minar([], "b"); c.minar([pago], "b"); } // reorg: el pago pasa a la 7
        else c.minar();
      },
    });
    expect(r.state).toBe("firme");
    expect(r.height).toBe(7);
    expect(r.from).toBe(cliente.address);
    const seq = estados.map((e) => `${e.state}${e.height ?? ""}`);
    expect(seq[0]).toBe("pendiente");
    expect(seq).toContain("incluido5");
    expect(seq).toContain("incluido7");
    expect(seq.at(-1)).toBe("firme7");
    expect(estados.find((e) => e.state === "incluido")!.remainingMs).toBe(4 * 2000);
  });

  test("sin pago antes de caducar → «caducada»", async () => {
    const { invoice } = createInvoice({ to: tienda.address, amount: UNIT, ref: "x", exp: 10_000 });
    const c = new Cadena();
    let t = 0;
    const r = await watchPayment(c, invoice, { now: () => t, sleep: async () => { t += 4_000; c.minar(); } });
    expect(r.state).toBe("caducada");
  });
});
