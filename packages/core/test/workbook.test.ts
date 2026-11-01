// Libro de trabajo del nodo (v3 §4): hojas → work.claim al entrar en E+1 → work.prove con la baliza de E+3.
import { expect, test } from "bun:test";
import * as V from "../src";

test("libro de trabajo: reclama, prueba con caminos válidos y olvida", () => {
  const me = V.keyPairFromText("wb-yo").address;
  const others = ["b", "c"].map((x) => V.keyPairFromText("wb-" + x).address);
  const B = V.EPOCH_BLOCKS;
  const E = 4;
  const snaps = new Map<number, V.EpochSnapshot>([E, E + 3].map((e) => [e, V.makeSnapshot(e, V.hashHex("b" + e), [me, ...others].map((node) => ({ node })))]));
  const snapFor = (ep: number) => snaps.get(ep) ?? null;
  const book = new V.WorkBook(me);
  const h = B * E + 5; // bloque de la época E
  let n = 0;
  for (let i = 0; n < 40; i++) {
    const shard = "s" + i;
    if (!V.lotteryCandidates(snaps.get(E)!, shard, "carrier").includes(me)) continue;
    const secret = V.receiptSecret("aa".repeat(32), shard);
    const r: V.ReceiptV2 = { shard, mailbox: "m", rh: V.receiptHash(secret), secret, carrier: me, courier: others[0]!, ts: 1, ep: E };
    expect(book.add(r, h, snapFor)).toBe(1);
    expect(book.add(r, h, snapFor)).toBe(0); // sin repetir
    n++;
  }
  // Recibo que no me nombra o con secreto falso: nada.
  const s2 = V.receiptSecret("bb".repeat(32), "x");
  expect(book.add({ shard: "x", mailbox: "m", rh: V.receiptHash(s2), secret: s2, carrier: others[0]!, courier: others[1]!, ts: 1, ep: E }, h, snapFor)).toBe(0);
  expect(book.add({ shard: "x", mailbox: "m", rh: "00".repeat(64), secret: s2, carrier: me, courier: me, ts: 1, ep: E }, h, snapFor)).toBe(0);
  // Aún en E: nada que enviar.
  expect(book.due(h, snapFor, () => null)).toEqual([]);
  // Cabeza en 30(E+1): toca reclamar E.
  const [claim] = book.due(B * (E + 1), snapFor, () => null, 1_000);
  expect(claim).toMatchObject({ kind: "claim", epoch: E, count: 40 });
  // Reintenta solo pasado el plazo.
  expect(book.due(B * (E + 1) + 1, snapFor, () => null, 2_000)).toEqual([]);
  const onChain = () => ({ status: "pending", count: 40 });
  // Con la foto E+3: prueba de las muestras.
  const [prove] = book.due(B * (E + 3), snapFor, onChain, 50_000);
  if (prove?.kind !== "prove" || claim?.kind !== "claim") throw new Error("esperaba reclamación y prueba");
  const idx = V.proofIndices(V.claimSamples(snaps.get(E + 3)!.beacon, me, E, 40), 40);
  expect(prove.leaves.length).toBe(idx.length);
  prove.leaves.forEach((leaf, i) => expect(V.verifyWorkPath(V.leafHash(leaf), idx[i]!, 40, prove.paths[i], claim.root)).toBe(true));
  // Pasada E+5 se olvida.
  book.due(B * (E + 6), snapFor, onChain, 100_000);
  expect(book.counts()[String(E)]).toBeUndefined();
});
