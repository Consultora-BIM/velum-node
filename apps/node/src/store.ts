// Almacén local (bun:sqlite): bloques, cadena principal, instantáneas de estado, fragmentos e índices.
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";
import { CHAIN_ID, reviveBlock, reviveState, txId, txView, type Block, type ChainState, type Shard, type Tx } from "@velum/core";

export type StoredShard = Shard & { carrier: string };

export class Store {
  db: Database;

  /** Una base por cadena: al cambiar de red (v1 → v2…) se empieza limpio sin mezclar bloques. */
  static fileFor = () => `velum-${CHAIN_ID}.db`;

  constructor(dir: string, file = Store.fileFor()) {
    if (file !== ":memory:") {
      // Restos de la red v1 (velum.db): ya no sirven.
      for (const f of ["velum.db", "velum.db-wal", "velum.db-shm"]) if (existsSync(join(dir, f))) try { rmSync(join(dir, f)); } catch {}
    }
    this.db = new Database(file === ":memory:" ? ":memory:" : join(dir, file), { create: true });
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS blocks (hash TEXT PRIMARY KEY, height INTEGER NOT NULL, prev TEXT NOT NULL, json TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS blocks_height ON blocks(height);
      CREATE TABLE IF NOT EXISTS main (height INTEGER PRIMARY KEY, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (hash TEXT PRIMARY KEY, height INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS shards (id TEXT PRIMARY KEY, mailbox TEXT NOT NULL, msg TEXT NOT NULL, json TEXT NOT NULL, carrier TEXT NOT NULL, exp INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS shards_mailbox ON shards(mailbox);
      CREATE INDEX IF NOT EXISTS shards_exp ON shards(exp);
      CREATE TABLE IF NOT EXISTS txindex (addr TEXT NOT NULL, height INTEGER NOT NULL, ts INTEGER NOT NULL, txid TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (addr, txid));
      CREATE INDEX IF NOT EXISTS txindex_addr_h ON txindex(addr, height);
      CREATE INDEX IF NOT EXISTS txindex_h ON txindex(height);
      CREATE TABLE IF NOT EXISTS faucet (address TEXT PRIMARY KEY, ts INTEGER NOT NULL);
    `);
    // Tamaño en bytes del trozo (para el tope de bytes por buzón). Bases anteriores: se añade la columna.
    const cols = this.db.query("PRAGMA table_info(shards)").all() as { name: string }[];
    if (!cols.some((c) => c.name === "size")) this.db.exec("ALTER TABLE shards ADD COLUMN size INTEGER NOT NULL DEFAULT 0");
  }

  close() { try { this.db.close(); } catch {} }

  // ---------- Bloques ----------
  putBlock(b: Block) {
    this.db.query("INSERT OR IGNORE INTO blocks (hash, height, prev, json) VALUES (?, ?, ?, ?)").run(b.hash, b.header.height, b.header.prev, JSON.stringify(b));
  }
  hasBlock(hash: string) { return !!this.db.query("SELECT 1 FROM blocks WHERE hash = ?").get(hash); }
  getBlock(hash: string): Block | null {
    const r = this.db.query("SELECT json FROM blocks WHERE hash = ?").get(hash) as { json: string } | null;
    return r ? reviveBlock(JSON.parse(r.json)) : null;
  }
  mainHash(height: number): string | null {
    const r = this.db.query("SELECT hash FROM main WHERE height = ?").get(height) as { hash: string } | null;
    return r?.hash ?? null;
  }
  mainBlock(height: number): Block | null {
    const r = this.db.query("SELECT b.json FROM main m JOIN blocks b ON b.hash = m.hash WHERE m.height = ?").get(height) as { json: string } | null;
    return r ? reviveBlock(JSON.parse(r.json)) : null;
  }
  mainRange(from: number, to: number, maxBytes = 768 * 1024): Block[] {
    const rows = this.db.query("SELECT b.json FROM main m JOIN blocks b ON b.hash = m.hash WHERE m.height BETWEEN ? AND ? ORDER BY m.height").all(from, to) as { json: string }[];
    const out: Block[] = [];
    let bytes = 0;
    for (const r of rows) {
      bytes += r.json.length;
      if (out.length > 0 && bytes > maxBytes) break;
      out.push(reviveBlock(JSON.parse(r.json)));
    }
    return out;
  }
  /** Marca como principal la rama dada (alturas consecutivas) y borra lo que quede por encima de la nueva cabeza. */
  setMain(blocks: Block[], headHeight: number) {
    const tx = this.db.transaction(() => {
      this.db.query("DELETE FROM main WHERE height > ?").run(headHeight);
      const ins = this.db.query("INSERT OR REPLACE INTO main (height, hash) VALUES (?, ?)");
      for (const b of blocks) ins.run(b.header.height, b.hash);
      // Índice de historial: se rehace para las alturas tocadas.
      const minH = blocks.length ? blocks[0]!.header.height : headHeight + 1;
      this.db.query("DELETE FROM txindex WHERE height >= ?").run(minH);
      const idx = this.db.query("INSERT OR REPLACE INTO txindex (addr, height, ts, txid, json) VALUES (?, ?, ?, ?, ?)");
      for (const b of blocks) for (const t of b.txs) {
        const json = JSON.stringify(t);
        const id = txKey(t);
        idx.run(t.from, b.header.height, b.header.ts, id, json);
        const to = t.type === "transfer" || t.type === "token.mint" ? t.to : null;
        if (to && to !== t.from) idx.run(to, b.header.height, b.header.ts, id, json);
      }
    });
    tx();
  }
  pruneSideBlocks(belowHeight: number) {
    this.db.query("DELETE FROM blocks WHERE height < ? AND hash NOT IN (SELECT hash FROM main WHERE height < ?)").run(belowHeight, belowHeight);
  }

  // ---------- Estado ----------
  // En disco, importes en texto decimal (v4). Un estado guardado por el nodo v2.0.0 (µVEL, números) se sube a v4 al leerlo.
  saveHead(state: ChainState) { this.setMeta("state", JSON.stringify(state)); }
  loadHead(): ChainState | null {
    const v = this.getMeta("state");
    return v ? reviveState(JSON.parse(v)) : null;
  }
  putSnapshot(state: ChainState) {
    this.db.query("INSERT OR REPLACE INTO snapshots (hash, height, json) VALUES (?, ?, ?)").run(state.hash, state.height, JSON.stringify(state));
    // Guardamos solo las 12 más recientes.
    this.db.query("DELETE FROM snapshots WHERE hash NOT IN (SELECT hash FROM snapshots ORDER BY height DESC LIMIT 12)").run();
  }
  getSnapshot(hash: string): ChainState | null {
    const r = this.db.query("SELECT json FROM snapshots WHERE hash = ?").get(hash) as { json: string } | null;
    return r ? reviveState(JSON.parse(r.json)) : null;
  }
  getMeta(k: string): string | null {
    const r = this.db.query("SELECT v FROM meta WHERE k = ?").get(k) as { v: string } | null;
    return r?.v ?? null;
  }
  setMeta(k: string, v: string) { this.db.query("INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)").run(k, v); }

  // ---------- Historial ----------
  history(addr: string, limit = 50): { height: number; ts: number; tx: Tx }[] {
    const rows = this.db.query("SELECT height, ts, json FROM txindex WHERE addr = ? ORDER BY height DESC, ts DESC LIMIT ?").all(addr, Math.min(Math.max(1, limit), 500)) as { height: number; ts: number; json: string }[];
    // Tx anteriores a la v4 (µVEL, números) se sirven ya convertidas a velos en texto (vista v4).
    return rows.map((r) => ({ height: r.height, ts: r.ts, tx: txView(JSON.parse(r.json)) }));
  }

  // ---------- Fragmentos ----------
  putShard(s: StoredShard): boolean {
    const { carrier, ...shard } = s;
    const r = this.db.query("INSERT OR IGNORE INTO shards (id, mailbox, msg, json, carrier, exp, size) VALUES (?, ?, ?, ?, ?, ?, ?)").run(shard.id, shard.mailbox, shard.msg, JSON.stringify(shard), carrier, shard.exp, shardBytes(shard));
    return r.changes > 0;
  }
  hasShard(id: string) { return !!this.db.query("SELECT 1 FROM shards WHERE id = ?").get(id); }
  deleteShard(id: string, mailbox?: string): boolean {
    const r = mailbox
      ? this.db.query("DELETE FROM shards WHERE id = ? AND mailbox = ?").run(id, mailbox)
      : this.db.query("DELETE FROM shards WHERE id = ?").run(id);
    return r.changes > 0;
  }
  shardsFor(mailbox: string, limit = 5000): StoredShard[] {
    const rows = this.db.query("SELECT json, carrier FROM shards WHERE mailbox = ? AND exp > ? ORDER BY msg, id LIMIT ?").all(mailbox, Date.now(), limit) as { json: string; carrier: string }[];
    return rows.map((r) => ({ ...JSON.parse(r.json), carrier: r.carrier }));
  }
  pruneShards(now = Date.now()): number { return this.db.query("DELETE FROM shards WHERE exp <= ?").run(now).changes; }
  /** Trozos y bytes pendientes (sin caducar) en un buzón. */
  mailboxUsage(mailbox: string, now = Date.now()): { n: number; bytes: number } {
    const r = this.db.query("SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM shards WHERE mailbox = ? AND exp > ?").get(mailbox, now) as { n: number; bytes: number };
    return { n: r.n, bytes: r.bytes };
  }
  countMailbox(mailbox: string): number { return (this.db.query("SELECT COUNT(*) AS n FROM shards WHERE mailbox = ?").get(mailbox) as { n: number }).n; }
  /** Hace sitio: borra los `n` trozos que antes caducan. */
  evictOldest(n: number): number { return this.db.query("DELETE FROM shards WHERE id IN (SELECT id FROM shards ORDER BY exp LIMIT ?)").run(n).changes; }
  getShard(id: string): StoredShard | null {
    const r = this.db.query("SELECT json, carrier FROM shards WHERE id = ?").get(id) as { json: string; carrier: string } | null;
    return r ? { ...JSON.parse(r.json), carrier: r.carrier } : null;
  }
  shardCount(): number { return (this.db.query("SELECT COUNT(*) AS n FROM shards").get() as { n: number }).n; }

  // ---------- Grifo ----------
  faucetLast(address: string): number {
    const r = this.db.query("SELECT ts FROM faucet WHERE address = ?").get(address) as { ts: number } | null;
    return r?.ts ?? 0;
  }
  faucetMark(address: string, ts: number) { this.db.query("INSERT OR REPLACE INTO faucet (address, ts) VALUES (?, ?)").run(address, ts); }
}

const txKey = (t: Tx) => txId(t);
/** Bytes útiles de un trozo (datos en base64 → bytes). */
export const shardBytes = (s: Pick<Shard, "data">) => (typeof s.data === "string" ? Math.floor((s.data.length * 3) / 4) : 0);
