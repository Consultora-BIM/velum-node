// Tests de la cadena (economía v4: importes BigInt de 18 decimales): oferta limitada, comisiones sin quema (0 bajo 1.000 € con sello PoW), Reserva, tokens,
// mercado, niveles por racha, fianza, reclamaciones con muestreo, oráculo TWAP, alias, conservación y determinismo.
import { expect, test, describe } from "bun:test";
import * as V from "../src";
import sample from "./appattest-sample.json";

const K = (t: string) => V.keyPairFromText(t);
const faucet = V.faucetKeyPair();
const alice = K("alice"), bob = K("bob"), carol = K("carol");
const PAIR = "VEL/tEUR";
const EUR = 1_000_000; // precio: 1 € por VEL = 1.000.000 µEUR (los precios siguen siendo `number`)
const EURt = 1_000_000n; // importe: 1 tEUR (6 decimales, BigInt)

const nonceOf = (s: V.ChainState, a: string) => s.accounts[a]?.nonce ?? 0;
/** Aplica una tx a un estado suelto (fuera de bloque) y exige que entre. */
function ok(s: V.ChainState, tx: V.Tx) {
  const e = V.applyTx(s, tx);
  if (e) throw new Error(e);
}
function tokenTotal(s: V.ChainState, token: string) {
  let t = 0n;
  for (const a of Object.keys(s.balances)) t += s.balances[a]![token] ?? 0n;
  return t;
}
function fresh() {
  const s = V.genesisState();
  s.height = 1;
  s.ts = V.GENESIS_TIME + 10_000;
  return s;
}
function fund(s: V.ChainState, to: string, vel: bigint, eur = 0n) {
  if (vel) ok(s, V.makeTransfer(faucet.secret, faucet.address, to, vel, nonceOf(s, faucet.address), { ts: 1, ctx: s }));
  if (eur) ok(s, V.makeTransfer(faucet.secret, faucet.address, to, eur, nonceOf(s, faucet.address), { token: "tEUR", ts: 1, ctx: s }));
}
/** Fija el oráculo a mano (tests de comisiones): precios en µunidad por VEL. */
function setPrices(s: V.ChainState, eur: number | null, usd: number | null = eur, usdt: number | null = usd) {
  Object.assign(s.oracle, { eur, usd, usdt });
}

describe("oferta limitada", () => {
  test("constantes, puertas y génesis", () => {
    expect(V.CHAIN_ID).toBe("velum-testnet-4");
    expect(V.PROTOCOL_VERSION).toBe(4);
    expect(V.UNIT).toBe(10n ** 18n);
    expect(V.MAX_SUPPLY).toBe(21_000_000_000n * V.UNIT);
    expect(V.GENESIS_RESERVE_SUPPLY).toBe(100_000_000n * V.UNIT);
    expect(V.MINEABLE_SUPPLY).toBe(20_900_000_000n * V.UNIT);
    expect(V.HALVING_EPOCHS).toBe(2_103_840); // 4 años de épocas de 1 min
    expect(V.MAX_HALVINGS).toBe(33);
    expect(V.R0).toBe(V.MINEABLE_SUPPLY / (2n * 2_103_840n));
    expect(V.GATEWAYS[0]).toBe("wss://velumprotocol.org/hub");
    expect(V.GATEWAYS[2]).toContain("workers.dev");
    expect(V.DEFAULT_GATEWAY).toBe(V.GATEWAYS[0]);
    const s = V.genesisState();
    for (const t of ["tEUR", "tUSD", "tUSDT"]) expect(V.balanceOf(s, faucet.address, t)).toBe(V.GENESIS_TOKEN_SUPPLY);
    expect(V.balanceOf(s, faucet.address)).toBe(V.GENESIS_RESERVE_SUPPLY);
    expect(s.supply.minted).toBe(V.GENESIS_RESERVE_SUPPLY);
    expect("burned" in s.supply).toBe(false); // sin quema
    expect(V.velLedgerGap(s)).toBe(0n);
  });

  test("33 mitades de emisión nunca superan el tope y a las 7 ya se ha descubierto ≥ 99 %", () => {
    const H = BigInt(V.HALVING_EPOCHS);
    let minted = V.GENESIS_RESERVE_SUPPLY;
    for (let k = 0; k <= V.MAX_HALVINGS; k++) {
      const e = k * V.HALVING_EPOCHS;
      // La emisión es constante dentro de cada mitad: primera y última época iguales.
      expect(V.emissionFor(e + V.HALVING_EPOCHS - 1)).toBe(V.emissionFor(e));
      minted += V.emissionFor(e) * H;
      expect(minted).toBeLessThanOrEqual(V.MAX_SUPPLY);
      if (k === 6) expect((minted - V.GENESIS_RESERVE_SUPPLY) * 100n).toBeGreaterThanOrEqual(V.MINEABLE_SUPPLY * 99n);
    }
    // Lo que queda sin descubrir tras 33 mitades es la cola R0·H/2^32 (≈ 2,4 VEL) más el redondeo de cada mitad.
    expect(V.MAX_SUPPLY - minted).toBeLessThan(((V.R0 * H) >> 32n) + 35n * H);
    expect(V.emissionFor(0)).toBe(V.R0);
    expect(V.emissionFor(V.HALVING_EPOCHS)).toBe(V.R0 / 2n);
    expect(V.emissionFor(32 * V.HALVING_EPOCHS)).toBe(V.R0 >> 32n);
    expect(V.emissionFor(32 * V.HALVING_EPOCHS)).toBeGreaterThan(0n);
    expect(V.emissionFor(33 * V.HALVING_EPOCHS)).toBe(0n);
    expect(V.emissionFor(100 * V.HALVING_EPOCHS)).toBe(0n);
  });
});

