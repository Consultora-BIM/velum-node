// Puente USDT ⇄ vUSDT con cadenas simuladas. Sin red real, sin fondos reales.
import { describe, expect, test } from "bun:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "@noble/hashes/utils.js";
import { mnemonicToSeedSync } from "@scure/bip39";
import { generateKeyPair, generatePhrase, seedFromPhrase, sign, canonical } from "@velum/core";
import { defaultConfig, type BridgeConfig } from "../src/config";
import { ChainClient } from "../src/chains";
import { Bridge, CLOSED_MSG } from "../src/bridge";
import {
  accountXpub, depositAddress, evmAddress, isChainAddress, pubToAddr20, treasuryAddress, tronAddress, tronToAddr20,
} from "../src/hd";
import { reviewQueue, rlp, signQueue, tronRawData, type PayoutQueue } from "../src/offline";
import { Store } from "../src/store";
import { VUSDT, type BridgeRedeemTx } from "../src/velum";
import { publicFromPhrase } from "../../node/scripts/cold-wallet";
import { MockChain, MockVelum } from "./mocks";

const U = 1_000_000n;
const LIMITS = { maxPayout: 10_000n * U, maxTotalPayout: 50_000n * U };

function setup(opts: { enabled?: boolean; cfg?: (c: BridgeConfig) => void } = {}) {
  const phrase = generatePhrase();
  const cold = publicFromPhrase(phrase);
  const key = generateKeyPair();
  const cfg = defaultConfig();
  cfg.enabled = opts.enabled ?? true;
  cfg.velumConfirmations = 2;
  cfg.chains.ethereum.enabled = false;
  opts.cfg?.(cfg);
  const tron = new MockChain("tron", cfg.chains.tron.usdt);
  const polygon = new MockChain("polygon", cfg.chains.polygon.usdt);
  const velum = new MockVelum(key.address);
  let now = Date.UTC(2027, 0, 10, 12);
  const bridge = new Bridge(cfg, cold, key, velum, {
    tron: new ChainClient(cfg.chains.tron, tron.fetch), polygon: new ChainClient(cfg.chains.polygon, polygon.fetch),
  }, new Store(null), () => now, () => {});
  return { phrase, cold, key, cfg, tron, polygon, velum, bridge, advance: (ms: number) => { now += ms; } };
}

function redeem(user: ReturnType<typeof generateKeyPair>, velum: MockVelum, dst: "tron" | "polygon", to: string, amount: number): BridgeRedeemTx {
  const nonce = (velum.nonces.get(user.address) ?? 0) + velum.mempool.filter((t) => t.from === user.address).length;
  const rest = { type: "bridge.redeem" as const, chain: velum.id, from: user.address, nonce, ts: Date.now(), dst, to, amount, fee: 0 };
  return { ...rest, sig: sign(user.secret, canonical(rest)) };
}

