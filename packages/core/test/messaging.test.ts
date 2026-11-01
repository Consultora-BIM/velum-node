// Mensajería v2 (docs/protocolo-v2.md §1–6): claves, sobre poscuántico, dispositivos, relleno,
// Reed–Solomon, buzones que rotan, recibos anónimos, vinculación por QR y grupos.
import { describe, expect, test } from "bun:test";
import * as V from "../src";

// ---------- Utilidades ----------
const PHRASE = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon art";

function newAccount(name: string, devices = 1) {
  const keys = V.keysFromPhrase(V.generatePhrase());
  const devs = Array.from({ length: devices }, (_, i) => V.createDevice(`${name}-${i}`));
  let acc = V.createAccount(keys, devs[0]!);
  const accounts = [acc];
  for (const d of devs.slice(1)) {
    const list = V.addDevice(keys.identity.secret, acc.deviceList, V.deviceEntry(d, keys.mailboxBase));
    accounts.forEach((a, i) => (accounts[i] = { ...a, deviceList: list }));
    accounts.push({ ...acc, device: d, cert: V.signDeviceCert(keys.identity.secret, keys.identity.address, d), deviceList: list });
    acc = accounts[0]!;
  }
  return accounts;
}

const text = (body: string, a: V.VelumAccount, to: string): V.Payload =>
  ({ v: 2, id: V.newMessageId(), from: a.identity.address, dev: a.device.id, to, ts: Date.now(), kind: "text", body });

/** Bytes aleatorios de cualquier tamaño (randomBytes tiene tope de 64 KB). */
function rnd(n: number) {
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(out.subarray(i, Math.min(n, i + 65536)));
  return out;
}

