// Nodo ligero (protocolo-v2 §10): corre dentro de la app (iOS) o en cualquier sitio con WebSocket.
// Sin APIs de Bun ni de Node: almacenamiento enchufable (memoria por defecto; la app pone SQLite).
//
//  · Se conecta a la puerta como `role=node` con `kind: "light"` en el saludo.
//  · No guarda la cadena: sigue la cabeza (`head`) y la foto del sorteo (`epoch` o `chain.epoch` a un completo).
//  · Acepta `shard.put`, sirve `mailbox.open` (con prueba de buzón) y `receipt.submit`, empuja trozos a
//    los buzones abiertos y propaga trozos y recibos.
//  · Se da de alta solo con una tx `register { kind: "light" }` (el alta es gratis) y manda señal de vida
//    para que el sorteo lo cuente como presente (y cobre ×0,5).
import { GATEWAYS, CHAIN_ID, EPOCH_BLOCKS, PROTOCOL_VERSION } from "./constants";
import type { KeyPair } from "./keys";
import { sign, signObj } from "./keys";
import { verifyOpenProof, type MailboxOpen } from "./mailbox";
import { checkReceiptProof, type ReceiptV2 } from "./proof";
import { shardProblem, type Shard } from "./shards";
import { makeRegister, makeWorkClaim, makeWorkProve } from "./wallet";
import { WorkBook } from "./workbook";
import { helloChallenge, presenceBody, type DirectRpc, type GossipItem, type PeerInfo, type RpcMethod } from "./wire";
import type { EpochSnapshot } from "./lottery";
import type { Socket } from "./client";
import type { Presence } from "./tx";

export type LightShard = Shard & { carrier: string };

/** Almacén de trozos. La app puede darle uno con SQLite; por defecto vive en memoria. */
export interface LightStore {
  put(s: LightShard): boolean;
  get(id: string): LightShard | undefined;
  delete(id: string): boolean;
  /** Trozos de un buzón con esa clave de apertura (sin caducar). */
  list(mailbox: string, auth: string, now: number): LightShard[];
  count(): number;
  countMailbox(mailbox: string): number;
  /** Borra los caducados. Devuelve cuántos. */
  prune(now: number): number;
  /** Borra el que antes caduca (para hacer sitio). */
  evictOldest(): boolean;
}

export class MemoryLightStore implements LightStore {
  private m = new Map<string, LightShard>();
  put(s: LightShard) {
    if (this.m.has(s.id)) return false;
    this.m.set(s.id, s);
    return true;
  }
  get(id: string) { return this.m.get(id); }
  delete(id: string) { return this.m.delete(id); }
  list(mailbox: string, auth: string, now: number) {
    return [...this.m.values()].filter((s) => s.mailbox === mailbox && s.mbAuth === auth && s.exp > now);
  }
  count() { return this.m.size; }
  countMailbox(mailbox: string) {
    let n = 0;
    for (const s of this.m.values()) if (s.mailbox === mailbox) n++;
    return n;
  }
  prune(now: number) {
    let n = 0;
    for (const [id, s] of this.m) if (s.exp <= now) { this.m.delete(id); n++; }
    return n;
  }
  evictOldest() {
    let old: LightShard | undefined;
    for (const s of this.m.values()) if (!old || s.exp < old.exp) old = s;
    return old ? this.m.delete(old.id) : false;
  }
}

export interface LightNodeOptions {
  /** Clave del nodo (la app la guarda en el Keychain). */
  keys: KeyPair;
  /** Opcional y decorativo: un nodo es su dirección. Vacío por defecto. */
  name?: string;
  /** Cartera que cobra (por defecto, la del nodo). */
  payout?: string;
  /** Puerta(s) de entrada; por defecto GATEWAYS. */
  url?: string | readonly string[];
  socket?: (url: string) => Socket;
  store?: LightStore;
  /** Tope de trozos guardados (memoria del móvil). */
  maxShards?: number;
  maxPerMailbox?: number;
  version?: string;
}