describe("comisiones v3: sin quema, 0 bajo 1.000 €, 1 pb desde 1.000 €", () => {
  test("reparto 80/20 exacto y sin quema", () => {
    expect(V.splitFee(10_000n)).toEqual({ pool: 8_000n, reserve: 2_000n });
    for (const f of [1n, 7n, 1001n, 123_457n, V.UNIT + 3n]) { const p = V.splitFee(f); expect(p.pool + p.reserve).toBe(f); }
  });

  test("umbral exacto de 1.000 € (VEL y tEUR) y sin precio no hay comisión", () => {
    const p = { eur: 2 * EUR, usd: 2_200_000, usdt: 2_200_000 }; // 2 € por VEL
    const bp500 = (500n * V.UNIT) / 10_000n; // 1 pb de 500 VEL = 0,05 VEL
    expect(V.transferFee(p, V.VEL, 500n * V.UNIT)).toBe(bp500); // 1.000 € justos → 1 pb de 500 VEL
    expect(V.transferFee(p, V.VEL, 500n * V.UNIT - 1n)).toBe(0n); // 1 velo menos: < 1.000 €
    expect(V.transferFee(p, "tEUR", 1_000n * EURt)).toBe(bp500); // 1.000 tEUR = 500 VEL
    expect(V.transferFee(p, "tEUR", 1_000n * EURt - 1n)).toBe(0n);
    expect(V.transferFee(p, V.VEL, 5_000n * V.UNIT)).toBe(V.UNIT / 2n); // 10.000 € → 0,5 VEL (1 €)
    expect(V.transferFee(p, V.VEL, 1n)).toBe(0n);
    expect(V.transferFee(null, V.VEL, 10n ** 33n)).toBe(0n); // «sin precio»
    expect(V.transferFee(p, "RARO", 10n ** 30n)).toBe(0n); // token sin precio
    const q = V.quote(500n * V.UNIT, V.VEL, { oracle: p, powBits: 16 });
    expect(q).toMatchObject({ fee: bp500, receive: 500n * V.UNIT, totalVel: 500n * V.UNIT + bp500, eur: 1_000n * EURt, usd: 1_100n * EURt, powBits: 0 });
    expect(V.quote(10n * V.UNIT, V.VEL, { oracle: p, powBits: 17 })).toMatchObject({ fee: 0n, eur: 20n * EURt, powBits: 17 });
    // Texto decimal también vale; un `number` es un error a propósito (¿µVEL de la v3 o velos?).
    expect(V.quote("500000000000000000000", V.VEL, { oracle: p, powBits: 16 }).fee).toBe(bp500);
    expect(() => V.quote(500 as any, V.VEL, { oracle: p, powBits: 16 })).toThrow();
  });

  test("pago gratis con sello, pago grande con comisión → bolsa y Reserva, contabilidad cuadrada", () => {
    const s = fresh();
    fund(s, alice.address, 2_000n * V.UNIT);
    expect(s.supply.feesCollected).toBe(0n); // sin precio: gratis
    setPrices(s, 2 * EUR);
    // Pequeño: comisión 0, necesita sello
    const small = V.makeTransfer(alice.secret, alice.address, bob.address, 10n * V.UNIT, 0, { ts: 1, ctx: s });
    expect(small.fee).toBe(0n);
    expect(V.powBits(small)).toBeGreaterThanOrEqual(16);
    const { pow: _p, sig: _s, ...noPow } = small;
    const unsealed = V.signTx(alice.secret, noPow as Omit<V.TransferTx, "sig">) as V.TransferTx;
    expect(V.applyTx(s, unsealed)).toContain("sello");
    ok(s, small);
    // Grande sin comisión: rechazado. Con la comisión que calcula la cartera: entra.
    const cheat = V.makeTransfer(alice.secret, alice.address, bob.address, 600n * V.UNIT, 1, { ts: 1, ctx: s, fee: 0n });
    expect(V.applyTx(s, cheat)).toContain("Comisión mínima");
    // Un importe `number` en una tx se rechaza (la red solo acepta texto decimal o BigInt).
    expect(() => V.makeTransfer(alice.secret, alice.address, bob.address, 600 as any, 1, { ts: 1, ctx: s })).toThrow();
    const asNumber = V.signTx(alice.secret, { type: "transfer", chain: V.CHAIN_ID, from: alice.address, to: bob.address, amount: 600, fee: 0, nonce: 1, ts: 1 } as any) as V.Tx;
    expect(V.checkTx(asNumber)).toContain("Importe no válido");
    expect(V.applyTx(s, asNumber)).toContain("Importe no válido");
    const big = V.makeTransfer(alice.secret, alice.address, bob.address, 600n * V.UNIT, 1, { ts: 1, ctx: s });
    expect(big.fee).toBe((600n * V.UNIT) / 10_000n);
    expect(big.pow).toBeUndefined();
    // En JSON los importes van como texto decimal y así también entran.
    const wire = JSON.parse(JSON.stringify(big));
    expect(wire.amount).toBe("600000000000000000000");
    expect(V.checkTx(wire)).toBeNull();
    ok(s, wire);
    expect(s.epoch.pool).toBe((48n * V.UNIT) / 1_000n); // 80 % de 0,06 VEL
    expect(V.balanceOf(s, V.RESERVE_ADDRESS)).toBe((12n * V.UNIT) / 1_000n); // 20 %
    expect("burned" in s.supply).toBe(false); // no hay quema ni cuenta de quema
    expect((V as any).BURN_ADDRESS).toBeUndefined();
    expect(V.velLedgerGap(s)).toBe(0n);
  });
});

describe("prueba de trabajo", () => {
  test("validación: bits, ligada a la tx y a la firma", () => {
    expect(V.leadingZeroBits(new Uint8Array([0, 0, 0x10]))).toBe(19);
    expect(V.leadingZeroBits(new Uint8Array([0x80]))).toBe(0);
    const body = { type: "transfer", chain: V.CHAIN_ID, from: alice.address, to: bob.address, amount: "5", fee: "0", nonce: 0, ts: 1 };
    const t0 = performance.now();
    const sealed = V.attachPow(body, 16);
    const ms = performance.now() - t0;
    console.log(`sello 16 bits: ${ms.toFixed(0)} ms (nonce ${sealed.pow})`);
    expect(V.powBits(sealed)).toBeGreaterThanOrEqual(16);
    expect(V.powBits({ ...sealed, amount: "6" })).toBeLessThan(16 + 8); // otro cuerpo: el sello ya no sirve (casi seguro)
    expect(V.powBits({ ...sealed, pow: -1 })).toBe(0);
    expect(V.powBits({ ...sealed, sig: "x" })).toBe(V.powBits(sealed)); // la firma no entra en el sello
  });

  test("la dificultad sube con la carga en cadena y baja al aflojar (16…26, se acepta la anterior)", () => {
    const R = new Runner();
    R.step();
    R.s.pow.used = V.POW_TARGET_PER_EPOCH + 1;
    R.toEpochEnd();
    expect(R.s.pow).toMatchObject({ bits: 17, prev: 16, used: 0 });
    // Un sello de 16 bits aún vale una época (min(bits, prev)).
    expect(V.powRequired(R.s, V.makeTransfer(alice.secret, alice.address, bob.address, 1n, 0, { ts: 1 }))).toBe(16);
    R.toEpochEnd(); // poca carga → baja
    expect(R.s.pow).toMatchObject({ bits: 16, prev: 17 });
    R.toEpochEnd();
    expect(R.s.pow.bits).toBe(V.POW_MIN_BITS); // nunca por debajo de 16
  });
});

