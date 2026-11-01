// Puerta de entrada mínima, independiente de la plataforma (sin cadena ni indexador).
// Hace lo mismo que la puerta del Worker (apps/web/worker/hub.ts) en cuanto a enrutado:
//  · nodos (completos y ligeros) se presentan con saludo firmado; el gossip se reenvía al resto;
//  · a los ligeros no les llegan bloques, transacciones ni señales de vida: solo trozos, recibos y la cabeza;
//  · clientes mandan RPC a un nodo (o a uno completo al azar) y reciben respuestas y avisos (push).
// Se usa en pruebas (memoria) y en la puerta local de desarrollo (apps/node/scripts/devhub.ts).
import { verify } from "./keys";
import { isAddress } from "./keys";
import { LIGHT_METHODS, helloChallenge, type GossipItem, type PeerInfo } from "./wire";
import { txId, receiptId } from "./tx";

export interface HubConn {
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type Peer = { conn: HubConn; role: "node"; info?: PeerInfo; light?: boolean; hash?: string };
type Client = { conn: HubConn; role: "client"; id: string };
type Watch = { conn: HubConn; role: "watch" };
export type HubHandle = Peer | Client | Watch;

const HELLO_SKEW_MS = 2 * 60_000;

export class HubRouter {
  private nodes = new Set<Peer>();
  private clients = new Map<string, Client>();
  private watchers = new Set<Watch>();
  private seen = new Map<string, number>();
  private seq = 0;
  private head = { height: 0, hash: "", ts: 0 };

  open(conn: HubConn, role: "node" | "client" | "watch"): HubHandle {
    if (role === "node") {
      const p: Peer = { conn, role };
      this.nodes.add(p);
      return p;
    }
    if (role === "client") {
      const c: Client = { conn, role, id: `c_${Date.now().toString(36)}${(this.seq++).toString(36)}` };
      this.clients.set(c.id, c);
      this.send(conn, { t: "welcome", client: c.id, nodes: this.peers() });
      return c;
    }
    const w: Watch = { conn, role };
    this.watchers.add(w);
    this.send(conn, { t: "snapshot", head: this.head.hash ? this.head : null, nodes: this.peers(), stats: {} });
    return w;
  }

  close(h: HubHandle) {
    if (h.role === "node") {
      this.nodes.delete(h);
      if (h.info && ![...this.nodes].some((p) => p.info?.node === h.info!.node)) {
        this.toNodes({ t: "peer", op: "leave", peer: h.info });
        this.announceNodes();
      }
    } else if (h.role === "client") {
      this.clients.delete(h.id);
      this.toNodes({ t: "client_left", client: h.id });
    } else this.watchers.delete(h);
  }

  message(h: HubHandle, raw: string) {
    let f: any;
    try { f = JSON.parse(raw); } catch { return; }
    if (!f || typeof f !== "object") return;
    if (h.role === "node") this.onNode(h, f);
    else if (h.role === "client") this.onClient(h, f);
  }

  peers(): PeerInfo[] {
    return [...this.nodes].filter((p) => p.info).map((p) => p.info!);
  }

  private send(conn: HubConn, msg: unknown) {
    try { conn.send(typeof msg === "string" ? msg : JSON.stringify(msg)); } catch { /* cerrado */ }
  }

  private toNodes(msg: unknown, except?: Peer, filter: (p: Peer) => boolean = () => true) {
    const data = JSON.stringify(msg);
    for (const p of this.nodes) if (p.info && p !== except && filter(p)) this.send(p.conn, data);
  }

  private announceNodes() {
    const nodes = this.peers();
    for (const c of this.clients.values()) this.send(c.conn, { t: "nodes", nodes });
    for (const w of this.watchers) this.send(w.conn, { t: "nodes", nodes });
  }

  private byAddress(node: string) {
    for (const p of this.nodes) if (p.info?.node === node) return p;
    return undefined;
  }

  private dup(key: string) {
    if (this.seen.has(key)) return true;
    this.seen.set(key, Date.now());
    if (this.seen.size > 20_000) for (const k of [...this.seen.keys()].slice(0, 5_000)) this.seen.delete(k);
    return false;
  }