export interface LightNodeStats {
  connected: boolean;
  registered: boolean;
  height: number;
  epoch: number | null;
  shardsStored: number;
  shardsAccepted: number;
  shardsDelivered: number;
  receiptsAccepted: number;
  mailboxes: number;
}

type Listener = (s: LightNodeStats) => void;

const DEFAULT_SOCKET = (url: string): Socket => new (globalThis as unknown as { WebSocket: new (u: string) => Socket }).WebSocket(url);
const RPC_TIMEOUT_MS = 10_000;

export class LightNode {
  readonly address: string;
  private urls: string[];
  private urlIdx = 0;
  private ws: Socket | null = null;
  private up = false;
  private stopped = true;
  private backoff = 1_000;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private timers: ReturnType<typeof setInterval>[] = [];
  private store: LightStore;
  private maxShards: number;
  private maxPerMailbox: number;
  private peers = new Map<string, PeerInfo>();
  private subs = new Map<string, Map<string, string>>(); // buzón → cliente → auth
  private calls = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private seq = 0;
  private seen = new Set<string>();
  private registering = 0;
  head = { height: 0, hash: "", ts: 0 };
  snapshot: EpochSnapshot | null = null;
  /** Fotos del sorteo por época (para apuntar hojas de trabajo y para la baliza de muestreo). */
  private snaps = new Map<number, EpochSnapshot>();
  /** v3: reclamaciones de trabajo propias (estado local: el ligero no guarda la cadena). */
  readonly work: WorkBook;
  private claimed = new Map<number, { status: string; count: number }>();
  registered = false;
  counters = { shardsAccepted: 0, shardsDelivered: 0, receiptsAccepted: 0, claimsSent: 0, provesSent: 0 };
  /** Último error al enviar trabajo a la cadena (diagnóstico). */
  lastWorkError: string | null = null;
  private listeners = new Set<Listener>();

  constructor(private o: LightNodeOptions) {
    this.address = o.keys.address;
    this.work = new WorkBook(o.keys.address);
    const u = o.url ?? GATEWAYS;
    this.urls = typeof u === "string" ? [u] : [...u];
    this.store = o.store ?? new MemoryLightStore();
    this.maxShards = o.maxShards ?? 2_000;
    this.maxPerMailbox = o.maxPerMailbox ?? 500;
  }

  on(fn: Listener) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  stats(): LightNodeStats {
    let mailboxes = 0;
    for (const m of this.subs.values()) mailboxes += m.size ? 1 : 0;
    return {
      connected: this.up, registered: this.registered, height: this.head.height, epoch: this.snapshot?.epoch ?? null,
      shardsStored: this.store.count(), ...this.counters, mailboxes,
    };
  }

  private changed() {
    const st = this.stats();
    this.listeners.forEach((fn) => { try { fn(st); } catch { /* oyente roto */ } });
  }

  start() {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
    this.timers.push(setInterval(() => this.presence(), 5_000));
    this.timers.push(setInterval(() => this.ensureRegistered().catch(() => {}), 10_000));
    this.timers.push(setInterval(() => { this.store.prune(Date.now()); this.status(); }, 30_000));
  }

  stop() {
    this.stopped = true;
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    if (this.retry) clearTimeout(this.retry);
    this.retry = null;
    const ws = this.ws;
    this.ws = null;
    this.up = false;
    try { ws?.close(); } catch { /* nada */ }
    for (const [, c] of this.calls) { clearTimeout(c.timer); c.reject(new Error("Nodo ligero parado")); }
    this.calls.clear();
    this.subs.clear();
    this.changed();
  }

