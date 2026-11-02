// Economía v4 en la mainnet viva: una cadena que cruza la altura de activación H.
//  · Antes de H, reglas v3 congeladas (µVEL, `number`); en H, migración ×10^12; después, reglas v4 (BigInt, 18 decimales).
//  · Tres nodos: A actualiza el binario en marcha, B reaplica desde génesis con el binario nuevo, C sigue con el viejo.
//  · Saldos idénticos en VEL a ambos lados de H, conservación en cada altura, fotos de estado antes y después de H.
// Se ejecuta con VELUM_NETWORK=mainnet (bun run test:mainnet). Los créditos de mensajería se prueban también en testnet.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as V from "../src";
import * as L from "../src/v3";
import { useTestGenesis } from "./genesis-de-prueba";

const ORIGINAL = V.upgrades();
const H = 3_600; // segundo cierre de época de mainnet (1.800 bloques por época)
const V1_ONLY: V.Upgrade[] = [{ version: 1, height: 0, name: "génesis" }];
const WITH_V4: V.Upgrade[] = [...V1_ONLY, { version: 4, height: H, name: "v4", migrate: V.migrateV4 }];

const prod = V.keyPairFromText("v4-productor");
const alice = V.keyPairFromText("v4-alice");
const bob = V.keyPairFromText("v4-bob");
const K = V.V3_TO_V4;

/** Tx v3 (importes `number` en µVEL), como las firmaba el nodo v2.0.0. */
function v3tx(s: V.ChainState, key: V.KeyPair, body: Record<string, unknown>, stamp = true) {
  const nonce = s.accounts[key.address]?.nonce ?? 0;
  const raw = { chain: V.CHAIN_ID, from: key.address, nonce, ts: s.ts, ...body };
  return V.signTx(key.secret, (stamp ? V.attachPow(raw, Math.min(s.pow.bits, s.pow.prev)) : raw) as any) as V.Tx;
}

