// HTLC (htlc.ts, docs/intercambio-p2p.md): bloquear, cobrar con el secreto, devolver al caducar y conservación.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import * as V from "../src";

const K = (t: string) => V.keyPairFromText(t);
const ana = K("ana-htlc"), beto = K("beto-htlc"), otro = K("otro-htlc");
const nonceOf = (s: V.ChainState, a: string) => s.accounts[a]?.nonce ?? 0;
const ok = (s: V.ChainState, tx: any) => { const e = V.applyTx(s, tx); if (e) throw new Error(e); };
const ctx = (s: V.ChainState) => ({ oracle: null, powBits: Math.min(s.pow.bits, s.pow.prev) });

function setup() {
  const s = V.genesisState();
  const f = V.faucetKeyPair();
  s.height = 2;
  s.ts = V.GENESIS_TIME + 10_000;
  for (const [to, amt] of [[ana.address, 1_000n], [beto.address, 10n], [otro.address, 5n]] as const)
    ok(s, V.makeTransfer(f.secret, f.address, to, amt * V.UNIT, nonceOf(s, f.address), { ts: 1, ctx: s }));
  return s;
}
const lock = (s: V.ChainState, o: Partial<{ amount: bigint; hash: string; exp: number; to: string; token: string }> = {}) =>
  V.makeHtlcLock(ana.secret, ana.address, nonceOf(s, ana.address), {
    to: o.to ?? beto.address, amount: o.amount ?? 100n * V.UNIT, hash: o.hash ?? "", expiresEpoch: o.exp ?? V.curEpoch(s) + 3, ts: 1, ctx: ctx(s), token: o.token,
  });

