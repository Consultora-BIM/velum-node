// Genera los vectores de prueba de conformidad (spec/vectors/*.json) a partir del núcleo de referencia
// (packages/core). Toda implementación compatible (Rust, Go, Swift, Kotlin…) debe reproducirlos byte a byte.
//   bun spec/generate.ts            regenera los vectores
//   bun spec/generate.ts --check    comprueba que los vectores deterministas siguen cuadrando con el núcleo
// La economía v3 (sello PoW, comisiones, oráculo, niveles, alias, cadena v3) la generan
// `bun packages/core/scripts/vectors.ts` (mismo formato, mismos `--check`).
// Los vectores con aleatoriedad (sobres poscuánticos) son "de apertura": dan las claves secretas y el sobre,
// y se comprueba que se abre y da el contenido esperado.
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import * as V from "../packages/core/src";

const DIR = join(import.meta.dir, "vectors");
const check = process.argv.includes("--check");
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";
const T0 = 1_793_491_200_000 + 3_600_000; // hora fija (1 nov 2026 01:00 UTC)

type Vec = { description: string; cases: unknown[] };
const out: Record<string, Vec> = {};
const failures: string[] = [];

function group(name: string, description: string, fn: () => unknown[], deterministic = true) {
  try {
    const cases = fn();
    out[name] = { description, cases };
    if (check && deterministic) {
      const file = join(DIR, `${name}.json`);
      if (!existsSync(file)) { failures.push(`${name}: falta el archivo`); return; }
      const saved = JSON.parse(readFileSync(file, "utf8")) as Vec;
      if (V.canonical(saved.cases) !== V.canonical(cases)) failures.push(`${name}: el núcleo ya no reproduce los vectores`);
    }
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

// 1. JSON canónico y hashes
group("canonical", "JSON canónico (claves ordenadas, sin espacios, sin undefined) y SHA-256 hex de ese texto (hashObj).", () => {
  const objs: unknown[] = [{ b: 1, a: [3, { d: "é", c: null }] }, { z: true, y: "línea\n", x: 1.5 }, [], "texto", 0];
  return objs.map((value) => ({ value, canonical: V.canonical(value), sha256: V.hashObj(value) }));
});
group("merkle", "Raíz de Merkle SHA-256 (hojas hex; impar = se duplica la última; vacía = 64 ceros).", () => {
  const leaves = Array.from({ length: 5 }, (_, i) => V.hashHex("hoja" + i));
  return [0, 1, 2, 3, 5].map((n) => ({ leaves: leaves.slice(0, n), root: V.merkleRoot(leaves.slice(0, n)) }));
});

// 2. Claves
group("keys", "Frase BIP-39 → semilla. Cartera = SLIP-10 ed25519 m/44'/7420'/0'/0'/0'. Identidad y buzón base = HKDF-SHA512. Direcciones = 'vel' + base58(ed25519 pub).", () => {
  const k = V.keysFromPhrase(PHRASE);
  const t = V.keyPairFromText("velum-testnet-1/faucet");
  return [
    { phrase: PHRASE, seed: V.bytesToHex(V.seedFromPhrase(PHRASE)), identity: k.identity, wallet: k.wallet, mailboxBase: k.mailboxBase },
    { note: "keyPairFromText: secreto = sha256(texto) (solo grifo y pruebas)", text: "velum-testnet-1/faucet", ...t },
  ];
});
group("signatures", "Firma ed25519 sobre el JSON canónico sin 'sig' (signObj). Deterministas (RFC 8032).", () => {
  const k = V.keyPairFromText("vector-firma");
  const body = { node: k.address, height: 7, ts: T0 };
  return [{ secret: k.secret, address: k.address, body, signed: V.signObj(k.secret, body), hello: { challenge: V.helloChallenge(k.address, T0), sig: V.sign(k.secret, V.helloChallenge(k.address, T0)) } }];
});

// 3. Buzones
group("mailbox", "Buzón del día = hex(HMAC-SHA512(seed, 'day:'+día))[0..40]; mbAuth = mbPub + t·G; prueba de apertura = ed25519 con s+t.", () => {
  const base = V.keysFromPhrase(PHRASE).mailboxBase;
  const mb = V.deviceMailbox(base, "0011223344556677", "aa".repeat(16));
  const day = V.dayOf(T0);
  const mailbox = V.mailboxFor(mb.seed, day);
  const proof = V.openProof(mb, mailbox, T0);
  return [{ mailboxBase: base, deviceId: "0011223344556677", salt: "aa".repeat(16), derived: mb, day, mailbox, mbAuth: V.mbAuthFor(mb.pub, mailbox), openChallenge: V.openChallenge(mailbox, T0), proof, proofValid: V.verifyOpenProof(proof, T0) }];
});

// 4. Trozos y recibos
group("shards", "Relleno a cubo + Reed-Solomon 3 de 5 (Cauchy, GF(256) 0x11d). id = hex(sha512('msg|stripe|idx'))[0..32]. rh = sha512(HMAC-SHA512(rseed, id)[0..32]).", () => {
  const data = V.utf8ToBytes("vector de trozos Velum ".repeat(20));
  const sealed = V.padToBucket(data);
  const shards = V.splitIntoShards(sealed, { mailbox: "ab".repeat(20), mbAuth: "cd".repeat(32), rseed: "ef".repeat(32), msg: "00112233445566778899aabbccddeeff", now: T0, ep: 5 });
  return [{ plain: V.b64(data), padded: V.b64(sealed), bucket: sealed.length, shardSize: V.shardSizeFor(sealed.length), shards, joinedEqualsPadded: V.bytesToHex(V.joinShards([shards[1]!, shards[3]!, shards[4]!])!) === V.bytesToHex(sealed) }];
});
group("receipts", "Recibo v2 anónimo: secret = HMAC-SHA512(rseed, shardId)[0..32]; válido si sha512(secret) == rh. receiptId = rh[0..48].", () => {
  const rseed = "12".repeat(32);
  return ["trozo-a", "trozo-b"].map((shard) => {
    const secret = V.receiptSecret(rseed, shard);
    const r: V.ReceiptV2 = { shard, mailbox: "34".repeat(20), rh: V.receiptHash(secret), secret, carrier: V.keyPairFromText("c").address, courier: V.keyPairFromText("d").address, ts: T0, ep: 3 };
    return { rseed, receipt: r, receiptId: V.receiptId(r), valid: V.verifyReceipt(r) };
  });
});

// 5. Sorteo de rutas
group("lottery", "Sorteo público: sha512(baliza|trozo|papel[|ronda]) → 64 bits BE mod Σpesos → elección acumulada sobre nodos ordenados. Completo 2, ligero 1.", () => {
  const nodes = ["a", "b", "c", "d", "e"].map((x, i) => ({ node: V.keyPairFromText("nodo-" + x).address, kind: (i === 4 ? "light" : "full") as V.NodeKind }));
  const snap = V.makeSnapshot(3, V.hashHex("baliza"), nodes);
  return Array.from({ length: 8 }, (_, i) => {
    const shard = V.shardId("msg-vector", 0, i % 5);
    return { snapshot: i === 0 ? snap : undefined, shard, carrier: V.assignedNode(snap, shard, "carrier"), courier: V.assignedNode(snap, shard, "courier"), candidates: V.lotteryCandidates(snap, shard, "carrier") };
  });
});

group("claims", "Reclamaciones de trabajo v3: hoja {r, role} → sha512(canónico); hojas ORDENADAS por hash y sin repetir; árbol SHA-512 binario (impar: el último consigo mismo); raíz = sha512('velum/v3/root|' + count + '|' + cima); camino hoja→cima; muestras con baliza y posiciones de la prueba (muestra + vecina).", () => {
  const me = V.keyPairFromText("vector-nodo").address;
  const leaves: V.WorkLeaf[] = Array.from({ length: 5 }, (_, i) => {
    const shard = `trozo-${i}`, secret = V.receiptSecret("56".repeat(32), shard);
    return { r: { shard, mailbox: "78".repeat(20), rh: V.receiptHash(secret), secret, carrier: me, courier: me, ts: T0, ep: 2 }, role: i % 2 ? "courier" : "carrier" } as V.WorkLeaf;
  });
  const tree = V.buildWorkTree(leaves);
  const beacon = V.hashHex("baliza-muestras");
  const samples = V.claimSamples(beacon, me, 2, tree.count);
  return [{ node: me, leaves: tree.leaves, leafHashes: tree.leaves.map(V.leafHash), root: tree.root, count: tree.count, paths: tree.leaves.map((_, i) => V.workPath(tree, i)), beacon, epoch: 2, samples, proofIndices: V.proofIndices(samples, tree.count) }];
});

// 6. Transacciones, bloques y estado
group("transactions", "Transacciones firmadas con la clave de cartera (ed25519 sobre JSON canónico sin 'sig'). txId = sha256(canónico)[0..48].", () => {
  const f = V.faucetKeyPair(), a = V.keyPairFromText("vector-alice");
  const txs: V.Tx[] = [
    V.makeTransfer(f.secret, f.address, a.address, 5 * V.UNIT, 0, { ts: T0, memo: "hola" }),
    V.makeTransfer(f.secret, f.address, a.address, 7 * V.UNIT, 1, { ts: T0, token: "tEUR" }),
    V.makeRegister(a.secret, a.address, 0, { name: "nodo-vector", version: "2.0.0", kind: "light", ts: T0 }),
  ];
  return txs.map((tx) => ({ tx, txId: V.txId(tx), checkTx: V.checkTx(tx) }));
});
group("chain", "Génesis y 3 bloques aplicados con applyBlock: hashes de cabecera y raíz de estado esperados.", () => {
  const p = V.keyPairFromText("vector-productor"), f = V.faucetKeyPair(), a = V.keyPairFromText("vector-alice");
  let s = V.genesisState();
  const cases: unknown[] = [{ height: 0, hash: s.hash, stateRoot: V.stateRoot(s) }];
  const inputs: V.Tx[][] = [
    [V.makeRegister(p.secret, p.address, 0, { name: "productor", version: "2.0.0", ts: T0 }), V.makeTransfer(f.secret, f.address, a.address, 10 * V.UNIT, 0, { ts: T0 })],
    [],
    [V.makeTransfer(a.secret, a.address, p.address, V.UNIT, 0, { ts: T0 })],
  ];
  let ts = V.GENESIS_TIME + 1_000 * V.BLOCK_MS;
  for (const txs of inputs) {
    ts += V.BLOCK_MS;
    const { block } = V.buildBlock(s, { proposer: p.address, ts, txs, receipts: [], presence: [] });
    const signed = { ...block, sig: V.sign(p.secret, block.hash) } as V.Block;
    const r = V.applyBlock(s, signed);
    if ("error" in r) throw new Error(r.error);
    s = r.state;
    cases.push({ block: signed, stateRoot: V.stateRoot(s), balances: { [a.address]: V.balancesOf(s, a.address), [p.address]: V.balancesOf(s, p.address) } });
  }
  return cases;
});

// 7. Sobres poscuánticos (vector de apertura: no determinista)
group("envelope", "Sobre híbrido X25519 + ML-KEM-768 (vector de APERTURA): con las claves del dispositivo, el sobre debe abrirse y dar el payload.", () => {
  const keys = V.keysFromPhrase(PHRASE);
  const dev = V.createDevice("vector", T0);
  const acc = V.createAccount(keys, dev, T0);
  const payload: V.Payload = { v: 2, id: "00".repeat(16), from: acc.identity.address, dev: dev.id, to: acc.identity.address, ts: T0, kind: "text", body: "hola poscuántico" };
  const [copy] = V.sealMessage({ device: dev, cert: acc.cert }, [acc.deviceList.devices[0]!], payload);
  const opened = V.openMessage(dev, copy!.bytes);
  return [{ deviceKeys: dev, sealed: V.b64(copy!.bytes), rseed: copy!.rseed, expectedPayload: opened.payload }];
}, false);

if (check) {
  if (failures.length) { console.error("FALLO\n" + failures.join("\n")); process.exit(1); }
  console.log(`vectores al día (${Object.keys(out).length} grupos)`);
} else {
  mkdirSync(DIR, { recursive: true });
  for (const [name, v] of Object.entries(out)) writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ protocol: V.PROTOCOL_VERSION, chain: V.CHAIN_ID, ...v }, null, 2) + "\n");
  console.log(`${Object.keys(out).length} grupos de vectores en ${DIR}${failures.length ? `\nno generados:\n  ${failures.join("\n  ")}` : ""}`);
  if (failures.length) process.exit(1);
}