  private onNode(p: Peer, f: any) {
    if (!p.info) {
      if (f.t !== "hello") return p.conn.close(4001, "Primero hay que saludar (hello)");
      const ts = Number(f.ts);
      if (!isAddress(f.node) || !Number.isFinite(ts) || Math.abs(ts - Date.now()) > HELLO_SKEW_MS) return p.conn.close(4002, "Saludo caducado");
      if (typeof f.sig !== "string" || !verify(f.node, helloChallenge(f.node, ts), f.sig)) return p.conn.close(4003, "Firma del saludo no válida");
      const old = this.byAddress(f.node);
      if (old) { this.nodes.delete(old); old.conn.close(4000, "Sustituido por una conexión nueva"); }
      p.light = f.kind === "light";
      p.info = {
        node: f.node, name: String(f.name ?? "").slice(0, 40), version: String(f.version ?? "").slice(0, 24),
        height: Number(f.height) || 0, since: Date.now(), ...(f.endpoint ? { endpoint: String(f.endpoint).slice(0, 200) } : {}),
        kind: p.light ? "light" : "full",
      };
      this.send(p.conn, { t: "welcome", peers: this.peers().filter((x) => x.node !== f.node) });
      if (p.light && this.head.hash) this.send(p.conn, { t: "head", ...this.head });
      this.toNodes({ t: "peer", op: "join", peer: p.info }, p);
      this.announceNodes();
      return;
    }
    const from = p.info.node;
    switch (f.t) {
      case "gossip": {
        const item = f.item as GossipItem;
        const key = gossipKey(item);
        if (!key || this.dup(key)) return;
        // A los ligeros solo trozos y recibos; los bloques se resumen en "head".
        const forLight = item.kind === "shard" || item.kind === "receipt";
        this.toNodes({ t: "gossip", from, item }, p, (x) => !x.light || forLight);
        if (item.kind === "block" && item.block?.header && item.block.header.height > this.head.height) {
          this.head = { height: item.block.header.height, hash: item.block.hash, ts: item.block.header.ts };
          this.toNodes({ t: "head", ...this.head }, undefined, (x) => !!x.light);
        }
        return;
      }
      case "rpc_res": {
        const c = this.clients.get(f.to);
        if (c) this.send(c.conn, { t: "rpc_res", id: f.id, result: f.result, error: f.error, node: from });
        return;
      }
      case "push": {
        const c = this.clients.get(f.to);
        if (c) this.send(c.conn, { t: "push", node: from, event: f.event, data: f.data });
        return;
      }
      case "direct": {
        const n = typeof f.to === "string" ? this.byAddress(f.to) : undefined;
        if (n) this.send(n.conn, { t: "direct", from, data: f.data });
        return;
      }
      case "status":
        p.info.height = Number(f.height) || 0;
        p.hash = typeof f.hash === "string" ? f.hash : undefined;
        return;
    }
  }

  private onClient(c: Client, f: any) {
    if (f.t === "ping") return this.send(c.conn, { t: "pong" });
    if (f.t !== "rpc" || typeof f.id !== "string" || typeof f.method !== "string") return;
    let target: Peer | undefined;
    if (typeof f.node === "string" && f.node) {
      target = this.byAddress(f.node);
      if (!target) return this.send(c.conn, { t: "rpc_res", id: f.id, error: "Ese nodo no está conectado ahora" });
      if (target.light && !(LIGHT_METHODS as readonly string[]).includes(f.method))
        return this.send(c.conn, { t: "rpc_res", id: f.id, error: "Ese nodo es ligero y no sirve ese método" });
    } else {
      // Sin nodo: a uno completo al azar (los ligeros no tienen la cadena).
      const full = [...this.nodes].filter((x) => x.info && !x.light);
      target = full[Math.floor(Math.random() * full.length)];
    }
    if (!target) return this.send(c.conn, { t: "rpc_res", id: f.id, error: "No hay nodos conectados" });
    this.send(target.conn, { t: "rpc", from: c.id, id: f.id, method: f.method, params: f.params ?? {} });
  }
}

export function gossipKey(item: GossipItem): string | null {
  try {
    switch (item?.kind) {
      case "block": return item.block?.hash ? `b:${item.block.hash}` : null;
      case "tx": return item.tx ? `t:${txId(item.tx)}` : null;
      case "shard": return item.shard?.id ? `s:${item.shard.id}:${item.carrier}` : null;
      case "receipt": return item.receipt ? `r:${receiptId(item.receipt)}` : null;
      case "presence": return item.presence ? `p:${item.presence.node}:${item.presence.ts}` : null;
    }
  } catch { /* mal formado */ }
  return null;
}
