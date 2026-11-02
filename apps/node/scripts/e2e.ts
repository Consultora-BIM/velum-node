// Prueba de punta a punta v2: puerta local + 3 nodos completos (subprocesos) + 1 nodo ligero (LightNode del núcleo),
// clientes con cuentas de frase (bob con 2 dispositivos), mensajes poscuánticos (texto, imagen de 1 MB, grupo de 3),
// sorteo público de rutas, recibos anónimos, recompensas, pagos, tokens, mercado, bolsas de token,
// reinicio y resincronización, y actualización OTA firmada (con una clave de PRUEBA).
//   bun apps/node/scripts/e2e.ts            (VELUM_E2E_KEEP=1 para no borrar los datos temporales)
import { mkdtempSync, rmSync, openSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as V from "@velum/core";
import { startDevHub } from "./devhub";
import { signManifest } from "./release";
import { checkAndApply, currentPlatform, onStartPending, verifyManifest, type Manifest } from "../src/update";

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const ROOT = mkdtempSync(join(tmpdir(), "velum-e2e-"));
const PORTS = [7431, 7432, 7433];
const url = (p: number) => `ws://localhost:${p}/ws`;
const EUR = 1_000_000; // precio: µtEUR por VEL (number)
const EURt = 1_000_000n; // 1 tEUR en unidades mínimas (BigInt)
/** Importes de la RPC (texto decimal) → BigInt. */
const big = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o ?? {}).map(([k, v]) => [k, BigInt(String(v))])) as Record<string, bigint>;

type Proc = ReturnType<typeof Bun.spawn>;
const procs: (Proc | null)[] = [null, null, null];
const results: { name: string; ok: boolean; detail?: string }[] = [];
const t0 = Date.now();
const el = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;
const say = (m: string) => console.log(`[e2e ${el()}] ${m}`);
const hub = startDevHub(0, join(ROOT, "download"));
mkdirSync(join(ROOT, "download"), { recursive: true });

function startNode(i: number) {
  const port = PORTS[i]!;
  const args = ["start", "--port", String(port), "--gateway", hub.url, "--name", `nodo-${i + 1}`, "--endpoint", url(port), "--no-auto-update"];
  if (i > 0) args.push("--peer", url(PORTS[i - 1]!)); // además, en línea: 2→1, 3→2
  const logFile = join(ROOT, `n${i + 1}.log`);
  const fd = openSync(logFile, "a");
  procs[i] = Bun.spawn(["bun", MAIN, ...args], {
    env: { ...process.env, VELUM_HOME: join(ROOT, `n${i + 1}`), VELUM_LOG: process.env.VELUM_LOG ?? "info", VELUM_LOG_TAG: `n${i + 1}`, VELUM_MANIFEST_URL: "http://127.0.0.1:1/none" },
    stdout: fd, stderr: fd,
  });
  say(`nodo ${i + 1} arrancado en :${port} (registro: ${logFile})`);
}

async function stopNode(i: number) {
  const p = procs[i];
  if (!p) return;
  p.kill("SIGTERM");
  await p.exited;
  procs[i] = null;
}

async function status(i: number): Promise<any | null> {
  try { return await (await fetch(`http://localhost:${PORTS[i]}/status`)).json(); } catch { return null; }
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, timeoutMs: number, everyMs = 500): Promise<T> {
  const end = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < end) {
    try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; }
    await Bun.sleep(everyMs);
  }
  throw new Error(`tiempo agotado esperando: ${what}${last ? ` (${(last as Error).message})` : ""}`);
}

async function check(name: string, fn: () => Promise<string | void>) {
  try {
    const detail = await fn();
    results.push({ name, ok: true, detail: detail || undefined });
    say(`OK   ${name}${detail ? " — " + detail : ""}`);
  } catch (e) {
    results.push({ name, ok: false, detail: (e as Error).message });
    say(`FALLO ${name} — ${(e as Error).message}`);
    throw e;
  }
}