describe.skipIf(!V.IS_MAINNET)("actualización v4 en velum-mainnet-1", () => {
  const blocks: V.Block[] = [];
  const states = new Map<number, V.ChainState>();
  let txAt: Record<number, V.Tx[]> = {};

  function nextBlock(s: V.ChainState, txs: V.Tx[] = []) {
    const ts = V.genesisTime() + (s.height + 1) * V.BLOCK_MS;
    const { block, state } = V.buildBlock(s, { proposer: prod.address, ts, txs, presence: [] });
    if (block.txs.length !== txs.length) throw new Error(`altura ${state.height}: se descartó una tx`);
    return { block: { ...block, sig: V.sign(prod.secret, block.hash) } as V.Block, state };
  }

  beforeAll(() => {
    useTestGenesis();
    // Nodo A: arranca con el binario viejo (solo v1) y actualiza en marcha antes de H.
    V.setUpgrades(V1_ONLY);
    let s = V.genesisState();
    const run = (until: number, txsFor: (s: V.ChainState) => V.Tx[] = () => []) => {
      while (s.height < until) {
        const txs = txsFor(s);
        const r = nextBlock(s, txs);
        blocks.push(r.block);
        s = r.state;
        states.set(s.height, s);
        if (txs.length) txAt[s.height] = txs;
      }
    };
    run(1, (x) => [V.makeRegister(prod.secret, prod.address, 0, { version: "2.0.0", ts: x.ts })]);
    run(1_800); // cierre de la época 0 con reglas v3: emisión v3 al productor
    // Movimientos v3: pago a alice, fianza del nodo, delegación de alice.
    run(1_801, (x) => [v3tx(x, prod, { type: "transfer", to: alice.address, amount: 1_000_000_000, fee: 0 })]);
    run(1_802, (x) => [v3tx(x, prod, { type: "node.bond", amount: 100_000_000 }, false)]);
    run(1_803, (x) => [v3tx(x, alice, { type: "stake.delegate", node: prod.address, amount: 10_000_000 })]);
    run(1_804, (x) => [v3tx(x, alice, { type: "stake.undelegate", node: prod.address, amount: 3_000_000 })]);
    V.setUpgrades(WITH_V4); // A instala el binario v2.1.0 sin borrar datos
    run(H + 20);
    run(H + 21, (x) => [V.makeTransfer(alice.secret, alice.address, bob.address, 250n * V.UNIT + 1n, x.accounts[alice.address]!.nonce, { ctx: x, ts: x.ts })]);
    run(H + 40);
  });
  afterAll(() => V.setUpgrades(ORIGINAL));

  test("antes de H: reglas v3 y versión 1 en la cabecera; desde H: v4", () => {
    expect(blocks[H - 2]!.header.pv).toBe(1);
    expect(blocks[H - 1]!.header.pv).toBe(4);
    expect(V.protocolAt(H - 1)).toBe(1);
    expect(V.protocolAt(H)).toBe(4);
    // La tx v3 lleva el importe como número (µVEL) y así sigue en el bloque.
    expect(typeof (txAt[1_801]![0] as any).amount).toBe("number");
    // La v4, como texto en la red.
    expect(JSON.parse(JSON.stringify(txAt[H + 21]![0])).amount).toBe((250n * V.UNIT + 1n).toString());
  });

  test("saldos idénticos en VEL a ambos lados de H y migración ×10^12", () => {
    const pre = states.get(H - 1)!, post = states.get(H)!;
    const pre3 = V.toV3(pre);
    // El estado v3 de H−1 es exactamente el de las reglas viejas.
    expect(pre3.balances[alice.address]!.VEL).toBe(1_000_000_000 - 10_000_000);
    expect("burned" in pre3.supply).toBe(true);
    for (const a of [alice.address, useTestGenesis().cold.velum.address, V.ESCROW_ADDRESS, prod.address]) {
      // Vista v4 de H−1 = estado v3 × 10^12, exacto.
      expect(V.balanceOf(pre, a)).toBe(BigInt(pre3.balances[a]?.VEL ?? 0) * K);
    }
    for (const a of [useTestGenesis().cold.velum.address, V.ESCROW_ADDRESS]) expect(V.balanceOf(post, a)).toBe(V.balanceOf(pre, a));
    // En H cierra la época 1 (ya con v4): alice, como delegada, cobra su parte de lo descubierto por el nodo.
    const toAlice = blocks[H - 1]!.rewards.reduce((t, r) => t + (r.delegators ?? 0n), 0n);
    expect(toAlice > 0n).toBe(true);
    expect(V.balanceOf(post, alice.address)).toBe(V.balanceOf(pre, alice.address) + toAlice);
    expect(post.nodes[prod.address]!.bond).toBe(100_000_000n * K);
    expect(post.stake!.del[prod.address]![alice.address]!.amount).toBe(7_000_000n * K);
    expect(post.stake!.unbonding[alice.address]![0]!.amount).toBe(3_000_000n * K);
    expect("burned" in post.supply).toBe(false);
    expect(post.supply.creditsPaid).toBe(0n);
    expect(post.msgCredits).toEqual({});
    // Lo acuñado antes de H se conserva (×10^12) y la emisión de la época que cierra en H ya es la v4.
    const p = V.computeEpochPot(pre);
    expect(post.supply.minted).toBe(BigInt(pre3.supply.minted) * K + V.emissionFor(1));
    expect(p.emission).toBe(V.emissionFor(1)); // vista v4 de la época que cierra en H
    expect(V.emissionFor(1)).toBe(V.R0);
  });

  test("conservación en cada altura (v3 antes, v4 después)", () => {
    for (const [h, s] of states) {
      if (h < H) expect(L.velLedgerGap(V.toV3(s))).toBe(0);
      expect(V.velLedgerGap(s)).toBe(0n);
      expect(s.supply.minted <= V.MAX_SUPPLY).toBe(true);
    }
  });

  test("un nodo nuevo reaplica desde génesis y llega a las mismas raíces", () => {
    V.setUpgrades(WITH_V4);
    let b = V.genesisState();
    for (const blk of JSON.parse(JSON.stringify(blocks)) as V.Block[]) {
      const r = V.applyBlock(b, blk);
      if ("error" in r) throw new Error(`altura ${blk.header.height}: ${r.error}`);
      b = r.state;
      expect(V.stateRoot(b)).toBe(blk.header.stateRoot);
    }
    expect(b.hash).toBe(blocks[blocks.length - 1]!.hash);
  });

  test("el binario viejo se para en H (no bifurca)", () => {
    V.setUpgrades(V1_ONLY);
    let c = V.genesisState();
    for (const blk of blocks.slice(0, H - 1)) { const r = V.applyBlock(c, blk); if ("error" in r) throw new Error(r.error); c = r.state; }
    const r = V.applyBlock(c, blocks[H - 1]!);
    expect("error" in r && r.error).toContain(V.UPGRADE_NEEDED);
    V.setUpgrades(WITH_V4);
  });

  test("fotos de estado antes y después de H (y la del nodo v2.0.0 en µVEL)", () => {
    V.setUpgrades(WITH_V4);
    for (const h of [H - 1, H, H + 25]) {
      const s = states.get(h)!;
      const snap = JSON.parse(JSON.stringify(V.exportSnapshot(s)));
      const back = V.importSnapshot(snap, { height: h, stateRoot: blocks[h - 1]!.header.stateRoot, hash: blocks[h - 1]!.hash });
      expect(V.stateRoot(back)).toBe(blocks[h - 1]!.header.stateRoot);
      expect(typeof V.balanceOf(back, alice.address)).toBe("bigint");
      const ts = V.genesisTime() + (h + 1) * V.BLOCK_MS;
      const n1 = V.buildBlock(back, { proposer: prod.address, ts, txs: [], presence: [] }).block.hash;
      const n2 = V.buildBlock(s, { proposer: prod.address, ts, txs: [], presence: [] }).block.hash;
      expect(n1).toBe(n2);
    }
    // Estado que guardó el nodo v2.0.0 (JSON v3 con números y `burned`): se lee y se sube a v4 sin perder nada.
    const old = JSON.parse(JSON.stringify(V.toV3(states.get(H - 1)!)));
    const up = V.reviveState(old);
    expect(V.stateRoot(up)).toBe(blocks[H - 2]!.header.stateRoot);
    expect(V.balanceOf(up, alice.address)).toBe(V.balanceOf(states.get(H - 1)!, alice.address));
  });

  test("tx con el formato equivocado: v4 antes de H y v3 después no entran", () => {
    V.setUpgrades(WITH_V4);
    const pre = V.cloneState(states.get(H - 2)!);
    pre.height = H - 1;
    const v4before = V.makeTransfer(alice.secret, alice.address, bob.address, 1n * V.UNIT, pre.accounts[alice.address]!.nonce, { ctx: pre });
    expect(V.applyTx(pre, v4before)).toBe("Importe no válido");
    const post = V.cloneState(states.get(H + 30)!);
    post.height = H + 31;
    const v3after = v3tx(post, alice, { type: "transfer", to: bob.address, amount: 1_000_000, fee: 0 });
    expect(V.applyTx(post, v3after)).toContain("Importe no válido");
  });

  test("vista v4 de tx antiguas (historial)", () => {
    const t = V.txView(txAt[1_801]![0]!) as any;
    expect(t.amount).toBe((1_000_000_000n * K).toString());
    expect(t.fee).toBe("0");
  });
});