describe("tokens", () => {
  test("crear (100 VEL a la Reserva), emitir con sello y transferir", () => {
    const s = fresh();
    fund(s, alice.address, 150n * V.UNIT);
    const create = (sym: string, n: number) => V.makeTokenCreate(alice.secret, alice.address, n, { symbol: sym, name: "Puntos", decimals: 2, maxSupply: 1_000_000n, initial: "1000", mintable: true, ts: 1 });
    expect(V.applyTx(s, create("TUSDT", 0))).toBe("Símbolo ya existe");
    ok(s, create("PTS", 0));
    expect(V.balanceOf(s, V.RESERVE_ADDRESS)).toBe(100n * V.UNIT);
    expect(V.balanceOf(s, alice.address)).toBe(50n * V.UNIT);
    expect(s.supply.reserveIn).toBe(100n * V.UNIT);
    expect(s.tokens.PTS!.maxSupply).toBe(1_000_000n);
    ok(s, V.makeTokenMint(alice.secret, alice.address, 1, "PTS", bob.address, 500n, 1, s));
    expect(s.tokens.PTS!.supply).toBe(1_500n);
    ok(s, V.makeTransfer(bob.secret, bob.address, carol.address, 100n, 0, { token: "PTS", ts: 1, ctx: s })); // bob sin VEL: gratis
    expect(V.balanceOf(s, carol.address, "PTS")).toBe(100n);
    expect(tokenTotal(s, "PTS")).toBe(s.tokens.PTS!.supply);
    expect(V.velLedgerGap(s)).toBe(0n);
  });
});

describe("mercado", () => {
  test("cruce sin comisión bajo 1.000 €, con 1 pb desde 1.000 €, cancelación", () => {
    const s = fresh();
    fund(s, alice.address, 2_000n * V.UNIT);
    fund(s, bob.address, 0n, 10_000n * EURt);
    const eur0 = tokenTotal(s, "tEUR");
    ok(s, V.makeOrder(alice.secret, alice.address, 0, { pair: PAIR, side: "sell", price: 2 * EUR, amount: 1_000n * V.UNIT, ts: 1, ctx: s }));
    ok(s, V.makeOrder(bob.secret, bob.address, 0, { pair: PAIR, side: "buy", price: 2 * EUR, amount: 4n * V.UNIT, ts: 1, ctx: s }));
    expect(V.balanceOf(s, bob.address)).toBe(4n * V.UNIT); // sin comisión
    expect(V.balanceOf(s, alice.address, "tEUR")).toBe(8n * EURt); // 4 VEL × 2 € (quoteOf)
    expect(V.quoteOf(4n * V.UNIT, 2 * EUR)).toBe(8n * EURt);
    setPrices(s, 2 * EUR);
    ok(s, V.makeOrder(bob.secret, bob.address, 1, { pair: PAIR, side: "buy", price: 2 * EUR, amount: 600n * V.UNIT, ts: 1, ctx: s }));
    const fee = (600n * V.UNIT) / 10_000n;
    expect(V.balanceOf(s, bob.address)).toBe(604n * V.UNIT - fee); // 1.200 € → 1 pb de 600 VEL
    expect(s.epoch.pool + V.balanceOf(s, V.RESERVE_ADDRESS)).toBe(fee);
    const ask = V.ordersOf(s, alice.address)[0]!;
    ok(s, V.makeCancel(alice.secret, alice.address, 1, ask.id, 1, s));
    expect(V.balanceOf(s, V.ESCROW_ADDRESS)).toBe(0n);
    expect(tokenTotal(s, "tEUR")).toBe(eur0);
    expect(V.velLedgerGap(s)).toBe(0n);
    // sin sello no entra
    const raw = V.signTx(alice.secret, { type: "order.cancel", chain: V.CHAIN_ID, from: alice.address, nonce: 2, ts: 1, id: "o0" }) as V.Tx;
    expect(V.applyTx(s, raw)).toContain("sello");
  });
});

