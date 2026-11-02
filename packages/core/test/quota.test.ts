import { describe, expect, test } from "bun:test";
import * as V from "../src";

const dev = () => V.bytesToHex(V.randomBytes(32));
const clock = (t0 = 1_800_000_000_000) => { let t = t0; return { now: () => t, add: (ms: number) => { t += ms; } }; };

describe("pase de envío", () => {
  test("seudónimo diario: estable en el día, distinto al día siguiente y distinto de la clave del dispositivo", () => {
    const d = dev();
    const day = 1_800_000_000_000;
    const a = V.quotaSecret(d, day), b = V.quotaSecret(d, day + 1000), c = V.quotaSecret(d, day + V.DAY_MS);
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(V.keyPairFromSecret(a).address).not.toBe(V.keyPairFromSecret(d).address);
  });

  test("valida firma, msg y hora", () => {
    const q = V.quotaSecret(dev());
    const p = V.makeRatePass(q, "m1");
    expect(V.ratePassProblem(p, "m1")).toBeNull();
    expect(V.ratePassProblem(p, "m2")).toBe("El pase no corresponde a este trozo");
    expect(V.ratePassProblem({ ...p, sig: "00".repeat(64) }, "m1")).toBe("Firma del pase no válida");
    expect(V.ratePassProblem(p, "m1", p.ts + V.CLOCK_SKEW_MS + 1)).toBe("Pase de envío caducado");
    expect(V.ratePassProblem({ v: 2 }, "m1")).toBe("Pase de envío no válido");
  });

  test("prueba de créditos atada a la clave del día", () => {
    const wallet = V.generateKeyPair();
    const q = V.quotaSecret(dev());
    const p = V.makeRatePass(q, "m", Date.now(), { address: wallet.address, secret: wallet.secret });
    expect(V.ratePassProblem(p, "m")).toBeNull();
    // La firma de créditos de otra clave de cupo no vale.
    const other = V.makeRatePass(V.quotaSecret(dev()), "m", Date.now(), { address: wallet.address, secret: wallet.secret });
    expect(V.ratePassProblem({ ...p, cr: other.cr }, "m")).toBe("Prueba de créditos no válida");
  });
});

describe("cupo gratis (20 mensajes / 10 min)", () => {
  test("sin pase: por conexión; los trozos de una copia cuentan una vez", () => {
    const c = clock();
    const L = new V.QuotaLedger(null, c.now);
    for (let i = 0; i < V.FREE_COPIES_PER_WINDOW; i++) {
      expect(L.check(`m${i}`, { conn: "a" })).toBeNull();
      expect(L.check(`m${i}`, { conn: "a" })).toBeNull(); // otro trozo de la misma copia
    }
    expect(L.check("extra", { conn: "a" })).toContain("Cupo gratis agotado");
    expect(L.check("extra", { conn: "b" })).toBeNull(); // otra conexión, otro cupo
    c.add(V.QUOTA_WINDOW_MS);
    expect(L.check("extra", { conn: "a" })).toBeNull(); // ventana nueva
  });

  test("con pase: el cupo sigue al seudónimo aunque cambie de conexión", () => {
    const c = clock(Date.now());
    const L = new V.QuotaLedger(null, c.now);
    const q = V.quotaSecret(dev(), c.now());
    for (let i = 0; i < V.FREE_COPIES_PER_WINDOW; i++) expect(L.check(`m${i}`, { conn: `c${i % 3}`, pass: V.makeRatePass(q, `m${i}`, c.now()) })).toBeNull();
    expect(L.check("x", { conn: "nueva", pass: V.makeRatePass(q, "x", c.now()) })).toContain("Cupo gratis agotado");
    expect(L.check("x", { conn: "nueva", pass: { v: 1, k: "basura" } })).toBe("Pase de envío no válido");
  });

  test("una conexión no puede rotar seudónimos sin límite", () => {
    const c = clock(Date.now());
    const L = new V.QuotaLedger(null, c.now);
    for (let i = 0; i < V.MAX_PASS_KEYS_PER_CONN; i++) expect(L.check(`m${i}`, { conn: "a", pass: V.makeRatePass(V.quotaSecret(dev()), `m${i}`, c.now()) })).toBeNull();
    expect(L.check("z", { conn: "a", pass: V.makeRatePass(V.quotaSecret(dev()), "z", c.now()) })).toContain("Demasiadas claves de envío");
  });

  test("tope holgado por red (IP)", () => {
    const c = clock();
    const L = new V.QuotaLedger(null, c.now);
    const cap = V.FREE_COPIES_PER_WINDOW * V.IP_COPIES_FACTOR;
    for (let i = 0; i < cap; i++) expect(L.check(`m${i}`, { conn: `c${Math.floor(i / V.FREE_COPIES_PER_WINDOW)}`, ip: "ip1" })).toBeNull();
    expect(L.check("y", { conn: "otra", ip: "ip1" })).toContain("desde esta red");
    expect(L.check("y", { conn: "otra", ip: "ip2" })).toBeNull();
  });

  test("créditos: suben el límite y se descuentan fuera de la cadena", () => {
    const c = clock(Date.now());
    const bought = new Map([["", 0]]);
    const used = new Map<string, number>();
    const book: V.CreditBook = {
      available: (a) => (bought.get(a) ?? 0) - (used.get(a) ?? 0),
      consume: (a) => used.set(a, (used.get(a) ?? 0) + 1),
    };
    const wallet = V.generateKeyPair();
    bought.set(wallet.address, 3);
    const L = new V.QuotaLedger(book, c.now);
    const q = V.quotaSecret(dev(), c.now());
    const pass = (m: string) => V.makeRatePass(q, m, c.now(), { address: wallet.address, secret: wallet.secret });
    for (let i = 0; i < V.FREE_COPIES_PER_WINDOW; i++) expect(L.check(`m${i}`, { conn: "a", pass: pass(`m${i}`) })).toBeNull();
    expect(used.get(wallet.address)).toBeUndefined(); // el cupo gratis no gasta créditos
    for (let i = 0; i < 3; i++) expect(L.check(`c${i}`, { conn: "a", pass: pass(`c${i}`) })).toBeNull();
    expect(used.get(wallet.address)).toBe(3);
    expect(L.check("c3", { conn: "a", pass: pass("c3") })).toContain("Cupo gratis agotado");
  });
});

describe("topes por remitente en un buzón", () => {
  test("trozos y bytes pendientes, con caducidad y descuento al entregar", () => {
    const c = clock();
    const caps = new V.SenderMailboxCaps(c.now, 3, 1000);
    const exp = c.now() + 60_000;
    expect(caps.add("s", "mb", "1", 100, exp)).toBeNull();
    expect(caps.add("s", "mb", "1", 100, exp)).toBeNull(); // repetido: no cuenta dos veces
    expect(caps.add("s", "mb", "2", 100, exp)).toBeNull();
    expect(caps.add("s", "mb", "3", 100, exp)).toBeNull();
    expect(caps.add("s", "mb", "4", 100, exp)).toContain("Demasiados trozos pendientes");
    expect(caps.add("otro", "mb", "4", 100, exp)).toBeNull(); // otro remitente
    expect(caps.add("s", "mb2", "5", 100, exp)).toBeNull(); // otro buzón
    caps.remove("1");
    expect(caps.add("s", "mb", "4", 100, exp)).toBeNull();
    expect(caps.add("s", "mb3", "big", 1001, exp)).toContain("Demasiados trozos pendientes");
    c.add(60_001);
    expect(caps.add("s", "mb", "6", 100, c.now() + 1000)).toBeNull(); // los viejos caducaron
  });
});
