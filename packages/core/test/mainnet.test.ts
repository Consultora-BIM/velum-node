// Mainnet: génesis con cartera fría de PRUEBA (carpeta temporal), sin grifo ni tokens de prueba, vUSDT con la pasarela
// como única emisora, umbral de comisión en USDT, versión de protocolo en cabecera.
// Se ejecuta con: VELUM_NETWORK=mainnet bun test test/mainnet.test.ts test/upgrades.test.ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import * as V from "../src";
import { testBridgeKey as bridgeKey, useTestGenesis } from "./genesis-de-prueba";
import type { ColdWalletPublic } from "../../../apps/node/scripts/cold-wallet";

const user = V.keyPairFromText("usuario-mainnet");
let cold: ColdWalletPublic;
/** 1 vUSDT en unidades mínimas (6 decimales). */
const USDT = 1_000_000n;
// La tabla real lleva la v4 en MAINNET_V4_HEIGHT; para probar las reglas v4 la cadena es v4 desde el bloque 1.
const ORIGINAL = V.upgrades();
const V4_FROM_1: V.Upgrade[] = [{ version: 1, height: 0, name: "g" }, { version: 4, height: 1, name: "v4", migrate: V.migrateV4 }];

beforeAll(() => {
  if (!V.IS_MAINNET) return;
  cold = useTestGenesis().cold;
});
beforeEach(() => { if (V.IS_MAINNET) V.setUpgrades(V4_FROM_1); });
afterAll(() => V.setUpgrades(ORIGINAL));

const ok = (s: V.ChainState, tx: any) => { const e = V.applyTx(s, tx); if (e) throw new Error(e); };
const nonceOf = (s: V.ChainState, a: string) => s.accounts[a]?.nonce ?? 0;
const mint = (s: V.ChainState, to: string, amount: bigint, ref: string, key = bridgeKey) =>
  V.signTx(key.secret, { type: "bridge.mint", chain: V.CHAIN_ID, from: key.address, nonce: nonceOf(s, key.address), ts: 1, to, amount, src: "tron", ref } as any);
const redeem = (s: V.ChainState, dst: string, to: string, amount: bigint) =>
  V.signTx(user.secret, V.attachPow({ type: "bridge.redeem", chain: V.CHAIN_ID, from: user.address, nonce: nonceOf(s, user.address), ts: 1, dst, to, amount, fee: 0n }, Math.min(s.pow.bits, s.pow.prev)) as any);