/** Cliente "monitor" (sin cuenta) por nodo, conectado directo, para leer la cadena por RPC. */
const monitors: V.VelumClient[] = [];
async function monitor(i: number): Promise<V.VelumClient> {
  monitors[i]?.close();
  const c = new V.VelumClient({ url: url(PORTS[i]!) });
  c.connect();
  await waitFor(`monitor ${i + 1} en línea`, async () => c.status === "online", 15_000, 100);
  monitors[i] = c;
  return c;
}
const m0 = () => monitors[0]!;

async function hashAt(i: number, h: number): Promise<string | null> {
  const b = await monitors[i]!.rpc("chain.block", { height: h });
  return b?.hash ?? null;
}

async function converged(idx: number[], minHeight = 1): Promise<number | null> {
  const st = await Promise.all(idx.map(status));
  if (st.some((s) => !s)) return null;
  const h = Math.min(...st.map((s) => s.height)) - 1;
  if (h < minHeight) return null;
  const hashes = await Promise.all(idx.map((i) => hashAt(i, h)));
  return hashes.every((x) => x && x === hashes[0]) ? h : null;
}

/** Cuenta con frase de 24 palabras y N dispositivos (cada uno con su VelumAccount). */
function accountFromPhrase(name: string, devices = 1): V.VelumAccount[] {
  const keys = V.keysFromPhrase(V.generatePhrase());
  const devs = Array.from({ length: devices }, (_, i) => V.createDevice(`${name}-${i + 1}`));
  let list = V.createAccount(keys, devs[0]!).deviceList;
  for (const d of devs.slice(1)) list = V.addDevice(keys.identity.secret, list, V.deviceEntry(d, keys.mailboxBase));
  return devs.map((d) => ({ ...keys, device: d, cert: V.signDeviceCert(keys.identity.secret, keys.identity.address, d), deviceList: list }));
}

const faucet = V.faucetKeyPair();
async function submit(tx: V.Tx) { return m0().rpc("tx.submit", { tx }); }
async function nonceOf(addr: string) { const a = await m0().rpc("account.get", { address: addr }); return a.nonce + a.pending; }
async function bal(addr: string) { return big(await m0().rpc("account.balances", { address: addr })); }
async function waitTxs(addrs: string[]) {
  await waitFor("transacciones en bloque", async () => (await Promise.all(addrs.map((a) => m0().rpc("account.get", { address: a })))).every((a) => a.pending === 0), 30_000, 300);
}

const clients: V.VelumClient[] = [];
let light: V.LightNode | null = null;
let chatter: ReturnType<typeof setInterval> | null = null;