async function until(cond: () => boolean, ms = 5_000, what = "condición") {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error(`Tiempo agotado esperando ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

// ---------- Red en memoria: puerta + 3 nodos con la lógica v2 del nodo ----------
class FakeHub {
  nodes: V.PeerInfo[] = ["velNodoA", "velNodoB", "velNodoC"].map((node) => ({ node, name: node, version: "2", height: 0, since: 0 }));
  store = new Map<string, V.Shard & { carrier: string }>();
  subs: { sock: FakeSock; mailbox: string; auth: string; node: string }[] = [];
  receipts: V.ReceiptV2[] = [];
  rejected = 0;
  down = new Set<string>();
  connects: string[] = [];
  socket = (url: string) => new FakeSock(this, url);

  rpc(sock: FakeSock, f: { id: string; method: string; params: any; node?: string }) {
    const node = f.node ?? this.nodes[0]!.node;
    const reply = (result?: unknown, error?: string) => sock.deliver({ t: "rpc_res", id: f.id, result, error, node });
    switch (f.method) {
      case "shard.put": {
        const s = { ...(f.params.shard as V.Shard), carrier: node };
        this.store.set(s.id, s);
        for (const sub of this.subs) if (sub.mailbox === s.mailbox && sub.auth === s.mbAuth) sub.sock.deliver({ t: "push", node: sub.node, event: "shard", data: s });
        return reply({ ok: true, carrier: node });
      }
      case "mailbox.open": {
        const out: (V.Shard & { carrier: string })[] = [];
        for (const m of f.params.mailboxes as V.MailboxOpen[]) {
          if (!V.verifyOpenProof(m)) return reply(undefined, "Prueba de buzón no válida");
          if (!this.subs.some((x) => x.sock === sock && x.mailbox === m.mailbox && x.node === node)) this.subs.push({ sock, mailbox: m.mailbox, auth: m.auth, node });
          for (const s of this.store.values()) if (s.mailbox === m.mailbox && s.mbAuth === m.auth) out.push(s);
        }
        return reply({ shards: out, courier: node });
      }
      case "receipt.submit": {
        let accepted = 0;
        for (const r of f.params.receipts as V.ReceiptV2[]) {
          const s = this.store.get(r.shard);
          if (V.checkReceiptProof(r) && s && s.rh === r.rh) { this.store.delete(r.shard); this.receipts.push(r); accepted++; }
          else this.rejected++;
        }
        return reply({ accepted });
      }
      default:
        return reply(undefined, "Método desconocido");
    }
  }
}

class FakeSock implements V.Socket {
  readyState = 0;
  onopen: ((e: unknown) => void) | null = null;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onclose: ((e: unknown) => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  constructor(private hub: FakeHub, readonly url: string) {
    hub.connects.push(url);
    setTimeout(() => {
      if ([...hub.down].some((d) => url.startsWith(d))) { this.readyState = 3; this.onclose?.({}); return; }
      this.readyState = 1;
      this.onopen?.({});
      this.deliver({ t: "welcome", client: "c", nodes: hub.nodes });
    }, 1);
  }
  send(data: string) {
    const f = JSON.parse(data);
    queueMicrotask(() => this.hub.rpc(this, f));
  }
  deliver(f: unknown) {
    if (this.readyState !== 1) return;
    const s = JSON.stringify(f);
    queueMicrotask(() => this.onmessage?.({ data: s }));
  }
  close() {
    this.readyState = 3;
    this.hub.subs = this.hub.subs.filter((x) => x.sock !== this);
    queueMicrotask(() => this.onclose?.({}));
  }
}

// ---------- 1. Frase y claves ----------
describe("frase de recuperación", () => {
  test("la misma frase da siempre las mismas claves, separadas por uso", () => {
    const a = V.keysFromPhrase(PHRASE), b = V.keysFromPhrase("  " + PHRASE.toUpperCase().replace(/ /g, "   ") + " ");
    expect(a.identity.address).toBe(b.identity.address);
    expect(a.wallet.address).toBe(b.wallet.address);
    expect(a.mailboxBase).toBe(b.mailboxBase);
    expect(a.identity.address).not.toBe(a.wallet.address);
    expect(V.walletFromSeed(V.seedFromPhrase(PHRASE), 1).address).not.toBe(a.wallet.address);
    expect(a.mailboxBase).toMatch(/^[0-9a-f]{64}$/);
  });

  test("24 palabras en cada idioma; el ruso usa la lista inglesa", () => {
    for (const lang of ["en", "es", "fr", "zh", "ru"] as const) {
      const p = V.generatePhrase(lang);
      expect(p.split(" ").length).toBe(24);
      expect(V.validatePhrase(p, lang)).toBe(lang === "ru" ? "en" : lang);
      expect(V.keysFromPhrase(p).identity.address).toBe(V.keysFromPhrase(p).identity.address);
    }
    expect(V.validatePhrase(PHRASE.replace(/art$/, "abandon"))).toBeNull(); // suma de control mala
    expect(V.validatePhrase("hola mundo")).toBeNull();
    expect(() => V.seedFromPhrase("no es una frase")).toThrow();
  });
});

// ---------- 2. Híbrido X25519 + ML-KEM-768 ----------
describe("cifrado poscuántico híbrido", () => {
  test("seal/open con el formato exacto y fallo si se manipula", () => {
    const k = V.hybridKeygen(), other = V.hybridKeygen();
    const msg = V.utf8ToBytes("hola cuántico 🔒");
    const sealed = V.hybridSeal(k.publicKey, msg);
    expect(sealed[0]).toBe(2);
    expect(sealed.length).toBe(1 + 32 + 1088 + 24 + msg.length + 16);
    expect(V.bytesToUtf8(V.hybridOpen(k.secretKey, sealed))).toBe("hola cuántico 🔒");
    expect(() => V.hybridOpen(other.secretKey, sealed)).toThrow();
    for (const pos of [1, 40, 1121 + 3, sealed.length - 1]) {
      const bad = sealed.slice();
      bad[pos]! ^= 1;
      expect(() => V.hybridOpen(k.secretKey, bad)).toThrow();
    }
  });

  test("claves deterministas desde semilla", () => {
    const seed = V.randomBytes(96);
    expect(V.bytesToHex(V.hybridKeygen(seed).publicKey.kem)).toBe(V.bytesToHex(V.hybridKeygen(seed).publicKey.kem));
  });
});

// ---------- 3. Dispositivos ----------
describe("lista de dispositivos", () => {
  test("firma de la identidad, máximo 5, versiones y certificados", () => {
    const [a] = newAccount("ana");
    const list = a!.deviceList;
    expect(V.verifyDeviceList(list, a!.identity.address)).toBe(true);
    expect(V.verifyDeviceList(list, V.keysFromPhrase(PHRASE).identity.address)).toBe(false);
    expect(V.verifyDeviceList({ ...list, devices: [{ ...list.devices[0]!, name: "pirata" }] })).toBe(false);
    const forged = V.signDeviceList(V.keysFromPhrase(PHRASE).identity.secret, a!.identity.address, list.devices, list.seq + 1);
    expect(V.verifyDeviceList(forged)).toBe(false);

    let l = list;
    for (let i = 0; i < 4; i++) l = V.addDevice(a!.identity.secret, l, V.deviceEntry(V.createDevice("d" + i), a!.mailboxBase));
    expect(l.devices.length).toBe(5);
    expect(V.isNewerDeviceList(list, l)).toBe(true);
    expect(V.isNewerDeviceList(l, list)).toBe(false);
    expect(() => V.addDevice(a!.identity.secret, l, V.deviceEntry(V.createDevice("sexto"), a!.mailboxBase))).toThrow();
    const removed = V.removeDevice(a!.identity.secret, l, l.devices[1]!.id);
    expect(removed.devices.length).toBe(4);
    expect(V.verifyDeviceList(removed)).toBe(true);

    expect(V.verifyDeviceCert(a!.cert)).toBe(true);
    expect(V.verifyDeviceCert({ ...a!.cert, device: "otro" })).toBe(false);
  });

  test("prellaves: rotan cada 24 h y se borran a los 7 días", () => {
    const t0 = Date.now();
    let d = V.createDevice("móvil", t0);
    expect(V.rotatePrekeys(d, t0 + 3_600_000).rotated).toBe(false);
    for (let day = 1; day <= 9; day++) d = V.rotatePrekeys(d, t0 + day * 86_400_000).keys;
    // actual + las retiradas en los últimos 7 días
    expect(d.prekeys.length).toBe(8);
    // Un sobre a la prellave de hace 3 días se sigue abriendo
    const [a] = newAccount("ana");
    const old = { ...V.deviceEntry(d, a!.mailboxBase), x25519: d.prekeys[3]!.x25519, kem: d.prekeys[3]!.kem };
    const [copy] = V.sealMessage({ device: a!.device, cert: a!.cert }, [old], text("rezagado", a!, "x"));
    expect(V.openMessage(d, copy!.bytes).payload.body).toBe("rezagado");
  });
});

// ---------- 4. Relleno ----------
describe("relleno y fragmentos", () => {
  test("un texto y una foto pequeña dan trozos idénticos en tamaño y número", () => {
    const [a] = newAccount("ana");
    const [b] = newAccount("beto");
    const sender = { device: a!.device, cert: a!.cert };
    const t = V.sealMessage(sender, b!.deviceList.devices, text("ok", a!, b!.identity.address))[0]!;
    const photo = { ...text("", a!, b!.identity.address), kind: "image" as const, blob: V.b64(V.randomBytes(150)), mime: "image/jpeg" };
    const p = V.sealMessage(sender, b!.deviceList.devices, photo)[0]!;
    expect(t.bytes.length).toBe(2048);
    expect(p.bytes.length).toBe(2048);
    const opts = (c: V.SealedCopy) => ({ ...V.mailboxTarget(b!.deviceList.devices[0]!), rseed: c.rseed });
    const st = V.splitIntoShards(t.bytes, opts(t)), sp = V.splitIntoShards(p.bytes, opts(p));
    expect(st.length).toBe(5);
    expect(sp.length).toBe(5);
    expect(new Set([...st, ...sp].map((s) => s.data.length)).size).toBe(1);
    expect(st.every((s) => !("size" in s))).toBe(true);
    // Fotos de 3 KB y de 5 KB: mismo cubo (8 KB), indistinguibles
    const f3 = V.sealMessage(sender, b!.deviceList.devices, { ...photo, blob: V.b64(V.randomBytes(3000)) })[0]!;
    const f5 = V.sealMessage(sender, b!.deviceList.devices, { ...photo, blob: V.b64(V.randomBytes(5000)) })[0]!;
    expect([f3.bytes.length, f5.bytes.length]).toEqual([8192, 8192]);
    // Cubos y trozos
    expect(V.BUCKETS.map((x) => V.shardSizeFor(x) / 1024)).toEqual([1, 3, 11, 24, 24, 24, 24]);
    expect(V.bucketFor(2048)).toBe(2048);
    expect(V.bucketFor(2049)).toBe(8192);
    expect(() => V.bucketFor(8 * 1024 * 1024 + 1)).toThrow();
    expect(Array.from(V.unpad(V.padToBucket(new Uint8Array([1, 2, 3]))))).toEqual([1, 2, 3]);
  });
});

// ---------- 5. Reed–Solomon ----------
describe("Reed–Solomon 3 de 5", () => {
  const pairs: [number, number][] = [];
  for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) pairs.push([i, j]);

  test("rsDecode recupera con cualquier par perdido (exhaustivo)", () => {
    const data = [V.randomBytes(1000), V.randomBytes(1000), V.randomBytes(1000)];
    const all = [...data, ...V.rsEncode(data, 5)];
    for (const [i, j] of pairs) {
      const got = V.rsDecode(all.map((s, k) => (k === i || k === j ? null : s)), 3);
      expect(got.map(V.bytesToHex)).toEqual(data.map(V.bytesToHex));
    }
    expect(() => V.rsDecode([all[0]!, null, null, null, all[4]!], 3)).toThrow();
  });

  test("sobre de 128 KB (varias franjas): cualquier par perdido en cada franja", () => {
    const sealed = rnd(128 * 1024);
    const shards = V.splitIntoShards(sealed, { mailbox: "mb", mbAuth: "00", rseed: V.bytesToHex(V.randomBytes(32)) });
    expect(new Set(shards.map((s) => s.stripe)).size).toBe(2);
    for (const [i, j] of pairs) {
      for (const [x, y] of pairs) {
        const kept = shards.filter((s) => (s.stripe === 0 ? s.idx !== i && s.idx !== j : s.idx !== x && s.idx !== y));
        expect(V.bytesToHex(V.joinShards(kept)!)).toBe(V.bytesToHex(sealed));
      }
    }
    expect(V.joinShards(shards.filter((s) => !(s.stripe === 1 && s.idx < 3)))).toBeNull();
    expect(V.shardProgress(shards.slice(0, 4))).toEqual({ have: 3, total: 6 });
  });
});

// ---------- 6. Buzones ----------
describe("buzones que rotan", () => {
  test("cambian cada día, solo el dueño los abre y el nodo no lo identifica", () => {
    const [a] = newAccount("ana");
    const entry = a!.deviceList.devices[0]!;
    const mb = V.mailboxOfDevice(a!.device, a!.mailboxBase);
    expect(mb.seed).toBe(entry.mailboxSeed);
    const now = Date.now();
    const today = V.mailboxTarget(entry, now), tomorrow = V.mailboxTarget(entry, now + 86_400_000);
    expect(today.mailbox).toMatch(/^[0-9a-f]{40}$/);
    expect(today.mailbox).not.toBe(tomorrow.mailbox);
    expect(today.mbAuth).not.toBe(tomorrow.mbAuth); // no enlazable entre días

    const opens = V.mailboxesToOpen(mb, now);
    expect(opens.map((o) => o.mailbox)).toEqual([today.mailbox, V.mailboxTarget(entry, now - 86_400_000).mailbox]);
    expect(opens[0]!.auth).toBe(today.mbAuth); // el emisor calcula lo mismo sin conocer el secreto
    expect(opens.every((o) => V.verifyOpenProof(o, now))).toBe(true);
    expect(V.verifyOpenProof(opens[0]!, now + 20 * 60_000)).toBe(false); // fuera de plazo
    expect(V.verifyOpenProof({ ...opens[0]!, mailbox: tomorrow.mailbox }, now)).toBe(false);

    // Un contacto conoce mailboxSeed y mbPub, pero no el escalar: no puede abrir.
    const fake = V.openProof({ ...mb, scalar: V.bytesToHex(V.randomBytes(31)) + "00" }, today.mailbox, now);
    expect(V.verifyOpenProof(fake, now)).toBe(true); // firma válida… para OTRA clave
    expect(fake.auth).not.toBe(today.mbAuth); // …que no coincide con la de los trozos

    // Rotar la sal (expulsión) cambia el buzón
    const rotated = V.rotateMailbox(a!.device);
    expect(V.mailboxOfDevice(rotated, a!.mailboxBase).seed).not.toBe(mb.seed);
  });
});

// ---------- 7. Recibos anónimos ----------
describe("recibos anónimos", () => {
  test("solo quien abre el sobre puede pagar y no se pueden falsificar", () => {
    const [a] = newAccount("ana");
    const [b] = newAccount("beto");
    const copy = V.sealMessage({ device: a!.device, cert: a!.cert }, b!.deviceList.devices, text("hola", a!, b!.identity.address))[0]!;
    const shards = V.splitIntoShards(copy.bytes, { ...V.mailboxTarget(b!.deviceList.devices[0]!), rseed: copy.rseed });
    const opened = V.openMessage(b!.device, V.joinShards(shards)!);
    expect(opened.rseed).toBe(copy.rseed);
    for (const s of shards) {
      const r: V.ReceiptV2 = { shard: s.id, mailbox: s.mailbox, rh: s.rh, secret: V.receiptSecret(opened.rseed, s.id), carrier: "n1", courier: "n2", ts: Date.now() };
      expect(V.checkReceiptProof(r)).toBe(true);
      expect(JSON.stringify(r)).not.toContain(b!.identity.address);
      expect(V.checkReceiptProof({ ...r, secret: V.bytesToHex(V.randomBytes(32)) })).toBe(false);
    }
    // El secreto de un trozo no sirve para otro
    expect(V.receiptHash(V.receiptSecret(opened.rseed, shards[0]!.id))).not.toBe(shards[1]!.rh);
    // Cada copia (dispositivo) tiene su propia semilla
    const two = V.sealMessage({ device: a!.device, cert: a!.cert }, [...b!.deviceList.devices, ...b!.deviceList.devices], text("x", a!, "y"));
    expect(two[0]!.rseed).not.toBe(two[1]!.rseed);
  });
});

// ---------- 8. Grupos y multidispositivo ----------
describe("grupos", () => {
  test("3 miembros con 2 dispositivos cada uno: cada dispositivo lo descifra", () => {
    const [ana1, ana2] = newAccount("ana", 2);
    const members = [newAccount("beto", 2), newAccount("carla", 2), newAccount("dani", 2)];
    const targets = V.fanOutTargets(members.map((m) => m[0]!.deviceList), ana1!.deviceList, ana1!.device.id);
    expect(targets.length).toBe(7); // 6 de los miembros + mi otro dispositivo
    expect(targets.some((t) => t.id === ana1!.device.id)).toBe(false);
    const p = { ...text("hola grupo", ana1!, "grp1"), group: "grp1" };
    const copies = V.sealMessage({ device: ana1!.device, cert: ana1!.cert }, targets, p);
    expect(new Set(copies.map((c) => c.bytes.length)).size).toBe(1); // todas iguales que un 1 a 1
    const all = [...members.flat(), ana2!];
    for (const acc of all) {
      const mine = copies.filter((c) => c.device.id === acc.device.id);
      expect(mine.length).toBe(1);
      const o = V.openMessage(acc.device, mine[0]!.bytes);
      expect(o.payload.body).toBe("hola grupo");
      expect(o.payload.from).toBe(ana1!.identity.address);
      expect(o.cert.device).toBe(ana1!.device.id);
      // y no abre la copia de otro
      expect(() => V.openMessage(acc.device, copies.find((c) => c.device.id !== acc.device.id)!.bytes)).toThrow();
    }
  });

  test("firma: otro dispositivo no puede hacerse pasar por el remitente", () => {
    const [a] = newAccount("ana");
    const [b] = newAccount("beto");
    const [eve] = newAccount("eva");
    // Eva firma con su dispositivo pero presenta el certificado de Ana
    const copy = V.sealMessage({ device: eve!.device, cert: a!.cert }, b!.deviceList.devices, { ...text("soy ana", a!, b!.identity.address) })[0]!;
    expect(() => V.openMessage(b!.device, copy.bytes)).toThrow();
  });
});

// ---------- 9. Cliente completo sobre la red en memoria ----------
describe("cliente v2 en red simulada", () => {
  test("1 a 1 con recibos anónimos y copia a mis otros dispositivos", async () => {
    const hub = new FakeHub();
    const [ana1, ana2] = newAccount("ana", 2);
    const [beto] = newAccount("beto");
    const mk = (acc: V.VelumAccount, contacts: V.DeviceList[]) => new V.VelumClient({ account: acc, contacts, url: "wss://hub.test/hub", socket: hub.socket });
    const A1 = mk(ana1!, [beto!.deviceList]), A2 = mk(ana2!, [beto!.deviceList]), B = mk(beto!, [ana1!.deviceList]);
    const got: Record<string, V.IncomingMessage[]> = { A1: [], A2: [], B: [] };
    A1.on("message", (m) => got.A1!.push(m));
    A2.on("message", (m) => got.A2!.push(m));
    B.on("message", (m) => got.B!.push(m));
    for (const c of [A1, A2, B]) c.connect();
    await until(() => [A1, A2, B].every((c) => c.status === "online"), 2000, "conexión");
    await new Promise((r) => setTimeout(r, 30));

    const prog = await A1.send(beto!.identity.address, { kind: "text", body: "hola beto" });
    expect(prog.error).toBeUndefined();
    expect(prog.copies).toBe(2); // Beto + mi otro móvil
    await until(() => got.B!.length > 0 && got.A2!.some((m) => m.outgoing), 3000, "entrega");
    expect(got.B![0]!.payload.body).toBe("hola beto");
    expect(got.B![0]!.outgoing).toBe(false);
    expect(got.A2!.find((m) => m.outgoing)!.payload.to).toBe(beto!.identity.address);
    // Acuse de entregado (cifrado) de vuelta a Ana
    await until(() => got.A1!.some((m) => m.payload.kind === "receipt"), 3000, "acuse");
    expect(got.A1!.find((m) => m.payload.kind === "receipt")!.payload.status).toBe("delivered");
    // Recibos anónimos aceptados y trozos borrados
    await until(() => hub.receipts.length >= 10, 3000, "recibos");
    expect(hub.rejected).toBe(0);
    for (const r of hub.receipts) expect(JSON.stringify(r)).not.toContain(beto!.identity.address);
    for (const c of [A1, A2, B]) c.close();
  });

  test("vinculación completa por QR que rota: código igual, secretos e historial", async () => {
    const hub = new FakeHub();
    const [ana] = newAccount("ana");
    const [carla] = newAccount("carla");
    const A = new V.VelumClient({ account: ana!, contacts: [carla!.deviceList], url: "wss://hub.test/hub", socket: hub.socket });
    const C = new V.VelumClient({ account: carla!, contacts: [ana!.deviceList], url: "wss://hub.test/hub", socket: hub.socket });
    const B = new V.VelumClient({ url: "wss://hub.test/hub", socket: hub.socket }); // móvil nuevo, sin cuenta
    for (const c of [A, B, C]) c.connect();
    await until(() => [A, B, C].every((c) => c.status === "online"), 2000, "conexión");

    const evA: V.LinkEvent[] = [], evB: V.LinkEvent[] = [];
    A.on("link", (e) => evA.push(e));
    B.on("link", (e) => evB.push(e));
    let carlaSaw: V.DeviceList | null = null;
    C.on("contact", (l) => (carlaSaw = l));

    await A.startLink();
    const frame = evA.find((e) => e.stage === "frame") as { qr: string };
    expect(frame.qr.startsWith("velum-link:v2:")).toBe(true);
    // Un QR manipulado no sirve
    expect(() => V.parseLinkFrame(frame.qr.replace("velum-link:v2", "velum-link:v1"))).toThrow();

    await B.joinLink(frame.qr, "iPad");
    await until(() => evA.some((e) => e.stage === "code") && evB.some((e) => e.stage === "code"), 3000, "código");
    const codeA = (evA.find((e) => e.stage === "code") as { code: string }).code;
    const codeB = (evB.find((e) => e.stage === "code") as { code: string }).code;
    expect(codeA).toMatch(/^\d{6}$/);
    expect(codeA).toBe(codeB);

    const history = Array.from({ length: 3000 }, (_, i) => ({ id: i, chat: "carla", body: `mensaje ${i} ${"x".repeat(i % 50)}` }));
    await A.confirmLink({ contacts: [carla!.deviceList], history });
    await until(() => evB.some((e) => e.stage === "done") && evA.some((e) => e.stage === "done"), 5000, "vínculo");
    const done = evB.find((e) => e.stage === "done") as { account: V.VelumAccount; blobs: Record<string, any> };
    expect(done.account.identity.address).toBe(ana!.identity.address);
    expect(done.account.wallet.address).toBe(ana!.wallet.address);
    expect(done.blobs.history.length).toBe(3000);
    expect(done.blobs.history[2999].body).toBe(history[2999]!.body);
    expect(A.account!.deviceList.devices.length).toBe(2);
    expect(V.verifyDeviceList(A.account!.deviceList, ana!.identity.address)).toBe(true);
    for (const l of done.blobs.contacts as V.DeviceList[]) B.setContact(l);

    // Carla recibe la lista nueva de Ana y su mensaje llega a los DOS dispositivos de Ana
    await until(() => carlaSaw?.devices.length === 2, 3000, "perfil nuevo");
    const inA: V.IncomingMessage[] = [], inB: V.IncomingMessage[] = [];
    A.on("message", (m) => inA.push(m));
    B.on("message", (m) => inB.push(m));
    await C.send(ana!.identity.address, { kind: "text", body: "¿me lees en los dos?" });
    await until(() => inA.some((m) => m.payload.body === "¿me lees en los dos?") && inB.some((m) => m.payload.body === "¿me lees en los dos?"), 3000, "multidispositivo");
    for (const c of [A, B, C]) c.close();
  });

  test("expulsar un dispositivo: lista nueva y buzones rotados", async () => {
    const hub = new FakeHub();
    const [a1, a2, a3] = newAccount("ana", 3);
    const mk = (acc: V.VelumAccount) => new V.VelumClient({ account: acc, url: "wss://hub.test/hub", socket: hub.socket });
    const A1 = mk(a1!), A2 = mk(a2!);
    for (const c of [A1, A2]) c.connect();
    await until(() => [A1, A2].every((c) => c.status === "online"), 2000, "conexión");
    const oldSeed2 = a2!.deviceList.devices.find((d) => d.id === a2!.device.id)!.mailboxSeed;
    const list = await A1.removeDevice(a3!.device.id);
    expect(list.devices.some((d) => d.id === a3!.device.id)).toBe(false);
    await until(() => A2.account!.deviceList.devices.find((d) => d.id === a2!.device.id)?.mailboxSeed !== oldSeed2, 3000, "rotación en A2");
    expect(A2.account!.deviceList.devices.length).toBe(2);
    for (const c of [A1, A2]) c.close();
  });

  test("cambia de puerta si la primera no responde y se queda con la que funciona", async () => {
    const hub = new FakeHub();
    hub.down.add("wss://bloqueada.test");
    const [a] = newAccount("ana");
    const c = new V.VelumClient({ account: a!, url: ["wss://bloqueada.test/hub", "wss://buena.test/hub"], socket: hub.socket });
    c.connect();
    await until(() => c.status === "online", 3000, "segunda puerta");
    expect(c.url).toBe("wss://buena.test/hub");
    c.close();
    expect(new V.VelumClient().url).toBe(V.GATEWAYS[0]);
  });
});

// ---------- 10. Rendimiento ----------
test("rendimiento (ms)", () => {
  const [a] = newAccount("ana");
  const [b] = newAccount("beto");
  const sender = { device: a!.device, cert: a!.cert };
  const time = (f: () => void, n = 5) => { f(); const t = performance.now(); for (let i = 0; i < n; i++) f(); return +((performance.now() - t) / n).toFixed(2); };
  const t = text("hola, ¿qué tal?", a!, b!.identity.address);
  const photo = { ...t, kind: "image" as const, blob: V.b64(rnd(1024 * 1024)), mime: "image/jpeg" };
  let ct!: V.SealedCopy, cp!: V.SealedCopy;
  const r = {
    sealText: time(() => { ct = V.sealMessage(sender, b!.deviceList.devices, t)[0]!; }),
    openText: time(() => V.openMessage(b!.device, ct.bytes)),
    sealPhoto1MB: time(() => { cp = V.sealMessage(sender, b!.deviceList.devices, photo)[0]!; }, 3),
    openPhoto1MB: time(() => V.openMessage(b!.device, cp.bytes), 3),
  } as Record<string, number>;
  const big = rnd(2 * 1024 * 1024);
  let shards!: V.Shard[];
  r.rsEncode2MB = time(() => { shards = V.splitIntoShards(big, { mailbox: "m", mbAuth: "a", rseed: "00".repeat(32) }); }, 3);
  const lossy = shards.filter((s) => s.idx !== 0 && s.idx !== 2);
  r.rsDecode2MB_2perdidos = time(() => V.joinShards(lossy), 3);
  r.rsEncodeSolo2MB = time(() => {
    const k = 699_050;
    V.rsEncode([big.subarray(0, k), big.subarray(k, 2 * k), big.subarray(2 * k, 3 * k)], 5);
  }, 3);
  console.log("rendimiento", JSON.stringify(r), "bytes foto:", cp.bytes.length);
  expect(cp.bytes.length).toBe(2 * 1024 * 1024);
});

// ---------- 11. Identidad v3: vínculo inverso, solicitudes de contacto e invitaciones ----------
describe("identidad v3 en red simulada", () => {
  test("vinculación inversa: el dispositivo nuevo muestra el QR y el activo lo escanea", async () => {
    const hub = new FakeHub();
    const [ana] = newAccount("ana");
    const A = new V.VelumClient({ account: ana!, url: "wss://hub.test/hub", socket: hub.socket });
    const D = new V.VelumClient({ url: "wss://hub.test/hub", socket: hub.socket }); // escritorio sin cámara
    for (const c of [A, D]) c.connect();
    await until(() => [A, D].every((c) => c.status === "online"), 2000, "conexión");
    const evA: V.LinkEvent[] = [], evD: V.LinkEvent[] = [];
    A.on("link", (e) => evA.push(e));
    D.on("link", (e) => evD.push(e));
    await D.startReverseLink("Escritorio");
    const frame = evD.find((e) => e.stage === "frame") as { qr: string };
    expect(frame.qr.startsWith("velum-link:v3r:")).toBe(true);
    expect(() => new V.LinkGuest(frame.qr, "x")).toThrow(); // un QR inverso no se «une» como v2
    await A.scanReverseLink(frame.qr);
    await until(() => evA.some((e) => e.stage === "code") && evD.some((e) => e.stage === "code"), 3000, "código");
    expect((evA.find((e) => e.stage === "code") as { code: string }).code).toBe((evD.find((e) => e.stage === "code") as { code: string }).code);
    await A.confirmLink({ notes: ["hola"] });
    await until(() => evD.some((e) => e.stage === "done") && evA.some((e) => e.stage === "done"), 5000, "vínculo inverso");
    const done = evD.find((e) => e.stage === "done") as { account: V.VelumAccount; blobs: Record<string, any> };
    expect(done.account.identity.address).toBe(ana!.identity.address);
    expect(done.blobs.notes).toEqual(["hola"]);
    expect(A.account!.deviceList.devices.length).toBe(2);
    for (const c of [A, D]) c.close();
  });

  test("solicitud de contacto con la tarjeta (enlace /c/) y aceptación", async () => {
    const hub = new FakeHub();
    const [ana] = newAccount("ana");
    const [beto] = newAccount("beto");
    const A = new V.VelumClient({ account: ana!, url: "wss://hub.test/hub", socket: hub.socket });
    const B = new V.VelumClient({ account: beto!, url: "wss://hub.test/hub", socket: hub.socket });
    for (const c of [A, B]) c.connect();
    await until(() => [A, B].every((c) => c.status === "online"), 2000, "conexión");
    await new Promise((r) => setTimeout(r, 30));
    const link = B.myCardLink();
    expect(link.startsWith("https://velumprotocol.org/c/")).toBe(true);
    const reqs: V.ContactRequest[] = [];
    B.on("request", (r) => reqs.push(r));
    const anaGot: V.DeviceList[] = [];
    A.on("contact", (l) => anaGot.push(l));
    await A.sendContactRequest(link, "soy Ana, del curro");
    await until(() => reqs.length > 0, 3000, "solicitud");
    expect(reqs[0]!.from).toBe(ana!.identity.address);
    expect(reqs[0]!.note).toBe("soy Ana, del curro");
    await B.acceptContactRequest(reqs[0]!);
    expect(B.contacts.has(ana!.identity.address)).toBe(true);
    await until(() => anaGot.some((l) => l.identity === beto!.identity.address), 3000, "perfil de vuelta");
    const got: V.IncomingMessage[] = [];
    B.on("message", (m) => got.push(m));
    await A.send(beto!.identity.address, { kind: "text", body: "¡ya podemos hablar!" });
    await until(() => got.some((m) => m.payload.body === "¡ya podemos hablar!"), 3000, "primer mensaje");
    expect(hub.rejected).toBe(0);
    for (const c of [A, B]) c.close();
  });

  test("invitación de un solo uso: mensajes pendientes 24 h y contacto en los dos sentidos", async () => {
    const hub = new FakeHub();
    const [ana] = newAccount("ana");
    const A = new V.VelumClient({ account: ana!, url: "wss://hub.test/hub", socket: hub.socket });
    A.connect();
    await until(() => A.status === "online", 2000, "conexión");
    const inv = await A.createInvite([{ kind: "text", body: "te escribo antes de que tengas la app" }]);
    expect(inv.link.startsWith("https://velumprotocol.org/i/")).toBe(true);
    const pending = [...hub.store.values()];
    expect(pending.length).toBeGreaterThan(0);
    for (const s of pending) expect(s.exp - Date.now()).toBeLessThanOrEqual(V.INVITE_TTL_MS);
    // Luis instala la app más tarde y abre el enlace.
    const [luis] = newAccount("luis");
    const L = new V.VelumClient({ account: luis!, url: "wss://hub.test/hub", socket: hub.socket });
    const msgs: V.IncomingMessage[] = [];
    const invites: { from: string }[] = [];
    L.on("message", (m) => msgs.push(m));
    L.on("invite", (i) => invites.push(i));
    const anaSaw: V.DeviceList[] = [];
    A.on("contact", (l) => anaSaw.push(l));
    L.connect();
    await until(() => L.status === "online", 2000, "conexión de Luis");
    await L.redeemInvite(inv.link);
    await until(() => invites.length > 0 && msgs.some((m) => m.payload.body === "te escribo antes de que tengas la app"), 3000, "canje");
    expect(invites[0]!.from).toBe(ana!.identity.address);
    expect(L.contacts.has(ana!.identity.address)).toBe(true);
    await until(() => anaSaw.some((l) => l.identity === luis!.identity.address), 3000, "Ana recibe a Luis");
    for (const c of [A, L]) c.close();
  });
});
