// Vectores de conformidad de la cadena v4 (economía e identidad) → spec/vectors/*.json. Se generan en testnet:
//   VELUM_NETWORK=testnet bun packages/core/scripts/vectors.ts
// Importes: BigInt en memoria, TEXTO DECIMAL en el JSON (1 VEL = "1000000000000000000").
// Completa a spec/generate.ts (formato, hashes, sobres, trozos, sorteo y árbol de reclamaciones).
//   bun packages/core/scripts/vectors.ts            regenera
//   bun packages/core/scripts/vectors.ts --check    comprueba que el núcleo los sigue reproduciendo byte a byte
// Todo es determinista: hora fija, claves desde texto y sellos PoW buscados desde el nonce 0.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as V from "../src";

const DIR = join(import.meta.dir, "../../../spec/vectors");
const check = process.argv.includes("--check");
const T0 = 1_793_491_200_000 + 3_600_000; // 1 nov 2026 01:00 UTC
const EUR = 1_000_000; // precio: µtEUR por 1 VEL (number)
const EURt = 1_000_000n; // 1 tEUR en unidades mínimas (BigInt)
const K = (t: string) => V.keyPairFromText(t);

type Vec = { description: string; cases: unknown[] };
const out: Record<string, Vec> = {};
const failures: string[] = [];

function group(name: string, description: string, fn: () => unknown[]) {
  try {
    const cases = fn();
    out[name] = { description, cases };
    if (!check) return;
    const file = join(DIR, `${name}.json`);
    if (!existsSync(file)) { failures.push(`${name}: falta el archivo`); return; }
    const saved = JSON.parse(readFileSync(file, "utf8")) as Vec;
    if (V.canonical(saved.cases) !== V.canonical(cases)) failures.push(`${name}: el núcleo ya no reproduce los vectores`);
  } catch (e) {
    failures.push(`${name}: ${(e as Error).message}`);
  }
}

// 1. Sello de prueba de trabajo
group("pow", "Sello PoW v3: cuerpo = sha512(canónico sin sig ni pow); sello = sha512(cuerpo ‖ u64be(pow)); bits = ceros iniciales. pow = primer nonce desde 0 con ≥ bits.", () => {
  const a = K("vector-alice"), b = K("vector-bob");
  const bodies = [
    { type: "transfer", chain: V.CHAIN_ID, from: a.address, nonce: 0, ts: T0, to: b.address, amount: 5n * V.UNIT, fee: 0n },
    { type: "order.cancel", chain: V.CHAIN_ID, from: a.address, nonce: 3, ts: T0, id: "o7" },
  ];
  return bodies.flatMap((body) => [8, 16].map((bits) => {
    const sealed = V.attachPow(body, bits);
    return { body, bits, bodyHash: V.bytesToHex(V.powBody(body)), pow: sealed.pow, stampHash: V.powHash(sealed), achieved: V.powBits(sealed) };
  }));
});

// 2. Comisiones
group("fees", "Comisión v4: 80 % bolsa / 20 % Reserva; 0 bajo 1.000 € (oráculo); desde 1.000 €, max(1, floor(velos × 1 / 10.000)). Importes en texto decimal (velos; tokens en sus unidades mínimas). Precios (number) en unidades mínimas del token por 1 VEL.", () => {
  const prices = { eur: 2 * EUR, usd: 2_200_000, usdt: 2_200_000 };
  const cases: unknown[] = [1n, 7n, 10_000n, 123_457n, 10n ** 20n + 3n].map((fee) => ({ splitFee: fee, result: V.splitFee(fee) }));
  for (const [token, amount] of [["VEL", 500n * V.UNIT], ["VEL", 500n * V.UNIT - 1n], ["VEL", 5_000n * V.UNIT], ["tEUR", 1_000n * EURt], ["tEUR", 1_000n * EURt - 1n], ["tUSD", 1_100n * EURt], ["tUSDT", 2_000n * EURt], ["OTRO", 10n ** 12n]] as const)
    cases.push({ prices, token, amount, fee: V.transferFee(prices, token, amount), value: V.valueOf(prices, token, amount), quote: V.quote(amount, token, { oracle: prices, powBits: 16 }) });
  cases.push({ prices: null, token: "VEL", amount: 10n ** 27n, fee: V.transferFee(null, "VEL", 10n ** 27n) });
  return cases;
});