describe.skipIf(V.IS_MAINNET)("HTLC", () => {
  beforeAll(() => V.setUpgrades([{ version: 4, height: 0, name: "t4" }, { version: V.HTLC_PROTOCOL, height: 1, name: "htlc" }]));
  afterAll(() => V.setUpgrades(V.TESTNET_UPGRADES));

  test("bloquear → cobrar con el secreto (cualquiera puede mandar el cobro; el VEL va a `to`)", () => {
    const s = setup();
    const { preimage, hash } = V.newHtlcSecret();
    const tx = lock(s, { hash });
    const id = V.htlcIdOf(tx);
    ok(s, tx);
    expect(V.balanceOf(s, ana.address)).toBe(900n * V.UNIT);
    expect(V.balanceOf(s, V.HTLC_ADDRESS)).toBe(100n * V.UNIT);
    expect(s.htlcs![id]!.to).toBe(beto.address);
    expect(V.velLedgerGap(s)).toBe(0n);
    // secreto equivocado
    expect(V.applyTx(s, V.makeHtlcClaim(otro.secret, otro.address, nonceOf(s, otro.address), { id, preimage: "00".repeat(32), ts: 1, ctx: ctx(s) }))).toContain("no abre");
    // no se puede devolver antes de caducar
    expect(V.applyTx(s, V.makeHtlcRefund(ana.secret, ana.address, nonceOf(s, ana.address), { id, ts: 1, ctx: ctx(s) }))).toContain("Aún no");
    // un tercero lo cobra con el secreto: el dinero va a beto
    ok(s, V.makeHtlcClaim(otro.secret, otro.address, nonceOf(s, otro.address), { id, preimage, ts: 1, ctx: ctx(s) }));
    expect(V.balanceOf(s, beto.address)).toBe(110n * V.UNIT);
    expect(V.balanceOf(s, otro.address)).toBe(5n * V.UNIT);
    expect(V.balanceOf(s, V.HTLC_ADDRESS)).toBe(0n);
    expect(s.htlcs).toBeUndefined();
    expect(V.velLedgerGap(s)).toBe(0n);
    // no se cobra dos veces
    expect(V.applyTx(s, V.makeHtlcClaim(beto.secret, beto.address, nonceOf(s, beto.address), { id, preimage, ts: 1, ctx: ctx(s) }))).toContain("desconocido");
  });

  test("caducado: no se cobra y vuelve a quien lo bloqueó", () => {
    const s = setup();
    const { preimage, hash } = V.newHtlcSecret();
    const tx = lock(s, { hash, exp: V.curEpoch(s) + 1 });
    const id = V.htlcIdOf(tx);
    ok(s, tx);
    s.height += 2 * V.EPOCH_BLOCKS;
    expect(V.applyTx(s, V.makeHtlcClaim(beto.secret, beto.address, nonceOf(s, beto.address), { id, preimage, ts: 1, ctx: ctx(s) }))).toContain("caducado");
    ok(s, V.makeHtlcRefund(beto.secret, beto.address, nonceOf(s, beto.address), { id, ts: 1, ctx: ctx(s) }));
    expect(V.balanceOf(s, ana.address)).toBe(1_000n * V.UNIT);
    expect(V.balanceOf(s, beto.address)).toBe(10n * V.UNIT);
    expect(V.velLedgerGap(s)).toBe(0n);
  });

  test("reglas: saldo, caducidad, sello, formato y tokens", () => {
    const s = setup();
    const { hash } = V.newHtlcSecret();
    expect(V.applyTx(s, lock(s, { hash, amount: 2_000n * V.UNIT }))).toContain("Saldo");
    expect(V.applyTx(s, lock(s, { hash, exp: V.curEpoch(s) }))).toContain("futura");
    expect(V.applyTx(s, lock(s, { hash, exp: V.curEpoch(s) + V.HTLC_MAX_EPOCHS + 1 }))).toContain("lejana");
    expect(V.applyTx(s, lock(s, { hash: "xyz" }))).toContain("Huella");
    expect(V.applyTx(s, lock(s, { hash, token: "NOPE" }))).toContain("Token");
    const sinSello = V.signTx(ana.secret, { type: "htlc.lock", chain: V.CHAIN_ID, from: ana.address, nonce: nonceOf(s, ana.address), ts: 1, to: beto.address, amount: V.UNIT, hash, expiresEpoch: V.curEpoch(s) + 2 } as any);
    expect(V.applyTx(s, sinSello)).toContain("sello");
    // en la red llega con el importe como texto: mismo id y mismo efecto
    const tx = lock(s, { hash });
    const wire = JSON.parse(JSON.stringify(tx));
    expect(typeof wire.amount).toBe("string");
    expect(V.htlcIdOf(wire)).toBe(V.htlcIdOf(tx));
    ok(s, wire);
    expect(s.htlcs![V.htlcIdOf(tx)]).toBeTruthy();
    expect(V.velLedgerGap(s)).toBe(0n);
  });

  test("tokens: el importe bloqueado es del token y la comisión no existe", () => {
    const s = setup();
    const t = V.makeTokenCreate(ana.secret, ana.address, nonceOf(s, ana.address), { symbol: "CAFE", name: "Café", decimals: 2, maxSupply: 10_000n, initial: 1_000n, mintable: false, ts: 1 });
    ok(s, t);
    const { preimage, hash } = V.newHtlcSecret();
    const tx = lock(s, { hash, token: "CAFE", amount: 250n });
    ok(s, tx);
    expect(V.balanceOf(s, V.HTLC_ADDRESS, "CAFE")).toBe(250n);
    ok(s, V.makeHtlcClaim(beto.secret, beto.address, nonceOf(s, beto.address), { id: V.htlcIdOf(tx), preimage, ts: 1, ctx: ctx(s) }));
    expect(V.balanceOf(s, beto.address, "CAFE")).toBe(250n);
    expect(V.velLedgerGap(s)).toBe(0n);
  });

  test("sin activar (versión < 5) no entra, y la raíz del estado no cambia mientras no se usa", () => {
    V.setUpgrades(V.TESTNET_UPGRADES);
    try {
      const s = setup();
      const root = V.stateRoot(s);
      expect(V.applyTx(s, lock(s, { hash: V.newHtlcSecret().hash }))).toContain("aún no están activos");
      expect(V.stateRoot(s)).toBe(root);
    } finally {
      V.setUpgrades([{ version: 4, height: 0, name: "t4" }, { version: V.HTLC_PROTOCOL, height: 1, name: "htlc" }]);
    }
  });

  test("dentro de bloques: determinista y con la contabilidad cuadrada", () => {
    const f = V.faucetKeyPair();
    let s = V.genesisState();
    s = V.buildBlock(s, { proposer: f.address, ts: s.ts + V.BLOCK_MS, txs: [V.makeTransfer(f.secret, f.address, ana.address, 50n * V.UNIT, 0, { ts: 1, ctx: s })], presence: [] }).state;
    const { preimage, hash } = V.newHtlcSecret();
    const l = V.makeHtlcLock(ana.secret, ana.address, 0, { to: beto.address, amount: 20n * V.UNIT, hash, expiresEpoch: V.curEpoch(s) + 2, ts: 1, ctx: ctx(s) });
    const r1 = V.buildBlock(s, { proposer: f.address, ts: s.ts + V.BLOCK_MS, txs: [l], presence: [] });
    expect(r1.block.txs.length).toBe(1);
    s = r1.state;
    const c = V.makeHtlcClaim(beto.secret, beto.address, 0, { id: V.htlcIdOf(l), preimage, ts: 1, ctx: ctx(s) });
    const r2 = V.buildBlock(s, { proposer: f.address, ts: s.ts + V.BLOCK_MS, txs: [c], presence: [] });
    expect(r2.block.txs.length).toBe(1);
    expect(V.balanceOf(r2.state, beto.address)).toBe(20n * V.UNIT);
    expect(V.velLedgerGap(r2.state)).toBe(0n);
    // otro nodo reaplica el mismo bloque y llega a la misma raíz
    const again = V.applyBlock(s, { ...r2.block, sig: V.sign(f.secret, r2.block.hash) } as V.Block);
    expect("error" in again ? again.error : V.stateRoot(again.state)).toBe(V.stateRoot(r2.state));
  });
});
