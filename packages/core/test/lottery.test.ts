// Rutas por sorteo público: nadie gana más que su parte inventándose tráfico (investigacion.md §5.6.4).
import { describe, expect, test } from "bun:test";
import * as V from "../src";

const K = (t: string) => V.keyPairFromText(t);
const nodes = [K("lot-a"), K("lot-b"), K("lot-c"), K("lot-d")];
const light = K("lot-light");
const attacker = nodes[0]!;

/** Cadena con 4 completos + 1 ligero dados de alta y la primera foto de época tomada. */
function chainWithSnapshot() {
  let s = V.genesisState();
  s.ts = Date.now() - 3 * 3600_000;
  const step = (txs: V.Tx[] = [], receipts: V.ReceiptV2[] = [], withPresence = true) => {
    const ts = s.ts + V.BLOCK_MS;
    // Le toca al de puesto 0 en este hueco (con todos presentes, el turno importa).
    const p = nodes.find((k) => V.proposerRank(s, V.slotOf(ts), k.address) === 0) ?? nodes[1]!;
    const presence = s.height && withPresence ? [...nodes, light].map((k) => V.signObj(k.secret, V.presenceBody(k.address, s.height, ts)) as V.Presence) : [];
    const { block } = V.buildBlock(s, { proposer: p.address, ts, txs, receipts, presence });
    const r = V.applyBlock(s, { ...block, sig: V.sign(p.secret, block.hash) } as V.Block);
    if ("error" in r) throw new Error(r.error);
    s = r.state;
    return block;
  };
  step([...nodes, light].map((k, i) => V.makeRegister(k.secret, k.address, 0, { name: "n" + i, version: "2", kind: k === light ? "light" : "full", ts: 1 })));
  while (s.height % V.EPOCH_BLOCKS !== 0) step();
  return { get s() { return s; }, step };
}

function rec(s: V.ChainState, shard: string, carrier: string, courier: string, mailbox: string): V.ReceiptV2 {
  const secret = V.receiptSecret("22".repeat(32), shard);
  return { shard, mailbox, rh: V.receiptHash(secret), secret, carrier, courier, ts: s.ts + V.BLOCK_MS, ep: V.currentSnapshot(s)!.epoch };
}

