// Nodo Velum v2: consenso, red (puertas de entrada + pares directos), RPC para clientes y panel local.
import type { Server, ServerWebSocket } from "bun";
import {
  activeValidators, buildBlock, faucetKeyPair, helloChallenge, makeTransfer, presenceBody, proposeAfter, proposerRank,
  receiptId, sign, signObj, slotOf, tierFor, epochOf, txId, verify, isAddress, shardProblem, verifyOpenProof,
  checkReceiptProof, currentSnapshot, snapshotFor, makeRegister, balancesOf, bookOf, tradesOf, ordersOf, tokenInfo,
  tokenList, supplyInfo, difficulty, formatAmount, pairOf, feeContext, makeWorkClaim, makeWorkProve, WorkBook, nameInfo, nameOfAddress,
  CHAIN_ID, FAUCET_DRIP, UNIT, VEL, LIGHT_METHODS, PROTOCOL_VERSION, UPGRADE_NEEDED, HAS_FAUCET,
  delegationsOfNode, delegationsOfAddress,
  type Block, type GossipItem, type HubToNode, type KeyPair, type NodeHello, type PeerInfo, type Presence, type Receipt,
  type RpcMethod, type Shard, type Tx, type MailboxOpen, type DirectRpc, type EpochInfo,
} from "@velum/core";
import { Chain, type AddResult } from "./chain";
import { Store, type StoredShard } from "./store";
import { Mempool, PresencePool, ReceiptPool } from "./pools";
import { LruSet } from "./lru";
import { log } from "./log";
import { activeGateways, savePaused, type NodeConfig } from "./config";
import { dashboardHtml } from "./dashboard";
import { chainEndpoints, dnsSeedEndpoints } from "./discovery";
import { VERSION } from "./version";
import { useNativeVerifier } from "./native";

export { VERSION };

/** Lo único que el nodo dice de su software a la red: la versión de protocolo (ni binario, ni sistema, ni equipo). */
export const PUBLIC_VERSION = String(PROTOCOL_VERSION);
/** Pasarela USDT (opcional): el nodo reenvía `bridge.*` a este servicio. Sin él: «puente aún no abierto». */
const BRIDGE_URL = process.env.VELUM_BRIDGE_URL ?? "";
const BRIDGE_CLOSED = "puente aún no abierto";

const TICK_MS = 200;
const STATUS_MS = 5_000;
const PRESENCE_MS = 5_000;
const REGISTER_CHECK_MS = 3_000;
const STARTUP_GRACE_MS = 3_000;
const FAUCET_INTERVAL_MS = 3_600_000;
/** El grifo también da tokens de prueba para estrenar el mercado. */
const FAUCET_TOKEN = "tEUR";
const FAUCET_TOKEN_DRIP = 100 * 1_000_000; // 100 tEUR (6 decimales)
const MAX_PEX = 64;
const MAX_OUT_LINKS = 12;
const OPEN_RESULT_BYTES = 700_000;
// Antispam (por conexión de cliente) y cupos de almacenamiento.
const SHARD_PUT_RATE = 50; // por segundo
const SHARD_PUT_BURST = 200;
const MAX_SHARDS_PER_MAILBOX = 2_000;
const MAX_SHARDS_TOTAL = 200_000;
const MAX_CLIENT_FRAME = 1024 * 1024; // 1 MB por llamada RPC
const DIRECT_RPC_TIMEOUT_MS = 10_000;
/** Métodos que un nodo atiende por RPC directa de otro nodo (ligeros y reenvíos de clientes). */
const DIRECT_METHODS = new Set<string>([
  "chain.head", "chain.block", "chain.blocks", "chain.epoch", "account.get", "account.history", "account.balances", "account.orders",
  "tx.submit", "node.info", "node.get", "node.list", "stats", "token.info", "token.list", "market.book", "market.trades", "supply",
  "difficulty", "shard.put", "receipt.submit", "mailbox.open", "faucet", "chain.fees", "oracle", "claims", "name.info", "name.of",
]);

type WsLike = { send(data: string): unknown; close(code?: number, reason?: string): void };

/** Enlace directo con otro nodo (entrante o saliente). Habla tramas con la misma forma que la puerta. */
interface PeerLink {
  id: number;
  ws: WsLike;
  outgoing: boolean;
  url?: string;
  node?: string;
  name?: string;
  version?: string;
  endpoint?: string;
  height: number;
  hash?: string;
  since: number;
  ready: boolean;
}

type Source = { kind: "self" } | { kind: "hub"; node?: string } | { kind: "peer"; link: PeerLink };

interface WsData { role: "node" | "client"; key: string; link?: PeerLink }

class RpcError extends Error {}

export interface NodeOptions {
  dbFile?: string;
}

export class VelumNode {
  readonly me: string;
  readonly store: Store;
  readonly chain: Chain;
  readonly mempool = new Mempool();
  readonly receipts = new ReceiptPool();
  readonly presences = new PresencePool();
  private seen = new LruSet(50_000);
  private delivered = new LruSet(50_000);
  /** v3: hojas de trabajo (recibos en los que soy candidato del sorteo) → work.claim / work.prove. */
  readonly work: WorkBook;

