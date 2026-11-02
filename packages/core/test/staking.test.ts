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
  let sum = 0n;
  for (const n of Object.values(s.nodes)) sum += n.bond + n.unbonding.reduce((a, u) => a + u.amount, 0n) + (n.delegated ?? 0n);
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
  for (const [to, amt] of [[alice.address, 3_000n], [bob.address, 1_000n], [node.address, 10n]] as const)
    ok(s, V.makeTransfer(reserveKey.secret, reserve, to, amt * V.UNIT, nonceOf(s, reserve), { ts: 1, ctx: s }));
  ok(s, V.makeRegister(node.secret, node.address, 0, { payout: node.address, version: "3", kind: "full" } as any));
  return s;
}

describe.skipIf(V.IS_MAINNET)("staking delegado", () => {
  test("delegar suma peso con el mismo tope que la fianza; comisión limitada", () => {
    const s = setup();
    const w0 = V.nodeWeight(s.nodes[node.address]!, 0);
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 2_000n * V.UNIT }, s));
    const w1 = V.nodeWeight(s.nodes[node.address]!, 0);
    expect(w1).toBeGreaterThan(w0);
    expect(s.nodes[node.address]!.delegated).toBe(2_000n * V.UNIT);
    // Sin sello no entra.
    expect(V.applyTx(s, V.signTx(bob.secret, { type: "stake.delegate", ...base(s, bob.address), node: node.address, amount: V.UNIT } as any))).toContain("sello");
    // Comisión: máximo 20 %, ±5 puntos por cambio, uno cada 7 días.
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 2_500 }, s))).toBeTruthy();
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_600 }, s))).toContain("±5");
    ok(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_500 }, s));
    expect(V.applyTx(s, stamped(node.secret, { type: "node.commission", ...base(s, node.address), bp: 1_400 }, s))).toContain("7 días");
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
  });

  test("reparto exacto por época: comisión + prorrata, sin crear ni perder un velo", () => {
    const s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 3_000n * V.UNIT }, s));
    ok(s, stamped(bob.secret, { type: "stake.delegate", ...base(s, bob.address), node: node.address, amount: 1_000n * V.UNIT }, s));
    const n = s.nodes[node.address]!;
    for (const amount of [1n, 7n, 999n, 1_000_001n, 25_684_931_506n, 298_026_465_890_942_276_979_237n]) {
      const before = { a: V.balanceOf(s, alice.address), b: V.balanceOf(s, bob.address), n: V.balanceOf(s, node.address) };
      const toDel = V.payNode(s, n, amount);
      const got = { a: V.balanceOf(s, alice.address) - before.a, b: V.balanceOf(s, bob.address) - before.b, n: V.balanceOf(s, node.address) - before.n };
      expect(got.a + got.b + got.n).toBe(amount);
      expect(got.a + got.b).toBe(toDel);
      // 10 % de comisión por defecto; el resto 3:1 entre Alice y Bob (el nodo no tiene fianza propia).
      if (amount >= 1_000_001n) {
        expect(got.n).toBeGreaterThanOrEqual(amount / 10n);
        const diff = got.a - 3n * got.b;
        expect(diff < 0n ? -diff : diff).toBeLessThanOrEqual(3n);
      }
    }
  });

  test("bloques con cierre de época: los delegados cobran y la contabilidad cuadra", () => {
    let s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 2_000n * V.UNIT }, s));
    s.epoch = { ...s.epoch, produced: {} };
    const aliceBefore = V.balanceOf(s, alice.address);
    let ts = s.ts;
    while (s.height < 3 * V.EPOCH_BLOCKS) {
      ts += V.BLOCK_MS;
      s = V.buildBlock(s, { proposer: node.address, ts, txs: [], presence: [] }).state;
    }
    expect(V.balanceOf(s, alice.address)).toBeGreaterThan(aliceBefore);
    expect(s.stake!.del[node.address]![alice.address]!.earned).toBeGreaterThan(0n);
    expect(V.velLedgerGap(s)).toBe(0n);
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
  });

  test("retirar: 14 días de espera, tope de retiradas y vuelta exacta", () => {
    const s = setup();
    ok(s, stamped(alice.secret, { type: "stake.delegate", ...base(s, alice.address), node: node.address, amount: 100n * V.UNIT }, s));
    const bal = V.balanceOf(s, alice.address);
    ok(s, stamped(alice.secret, { type: "stake.undelegate", ...base(s, alice.address), node: node.address, amount: 40n * V.UNIT }, s));
    expect(s.nodes[node.address]!.delegated).toBe(60n * V.UNIT);
    expect(V.applyTx(s, stamped(alice.secret, { type: "stake.undelegate", ...base(s, alice.address), node: node.address, amount: 61n * V.UNIT }, s))).toContain("insuficiente");
    const release = s.stake!.unbonding[alice.address]![0]!.release;
    expect(release).toBe(V.curEpoch(s) + V.BOND_UNBOND_EPOCHS);
    V.releaseUndelegations(s, release - 1);
    expect(V.balanceOf(s, alice.address)).toBe(bal);
    V.releaseUndelegations(s, release);
    expect(V.balanceOf(s, alice.address)).toBe(bal + 40n * V.UNIT);
    expect(escrowParts(s)).toBe(V.balanceOf(s, V.ESCROW_ADDRESS));
    expect(V.delegationsOfAddress(s, alice.address).delegations[0]!.amount).toBe(60n * V.UNIT);
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