describe("sorteo público de rutas", () => {
  test("determinista, ponderado (peso de tipo × nivel × fianza) y baliza = último bloque de la época anterior", () => {
    const c = chainWithSnapshot();
    const snap = V.currentSnapshot(c.s)!;
    expect(snap.epoch).toBe(1);
    const wFull = snap.nodes.find((n) => n.node === nodes[0]!.address)!.w;
    const wLight = snap.nodes.find((n) => n.node === light.address)!.w;
    expect(wLight * 2).toBe(wFull); // el ligero pesa la mitad
    expect(snap.total).toBe(4 * wFull + wLight);
    expect(snap.beacon).not.toBe(V.genesisState().hash);
    expect(V.assignedNode(snap, "abc", "carrier")).toBe(V.assignedNode(snap, "abc", "carrier"));
    const hits = new Map<string, number>();
    const N = 18_000;
    for (let i = 0; i < N; i++) {
      const a = V.assignedNode(snap, "s" + i, i % 2 ? "carrier" : "courier")!;
      hits.set(a, (hits.get(a) ?? 0) + 1);
    }
    for (const n of snap.nodes) expect(Math.abs(hits.get(n.node)! / N - n.w / snap.total)).toBeLessThan(0.015);
    let same = 0;
    for (let i = 0; i < 2000; i++) if (V.assignedNode(snap, "x" + i, "carrier") === V.assignedNode(snap, "x" + i, "courier")) same++;
    expect(same / 2000).toBeLessThan(0.35);
    // v3: 3 candidatos distintos; el primero es el sorteado.
    const c3 = V.lotteryCandidates(snap, "abc", "carrier");
    expect(c3.length).toBe(3);
    expect(new Set(c3).size).toBe(3);
    expect(c3[0]).toBe(V.assignedNode(snap, "abc", "carrier")!);
    expect(V.lotteryCandidates(V.makeSnapshot(0, "b", [{ node: "solo" }]), "x", "courier")).toEqual(["solo"]);
  });

  test("un nodo que se manda tráfico falso a sí mismo no cobra más que el tope sobre su parte justa", () => {
    // v3: cada nodo reclama las hojas en las que figura y es candidato (3 por papel). El atacante reclama
    // todos sus trozos falsos en los que cae entre los candidatos; el tope de verosimilitud (×1,5 de lo
    // esperado por su peso) recorta el exceso. Sin sorteo cobraría el 50 % de lo reclamado.
    const c = chainWithSnapshot();
    const s0 = c.s;
    const snap = V.currentSnapshot(s0)!;
    const book = new Map<string, V.WorkBook>([...nodes, light].map((k) => [k.address, new V.WorkBook(k.address)]));
    const snapFor = (ep: number) => V.snapshotFor(s0, ep);
    for (let i = 0; i < 1500; i++) {
      const shard = `honesto-${i}`;
      const r = V.lotteryRoute(snap, shard);
      const receipt = rec(s0, shard, r.carrier!, r.courier!, "mb" + (i % 50));
      for (const b of book.values()) b.add(receipt, s0.height + 1, snapFor);
    }
    let fakeLeaves = 0;
    for (let i = 0; i < 1500; i++) fakeLeaves += book.get(attacker.address)!.add(rec(s0, `falso-${i}`, attacker.address, attacker.address, "propio" + (i % 50)), s0.height + 1, snapFor);
    // Solo entran las hojas falsas en las que el atacante está entre los 3 candidatos (≈ 3 × su peso por papel).
    expect(fakeLeaves / 3000).toBeLessThan(0.8);
    // Simula reclamaciones probadas de esa época y aplica el tope de la cadena.
    const E = snap.epoch;
    const st = JSON.parse(JSON.stringify(s0)) as V.ChainState;
    (st as any).claims = { [String(E)]: {} };
    for (const [node, b] of book) {
      const count = b.counts()[String(V.workEpochOf(s0.height + 1))] ?? 0;
      if (count) (st as any).claims[String(E)][node] = { node, epoch: E, count, root: "0".repeat(128), height: st.height, status: "proved" };
    }
    const credited = V.creditedClaims(st, E);
    const total = credited.reduce((a, x) => a + x.credited, 0);
    const att = credited.find((x) => x.node === attacker.address)!;
    const fair = snap.nodes.find((n) => n.node === attacker.address)!.w / snap.total;
    expect(att.count).toBeGreaterThan(att.credited); // el tope recorta lo inventado
    expect(att.credited / total).toBeLessThan(1.5 * fair + 0.03);
    expect(att.credited / total).toBeLessThan(0.5);
  });

  test("solo cobran los candidatos del sorteo; las fotos viejas se podan", () => {
    const c = chainWithSnapshot();
    const snap = V.currentSnapshot(c.s)!;
    const shard = "t1";
    const cands = V.lotteryCandidates(snap, shard, "carrier");
    const outsider = [...nodes, light].find((k) => !cands.includes(k.address))!.address;
    const ok = rec(c.s, shard, cands[1]!, cands[1]!, "m");
    expect(V.claimableRoles(c.s, ok, cands[1]!)).toContain("carrier");
    expect(V.claimableRoles(c.s, { ...ok, carrier: outsider }, outsider)).not.toContain("carrier");
    expect(V.claimableRoles(c.s, { ...ok, ep: 99 }, cands[1]!)).toEqual([]);
    expect(V.claimableRoles(c.s, { ...ok, ep: undefined }, cands[1]!)).toEqual([]);
    for (let i = 0; i < V.EPOCH_BLOCKS * (V.LOTTERY_KEEP_EPOCHS + 1); i++) c.step([], [], false);
    expect(Object.keys(c.s.epochNodes).length).toBe(V.LOTTERY_KEEP_EPOCHS);
    expect(c.s.epochNodes["1"]).toBeUndefined();
  }, 60_000);
});