// 3. Oráculo
group("oracle", "Oráculo TWAP (volúmenes en velos, texto decimal): muestra por bloque del último precio (tope 10¹²) antes de las tx; ventana de 60 épocas; volumen mínimo 1.000 VEL; reserva cruzada por mediana (USD↔USDT 1:1, EUR↔USD con el cambio visto).", () => {
  const s = V.genesisState();
  const cases: unknown[] = [];
  const feed = (e: number, prices: Record<string, number>, vol: bigint) => {
    for (let b = 0; b < V.EPOCH_BLOCKS; b++) { for (const [p, x] of Object.entries(prices)) s.dex.pairs[p] = { last: x, hours: [] }; V.oracleSample(s, e); }
    for (const p of Object.keys(prices)) V.oracleTrade(s, p, vol, e);
    V.oracleClose(s, e);
  };
  for (let e = 0; e < 3; e++) feed(e, { "VEL/tEUR": 2 * EUR, "VEL/tUSD": 2_200_000 }, 400n * V.UNIT);
  cases.push({ after: "3 épocas EUR 2,00 y USD 2,20 con 400 VEL/época", oracle: V.oracleInfo(s) });
  feed(3, { "VEL/tEUR": 2_400_000, "VEL/tUSDT": 2_000_000 }, 50n * V.UNIT);
  cases.push({ after: "época 3: EUR 2,40, USDT 2,00 con 50 VEL (USDT sin volumen suficiente)", oracle: V.oracleInfo(s) });
  return cases;
});

// 4. Niveles y peso
group("tiers", "Niveles v3: racha continua (> 2.880 épocas sin presencia la reinicia), presencia 90/95/98 %, meses de 43.200 épocas, Pilar M(t) = min(12, 6 + floor(edadRed/4)); peso = tipo(2|1) × floor(nivelPb × fianzaPb / 10⁶).", () => {
  const M = V.MONTH_EPOCHS;
  const cases: unknown[] = [{ pillarMonths: [0, 3, 4, 8, 24, 100].map((m) => [m, V.pillarMonths(m)]) }];
  cases.push({ bondFactorBp: [0n, 1n, 5_000n * V.UNIT, 10_000n * V.UNIT, 20_000n * V.UNIT].map((b) => [b, V.bondFactorBp(b)]) });
  const n = { lastPresentEpoch: -1, streakStart: 0, streakPresent: 0, epochsPresent: 0, kind: "full", bond: 0n } as unknown as V.NodeInfo;
  const checkpoints = new Set([0, M - 2, M - 1, 3 * M - 1, 6 * M - 1, 7 * M - 1]);
  for (let e = 0; e < 7 * M; e++) {
    if (e % 50 !== 49) V.markPresent(n, e); // 98 % de presencia
    if (checkpoints.has(e)) cases.push({ epoch: e, presentEvery: "49 de 50", streak: V.streakOf(n, e), tier: V.tierFor(n, e).id, weight: V.nodeWeight(n, e) });
  }
  const g = { ...n };
  V.markPresent(g, 7 * M + V.STREAK_GAP_EPOCHS + 1);
  cases.push({ afterGapEpochs: V.STREAK_GAP_EPOCHS + 1, streakStart: g.streakStart, tier: V.tierFor(g, 7 * M + V.STREAK_GAP_EPOCHS + 1).id });
  return cases;
});

// 5. Identidad: tarjeta, enlaces y alias
group("names", "Tarjeta de contacto v3 (binaria → base58: [ver 3][identidad 32][x25519 32][ML-KEM 1184][semilla buzón 32][mbPub 32][ts u64][firma 64], firma de 'velum/v3/card|' ‖ cuerpo), enlaces y tx name.register con sello de +4 bits.", () => {
  const a = K("vector-alice");
  const mb = "55".repeat(32);
  const keys = V.cardKeys(a, mb);
  const card = V.encodeCard(keys.card);
  const tx = V.makeNameRegister(a.secret, a.address, 0, { name: "alice.v3", card, ts: T0 });
  return [{
    identity: a.address, mailboxBase: mb, card: keys.card, encoded: card, cardLink: V.cardLink(keys.card), aliasLink: V.aliasLink("alice.v3"),
    invite: { secret: "77".repeat(32), link: V.inviteFromSecret("77".repeat(32)).link, entry: V.inviteFromSecret("77".repeat(32)).entry },
    nameRegister: { tx, txId: V.txId(tx), powBits: V.powBits(tx), checkTx: V.checkTx(tx) },
  }];
});