async function run() {
  say(`datos temporales en ${ROOT} · puerta local ${hub.url}`);
  for (let i = 0; i < 3; i++) startNode(i);
  await waitFor("paneles en marcha", async () => (await Promise.all([0, 1, 2].map(status))).every(Boolean), 15_000, 200);
  for (let i = 0; i < 3; i++) await monitor(i);

  // ---------------------------------------------------------------- red
  await check("los 3 nodos completos se dan de alta y convergen (puerta local + enlaces directos)", async () => {
    const h = await waitFor("convergencia", async () => {
      const st = await Promise.all([0, 1, 2].map(status));
      if (!st.every((s) => s?.registered && s.hubConnected)) return null;
      return converged([0, 1, 2], 3);
    }, 60_000);
    return `altura común #${h}`;
  });

  const lightKeys = V.keyPairFromText("e2e-ligero-" + Date.now());
  light = new V.LightNode({ keys: lightKeys, name: "movil-e2e", url: hub.url });
  light.start();
  await check("el nodo ligero entra por la puerta y se da de alta (register kind=light)", async () => {
    const n = await waitFor("alta del ligero", async () => {
      const x = await m0().rpc("node.get", { address: lightKeys.address });
      return x?.kind === "light" ? x : null;
    }, 40_000);
    await waitFor("ligero registrado", async () => light!.registered || (await light!.ensureRegistered().then(() => light!.registered)), 20_000);
    return `${n.name} · ${lightKeys.address.slice(0, 10)}…`;
  });

  // ---------------------------------------------------------------- cuentas y clientes
  const [alice] = accountFromPhrase("alice");
  const [bob1, bob2] = accountFromPhrase("bob", 2);
  const [carol] = accountFromPhrase("carol");
  const mk = (a: V.VelumAccount, contacts: V.DeviceList[]) => {
    const c = new V.VelumClient({ account: a, contacts, url: hub.url });
    clients.push(c);
    c.connect();
    return c;
  };
  const ca = mk(alice!, [bob1!.deviceList, carol!.deviceList]);
  const cb1 = mk(bob1!, [alice!.deviceList, carol!.deviceList]);
  const cb2 = mk(bob2!, [alice!.deviceList, carol!.deviceList]);
  const cc = mk(carol!, [alice!.deviceList, bob1!.deviceList]);
  await waitFor("clientes en línea", async () => clients.every((c) => c.status === "online"), 15_000, 100);
  const got = new Map<V.VelumClient, V.IncomingMessage[]>(clients.map((c) => [c, []]));
  for (const c of clients) c.on("message", (m) => got.get(c)!.push(m));
  const A = alice!.wallet.address, B = bob1!.wallet.address, C = carol!.wallet.address;

  // ---------------------------------------------------------------- dinero
  await check("grifo: VEL + 100 tEUR para probar el mercado", async () => {
    const r = await cb1.faucet();
    await waitTxs([faucet.address]);
    const b = await bal(B);
    if (b.VEL !== BigInt(r.amount) || b.tEUR !== 100n * EURt) throw new Error(JSON.stringify(b));
    return `bob: ${V.formatAmount("VEL", b.VEL!)} y ${V.formatAmount("tEUR", b.tEUR!)}`;
  });

  await check("pago: comisión según el precio (0 bajo 1.000 € con sello PoW), sin quemar nada", async () => {
    // alice recibe fondos de la cuenta del grifo (clave pública de testnet) para crear su token.
    await submit(V.makeTransfer(faucet.secret, faucet.address, A, 400n * V.UNIT, await nonceOf(faucet.address), { ctx: await m0().rpc("chain.fees", {}) }));
    await waitTxs([faucet.address]);
    const before = await m0().rpc("supply", {});
    const a0 = (await bal(A)).VEL!;
    const p = await ca.pay(C, 1n * V.UNIT, { memo: "e2e" });
    await waitTxs([A]);
    const fee = BigInt((p.tx as V.TransferTx).fee);
    const a1 = (await bal(A)).VEL!;
    if (a1 !== a0 - V.UNIT - fee) throw new Error(`alice ${a1}, esperado ${a0 - V.UNIT - fee}`);
    if ((await bal(C)).VEL !== V.UNIT) throw new Error("carol no recibe");
    const after = await m0().rpc("supply", {});
    if ("burned" in after) throw new Error("v4 no tiene quema");
    if (BigInt(after.minted) < BigInt(before.minted)) throw new Error("bajó lo acuñado");
    return `tx ${p.id.slice(0, 10)}… · comisión ${fee} velos${fee === 0n ? ` (sello PoW de ${V.powBits(p.tx as any)} bits)` : ""} · nada quemado`;
  });

  await check("tokens: crear, emitir y transferir (comisión en VEL)", async () => {
    let n = await nonceOf(A);
    await submit(V.makeTokenCreate(alice!.wallet.secret, A, n++, { symbol: "ALIZ", name: "Token de Alice", decimals: 2, maxSupply: 1_000_000n, initial: 10_000n, mintable: true }));
    await submit(V.makeTokenMint(alice!.wallet.secret, A, n++, "ALIZ", A, 5_000n));
    await submit(V.makeTransfer(alice!.wallet.secret, A, B, 250n, n++, { token: "ALIZ" }));
    await waitTxs([A]);
    const info = await m0().rpc("token.info", { symbol: "ALIZ" });
    const a = await bal(A), b = await bal(B);
    if (BigInt(info?.supply ?? -1) !== 15_000n || a.ALIZ !== 14_750n || b.ALIZ !== 250n) throw new Error(`${JSON.stringify(info)} ${a.ALIZ} ${b.ALIZ}`);
    const list = (await m0().rpc("token.list", {})) as any[];
    return `ALIZ: emitidos ${info.supply} · tokens en la red: ${list.map((t) => t.symbol).join(", ")}`;
  });

  await check("mercado VEL/tEUR: alice vende, bob compra; saldos y comisión del taker", async () => {
    const s0 = await m0().rpc("supply", {});
    const a0 = await bal(A), b0 = await bal(B);
    const price = 2 * EUR, amount = 10n * V.UNIT;
    await submit(V.makeOrder(alice!.wallet.secret, A, await nonceOf(A), { pair: "VEL/tEUR", side: "sell", price, amount }));
    await waitTxs([A]);
    const book = await m0().rpc("market.book", { pair: "VEL/tEUR" });
    if (!book.asks?.length) throw new Error("la orden no está en el libro");
    await cb1.placeOrder({ pair: "VEL/tEUR", side: "buy", price, amount });
    await waitTxs([B]);
    const a1 = await bal(A), b1 = await bal(B), s1 = await m0().rpc("supply", {});
    const quote = 20n * EURt;
    if (a1.VEL !== a0.VEL! - amount) throw new Error(`alice VEL ${a1.VEL} vs ${a0.VEL! - amount}`);
    if ((a1.tEUR ?? 0n) !== (a0.tEUR ?? 0n) + quote) throw new Error(`alice tEUR ${a1.tEUR}`);
    // Comisión del taker (bob): 1 pb del VEL ejecutado si vale ≥ 1.000 €; si no, 0.
    const fee = b0.VEL! + amount - b1.VEL!;
    if (fee < 0n || fee > amount / 10_000n + 1n) throw new Error(`bob pagó ${fee} velos de comisión`);
    if (b1.tEUR !== b0.tEUR! - quote) throw new Error(`bob tEUR ${b1.tEUR}`);
    if ("burned" in s1 || BigInt(s1.minted) < BigInt(s0.minted)) throw new Error("v4 no tiene quema");
    const trades = await m0().rpc("market.trades", { pair: "VEL/tEUR" });
    const last = (await m0().rpc("market.book", { pair: "VEL/tEUR" })).last;
    return `1 operación (${trades.length} en el registro) · último precio ${last / EUR} tEUR · comisión del taker ${fee} velos · nada quemado`;
  });

  // ---------------------------------------------------------------- sorteo y mensajes
  await check("foto del sorteo publicada con el nodo ligero dentro", async () => {
    const info = await waitFor("época con el ligero", async () => {
      const e = await m0().rpc("chain.epoch", {});
      return e && e.nodes.some((n: any) => n.node === lightKeys.address) && e.online.includes(lightKeys.address) ? e : null;
    }, 150_000, 1_000);
    await Promise.all(clients.map((c) => c.refreshEpoch()));
    return `época ${info.epoch} · ${info.nodes.length} nodos · baliza ${info.beacon.slice(0, 10)}…`;
  });

  const blob1mb = V.b64(V.concatBytes(...Array.from({ length: 16 }, () => V.randomBytes(64 * 1024))));
  await check("mensajes poscuánticos: texto e imagen de 1 MB llegan intactos a los 2 dispositivos de bob", async () => {
    const p1 = await ca.send(bob1!.identity.address, { kind: "text", body: "hola bob, cifrado X25519 + ML-KEM ✓" });
    const p2 = await ca.send(bob1!.identity.address, { kind: "image", blob: blob1mb, mime: "application/octet-stream", meta: { w: 1, h: 1 } });
    if (p1.error || p2.error) throw new Error(p1.error || p2.error);
    for (const c of [cb1, cb2]) {
      await waitFor("llegada", async () => got.get(c)!.some((m) => m.payload.id === p1.id) && got.get(c)!.some((m) => m.payload.id === p2.id), 60_000, 200);
      const img = got.get(c)!.find((m) => m.payload.id === p2.id)!;
      if (img.payload.blob !== blob1mb) throw new Error("imagen alterada");
      if (got.get(c)!.find((m) => m.payload.id === p1.id)!.payload.from !== alice!.identity.address) throw new Error("remitente");
    }
    return `imagen en ${p2.total} trozos (${p2.copies} copias)`;
  });

  await check("grupo de 3 (alice, bob, carol): todos los dispositivos lo descifran", async () => {
    const gid = "g" + V.bytesToHex(V.randomBytes(8));
    const p = await cb1.sendGroup(gid, [alice!.identity.address, bob1!.identity.address, carol!.identity.address], { kind: "text", body: "hola grupo" });
    if (p.error) throw new Error(p.error);
    for (const c of [ca, cc, cb2]) await waitFor("grupo", async () => got.get(c)!.some((m) => m.payload.id === p.id && m.payload.group === gid), 30_000, 200);
    const own = got.get(cb2)!.find((m) => m.payload.id === p.id)!;
    if (!own.outgoing) throw new Error("bob-2 debería verlo como enviado por mí");
    return `${p.copies} copias`;
  });

  // Charla de fondo: genera trabajo en cada época (para recompensas y bolsas).
  chatter = setInterval(() => { ca.send(carol!.identity.address, { kind: "text", body: "tic " + Date.now() }).catch(() => {}); }, 2_500);

  await check("recibos anónimos → reclamaciones de trabajo con muestreo; solo cobran candidatos del sorteo (también el ligero)", async () => {
    // Autoengaño: un recibo «verdadero» (secreto correcto) en el que el nodo 1 se nombra en los dos papeles
    // de un trozo donde NO es candidato. Su libro de trabajo no lo apunta y la cadena no lo pagaría.
    const e = await m0().rpc("chain.epoch", {});
    const n1 = (await status(0)).address;
    let shard = "";
    for (let i = 0; ; i++) {
      shard = `trampa-${i}`;
      if (!V.lotteryCandidates(e, shard, "carrier").includes(n1) && !V.lotteryCandidates(e, shard, "courier").includes(n1)) break;
    }
    const secret = V.receiptSecret("55".repeat(32), shard);
    const fake: V.ReceiptV2 = { shard, mailbox: "cd".repeat(20), rh: V.receiptHash(secret), secret, carrier: n1, courier: n1, ts: Date.now(), ep: e.epoch };
    await m0().rpc("receipt.submit", { receipts: [fake] });
    // Espera a que haya reclamaciones probadas (claim en E+1, prueba en E+3) de los completos y del ligero.
    const dbg = setInterval(() => say(`  ligero: ${JSON.stringify(light!.stats())} · hojas ${JSON.stringify(light!.work.counts())} · descartes ${JSON.stringify(light!.work.skipped)} · error ${light!.lastWorkError} · cabeza #${light!.head.height}`), 30_000);
    const seen = await waitFor("reclamaciones probadas", async () => {
      const head = (await m0().rpc("chain.head", {})).height;
      const cur = Math.floor((head - 1) / V.EPOCH_BLOCKS);
      const all: any[] = [];
      for (let E = Math.max(0, cur - 8); E <= cur; E++) all.push(...Object.values(await m0().rpc("claims", { epoch: E })));
      const proved = all.filter((c) => c.status === "proved");
      return proved.some((c) => c.node === lightKeys.address) && new Set(proved.map((c) => c.node)).size >= 3 ? all : null;
    }, 330_000, 3_000);
    clearInterval(dbg);
    const voids = seen.filter((c: any) => c.status === "void");
    if (voids.length) throw new Error(`reclamaciones nulas: ${voids.map((c: any) => c.reason).join("; ")}`);
    const lightInfo = await waitFor("créditos del ligero", async () => {
      const x = await m0().rpc("node.get", { address: lightKeys.address });
      return x?.credits > 0 ? x : null;
    }, 200_000, 3_000);
    const nodes = (await m0().rpc("node.list", {})) as any[];
    return `${seen.length} reclamaciones (${seen.filter((c: any) => c.status === "proved").length} probadas, 0 nulas) · créditos verificados: ${nodes.map((n) => `${n.name} ${n.credits}`).join(" · ")} · ligero ${lightInfo.credits}`;
  });

  await check("bolsa de token (pool.fund): alice reparte ALIZ entre los nodos durante 2 épocas", async () => {
    await submit(V.makePoolFund(alice!.wallet.secret, A, await nonceOf(A), "ALIZ", 2_000n, 2));
    await waitTxs([A]);
    const nodes = (await m0().rpc("node.list", {})) as any[];
    const paid = await waitFor("reparto de la bolsa", async () => {
      const bs = await Promise.all(nodes.map((n) => bal(n.payout)));
      const total = bs.reduce((a, b) => a + (b.ALIZ ?? 0n), 0n);
      const escrow = await bal(V.ESCROW_ADDRESS);
      return total > 0n && !((escrow.ALIZ ?? 0n) > 0n) ? { bs, total } : null;
    }, 200_000, 2_000);
    const lightGot = paid.bs[nodes.findIndex((n) => n.address === lightKeys.address)]?.ALIZ ?? 0n;
    return `repartidos ${paid.total} de 2000 ALIZ · ligero ${lightGot} · resto vuelve a alice`;
  });

  await check("recompensas: emisión R0 por época cerrada (sin quema); el ligero cobra por su trabajo verificado", async () => {
    const sup = await m0().rpc("supply", {});
    const closed = sup.epoch; // épocas 0..epoch-1 cerradas
    const diff = BigInt(sup.minted) - V.GENESIS_FAUCET_SUPPLY;
    if (diff !== V.R0 * BigInt(closed)) throw new Error(`acuñado ${diff}, esperado ${V.R0 * BigInt(closed)} (${closed} épocas)`);
    if ("burned" in sup) throw new Error("v4 no tiene quema");
    const lightInfo = await waitFor("cobro del ligero", async () => {
      const x = await m0().rpc("node.get", { address: lightKeys.address });
      return BigInt(x?.earned ?? 0) > 0n ? x : null;
    }, 200_000, 3_000);
    const dif = await m0().rpc("difficulty", {});
    return `${closed} épocas × R0 = ${V.formatAmount("VEL", diff, 18, 3)} · ligero ganó ${V.formatAmount("VEL", lightInfo.earned, 18, 3)} · dificultad ${dif.value}`;
  });

  if (chatter) clearInterval(chatter);

  await check("cae el nodo 2, la red sigue; vuelve y se resincroniza", async () => {
    await stopNode(1);
    monitors[1]?.close();
    const h0 = Math.max(...(await Promise.all([0, 2].map(status))).map((s) => s.height));
    await waitFor("avance sin el nodo 2", async () => {
      const st = await Promise.all([0, 2].map(status));
      return st.every((s) => s.height >= h0 + 5) && (await converged([0, 2], h0 + 3));
    }, 40_000);
    startNode(1);
    await waitFor("panel 2", async () => !!(await status(1)), 15_000, 200);
    await monitor(1);
    await waitFor("resincronización", async () => {
      const st = await Promise.all([0, 1, 2].map(status));
      const top = Math.max(...st.map((s) => s.height));
      return st[1].height >= top - 1 && st[1].ready && (await converged([0, 1, 2], 2));
    }, 60_000);
    const b2 = await monitors[1]!.rpc("account.balances", { address: B });
    const b0 = await bal(B);
    if (JSON.stringify(b2) !== JSON.stringify(b0)) throw new Error("saldos distintos tras resincronizar");
    return `altura #${(await status(1)).height}, saldos multi-token coherentes`;
  });

  await check("velum reset: borra cadena y trozos, conserva clave y configuración, y resincroniza", async () => {
    await stopNode(2);
    const dir = join(ROOT, "n3");
    const key0 = readFileSync(join(dir, "node.key"), "utf8");
    const r = Bun.spawnSync(["bun", MAIN, "reset"], { env: { ...process.env, VELUM_HOME: dir } });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    if (existsSync(join(dir, `velum-${V.CHAIN_ID}.db`))) throw new Error("queda la base");
    if (readFileSync(join(dir, "node.key"), "utf8") !== key0 || !existsSync(join(dir, "config.json"))) throw new Error("perdió clave o configuración");
    startNode(2);
    await waitFor("panel 3", async () => !!(await status(2)), 15_000, 200);
    await monitor(2);
    await waitFor("resincronización tras reset", async () => (await converged([0, 1, 2], 10)), 60_000);
    return `resincronizado hasta #${(await status(2)).height}`;
  });

  await check("actualización OTA firmada (clave de PRUEBA): verifica firma y SHA-512, cambia el binario y vuelve atrás si falla", async () => {
    const test = V.generateKeyPair();
    const dl = join(ROOT, "download");
    const dir = join(ROOT, "ota");
    mkdirSync(dir, { recursive: true });
    const exe = join(dir, "velum-node");
    writeFileSync(exe, "binario 2.0.0");
    const nuevo = new TextEncoder().encode("binario 9.9.9 " + "x".repeat(1000));
    const plat = currentPlatform() ?? "linux-x64";
    writeFileSync(join(dl, "bin-new"), nuevo);
    const body = { version: "9.9.9", chain: V.CHAIN_ID, minNodeVersion: "2.0.0", files: { [plat]: { url: `${hub.http}/download/bin-new`, sha512: V.sha512Hex(nuevo), size: nuevo.length } }, ts: Date.now() };
    const m = signManifest(body as Omit<Manifest, "sig">, test.secret);
    if (!verifyManifest(m, test.address) || verifyManifest(m)) throw new Error("firma: la de prueba debe valer solo con su clave");
    const opts = { exe, dir, pub: test.address, platform: plat, current: "2.0.0", force: true, urls: [`${hub.http}/download/manifest.json`] } as const;
    // 1) manifiesto manipulado → no se instala nada
    writeFileSync(join(dl, "manifest.json"), JSON.stringify({ ...m, version: "9.9.10" }));
    if ((await checkAndApply(opts)).status !== "none") throw new Error("aceptó un manifiesto manipulado");
    // 2) firma buena pero SHA-512 que no cuadra → error y binario intacto
    writeFileSync(join(dl, "manifest.json"), JSON.stringify(signManifest({ ...body, files: { [plat]: { ...body.files[plat]!, sha512: "00".repeat(64) } } } as any, test.secret)));
    const bad = await checkAndApply(opts);
    if (bad.status !== "error" || readFileSync(exe, "utf8") !== "binario 2.0.0") throw new Error("aceptó un binario con SHA-512 distinto");
    // 3) todo bien → se cambia; el anterior queda como .prev
    writeFileSync(join(dl, "manifest.json"), JSON.stringify(m));
    const ok = await checkAndApply(opts);
    if (ok.status !== "installed" || readFileSync(exe, "utf8") !== new TextDecoder().decode(nuevo) || readFileSync(exe + ".prev", "utf8") !== "binario 2.0.0") throw new Error(JSON.stringify(ok));
    // 4) el nuevo se cae dos veces antes de estar sano → al tercer arranque vuelve al anterior
    onStartPending(dir); onStartPending(dir);
    if (!onStartPending(dir) || readFileSync(exe, "utf8") !== "binario 2.0.0") throw new Error("no volvió atrás");
    // 5) ya al día → nada
    if ((await checkAndApply({ ...opts, current: "9.9.9" })).status !== "none") throw new Error("reinstala la misma versión");
    return `plataforma ${plat}: manipulado rechazado · SHA-512 rechazado · instalado · vuelta atrás`;
  });
}

let failed = false;
try {
  await run();
} catch (e) {
  failed = true;
  if (!results.some((r) => !r.ok)) console.log("error:", (e as Error)?.stack ?? e);
} finally {
  if (chatter) clearInterval(chatter);
  for (const c of clients) c.close();
  light?.stop();
  for (const m of monitors) m?.close();
  await Promise.all([0, 1, 2].map(stopNode));
  hub.stop();
  console.log("\n================ RESUMEN E2E v2 ================");
  for (const r of results) console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}${r.detail ? `\n      ${r.detail}` : ""}`);
  const ok = !failed && results.every((r) => r.ok);
  console.log(`================================================\n${ok ? "PASS" : "FAIL"} · ${results.filter((r) => r.ok).length}/${results.length} comprobaciones · ${el()}`);
  if (process.env.VELUM_E2E_KEEP || !ok) console.log(`registros y datos en ${ROOT}`);
  else rmSync(ROOT, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