describe("créditos de mensajería (v4)", () => {
  const T = V.IS_MAINNET ? [{ version: 1, height: 0, name: "g" }, { version: 4, height: 1, name: "v4", migrate: V.migrateV4 }] : null;
  beforeAll(() => { if (V.IS_MAINNET) { useTestGenesis(); V.setUpgrades(T!); } });
  afterAll(() => V.setUpgrades(ORIGINAL));

  function funded() {
    const s = V.genesisState();
    s.height = 2;
    s.ts = V.genesisTime() + 10_000;
    V.credit(s, alice.address, V.VEL, 10_000n * V.UNIT);
    s.supply.minted += 10_000n * V.UNIT;
    return s;
  }

  test("sin precio del oráculo no se compran", () => {
    const s = funded();
    const tx = V.makeCreditsBuy(alice.secret, alice.address, 0, { amount: 5n * V.UNIT, ctx: s });
    expect(V.applyTx(s, tx)).toContain("Sin precio");
  });

  test("con precio: créditos al precio fijo en USDT, VEL entero a la bolsa de nodos, nada se destruye", () => {
    const s = funded();
    // 0,01 USDT por VEL = 10.000 µUSDT por VEL (USD en testnet, USDT en ambas).
    Object.assign(s.oracle, { eur: 9_200, usd: 10_000, usdt: 10_000 });
    const amount = 100n * V.UNIT; // 1 USDT → 1.000.000 / 22 = 45.454 créditos
    const before = { pool: s.epoch.pool, minted: s.supply.minted };
    const tx = V.makeCreditsBuy(alice.secret, alice.address, 0, { amount, to: bob.address, ctx: s });
    expect(V.creditsQuote(amount, s)).toBe(45_454);
    expect(V.applyTx(s, tx)).toBeNull();
    expect(V.msgCreditsOf(s, bob.address)).toBe(45_454);
    expect(V.msgCreditsOf(s, alice.address)).toBe(0);
    expect(s.epoch.pool - before.pool).toBe(amount);
    expect(s.supply.minted).toBe(before.minted);
    expect(s.supply.creditsPaid).toBe(amount);
    expect(V.velLedgerGap(s)).toBe(0n);
    // Mínimo 1 VEL; no transferibles (no hay tx que los mueva).
    const small = V.makeCreditsBuy(alice.secret, alice.address, 1, { amount: V.UNIT - 1n, ctx: s });
    expect(V.checkTx(small)).toContain("mínima");
  });
});

