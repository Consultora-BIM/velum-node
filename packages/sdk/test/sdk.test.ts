import { describe, expect, test } from "bun:test";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils.js";
import { generateKeyPair, powBits } from "@velum/core";
import {
  DepositWatcher, buildDelegate, shortId, signingBytes, slip10Derive, slip10Master, txHash, verifyTxSignature, walletFromPhrase, walletPath,
} from "../src";

describe("SLIP-10 ed25519 (vectores de la especificación, prueba 1)", () => {
  const seed = hexToBytes("000102030405060708090a0b0c0d0e0f");
  test("maestra", () => {
    const m = slip10Master(seed);
    expect(bytesToHex(m.key)).toBe("2b4be7f19ee27bbf30c667b642d5f4aa69fd169872f8fc3059c08ebae2eb19e7");
    expect(bytesToHex(m.chainCode)).toBe("90046a93de5380a72b5e45010748567d5ea02bbf6522f979e05c0d8d8ca9fffb");
  });
  test("hijas endurecidas", () => {
    expect(bytesToHex(slip10Derive(seed, "m/0'").key)).toBe("68e0fe46dfb67e368c75379acec591dad19df3cde26e63b93a8e704f1dade7a3");
    expect(bytesToHex(slip10Derive(seed, "m/0'/1'").key)).toBe("b1d0bad404bf35da785a64ca1ac54b2617211d2777696fbffaf208f746ae84f2");
    expect(bytesToHex(slip10Derive(seed, "m/0'/1'/2'/2'/1000000000'").key)).toBe("8f94d394a8e8fd6b1bc2f3f49f5c47e385281d5c17e65324b0f62483e37e8793");
  });
  test("rutas sin endurecer se rechazan", () => {
    expect(() => slip10Derive(seed, "m/44'/7420'/0/0")).toThrow();
  });
});

describe("cartera", () => {
  const phrase = "abandon ".repeat(23) + "art";
  test("ruta de Velum y determinismo", () => {
    expect(walletPath()).toBe("m/44'/7420'/0'/0'/0'");
    const a = walletFromPhrase(phrase), b = walletFromPhrase(phrase), c = walletFromPhrase(phrase, 1);
    expect(a.address).toBe(b.address);
    expect(a.address).not.toBe(c.address);
    expect(a.address.startsWith("vel")).toBe(true);
  });
  test("id corto", () => {
    expect(shortId("velABCDEFGHIJ")).toBe("ABCD…GHIJ");
  });
});

describe("transacciones", () => {
  test("delegar: sello + firma sobre JSON canónico", () => {
    const k = generateKeyPair(), node = generateKeyPair().address;
    const tx = buildDelegate(k.secret, "velum-mainnet-1", k.address, 0, node, 5_000_000, 8, 1);
    expect(powBits(tx)).toBeGreaterThanOrEqual(8);
    expect(verifyTxSignature(tx)).toBe(true);
    expect(new TextDecoder().decode(signingBytes(tx)).startsWith('{"amount":5000000,"chain":"velum-mainnet-1"')).toBe(true);
    expect(verifyTxSignature({ ...tx, amount: 6_000_000 } as any)).toBe(false);
    expect(txHash(tx)).toHaveLength(48);
  });
});

describe("vigilante de depósitos", () => {
  test("respeta confirmaciones, filtra por dirección y lleva el memo", async () => {
    const hot = generateKeyPair().address, other = generateKeyPair().address;
    const blocks = Array.from({ length: 50 }, (_, h) => ({ height: h, hash: "h" + h, ts: h, txs: [] as any[] }));
    blocks[10]!.txs.push({ type: "transfer", from: other, to: hot, amount: 7, memo: "cliente-42" });
    blocks[12]!.txs.push({ type: "transfer", from: other, to: other, amount: 9 });
    blocks[45]!.txs.push({ type: "transfer", from: other, to: hot, amount: 3, token: "vUSDT" });
    const reader = { head: async () => ({ height: 49 }), blocks: async (f: number, t: number) => blocks.filter((b) => b.height >= f && b.height <= t) };
    const w = new DepositWatcher(reader, { addresses: [hot], confirmations: 30 });
    const got = await w.poll(7);
    expect(got.map((d) => [d.amount, d.memo])).toEqual([[7, "cliente-42"]]);
    expect(w.cursor).toBe(19);
    expect(await w.poll()).toEqual([]);
  });
});

import { identiconCells, identiconSvg } from "../src";
describe("identicono", () => {
  test("determinista y simétrico", () => {
    const a = generateKeyPair().address;
    expect(identiconSvg(a)).toBe(identiconSvg(a));
    for (const row of identiconCells(a)) expect(row).toEqual([...row].reverse());
    expect(identiconSvg(a)).not.toBe(identiconSvg(generateKeyPair().address));
  });
});