describe("niveles por antigüedad continua", () => {
  const node = () => ({ lastPresentEpoch: -1, streakStart: 0, streakPresent: 0, epochsPresent: 0 }) as V.NodeInfo;
  const M = V.MONTH_EPOCHS;

  test("progresión nuevo → activo → veterano → pilar y M(t)", () => {
    expect([0, 3, 4, 8, 24, 100].map(V.pillarMonths)).toEqual([6, 6, 7, 8, 12, 12]);
    const n = node();
    const tierAt = (e: number) => V.tierFor(n, e).id;
    for (let e = 0; e < 7 * M; e++) {
      V.markPresent(n, e);
      if (e === M - 2) expect(tierAt(e)).toBe("nuevo");
      if (e === M - 1) expect(tierAt(e)).toBe("activo");
      if (e === 3 * M - 1) expect(tierAt(e)).toBe("veterano");
      if (e === 6 * M - 1) expect(tierAt(e)).toBe("veterano"); // red de 5 meses: M(t) = 7
      if (e === 7 * M - 2) expect(tierAt(e)).toBe("veterano");
      if (e === 7 * M - 1) expect(tierAt(e)).toBe("pilar");
    }
    // Con la red más vieja el pilar pide más: a los 20 meses de red, M = 11.
    const late = node();
    const start = 20 * M;
    for (let e = start; e < start + 7 * M; e++) V.markPresent(late, e);
    expect(V.tierFor(late, start + 7 * M - 1).id).toBe("veterano");
    expect(V.nodeWeight({ ...n, kind: "full", bond: 0n } as V.NodeInfo, 7 * M - 1)).toBe(200);
  });

  test("la presencia exige 90/95/98 % y una ausencia > 48 h reinicia la racha", () => {
    const flaky = node();
    for (let e = 0; e < 2 * M; e++) if (e % 10 !== 0) V.markPresent(flaky, e); // 90 % justo
    expect(V.tierFor(flaky, 2 * M - 1).id).toBe("activo");
    const worse = node();
    for (let e = 0; e < 2 * M; e++) if (e % 5 !== 0) V.markPresent(worse, e); // 80 %
    expect(V.tierFor(worse, 2 * M - 1).id).toBe("nuevo");
    // Ausencia de 48 h exactas: no rompe. De 48 h + 1 época: se reinicia.
    const a = node(), b = node();
    for (let e = 0; e < 2 * M; e++) { V.markPresent(a, e); V.markPresent(b, e); }
    const gap = V.STREAK_GAP_EPOCHS;
    V.markPresent(a, 2 * M - 1 + gap + 1); // gap épocas sin señal
    V.markPresent(b, 2 * M - 1 + gap + 2); // gap + 1
    expect(a.streakStart).toBe(0);
    expect(b.streakStart).toBe(2 * M - 1 + gap + 2);
    expect(V.tierFor(b, 2 * M + gap + 1).id).toBe("nuevo");
    // Apagado más de 48 h sin volver: la racha ya cuenta 0 al evaluar.
    expect(V.tierFor(a, 2 * M + 3 * gap).id).toBe("nuevo");
  });

  test("1.000 nodos nuevos frente a 10 veteranos: misma emisión, reparto por peso y tope ×1,5", () => {
    const s = V.genesisState();
    const vets = Array.from({ length: 10 }, (_, i) => `vet${i}`);
    const farm = Array.from({ length: 1000 }, (_, i) => `dc${i}`);
    const pilar = { lastPresentEpoch: 9 * M, streakStart: 0, streakPresent: 9 * M + 1, kind: "full", bond: 0n } as V.NodeInfo;
    const nuevo = { lastPresentEpoch: 9 * M, streakStart: 9 * M, streakPresent: 1, kind: "full", bond: 0n } as V.NodeInfo;
    const E = 9 * M;
    expect(V.nodeWeight(pilar, E)).toBe(200);
    expect(V.nodeWeight(nuevo, E)).toBe(100);
    expect(V.nodeWeight({ ...pilar, bond: 10_000n * V.UNIT }, E)).toBe(400); // fianza ×2 (tope)
    expect(V.nodeWeight({ ...pilar, bond: 50_000n * V.UNIT }, E)).toBe(400);
    const run = (ids: string[], inflate?: string) => {
      s.epochNodes[String(E)] = V.makeSnapshot(E, "b", ids.map((id) => ({ node: id, w: V.nodeWeight(id.startsWith("vet") ? pilar : nuevo, E) })));
      const snap = s.epochNodes[String(E)]!;
      const T = 1_020_000; // tráfico total de la época (créditos)
      s.claims[String(E)] = Object.fromEntries(snap.nodes.map((n) => [n.node, {
        node: n.node, epoch: E, count: Math.floor((T * n.w) / snap.total) * (n.node === inflate ? 10 : 1), root: "0".repeat(128), height: 0, status: "proved" as const,
      }]));
      const cr = V.creditedClaims(s, E);
      const total = cr.reduce((a, c) => a + c.credited, 0);
      const share = (pred: (id: string) => boolean) => cr.filter((c) => pred(c.node)).reduce((a, c) => a + c.credited, 0) / total;
      return { cr, share };
    };
    const before = run(vets);
    expect(before.share((id) => id.startsWith("vet"))).toBe(1);
    const after = run([...vets, ...farm], "dc7");
    const vetShare = after.share((id) => id.startsWith("vet"));
    const one = (id: string) => after.cr.find((c) => c.node === id)!.credited;
    console.log(`10 veteranos frente a 1.000 nuevos: ${(vetShare * 100).toFixed(2)} % de la bolsa; por nodo veterano/nuevo = ${(one("vet0") / one("dc0")).toFixed(2)}`);
    expect(one("vet0") / one("dc0")).toBeCloseTo(2, 1); // ×1,00 frente a ×0,50
    expect(vetShare).toBeGreaterThan(0.019);
    // El nodo que infla ×10 su reclamación se queda en ~1,5× lo esperado.
    expect(one("dc7") / one("dc0")).toBeGreaterThan(1.45);
    expect(one("dc7") / one("dc0")).toBeLessThanOrEqual(1.51);
    // La emisión por época no depende de cuántos nodos haya.
    s.height = V.EPOCH_BLOCKS;
    s.epoch.produced = { [vets[0]!]: 1 };
    s.nodes[vets[0]!] = { address: vets[0]! } as V.NodeInfo;
    expect(V.computeEpochPot(s).emission).toBe(V.R0);
  });
});

// ---------- Bloques ----------
const reg = (k: V.KeyPair, nonce: number, kind: V.NodeKind = "full") =>
  V.makeRegister(k.secret, k.address, nonce, { name: "n", version: "3.0", kind, region: "EU", ts: 1 });
const pres = (k: V.KeyPair, s: V.ChainState, ts: number) => V.signObj(k.secret, V.presenceBody(k.address, s.height, ts)) as V.Presence;

class Runner {
  s: V.ChainState;
  blocks: V.Block[] = [];
  keys: V.KeyPair[] = [];
  constructor(start = Date.now() - 3 * 3600_000) {
    this.s = V.genesisState();
    this.s.ts = start;
  }
  /** Bloque siguiente; propone el de puesto 0 entre `keys` (o el primero). Con señal de vida de todos. */
  /** Bloque siguiente firmado, sin aplicar. */
  build(input: Partial<V.BuildInput> = {}) {
    const ts = this.s.ts + V.BLOCK_MS;
    const slot = V.slotOf(ts);
    const proposer = this.keys.find((k) => V.proposerRank(this.s, slot, k.address) === 0) ?? this.keys[0] ?? faucet;
    const presence = this.keys.filter((k) => this.s.nodes[k.address]).map((k) => pres(k, this.s, ts));
    const { block } = V.buildBlock(this.s, { proposer: proposer.address, ts, txs: [], presence, ...input });
    return { ...block, sig: V.sign(proposer.secret, block.hash) } as V.Block;
  }
  step(input: Partial<V.BuildInput> = {}) {
    const ts = this.s.ts + V.BLOCK_MS;
    const slot = V.slotOf(ts);
    const proposer = this.keys.find((k) => V.proposerRank(this.s, slot, k.address) === 0) ?? this.keys[0] ?? faucet;
    const presence = this.keys.filter((k) => this.s.nodes[k.address]).map((k) => pres(k, this.s, ts));
    const { block, state } = V.buildBlock(this.s, { proposer: proposer.address, ts, txs: [], presence, ...input });
    const signed = { ...block, sig: V.sign(proposer.secret, block.hash) } as V.Block;
    const r = V.applyBlock(this.s, signed);
    if ("error" in r) throw new Error(r.error);
    expect(r.state.hash).toBe(state.hash);
    expect(V.velLedgerGap(r.state)).toBe(0n); // conservación en cada bloque
    this.s = r.state;
    this.blocks.push(signed);
    return signed;
  }
  toEpochEnd(input: (s: V.ChainState) => Partial<V.BuildInput> = () => ({})) {
    const out: V.Block[] = [];
    do out.push(this.step(input(this.s))); while (this.s.height % V.EPOCH_BLOCKS !== 0);
    return out;
  }
  /** Avanza hasta que el bloque siguiente sea de la época `e`. */
  toEpoch(e: number) {
    const out: V.Block[] = [];
    while (V.curEpoch({ height: this.s.height + 1 }) < e) out.push(this.step());
    return out;
  }
}

