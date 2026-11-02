import { expect, test } from "bun:test";
import * as V from "@velum/core";
import { Chain } from "../src/chain";
import { Store } from "../src/store";
import { Mempool, ReceiptPool } from "../src/pools";
import { checkShard } from "../src/node";
import { parseArgs } from "../src/config";
import { nativeVerifier } from "../src/native";

const n1 = V.keyPairFromText("t-node1"), n2 = V.keyPairFromText("t-node2");
const alice = V.keyPairFromText("t-alice"), bob = V.keyPairFromText("t-bob");
const reg = (k: V.KeyPair, nonce = 0) =>
  V.signTx(k.secret, { type: "register", chain: V.CHAIN_ID, from: k.address, name: "n", payout: k.address, version: "t", nonce, ts: 1 }) as V.Tx;

/** Bloque firmado sobre `s` en el hueco dado (para que el turno cuadre usamos ts = inicio del hueco + retraso del puesto). */
function mk(s: V.ChainState, k: V.KeyPair, slot: number, txs: V.Tx[] = []): V.Block {
  const rank = V.proposerRank(s, slot, k.address);
  const ts = Math.max(V.proposeAfter(slot, rank), s.ts + 1);
  const { block } = V.buildBlock(s, { proposer: k.address, ts, txs, receipts: [], presence: [] });
  return { ...block, sig: V.sign(k.secret, block.hash) };
}

const baseSlot = () => V.slotOf(Date.now()) - 400;

test("cadena: extiende, guarda rama lateral y reorganiza a la más larga devolviendo transacciones", () => {
  const chain = new Chain(new Store("", ":memory:"));
  let slot = baseSlot();
  const g = chain.state;
  const b1 = mk(g, n1, slot++, [reg(n1), reg(n2)]);
  expect(chain.add(b1).status).toBe("head");
  const s1 = chain.state;
  // Dos ramas desde b1.
  const pay = V.makeTransfer(V.faucetKeyPair().secret, V.faucetKeyPair().address, alice.address, V.UNIT, 0);
  const a2 = mk(s1, n1, slot, [pay]);
  const b2 = mk(s1, n2, slot + 1);
  const r1 = chain.add(a2);
  expect(r1.status).toBe("head");
  const r2 = chain.add(b2);
  // A igual altura gana el menor hash.
  const winner = a2.hash < b2.hash ? a2 : b2;
  expect(chain.hash).toBe(winner.hash);
  if (winner === b2) expect(r2.status === "head" && r2.reorg?.droppedTxs.length).toBe(1);
  else expect(r2.status).toBe("side");
  // La rama b crece: b3 sobre b2 → reorganiza a la más larga.
  const sb2 = chain.stateFor(b2.hash)!;
  const b3 = mk(sb2, n2, slot + 2);
  const r3 = chain.add(b3);
  expect(r3.status).toBe("head");
  expect(chain.height).toBe(3);
  expect(chain.hash).toBe(b3.hash);
  if (winner === a2) expect(r3.status === "head" && r3.reorg?.droppedTxs.map(V.txId)).toEqual([V.txId(pay)]);
  // La cadena principal guardada es la nueva.
  expect(chain.blockAt(2)!.hash).toBe(b2.hash);
  expect(chain.add(b3).status).toBe("known");
});

test("cadena: bloques huérfanos esperan al padre y se encadenan solos", () => {
  const chain = new Chain(new Store("", ":memory:"));
  let slot = baseSlot();
  let s = chain.state;
  const blocks: V.Block[] = [];
  for (let i = 0; i < 4; i++) {
    const b = mk(s, n1, slot++, i === 0 ? [reg(n1)] : []);
    blocks.push(b);
    s = (V.applyBlock(s, b) as { state: V.ChainState }).state;
  }
  expect(chain.add(blocks[3]!).status).toBe("orphan");
  expect(chain.add(blocks[2]!).status).toBe("orphan");
  expect(chain.add(blocks[1]!).status).toBe("orphan");
  const r = chain.add(blocks[0]!);
  expect(r.status).toBe("head");
  expect(chain.height).toBe(4);
});