describe("derivación y direcciones", () => {
  const seed = mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about");
  test("vectores conocidos de BIP-44 (ETH y TRON)", () => {
    expect(depositAddress("evm", accountXpub(seed, "evm"), 0)).toBe("0x9858EfFD232B4033E47d90003D41EC34EcaEda94");
    expect(depositAddress("tron", accountXpub(seed, "tron"), 0)).toBe("TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH");
  });
  test("ida y vuelta TRON y EIP-55", () => {
    const a20 = tronToAddr20("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(tronAddress(a20)).toBe("TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t");
    expect(evmAddress(hexToBytes("c2132d05d31c914a87c6611c10748aeb04b58e8f"))).toBe("0xc2132D05D31c914a87C6611C10748AEb04B58e8F");
    expect(isChainAddress("polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8f")).toBe(false); // EIP-55 roto
    expect(isChainAddress("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe(false); // suma de control
  });
  test("la xpub no deja derivar claves privadas", () => {
    expect(() => depositAddress("tron", "xprv9s21ZrQH143K3QTDL4LXw2F7HEK3wJUD2nW2nRk4stbPy6cq3jPPqjiChkVvvNKmPGJxWUtg6LnF5kejMRNNU3TGtRBeJgk33yuGBxrMPHi", 0)).toThrow();
  });
  test("RLP: vectores de la especificación", () => {
    const enc = (x: any) => bytesToHex(rlp(x));
    expect(enc(utf8ToBytes("dog"))).toBe("83646f67");
    expect(enc([utf8ToBytes("cat"), utf8ToBytes("dog")])).toBe("c88363617483646f67");
    expect(enc(new Uint8Array(0))).toBe("80");
    expect(enc([])).toBe("c0");
    expect(enc(hexToBytes("0400"))).toBe("820400");
  });
});

describe("puente cerrado (BRIDGE_ENABLED=false)", () => {
  test("no da direcciones ni acuña", async () => {
    const { bridge, tron, velum, key } = setup({ enabled: false });
    expect(() => bridge.address({ chain: "tron", velAddress: key.address })).toThrow(CLOSED_MSG);
    tron.mine(100);
    expect(await bridge.pollDeposits("tron")).toBe(0);
    expect(await bridge.mintPending()).toBe(0);
    expect(velum.mempool.length).toBe(0);
    expect(bridge.status().message).toBe(CLOSED_MSG);
  });
  test("por defecto la configuración viene cerrada", () => {
    expect(defaultConfig().enabled).toBe(false);
  });
});

describe("depósito → vUSDT", () => {
  test("una dirección por cartera, acuña tras las confirmaciones y nunca dos veces", async () => {
    const { bridge, tron, polygon, velum } = setup();
    const user = generateKeyPair();
    const a = bridge.address({ chain: "tron", velAddress: user.address });
    expect(bridge.address({ chain: "tron", velAddress: user.address }).address).toBe(a.address);
    const p = bridge.address({ chain: "polygon", velAddress: user.address });
    const e = bridge.address({ chain: "polygon", velAddress: generateKeyPair().address });
    expect(p.address).not.toBe(e.address);
    expect(a.address.startsWith("T")).toBe(true);
    expect(() => bridge.address({ chain: "ethereum", velAddress: user.address })).toThrow("Cadena no disponible");
    expect(() => bridge.address({ chain: "tron", velAddress: "nope" })).toThrow();

    await bridge.pollDeposits("tron"); // fija el cursor
    await bridge.pollDeposits("polygon");
    tron.mine(1);
    tron.deposit(a.address, 250n * U);
    polygon.mine(1);
    polygon.deposit(p.address, 40n * U);

    tron.mine(10); // menos de 20 confirmaciones
    expect(await bridge.pollDeposits("tron")).toBe(0);
    tron.mine(15);
    expect(await bridge.pollDeposits("tron")).toBe(1);
    polygon.mine(200);
    expect(await bridge.pollDeposits("polygon")).toBe(1);
    expect(await bridge.pollDeposits("tron")).toBe(0); // no repite

    expect(await bridge.mintPending()).toBe(2);
    velum.mine(3);
    await bridge.pollVelum();
    expect(velum.balances.get(user.address)).toBe(Number(290n * U));
    expect(velum.supply).toBe(Number(290n * U));
    expect(Object.values(bridge.store.data.deposits).every((d) => d.status === "minted")).toBe(true);

    // Reenviar a mano un depósito ya acuñado: la cadena lo rechaza por la referencia.
    const dep = Object.values(bridge.store.data.deposits)[0]!;
    dep.status = "seen";
    expect(await bridge.mintPending()).toBe(0);
    expect(velum.rejected).toContain(dep.id);
  });

  test("tope diario de acuñación: lo que sobra espera", async () => {
    const { bridge, tron, velum, advance } = setup({ cfg: (c) => { c.limits.dailyMintCap = Number(100n * U); } });
    const user = generateKeyPair();
    const a = bridge.address({ chain: "tron", velAddress: user.address });
    await bridge.pollDeposits("tron");
    tron.mine(1); tron.deposit(a.address, 80n * U); tron.deposit(a.address, 50n * U); tron.mine(30);
    await bridge.pollDeposits("tron");
    expect(await bridge.mintPending()).toBe(1);
    expect(Object.values(bridge.store.data.deposits).filter((d) => d.status === "waiting_cap").length).toBe(1);
    velum.mine(3); await bridge.pollVelum();
    advance(24 * 3_600_000);
    expect(await bridge.mintPending()).toBe(1);
  });
});

describe("retiro → firma sin conexión → pago", () => {
  test("flujo completo con TRON y Polygon", async () => {
    const { bridge, tron, polygon, velum, phrase, cold } = setup();
    const user = generateKeyPair();
    velum.balances.set(user.address, Number(1_000n * U));
    velum.supply = Number(1_000n * U);
    const tronDest = depositAddress("tron", accountXpub(mnemonicToSeedSync("abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"), "tron"), 3);
    await velum.submit(redeem(user, velum, "tron", tronDest, Number(120n * U)));
    velum.mine();
    await velum.submit(redeem(user, velum, "polygon", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", Number(30n * U)));
    await velum.submit(redeem(user, velum, "polygon", "0xnotanaddress", Number(15n * U)));
    velum.mine(3);
    const r = await bridge.pollVelum();
    expect(r.redeems).toBe(3);
    const ws = Object.values(bridge.store.data.withdrawals);
    expect(ws.filter((w) => w.status === "queued").length).toBe(2);
    expect(ws.find((w) => w.to === "0xnotanaddress")!.status).toBe("refund");

    // Devolución en vUSDT de lo que no se puede pagar.
    expect(await bridge.processRefunds()).toBe(1);
    velum.mine(3); await bridge.pollVelum();
    expect(ws.find((w) => w.to === "0xnotanaddress")!.status).toBe("refunded");

    const q = await bridge.exportWithdrawals();
    expect(q.entries.length).toBe(2);
    expect(q.entries.every((e) => e.fromAddress === treasuryAddress(e.chain === "tron" ? "tron" : "evm", e.chain === "tron" ? cold.tron.xpub : cold.evm.xpub))).toBe(true);
    expect(reviewQueue(q, LIMITS)).toEqual([]);

    // Frase equivocada: no firma.
    expect(() => signQueue(q, seedFromPhrase(generatePhrase()), LIMITS)).toThrow("no es la de la cartera fría");

    const signed = signQueue(q, seedFromPhrase(phrase), LIMITS);
    expect(signed.entries.length).toBe(2);

    // La firma EVM la recupera el remitente correcto.
    const evmE = q.entries.find((e) => e.chain === "polygon")!;
    const evmS = signed.entries.find((e) => e.chain === "polygon")!;
    expect(evmS.raw.startsWith("02")).toBe(true);
    expect(evmS.txid).toBe(bytesToHex(keccak_256(hexToBytes(evmS.raw))));
    // La firma TRON: sha256(raw_data) = txid, y la clave pública recuperada es la de la tesorería.
    const trE = q.entries.find((e) => e.chain === "tron")!;
    const trS = signed.entries.find((e) => e.chain === "tron")!;
    const raw = tronRawData(trE);
    expect(trS.txid).toBe(bytesToHex(sha256(raw)));
    const sigHex = trS.raw.slice(trS.raw.length - 130);
    const sig65 = hexToBytes(sigHex);
    const recovered = secp256k1.Signature.fromBytes(new Uint8Array([sig65[64]! - 27, ...sig65.slice(0, 64)]), "recovered").recoverPublicKey(sha256(raw)).toBytes(false);
    expect(tronAddress(pubToAddr20(recovered))).toBe(trE.fromAddress);
    expect(evmE.evm!.chainId).toBe(137);

    // Emitir y confirmar.
    const sent: Record<string, string> = {};
    for (const e of signed.entries) sent[e.id] = await new ChainClient(bridge.cfg.chains[e.chain], e.chain === "tron" ? tron.fetch : polygon.fetch).broadcast(e.raw);
    bridge.markSent(signed, sent);
    expect(await bridge.confirmPayouts()).toBe(2);
    expect(Object.values(bridge.store.data.withdrawals).filter((w) => w.status === "paid").length).toBe(2);
  });

  test("la revisión frena colas manipuladas o por encima del tope", async () => {
    const { bridge, velum } = setup();
    const user = generateKeyPair();
    await velum.submit(redeem(user, velum, "polygon", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", Number(9_000n * U)));
    velum.mine(3);
    await bridge.pollVelum();
    const q = await bridge.exportWithdrawals();
    expect(reviewQueue(q, { maxPayout: 1_000n * U, maxTotalPayout: 50_000n * U }).join()).toContain("máximo por retiro");
    const bad: PayoutQueue = structuredClone(q);
    bad.entries[0]!.fromAddress = "0x0000000000000000000000000000000000000001";
    expect(reviewQueue(bad, LIMITS).join()).toContain("no sale de la xpub");
    const bad2: PayoutQueue = structuredClone(q);
    bad2.entries[0]!.from = { branch: 0, index: 4 };
    expect(reviewQueue(bad2, LIMITS).join()).toContain("tesorería");
  });

  test("tope diario de retiros: lo que no cabe queda retenido", async () => {
    const { bridge, velum } = setup({ cfg: (c) => { c.limits.dailyWithdrawalCap = Number(100n * U); } });
    const user = generateKeyPair();
    for (const amt of [60n, 50n]) { await velum.submit(redeem(user, velum, "polygon", "0x9858EfFD232B4033E47d90003D41EC34EcaEda94", Number(amt * U))); velum.mine(); }
    velum.mine(3);
    await bridge.pollVelum();
    const q = await bridge.exportWithdrawals();
    expect(q.entries.length).toBe(1);
    expect(Object.values(bridge.store.data.withdrawals).filter((w) => w.status === "held").length).toBe(1);
  });
});

describe("reservas y barrido", () => {
  test("prueba de reservas: cuadra y delata el descuadre", async () => {
    const { bridge, tron, velum, cold } = setup();
    const user = generateKeyPair();
    const a = bridge.address({ chain: "tron", velAddress: user.address });
    await bridge.pollDeposits("tron");
    tron.mine(1); tron.deposit(a.address, 500n * U); tron.mine(30);
    await bridge.pollDeposits("tron"); await bridge.mintPending(); velum.mine(3); await bridge.pollVelum();
    let r = await bridge.reserves();
    expect(r.supply).toBe(String(500n * U));
    expect(r.ok).toBe(true);
    expect(r.ratioBp).toBe(10_000);
    // Alguien acuña de más (clave del puente robada): las reservas no cuadran.
    velum.supply += Number(1n * U);
    r = await bridge.reserves();
    expect(r.ok).toBe(false);
    // Barrido a la tesorería: gas primero, luego USDT. Pasa la revisión.
    const q = await bridge.planSweep("tron", 1n * U);
    expect(q.entries.map((e) => e.kind)).toEqual(["gas", "sweep"]);
    expect(q.entries[1]!.to).toBe(treasuryAddress("tron", cold.tron.xpub));
    expect(reviewQueue(q, LIMITS)).toEqual([]);
  });
});