describe("reclamaciones de trabajo con muestreo", () => {
  test("reclamar, probar, liquidar; hoja falsa anula; sin prueba anula; recibos fuera de bloques", () => {
    const R = new Runner();
    const N = [1, 2, 3, 4, 5].map((i) => K("nodo-v3-" + i));
    R.keys = N;
    R.step({ txs: N.map((k) => reg(k, 0)) });
    expect(R.s.nodes[N[0]!.address]!.region).toBe("EU");
    R.toEpochEnd(); // foto 1
    const E = 1;
    const snap = V.currentSnapshot(R.s)!;
    expect(snap.epoch).toBe(E);
    expect(snap.nodes.every((n) => n.w === 100)).toBe(true); // completos nuevos sin fianza
    // Tráfico de la época 1: cada trozo lo llevan candidatos del sorteo (el cliente elige entre los 3).
    const leaves = new Map<string, V.WorkLeaf[]>(N.map((k) => [k.address, []]));
    for (let i = 0; i < 400; i++) {
      const shard = `trozo-${i}`;
      const carrier = V.lotteryCandidates(snap, shard, "carrier")[i % 3]!;
      const courier = V.lotteryCandidates(snap, shard, "courier")[(i >> 1) % 3]!;
      const secret = V.receiptSecret("33".repeat(32), shard);
      const r: V.ReceiptV2 = { shard, mailbox: "mb" + (i % 20), rh: V.receiptHash(secret), secret, carrier, courier, ts: R.s.ts, ep: E };
      expect(V.checkReceipt(R.s, r, R.s.ts)).toBeNull();
      for (const k of N) for (const role of V.claimableRoles(R.s, r, k.address)) leaves.get(k.address)!.push({ r, role });
    }
    // El nodo 5 infla su árbol con recibos donde no era candidato.
    const cheat = N[4]!;
    const fakes: V.WorkLeaf[] = [];
    for (let i = 0; fakes.length < 600; i++) {
      const shard = `falso-${i}`;
      if (V.lotteryCandidates(snap, shard, "carrier").includes(cheat.address)) continue;
      const secret = V.receiptSecret("44".repeat(32), shard);
      fakes.push({ r: { shard, mailbox: "x", rh: V.receiptHash(secret), secret, carrier: cheat.address, courier: cheat.address, ts: R.s.ts, ep: E }, role: "carrier" });
    }
    leaves.get(cheat.address)!.push(...fakes);
    // Un recibo en un bloque ya no vale.
    const bad = { ...R.build(), receipts: [leaves.get(N[0]!.address)![0]!.r] };
    const rb = V.applyBlock(R.s, bad);
    expect("error" in rb && rb.error).toContain("recibos");

    const trees = new Map(N.map((k) => [k.address, V.buildWorkTree(leaves.get(k.address)!)]));
    R.toEpoch(E + 1);
    // Reclaman todos; reclamar otra época o dos veces no vale.
    const claim = (k: V.KeyPair, nonce: number, epoch = E) => V.makeWorkClaim(k.secret, k.address, nonce, { epoch, count: trees.get(k.address)!.count, root: trees.get(k.address)!.root, ts: 1 });
    const cb = R.step({ txs: [...N.map((k) => claim(k, 1)), claim(N[0]!, 2), claim(N[1]!, 2, E + 1)] });
    expect(cb.txs.length).toBe(5);
    expect(V.claimsOf(R.s, E).length).toBe(5);
    // Las pruebas solo valen desde E+3 (baliza de la foto E+3).
    R.toEpoch(E + 3);
    const prove = (k: V.KeyPair) => {
      const c = R.s.claims[String(E)]![k.address]!;
      const t = trees.get(k.address)!;
      const idx = V.proofIndices(V.samplesFor(R.s, c)!, c.count);
      return V.makeWorkProve(k.secret, k.address, 2, { epoch: E, leaves: idx.map((i) => t.leaves[i]!), paths: idx.map((i) => V.workPath(t, i)), ts: 1 });
    };
    // El nodo 4 no prueba nada (se queda sin recompensa).
    const pb = R.step({ txs: [N[0]!, N[1]!, N[2]!, cheat].map(prove) });
    expect(pb.txs.length).toBe(4);
    const cl = R.s.claims[String(E)]!;
    expect([0, 1, 2].map((i) => cl[N[i]!.address]!.status)).toEqual(["proved", "proved", "proved"]);
    expect(cl[cheat.address]!.status).toBe("void");
    expect(cl[cheat.address]!.reason).toContain("candidatos");
    // Liquidación al cerrar E+4.
    const minted0 = R.s.supply.minted;
    const blocks = R.toEpoch(E + 5);
    const settle = blocks.find((x) => x.rewards.some((r) => r.kind === "work"))!;
    const work = settle.rewards.filter((r) => r.kind === "work" && r.epoch === E);
    expect(work.map((r) => r.node).sort()).toEqual([N[0]!, N[1]!, N[2]!].map((k) => k.address).sort());
    expect(R.s.nodes[cheat.address]!.claimsVoid).toBe(1);
    expect(R.s.nodes[N[3]!.address]!.claimsVoid).toBe(1);
    expect(R.s.claims[String(E)]).toBeUndefined();
    const credited = work.reduce((a, r) => a + r.shards, 0);
    expect(credited).toBe([0, 1, 2].reduce((a, i) => a + trees.get(N[i]!.address)!.count, 0));
    expect(R.s.stats.history.find((h) => h.epoch === E)!.credits).toBe(credited);
    expect(R.s.supply.minted).toBeGreaterThan(minted0);
    // Una hoja ya probada no se puede volver a probar (memoria de recibos).
    expect(Object.keys(R.s.seenReceipts).length).toBeGreaterThanOrEqual(3 * 16);
  }, 60_000);

  test("Merkle SHA-512: caminos, hoja impar y manipulación", () => {
    const hs = Array.from({ length: 7 }, (_, i) => V.sha512Hex("h" + i));
    const t = V.buildWorkTree(hs);
    expect(V.treeDepth(7)).toBe(3);
    const L0 = t.levels[0]!;
    for (let i = 0; i < 7; i++) expect(V.verifyWorkPath(L0[i]!, i, 7, V.workPath(t, i), t.root)).toBe(true);
    expect(V.verifyWorkPath(L0[1]!, 2, 7, V.workPath(t, 2), t.root)).toBe(false);
    expect(V.verifyWorkPath(t.levels[0]![6]!, 6, 8, V.workPath(t, 6), t.root)).toBe(false); // la cuenta va en la raíz
    for (let i = 0; i < 6; i++) expect(t.levels[0]![i]! < t.levels[0]![i + 1]!).toBe(true); // ordenadas
    expect(V.buildWorkTree([...hs, hs[0]!]).count).toBe(7); // sin repetidas
    expect(V.proofIndices([3, 6], 7)).toEqual([3, 4, 6]);
    const s1 = V.claimSamples("baliza", "nodo", 3, 1000);
    expect(new Set(s1).size).toBe(16);
    expect(V.claimSamples("baliza", "nodo", 3, 5).sort()).toEqual([0, 1, 2, 3, 4]);
    expect(V.claimSamples("baliza", "nodo", 3, 1000)).toEqual(s1);
  });
});

