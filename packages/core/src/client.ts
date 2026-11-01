// Cliente Velum v2: lo usan la app y la web. Habla con la puerta de entrada (o con un nodo directo).
// - Envía una copia sellada a cada dispositivo del destinatario y a mis otros dispositivos.
// - Cada copia se rellena a un cubo fijo y sale en trozos 3 de 5 por nodos distintos.
// - Abre los buzones de hoy y de ayer con pruebas que no dicen quién es.
// - Paga a los nodos con recibos anónimos: revela el secreto de cada trozo (solo él puede).
// - Vincula dispositivos con el QR que rota (link.ts), también en modo inverso (v3 §8).
// - Tarjeta de contacto, solicitudes de contacto e invitaciones de 24 h (names.ts, v3 §7).
import { makeCancel, makeOrder, makeTokenCreate, makeTransfer } from "./wallet";
import { type Tx, txId } from "./tx";
import type { KeyPair } from "./keys";
import { keyPairFromSecret } from "./keys";
import { fanOutTargets, newMessageId, openMessage, sealMessage, type Payload, type SignedPayload, type Sender } from "./envelope";
import { joinShards, shardProgress, splitIntoShards, type Shard } from "./shards";
import {
  addDevice, deviceEntry, isNewerDeviceList, mailboxOfDevice, removeDevice as removeFromList, rotateMailbox, rotatePrekeys,
  signDeviceCert, type DeviceCert, type DeviceKeys, type DeviceList,
} from "./devices";
import { dayOf, mailboxFor, mailboxTarget, openProof, type MailboxOpen } from "./mailbox";
import { receiptHash, receiptSecret, type ReceiptV2 } from "./proof";
import { decodeLinkMsg, encodeLinkMsg, LinkGuest, LinkHost, type LinkMailbox, type LinkMsg, type LinkResult } from "./link";
import type { EpochInfo, HubToClient, PeerInfo, RpcMap, RpcMethod } from "./wire";
import { lotteryCandidates, type EpochSnapshot } from "./lottery";
import { GATEWAYS } from "./constants";
import { LINK_FRAME_MS, MAX_DEVICES } from "./msgconst";
import {
  cardKeys, cardLink, createInvite as newInvite, INVITE_TTL_MS, inviteFromSecret, openContactRequest, parseVelumLink,
  sealContactRequest, type CardKeys, type ContactCard, type ContactRequest, type Invite,
} from "./names";

type Listener<T> = (v: T) => void;

/** WebSocket mínimo común a navegador, Bun y React Native (los tipos de Workers no traen onopen/onmessage). */
export interface Socket {
  readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((e: unknown) => void) | null;
  onmessage: ((e: { data: unknown }) => void) | null;
  onclose: ((e: unknown) => void) | null;
  onerror: ((e: unknown) => void) | null;
}
const defaultSocket = (url: string): Socket => new (globalThis as unknown as { WebSocket: new (u: string) => Socket }).WebSocket(url);

/** Todo lo que la app guarda de la cuenta en este dispositivo (Keychain / SQLCipher). */
export interface VelumAccount {
  identity: KeyPair;
  wallet: KeyPair;
  mailboxBase: string;
  device: DeviceKeys;
  cert: DeviceCert;
  deviceList: DeviceList;
}

export interface ClientOptions {
  account?: VelumAccount;
  /** Listas de dispositivos de los contactos (verificadas al cargarlas). */
  contacts?: DeviceList[];
  /** Una puerta o varias (por orden de preferencia). Por defecto, GATEWAYS. */
  url?: string | readonly string[];
  /** Fábrica de sockets (pruebas o transportes propios). */
  socket?: (url: string) => Socket;
}

export interface SendProgress {
  id: string; // id del payload
  to: string;
  /** Copias (dispositivos) a las que se envía. */
  copies: number;
  accepted: number; // trozos aceptados por la red
  total: number;
  done: boolean;
  error?: string;
}

export type Content = Omit<Payload, "v" | "id" | "from" | "dev" | "to" | "ts" | "group"> & { id?: string };

export interface IncomingMessage {
  payload: SignedPayload;
  /** Dispositivo que lo envió. */
  device: string;
  /** true si lo envió otro dispositivo mío (copia de sincronización). */
  outgoing: boolean;
  /** true si el remitente no está en mis contactos (no hay su DeviceList). */
  unknown: boolean;
  shards: number;
  nodes: string[];
}

export type LinkEvent =
  | { stage: "frame"; qr: string }
  | { stage: "waiting" }
  | { stage: "code"; code: string }
  | { stage: "sending"; messages: number }
  | { stage: "done"; account?: VelumAccount; blobs?: Record<string, unknown>; list?: DeviceList }
  | { stage: "error"; error: string };

export interface ClientEvents {
  status: "connecting" | "online" | "offline";
  message: IncomingMessage;
  incoming: { msg: string; have: number; total: number };
  progress: SendProgress;
  nodes: PeerInfo[];
  /** Un contacto ha publicado una lista de dispositivos nueva (guárdala). */
  contact: DeviceList;
  /** Han cambiado mis claves o mi lista (rotación, vínculo, expulsión): guarda la cuenta. */
  account: VelumAccount;
  link: LinkEvent;
  /** Alguien pide contacto con mi tarjeta: `acceptContactRequest(req)` para aceptarlo. */
  request: ContactRequest;
  /** Una invitación canjeada ya me ha dado el contacto de quien la creó. */
  invite: { from: string; list: DeviceList };
}

type InShard = Shard & { carrier: string; courier: string };