describe("importes: texto decimal, formato y lectura", () => {
  test("parseAmount / formatAmount con 18 decimales y locale", () => {
    expect(V.parseAmount("0,000000000000000001")).toBe(1n);
    expect(V.parseAmount("1.234,5", 18, "es-ES")).toBe(1_234_500_000_000_000_000_000n);
    expect(V.parseAmount("1,234.5", 18, "en-US")).toBe(1_234_500_000_000_000_000_000n);
    expect(V.parseAmount("0,0000000000000000001")).toBeNull(); // 19 decimales
    expect(V.parseAmount("21.000.000.000", 18, "es-ES")).toBe(V.MAX_SUPPLY);
    expect(V.parseAmount("abc")).toBeNull();
    expect(V.formatAmount("VEL", V.MAX_SUPPLY)).toBe("21.000.000.000 VEL");
    expect(V.formatAmount("VEL", 1n)).toBe("0,000000000000000001 VEL");
    expect(V.formatAmount("VEL", "1500000000000000000", 18, 2, false, "en-US")).toBe("1.5");
    expect(V.formatAmount("vUSDT", 1_234_560n)).toBe("1,23456 vUSDT");
    expect(V.formatVel(V.UNIT * 12345n / 1000n)).toBe("12,345 VEL");
  });

  test("JSON y canónico: los BigInt van como texto decimal y firman igual", () => {
    expect(JSON.stringify({ a: 10n ** 20n })).toBe('{"a":"100000000000000000000"}');
    expect(V.canonical({ a: 5n })).toBe(V.canonical({ a: "5" }));
    expect(V.isAmount("01")).toBe(false);
    expect(V.isAmount(1)).toBe(false);
    expect(V.amountOrNull("123")).toBe(123n);
  });
});