describe("fianza", () => {
  test("bloquea en escrow, sube el peso y vuelve tras 14 días", () => {
    const R = new Runner();
    const n = K("fianza-1");
    R.keys = [n];
    R.step({ txs: [reg(n, 0), V.makeTransfer(faucet.secret, faucet.address, n.address, 20_000n * V.UNIT, 0, { ts: 1 })] });
    R.step({ txs: [V.makeBond(n.secret, n.address, 1, 5_000n * V.UNIT, 1)] });
    expect(R.s.nodes[n.address]!.bond).toBe(5_000n * V.UNIT);
    expect(V.balanceOf(R.s, V.ESCROW_ADDRESS)).toBe(5_000n * V.UNIT);
    R.toEpochEnd();
    expect(V.currentSnapshot(R.s)!.nodes[0]!.w).toBe(2 * 75); // nuevo ×0,5 × fianza ×1,5
    R.step({ txs: [V.makeUnbond(n.secret, n.address, 2, 2_000n * V.UNIT, 1), V.makeUnbond(n.secret, n.address, 3, 9_000n * V.UNIT, 1)] });
    expect(R.s.nodes[n.address]!.bond).toBe(3_000n * V.UNIT);
    const u = R.s.nodes[n.address]!.unbonding[0]!;
    expect(u.release).toBe(V.curEpoch(R.s) + V.BOND_UNBOND_EPOCHS);
    const before = V.balanceOf(R.s, n.address);
    R.toEpochEnd();
    expect(V.balanceOf(R.s, V.ESCROW_ADDRESS)).toBe(5_000n * V.UNIT); // aún no (fianza + espera)
    R.s.nodes[n.address]!.unbonding[0]!.release = V.curEpoch({ height: R.s.height + 1 }); // atajo de test: «han pasado 14 días»
    R.toEpochEnd();
    expect(V.balanceOf(R.s, n.address)).toBeGreaterThanOrEqual(before + 2_000n * V.UNIT);
    expect(R.s.nodes[n.address]!.unbonding.length).toBe(0);
    expect(V.balanceOf(R.s, V.ESCROW_ADDRESS)).toBe(3_000n * V.UNIT);
  });
});

describe("oráculo TWAP", () => {
  /** Simula `epochs` épocas con un precio fijo y algo de volumen por época. */
  function feed(s: V.ChainState, from: number, epochs: number, prices: Record<string, number>, volPerEpoch = 100n * V.UNIT) {
    for (let e = from; e < from + epochs; e++) {
      for (let b = 0; b < V.EPOCH_BLOCKS; b++) {
        for (const [pair, p] of Object.entries(prices)) s.dex.pairs[pair] = { last: p, hours: [] };
        V.oracleSample(s, e);
      }
      for (const pair of Object.keys(prices)) V.oracleTrade(s, pair, volPerEpoch, e);
      V.oracleClose(s, e);
    }
  }

  test("una operación enorme no mueve la TWAP; volumen mínimo y reserva cruzada", () => {
    const s = V.genesisState();
    expect(s.oracle.eur).toBeNull();
    feed(s, 0, 60, { "VEL/tEUR": 2 * EUR, "VEL/tUSD": 2_200_000, "VEL/tUSDT": 2_200_000 });
    expect(V.oracleInfo(s)).toMatchObject({ eur: 2 * EUR, usd: 2_200_000, usdt: 2_200_000, src: { eur: "twap", usd: "twap", usdt: "twap" } });
    expect(s.oracle.fx).toBe(909_090); // 2 / 2,2 €/$
    // Una operación a 100× en un bloque (luego el mercado vuelve a 2 €).
    s.dex.pairs["VEL/tEUR"] = { last: 200 * EUR, hours: [] };
    V.oracleSample(s, 60);
    V.oracleTrade(s, "VEL/tEUR", 50_000n * V.UNIT, 60);
    for (let b = 1; b < V.EPOCH_BLOCKS; b++) { s.dex.pairs["VEL/tEUR"] = { last: 2 * EUR, hours: [] }; V.oracleSample(s, 60); }
    for (const p of ["VEL/tUSD", "VEL/tUSDT"]) { s.dex.pairs[p] = { last: 2_200_000, hours: [] }; for (let b = 0; b < V.EPOCH_BLOCKS; b++) V.oracleSample(s, 60); V.oracleTrade(s, p, 100n * V.UNIT, 60); }
    V.oracleClose(s, 60);
    const moved = s.oracle.eur! / (2 * EUR) - 1;
    console.log(`operación a 100× durante 1 bloque: la TWAP se mueve ${(moved * 100).toFixed(2)} %`);
    expect(moved).toBeLessThan(0.06);
    // tUSDT sin volumen: precio cruzado (mediana de los otros convertidos).
    const t = V.genesisState();
    feed(t, 0, 60, { "VEL/tEUR": 2 * EUR, "VEL/tUSD": 2_200_000 });
    feed(t, 60, 1, { "VEL/tUSDT": 9 * EUR }, 1n); // par casi sin volumen: no cuenta
    expect(t.oracle.src.usdt).toBe("cross");
    expect(t.oracle.usdt).toBeCloseTo(2_200_000, -2);
    // Sin ningún par válido: sin precio.
    const u = V.genesisState();
    feed(u, 0, 5, { "VEL/tEUR": 2 * EUR }, 10n * V.UNIT);
    expect(u.oracle.eur).toBeNull();
    expect(V.valueOf(u.oracle, V.VEL, V.UNIT).eur).toBeNull();
  });

  test("las operaciones reales alimentan el oráculo bloque a bloque", () => {
    const R = new Runner();
    R.step({ txs: [V.makeTransfer(faucet.secret, faucet.address, alice.address, 5_000n * V.UNIT, 0, { ts: 1 })] });
    R.step({ txs: [
      V.makeOrder(alice.secret, alice.address, 0, { pair: PAIR, side: "sell", price: 2 * EUR, amount: 3_000n * V.UNIT, ts: 1 }),
      V.makeOrder(faucet.secret, faucet.address, 1, { pair: PAIR, side: "buy", price: 2 * EUR, amount: 1_500n * V.UNIT, ts: 1 }),
    ] });
    R.toEpochEnd();
    expect(R.s.oracle.eur).toBe(2 * EUR);
    expect(R.s.oracle.volume.eur).toBe(1_500n * V.UNIT);
    expect(R.s.oracle.usd).toBe(Math.floor((2 * EUR * 1_000_000) / V.ORACLE_FX_EUR_PER_USD)); // cruzado con el cambio semilla
  });
});