  // ---------------------------------------------------------------- conexión
  private connect() {
    if (this.stopped) return;
    const base = this.urls[this.urlIdx]!;
    const ws = (this.o.socket ?? DEFAULT_SOCKET)(base.includes("?") ? `${base}&role=node` : `${base}?role=node`);
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => {
      const ts = Date.now();
      this.raw({
        t: "hello", node: this.address, name: (this.o.name ?? "").slice(0, 40), version: this.o.version ?? String(PROTOCOL_VERSION),
        height: this.head.height, ts, sig: sign(this.o.keys.secret, helloChallenge(this.address, ts)), kind: "light",
      });
    };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      let f: any;
      try { f = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)); } catch { return; }
      if (f?.t === "welcome") { welcomed = true; this.up = true; this.backoff = 1_000; }
      try { this.onFrame(f); } catch (err) { console.warn("[velum-ligero]", err); }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.up = false;
      this.peers.clear();
      this.subs.clear();
      if (!welcomed && this.urls.length > 1) this.urlIdx = (this.urlIdx + 1) % this.urls.length;
      this.changed();
      if (!this.stopped) this.retry = setTimeout(() => this.connect(), (this.backoff = Math.min(this.backoff * 2, 30_000)));
    };
    ws.onerror = () => {};
  }

  private raw(obj: unknown) {
    if (this.ws && this.ws.readyState === 1) try { this.ws.send(JSON.stringify(obj)); } catch { /* cerrado */ }
  }

  private gossip(item: GossipItem) { this.raw({ t: "gossip", item }); }

  private onFrame(f: any) {
    switch (f?.t) {
      case "welcome":
        for (const p of f.peers ?? []) this.peers.set(p.node, p);
        this.changed();
        this.ensureRegistered().catch(() => {});
        this.refreshEpoch().catch(() => {});
        break;
      case "peer":
        if (f.op === "join") this.peers.set(f.peer.node, f.peer);
        else this.peers.delete(f.peer.node);
        break;
      case "head":
        if (typeof f.height === "number" && f.height >= this.head.height) {
          const newEpoch = this.snapshot && Math.floor(f.height / EPOCH_BLOCKS) > this.snapshot.epoch;
          this.head = { height: f.height, hash: String(f.hash), ts: Number(f.ts) || 0 };
          if (newEpoch || !this.snapshot) this.refreshEpoch().catch(() => {});
          this.doWork().catch(() => {});
        }
        break;
      case "epoch":
        if (f.snapshot) this.keepSnap(f.snapshot);
        break;
      case "gossip":
        this.onGossip(f.item);
        break;
      case "rpc":
        this.serve(String(f.from), String(f.id), f.method, f.params ?? {});
        break;
      case "direct":
        this.onDirect(String(f.from), f.data as DirectRpc);
        break;
      case "client_left":
        for (const m of this.subs.values()) m.delete(String(f.client));
        break;
    }
  }

  // ---------------------------------------------------------------- RPC hacia nodos completos (por `direct`)
  private fullPeers() {
    return [...this.peers.values()].filter((p) => p.kind !== "light").map((p) => p.node);
  }

  /** Llama a un nodo completo (al azar) por mensaje directo. */
  call(method: RpcMethod, params: unknown, node?: string): Promise<any> {
    const full = this.fullPeers();
    const target = node ?? full[Math.floor(Math.random() * full.length)];
    if (!target) return Promise.reject(new Error("Sin nodos completos a la vista"));
    const id = `l${Date.now().toString(36)}${(this.seq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new Error("El nodo no responde")); }, RPC_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      this.raw({ t: "direct", to: target, data: { kind: "rpc", id, method, params } satisfies DirectRpc });
    });
  }

  private onDirect(_from: string, d: DirectRpc) {
    if (!d || d.kind !== "rpc_res") return;
    const c = this.calls.get(d.id);
    if (!c) return;
    this.calls.delete(d.id);
    clearTimeout(c.timer);
    d.error ? c.reject(new Error(d.error)) : c.resolve(d.result);
  }

  private keepSnap(snap: EpochSnapshot) {
    this.snaps.set(snap.epoch, snap);
    if (this.snaps.size > 24) this.snaps.delete(Math.min(...this.snaps.keys()));
    if (!this.snapshot || snap.epoch >= this.snapshot.epoch) { this.snapshot = snap; this.changed(); }
  }

  /** Pide la foto del sorteo (la última o la de una época) a un nodo completo. */
  async refreshEpoch(epoch?: number): Promise<EpochSnapshot | null> {
    const info = await this.call("chain.epoch", epoch === undefined ? {} : { epoch });
    if (!info) return null;
    const { online: _o, ...snap } = info;
    this.keepSnap(snap);
    return snap;
  }

  private snapFor = (ep: number) => this.snaps.get(ep) ?? null;

  /** Apunta un recibo como hoja de trabajo (si este ligero es candidato del sorteo para algún papel). */
  private async noteWork(r: ReceiptV2) {
    if (r.ep !== undefined && !this.snaps.has(r.ep)) await this.refreshEpoch(r.ep).catch(() => null);
    this.work.add(r, this.head.height, this.snapFor);
  }

  /** v3 §4: reclama el trabajo de la época anterior y responde al muestreo, por RPC a un completo. */
  private async doWork() {
    if (!this.registered || !this.head.height) return;
    const sampleEp = Math.floor(this.head.height / EPOCH_BLOCKS);
    if (!this.snaps.has(sampleEp)) await this.refreshEpoch(sampleEp).catch(() => null);
    const actions = this.work.due(this.head.height, this.snapFor, (E) => this.claimed.get(E) ?? null);
    for (const a of actions) {
      const acc = await this.call("account.get", { address: this.address });
      const nonce = acc.nonce + acc.pending;
      const tx = a.kind === "claim"
        ? makeWorkClaim(this.o.keys.secret, this.address, nonce, { epoch: a.epoch, count: a.count, root: a.root })
        : makeWorkProve(this.o.keys.secret, this.address, nonce, { epoch: a.epoch, leaves: a.leaves, paths: a.paths });
      try {
        await this.call("tx.submit", { tx });
        if (a.kind === "claim") { this.claimed.set(a.epoch, { status: "pending", count: a.count }); this.counters.claimsSent++; }
        else { this.claimed.set(a.epoch, { status: "sent", count: a.leaves.length }); this.counters.provesSent++; }
      } catch (e) {
        this.lastWorkError = `${a.kind} ${a.epoch}: ${(e as Error).message}`; // se reintenta en el siguiente bloque
      }
    }
  }

  /** Alta en la cadena como nodo ligero (gratis). Repite hasta que entra en un bloque. */
  async ensureRegistered() {
    if (this.registered || !this.up || Date.now() - this.registering < 8_000) return;
    this.registering = Date.now();
    const info = await this.call("node.get", { address: this.address });
    const payout = this.o.payout ?? this.address;
    if (info && info.kind === "light" && info.payout === payout && info.name === (this.o.name ?? "").slice(0, 40)) {
      this.registered = true;
      this.changed();
      return;
    }
    const acc = await this.call("account.get", { address: this.address });
    const tx = makeRegister(this.o.keys.secret, this.address, acc.nonce + acc.pending, {
      name: (this.o.name ?? "").slice(0, 40), payout, version: this.o.version ?? String(PROTOCOL_VERSION), kind: "light",
    });
    await this.call("tx.submit", { tx }).catch((e) => { if (!/nonce/i.test(String(e?.message))) throw e; });
  }

  private presence() {
    if (!this.up || !this.registered || !this.head.height) return;
    const p = signObj(this.o.keys.secret, presenceBody(this.address, this.head.height, Date.now())) as Presence;
    this.gossip({ kind: "presence", presence: p });
  }

  private status() {
    if (!this.up) return;
    this.raw({ t: "status", height: this.head.height, hash: this.head.hash, mempool: 0, mailboxes: this.subs.size, stats: { ...this.counters, shardsStored: this.store.count() } });
  }

  // ---------------------------------------------------------------- trozos y recibos
  /** Guarda un trozo respetando topes (por buzón y total; si no cabe, se va el que antes caduca). */
  private keep(s: LightShard): boolean {
    if (this.seen.has(s.id) || this.store.get(s.id)) return false;
    if (this.store.countMailbox(s.mailbox) >= this.maxPerMailbox) return false;
    while (this.store.count() >= this.maxShards) if (!this.store.evictOldest()) break;
    if (!this.store.put(s)) return false;
    this.push(s);
    this.changed();
    return true;
  }

  private push(s: LightShard) {
    const subs = this.subs.get(s.mailbox);
    if (!subs) return;
    for (const [client, auth] of subs) if (auth === s.mbAuth) {
      this.raw({ t: "push", to: client, event: "shard", data: s });
      this.counters.shardsDelivered++;
    }
  }

  private forget(r: ReceiptV2): boolean {
    const s = this.store.get(r.shard);
    if (s && s.rh !== r.rh) return false;
    this.seen.add(r.shard);
    if (this.seen.size > 50_000) this.seen.clear();
    if (s) { this.store.delete(r.shard); this.changed(); }
    return true;
  }

  private onGossip(item: GossipItem) {
    if (!item || typeof item !== "object") return;
    if (item.kind === "shard") {
      if (typeof item.carrier === "string" && !shardProblem(item.shard)) this.keep({ ...item.shard, carrier: item.carrier });
    } else if (item.kind === "receipt") {
      if (item.receipt && checkReceiptProof(item.receipt)) {
        this.forget(item.receipt);
        if (item.receipt.carrier === this.address || item.receipt.courier === this.address) this.noteWork(item.receipt).catch(() => {});
      }
    }
  }

  private serve(client: string, id: string, method: string, params: any) {
    const reply = (result?: unknown, error?: string) => this.raw({ t: "rpc_res", to: client, id, ...(error ? { error } : { result }) });
    try {
      reply(this.handle(client, method, params));
    } catch (e) {
      reply(undefined, (e as Error).message);
    }
  }

  private handle(client: string, method: string, params: any): unknown {
    switch (method) {
      case "shard.put": {
        const shard = params.shard as Shard;
        const err = shardProblem(shard);
        if (err) throw new Error(err);
        const stored: LightShard = { ...shard, carrier: this.address };
        if (this.keep(stored)) this.counters.shardsAccepted++;
        this.gossip({ kind: "shard", shard, carrier: this.address });
        return { ok: true, carrier: this.address };
      }
      case "mailbox.open": {
        const list = Array.isArray(params.mailboxes) ? (params.mailboxes as MailboxOpen[]).slice(0, 16) : [];
        const shards: LightShard[] = [];
        const now = Date.now();
        for (const m of list) {
          if (!verifyOpenProof(m, now)) throw new Error("Prueba de buzón no válida");
          (this.subs.get(m.mailbox) ?? this.subs.set(m.mailbox, new Map()).get(m.mailbox)!).set(client, m.auth);
          shards.push(...this.store.list(m.mailbox, m.auth, now));
        }
        this.counters.shardsDelivered += shards.length;
        return { shards, courier: this.address };
      }
      case "receipt.submit": {
        const list = Array.isArray(params.receipts) ? (params.receipts as ReceiptV2[]).slice(0, 2_000) : [];
        let accepted = 0;
        for (const r of list) {
          if (!r || r.courier !== this.address || !checkReceiptProof(r) || !this.forget(r)) continue;
          accepted++;
          this.counters.receiptsAccepted++;
          this.noteWork(r).catch(() => {});
          this.gossip({ kind: "receipt", receipt: r });
        }
        return { accepted };
      }
      case "node.info":
        return { address: this.address, name: this.o.name ?? "", payout: this.o.payout ?? this.address, version: this.o.version ?? String(PROTOCOL_VERSION), height: this.head.height, peers: this.peers.size, tier: "bronce", earned: 0, uptime: 0, kind: "light" };
      case "chain.head":
        return { height: this.head.height, hash: this.head.hash, ts: this.head.ts, node: this.address };
      case "chain.epoch":
        return this.snapshot ? { ...this.snapshot, online: [this.address, ...this.peers.keys()] } : null;
      default:
        throw new Error(`Nodo ligero: «${method}» no está disponible`);
    }
  }
}

/** Cadena a la que pertenece este nodo ligero (para mostrar). */
export const LIGHT_CHAIN = CHAIN_ID;