interface LinkSession {
  role: "host" | "guest";
  host?: LinkHost;
  guest?: LinkGuest;
  inbox: LinkMailbox;
  outbox: LinkMailbox;
  timer?: ReturnType<typeof setInterval>;
}

const DONE_MAX = 5_000;

export class VelumClient {
  private ws: Socket | null = null;
  private pending = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: any; at?: number; node?: string }>();
  /** Latencia media (ms) por nodo, medida en cada RPC dirigida (para elegir el candidato más cercano). */
  private latency = new Map<string, number>();
  private listeners: { [K in keyof ClientEvents]?: Set<Listener<ClientEvents[K]>> } = {};
  private inbox = new Map<string, InShard[]>();
  /** msg → semilla de recibos (para pagar también los trozos rezagados). Null si no era para mí. */
  private done = new Map<string, string | null>();
  private acked = new Set<string>();
  private seq = 0;
  private rr = 0;
  private closed = false;
  private backoff = 500;
  private urls: string[];
  private urlIdx = 0;
  private makeSocket: (url: string) => Socket;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private tick: ReturnType<typeof setInterval> | null = null;
  private openedDay = -1;
  private link: LinkSession | null = null;
  /** Fotos del sorteo de rutas por época (para enrutar trozos y pagar al repartidor sorteado). */
  private snaps = new Map<number, EpochSnapshot>();
  private latestSnap: { snap: EpochSnapshot; at: number } | null = null;
  /** Buzones especiales abiertos: solicitudes de mi tarjeta e invitaciones que estoy canjeando. */
  private special = new Map<string, { kind: "request"; keys: CardKeys } | { kind: "invite"; inv: Invite }>();
  private invites = new Map<string, { inv: Invite; until: number }>();
  /** Nodos que el nodo/puerta al que hablo ve en línea (además de `nodes`). */
  private onlineSeen = new Set<string>();
  account: VelumAccount | null;
  contacts = new Map<string, DeviceList>();
  nodes: PeerInfo[] = [];
  status: ClientEvents["status"] = "offline";

  constructor(o: ClientOptions = {}) {
    this.account = o.account ?? null;
    for (const c of o.contacts ?? []) this.setContact(c);
    const u = o.url ?? GATEWAYS;
    this.urls = typeof u === "string" ? [u] : [...u];
    if (!this.urls.length) throw new Error("Sin puertas de entrada");
    this.makeSocket = o.socket ?? defaultSocket;
  }

  /** Puerta en uso. */
  get url() {
    return this.urls[this.urlIdx]!;
  }

  on<K extends keyof ClientEvents>(ev: K, fn: Listener<ClientEvents[K]>) {
    const map = this.listeners as Record<string, Set<Listener<ClientEvents[K]>> | undefined>;
    const set = (map[ev] ??= new Set());
    set.add(fn);
    return () => set.delete(fn);
  }
  private emit<K extends keyof ClientEvents>(ev: K, v: ClientEvents[K]) {
    this.listeners[ev]?.forEach((fn) => {
      try { (fn as Listener<ClientEvents[K]>)(v); } catch (e) { console.warn("[velum] listener", e); }
    });
  }
  private setStatus(s: ClientEvents["status"]) {
    this.status = s;
    this.emit("status", s);
  }
  private need(): VelumAccount {
    if (!this.account) throw new Error("Este dispositivo aún no tiene cuenta (vincúlalo o restaura la frase)");
    return this.account;
  }

  // ---------- Conexión (un solo socket vivo, reintento con espera creciente y cambio de puerta) ----------
  connect() {
    this.closed = false;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    // Una sola conexión viva: si se llama con otra abierta (p. ej. al volver la app), se cierra la vieja.
    const old = this.ws;
    this.ws = null;
    if (old && old.readyState <= 1) old.close();
    this.setStatus("connecting");
    const base = this.url;
    const ws = this.makeSocket(base.includes("?") ? `${base}&role=client` : `${base}?role=client`);
    this.ws = ws;
    let welcomed = false;
    ws.onopen = () => { this.backoff = 500; };
    ws.onmessage = (e) => {
      if (this.ws !== ws) return;
      const f = JSON.parse(typeof e.data === "string" ? e.data : new TextDecoder().decode(e.data as ArrayBuffer)) as HubToClient;
      if (f.t === "welcome") welcomed = true;
      this.onFrame(f);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return; // conexión sustituida: no reintenta ni cambia el estado
      this.setStatus("offline");
      for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(new Error("Sin conexión")); }
      this.pending.clear();
      // Si esta puerta no llegó a funcionar (DNS bloqueado, caída…), prueba la siguiente; si funcionaba, se queda.
      if (!welcomed && this.urls.length > 1) this.urlIdx = (this.urlIdx + 1) % this.urls.length;
      if (!this.closed) this.retry = setTimeout(() => this.connect(), (this.backoff = Math.min(this.backoff * 2, 15_000)));
    };
    ws.onerror = () => {};
    if (!this.tick) this.tick = setInterval(() => this.maintain().catch((e) => console.warn("[velum] mantenimiento", e)), 60_000);
  }

  close() {
    this.closed = true;
    if (this.retry) { clearTimeout(this.retry); this.retry = null; }
    if (this.tick) { clearInterval(this.tick); this.tick = null; }
    if (this.link?.timer) clearInterval(this.link.timer);
    this.ws?.close();
  }

  private onFrame(f: HubToClient) {
    if (f.t === "welcome" || f.t === "nodes") {
      this.nodes = f.nodes;
      this.emit("nodes", f.nodes);
      if (f.t === "welcome") {
        this.setStatus("online");
        this.openMailboxes().catch((e) => console.warn("[velum] buzón", e));
        this.refreshEpoch().catch(() => {});
      }
    } else if (f.t === "rpc_res") {
      const p = this.pending.get(f.id);
      if (!p) return;
      if (p.at && p.node && !f.error) {
        const ms = Date.now() - p.at, prev = this.latency.get(p.node);
        this.latency.set(p.node, prev === undefined ? ms : prev * 0.7 + ms * 0.3);
      }
      this.pending.delete(f.id);
      clearTimeout(p.timer);
      f.error ? p.reject(new Error(f.error)) : p.resolve(f.result);
    } else if (f.t === "push" && f.event === "shard") {
      this.onShard({ ...f.data, courier: f.node });
    }
  }

  rpc<M extends RpcMethod>(method: M, params: RpcMap[M]["params"], node?: string, timeoutMs = 12_000): Promise<RpcMap[M]["result"]> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== 1) return reject(new Error("Sin conexión con la red"));
      const id = `${Date.now().toString(36)}${(this.seq++).toString(36)}`;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("La red no responde")); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, at: Date.now(), node });
      this.ws.send(JSON.stringify({ t: "rpc", node, id, method, params }));
    });
  }

  // ---------- Sorteo público de rutas (lottery.ts) ----------
  /**
   * Pide la foto del sorteo (la última, o la de una época concreta). Se guarda por época. La última se
   * renueva si tiene más de 30 s (una época dura ~1 min).
   */
  async refreshEpoch(epoch?: number): Promise<EpochSnapshot | null> {
    const info = (await this.rpc("chain.epoch", epoch === undefined ? {} : { epoch })) as EpochInfo | null;
    if (!info) return null;
    const { online, ...snap } = info;
    this.snaps.set(snap.epoch, snap);
    if (this.snaps.size > 32) this.snaps.delete(Math.min(...this.snaps.keys()));
    if (epoch === undefined) {
      const fresh = this.latestSnap?.snap.epoch !== snap.epoch;
      this.latestSnap = { snap, at: Date.now() };
      this.onlineSeen = new Set(online ?? []);
      if (fresh) this.probeLatency().catch(() => {});
    }
    return snap;
  }

  private async currentSnap(): Promise<EpochSnapshot | null> {
    if (this.latestSnap && Date.now() - this.latestSnap.at < 30_000) return this.latestSnap.snap;
    try { return await this.refreshEpoch(); } catch { return this.latestSnap?.snap ?? null; }
  }

  private async snapFor(ep: number | undefined): Promise<EpochSnapshot | null> {
    if (ep === undefined) return null;
    const hit = this.snaps.get(ep);
    if (hit) return hit;
    try { return await this.refreshEpoch(ep); } catch { return null; }
  }

  /**
   * v3 §3: de los 3 candidatos del sorteo, el alcanzable de menor latencia (sin medir aún = 250 ms; a igual
   * latencia manda el orden del sorteo). Todos cobran si de verdad llevan el trozo. Null si ninguno está en línea.
   */
  private bestCandidate(snap: EpochSnapshot | null, shardId: string, role: "carrier" | "courier"): string | null {
    if (!snap) return null;
    let best: string | null = null, bestMs = Infinity;
    for (const c of lotteryCandidates(snap, shardId, role)) {
      if (!this.isReachable(c)) continue;
      const ms = this.latency.get(c) ?? 250;
      if (ms < bestMs) { best = c; bestMs = ms; }
    }
    return best;
  }

  /** Mide la latencia de los nodos en línea de la foto (una llamada ligera a cada uno, como mucho 12). */
  async probeLatency() {
    const snap = this.latestSnap?.snap;
    if (!snap) return;
    const nodes = snap.nodes.map((n) => n.node).filter((n) => this.isReachable(n)).slice(0, 12);
    await Promise.allSettled(nodes.map((n) => this.rpc("chain.head", {}, n, 5_000)));
  }

  /** ¿Puedo hacer llegar una llamada a este nodo ahora? (la puerta lo tiene, o mi nodo lo ve en línea). */
  isReachable(node: string) {
    return this.nodes.some((n) => n.node === node) || this.onlineSeen.has(node);
  }

  /** Nodo siguiente en rueda: así cada fragmento sale por un nodo distinto. */
  private pickNode(): string | undefined {
    if (!this.nodes.length) return undefined;
    return this.nodes[this.rr++ % this.nodes.length]!.node;
  }

  // ---------- Contactos y cuenta ----------
  /** Guarda (o actualiza) la lista de dispositivos de un contacto. Devuelve false si no es válida o es más vieja. */
  setContact(list: DeviceList): boolean {
    if (!isNewerDeviceList(this.contacts.get(list.identity), list)) return false;
    this.contacts.set(list.identity, list);
    return true;
  }

  private setAccount(a: VelumAccount) {
    this.account = a;
    this.emit("account", a);
  }

  /** Buzones que abro: hoy y ayer de este dispositivo, y el efímero de un vínculo en curso. */
  private myMailboxes(now = Date.now()): MailboxOpen[] {
    const out: MailboxOpen[] = [];
    if (this.account) {
      const mb = mailboxOfDevice(this.account.device, this.account.mailboxBase);
      const d = dayOf(now);
      for (const day of [d, d - 1]) out.push(openProof(mb, mailboxFor(mb.seed, day), now));
    }
    if (this.link) out.push(openProof(this.link.inbox.mb, this.link.inbox.mailbox, now));
    // Buzón de solicitudes de mi tarjeta (hoy y ayer) e invitaciones en canje (24 h).
    this.special.clear();
    const d = dayOf(now);
    if (this.account) {
      const keys = this.cardKeys();
      for (const day of [d, d - 1]) {
        const mailbox = mailboxFor(keys.mailbox.seed, day);
        this.special.set(mailbox, { kind: "request", keys });
        out.push(openProof(keys.mailbox, mailbox, now));
      }
    }
    for (const [id, x] of this.invites) {
      if (now > x.until) { this.invites.delete(id); continue; }
      for (const day of [d, d - 1]) {
        const mailbox = mailboxFor(x.inv.mailbox.seed, day);
        this.special.set(mailbox, { kind: "invite", inv: x.inv });
        out.push(openProof(x.inv.mailbox, mailbox, now));
      }
    }
    return out;
  }

  /** Abre los buzones en TODOS los nodos (así recibe aunque un nodo se apague). */
  async openMailboxes() {
    const mailboxes = this.myMailboxes();
    if (!mailboxes.length) return;
    this.openedDay = dayOf(Date.now());
    const targets = this.nodes.length ? this.nodes.map((n) => n.node) : [undefined];
    await Promise.allSettled(
      targets.map(async (node) => {
        const r = await this.rpc("mailbox.open", { mailboxes }, node);
        for (const s of r.shards) this.onShard({ ...s, courier: r.courier });
      }),
    );
  }

  /**
   * Mantenimiento (cada minuto): reabre buzones al cambiar de día y rota la prellave cada 24 h
   * (entonces firma la lista nueva y la reparte a los contactos).
   */
  async maintain(now = Date.now()) {
    if (this.status === "online" && dayOf(now) !== this.openedDay) await this.openMailboxes();
    const a = this.account;
    if (!a) return;
    const { keys, rotated } = rotatePrekeys(a.device, now);
    if (keys.prekeys.length !== a.device.prekeys.length || rotated) {
      const deviceList = rotated ? addDevice(a.identity.secret, a.deviceList, deviceEntry(keys, a.mailboxBase, now), now) : a.deviceList;
      this.setAccount({ ...a, device: keys, deviceList });
      if (rotated && this.status === "online") await this.broadcastProfile();
    }
  }

  // ---------- Recepción ----------
  private onShard(s: InShard) {
    const known = this.done.get(s.msg);
    if (known !== undefined) {
      if (known) this.ack([s], known);
      return;
    }
    const list = this.inbox.get(s.msg) ?? [];
    if (list.some((x) => x.id === s.id)) return;
    list.push(s);
    this.inbox.set(s.msg, list);
    const prog = shardProgress(list);
    this.emit("incoming", { msg: s.msg, have: prog.have, total: prog.total });
    const sealed = joinShards(list);
    if (!sealed) return;
    this.inbox.delete(s.msg);
    const link = this.link;
    if (link && s.mailbox === link.inbox.mailbox) {
      this.markDone(s.msg, link.inbox.rseed);
      this.ack(list, link.inbox.rseed);
      try { this.onLinkMsg(decodeLinkMsg(sealed)); } catch (e) { this.emit("link", { stage: "error", error: (e as Error).message }); }
      return;
    }
    const sp = this.special.get(s.mailbox);
    if (sp) { this.onSpecial(sp, s.msg, sealed, list); return; }
    if (!this.account) { this.markDone(s.msg, null); return; }
    try {
      const o = openMessage(this.account.device, sealed);
      this.markDone(s.msg, o.rseed);
      this.ack(list, o.rseed);
      this.onPayload(o.payload, o.cert.device, list);
    } catch {
      // Con todos los datos y sin abrir: no era para este dispositivo o está corrupto.
      this.markDone(s.msg, null);
    }
  }

  /** Trozos completos de mi buzón de solicitudes o de una invitación en canje. */
  private onSpecial(sp: { kind: "request"; keys: CardKeys } | { kind: "invite"; inv: Invite }, msg: string, sealed: Uint8Array, list: InShard[]) {
    try {
      if (sp.kind === "request") {
        const req = openContactRequest(sp.keys, sealed);
        this.markDone(msg, req.rseed);
        this.ack(list, req.rseed);
        this.emit("request", req);
        return;
      }
      const o = openMessage(sp.inv.device, sealed);
      this.markDone(msg, o.rseed);
      this.ack(list, o.rseed);
      if (!this.account) return;
      this.onPayload(o.payload, o.cert.device, list);
      if (o.payload.kind === "profile") {
        const contact = this.contacts.get(o.payload.from);
        if (contact) {
          this.emit("invite", { from: o.payload.from, list: contact });
          this.sendProfile(o.payload.from).catch(() => {}); // así quien invitó también me tiene
        }
      }
    } catch {
      this.markDone(msg, null);
    }
  }

  private markDone(msg: string, rseed: string | null) {
    this.done.set(msg, rseed);
    if (this.done.size > DONE_MAX) this.done.delete(this.done.keys().next().value!);
  }

  private onPayload(p: SignedPayload, device: string, shards: InShard[]) {
    const a = this.account!;
    const outgoing = p.from === a.identity.address;
    const list = outgoing ? a.deviceList : this.contacts.get(p.from);
    // Dispositivo expulsado: su certificado sigue siendo válido, pero ya no está en la lista.
    if (list && !list.devices.some((d) => d.id === device) && p.ts <= list.ts) return;
    if (p.kind === "profile") {
      try {
        const next = JSON.parse(p.body ?? "") as DeviceList;
        if (next.identity !== p.from) return;
        if (outgoing) this.adoptOwnList(next);
        else if (this.setContact(next)) this.emit("contact", next);
      } catch { /* perfil mal formado */ }
      return;
    }
    this.emit("message", { payload: p, device, outgoing, unknown: !list, shards: shards.length, nodes: [...new Set(shards.map((x) => x.carrier))] });
    if (!outgoing && list && !["receipt", "typing", "sync", "security"].includes(p.kind))
      this.sendReceipt(p.from, [p.id], "delivered").catch(() => {});
  }

  /** Otro dispositivo mío publicó mi lista. Si me han quitado, no hago nada; si quitaron a otro, roto mi buzón. */
  private adoptOwnList(next: DeviceList) {
    const a = this.account!;
    if (!isNewerDeviceList(a.deviceList, next)) return;
    if (!next.devices.some((d) => d.id === a.device.id)) {
      this.setAccount({ ...a, deviceList: next });
      return;
    }
    const removed = a.deviceList.devices.some((d) => !next.devices.some((x) => x.id === d.id));
    if (removed) {
      const device = rotateMailbox(a.device);
      const deviceList = addDevice(a.identity.secret, next, deviceEntry(device, a.mailboxBase, Date.now()));
      this.setAccount({ ...a, device, deviceList });
      this.broadcastProfile().catch(() => {});
      this.openMailboxes().catch(() => {});
    } else this.setAccount({ ...a, deviceList: next });
  }

  /**
   * Recibos anónimos: revela el secreto de cada trozo. Cobra el repartidor SORTEADO para ese trozo
   * (no quien me lo empujó): si está en línea, el recibo le nombra y se le manda a él; si no, se manda
   * al nodo que lo entregó con su nombre (ese papel no cobra nadie, pero el trozo se borra en toda la red).
   */
  private ack(shards: InShard[], rseed: string) {
    const ready: { s: InShard; secret: string }[] = [];
    for (const s of shards) {
      if (this.acked.has(s.id)) continue;
      const secret = receiptSecret(rseed, s.id);
      if (receiptHash(secret) !== s.rh) continue; // trozo con huella falsa: no se paga
      this.acked.add(s.id);
      ready.push({ s, secret });
    }
    if (this.acked.size > DONE_MAX * 10) this.acked.clear();
    if (!ready.length) return;
    (async () => {
      const byCourier = new Map<string, ReceiptV2[]>();
      const ts = Date.now();
      for (const { s, secret } of ready) {
        const snap = await this.snapFor(s.ep);
        // Si quien me lo entregó es candidato del sorteo, cobra él; si no, el candidato en línea más cercano.
        const cands = snap ? lotteryCandidates(snap, s.id, "courier") : [];
        const courier = cands.includes(s.courier) ? s.courier : this.bestCandidate(snap, s.id, "courier") ?? s.courier;
        const r: ReceiptV2 = { shard: s.id, mailbox: s.mailbox, rh: s.rh, secret, carrier: s.carrier, courier, ts, ...(s.ep !== undefined ? { ep: s.ep } : {}) };
        (byCourier.get(courier) ?? byCourier.set(courier, []).get(courier)!).push(r);
      }
      for (const [node, receipts] of byCourier) {
        await this.rpc("receipt.submit", { receipts }, node).catch(async () => {
          // El sorteado no contesta: el recibo va al que lo entregó (así al menos se borra el trozo).
          const fallback = receipts.map((r) => ({ ...r, courier: shards.find((x) => x.id === r.shard)?.courier ?? r.courier }));
          const via = fallback[0]!.courier;
          if (via !== node) await this.rpc("receipt.submit", { receipts: fallback }, via).catch(() => {});
        });
      }
    })().catch(() => {});
  }

  // ---------- Envío ----------
  /**
   * Cada trozo va al candidato del sorteo más cercano (de 3) que esté en línea: solo así cobra como `carrier`.
   * Si no hay ninguno, o falla, sale por cualquier otro (el trozo llega igual, pero ese papel no cobra nadie).
   */
  private async pushShards(shards: Shard[], prog: SendProgress, snap: EpochSnapshot | null = null) {
    const results = await Promise.allSettled(
      shards.map(async (shard) => {
        let lastErr: unknown;
        const sorted = this.bestCandidate(snap, shard.id, "carrier");
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            const node = attempt === 0 && sorted && this.isReachable(sorted) ? sorted : this.pickNode();
            await this.rpc("shard.put", { shard }, node);
            prog.accepted++;
            this.emit("progress", { ...prog });
            return true;
          } catch (e) { lastErr = e; }
        }
        throw lastErr;
      }),
    );
    // Cada franja necesita 3 de 5 en la red.
    const ok = new Map<number, number>();
    shards.forEach((s, i) => { if (results[i]!.status === "fulfilled") ok.set(s.stripe, (ok.get(s.stripe) ?? 0) + 1); });
    const stripes = new Set(shards.map((s) => s.stripe));
    return [...stripes].every((st) => (ok.get(st) ?? 0) >= shards[0]!.k);
  }

  private async deliver(payload: Payload, targets: ReturnType<typeof fanOutTargets>, to: string): Promise<SendProgress> {
    const a = this.need();
    const sender: Sender = { device: a.device, cert: a.cert };
    const copies = sealMessage(sender, targets, payload);
    const now = Date.now();
    const snap = await this.currentSnap();
    const ep = snap?.epoch;
    const all = copies.map((c) => splitIntoShards(c.bytes, { ...mailboxTarget(c.device, now), rseed: c.rseed, now, ep }));
    const prog: SendProgress = { id: payload.id, to, copies: copies.length, accepted: 0, total: all.reduce((n, s) => n + s.length, 0), done: false };
    this.emit("progress", { ...prog });
    const oks = await Promise.all(all.map((sh) => this.pushShards(sh, prog, snap)));
    prog.done = true;
    if (!oks.every(Boolean)) prog.error = "No se pudo entregar a la red";
    this.emit("progress", { ...prog });
    return prog;
  }

  private base(to: string, p: Content, group?: string): Payload {
    const a = this.need();
    const { id, ...rest } = p;
    return { v: 2, id: id ?? newMessageId(), from: a.identity.address, dev: a.device.id, to, ts: Date.now(), ...rest, ...(group ? { group } : {}) };
  }

  /** Mensaje 1 a 1 (`to` = identidad del contacto): copia a cada dispositivo suyo y a mis otros dispositivos. */
  async send(to: string, p: Content): Promise<SendProgress> {
    const a = this.need();
    const list = this.contacts.get(to);
    if (!list && to !== a.identity.address) throw new Error("No tengo las claves de este contacto: intercambiad el perfil (QR o enlace)");
    const payload = this.base(to, p);
    return this.deliver(payload, fanOutTargets(list ? [list] : [], a.deviceList, a.device.id), to);
  }

  /** Mensaje de grupo: se cifra una vez; la clave va sellada a cada dispositivo de cada miembro (y a los míos). */
  async sendGroup(group: string, members: string[], p: Content): Promise<SendProgress> {
    const a = this.need();
    const lists = members.filter((m) => m !== a.identity.address).map((m) => this.contacts.get(m)).filter((l): l is DeviceList => !!l);
    if (!lists.length) throw new Error("No tengo las claves de ningún miembro del grupo");
    return this.deliver(this.base(group, p, group), fanOutTargets(lists, a.deviceList, a.device.id), group);
  }

  sendReceipt(to: string, refs: string[], status: "delivered" | "read") {
    return this.send(to, { kind: "receipt", refs, status });
  }

  /** Envía mi lista de dispositivos (firmada) a un contacto, dentro de un mensaje cifrado. */
  sendProfile(to: string) {
    return this.send(to, { kind: "profile", body: JSON.stringify(this.need().deviceList) });
  }

  /** Reparte mi lista a todos los contactos y a mis otros dispositivos. */
  async broadcastProfile() {
    const a = this.need();
    const body = JSON.stringify(a.deviceList);
    const jobs = [...this.contacts.keys()].map((c) => this.send(c, { kind: "profile", body }));
    if (a.deviceList.devices.length > 1) jobs.push(this.send(a.identity.address, { kind: "profile", body }));
    await Promise.allSettled(jobs);
  }

  /**
   * Expulsa un dispositivo: lista nueva sin él, rotación de mi buzón y reparto a contactos y a mis
   * otros dispositivos (que también rotan el suyo al recibirla).
   */
  async removeDevice(deviceId: string) {
    const a = this.need();
    if (deviceId === a.device.id) throw new Error("No puedes expulsar este dispositivo desde sí mismo");
    const device = rotateMailbox(a.device);
    const without = removeFromList(a.identity.secret, a.deviceList, deviceId);
    const deviceList = addDevice(a.identity.secret, without, deviceEntry(device, a.mailboxBase, Date.now()));
    this.setAccount({ ...a, device, deviceList });
    await this.openMailboxes().catch(() => {});
    await this.broadcastProfile();
    return deviceList;
  }

  // ---------- Vinculación (§6) ----------
  private async pushLink(box: LinkMailbox, m: LinkMsg) {
    const shards = splitIntoShards(encodeLinkMsg(m), { mailbox: box.mailbox, mbAuth: box.mbAuth, rseed: box.rseed });
    const prog: SendProgress = { id: "link", to: "link", copies: 1, accepted: 0, total: shards.length, done: false };
    if (!(await this.pushShards(shards, prog))) throw new Error("No se pudo enviar el mensaje de vínculo");
  }

  /** A: empieza a mostrar el QR. Emite `link` { stage: "frame" } cada 2 s hasta que B lo lea. */
  async startLink() {
    const a = this.need();
    if (a.deviceList.devices.length >= MAX_DEVICES) throw new Error(`Ya hay ${MAX_DEVICES} dispositivos: expulsa uno antes`);
    this.cancelLink();
    const host = new LinkHost();
    const s: LinkSession = { role: "host", host, inbox: host.inbox, outbox: host.outbox };
    this.link = s;
    const show = () => this.emit("link", { stage: "frame", qr: host.frame() });
    show();
    s.timer = setInterval(() => {
      if (host.expired()) { this.emit("link", { stage: "error", error: "El vínculo ha caducado" }); this.cancelLink(); return; }
      if (host.state === "waiting") show();
    }, LINK_FRAME_MS);
    await this.openMailboxes();
    return host;
  }

  /** A: el usuario ha confirmado que el código coincide. Envía secretos, contactos e historial (lotes comprimidos). */
  async confirmLink(blobs: Record<string, unknown> = {}, phrase?: string) {
    const a = this.need();
    const host = this.link?.host;
    if (!host || !this.link) throw new Error("No hay ningún vínculo en curso");
    const msgs = host.confirm({ identitySecret: a.identity.secret, walletSecret: a.wallet.secret, mailboxBase: a.mailboxBase, phrase, deviceList: a.deviceList }, blobs);
    this.emit("link", { stage: "sending", messages: msgs.length });
    for (const m of msgs) await this.pushLink(this.link.outbox, m);
  }

  /** B: ha leído un fotograma del QR. Crea sus claves de dispositivo y saluda a A por la red. */
  async joinLink(qr: string, deviceName: string) {
    this.cancelLink();
    const guest = new LinkGuest(qr, deviceName);
    this.link = { role: "guest", guest, inbox: guest.inbox, outbox: guest.outbox };
    await this.openMailboxes();
    await this.pushLink(guest.outbox, guest.hello());
    this.emit("link", { stage: "waiting" });
    return guest;
  }

  /**
   * Modo inverso (v3 §8), en el dispositivo NUEVO (escritorio, web): muestra un QR que rota y espera a que el
   * activo lo escanee. Emite `link` { stage: "frame" } cada 2 s, luego "code" y "done" como en `joinLink`.
   */
  async startReverseLink(deviceName: string) {
    this.cancelLink();
    const guest = LinkGuest.display(deviceName);
    const s: LinkSession = { role: "guest", guest, inbox: guest.inbox, outbox: guest.outbox };
    this.link = s;
    const show = () => this.emit("link", { stage: "frame", qr: guest.qr() });
    show();
    s.timer = setInterval(() => {
      if (guest.expired()) { this.emit("link", { stage: "error", error: "El vínculo ha caducado" }); this.cancelLink(); return; }
      if (!guest.code) show();
    }, LINK_FRAME_MS);
    await this.openMailboxes();
    return guest;
  }

  /** Modo inverso, en el dispositivo ACTIVO: ha escaneado el QR del nuevo. Luego `confirmLink` como siempre. */
  async scanReverseLink(qr: string) {
    const a = this.need();
    if (a.deviceList.devices.length >= MAX_DEVICES) throw new Error(`Ya hay ${MAX_DEVICES} dispositivos: expulsa uno antes`);
    this.cancelLink();
    const host = LinkHost.scan(qr);
    this.link = { role: "host", host, inbox: host.inbox, outbox: host.outbox };
    await this.openMailboxes();
    await this.pushLink(host.outbox, host.hello());
    this.emit("link", { stage: "waiting" });
    return host;
  }

  cancelLink() {
    const s = this.link;
    if (!s) return;
    if (s.timer) clearInterval(s.timer);
    const m = s.host?.cancel();
    if (m && s.host?.state !== "done") this.pushLink(s.outbox, m).catch(() => {});
    this.link = null;
  }

  private onLinkMsg(m: LinkMsg) {
    const s = this.link;
    if (!s) return;
    if (s.role === "host" && s.host) {
      if (m.t === "accept" && s.host.reverse) {
        this.emit("link", { stage: "code", code: s.host.onAccept(m) });
      } else if (m.t === "hello") {
        const { reply, code } = s.host.onHello(m);
        if (s.timer) { clearInterval(s.timer); s.timer = undefined; }
        this.pushLink(s.outbox, reply).catch((e) => this.emit("link", { stage: "error", error: e.message }));
        this.emit("link", { stage: "code", code });
      } else if (m.t === "box") {
        const r = s.host.onBox(m, this.need().deviceList);
        if (!r) return;
        const a = this.need();
        this.setAccount({ ...a, deviceList: r.list });
        this.emit("link", { stage: "done", list: r.list });
        this.link = null;
        this.broadcastProfile().catch(() => {});
      }
    } else if (s.role === "guest" && s.guest) {
      if (m.t === "accept") this.emit("link", { stage: "code", code: s.guest.onAccept(m) });
      else if (m.t === "hello" && s.guest.reverse) {
        const { reply, code } = s.guest.onHello(m);
        if (s.timer) { clearInterval(s.timer); s.timer = undefined; }
        this.pushLink(s.outbox, reply).catch((e) => this.emit("link", { stage: "error", error: e.message }));
        this.emit("link", { stage: "code", code });
      }
      else if (m.t === "box") {
        const r = s.guest.onBox(m);
        if (!r) return;
        if ("cancelled" in r) { this.emit("link", { stage: "error", error: r.cancelled }); this.link = null; return; }
        const account = accountFromLink(r.result);
        this.pushLink(s.outbox, r.reply).catch((e) => this.emit("link", { stage: "error", error: e.message }));
        this.setAccount(account);
        this.emit("link", { stage: "done", account, blobs: r.result.blobs, list: account.deviceList });
        this.link = null;
        this.openMailboxes().catch(() => {});
      }
    }
  }

  // ---------- Tarjeta, solicitudes e invitaciones (v3 §7) ----------
  /** Claves de mi tarjeta (derivadas de la identidad: iguales en todos mis dispositivos). */
  cardKeys(rotation = 0): CardKeys {
    const a = this.need();
    return cardKeys(a.identity, a.mailboxBase, rotation);
  }
  /** Mi tarjeta de contacto (para `name.register` o el enlace `/c/<tarjeta>`). */
  myCard(rotation = 0): ContactCard {
    return this.cardKeys(rotation).card;
  }
  /** Enlace de contacto con mi tarjeta (funciona sin alias). */
  myCardLink(domain?: string) {
    return cardLink(this.myCard(), domain);
  }

  /** Trocea y entrega un sobre a un buzón (con la foto del sorteo vigente). */
  private async pushSealed(bytes: Uint8Array, target: { mailbox: string; mbAuth: string }, rseed: string, label: string, exp?: number) {
    const snap = await this.currentSnap();
    const shards = splitIntoShards(bytes, { ...target, rseed, ep: snap?.epoch });
    if (exp !== undefined) for (const sh of shards) sh.exp = exp;
    const prog: SendProgress = { id: label, to: label, copies: 1, accepted: 0, total: shards.length, done: false };
    if (!(await this.pushShards(shards, prog, snap))) throw new Error("No se pudo entregar a la red");
  }

  /** Pide contacto a alguien a partir de su tarjeta o de un enlace `/c/<tarjeta>`. */
  async sendContactRequest(to: ContactCard | string, note?: string) {
    const a = this.need();
    const card = typeof to === "string" ? (() => { const l = parseVelumLink(to); if (l.kind !== "card") throw new Error("Ese enlace no lleva tarjeta"); return l.card; })() : to;
    const { bytes, rseed, target } = sealContactRequest({ identity: a.identity, deviceList: a.deviceList }, card, note);
    await this.pushSealed(bytes, target, rseed, "request");
  }

  /** Acepta una solicitud: guardo su lista y le mando la mía (desde ahí, chat normal). */
  async acceptContactRequest(req: ContactRequest) {
    if (this.setContact(req.list)) this.emit("contact", req.list);
    return this.sendProfile(req.from);
  }

  /**
   * Invitación de un solo uso para quien aún no tiene Velum: claves nuevas, mi perfil y los mensajes
   * pendientes cifrados para ellas en un buzón derivado durante 24 h. Manda `link` por SMS, correo u otra app.
   */
  async createInvite(contents: Content[] = [], domain?: string) {
    const a = this.need();
    const inv = newInvite(domain);
    const now = Date.now();
    const exp = now + INVITE_TTL_MS;
    const sender: Sender = { device: a.device, cert: a.cert };
    const target = mailboxTarget(inv.entry, now);
    const payloads = [this.base("invite", { kind: "profile", body: JSON.stringify(a.deviceList) }), ...contents.map((c) => this.base("invite", c))];
    for (const p of payloads) {
      const [copy] = sealMessage(sender, [inv.entry], p);
      await this.pushSealed(copy!.bytes, target, copy!.rseed, "invite", exp);
    }
    return { link: inv.link, secret: inv.secret, expires: exp };
  }

  /** Canjea una invitación (`/i/<secreto>`): abre su buzón y recoge perfil y mensajes. Emite `invite`. */
  async redeemInvite(link: string) {
    this.need();
    const l = parseVelumLink(link);
    if (l.kind !== "invite") throw new Error("Ese enlace no es una invitación");
    const inv = inviteFromSecret(l.secret);
    this.invites.set(inv.secret, { inv, until: Date.now() + INVITE_TTL_MS });
    await this.openMailboxes();
    return inv;
  }

  // ---------- Cartera (clave separada de la identidad) ----------
  private get walletKeys() {
    return this.need().wallet;
  }
  walletAccount(address = this.walletKeys.address) {
    return this.rpc("account.get", { address });
  }
  /** Saldo y nonce de mi cartera (o de otra dirección). */
  balance(address?: string) {
    return this.walletAccount(address);
  }
  history(address = this.walletKeys.address) {
    return this.rpc("account.history", { address, limit: 100 });
  }
  faucet() {
    return this.rpc("faucet", { address: this.walletKeys.address });
  }
  /** Saldos de todos los tokens (VEL incluido). */
  balances(address = this.walletKeys.address) {
    return this.rpc("account.balances", { address });
  }
  orders(address = this.walletKeys.address) {
    return this.rpc("account.orders", { address });
  }
  book(pair: string) {
    return this.rpc("market.book", { pair });
  }
  async cancelOrder(id: string) {
    const w = this.walletKeys;
    return this.submit(makeCancel(w.secret, w.address, await this.nextNonce(), id));
  }
  private async nextNonce() {
    const acc = await this.walletAccount();
    return acc.nonce + acc.pending;
  }
  private async submit(tx: Tx) {
    const r = await this.rpc("tx.submit", { tx });
    return { id: r.id ?? txId(tx), tx };
  }
  /** Pago en VEL o en otro token (la comisión siempre en VEL). */
  async pay(to: string, amount: number, o: { token?: string; memo?: string } = {}): Promise<{ id: string; tx: Tx }> {
    const w = this.walletKeys;
    return this.submit(makeTransfer(w.secret, w.address, to, amount, await this.nextNonce(), o));
  }
  async placeOrder(o: Parameters<typeof makeOrder>[3]) {
    const w = this.walletKeys;
    return this.submit(makeOrder(w.secret, w.address, await this.nextNonce(), o));
  }
  async createToken(o: Parameters<typeof makeTokenCreate>[3]) {
    const w = this.walletKeys;
    return this.submit(makeTokenCreate(w.secret, w.address, await this.nextNonce(), o));
  }
}

/** Cuenta nueva (primer dispositivo o restauración con la frase). */
export function createAccount(keys: { identity: KeyPair; wallet: KeyPair; mailboxBase: string }, device: DeviceKeys, now = Date.now()): VelumAccount {
  const entry = deviceEntry(device, keys.mailboxBase, now);
  const deviceList = signDeviceListFirst(keys.identity, entry, now);
  return { ...keys, device, cert: signDeviceCert(keys.identity.secret, keys.identity.address, device, now), deviceList };
}

function signDeviceListFirst(identity: KeyPair, entry: ReturnType<typeof deviceEntry>, now: number): DeviceList {
  // seq empieza en el instante: una restauración con la frase siempre gana a listas viejas.
  return addDevice(identity.secret, { v: 2, identity: identity.address, devices: [], seq: now, ts: now, sig: "" }, entry, now);
}

/** Cuenta del dispositivo nuevo a partir del resultado del vínculo. */
export function accountFromLink(r: LinkResult): VelumAccount {
  return {
    identity: keyPairFromSecret(r.identitySecret),
    wallet: keyPairFromSecret(r.walletSecret),
    mailboxBase: r.mailboxBase,
    device: r.device,
    cert: r.cert,
    deviceList: r.deviceList,
  };
}