  // Red
  private server: Server<WsData> | null = null;
  private hub: WebSocket | null = null;
  private hubUp = false;
  private hubWelcomed = false;
  private hubFailures = 0;
  private gwIdx = 0;
  private hubBackoff = 1_000;
  private hubTimer: ReturnType<typeof setTimeout> | null = null;
  private hubPeers = new Map<string, PeerInfo>();
  private links = new Map<number, PeerLink>();
  private linkSeq = 0;
  private dialers = new Map<string, { link?: PeerLink; backoff: number; nextAt: number; node?: string; self?: boolean }>();
  private pexUrls = new Set<string>();
  private discovered = new Set<string>();
  private lastDiscovery = 0;
  private peerHeights = new Map<string, { height: number; hash?: string; at: number }>();
  private syncInflight: { node: string; until: number } | null = null;
  private calls = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any }>();
  private callSeq = 0;

  // Clientes: "h:<id>" (vía puerta) o "l:<id>" (directos)
  private localClients = new Map<string, ServerWebSocket<WsData>>();
  private clientSeq = 0;
  /** buzón → cliente → clave de apertura (solo se empujan trozos con mbAuth == auth). */
  private subs = new Map<string, Map<string, string>>();
  private clientSubs = new Map<string, Set<string>>();
  private buckets = new Map<string, { tokens: number; at: number }>();

  // Consenso
  private lastProposedSlot = -1;
  private readySince = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private myRegisterAt = 0;
  private faucetMem = new Map<string, number>();

  // Contadores
  readonly startedAt = Date.now();
  private counters = { shardsRelayed: 0, shardsDelivered: 0, blocksProduced: 0, receiptsAccepted: 0, shardsRejected: 0, rateLimited: 0 };
  paused: boolean;
  /** Motivo por el que el nodo no participa aunque no esté en pausa (p. ej. versión por debajo del mínimo). */
  held: string | null = null;
  /** App de escritorio (apps/desktop): sirve /app y /api en este mismo servidor. La monta main.ts. */
  desktop: { handle(req: Request, ip?: string | null): Response | Promise<Response> | undefined } | null = null;

  constructor(public cfg: NodeConfig, public keys: KeyPair, public dir: string, opts: NodeOptions = {}) {
    this.me = keys.address;
    // Firmas ed25519 nativas (OpenSSL): ~30× más rápidas que noble; con caché, un bloque con 10.000 reclamaciones < 1 s.
    useNativeVerifier();
    this.work = new WorkBook(keys.address);
    this.store = new Store(dir, opts.dbFile);
    this.chain = new Chain(this.store);
    this.paused = cfg.paused;
  }

  private get offline() { return this.paused || !!this.held; }

  // =====================================================================
  // Arranque y parada
  // =====================================================================
  start() {
    this.listen();
    log.info(`nodo ${this.cfg.name} (${short(this.me)}) · ${CHAIN_ID} · altura ${this.chain.height} · panel http://localhost:${this.cfg.port}`);
    if (this.cfg.payout !== this.me) log.info(`cobra en ${short(this.cfg.payout)}`);
    this.timers.push(setInterval(() => this.safe(() => this.tick()), TICK_MS));
    this.timers.push(setInterval(() => this.safe(() => this.slowTick()), 1_000));
    this.timers.push(setInterval(() => this.safe(() => this.sendStatus()), STATUS_MS));
    this.timers.push(setInterval(() => this.safe(() => this.sendPresence()), PRESENCE_MS));
    this.timers.push(setInterval(() => this.safe(() => this.checkRegistration()), REGISTER_CHECK_MS));
    this.timers.push(setInterval(() => this.safe(() => this.housekeeping()), 60_000));
    if (this.paused) log.info("aportación en pausa: el nodo no se conecta a la red (actívala en el panel)");
    else this.connectNetwork();
  }

  async stop() {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
    this.disconnectNetwork();
    this.server?.stop(true);
    this.store.close();
  }

  pause() {
    if (this.paused) return;
    this.paused = true;
    savePaused(this.dir, true);
    this.disconnectNetwork();
    log.info("aportación en pausa: desconectado de la red");
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    savePaused(this.dir, false);
    this.readySince = Date.now();
    if (!this.held) this.connectNetwork();
    log.info("aportación encendida: conectando con la red");
  }

  /** Retiene el nodo fuera de la red sin tocar la configuración (versión por debajo del mínimo…). */
  hold(reason: string | null) {
    if (reason === this.held) return;
    const was = this.offline;
    this.held = reason;
    if (reason) { log.error(`nodo retenido: ${reason}`); this.disconnectNetwork(); }
    else if (was && !this.paused) { this.readySince = Date.now(); this.connectNetwork(); }
  }

  private safe(fn: () => void) {
    try { fn(); } catch (e) { log.error((e as Error)?.stack ?? e); }
  }

  private connectNetwork() {
    if (activeGateways(this.cfg).length) this.connectHub();
    this.dialPeers();
    this.checkRegistration();
  }

  private disconnectNetwork() {
    if (this.hubTimer) clearTimeout(this.hubTimer);
    this.hubTimer = null;
    const h = this.hub;
    this.hub = null;
    this.hubUp = false;
    try { h?.close(); } catch {}
    this.hubPeers.clear();
    for (const l of this.links.values()) try { l.ws.close(1001, "pausa"); } catch {}
    this.links.clear();
    for (const d of this.dialers.values()) d.link = undefined;
    for (const [k, ws] of this.localClients) { try { ws.close(1001, "pausa"); } catch {} this.dropClient(k); }
    for (const k of [...this.clientSubs.keys()]) this.dropClient(k);
    this.peerHeights.clear();
    this.syncInflight = null;
  }

  // =====================================================================
  // Servidor local: panel, estado, pares y clientes directos
  // =====================================================================
  private listen() {
    const node = this;
    this.server = Bun.serve<WsData>({
      port: this.cfg.port,
      hostname: process.env.VELUM_HOST || "0.0.0.0",
      fetch(req, server) {
        const desk = node.desktop?.handle(req, server.requestIP(req)?.address);
        if (desk) return desk;
        const url = new URL(req.url);
        if (url.pathname === "/ws") {
          if (node.offline) return new Response("Aportación en pausa", { status: 503 });
          const role = url.searchParams.get("role") === "node" ? "node" : "client";
          const key = role === "client" ? `l:${++node.clientSeq}` : `p:${++node.linkSeq}`;
          if (server.upgrade(req, { data: { role, key } })) return undefined;
          return new Response("Se esperaba WebSocket", { status: 400 });
        }
        if (url.pathname === "/" && req.method === "GET")
          return new Response(dashboardHtml(), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
        if (url.pathname === "/status" && req.method === "GET") {
          // La versión del binario solo se enseña a este mismo ordenador.
          const local = isLocal(server.requestIP(req)?.address, req.headers.get("origin"), node.cfg.port);
          return Response.json({ ...node.status(), ...(local ? { build: VERSION } : {}) }, { headers: { "cache-control": "no-store", "access-control-allow-origin": "*" } });
        }
        if ((url.pathname === "/pause" || url.pathname === "/resume") && req.method === "POST") {
          if (!isLocal(server.requestIP(req)?.address, req.headers.get("origin"), node.cfg.port)) return new Response("Solo desde este ordenador", { status: 403 });
          url.pathname === "/pause" ? node.pause() : node.resume();
          return Response.json(node.status());
        }
        if (url.pathname === "/favicon.ico") return new Response(null, { status: 204 });
        return new Response("No encontrado", { status: 404 });
      },
      websocket: {
        maxPayloadLength: 16 * 1024 * 1024,
        idleTimeout: 120,
        open(ws) {
          if (ws.data.role === "client") {
            node.localClients.set(ws.data.key, ws);
            ws.send(JSON.stringify({ t: "welcome", client: ws.data.key, nodes: [node.selfInfo()] }));
          } else {
            const link: PeerLink = { id: node.linkSeq++, ws, outgoing: false, height: 0, since: Date.now(), ready: false };
            ws.data.link = link;
            node.links.set(link.id, link);
            node.sendHello(link);
          }
        },
        message(ws, msg) {
          if (ws.data.role === "client" && (typeof msg === "string" ? msg.length : msg.byteLength) > MAX_CLIENT_FRAME) {
            try { ws.send(JSON.stringify({ t: "rpc_res", id: "", error: "Llamada demasiado grande" })); } catch {}
            return;
          }
          let f: any;
          try { f = JSON.parse(typeof msg === "string" ? msg : new TextDecoder().decode(msg)); } catch { return; }
          node.safe(() => {
            if (ws.data.role === "client") node.onLocalClientFrame(ws, f);
            else if (ws.data.link) node.onPeerFrame(ws.data.link, f);
          });
        },
        close(ws, code) {
          if (ws.data.role === "client") node.dropClient(ws.data.key);
          else if (ws.data.link) node.onLinkClosed(ws.data.link, code);
        },
      },
    });
  }

  // =====================================================================
  // Puertas de entrada (lista con relevo)
  // =====================================================================
  get gateway(): string | null {
    const gws = activeGateways(this.cfg);
    return gws.length ? gws[this.gwIdx % gws.length]! : null;
  }

  private connectHub() {
    if (this.offline || this.hub) return;
    const g = this.gateway;
    if (!g) return;
    const url = g.includes("?") ? `${g}&role=node` : `${g}?role=node`;
    let ws: WebSocket;
    try { ws = new WebSocket(url); } catch (e) { log.warn("puerta de entrada:", (e as Error).message); return this.scheduleHub(true); }
    this.hub = ws;
    this.hubWelcomed = false;
    ws.onopen = () => {
      this.hubUp = true;
      ws.send(JSON.stringify(this.hello()));
    };
    ws.onmessage = (e) => {
      const raw = typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
      let f: HubToNode;
      try { f = JSON.parse(raw); } catch { return; }
      if (f.t === "welcome" && !this.hubWelcomed) {
        this.hubWelcomed = true;
        this.hubFailures = 0;
        this.hubBackoff = 1_000;
        log.info(`conectado a la puerta de entrada ${g}`);
      }
      if (f.t === "rpc" && raw.length > MAX_CLIENT_FRAME) {
        this.hubSend({ t: "rpc_res", to: f.from, id: f.id, error: "Llamada demasiado grande" });
        return;
      }
      this.safe(() => this.onHubFrame(f));
    };
    ws.onclose = () => {
      if (this.hub !== ws) return;
      const was = this.hubWelcomed;
      this.hub = null;
      this.hubUp = false;
      this.hubPeers.clear();
      for (const k of [...this.clientSubs.keys()]) if (k.startsWith("h:")) this.dropClient(k);
      if (was) log.warn(`se perdió la puerta de entrada ${g}; reintentando`);
      this.scheduleHub(!was);
    };
    ws.onerror = () => {};
  }

  /** Si la puerta no llegó a responder, prueba la siguiente de la lista. Si caen todas, tira de vecinos directos. */
  private scheduleHub(failed: boolean) {
    if (this.offline || this.hubTimer) return;
    const gws = activeGateways(this.cfg);
    if (failed) {
      this.hubFailures++;
      if (gws.length > 1) {
        this.gwIdx = (this.gwIdx + 1) % gws.length;
        log.debug(`pruebo la siguiente puerta: ${this.gateway}`);
      }
      if (this.hubFailures >= gws.length) this.discover(true);
    }
    const wait = this.hubBackoff;
    this.hubBackoff = Math.min(this.hubBackoff * 2, 30_000);
    this.hubTimer = setTimeout(() => { this.hubTimer = null; this.connectHub(); }, wait + Math.random() * 500);
  }

  private hubSend(obj: unknown) {
    if (this.hub && this.hubUp) try { this.hub.send(JSON.stringify(obj)); } catch {}
  }

  private onHubFrame(f: HubToNode) {
    switch (f.t) {
      case "welcome":
        this.hubPeers.clear();
        for (const p of f.peers ?? []) if (p.node !== this.me) { this.hubPeers.set(p.node, p); if (p.kind !== "light") this.notePeerHeight(p.node, p.height); }
        log.debug(`puerta: ${this.hubPeers.size} nodos más`);
        break;
      case "peer":
        if (f.peer.node === this.me) break;
        if (f.op === "join") { this.hubPeers.set(f.peer.node, f.peer); if (f.peer.kind !== "light") this.notePeerHeight(f.peer.node, f.peer.height); }
        else { this.hubPeers.delete(f.peer.node); this.peerHeights.delete(f.peer.node); }
        break;
      case "gossip":
        this.onGossip(f.item, { kind: "hub", node: f.from });
        break;
      case "rpc":
        this.runRpc(`h:${f.from}`, f.method, f.params).then(
          (result) => this.hubSend({ t: "rpc_res", to: f.from, id: f.id, result }),
          (e) => this.hubSend({ t: "rpc_res", to: f.from, id: f.id, error: errMsg(e) }),
        );
        break;
      case "direct":
        this.onDirect(f.from, f.data);
        break;
      case "client_left":
        this.dropClient(`h:${f.client}`);
        break;
    }
  }

  // =====================================================================
  // Pares directos y descubrimiento
  // =====================================================================
  private hello(): NodeHello {
    const ts = Date.now();
    return {
      t: "hello", node: this.me, name: this.cfg.name, version: PUBLIC_VERSION, height: this.chain.height, ts,
      sig: sign(this.keys.secret, helloChallenge(this.me, ts)), kind: "full",
      ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint } : {}),
    };
  }

  private sendHello(link: PeerLink) { this.linkSend(link, this.hello()); }

  private linkSend(link: PeerLink, obj: unknown) {
    try { link.ws.send(JSON.stringify(obj)); } catch {}
  }

  /**
   * Candidatos para conectar: los configurados, los del intercambio de vecinos y, si las puertas fallan
   * o hay pocos enlaces, los `endpoint` de la cadena y las semillas DNS.
   */
  private discover(force = false) {
    const ready = this.readyLinks().length;
    if (!force && (this.hubWelcomed || ready >= 3)) return;
    if (Date.now() - this.lastDiscovery < (force ? 5_000 : 60_000)) return;
    this.lastDiscovery = Date.now();
    for (const u of chainEndpoints(this.chain.state, this.me)) if (u !== this.cfg.endpoint) this.discovered.add(u);
    if (this.cfg.dnsSeeds.length) {
      dnsSeedEndpoints(this.cfg.dnsSeeds).then((list) => {
        for (const u of list) if (u !== this.cfg.endpoint) this.discovered.add(u);
        if (list.length) log.debug(`semillas DNS: ${list.length} direcciones`);
      });
    }
    if (this.discovered.size) log.debug(`descubrimiento: ${this.discovered.size} direcciones de vecinos`);
  }

  private dialPeers() {
    if (this.offline) return;
    this.discover();
    const urls = [...new Set([...this.cfg.peers, ...this.pexUrls, ...this.discovered])];
    let out = [...this.links.values()].filter((l) => l.outgoing).length;
    const now = Date.now();
    for (const url of urls) {
      if (out >= MAX_OUT_LINKS) break;
      if (url === this.cfg.endpoint) continue;
      const d = this.dialers.get(url) ?? this.dialers.set(url, { backoff: 1_000, nextAt: 0 }).get(url)!;
      if (d.self || d.link || now < d.nextAt) continue;
      if (d.node && this.linkTo(d.node)) continue; // ya conectados por otro camino
      d.nextAt = now + d.backoff;
      d.backoff = Math.min(d.backoff * 2, 30_000);
      this.dial(url, d);
      out++;
    }
  }

  private dial(url: string, d: { link?: PeerLink; backoff: number; nextAt: number; node?: string }) {
    const u = url.includes("?") ? `${url}&role=node` : `${url}?role=node`;
    let ws: WebSocket;
    try { ws = new WebSocket(u); } catch { return; }
    const link: PeerLink = { id: this.linkSeq++, ws, outgoing: true, url, height: 0, since: Date.now(), ready: false };
    d.link = link;
    this.links.set(link.id, link);
    ws.onopen = () => this.sendHello(link);
    ws.onmessage = (e) => {
      let f: any;
      try { f = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)); } catch { return; }
      this.safe(() => this.onPeerFrame(link, f));
    };
    ws.onclose = (e) => { if (d.link === link) d.link = undefined; this.onLinkClosed(link, e.code); };
    ws.onerror = () => {};
  }

  private onLinkClosed(link: PeerLink, code?: number) {
    if (!this.links.delete(link.id)) return;
    if (link.ready && link.node) {
      // 4000 = enlace duplicado que se cierra a propósito; sigue habiendo otro con ese nodo.
      (code === 4000 ? log.debug : log.info)(`par desconectado: ${link.name ?? short(link.node)}`);
      if (!this.linkTo(link.node) && !this.hubPeers.has(link.node)) this.peerHeights.delete(link.node);
    }
  }

  private linkTo(node: string): PeerLink | undefined {
    for (const l of this.links.values()) if (l.ready && l.node === node) return l;
    return undefined;
  }

  private readyLinks() { return [...this.links.values()].filter((l) => l.ready); }

  private onPeerFrame(link: PeerLink, f: any) {
    if (!link.ready) {
      if (f?.t !== "hello") return;
      const h = f as NodeHello;
      if (!isAddress(h.node) || Math.abs(Date.now() - h.ts) > 5 * 60_000 || !verify(h.node, helloChallenge(h.node, h.ts), h.sig)) {
        log.debug("saludo de par no válido");
        return link.ws.close(4001, "saludo no válido");
      }
      if (h.kind === "light") return link.ws.close(4004, "los nodos ligeros entran por la puerta de entrada");
      if (link.outgoing && link.url) {
        const d = this.dialers.get(link.url);
        if (d) { d.node = h.node; if (h.node === this.me) d.self = true; }
      }
      if (h.node === this.me) return link.ws.close(4002, "soy yo");
      const existing = this.linkTo(h.node);
      const replacing = !!existing;
      if (existing) {
        // Dos enlaces con el mismo nodo: ambos lados se quedan con el que abrió la dirección menor.
        const dialerOf = (l: PeerLink) => (l.outgoing ? this.me : h.node);
        const keepNew = dialerOf(link) < dialerOf(existing);
        if (!keepNew) return link.ws.close(4000, "duplicado");
        existing.ws.close(4000, "duplicado");
        this.links.delete(existing.id);
      }
      link.node = h.node;
      link.name = h.name;
      link.version = h.version;
      link.endpoint = h.endpoint ?? (link.outgoing ? link.url : undefined);
      link.height = h.height;
      link.ready = true;
      if (link.outgoing && link.url) { const d = this.dialers.get(link.url); if (d) d.backoff = 1_000; }
      this.notePeerHeight(h.node, h.height);
      (replacing ? log.debug : log.info)(`par conectado: ${h.name} (${short(h.node)}) · altura ${h.height}`);
      this.sendPex();
      // Le contamos lo que tenemos pendiente para que no se pierda nada al entrar.
      for (const t of this.mempool.all()) this.linkSend(link, { t: "gossip", item: { kind: "tx", tx: t } });
      return;
    }
    switch (f?.t) {
      case "gossip":
        if (f.item) this.onGossip(f.item, { kind: "peer", link });
        break;
      case "direct":
        this.onDirect(link.node!, f.data);
        break;
      case "status":
        if (typeof f.height === "number") { link.height = f.height; link.hash = f.hash; this.notePeerHeight(link.node!, f.height, f.hash); }
        break;
      case "peers":
        if (Array.isArray(f.urls)) for (const u of f.urls.slice(0, MAX_PEX)) {
          if (typeof u !== "string" || !/^wss?:\/\/[^\s]+$/.test(u) || u.length > 200 || u === this.cfg.endpoint || this.cfg.peers.includes(u)) continue;
          if (this.pexUrls.size < MAX_PEX) this.pexUrls.add(u);
        }
        break;
    }
  }

  /** Intercambio de vecinos (PEX): cada nodo cuenta a los demás dónde encontrar a los que conoce (y los de la cadena). */
  private sendPex() {
    const ready = this.readyLinks();
    const urls = new Set(ready.map((l) => l.endpoint).filter((u): u is string => !!u));
    if (this.cfg.endpoint) urls.add(this.cfg.endpoint);
    for (const u of chainEndpoints(this.chain.state, this.me, 16)) urls.add(u);
    for (const l of ready) this.linkSend(l, { t: "peers", urls: [...urls].filter((u) => u !== l.endpoint).slice(0, MAX_PEX) });
  }

  private sendDirect(node: string, data: unknown) {
    const l = this.linkTo(node);
    if (l) this.linkSend(l, { t: "direct", data });
    else this.hubSend({ t: "direct", to: node, data });
  }

  /** RPC a otro nodo por mensaje directo (enlace o puerta). */
  callNode(node: string, method: RpcMethod, params: unknown): Promise<any> {
    if (!this.linkTo(node) && !this.hubPeers.has(node)) return Promise.reject(new RpcError("Ese nodo no está conectado ahora"));
    const id = `n${Date.now().toString(36)}${(this.callSeq++).toString(36)}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.calls.delete(id); reject(new RpcError("El nodo no responde")); }, DIRECT_RPC_TIMEOUT_MS);
      this.calls.set(id, { resolve, reject, timer });
      this.sendDirect(node, { kind: "rpc", id, method, params } satisfies DirectRpc);
    });
  }

  // =====================================================================
  // Rumor (gossip)
  // =====================================================================
  private broadcast(item: GossipItem, src: Source) {
    const frame = JSON.stringify({ t: "gossip", item });
    for (const l of this.links.values()) {
      if (!l.ready) continue;
      if (src.kind === "peer" && src.link === l) continue;
      if (src.kind === "hub" && src.node && l.node === src.node) continue;
      try { l.ws.send(frame); } catch {}
    }
    if (src.kind !== "hub" && this.hub && this.hubUp) try { this.hub.send(frame); } catch {}
  }

  private itemId(item: GossipItem): string | null {
    try {
      switch (item.kind) {
        case "block": return "b:" + item.block.hash;
        case "tx": return "t:" + txId(item.tx);
        case "shard": return "s:" + item.shard.id;
        case "receipt": return "r:" + receiptId(item.receipt);
        case "presence": return `p:${item.presence.node}:${item.presence.ts}`;
      }
    } catch {}
    return null;
  }

  private srcNode(src: Source): string | undefined {
    return src.kind === "peer" ? src.link.node : src.kind === "hub" ? src.node : undefined;
  }

  onGossip(item: GossipItem, src: Source) {
    if (this.offline || !item || typeof item !== "object") return;
    const id = this.itemId(item);
    if (!id || !this.seen.add(id)) return;
    let relay = false;
    switch (item.kind) {
      case "block": {
        const from = this.srcNode(src);
        if (from) this.notePeerHeight(from, item.block?.header?.height ?? 0, item.block?.hash);
        const r = this.chain.add(item.block);
        if (r.status === "head") { this.afterHead(r); relay = true; }
        else if (r.status === "side") relay = true;
        else if (r.status === "orphan") {
          this.seen.delete(id);
          if (from) this.requestBlocks(from, Math.max(1, Math.min(this.chain.height + 1, item.block.header.height - 32)), item.block.header.height);
        } else if (r.status === "invalid") this.onInvalidBlock(item.block?.header?.height, r.error);
        break;
      }
      case "tx": {
        const r = this.mempool.add(item.tx, this.chain.state);
        relay = "id" in r;
        if (!relay) log.debug(`transacción rechazada: ${(r as { error: string }).error}`);
        break;
      }
      case "shard": {
        if (!isAddress(item.carrier) || shardProblem(item.shard)) { this.counters.shardsRejected++; break; }
        relay = true;
        this.keepShard({ ...item.shard, carrier: item.carrier });
        break;
      }
      case "receipt": {
        if (ReceiptPool.check(item.receipt)) break;
        relay = true;
        this.receipts.add(item.receipt);
        this.markDelivered(item.receipt);
        this.noteWork(item.receipt);
        break;
      }
      case "presence": {
        relay = this.presences.add(item.presence);
        break;
      }
    }
    if (relay) this.broadcast(item, src);
  }

  /** Guarda un trozo respetando cupos (por buzón y total, desalojando los que antes caducan) y lo empuja. */
  private keepShard(s: StoredShard): boolean {
    if (this.delivered.has(s.id)) return false;
    if (this.store.countMailbox(s.mailbox) >= MAX_SHARDS_PER_MAILBOX) { this.counters.shardsRejected++; return false; }
    if (this.store.shardCount() >= MAX_SHARDS_TOTAL) this.store.evictOldest(Math.ceil(MAX_SHARDS_TOTAL / 100));
    if (!this.store.putShard(s)) return false;
    this.counters.shardsRelayed++;
    this.pushToMailbox(s);
    return true;
  }

  /** Recibo válido visto: el trozo se destruye en este nodo (y el recibo corre por la red para que lo hagan todos). */
  private markDelivered(r: Receipt) {
    const s = this.store.getShard(r.shard);
    if (s && s.rh !== r.rh) return;
    this.delivered.add(r.shard);
    this.store.deleteShard(r.shard);
  }

  // =====================================================================
  // Sincronización de bloques
  // =====================================================================
  private notePeerHeight(node: string, height: number, hash?: string) {
    if (!node || typeof height !== "number") return;
    const cur = this.peerHeights.get(node);
    if (!cur || height >= cur.height || Date.now() - cur.at > 15_000) this.peerHeights.set(node, { height, hash, at: Date.now() });
  }

  private bestPeer(): { node: string; height: number } | null {
    let best: { node: string; height: number } | null = null;
    const now = Date.now();
    for (const [node, p] of this.peerHeights) {
      if (now - p.at > 30_000) continue;
      if (!this.linkTo(node) && !this.hubPeers.has(node)) continue;
      if (this.hubPeers.get(node)?.kind === "light") continue;
      if (!best || p.height > best.height) best = { node, height: p.height };
    }
    return best;
  }

  private requestBlocks(node: string, from: number, to: number) {
    if (this.syncInflight && this.syncInflight.node === node && Date.now() < this.syncInflight.until) return;
    this.syncInflight = { node, until: Date.now() + 4_000 };
    log.debug(`pido bloques ${from}–${to} a ${short(node)}`);
    this.sendDirect(node, { kind: "getBlocks", from, to });
  }

  private onDirect(from: string, data: any) {
    if (this.offline || !data || typeof data !== "object") return;
    if (data.kind === "rpc" && typeof data.id === "string") {
      const reply = (r: { result?: unknown; error?: string }) => this.sendDirect(from, { kind: "rpc_res", id: data.id, ...r } satisfies DirectRpc);
      if (!DIRECT_METHODS.has(data.method)) return reply({ error: `Método no disponible entre nodos: ${String(data.method)}` });
      this.runRpc(`d:${from}`, data.method, data.params).then((result) => reply({ result }), (e) => reply({ error: errMsg(e) }));
      return;
    }
    if (data.kind === "rpc_res" && typeof data.id === "string") {
      const c = this.calls.get(data.id);
      if (!c) return;
      this.calls.delete(data.id);
      clearTimeout(c.timer);
      data.error ? c.reject(new RpcError(data.error)) : c.resolve(data.result);
      return;
    }
    if (data.kind === "getBlocks") {
      const blocks = this.chain.range(Number(data.from), Number(data.to));
      this.sendDirect(from, { kind: "blocks", blocks, head: this.chain.height });
    } else if (data.kind === "blocks" && Array.isArray(data.blocks)) {
      if (this.syncInflight?.node === from) this.syncInflight = null;
      if (typeof data.head === "number") this.notePeerHeight(from, data.head);
      const blocks = data.blocks as Block[];
      if (!blocks.length) return;
      let firstOrphan = false;
      let applied = 0;
      for (const [i, b] of blocks.entries()) {
        const r = this.chain.add(b);
        if (i === 0 && r.status === "orphan") firstOrphan = true;
        if (r.status === "head") { this.afterHead(r, false); applied++; }
        if (r.status === "invalid") { this.onInvalidBlock(b?.header?.height, r.error, from); break; }
      }
      const first = blocks[0]!.header.height;
      if (firstOrphan && first > 1) {
        // Venimos de otra rama: hay que ir más atrás para encontrar el punto común.
        const back = Math.max(1, first - 64);
        this.requestBlocks(from, back, first - 1);
      } else if (applied > 0 && typeof data.head === "number" && data.head > this.chain.height) {
        this.requestBlocks(from, this.chain.height + 1, data.head);
      }
    }
  }

  private maybeSync() {
    const best = this.bestPeer();
    if (best && best.height > this.chain.height) this.requestBlocks(best.node, this.chain.height + 1, best.height);
  }

  /** Listo para producir: no en pausa, tras un rato para conocer a los pares, y al día con ellos. */
  isReady(): boolean {
    if (this.offline) return false;
    if (Date.now() - this.readySince < STARTUP_GRACE_MS) return false;
    const best = this.bestPeer();
    return !best || best.height <= this.chain.height + 2;
  }

  // =====================================================================
  // Consenso
  // =====================================================================
  private tick() {
    if (this.offline) return;
    this.tryPropose();
  }

  private slowTick() {
    if (this.offline) return;
    this.maybeSync();
    this.dialPeers();
  }

  tryPropose() {
    if (!this.isReady()) return;
    const now = Date.now();
    const slot = slotOf(now);
    if (slot <= this.lastProposedSlot || this.chain.headSlot >= slot) return;
    const s = this.chain.state;
    const set = activeValidators(s);
    if (set.length > 0 && !s.nodes[this.me]) return;
    const rank = proposerRank(s, slot, this.me);
    if (now < proposeAfter(slot, rank)) return;
    const ts = Math.max(now, s.ts + 1);
    if (slotOf(ts) !== slot) return;
    this.lastProposedSlot = slot;
    const { block } = buildBlock(s, {
      proposer: this.me, ts,
      txs: this.mempool.select(s),
      receipts: [], // v3: el trabajo va en work.claim / work.prove
      presence: this.presences.select(s, ts),
    });
    const signed: Block = { ...block, sig: sign(this.keys.secret, block.hash) };
    const r = this.chain.add(signed);
    if (r.status !== "head") { log.debug(`mi bloque no entró: ${r.status}${"error" in r ? " " + r.error : ""}`); return; }
    this.counters.blocksProduced++;
    this.seen.add("b:" + signed.hash);
    this.afterHead(r);
    this.broadcast({ kind: "block", block: signed }, { kind: "self" });
  }

  private afterHead(r: Extract<AddResult, { status: "head" }>, verbose = true) {
    const s = this.chain.state;
    if (r.reorg) {
      log.info(`reorganización: ${r.reorg.depth} bloque(s) sustituidos; cabeza #${s.height}`);
      for (const t of r.reorg.droppedTxs) this.mempool.add(t, s);
      for (const rc of r.reorg.droppedReceipts) this.receipts.add(rc);
    }
    for (const b of r.extended) {
      this.presences.prune(b.presence);
      for (const rc of b.receipts) this.markDelivered(rc);
      if (verbose) this.logBlock(b);
    }
    this.mempool.prune(s);
    this.receipts.prune(s);
    this.doWork();
  }

  /** Apunta un recibo en el libro de trabajo si este nodo es candidato del sorteo para algún papel. */
  private noteWork(r: Receipt) {
    const s = this.chain.state;
    this.work.add(r, s.height, (ep) => snapshotFor(s, ep));
  }

  /** Envía las reclamaciones y pruebas de trabajo que tocan con la cabeza actual (v3 §4). */
  private doWork() {
    const s = this.chain.state;
    if (!s.nodes[this.me]) return;
    const actions = this.work.due(s.height, (ep) => snapshotFor(s, ep), (E) => {
      const c = (s as any).claims?.[String(E)]?.[this.me];
      return c ? { status: c.status, count: c.count } : null;
    });
    for (const a of actions) {
      const nonce = (s.accounts[this.me]?.nonce ?? 0) + this.mempool.pendingFrom(this.me).length;
      const tx = a.kind === "claim"
        ? makeWorkClaim(this.keys.secret, this.me, nonce, { epoch: a.epoch, count: a.count, root: a.root })
        : makeWorkProve(this.keys.secret, this.me, nonce, { epoch: a.epoch, leaves: a.leaves, paths: a.paths });
      const r = this.mempool.add(tx, s);
      if ("error" in r) { log.debug(`trabajo ${a.kind} época ${a.epoch}: ${r.error}`); continue; }
      this.seen.add("t:" + r.id);
      this.broadcast({ kind: "tx", tx }, { kind: "self" });
      log.info(a.kind === "claim" ? `reclamo el trabajo de mis puentes en la época ${a.epoch}: ${a.count} entregas` : `pruebo ${a.leaves.length} entregas de la época ${a.epoch} (muestreo)`);
    }
  }

  private logBlock(b: Block) {
    const st = this.chain.state;
    const who = b.header.proposer === this.me ? "este nodo" : (st.nodes[b.header.proposer]?.name ?? short(b.header.proposer));
    const extra: string[] = [];
    if (b.txs.length) extra.push(`${b.txs.length} tx`);
    if (b.receipts.length) extra.push(`${b.receipts.length} entregas`);
    const line = `bloque #${b.header.height} por ${who}${extra.length ? " · " + extra.join(" · ") : ""}`;
    // Los bloques vacíos solo se ven en modo debug (uno cada 2 s llenaría el registro).
    if (extra.length || log.isDebug) log.info(line);
    for (const t of b.txs) {
      switch (t.type) {
        case "transfer": log.info(`  pago ${formatAmount(t.token ?? VEL, t.amount, st.tokens[t.token ?? ""]?.decimals ?? 6, 3)} ${short(t.from)} → ${short(t.to)}`); break;
        case "register": log.info(`  alta de nodo ${t.kind === "light" ? "ligero" : "completo"}: ${t.name} (${short(t.from)})`); break;
        case "token.create": log.info(`  token nuevo ${t.symbol} («${t.name}») por ${short(t.from)}`); break;
        case "token.mint": log.info(`  emisión de ${t.symbol} para ${short(t.to)}`); break;
        case "pool.fund": log.info(`  bolsa de ${t.token} para nodos durante ${t.epochs} épocas`); break;
        case "order.place": log.info(`  orden ${t.side === "buy" ? "de compra" : "de venta"} en ${t.pair}`); break;
        case "order.cancel": log.info(`  orden cancelada ${t.id}`); break;
        case "work.claim": if (t.from === this.me) log.info(`  mi reclamación de la época ${t.epoch} entró (${t.count} entregas)`); break;
        case "work.prove": {
          if (t.from !== this.me) break;
          const c = (st as any).claims?.[String(t.epoch)]?.[this.me];
          log.info(`  mi prueba de la época ${t.epoch}: ${c?.status === "proved" ? "aceptada" : "NULA" + (c?.reason ? " · " + c.reason : "")}`);
          break;
        }
        case "device.attest": {
          // Modo soft (testnet): se acepta siempre y se deja constancia de si Apple la avala.
          const d = st.devices[t.keyId];
          log.info(`  atestación de dispositivo ${d?.verified ? "verificada" : "NO verificada (modo soft: se acepta)"}${d?.reason ? " · " + d.reason : ""}`);
          break;
        }
      }
    }
    if (b.rewards.length) {
      const total = b.rewards.reduce((a, x) => a + x.amount, 0);
      if (!extra.length && !log.isDebug) log.info(line);
      log.info(`  cierre de época ${epochOf(b.header.height) - 1}: ${formatVel(total)} descubiertos por ${b.rewards.length} nodo(s)`);
      const mine = b.rewards.find((x) => x.node === this.me);
      if (mine) log.info(`  descubierto por este nodo: +${formatVel(mine.amount)} (nivel ${mine.tier}, ${mine.shards} créditos)`);
    }
    for (const tr of b.tokenRewards ?? []) if (tr.node === this.me) log.info(`  bolsa ${tr.token}: +${tr.amount} unidades para mí`);
  }

  private sendPresence() {
    if (!this.isReady() || !this.chain.state.nodes[this.me]) return;
    const p = signObj(this.keys.secret, presenceBody(this.me, this.chain.height, Date.now())) as Presence;
    this.presences.add(p);
    this.seen.add(`p:${p.node}:${p.ts}`);
    this.broadcast({ kind: "presence", presence: p }, { kind: "self" });
  }

  /** Se da de alta (o actualiza nombre/cartera) hasta que su registro entra en un bloque. */
  private checkRegistration() {
    if (this.offline) return;
    const s = this.chain.state;
    const info = s.nodes[this.me];
    const wanted = { name: this.cfg.name, payout: this.cfg.payout, endpoint: this.cfg.endpoint };
    if (info && info.kind === "full" && info.name === wanted.name && info.payout === wanted.payout && (info.endpoint ?? undefined) === (wanted.endpoint ?? undefined)) return;
    const mine = this.mempool.pendingFrom(this.me).find((t) => t.type === "register");
    if (mine) {
      if (Date.now() - this.myRegisterAt > 10_000) {
        this.myRegisterAt = Date.now();
        this.broadcast({ kind: "tx", tx: mine }, { kind: "self" });
      }
      return;
    }
    const nonce = (s.accounts[this.me]?.nonce ?? 0) + this.mempool.pendingFrom(this.me).length;
    const tx = makeRegister(this.keys.secret, this.me, nonce, { name: wanted.name, payout: wanted.payout, endpoint: wanted.endpoint, version: PUBLIC_VERSION, kind: "full" });
    const r = this.mempool.add(tx, s);
    if ("error" in r) { log.debug(`registro: ${r.error}`); return; }
    this.myRegisterAt = Date.now();
    this.seen.add("t:" + r.id);
    this.broadcast({ kind: "tx", tx }, { kind: "self" });
    log.info(info ? "actualizo mis datos de nodo en la cadena" : "solicito el alta del nodo en la cadena");
  }

  private sendStatus() {
    if (this.offline) return;
    const st = { t: "status", height: this.chain.height, hash: this.chain.hash };
    for (const l of this.readyLinks()) this.linkSend(l, st);
    this.hubSend({
      ...st, mempool: this.mempool.size, mailboxes: this.subs.size,
      stats: { shardsStored: this.store.shardCount(), shardsRelayed: this.counters.shardsRelayed, shardsDelivered: this.counters.shardsDelivered, blocksProduced: this.counters.blocksProduced },
    });
    if (Math.random() < 0.2) this.sendPex();
  }

  private housekeeping() {
    const n = this.store.pruneShards();
    if (n) log.debug(`${n} fragmentos caducados destruidos`);
    for (const [a, t] of this.faucetMem) if (Date.now() - t > FAUCET_INTERVAL_MS) this.faucetMem.delete(a);
    const now = Date.now();
    for (const [k, b] of this.buckets) if (now - b.at > 120_000) this.buckets.delete(k);
    if (this.chain.height > 2_000 && this.chain.height % 10 < 2) this.store.pruneSideBlocks(this.chain.height - 2_000);
  }

  // =====================================================================
  // Clientes
  // =====================================================================
  private onLocalClientFrame(ws: ServerWebSocket<WsData>, f: any) {
    if (f?.t === "ping") return ws.send(JSON.stringify({ t: "pong" }));
    if (f?.t !== "rpc" || typeof f.id !== "string") return;
    const reply = (node: string) => [
      (result: unknown) => { try { ws.send(JSON.stringify({ t: "rpc_res", id: f.id, result, node })); } catch {} },
      (e: unknown) => { try { ws.send(JSON.stringify({ t: "rpc_res", id: f.id, error: errMsg(e), node })); } catch {} },
    ] as const;
    // Llamada dirigida a otro nodo (p. ej. el sorteado para un trozo): se reenvía por mensaje directo.
    if (typeof f.node === "string" && f.node && f.node !== this.me) {
      const [ok, ko] = reply(f.node);
      if (!this.allowShardPut(ws.data.key, f.method)) return ko(new RpcError("Demasiados trozos seguidos; espera un momento"));
      this.callNode(f.node, f.method, f.params ?? {}).then(ok, ko);
      return;
    }
    const [ok, ko] = reply(this.me);
    this.runRpc(ws.data.key, f.method, f.params).then(ok, ko);
  }

  /** Cubeta de fichas por conexión de cliente para `shard.put` (50/s, ráfaga 200). */
  private allowShardPut(client: string, method: string): boolean {
    if (method !== "shard.put" || client.startsWith("d:")) return true;
    const now = Date.now();
    const b = this.buckets.get(client) ?? { tokens: SHARD_PUT_BURST, at: now };
    b.tokens = Math.min(SHARD_PUT_BURST, b.tokens + ((now - b.at) / 1000) * SHARD_PUT_RATE);
    b.at = now;
    this.buckets.set(client, b);
    if (b.tokens < 1) { this.counters.rateLimited++; return false; }
    b.tokens -= 1;
    return true;
  }

  private dropClient(key: string) {
    this.localClients.delete(key);
    this.buckets.delete(key);
    const mbs = this.clientSubs.get(key);
    if (!mbs) return;
    for (const mb of mbs) {
      const set = this.subs.get(mb);
      set?.delete(key);
      if (set && set.size === 0) this.subs.delete(mb);
    }
    this.clientSubs.delete(key);
  }

  private pushTo(key: string, data: StoredShard) {
    if (key.startsWith("h:")) this.hubSend({ t: "push", to: key.slice(2), event: "shard", data });
    else if (key.startsWith("l:")) {
      const ws = this.localClients.get(key);
      if (!ws) return this.dropClient(key);
      try { ws.send(JSON.stringify({ t: "push", node: this.me, event: "shard", data })); } catch {}
    } else return;
    this.counters.shardsDelivered++;
  }

  private pushToMailbox(s: StoredShard) {
    const set = this.subs.get(s.mailbox);
    if (set) for (const [k, auth] of set) if (auth === s.mbAuth) this.pushTo(k, s);
  }

  // =====================================================================
  // RPC
  // =====================================================================
  private epochInfo(epoch?: number): EpochInfo | null {
    const s = this.chain.state;
    const snap = epoch === undefined ? currentSnapshot(s) : snapshotFor(s, epoch);
    if (!snap) return null;
    const online = new Set<string>([this.me, ...this.hubPeers.keys()]);
    for (const l of this.readyLinks()) online.add(l.node!);
    return { ...snap, online: [...online] };
  }

  private async runRpc(client: string, method: RpcMethod, params: any): Promise<any> {
    if (this.offline) throw new RpcError(this.held ?? "Aportación en pausa");
    params = params ?? {};
    const s = this.chain.state;
    const addr = () => {
      const a = String(params.address ?? "");
      if (!isAddress(a) && !a.startsWith("vel_")) throw new RpcError("Dirección no válida");
      return a;
    };
    switch (method) {
      case "chain.head":
        return { height: s.height, hash: s.hash, ts: s.ts, node: this.me };
      case "chain.block":
        if (typeof params.hash === "string") return this.chain.blockByHash(params.hash);
        return this.chain.blockAt(Number(params.height ?? s.height));
      case "chain.blocks":
        return this.chain.range(Number(params.from), Number(params.to));
      case "chain.epoch":
        return this.epochInfo(params.epoch === undefined ? undefined : Number(params.epoch));
      case "account.get": {
        const a = String(params.address ?? "");
        const acc = s.accounts[a] ?? { balance: 0, nonce: 0 };
        return { balance: acc.balance, nonce: acc.nonce, pending: this.mempool.pendingFrom(a).length };
      }
      case "account.balances":
        return balancesOf(s, addr());
      case "account.orders":
        return ordersOf(s, addr());
      case "account.history":
        return this.store.history(String(params.address ?? ""), Number(params.limit ?? 50));
      case "token.info":
        return tokenInfo(s, String(params.symbol ?? ""));
      case "token.list":
        return tokenList(s);
      case "market.book": {
        const pair = String(params.pair ?? "");
        return bookOf(s, pair.includes("/") ? pair : pairOf(pair), Math.min(100, Math.max(1, Number(params.levels ?? 20))));
      }
      case "market.trades":
        return tradesOf(s, params.pair ? String(params.pair) : undefined, Math.min(500, Math.max(1, Number(params.limit ?? 50))));
      case "supply":
        return supplyInfo(s);
      case "chain.fees":
        // Contexto para construir transacciones: precio del oráculo y bits del sello PoW.
        return feeContext(s);
      case "oracle":
        return (s as any).oracle ?? null;
      case "claims":
        return (s as any).claims?.[String(Number(params.epoch ?? epochOf(s.height) - 1))] ?? {};
      case "name.info":
        return nameInfo(s, String(params.name ?? "").toLowerCase());
      case "name.of":
        return nameOfAddress(s, addr());
      case "difficulty":
        return difficulty(s);
      case "tx.submit": {
        const tx = params.tx as Tx;
        const r = this.mempool.add(tx, s);
        if ("error" in r) throw new RpcError(r.error);
        if (this.seen.add("t:" + r.id)) this.broadcast({ kind: "tx", tx }, { kind: "self" });
        return { id: r.id };
      }
      case "faucet":
        return this.faucet(String(params.address ?? ""));
      case "bridge.address":
      case "bridge.status":
      case "bridge.reserves":
      case "bridge.lookup":
        return this.bridgeRpc(method, params);
      case "stake.delegations": {
        if (params.node !== undefined) return delegationsOfNode(s, String(params.node));
        return delegationsOfAddress(s, addr());
      }
      case "shard.put": {
        if (!this.allowShardPut(client, "shard.put")) throw new RpcError("Demasiados trozos seguidos; espera un momento");
        const shard = params.shard as Shard;
        const err = shardProblem(shard);
        if (err) { this.counters.shardsRejected++; throw new RpcError(err); }
        if (this.store.countMailbox(shard.mailbox) >= MAX_SHARDS_PER_MAILBOX) throw new RpcError("Ese buzón está lleno; inténtalo más tarde");
        this.seen.add("s:" + shard.id);
        this.keepShard({ ...shard, carrier: this.me });
        this.broadcast({ kind: "shard", shard, carrier: this.me }, { kind: "self" });
        return { ok: true, carrier: this.me };
      }
      case "mailbox.open": {
        const list = Array.isArray(params.mailboxes) ? (params.mailboxes as MailboxOpen[]).slice(0, 16) : [];
        if (!list.length) throw new RpcError("Faltan buzones");
        const all: StoredShard[] = [];
        for (const m of list) {
          if (!verifyOpenProof(m)) throw new RpcError("Prueba de buzón no válida");
          // Las llamadas reenviadas por otro nodo (d:) no se suscriben: no hay por dónde empujarles.
          if (!client.startsWith("d:")) {
            (this.subs.get(m.mailbox) ?? this.subs.set(m.mailbox, new Map()).get(m.mailbox)!).set(client, m.auth);
            (this.clientSubs.get(client) ?? this.clientSubs.set(client, new Set()).get(client)!).add(m.mailbox);
          }
          for (const x of this.store.shardsFor(m.mailbox)) if (x.mbAuth === m.auth) all.push(x);
        }
        const shards: StoredShard[] = [];
        let bytes = 0;
        let i = 0;
        for (; i < all.length; i++) {
          bytes += all[i]!.data.length + 600;
          if (shards.length && bytes > OPEN_RESULT_BYTES) break;
          shards.push(all[i]!);
        }
        // Lo que no cabe en la respuesta se empuja después, poco a poco.
        const rest = all.slice(i);
        if (rest.length) setTimeout(() => { for (const x of rest) this.pushTo(client, x); }, 50);
        this.counters.shardsDelivered += shards.length;
        return { shards, courier: this.me };
      }
      case "receipt.submit": {
        const list = Array.isArray(params.receipts) ? (params.receipts as Receipt[]).slice(0, 5_000) : [];
        let accepted = 0;
        for (const r of list) {
          // El recibo nombra a este nodo como repartidor y el secreto cuadra con la huella del trozo.
          if (!r || r.courier !== this.me || ReceiptPool.check(r) || !checkReceiptProof(r)) continue;
          const stored = this.store.getShard(r.shard);
          if (stored && stored.rh !== r.rh) continue;
          accepted++;
          this.markDelivered(r);
          this.noteWork(r);
          if (this.receipts.add(r)) {
            this.counters.receiptsAccepted++;
            this.seen.add("r:" + receiptId(r));
            this.broadcast({ kind: "receipt", receipt: r }, { kind: "self" });
          }
        }
        return { accepted };
      }
      case "node.info": {
        const n = s.nodes[this.me];
        return {
          address: this.me, name: this.cfg.name, payout: this.cfg.payout, version: PUBLIC_VERSION, height: s.height,
          peers: this.peerCount(), tier: n ? tierFor(n, epochOf(s.height)).id : "bronce", earned: n?.earned ?? 0,
          uptime: Math.floor((Date.now() - this.startedAt) / 1000), kind: "full",
        };
      }
      case "node.get":
        return s.nodes[String(params.address ?? "")] ?? null;
      case "node.list": {
        const active = new Set(activeValidators(s));
        return Object.values(s.nodes).map((n) => ({ ...n, active: active.has(n.address), online: n.address === this.me || !!this.linkTo(n.address) || this.hubPeers.has(n.address) }));
      }
      case "stats":
        return this.stats();
      default:
        throw new RpcError(`Método desconocido: ${String(method)}`);
    }
  }

  /** Grifo de pruebas: VEL y 100 tEUR (para estrenar el mercado), una vez por hora y dirección. */
  /** Bloque rechazado. Si es de una versión de protocolo que no conocemos, el nodo se para (no bifurca) y pide actualizar. */
  private onInvalidBlock(height: number | undefined, error: string, from?: string) {
    if (error.startsWith(UPGRADE_NEEDED)) {
      log.warn(`${error}. Este binario no conoce esa versión: el nodo se detiene hasta actualizar (velum update).`);
      this.hold(`${UPGRADE_NEEDED}: actualiza con «velum update»`);
      return;
    }
    log.debug(`bloque #${height}${from ? ` de ${short(from)}` : ""} rechazado: ${error}`);
  }

  /** Reenvía `bridge.*` a la pasarela USDT configurada (VELUM_BRIDGE_URL). */
  private async bridgeRpc(method: string, params: any): Promise<any> {
    if (!BRIDGE_URL) {
      if (method === "bridge.address") throw new RpcError(BRIDGE_CLOSED);
      if (method === "bridge.status" || method === "bridge.reserves") return { enabled: false, message: BRIDGE_CLOSED };
      throw new RpcError(BRIDGE_CLOSED);
    }
    const res = await fetch(BRIDGE_URL.replace(/\/$/, "") + "/rpc", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(10_000),
    }).catch(() => null);
    if (!res) throw new RpcError("La pasarela no responde");
    const j = (await res.json().catch(() => ({}))) as { result?: unknown; error?: string };
    if (j.error) throw new RpcError(j.error);
    return j.result;
  }

  private faucet(address: string) {
    if (!HAS_FAUCET) throw new RpcError("La mainnet no tiene grifo");
    if (!isAddress(address)) throw new RpcError("Dirección no válida");
    const last = Math.max(this.faucetMem.get(address) ?? 0, this.store.faucetLast(address));
    const wait = last + FAUCET_INTERVAL_MS - Date.now();
    if (wait > 0) throw new RpcError(`El grifo da una vez por hora; vuelve en ${Math.ceil(wait / 60_000)} min`);
    const f = faucetKeyPair();
    const s = this.chain.state;
    let lastErr = "No se pudo crear la transacción";
    for (let attempt = 0; attempt < 3; attempt++) {
      const nonce = (s.accounts[f.address]?.nonce ?? 0) + this.mempool.pendingFrom(f.address).length;
      const tx = makeTransfer(f.secret, f.address, address, FAUCET_DRIP, nonce, { ctx: feeContext(s) });
      const r = this.mempool.add(tx, s);
      if ("error" in r) { lastErr = r.error; continue; }
      const now = Date.now();
      this.faucetMem.set(address, now);
      this.store.faucetMark(address, now);
      this.seen.add("t:" + r.id);
      this.broadcast({ kind: "tx", tx }, { kind: "self" });
      let tokens = 0;
      if (s.tokens[FAUCET_TOKEN]) {
        const t2 = makeTransfer(f.secret, f.address, address, FAUCET_TOKEN_DRIP, nonce + 1, { token: FAUCET_TOKEN, ctx: feeContext(s) });
        const r2 = this.mempool.add(t2, s);
        if ("id" in r2) {
          tokens = FAUCET_TOKEN_DRIP;
          this.seen.add("t:" + r2.id);
          this.broadcast({ kind: "tx", tx: t2 }, { kind: "self" });
        }
      }
      log.info(`grifo: ${formatVel(FAUCET_DRIP)}${tokens ? ` y ${tokens / 1_000_000} ${FAUCET_TOKEN}` : ""} para ${short(address)}`);
      return { id: r.id, amount: FAUCET_DRIP, ...(tokens ? { tokens: { [FAUCET_TOKEN]: tokens } } : {}) };
    }
    throw new RpcError(lastErr);
  }

  // =====================================================================
  // Estado para panel, puerta y RPC
  // =====================================================================
  private peerCount() {
    const set = new Set<string>(this.hubPeers.keys());
    for (const l of this.readyLinks()) set.add(l.node!);
    return set.size;
  }

  selfInfo(): PeerInfo {
    return { node: this.me, name: this.cfg.name, version: PUBLIC_VERSION, height: this.chain.height, since: this.startedAt, kind: "full", ...(this.cfg.endpoint ? { endpoint: this.cfg.endpoint } : {}) };
  }

  stats(): Record<string, number> {
    const s = this.chain.state;
    const sup = supplyInfo(s);
    return {
      height: s.height, ts: s.ts, nodes: Object.keys(s.nodes).length, active: activeValidators(s).length, peers: this.peerCount(),
      lightNodes: Object.values(s.nodes).filter((n) => n.kind === "light").length,
      minted: s.supply.minted, burned: s.supply.burned, circulating: sup.circulating, feesCollected: s.supply.feesCollected,
      transfers: s.supply.transfers, shards: s.supply.shards, pool: s.epoch.pool, epoch: epochOf(s.height), emission: sup.emission,
      difficulty: s.stats.difficulty ?? -1, tokens: Object.keys(s.tokens).length, trades: s.dex.trades.length,
      mempool: this.mempool.size, receiptsPending: this.receipts.size, mailboxes: this.subs.size, shardsStored: this.store.shardCount(),
      ...this.counters,
    };
  }

  status() {
    const s = this.chain.state;
    const n = s.nodes[this.me];
    const peers = new Map<string, { node: string; name: string; height: number; via: string; kind?: string }>();
    for (const p of this.hubPeers.values()) peers.set(p.node, { node: p.node, name: p.name, height: this.peerHeights.get(p.node)?.height ?? p.height, via: "puerta", kind: p.kind ?? "full" });
    for (const l of this.readyLinks()) peers.set(l.node!, { node: l.node!, name: l.name ?? "", height: this.peerHeights.get(l.node!)?.height ?? l.height, via: "directo", kind: "full" });
    return {
      address: this.me, name: this.cfg.name, payout: this.cfg.payout, version: PUBLIC_VERSION, chain: CHAIN_ID,
      height: s.height, hash: s.hash, headTs: s.ts, paused: this.paused, held: this.held, ready: this.isReady(),
      registered: !!n, active: activeValidators(s).includes(this.me),
      tier: n ? tierFor(n, epochOf(s.height)).id : null, earned: n?.earned ?? 0, credits: n?.credits ?? 0,
      payoutBalance: s.accounts[this.cfg.payout]?.balance ?? 0,
      payoutBalances: balancesOf(s, this.cfg.payout),
      shardsDelivered: n?.shardsDelivered ?? 0, blocksProducedTotal: n?.blocksProduced ?? 0,
      gateway: this.gateway, gateways: activeGateways(this.cfg), hubConnected: this.hubWelcomed,
      port: this.cfg.port, peers: [...peers.values()],
      uptime: Math.floor((Date.now() - this.startedAt) / 1000),
      counters: { ...this.counters }, mempool: this.mempool.size, mailboxes: this.subs.size, shardsStored: this.store.shardCount(),
      epoch: epochOf(s.height), difficulty: s.stats.difficulty === null ? null : s.stats.difficulty / 1000,
      autoUpdate: this.cfg.autoUpdate,
      unit: UNIT,
    };
  }
}

// ---------------------------------------------------------------------
/** @deprecated nombre v1; usa `shardProblem` del núcleo. */
export const checkShard = (s: Shard) => shardProblem(s);

const short = (a: string) => (a.length > 14 ? `${a.slice(0, 7)}…${a.slice(-4)}` : a);
const errMsg = (e: unknown) => (e instanceof Error ? e.message : String(e));
const formatVel = (micro: number) => formatAmount(VEL, micro, 6, 3);

function isLocal(ip: string | undefined, origin: string | null, port: number) {
  const okIp = !ip || ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
  if (!okIp) return false;
  if (!origin) return true;
  return origin === `http://localhost:${port}` || origin === `http://127.0.0.1:${port}`;
}

export const LIGHT_RPC = LIGHT_METHODS;
