import { expect, test } from "bun:test";
import * as V from "../src";

const alice = V.keyPairFromText("alice"), bob = V.keyPairFromText("bob"), carol = V.keyPairFromText("carol");
const n1 = V.keyPairFromText("node1"), n2 = V.keyPairFromText("node2");

test("direcciones", () => {
  expect(V.isAddress(alice.address)).toBe(true);
  expect(V.isAddress("vel_burn")).toBe(false);
});

// Los tests de sobre, grupo y fragmentos v1 se sustituyen por test/messaging.test.ts (v2).

// Los tests de cadena v1 (recibos firmados) se sustituyen por test/chain.test.ts (v2: recibos anónimos, tokens, mercado).

test("la cadena no se para si los activos desaparecen", () => {
  const s = V.genesisState();
  s.ts = V.GENESIS_TIME + 100 * V.BLOCK_MS;
  for (let i = 0; i < 6; i++) {
    const k = V.keyPairFromText("n" + i);
    s.nodes[k.address] = { address: k.address, lastPresence: s.height } as any;
  }
  const outsider = V.keyPairFromText("late");
  s.nodes[outsider.address] = { address: outsider.address, lastPresence: -100 } as any;
  const slot = V.slotOf(s.ts);
  expect(V.proposerRank(s, slot + 1, outsider.address)).toBe(6);
  expect(V.proposerRank(s, slot + 8, outsider.address)).toBe(0);
});