test("cadena: recupera el estado tras reiniciar y rehace estados antiguos", () => {
  const store = new Store("", ":memory:");
  const chain = new Chain(store);
  let slot = baseSlot();
  for (let i = 0; i < 5; i++) chain.add(mk(chain.state, n1, slot++, i === 0 ? [reg(n1)] : []));
  const h3 = chain.blockAt(3)!.hash;
  const again = new Chain(store);
  expect(again.height).toBe(5);
  expect(again.hash).toBe(chain.hash);
  expect(again.stateFor(h3)!.height).toBe(3); // no estaba en memoria: se rehace desde el génesis
});

test("mempool: nonces seguidos, sin huecos ni duplicados, y saldo", () => {
  const f = V.faucetKeyPair();
  const s = V.genesisState();
  const mp = new Mempool();
  const t0 = V.makeTransfer(f.secret, f.address, alice.address, 5n * V.UNIT, 0);
  const t1 = V.makeTransfer(f.secret, f.address, bob.address, 5n * V.UNIT, 1);
  const t3 = V.makeTransfer(f.secret, f.address, bob.address, 5n * V.UNIT, 3);
  const dup = V.makeTransfer(f.secret, f.address, bob.address, 7n * V.UNIT, 1);
  expect("id" in mp.add(t1, s)).toBe(false); // hueco
  expect("id" in mp.add(t0, s)).toBe(true);
  expect("id" in mp.add(t1, s)).toBe(true);
  expect("error" in mp.add(dup, s)).toBe(true);
  expect("error" in mp.add(t3, s)).toBe(true);
  expect(mp.select(s).map((t) => t.nonce)).toEqual([0, 1]);
  const carol = V.keyPairFromText("t-carol");
  const poor = V.makeTransfer(carol.secret, carol.address, bob.address, 1n, 0);
  expect(mp.add(poor, s)).toEqual({ error: "Saldo insuficiente" });
  // alice sí puede: el estado de prueba ya incluye los 5 VEL que le llegan en cola.
  expect("id" in mp.add(V.makeTransfer(alice.secret, alice.address, bob.address, 1n, 0), s)).toBe(true);
});

test("recibos v2: anónimos; válidos si el secreto cuadra con la huella y están en plazo", () => {
  const secret = V.receiptSecret("33".repeat(32), "trozo-1");
  const ok: V.ReceiptV2 = { shard: "trozo-1", mailbox: "ab".repeat(20), rh: V.receiptHash(secret), secret, carrier: n1.address, courier: n2.address, ts: Date.now(), ep: 1 };
  expect(ReceiptPool.check(ok)).toBeNull();
  expect(ReceiptPool.check({ ...ok, secret: "00".repeat(32) })).not.toBeNull();
  expect(ReceiptPool.check({ ...ok, ts: Date.now() - 20 * 60_000 })).not.toBeNull();
  expect(ReceiptPool.check({ ...ok, carrier: "nadie" })).not.toBeNull();
});

test("fragmentos v2: validación de formato", () => {
  const acc = V.createAccount(V.keysFromPhrase(V.generatePhrase()), V.createDevice("t"));
  const tgt = V.mailboxTarget(acc.deviceList.devices[0]!);
  const [s] = V.splitIntoShards(V.padToBucket(V.randomBytes(500)), { ...tgt, rseed: "44".repeat(32), ep: 3 });
  expect(checkShard(s!)).toBeNull();
  expect(s!.ep).toBe(3);
  expect(checkShard({ ...s!, id: "nope" })).not.toBeNull();
  expect(checkShard({ ...s!, mailbox: "x" })).not.toBeNull();
  expect(checkShard({ ...s!, exp: Date.now() - 1 })).not.toBeNull();
  expect(checkShard({ ...s!, data: s!.data + "AAAA" })).not.toBeNull();
  expect(checkShard({ ...s!, k: 4 })).not.toBeNull();
  expect(checkShard({ ...s!, mbAuth: "zz" })).not.toBeNull();
});

