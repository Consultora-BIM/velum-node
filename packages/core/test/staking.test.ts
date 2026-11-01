// Staking delegado: delegar, comisión, reparto exacto por época, retirada en 14 días y conservación.
import { describe, expect, test } from "bun:test";
import * as V from "../src";

const K = (t: string) => V.keyPairFromText(t);
const node = K("nodo-staking"), alice = K("alice-st"), bob = K("bob-st");
const nonceOf = (s: V.ChainState, a: string) => s.accounts[a]?.nonce ?? 0;
const ok = (s: V.ChainState, tx: any) => { const e = V.applyTx(s, tx); if (e) throw new Error(e); };
const stamped = (secret: string, body: any, s: V.ChainState) => V.signTx(secret, V.attachPow(body, Math.min(s.pow.bits, s.pow.prev)) as any);
const base = (s: V.ChainState, from: string) => ({ chain: V.CHAIN_ID, from, nonce: nonceOf(s, from), ts: 1 });

/** Escrow VEL = fianzas + desbloqueos + delegaciones + retiradas en espera (sin órdenes ni bolsas en estas pruebas). */
function escrowParts(s: V.ChainState) {
  let sum = 0;
  for (const n of Object.values(s.nodes)) sum += n.bond + n.unbonding.reduce((a, u) => a + u.amount, 0) + (n.delegated ?? 0);
  for (const list of Object.values(s.stake?.unbonding ?? {})) for (const u of list) sum += u.amount;
  return sum;
}

function setup() {
  let s = V.genesisState();
  const reserve = V.IS_MAINNET ? V.mainnetGenesis().reserve.address : V.faucetKeyPair().address;
  const reserveKey = V.IS_MAINNET ? null : V.faucetKeyPair();
  if (!reserveKey) throw new Error("estas pruebas usan la testnet");
  s.height = 1;
  s.ts = V.GENESIS_TIME + 10_000;
  for (const [to, amt] of [[alice.address, 3_000], [bob.address, 1_000], [node.address, 10]] as const)
    ok(s, V.makeTransfer(reserveKey.secret, reserve, to, amt * V.UNIT, nonceOf(s, reserve), { ts: 1, ctx: s }));
  ok(s, V.makeRegister(node.secret, node.address, 0, { payout: node.address, version: "3", kind: "full" } as any));
  return s;
}

describe.skipIf(V.IS_MAINNET)("staking delegado", () => {
  test("delegar suma peso con el mismo tope que la fianza; comisión limitada", () => {
    const s = setup();
    const w0 = V.nodeWeight(s.nodes[node.address]!, 0);
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 2_000 * V.UNIT }, s));
    const w1 = V.nodeWeight(s.nodes[node.address]!, 0);
    expect(w1).toBeGreaterThan(w0);
    expect(s.nodes[node.address]!.delegated).toBe(2_000 * V.UNIT);
    // Sin sello no entra.
    expect(V.applyTx(s, V.signTx(bob.secret, { type: "stake.delegate", ...base(s, bob.address), node: node.address, amount: V.UNIT } as any))).toContain("sello");
    // Comisión: máximo 20 %, ±5 puntos por cambio, uno cada 7 días.
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 2_500 }, s))).toBeTruthy();
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_600 }, s))).toContain("±5");
    ok(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_500 }, s));
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_400 }, s))).toContain("7 días");
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
  });

  test("reparto exacto por época: comisión + prorrata, sin crear ni perder un µVEL", () => {
    const s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 3_000 * V.UNIT }, s));
    ok(s, stamped(bob.secret, { type: "stake.delegate", ...base(s, bob.address), node: node.address, amount: 1_000 * V.UNIT }, s));
    const n = s.nodes[node.address]!;
    for (const amount of [1, 7, 999, 1_000_001, 25_684_931_506]) {
      const before = { a: V.balanceOf(s, alice.address), b: V.balanceOf(s, bob.address), n: V.balanceOf(s, node.address) };
      const toDel = V.payNode(s, n, amount);
      const got = { a: V.balanceOf(s, alice.address) - before.a, b: V.balanceOf(s, bob.address) - before.b, n: V.balanceOf(s, node.address) - before.n };
      expect(got.a + got.b + got.n).toBe(amount);
      expect(got.a + got.b).toBe(toDel);
      // 10 % de comisión por defecto; el resto 3:1 entre Alice y Bob (el nodo no tiene fianza propia).
      if (amount >= 1_000_001) {
        expect(got.n).toBeGreaterThanOrEqual(Math.floor(amount / 10));
        expect(Math.abs(got.a - 3 * got.b)).toBeLessThanOrEqual(3);
      }
    }
  });

  test("bloques con cierre de época: los delegados cobran y la contabilidad cuadra", () => {
    let s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 2_000 * V.UNIT }, s));
    s.epoch = { ...s.epoch, produced: {} };
    const aliceBefore = V.balanceOf(s, alice.address);
    let ts = s.ts;
    while (s.height < 3 * V.EPOCH_BLOCKS) {
      ts += V.BLOCK_MS;
      s = V.buildBlock(s, { proposer: node.address, ts, txs: [], presence: [] }).state;
    }
    expect(V.balanceOf(s, alice.address)).toBeGreaterThan(aliceBefore);
    expect(s.stake!.del[node.address]![alice.address]!.earned).toBeGreaterThan(0);
    expect(V.velLedgerGap(s)).toBe(0);
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
  });

  test("retirar: 14 días de espera, tope de retiradas y vuelta exacta", () => {
    const s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 100 * V.UNIT }, s));
    const bal = V.balanceOf(s, alice.address);
    ok(s, stamped(alice.secret, { type: "stake.undelegate", ...base(s, alice.address), node: node.address, amount: 40 * V.UNIT }, s));
    expect(s.nodes[node.address]!.delegated).toBe(60 * V.UNIT);
    expect(V.applyTx(s, stamped(alice.secret, { type: "stake.undelegate", ...base(s, alice.address), node: node.address, amount: 61 * V.UNIT }, s))).toContain("insuficiente");
    const release = s.stake!.unbonding[alice.address]![0]!.release;
    expect(release).toBe(V.curEpoch(s) + V.BOND_UNBOND_EPOCHS);
    V.releaseUndelegations(s, release - 1);
    expect(V.balanceOf(s, alice.address)).toBe(bal);
    V.releaseUndelegations(s, release);
    expect(V.balanceOf(s, alice.address)).toBe(bal + 40 * V.UNIT);
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
    expect(V.delegationsOfAddress(s, alice.address).delegations[0]!.amount).toBe(60 * V.UNIT);
    expect(V.delegationsOfNode(s, node.address).length).toBe(1);
  });

  test("una tx rechazada no toca el estado (atomicidad)", () => {
    const s = setup();
    const root = V.stateRoot(s);
    expect(V.applyTx(s, stamped(alice.secret, { type: "stake.undelegate", ...base(s, alice.address), node: node.address, amount: V.UNIT }, s))).toBeTruthy();
    expect(V.applyTx(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: bob.address, amount: V.UNIT }, s))).toBeTruthy();
    expect(V.stateRoot(s)).toBe(root);
  });
});