describe("alias", () => {
  test("registrar, ocupado, uno por cartera, renovar, liberar, caducar", () => {
    const s = fresh();
    const mb = "55".repeat(32);
    const card = (k: V.KeyPair) => V.encodeCard(V.cardKeys(k, mb).card);
    const t0 = performance.now();
    const r1 = V.makeNameRegister(alice.secret, alice.address, 0, { name: "alice.v3", card: card(alice), ts: 1, ctx: s });
    console.log(`sello de alias (${s.pow.bits + V.NAME_POW_EXTRA_BITS} bits): ${(performance.now() - t0).toFixed(0)} ms`);
    expect(V.applyTx(s, { ...r1, pow: 0 } as V.Tx)).toMatch(/Firma|sello/);
    ok(s, r1);
    expect(V.nameInfo(s, "alice.v3")!.identity).toBe(alice.address);
    expect(V.nameOfAddress(s, alice.address)!.name).toBe("alice.v3");
    expect(V.applyTx(s, V.makeNameRegister(bob.secret, bob.address, 0, { name: "alice.v3", card: card(bob), ts: 1 }))).toBe("Alias ocupado");
    expect(V.applyTx(s, V.makeNameRegister(alice.secret, alice.address, 1, { name: "otra", card: card(alice), ts: 1 }))).toContain("uno por cartera");
    expect(V.checkTx(V.makeNameRelease(alice.secret, alice.address, 1, { name: "No-Vale", ts: 1 }))).toContain("Alias no válido");
    const exp0 = s.names["alice.v3"]!.expires;
    ok(s, V.makeNameRenew(alice.secret, alice.address, 1, { name: "alice.v3", ts: 1 }));
    expect(s.names["alice.v3"]!.expires).toBe(exp0 + V.NAME_TERM_EPOCHS);
    expect(V.applyTx(s, V.makeNameRenew(alice.secret, alice.address, 2, { name: "alice.v3", ts: 1 }))).toContain("máximo");
    ok(s, V.makeNameRelease(alice.secret, alice.address, 2, { name: "alice.v3", ts: 1 }));
    expect(V.nameInfo(s, "alice.v3")).toBeNull();
    expect(s.nameExpiry).toEqual({});
    ok(s, V.makeNameRegister(bob.secret, bob.address, 0, { name: "alice.v3", card: card(bob), ts: 1 }));
    // Caduca: queda libre para otro.
    s.names["alice.v3"]!.expires = V.curEpoch(s);
    expect(V.nameInfo(s, "alice.v3")).toBeNull();
    ok(s, V.makeNameRegister(carol.secret, carol.address, 0, { name: "alice.v3", card: card(carol), ts: 1 }));
    expect(V.nameOfAddress(s, bob.address)).toBeNull();
    expect(V.nameInfo(s, "alice.v3")!.owner).toBe(carol.address);
  }, 60_000);

  test("tarjeta y enlaces: ida y vuelta, firma y origen público", () => {
    const keys = V.cardKeys(alice, "66".repeat(32));
    const text = V.encodeCard(keys.card);
    expect(text.length).toBeLessThanOrEqual(V.CARD_MAX_CHARS);
    expect(V.decodeCard(text)).toEqual(keys.card);
    expect(V.cardKeys(alice, "66".repeat(32)).card).toEqual(keys.card); // determinista desde la identidad
    const link = V.cardLink(keys.card);
    expect(link.startsWith("https://velumprotocol.org/c/")).toBe(true);
    expect(V.parseVelumLink(link)).toEqual({ kind: "card", card: keys.card });
    expect(V.parseVelumLink(V.aliasLink("Alice.V3"))).toEqual({ kind: "alias", name: "alice.v3" });
    const inv = V.createInvite();
    expect(V.parseVelumLink(inv.link)).toEqual({ kind: "invite", secret: inv.secret });
    const raw = V.unb58(text);
    raw[40] ^= 1;
    expect(() => V.decodeCard(V.b58(raw))).toThrow();
  });
});