// 6. Reparto con tope de verosimilitud
group("settlement", "Liquidación v3: crédito = min(count, floor(1,5 × w_i × Σ_{j≠i} count_j / (W_probadas − w_i))); la bolsa se reparte ∝ crédito.", () => {
  const s = V.genesisState();
  const ids = ["n1", "n2", "n3", "n4"];
  s.epochNodes["5"] = V.makeSnapshot(5, "b", ids.map((node, i) => ({ node, w: [100, 100, 200, 50][i]! })));
  const counts = [1_000, 1_000, 2_000, 9_000];
  s.claims["5"] = Object.fromEntries(ids.map((node, i) => [node, { node, epoch: 5, count: counts[i]!, root: "0".repeat(128), height: 0, status: (i === 1 ? "void" : "proved") as "proved" | "void" }]));
  return [{ weights: s.epochNodes["5"], claims: s.claims["5"], credited: V.creditedClaims(s, 5) }];
});

// 7. Cadena v3 hasta el primer cierre de época
group("economy", "Cadena v4 (testnet-4): génesis y 31 bloques (alta, fianza, pago con sello, pago con comisión tras fijar precio, orden y cierre de época). Hash y raíz de estado por bloque; reparto y conservación.", () => {
  const p = K("vector-productor"), f = V.faucetKeyPair(), a = K("vector-alice");
  let s = V.genesisState();
  const cases: unknown[] = [{ height: 0, hash: s.hash, stateRoot: V.stateRoot(s) }];
  let ts = V.GENESIS_TIME + 1_000 * V.BLOCK_MS;
  const txsAt: Record<number, V.Tx[]> = {
    1: [V.makeRegister(p.secret, p.address, 0, { name: "productor", version: "3.0.0", region: "EU", ts: T0 }), V.makeTransfer(f.secret, f.address, a.address, 3_000n * V.UNIT, 0, { ts: T0 }), V.makeTransfer(f.secret, f.address, p.address, 200n * V.UNIT, 1, { ts: T0 })],
    2: [V.makeBond(p.secret, p.address, 1, 100n * V.UNIT, T0), V.makeOrder(a.secret, a.address, 0, { pair: "VEL/tEUR", side: "sell", price: 2 * EUR, amount: 2_000n * V.UNIT, ts: T0 }), V.makeOrder(f.secret, f.address, 2, { pair: "VEL/tEUR", side: "buy", price: 2 * EUR, amount: 1_200n * V.UNIT, ts: T0 })],
    3: [V.makeTokenCreate(a.secret, a.address, 1, { symbol: "VECT", name: "Vector", decimals: 2, maxSupply: 10_000n, initial: 100n, mintable: false, ts: T0 })],
  };
  for (let h = 1; h <= 31; h++) {
    ts += V.BLOCK_MS;
    const presence = s.nodes[p.address] ? [V.signObj(p.secret, V.presenceBody(p.address, s.height, ts)) as V.Presence] : [];
    const { block } = V.buildBlock(s, { proposer: p.address, ts, txs: txsAt[h] ?? [], presence });
    const signed = { ...block, sig: V.sign(p.secret, block.hash) } as V.Block;
    const r = V.applyBlock(s, signed);
    if ("error" in r) throw new Error(`bloque ${h}: ${r.error}`);
    s = r.state;
    if (V.velLedgerGap(s) !== 0n) throw new Error("conservación rota");
    if (txsAt[h] || h === 30 || h === 31) cases.push({ block: signed, stateRoot: V.stateRoot(s), ledgerGap: V.velLedgerGap(s) });
    else cases.push({ height: h, hash: s.hash });
  }
  // Con el precio ya en el oráculo, un pago grande paga comisión.
  const big = V.makeTransfer(a.secret, a.address, p.address, 600n * V.UNIT, 2, { ts: T0, ctx: s });
  cases.push({ oracle: V.oracleInfo(s), pow: s.pow, workPots: s.workPots, supply: V.supplyInfo(s), bigTransfer: { tx: big, fee: big.fee, applies: V.applyTx(V.cloneState(s), big) } });
  return cases;
});