describe.skipIf(!V.IS_MAINNET)("mainnet", () => {
  test("constantes de red", () => {
    expect(V.CHAIN_ID).toBe("velum-mainnet-1");
    expect(V.EPOCH_BLOCKS).toBe(1_800);
    expect(V.PROTOCOL_VERSION).toBe(4);
    expect(V.HALVING_EPOCHS).toBe(35_064); // 4 años de épocas de 1 h
    expect(V.MAX_HALVINGS).toBe(33);
    expect(V.MAX_SUPPLY).toBe(21_000_000_000n * V.UNIT);
    expect(V.R0).toBe(V.MINEABLE_SUPPLY / (2n * 35_064n));
    expect(V.R0).toBe(298_026_465_890_942_276_979_237n);
    // Tabla real: v1 en génesis y v4 en un cierre de época.
    expect(ORIGINAL.map((u) => [u.version, u.height])).toEqual([[1, 0], [4, V.MAINNET_V4_HEIGHT]]);
    expect(V.MAINNET_V4_HEIGHT % V.EPOCH_BLOCKS).toBe(0);
    expect(V.HAS_FAUCET).toBe(false);
    expect(V.ORACLE_PAIRS).toEqual({ usdt: "VEL/vUSDT" });
  });

  test("génesis: 100 M a la cartera fría, vUSDT sin suministro, sin grifo ni tokens de prueba", () => {
    const s = V.genesisState();
    expect(V.balanceOf(s, cold.velum.address)).toBe(V.GENESIS_RESERVE_SUPPLY);
    expect(V.balanceOf(s, V.faucetKeyPair().address)).toBe(0n);
    expect(Object.keys(s.tokens)).toEqual(["vUSDT"]);
    expect(s.tokens.vUSDT!.issuer).toBe(bridgeKey.address);
    expect(s.tokens.vUSDT!.supply).toBe(0n);
    expect(s.ts).toBe(Date.UTC(2026, 9, 1));
    expect("burned" in s.supply).toBe(false); // en memoria el estado siempre tiene forma v4
    expect(V.velLedgerGap(s)).toBe(0n);
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
    expect(V.protocolAt(s.height)).toBe(4);
    ok(s, mint(s, user.address, 50n * USDT, "tron:abc:0"));
    expect(V.balanceOf(s, user.address, "vUSDT")).toBe(50n * USDT);
    expect(V.applyTx(s, mint(s, user.address, 50n * USDT, "tron:abc:0"))).toContain("ya acuñado");
    expect(V.applyTx(s, mint(s, user.address, 1n, "tron:x:1", user))).toContain("Solo la pasarela");
    expect(V.applyTx(s, mint(s, user.address, 1 as any, "tron:x:2"))).toContain("Importe no válido"); // `number`: no
    expect(V.applyTx(s, V.makeTokenMint(bridgeKey.secret, bridgeKey.address, nonceOf(s, bridgeKey.address), "vUSDT", user.address, 1n, 1, s))).toBeTruthy();
    expect(V.applyTx(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u", 10n * USDT))).toContain("destino");
    expect(V.applyTx(s, redeem(s, "polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8f", 10n * USDT))).toContain("destino");
    ok(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 20n * USDT));
    ok(s, redeem(s, "polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 5n * USDT));
    expect(V.applyTx(s, redeem(s, "tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", 500_000n))).toContain("mínimo");
    expect(s.tokens.vUSDT!.supply).toBe(25n * USDT);
    expect(V.balanceOf(s, user.address, "vUSDT")).toBe(25n * USDT);
    expect(s.bridge).toMatchObject({ minted: 50n * USDT, redeemed: 25n * USDT, redeems: 2 });
    expect(V.velLedgerGap(s)).toBe(0n);
  });

  test("comisión: umbral en USDT (1.100), sin euros en consenso", () => {
    const p = { eur: null, usd: 2_000_000, usdt: 2_000_000 }; // 2 USDT por VEL
    const bp550 = (550n * V.UNIT) / 10_000n; // 1 pb de 550 VEL
    expect(V.transferFee(p, V.VEL, 550n * V.UNIT)).toBe(bp550); // 1.100 USDT → 1 pb
    expect(V.transferFee(p, V.VEL, 550n * V.UNIT - 1n)).toBe(0n);
    expect(V.transferFee(p, "vUSDT", 1_100n * USDT)).toBe(bp550);
    expect(V.transferFee(p, "vUSDT", 1_100n * USDT - 1n)).toBe(0n);
    expect(V.transferFee({ eur: 5_000_000, usd: null, usdt: null }, V.VEL, 10_000n * V.UNIT)).toBe(0n);
  });

  test("cabecera con versión de protocolo; el bloque sin ella se rechaza", () => {
    const s = V.genesisState();
    const prop = V.keyPairFromText("proponente-mainnet");
    const ts = V.genesisTime() + V.BLOCK_MS;
    // Con la tabla real el bloque 1 aún es de la era v1 (código v3 congelado); con v4 desde 1, lleva pv 4.
    V.setUpgrades(ORIGINAL);
    expect(V.buildBlock(s, { proposer: prop.address, ts, txs: [], presence: [] }).block.header.pv).toBe(1);
    V.setUpgrades(V4_FROM_1);
    const { block } = V.buildBlock(s, { proposer: prop.address, ts, txs: [], presence: [] });
    expect(block.header.pv).toBe(4);
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
