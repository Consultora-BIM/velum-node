// Gestor de la cadena: guarda bloques, elige la mejor rama (más larga; a igual altura, menor hash) y reorganiza.
import { applyBlock, betterHead, genesisState, protocolAt, slotOf, type Block, type ChainState, type Receipt, type Tx, txId, receiptId } from "@velum/core";
import type { Store } from "./store";

/** Estados recientes que guardamos en memoria (por hash de bloque) para reorganizar sin recalcular. */
const STATE_CACHE = 128;
const SNAPSHOT_EVERY = 64;
const MAX_ORPHANS = 512;

export type AddResult =
  | { status: "known" }
  | { status: "invalid"; error: string }
  | { status: "orphan" }
  | { status: "side" }
  | { status: "head"; extended: Block[]; reorg?: { depth: number; droppedTxs: Tx[]; droppedReceipts: Receipt[] } };

export class Chain {
  readonly genesis: ChainState;
  state: ChainState;
  head: Block | null = null;
  private states = new Map<string, ChainState>();
  /** Bloques cuyo padre aún no conocemos: prev → bloques. */
  private orphans = new Map<string, Map<string, Block>>();
  private orphanCount = 0;

  constructor(private store: Store) {
    this.genesis = genesisState();
    this.state = this.genesis;
    this.remember(this.genesis);
    this.load();
  }

  get height() { return this.state.height; }
  get hash() { return this.state.hash; }
  /** Hueco del bloque de cabeza (-1 en el génesis). */
  get headSlot() { return this.head?.header.slot ?? (this.state.height > 0 ? slotOf(this.state.ts) : -1); }

  private load() {
    const saved = this.store.loadHead();
    if (!saved || saved.chain !== this.genesis.chain) return;
    const head = this.store.getBlock(saved.hash);
    // Arranque desde una foto importada (velum-node snapshot import): no hay bloques anteriores, solo el estado comprobado.
    if (saved.height > 0 && !head && this.store.getMeta("snapshotBase") === saved.hash && this.store.getSnapshot(saved.hash)) {
      this.state = saved;
      this.head = null;
      this.remember(saved);
      return;
    }
    if (saved.height > 0 && (!head || this.store.mainHash(saved.height) !== saved.hash)) {
      // Estado guardado incoherente: lo rehacemos desde la cadena principal.
      this.rebuildFromMain();
      return;
    }
    // La cabeza guardada debe llevar la versión de protocolo que este binario espera a esa altura. Si no, la altura
    // de una actualización (p. ej. la v4) ya pasó en la red con las reglas viejas: arrancar rompería la cadena.
    const pv = head?.header.pv;
    if (head && typeof pv === "number" && pv !== protocolAt(head.header.height)) {
      throw new Error(`El bloque ${head.header.height} es de protocolo v${pv} y este binario espera v${protocolAt(head.header.height)} a esa altura: la altura de activación ya pasó. No arranques este binario en esta red.`);
    }
    this.state = saved;
    this.head = head;
    this.remember(saved);
  }

  private rebuildFromMain() {
    let s = this.genesis;
    let head: Block | null = null;
    for (let h = 1; ; h++) {
      const b = this.store.mainBlock(h);
      if (!b) break;
      const r = applyBlock(s, b);
      // Nunca se trunca la cadena principal: si un bloque guardado ya no entra (p. ej. una altura de
      // actualización que no coincide con la red), el nodo se para y la base queda intacta.
      if ("error" in r) throw new Error(`No se puede reconstruir la cadena en el bloque ${h}: ${r.error}. La base no se ha tocado.`);
      s = r.state;
      head = b;
      this.remember(s);
    }
    this.state = s;
    this.head = head;
    this.store.setMain([], s.height);
    this.store.saveHead(s);
  }

  private remember(s: ChainState) {
    this.states.set(s.hash, s);
    if (this.states.size > STATE_CACHE) {
      for (const k of this.states.keys()) {
        if (k === this.genesis.hash || k === this.state.hash) continue;
        this.states.delete(k);
        break;
      }
    }
  }

  /** Estado tras el bloque `hash` (o null si no tenemos ese bloque). Recalcula desde el antepasado más cercano conocido. */
  stateFor(hash: string): ChainState | null {
    const hit = this.states.get(hash);
    if (hit) return hit;
    const path: Block[] = [];
    let cur = hash;
    let base: ChainState | null = null;
    while (true) {
      const cached = this.states.get(cur) ?? this.store.getSnapshot(cur);
      if (cached) { base = cached; break; }
      const b = this.store.getBlock(cur);
      if (!b) return null;
      path.push(b);
      cur = b.header.prev;
    }
    let s = base;
    for (let i = path.length - 1; i >= 0; i--) {
      const r = applyBlock(s, path[i]!);
      if ("error" in r) return null;
      s = r.state;
      this.remember(s);
    }
    return s;
  }