describe("atestación App Attest", () => {
  const appId = "35MFYY2JY5.co.chiff.attestation-test";
  const cdh = V.bytesToHex(V.sha256(V.decodeB64(sample.clientData)));
  const now = Date.UTC(2021, 3, 14, 10, 0, 0);
  test("positivo y tx en modo soft", () => {
    expect(V.verifyAppAttest({ attestation: sample.attestationObject, keyId: sample.keyID, clientDataHashHex: cdh, now, appId }).ok).toBe(true);
    const s = fresh();
    ok(s, V.makeAttest(alice.secret, alice.address, 0, { device: cdh, keyId: sample.keyID, attestation: sample.attestationObject, ts: 1 }));
    expect(s.devices[sample.keyID]!.verified).toBe(false);
  });
});

describe("determinismo y conservación", () => {
  test("dos reaplicaciones independientes dan el mismo estado", () => {
    const R = new Runner();
    const n1 = K("det-1"), n2 = K("det-2"), lite = K("det-l");
    R.keys = [n1, n2, lite];
    const f = faucet;
    let fn = 0;
    R.step({ txs: [reg(n1, 0), reg(n2, 0), reg(lite, 0, "light")] });
    R.step({ txs: [
      V.makeTransfer(f.secret, f.address, alice.address, 3_000n * V.UNIT, fn++, { ts: 1 }),
      V.makeTransfer(f.secret, f.address, bob.address, 5_000n * EURt, fn++, { token: "tEUR", ts: 1 }),
      V.makePoolFund(f.secret, f.address, fn++, "tUSD", 90n * EURt, 3, 1),
      V.makeTransfer(f.secret, f.address, n1.address, 100n * V.UNIT, fn++, { ts: 1 }),
    ] });
    R.step({ txs: [
      V.makeTokenCreate(alice.secret, alice.address, 0, { symbol: "ZETA", name: "Zeta", decimals: 0, maxSupply: 1000n, initial: 10n, mintable: true, ts: 1 }),
      V.makeOrder(alice.secret, alice.address, 1, { pair: PAIR, side: "sell", price: 2 * EUR, amount: 2_000n * V.UNIT, ts: 1 }),
      V.makeOrder(bob.secret, bob.address, 0, { pair: PAIR, side: "buy", price: 3 * EUR, amount: 1_200n * V.UNIT, ts: 1 }),
      V.makeBond(n1.secret, n1.address, 1, 50n * V.UNIT, 1),
    ] });
    for (let e = 0; e < 3; e++) R.toEpochEnd();
    expect(R.s.oracle.eur).toBe(2 * EUR);
    // Ya hay precio: un pago grande paga comisión, uno pequeño no.
    const ctx = V.feeContext(R.s);
    R.step({ txs: [
      V.makeTransfer(alice.secret, alice.address, carol.address, 600n * V.UNIT, 2, { ts: 1, ctx }),
      V.makeTransfer(alice.secret, alice.address, carol.address, 1n * V.UNIT, 3, { ts: 1, ctx }),
    ] });
    expect(R.s.supply.feesCollected).toBe(100n * V.UNIT + (600n * V.UNIT) / 10_000n);
    R.toEpochEnd();
    const info = V.supplyInfo(R.s);
    expect("burned" in info).toBe(false);
    expect(info.circulating).toBe(info.minted); // sin quema: acuñado = en circulación
    expect(info.reserveOut).toBeGreaterThan(0n); // la Reserva ya devuelve 0,1 %/época
    expect(R.s.supply.minted).toBeLessThanOrEqual(V.MAX_SUPPLY);
    const replay = () => {
      let s = V.genesisState();
      s.ts = R.blocks[0]!.header.ts - V.BLOCK_MS;
      for (const b of JSON.parse(JSON.stringify(R.blocks)) as V.Block[]) {
        const r = V.applyBlock(s, b);
        if ("error" in r) throw new Error(r.error);
        s = r.state;
      }
      return s;
    };
    const a = replay(), b = replay();
    expect(a.hash).toBe(R.s.hash);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  }, 60_000);
});

describe("rendimiento", () => {
  test("applyBlock con 10.000 reclamaciones", () => {
    const s0 = V.genesisState();
    const prop = K("perf-prop");
    s0.ts = Date.now() - 600_000;
    s0.height = 2 * V.EPOCH_BLOCKS; // el bloque siguiente es de la época 2: se reclama la 1
    const node = (address: string, kind: V.NodeKind): V.NodeInfo => ({
      address, name: "p", payout: address, version: "3", kind, registeredHeight: 0, registeredEpoch: 0, lastPresence: s0.height,
      epochsPresent: 1, lastPresentEpoch: 1, streakStart: 0, streakPresent: 2, shardsDelivered: 0, credits: 0, blocksProduced: 0,
      earned: 0n, tier: "nuevo", bond: 0n, unbonding: [], claimsOk: 0, claimsVoid: 0,
    });
    s0.nodes[prop.address] = node(prop.address, "full");
    const t0 = performance.now();
    const keys = Array.from({ length: 10_000 }, (_, i) => K("perf-" + i));
    const root = "ab".repeat(64);
    const txs = keys.map((k) => { s0.nodes[k.address] = node(k.address, "light"); return V.makeWorkClaim(k.secret, k.address, 0, { epoch: 1, count: 1000, root, ts: 1 }); });
    const tSetup = performance.now() - t0;
    const ts = s0.ts + V.BLOCK_MS;
    const { block } = V.buildBlock(s0, { proposer: prop.address, ts, txs, presence: [] });
    const signed = { ...block, sig: V.sign(prop.secret, block.hash) } as V.Block;
    const t1 = performance.now();
    const r = V.applyBlock(s0, signed);
    const tApply = performance.now() - t1;
    if ("error" in r) throw new Error(r.error);
    expect(Object.keys(r.state.claims["1"]!).length).toBe(10_000);
    // Liquidación (tope y reparto) de 10.000 reclamaciones probadas.
    for (const c of Object.values(r.state.claims["1"]!)) c.status = "proved";
    r.state.epochNodes["1"] = V.makeSnapshot(1, "b", keys.map((k) => ({ node: k.address, w: 50 })));
    const t2 = performance.now();
    const cr = V.creditedClaims(r.state, 1);
    const tSettle = performance.now() - t2;
    expect(cr.length).toBe(10_000);
    console.log(`10.000 reclamaciones: firmar ${tSetup.toFixed(0)} ms · applyBlock ${tApply.toFixed(0)} ms · tope y reparto ${tSettle.toFixed(0)} ms · bloque ${(JSON.stringify(signed).length / 1024).toFixed(0)} KB`);
  }, 120_000);
});
