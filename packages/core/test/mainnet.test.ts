// Mainnet: génesis con cartera fría de PRUEBA (carpeta temporal), sin grifo ni tokens de prueba, vUSDT con la pasarela
// como única emisora, umbral de comisión en USDT, versión de protocolo en cabecera.
// Se ejecuta con: VELUM_NETWORK=mainnet bun test test/mainnet.test.ts test/upgrades.test.ts
import { describe, expect, test, beforeAll } from "bun:test";
import * as V from "../src";
import { testBridgeKey as bridgeKey, useTestGenesis } from "./genesis-de-prueba";
import type { ColdWalletPublic } from "../../../apps/node/scripts/cold-wallet";

const user = V.keyPairFromText("usuario-mainnet");
let cold: ColdWalletPublic;

beforeAll(() => {
  if (!V.IS_MAINNET) return;
  cold = useTestGenesis().cold;
});

const ok = (s: V.ChainState, tx: any) => { const e = V.applyTx(s, tx); if (e) throw new Error(e); };
const nonceOf = (s: V.ChainState, a: string) => s.accounts[a]?.nonce ?? 0;
const mint = (s: V.ChainState, to: string, amount: number, ref: string, key = bridgeKey) =>
  V.signTx(key.secret, { type: "bridge.mint", chain: V.CHAIN_ID, from: key.address, nonce: nonceOf(s, key.address), ts: 1, to, amount, src: "tron", ref } as any);
const redeem = (s: V.ChainState, dst: string, to: string, amount: number) =>
  V.signTx(user.secret, V.attachPow({ type: "bridge.redeem", chain: V.CHAIN_ID, from: user.address, nonce: nonceOf(s, user.address), ts: 1, dst, to, amount, fee: 0 }, Math.min(s.pow.bits, s.pow.prev)) as any);

describe.skipIf(!V.IS_MAINNET)("mainnet", () => {
  test("constantes de red", () => {
    expect(V.CHAIN_ID).toBe("velum-mainnet-1");
    expect(V.EPOCH_BLOCKS).toBe(1_800);
    expect(V.HALVING_EPOCHS).toBe(17_520);
    expect(V.R0).toBe(25_684_931_506);
    expect(V.HAS_FAUCET).toBe(false);
    expect(V.ORACLE_PAIRS).toEqual({ usdt: "VEL/vUSDT" });
  });

  test("génesis: 100 M a la cartera fría, vUSDT sin suministro, sin grifo ni tokens de prueba", () => {
    const s = V.genesisState();
    expect(V.balanceOf(s, cold.velum.address)).toBe(V.GENESIS_RESERVE_SUPPLY);
    expect(V.balanceOf(s, V.faucetKeyPair().address)).toBe(0);
    expect(Object.keys(s.tokens)).toEqual(["vUSDT"]);
    expect(s.tokens.vUSDT!.issuer).toBe(bridgeKey.address);
    expect(s.tokens.vUSDT!.supply).toBe(0);
    expect(s.ts).toBe(Date.UTC(2026, 9, 1));
    expect(V.velLedgerGap(s)).toBe(0);
  });

  test("sin génesis completa no arranca", () => {
    const g = V.rawMainnetGenesis();
    V.setMainnetGenesis({ v: 1, chain: "velum-mainnet-1", genesisTime: null, reserve: null, bridge: null });
    expect(() => V.genesisState()).toThrow("cartera fría");
    V.setMainnetGenesis(g);
    useTestGenesis();
  });

  test("pasarela: solo la autoridad acuña, una vez por depósito; canje valida la dirección de destino", () => {
    const s = V.genesisState();
    s.height = 1;
    ok(s, mint(s, user.address, 50 * V.UNIT, "tron:abc:0"));
    expect(V.balanceOf(s, user.address, "vUSDT")).toBe(50 * V.UNIT);
    expect(V.applyTx(s, mint(s, user.address, 50 * V.UNIT, "tron:abc:0"))).toContain("ya acuñado");
    expect(V.applyTx(s, mint(s, user.address, 1, "tron:x:1", user))).toContain("Solo la pasarela");
    expect(V.applyTx(s, V.makeTokenMint(bridgeKey.secret, bridgeKey.address, nonceOf(s, bridgeKey.address), "vUSDT", user.address, 1, 1, s))).toBeTruthy();
    expect(V.applyTx(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", 10 * V.UNIT))).toContain("destino");
    expect(V.applyTx(s, redeem(s, "polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8f", 10 * V.UNIT))).toContain("destino");
    ok(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 20 * V.UNIT));
    ok(s, redeem(s, "polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 5 * V.UNIT));
    expect(V.applyTx(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 500_000))).toContain("mínimo");
    expect(s.tokens.vUSDT!.supply).toBe(25 * V.UNIT);
    expect(V.balanceOf(s, user.address, "vUSDT")).toBe(25 * V.UNIT);
    expect(s.bridge).toMatchObject({ minted: 50 * V.UNIT, redeemed: 25 * V.UNIT, redeems: 2 });
    expect(V.velLedgerGap(s)).toBe(0);
  });

  test("comisión: umbral en USDT (1.100), sin euros en consenso", () => {
    const p = { eur: null, usd: 2_000_000, usdt: 2_000_000 }; // 2 USDT por VEL
    expect(V.transferFee(p, V.VEL, 550 * V.UNIT)).toBe(55_000); // 1.100 USDT → 1 pb
    expect(V.transferFee(p, V.VEL, 550 * V.UNIT - 1)).toBe(0);
    expect(V.transferFee(p, "vUSDT", 1_100 * V.UNIT)).toBe(55_000);
    expect(V.transferFee({ eur: 5_000_000, usd: null, usdt: null }, V.VEL, 10_000 * V.UNIT)).toBe(0);
  });

  test("cabecera con versión de protocolo; el bloque sin ella se rechaza", () => {
    const s = V.genesisState();
    const prop = V.keyPairFromText("proponente-mainnet");
    const ts = V.genesisTime() + V.BLOCK_MS;
    const { block } = V.buildBlock(s, { proposer: prop.address, ts, txs: [], presence: [] });
    expect(block.header.pv).toBe(1);
    const good = { ...block, sig: V.sign(prop.secret, block.hash) } as V.Block;
    expect("state" in V.applyBlock(s, good)).toBe(true);
    const { pv: _pv, ...h } = block.header;
    const bad = { ...block, header: h, hash: V.headerHash(h as V.BlockHeader) } as V.Block;
    expect((V.applyBlock(s, { ...bad, sig: V.sign(prop.secret, bad.hash) }) as any).error).toContain("versión");
  });

  test("cartera SLIP-10: la dirección de reserva es la de m/44'/7420'/0'/0'/0'", () => {
    expect(cold.velum.address.startsWith("vel")).toBe(true);
    expect(V.walletPath()).toBe("m/44'/7420'/0'/0'/0'");
  });
});