  hasBlock(hash: string) { return hash === this.genesis.hash || this.store.hasBlock(hash) || this.isOrphan(hash); }
  private isOrphan(hash: string) {
    for (const m of this.orphans.values()) if (m.has(hash)) return true;
    return false;
  }

  /** Añade un bloque recibido o propio. */
  add(b: Block): AddResult {
    if (!b || !b.header || typeof b.hash !== "string") return { status: "invalid", error: "Bloque mal formado" };
    if (b.hash === this.genesis.hash || this.store.hasBlock(b.hash)) return { status: "known" };
    const parent = this.stateFor(b.header.prev);
    if (!parent) {
      if (this.isOrphan(b.hash)) return { status: "orphan" };
      if (this.orphanCount >= MAX_ORPHANS) { this.orphans.clear(); this.orphanCount = 0; }
      (this.orphans.get(b.header.prev) ?? this.orphans.set(b.header.prev, new Map()).get(b.header.prev)!).set(b.hash, b);
      this.orphanCount++;
      return { status: "orphan" };
    }
    const r = applyBlock(parent, b);
    if ("error" in r) return { status: "invalid", error: r.error };
    this.store.putBlock(b);
    this.remember(r.state);
    if (r.state.height % SNAPSHOT_EVERY === 0) this.store.putSnapshot(r.state);

    let result: AddResult = { status: "side" };
    const best = betterHead({ height: this.state.height, hash: this.state.hash }, { height: r.state.height, hash: r.state.hash });
    if (best.hash === r.state.hash && r.state.hash !== this.state.hash) result = this.switchTo(b, r.state);

    // Hijos que esperaban a este bloque.
    const kids = this.orphans.get(b.hash);
    if (kids) {
      this.orphans.delete(b.hash);
      this.orphanCount -= kids.size;
      for (const k of kids.values()) {
        const kr = this.add(k);
        if (kr.status === "head") {
          if (result.status === "head") {
            result.extended.push(...kr.extended);
            if (kr.reorg) result.reorg = mergeReorg(result.reorg, kr.reorg);
          } else result = kr;
        }
      }
    }
    return result;
  }

  private switchTo(b: Block, st: ChainState): AddResult {
    const oldHash = this.state.hash;
    const oldHeight = this.state.height;
    // Rama nueva hasta encontrar un bloque que ya esté en la principal.
    const branch: Block[] = [b];
    let prev = b.header.prev;
    let forkHeight = b.header.height - 1;
    while (forkHeight > 0 && this.store.mainHash(forkHeight) !== prev) {
      const pb = this.store.getBlock(prev);
      if (!pb) break;
      branch.unshift(pb);
      prev = pb.header.prev;
      forkHeight--;
    }
    let reorg: { depth: number; droppedTxs: Tx[]; droppedReceipts: Receipt[] } | undefined;
    if (b.header.prev !== oldHash) {
      const newTx = new Set(branch.flatMap((x) => x.txs.map(txId)));
      const newRc = new Set(branch.flatMap((x) => x.receipts.map(receiptId)));
      const droppedTxs: Tx[] = [];
      const droppedReceipts: Receipt[] = [];
      for (let h = forkHeight + 1; h <= oldHeight; h++) {
        const ob = this.store.mainBlock(h);
        if (!ob) continue;
        for (const t of ob.txs) if (!newTx.has(txId(t))) droppedTxs.push(t);
        for (const r of ob.receipts) if (!newRc.has(receiptId(r))) droppedReceipts.push(r);
      }
      reorg = { depth: oldHeight - forkHeight, droppedTxs, droppedReceipts };
    }
    this.store.setMain(branch, st.height);
    this.state = st;
    this.head = b;
    this.store.saveHead(st);
    return { status: "head", extended: branch, reorg };
  }

  blockAt(height: number): Block | null {
    if (height <= 0 || height > this.state.height) return null;
    return this.store.mainBlock(height);
  }
  blockByHash(hash: string): Block | null { return this.store.getBlock(hash); }
  range(from: number, to: number): Block[] {
    const a = Math.max(1, Math.floor(from));
    const z = Math.min(this.state.height, Math.floor(to), a + 199);
    return z >= a ? this.store.mainRange(a, z) : [];
  }
}

function mergeReorg(
  a: { depth: number; droppedTxs: Tx[]; droppedReceipts: Receipt[] } | undefined,
  b: { depth: number; droppedTxs: Tx[]; droppedReceipts: Receipt[] },
) {
  if (!a) return b;
  return { depth: Math.max(a.depth, b.depth), droppedTxs: [...a.droppedTxs, ...b.droppedTxs], droppedReceipts: [...a.droppedReceipts, ...b.droppedReceipts] };
}
