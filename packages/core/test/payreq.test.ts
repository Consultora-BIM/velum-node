// Estándar de cobro (docs/pagos.md): URI velum:pay, factura firmada, NDEF y firmeza.
import { describe, expect, test } from "bun:test";
import {
  createInvoice, paymentURI, parsePaymentURI, verifyInvoice, paysInvoice, paymentMemo, ndefMessage, parseNdef, settlementOf,
  generateKeyPair, makeTransfer, UNIT, CHAIN_ID, BLOCK_MS, PAY_FINAL_CONFIRMATIONS, confirmationsFor, POW_MIN_BITS,
} from "../src";

const comercio = generateKeyPair();
const cliente = generateKeyPair();
const ctx = { oracle: null, powBits: 1 };

describe("cobros velum:pay", () => {
  test("factura firmada → URI → lectura y verificación", () => {
    const inv = createInvoice({ to: comercio.address, amount: 12n * UNIT + UNIT / 2n, ref: "T-0042", label: "Café y tostada", exp: 2_000_000_000_000, ts: 1_900_000_000_000, secret: comercio.secret });
    expect(verifyInvoice(inv)).toBe(true);
    const uri = paymentURI(inv);
    expect(uri.startsWith("velum:pay?to=" + comercio.address + "&amount=12.5&")).toBe(true);
    expect(uri).toContain("label=Caf%C3%A9%20y%20tostada");
    expect(uri.length).toBeLessThan(320);
    const r = parsePaymentURI(uri, 1_900_000_000_001);
    if (!r.ok) throw new Error(r.error);
    expect(r.signed && r.verified && !r.expired).toBe(true);
    expect(r.invoice.amount).toBe(12_500_000_000_000_000_000n);
    expect(r.invoice.label).toBe("Café y tostada");
    expect(r.invoice.chain).toBe(CHAIN_ID);
  });

  test("un QR alterado no verifica; caducada; sin firma; errores", () => {
    const inv = createInvoice({ to: comercio.address, amount: 5n * UNIT, ref: "A1", secret: comercio.secret, exp: 1_000 });
    const uri = paymentURI(inv).replace("amount=5", "amount=50");
    const r = parsePaymentURI(uri, 0);
    expect(r.ok && r.signed && !r.verified).toBe(true);
    expect((parsePaymentURI(paymentURI(inv), 5_000) as any).expired).toBe(true);
    const libre = parsePaymentURI(`velum:pay?to=${comercio.address}&amount=0.000000000000000001`);
    expect(libre.ok && !libre.signed && libre.invoice.amount === 1n).toBe(true);
    expect(parsePaymentURI(`velum:${comercio.address}`)).toEqual({ ok: false, error: "Falta el importe" });
    expect(parsePaymentURI("bitcoin:abc").ok).toBe(false);
    expect(parsePaymentURI(`velum:pay?to=${comercio.address}&amount=1.0000000000000000001`).ok).toBe(false);
    expect(() => createInvoice({ to: comercio.address, amount: 1n, secret: cliente.secret })).toThrow();
    expect(() => createInvoice({ to: comercio.address, amount: 1n, ref: "con espacios" })).toThrow();
  });

  test("token con sus decimales (vUSDT)", () => {
    const inv = createInvoice({ to: comercio.address, amount: 2_500_000n, token: "vUSDT", secret: comercio.secret });
    const uri = paymentURI(inv);
    expect(uri).toContain("amount=2.5&token=vUSDT&dec=6");
    const r = parsePaymentURI(uri);
    expect(r.ok && r.verified && r.invoice.amount === 2_500_000n).toBe(true);
  });

  test("el pago que cuadra: destino, token, importe ≥ y memo pay:<ref>", () => {
    const inv = createInvoice({ to: comercio.address, amount: 3n * UNIT, ref: "R9", secret: comercio.secret });
    const pago = makeTransfer(cliente.secret, cliente.address, comercio.address, 3n * UNIT, 0, { memo: paymentMemo(inv), ctx });
    expect(paysInvoice(pago, inv)).toBe(true);
    // tal como llega de la red (texto decimal)
    expect(paysInvoice(JSON.parse(JSON.stringify(pago)), inv)).toBe(true);
    expect(paysInvoice(makeTransfer(cliente.secret, cliente.address, comercio.address, 3n * UNIT - 1n, 0, { memo: "pay:R9", ctx }), inv)).toBe(false);
    expect(paysInvoice(makeTransfer(cliente.secret, cliente.address, comercio.address, 3n * UNIT, 0, { memo: "pay:OTRA", ctx }), inv)).toBe(false);
    expect(paysInvoice(makeTransfer(cliente.secret, cliente.address, cliente.address, 3n * UNIT, 0, { memo: "pay:R9", ctx }), inv)).toBe(false);
    expect(POW_MIN_BITS).toBeGreaterThan(0);
  });

  test("NFC: mensaje NDEF con registro URI de ida y vuelta", () => {
    const uri = paymentURI(createInvoice({ to: comercio.address, amount: UNIT, ref: "N1", secret: comercio.secret }));
    const m = ndefMessage(uri);
    expect(m[0]).toBe(0xd1); // MB|ME|SR|TNF=1
    expect(m[3]).toBe(0x55);
    expect(parseNdef(m)).toBe(uri);
    const largo = "velum:pay?to=x&label=" + "a".repeat(300);
    expect(parseNdef(ndefMessage(largo))).toBe(largo);
  });

  test("firmeza: incluido en un bloque y firme con 30", () => {
    expect(settlementOf(0).state).toBe("pendiente");
    const s = settlementOf(1);
    expect(s.state).toBe("incluido");
    expect(s.remainingMs).toBe((PAY_FINAL_CONFIRMATIONS - 1) * BLOCK_MS);
    expect(settlementOf(30).state).toBe("firme");
    expect(confirmationsFor(20_000n * UNIT)).toBe(1_800);
    expect(confirmationsFor(5n * UNIT)).toBe(30);
  });
});