test("mempool: prueba cada tx sobre el estado de prueba (tokens, sello PoW, mercado)", () => {
  const f = V.faucetKeyPair();
  const s = V.genesisState();
  const mp = new Mempool();
  const eur = V.makeTransfer(f.secret, f.address, alice.address, 50_000_000n, 0, { token: "tEUR" });
  expect("id" in mp.add(eur, s)).toBe(true);
  // alice aún no tiene VEL: vender VEL no entra; tras recibirlos en cola, sí.
  const sell = V.makeOrder(alice.secret, alice.address, 0, { pair: "VEL/tEUR", side: "sell", price: 2_000_000, amount: 4n * V.UNIT });
  expect("error" in mp.add(sell, s)).toBe(true);
  const vel = V.makeTransfer(f.secret, f.address, alice.address, 5n * V.UNIT, 1);
  expect("id" in mp.add(vel, s)).toBe(true);
  expect("id" in mp.add(sell, s)).toBe(true);
  // Lo bloqueado en la orden cuenta para lo siguiente.
  const tooMuch = V.makeTransfer(alice.secret, alice.address, bob.address, 2n * V.UNIT, 1);
  expect("error" in mp.add(tooMuch, s)).toBe(true);
  // Sin sello PoW (comisión 0) no entra.
  const { pow: _p, ...noPow } = V.makeTransfer(alice.secret, alice.address, bob.address, 1n, 1) as V.TransferTx & { pow?: number };
  expect("error" in mp.add(V.signTx(alice.secret, noPow as any) as V.Tx, s)).toBe(true);
  expect(mp.select(s).length).toBe(3);
});

test("firmas: el verificador nativo y noble (estricto) aceptan y rechazan lo mismo", () => {
  const k = V.keyPairFromText("t-firma");
  const msg = V.utf8ToBytes("hola");
  const sig = V.hexToBytes(V.sign(k.secret, msg));
  const pub = V.hexToBytes(k.publicKey);
  const L = 2n ** 252n + 27742317777372353535851937790883648493n;
  // S no canónico (S + L): RFC 8032 estricto lo rechaza.
  let S = 0n;
  for (let i = 31; i >= 0; i--) S = (S << 8n) | BigInt(sig[32 + i]!);
  const S2 = S + L;
  const bad = sig.slice();
  for (let i = 0; i < 32; i++) bad[32 + i] = Number((S2 >> BigInt(8 * i)) & 0xffn);
  const flipped = sig.slice(); flipped[5]! ^= 1;
  for (const [s, m] of [[sig, msg], [bad, msg], [flipped, msg], [sig, V.utf8ToBytes("otro")]] as const)
    expect(nativeVerifier(s, m, pub)).toBe(V.nobleVerifier(s, m, pub));
  expect(nativeVerifier(sig, msg, pub)).toBe(true);
  expect(nativeVerifier(bad, msg, pub)).toBe(false);
  // Con el nativo activo, la caché no deja reutilizar una firma para otro mensaje.
  V.setVerifier(nativeVerifier);
  expect(V.verify(k.address, "hola", V.bytesToHex(sig))).toBe(true);
  expect(V.verify(k.address, "adiós", V.bytesToHex(sig))).toBe(false);
  V.setVerifier(null);
});

test("línea de órdenes", () => {
  const a = parseArgs(["start", "--name", "x", "--peer=ws://a/ws", "--peer", "ws://b/ws", "--gateway", "wss://g1/hub,wss://g2/hub", "--port", "7500", "--dns-seed", "seed.example"]);
  expect(a).toMatchObject({ cmd: "start", name: "x", peers: ["ws://a/ws", "ws://b/ws"], gateways: ["wss://g1/hub", "wss://g2/hub"], port: 7500, dnsSeeds: ["seed.example"] });
  expect(() => parseArgs(["--nope"])).toThrow();
});
