// Nodo ligero (LightNode) contra una puerta en memoria (HubRouter) con un nodo completo simulado y dos clientes.
import { describe, expect, test } from "bun:test";
import * as V from "../src";

async function until(cond: () => boolean, ms = 5_000, what = "condición") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

/** Socket en memoria conectado a un HubRouter (lo usan clientes, el ligero y el completo simulado). */
class MemSock implements V.Socket {
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  private h: V.HubHandle | null = null;
  constructor(private router: V.HubRouter, url: string) {
    const role = (new URL(url.replace(/^mem:/, "http:")).searchParams.get("role") ?? "client") as "node" | "client";
    setTimeout(() => {
      this.readyState = 1;
      this.h = router.open({ send: (d) => this.readyState === 1 && queueMicrotask(() => this.onmessage?.({ data: d })), close: () => this.close() }, role);
      this.onopen?.({});
    }, 1);
  }
  send(data: string) {
    const h = this.h;
    if (h) queueMicrotask(() => this.router.message(h, data));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.h) this.router.close(this.h);
    queueMicrotask(() => this.onclose?.({}));
  }
}

function newAccount(name: string) {
  return V.createAccount(V.keysFromPhrase(V.generatePhrase()), V.createDevice(name));
}

describe("nodo ligero", () => {
  test("se da de alta, acepta trozos sorteados, los entrega, cobra recibos y los propaga", async () => {
    const router = new V.HubRouter();
    const socket = (u: string) => new MemSock(router, u);
    const lightKeys = V.keyPairFromText("ligero-test");
    const full = V.keyPairFromText("completo-test");

    // ---- Nodo completo simulado: responde RPC directas del ligero y RPC de clientes.
    const txs: V.Tx[] = [];
    const gossip: V.GossipItem[] = [];
    let registered = false;
    let snapshot: V.EpochSnapshot | null = null;
    const fs = socket("mem://hub?role=node");
    const fsend = (o: unknown) => fs.send(JSON.stringify(o));
    fs.onopen = () => {
      const ts = Date.now();
      fsend({ t: "hello", node: full.address, name: "completo", version: "2", height: 40, ts, sig: V.sign(full.secret, V.helloChallenge(full.address, ts)) });
    };
    const answer = (method: string, params: any) => {
      switch (method) {
        case "node.get": return registered && params.address === lightKeys.address ? { address: lightKeys.address, kind: "light", payout: lightKeys.address, name: "móvil" } : null;
        case "account.get": return { balance: "0", nonce: 0, pending: 0 }; // v4: importes en texto decimal
        case "tx.submit": txs.push(params.tx); registered = true; return { id: V.txId(params.tx) };
        case "chain.epoch": return snapshot ? { ...snapshot, online: [full.address, lightKeys.address] } : null;
        case "mailbox.open": return { shards: [], courier: full.address };
        default: throw new Error("no");
      }
    };
    fs.onmessage = (e) => {
      const f = JSON.parse(String(e.data));
      if (f.t === "direct" && f.data?.kind === "rpc") {
        let res: any;
        try { res = { result: answer(f.data.method, f.data.params) }; } catch (err) { res = { error: (err as Error).message }; }
        fsend({ t: "direct", to: f.from, data: { kind: "rpc_res", id: f.data.id, ...res } });
      } else if (f.t === "rpc") {
        let res: any;
        try { res = { result: answer(f.method, f.params) }; } catch (err) { res = { error: (err as Error).message }; }
        fsend({ t: "rpc_res", to: f.from, id: f.id, ...res });
      } else if (f.t === "gossip") gossip.push(f.item);
    };
    // Bloque para que el ligero conozca la cabeza (la puerta se lo resume en "head", no le manda el bloque).
    await until(() => router.peers().length === 1, 2000, "completo conectado");

    // ---- Nodo ligero
    const light = new V.LightNode({ keys: lightKeys, name: "móvil", url: "mem://hub", socket });
    light.start();
    await until(() => router.peers().some((p) => p.node === lightKeys.address && p.kind === "light"), 2000, "ligero conectado");
    await until(() => txs.length === 1, 3000, "alta del ligero");
    const reg = txs[0] as V.RegisterTx;
    expect(reg.type).toBe("register");
    expect(reg.kind).toBe("light");
    expect(V.checkTx(reg)).toBeNull();
    await light.ensureRegistered().catch(() => {});
    (light as any).registering = 0;
    await light.ensureRegistered();
    expect(light.registered).toBe(true);

    // La puerta no reenvía bloques al ligero, solo la cabeza.
    let gotBlock = false;
    const unsub = (light as any).onFrame.bind(light);
    (light as any).onFrame = (f: any) => { if (f.t === "gossip" && f.item.kind === "block") gotBlock = true; unsub(f); };
    fsend({ t: "gossip", item: { kind: "block", block: { hash: "h1", header: { height: 41, ts: Date.now() }, txs: [], receipts: [], presence: [], rewards: [] } } });
    await until(() => light.head.height === 41, 2000, "cabeza");
    expect(gotBlock).toBe(false);

    // ---- Foto del sorteo: solo el ligero → todos los trozos le tocan a él (como carrier y courier).
    snapshot = V.makeSnapshot(1, "baliza", [{ node: lightKeys.address, kind: "light" }]);
    await light.refreshEpoch();
    expect(light.snapshot?.epoch).toBe(1);

    const [alice, bob] = [newAccount("alice"), newAccount("bob")];
    const ca = new V.VelumClient({ account: alice, contacts: [bob.deviceList], url: "mem://hub", socket });
    const cb = new V.VelumClient({ account: bob, contacts: [alice.deviceList], url: "mem://hub", socket });
    const got: V.IncomingMessage[] = [];
    cb.on("message", (m) => got.push(m));
    ca.connect(); cb.connect();
    await until(() => ca.status === "online" && cb.status === "online", 2000, "clientes");
    await new Promise((r) => setTimeout(r, 50));

    const p = await ca.send(bob.identity.address, { kind: "text", body: "hola por el móvil" });
    expect(p.error).toBeUndefined();
    await until(() => got.some((m) => m.payload.body === "hola por el móvil"), 5000, "mensaje");
    const m = got.find((x) => x.payload.body === "hola por el móvil")!;
    expect(m.nodes).toEqual([lightKeys.address]); // el carrier sorteado lo aceptó
    // Los trozos llevan la época del sorteo y se propagan al resto de la red.
    expect(gossip.some((g) => g.kind === "shard" && g.shard.ep === 1 && g.carrier === lightKeys.address)).toBe(true);
    // Recibos al repartidor sorteado (el ligero): los acepta, borra sus trozos y los propaga.
    await until(() => light.counters.receiptsAccepted > 0, 5000, "recibos");
    const rec = gossip.filter((g): g is Extract<V.GossipItem, { kind: "receipt" }> => g.kind === "receipt");
    expect(rec.length).toBeGreaterThan(0);
    for (const g of rec) {
      expect(g.receipt.courier).toBe(lightKeys.address);
      expect(g.receipt.carrier).toBe(lightKeys.address);
      expect(g.receipt.ep).toBe(1);
      expect(V.checkReceiptProof(g.receipt)).toBe(true);
    }
    // v3: el ligero apunta hojas de trabajo y, al entrar la cabeza en la época siguiente, reclama.
    await until(() => Object.values(light.work.counts()).some((n) => n > 0), 3000, "hojas de trabajo");
    const before = txs.length;
    fsend({ t: "gossip", item: { kind: "block", block: { hash: "h2", header: { height: 60, ts: Date.now() }, txs: [], receipts: [], presence: [], rewards: [] } } });
    await until(() => txs.slice(before).some((x) => x.type === "work.claim"), 5000, "work.claim del ligero");
    const claim = txs.slice(before).find((x) => x.type === "work.claim") as V.WorkClaimTx;
    expect(claim.from).toBe(lightKeys.address);
    expect(claim.epoch).toBe(1);
    expect(V.checkTx(claim)).toBeNull();
    // Recibo con secreto falso: no se acepta.
    const bad = { ...rec[0]!.receipt, shard: "otro", secret: "00".repeat(32) };
    const r = await cb.rpc("receipt.submit", { receipts: [bad] }, lightKeys.address);
    expect(r.accepted).toBe(0);
    // Métodos que un ligero no sirve.
    await expect(cb.rpc("account.get", { address: "x" }, lightKeys.address)).rejects.toThrow();
    // Un trozo mal formado se rechaza.
    await expect(cb.rpc("shard.put", { shard: { id: "x" } as any }, lightKeys.address)).rejects.toThrow();
    // Topes: el ligero no guarda más de maxShards.
    expect(light.stats().shardsStored).toBeLessThanOrEqual(2_000);

    ca.close(); cb.close(); light.stop(); fs.close();
  });

  test("almacén en memoria: tope por buzón y desalojo del que antes caduca", () => {
    const st = new V.MemoryLightStore();
    const mk = (id: string, mb: string, exp: number) => ({ id, mailbox: mb, mbAuth: "a", exp, carrier: "c" }) as V.LightShard;
    st.put(mk("1", "m", 100)); st.put(mk("2", "m", 50)); st.put(mk("3", "n", 200));
    expect(st.countMailbox("m")).toBe(2);
    expect(st.evictOldest()).toBe(true);
    expect(st.get("2")).toBeUndefined();
    expect(st.prune(150)).toBe(1);
    expect(st.count()).toBe(1);
  });
});