// 8. Formato de importes (v4): lo que debe seguir toda implementación en la red
group("amounts", "Importes v4: BigInt en memoria; en JSON y en el canónico, texto decimal sin signo, sin ceros a la izquierda, sin decimales, hasta 78 cifras. Un number JSON en un campo de importe hace la tx inválida. 1 VEL = 10^18 velos.", () => {
  const a = K("vector-alice"), b = K("vector-bob");
  const tx = V.makeTransfer(a.secret, a.address, b.address, 1_500_000_000_000_000_001n, 0, { ts: T0 });
  const wire = JSON.parse(JSON.stringify(tx));
  const asNumber = { ...wire, amount: 5 };
  const valid = ["0", "1", "1000000000000000000", "21000000000000000000000000000", "9".repeat(78)];
  const invalid = ["01", "-1", "1.5", "1e18", "", " 1", "9".repeat(79)];
  return [
    { unit: V.UNIT, decimals: V.VEL_DECIMALS, maxSupply: V.MAX_SUPPLY, genesisReserve: V.GENESIS_RESERVE_SUPPLY },
    { valid: valid.map((x) => [x, V.isAmount(x)]), invalid: invalid.map((x) => [x, V.isAmount(x)]) },
    { tx: wire, canonical: V.canonical(tx), sameAsWire: V.canonical(tx) === V.canonical(wire), txId: V.txId(wire), checkTx: V.checkTx(wire), withNumberAmount: V.checkTx(asNumber) },
    { format: [["1", 18], ["1500000000000000000", 18], [V.MAX_SUPPLY.toString(), 18], ["1234560", 6]].map(([u, d]) => ({ units: u, decimals: d, es: V.formatAmount("X", String(u), Number(d), Number(d), false, "es-ES"), en: V.formatAmount("X", String(u), Number(d), Number(d), false, "en-US") })) },
    { parse: [["12,5", 18], ["1.234,56", 18], ["0,000000000000000001", 18], ["0,0000000000000000001", 18], ["1.5", 6]].map(([t, d]) => ({ text: t, decimals: d, units: V.parseAmount(String(t), Number(d)) })) },
  ];
});

// 9. Emisión v4 y migración de la mainnet
group("supply", "Oferta v4: tope 21.000 M VEL; R(e) = floor(R0 / 2^k), k = floor(e / HALVING_EPOCHS) < 33, si no 0. Mainnet: épocas de 1 h, HALVING_EPOCHS = 35.064, R0 = floor(20.900 M VEL / (2 × 35.064)). Migración v3→v4 de la mainnet en la altura de activación: importes VEL × 10^12 (µVEL → velos); los de otros tokens no cambian; se quita supply.burned.", () => {
  const MINE = V.MAX_SUPPLY - V.GENESIS_RESERVE_SUPPLY, H = 35_064n;
  const R0 = MINE / (2n * H);
  const R = (e: bigint) => (e / H >= 33n ? 0n : R0 >> (e / H));
  let total = V.GENESIS_RESERVE_SUPPLY;
  for (let k = 0n; k < 33n; k++) total += (R0 >> k) * H;
  return [
    { mainnet: { halvingEpochs: H, maxHalvings: 33, r0: R0, emission: [0n, 35_063n, 35_064n, 245_448n, 33n * H - 1n, 33n * H].map((e) => [e, R(e)]), totalAfter33Halvings: total, neverMined: V.MAX_SUPPLY - total } },
    { testnet: { halvingEpochs: V.HALVING_EPOCHS, r0: V.R0, emission0: V.emissionFor(0) } },
    { migration: { factor: V.V3_TO_V4, examples: [[1, "VEL"], [25_684_931_506, "VEL"], [100_000_000_000_000, "VEL"], [75_000_000, "vUSDT"]].map(([x, t]) => ({ v3: x, token: t, v4: t === "VEL" ? BigInt(x as number) * V.V3_TO_V4 : BigInt(x as number) })) } },
  ];
});

if (check) {
  if (failures.length) { console.error("FALLO\n" + failures.join("\n")); process.exit(1); }
  console.log(`vectores v4 al día (${Object.keys(out).length} grupos)`);
} else {
  mkdirSync(DIR, { recursive: true });
  for (const [name, v] of Object.entries(out)) writeFileSync(join(DIR, `${name}.json`), JSON.stringify({ protocol: V.PROTOCOL_VERSION, chain: V.CHAIN_ID, ...v }, null, 2) + "\n");
  console.log(`${Object.keys(out).length} grupos de vectores v4 en ${DIR}${failures.length ? `\nno generados:\n  ${failures.join("\n  ")}` : ""}`);
  if (failures.length) process.exit(1);
}
