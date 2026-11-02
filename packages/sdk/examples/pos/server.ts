#!/usr/bin/env bun
// TPV mínimo con Velum (docs/pagos.md §4): escribe el importe, enseña un QR y se pone verde al cobrar.
//
//   VELUM_POS_KEY=<clave hex de la cartera que cobra> bun packages/sdk/examples/pos/server.ts
//   bun packages/sdk/examples/pos/server.ts --demo        (cadena simulada: el «cliente» paga a los 4 s)
//
// Abre http://localhost:7480. Sin custodia: el VEL va directo a la cartera del comercio.
// Puerta: VELUM_HUB (por defecto wss://velumprotocol.org/hub?role=client). Puerto: POS_PORT (7480).
import { generateKeyPair, keyPairFromSecret, makeTransfer, parseAmount, formatAmount } from "@velum/core";
import { VelumRpc, createInvoice, watchPayment, paymentMemo, type Invoice, type PaymentChain, type PaymentUpdate } from "../../src";

const demo = process.argv.includes("--demo");
const port = Number(process.env.POS_PORT ?? 7480);
const key = process.env.VELUM_POS_KEY ? keyPairFromSecret(process.env.VELUM_POS_KEY.trim()) : generateKeyPair();
if (!process.env.VELUM_POS_KEY) console.warn("Aviso: sin VELUM_POS_KEY uso una cartera nueva de usar y tirar (solo para probar).");

/** Cadena simulada para --demo: un bloque cada 2 s; el cliente paga 4 s después de pedir el cobro. */
class Simulada implements PaymentChain {
  bloques: { height: number; hash: string; ts: number; txs: any[] }[] = [{ height: 0, hash: "g", ts: Date.now(), txs: [] }];
  cola: any[] = [];
  constructor() { setInterval(() => { const h = this.bloques.length; this.bloques.push({ height: h, hash: "s" + h, ts: Date.now(), txs: this.cola.splice(0) }); }, 2_000); }
  async head() { return { height: this.bloques.length - 1 }; }
  async blocks(a: number, b: number) { return this.bloques.slice(a, b + 1); }
  pagar(inv: Invoice) {
    const c = generateKeyPair();
    setTimeout(() => this.cola.push(makeTransfer(c.secret, c.address, inv.to, inv.amount, 0, { memo: paymentMemo(inv), ctx: { oracle: null, powBits: 1 } })), 4_000);
  }
}
const sim = demo ? new Simulada() : null;
const chain: PaymentChain = sim ?? new VelumRpc(process.env.VELUM_HUB ?? "wss://velumprotocol.org/hub?role=client");

const cobros = new Map<string, { invoice: Invoice; uri: string; estado: PaymentUpdate | null }>();
const html = await Bun.file(new URL("./index.html", import.meta.url)).text();

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (url.pathname === "/api/cobro" && req.method === "POST") {
      const b = (await req.json().catch(() => ({}))) as { amount?: string; label?: string };
      const amount = parseAmount(String(b.amount ?? ""), 18, "es-ES");
      if (!amount || amount <= 0n) return Response.json({ error: "Importe no válido" }, { status: 400 });
      const ref = "pos-" + crypto.randomUUID().slice(0, 8);
      const { invoice, uri } = createInvoice({ to: key.address, amount, ref, label: b.label?.slice(0, 64) || undefined, exp: Date.now() + 15 * 60_000, secret: key.secret });
      const c = { invoice, uri, estado: null as PaymentUpdate | null };
      cobros.set(ref, c);
      watchPayment(chain, invoice, { onUpdate: (u) => { c.estado = u; } }).catch((e) => console.error(ref, e.message));
      sim?.pagar(invoice);
      return Response.json({ ref, uri, importe: formatAmount("VEL", amount), comercio: key.address });
    }
    const m = /^\/api\/cobro\/(pos-[0-9a-f]{8})$/.exec(url.pathname);
    if (m) {
      const c = cobros.get(m[1]!);
      if (!c) return Response.json({ error: "No existe" }, { status: 404 });
      return Response.json({ estado: c.estado?.state ?? "pendiente", confirmaciones: c.estado?.confirmations ?? 0, necesarias: c.estado?.need ?? 30, quedaMs: c.estado?.remainingMs ?? null, tx: c.estado?.txId ?? null });
    }
    return new Response("No encontrado", { status: 404 });
  },
});
console.log(`TPV en http://localhost:${port}  ·  cobra en ${key.address}${demo ? "  ·  modo demo" : ""}`);
