import { expect, test } from "bun:test";
import * as V from "@velum/core";
import { Store } from "../src/store";
import { MAILBOX_FULL, MAILBOX_FULL_BYTES, NodeCreditBook, ShardGate } from "../src/gate";

const KB = 1024;
let seq = 0;
/** Trozo de mentira (la gate no valida formato: eso lo hace shardProblem antes). */
const fake = (mailbox: string, msg: string, bytes = 1 * KB, exp = Date.now() + 3_600_000): V.Shard => ({
  id: `id${seq++}`, msg, mailbox, stripe: 0, idx: 0, k: 3, n: 5, bucket: 2048, data: "A".repeat(Math.ceil((bytes * 4) / 3)),
  rh: "0".repeat(128), mbAuth: "0".repeat(64), exp,
});

test("buzón lleno por número de trozos: error claro", () => {
  const store = new Store("", ":memory:");
  const gate = new ShardGate(store, null);
  for (let i = 0; i < V.MAX_SHARDS_PER_MAILBOX; i++) store.putShard({ ...fake("mb", `m${i}`, 10), carrier: "n" });
  expect(gate.admit(fake("mb", "nuevo", 10), { conn: "l:1" })).toBe(MAILBOX_FULL);
  expect(gate.admit(fake("otro", "nuevo", 10), { conn: "l:1" })).toBeNull();
});

test("buzón lleno por bytes pendientes; los caducados no cuentan", () => {
  const store = new Store("", ":memory:");
  const gate = new ShardGate(store, null);
  const big = 24 * KB;
  const n = Math.floor(V.MAX_BYTES_PER_MAILBOX / big);
  for (let i = 0; i < n; i++) store.putShard({ ...fake("mb", `m${i}`, big), carrier: "n" });
  expect(gate.mailboxProblem(fake("mb", "x", big))).toBe(MAILBOX_FULL_BYTES);
  const store2 = new Store("", ":memory:");
  for (let i = 0; i < n; i++) store2.putShard({ ...fake("mb", `m${i}`, big, Date.now() - 1), carrier: "n" });
  expect(new ShardGate(store2, null).mailboxProblem(fake("mb", "x", big))).toBeNull();
});

test("un remitente no puede llenar solo un buzón; se libera al entregar", () => {
  const store = new Store("", ":memory:");
  const gate = new ShardGate(store, null);
  const q = V.quotaSecret(V.bytesToHex(V.randomBytes(32)));
  const pass = V.makeRatePass(q, "copia");
  const ids: string[] = [];
  for (let i = 0; i < V.MAX_SHARDS_PER_SENDER_MAILBOX; i++) {
    const s = fake("mb", "copia", 100);
    ids.push(s.id);
    expect(gate.admit(s, { conn: "l:1", pass })).toBeNull();
    store.putShard({ ...s, carrier: "n" });
  }
  expect(gate.admit(fake("mb", "copia", 100), { conn: "l:1", pass })).toContain("Demasiados trozos pendientes");
  // Otro remitente sí entra en el mismo buzón.
  expect(gate.admit(fake("mb", "otra", 100), { conn: "l:2" })).toBeNull();
  gate.delivered(ids[0]!);
  store.deleteShard(ids[0]!);
  expect(gate.admit(fake("mb", "copia", 100), { conn: "l:1", pass })).toBeNull();
});

test("cupo por conexión en shard.put; reenvíos de otro nodo no lo cuentan dos veces", () => {
  const store = new Store("", ":memory:");
  const gate = new ShardGate(store, null);
  for (let i = 0; i < V.FREE_COPIES_PER_WINDOW; i++) expect(gate.admit(fake(`mb${i}`, `m${i}`, 10), { conn: "h:c_1" })).toBeNull();
  expect(gate.admit(fake("mbx", "mx", 10), { conn: "h:c_1" })).toContain("Cupo gratis agotado");
  expect(gate.quotaOnly(fake("mbx", "mx", 10), { conn: "h:c_1" })).toContain("Cupo gratis agotado");
  expect(gate.admit(fake("mbx", "mx", 10), { conn: "d:otro-nodo" })).toBeNull();
});

test("créditos del nodo: comprados del estado, gastados en meta (persisten)", () => {
  const store = new Store("", ":memory:");
  const book = new NodeCreditBook((a) => (a === "velX" ? 5 : 0), store);
  expect(book.available("velX")).toBe(5);
  book.consume("velX"); book.consume("velX");
  book.flush();
  expect(new NodeCreditBook((a) => (a === "velX" ? 5 : 0), store).available("velX")).toBe(3);
  expect(book.available("velY")).toBe(0);
});
