// Prueba de punta a punta en configuración MAINNET con una cartera fría de PRUEBA (carpeta temporal, frase en memoria).
//   bun apps/node/scripts/e2e-mainnet.ts        (VELUM_E2E_KEEP=1 para no borrar los datos temporales)
// Comprueba: génesis sin grifo ni tokens de prueba, 100 M en la cartera fría, nodos anónimos (sin nombre, solo versión
// de protocolo), pagos desde la reserva, staking delegado por RPC, pasarela vUSDT (cerrada en un nodo, abierta con
// cadenas simuladas en otro), canje, y arranque desde una foto de estado con la raíz comprobada.
process.env.VELUM_NETWORK = "mainnet";
import { mkdtempSync, rmSync, openSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const V = await import("@velum/core");
const { publicFromPhrase } = await import("./cold-wallet");
const { buildGenesis } = await import("../../../packages/core/scripts/genesis-mainnet");
const { startDevHub } = await import("./devhub");
const { Bridge } = await import("../../bridge/src/bridge");
const { serve } = await import("../../bridge/src/main");
const { defaultConfig } = await import("../../bridge/src/config");
const { ChainClient } = await import("../../bridge/src/chains");
const { Store: BridgeStore } = await import("../../bridge/src/store");
const { VelumWs } = await import("../../bridge/src/velum");
const { MockChain } = await import("../../bridge/test/mocks");

const MAIN = resolve(import.meta.dir, "../src/main.ts");
const ROOT = mkdtempSync(join(tmpdir(), "velum-e2e-mainnet-"));
const PORTS = [7451, 7452, 7453];
const BRIDGE_PORT = 7459;
const url = (p: number) => `ws://localhost:${p}/ws`;
const t0 = Date.now();
const say = (m: string) => console.log(`[e2e-mainnet ${((Date.now() - t0) / 1000).toFixed(1)}s] ${m}`);
const results: { name: string; ok: boolean; detail?: string }[] = [];

// ---------- génesis de prueba ----------
const phrase = V.generatePhrase(); // de PRUEBA: solo en memoria, nunca se imprime
const cold = publicFromPhrase(phrase);
const coldKey = V.walletFromSeed(V.seedFromPhrase(phrase), 0);
const bridgeKey = V.generateKeyPair();
writeFileSync(join(ROOT, "cold-wallet.public.json"), JSON.stringify(cold));
writeFileSync(join(ROOT, "bridge.public.json"), JSON.stringify({ address: bridgeKey.address }));
const genesis = buildGenesis(join(ROOT, "cold-wallet.public.json"), join(ROOT, "bridge.public.json"), Math.floor(Date.now() / 3_600_000) * 3_600_000 - 3_600_000);
const GEN_FILE = join(ROOT, "genesis.json");
writeFileSync(GEN_FILE, JSON.stringify(genesis));
V.setMainnetGenesis(genesis);

const hub = startDevHub(0);
type Proc = ReturnType<typeof Bun.spawn>;
const procs: (Proc | null)[] = [null, null, null];

function startNode(i: number, bridgeUrl?: string) {
  const port = PORTS[i]!;
  const args = ["start", "--port", String(port), "--gateway", hub.url, "--no-auto-update"];
  if (i > 0) args.push("--peer", url(PORTS[i - 1]!));
  const fd = openSync(join(ROOT, `n${i + 1}.log`), "a");
  procs[i] = Bun.spawn(["bun", MAIN, ...args], {
    env: {
      ...process.env, VELUM_NETWORK: "mainnet", VELUM_GENESIS_FILE: GEN_FILE, VELUM_HOME: join(ROOT, `n${i + 1}`),
      VELUM_LOG_TAG: `n${i + 1}`, VELUM_MANIFEST_URL: "http://127.0.0.1:1/none", ...(bridgeUrl ? { VELUM_BRIDGE_URL: bridgeUrl } : {}),
    },
    stdout: fd, stderr: fd,
  });
}
async function stopNode(i: number) { const p = procs[i]; if (!p) return; p.kill("SIGTERM"); await p.exited; procs[i] = null; }
async function status(i: number): Promise<any | null> { try { return await (await fetch(`http://localhost:${PORTS[i]}/status`)).json(); } catch { return null; } }
async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms: number, every = 400): Promise<T> {
  const end = Date.now() + ms;
  let last: unknown;
  while (Date.now() < end) { try { const v = await fn(); if (v) return v as T; } catch (e) { last = e; } await Bun.sleep(every); }
  throw new Error(`tiempo agotado: ${what}${last ? ` (${(last as Error).message})` : ""}`);
}
async function check(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push({ name, ok: true }); say(`OK   ${name}${d ? " — " + d : ""}`); }
  catch (e) { results.push({ name, ok: false, detail: (e as Error).message }); say(`FALLO ${name} — ${(e as Error).message}`); }
}

const rpcs: InstanceType<typeof V.VelumClient>[] = [];
async function rpcClient(i: number) {
  rpcs[i]?.close();
  const c = new V.VelumClient({ url: url(PORTS[i]!) });
  c.connect();
  await waitFor(`cliente ${i + 1}`, async () => c.status === "online", 15_000, 100);
  rpcs[i] = c;
  return c;
}
const call = (i: number, method: string, params: any = {}) => rpcs[i]!.rpc(method as any, params);
const fees = async () => (await call(0, "chain.fees")) as import("@velum/core").FeeContext;
const nonce = async (a: string) => { const x = await call(0, "account.get", { address: a }); return x.nonce + x.pending; };
const settle = (addrs: string[]) => waitFor("tx en bloque", async () => (await Promise.all(addrs.map((a) => call(0, "account.get", { address: a })))).every((a: any) => a.pending === 0), 40_000, 300);
async function converged(idx: number[], min = 2) {
  const st = await Promise.all(idx.map(status));
  if (st.some((s) => !s)) return null;
  const h = Math.min(...st.map((s) => s.height)) - 1;
  if (h < min) return null;
  const hs = await Promise.all(idx.map(async (i) => (await call(i, "chain.block", { height: h }))?.hash));
  return hs.every((x) => x && x === hs[0]) ? h : null;
}

// ---------- pasarela con cadenas simuladas (abierta) ----------
const bcfg = defaultConfig();
bcfg.enabled = true;
bcfg.port = BRIDGE_PORT;
bcfg.velumUrl = url(PORTS[0]!);
bcfg.velumConfirmations = 1;
bcfg.chains.ethereum.enabled = false;
const tronMock = new MockChain("tron", bcfg.chains.tron.usdt);
const polyMock = new MockChain("polygon", bcfg.chains.polygon.usdt);
const bridgeVelum = new VelumWs(bcfg.velumUrl);
const bridge = new Bridge(bcfg, cold, bridgeKey, bridgeVelum, {
  tron: new ChainClient(bcfg.chains.tron, tronMock.fetch), polygon: new ChainClient(bcfg.chains.polygon, polyMock.fetch),
}, new BridgeStore(null), Date.now, (m) => say(`  pasarela: ${m}`));
const bridgeSrv = serve(bridge, bcfg);

async function run() {
  say(`datos en ${ROOT}`);
  startNode(0, `http://127.0.0.1:${BRIDGE_PORT}`);
  startNode(1);
  startNode(2);
  await waitFor("paneles", async () => (await Promise.all([0, 1, 2].map(status))).every(Boolean), 20_000, 200);
  for (let i = 0; i < 3; i++) await rpcClient(i);

  await check("mainnet: los 3 nodos se dan de alta y convergen", async () => {
    const h = await waitFor("convergencia", async () => {
      const st = await Promise.all([0, 1, 2].map(status));
      if (!st.every((s) => s?.registered && s.chain === "velum-mainnet-1")) return null;
      return converged([0, 1, 2], 3);
    }, 90_000);
    return `altura #${h}`;
  });

  await check("génesis: 100 M VEL en la cartera fría, solo vUSDT, sin grifo", async () => {
    const b = await call(0, "account.balances", { address: cold.velum.address });
    if (b.VEL !== V.GENESIS_RESERVE_SUPPLY) throw new Error(JSON.stringify(b));
    const toks = (await call(0, "token.list")).map((t: any) => t.symbol);
    if (JSON.stringify(toks) !== '["vUSDT"]') throw new Error(`tokens: ${toks}`);
    const e = await call(0, "faucet", { address: cold.velum.address }).then(() => null, (x: Error) => x.message);
    if (!e || !/grifo/.test(e)) throw new Error(`el grifo respondió: ${e}`);
    return "grifo: «" + e + "»";
  });

  await check("nodos anónimos: sin nombre, solo versión de protocolo", async () => {
    const st = await status(1);
    const list = await call(0, "node.list");
    if (st.name !== "" || st.version !== String(V.PROTOCOL_VERSION)) throw new Error(`status ${st.name}/${st.version}`);
    if (list.some((n: any) => n.name)) throw new Error("hay nombres en node.list");
    const peers = st.peers.map((p: any) => p.name).filter(Boolean);
    if (peers.length) throw new Error(`pares con nombre: ${peers}`);
    return `${list.length} nodos sin nombre · protocolo v${st.version}`;
  });

  const alice = V.walletFromSeed(V.seedFromPhrase(V.generatePhrase()), 0);
  await check("pago desde la reserva (comisión 0 con sello bajo el umbral)", async () => {
    const tx = V.makeTransfer(coldKey.secret, coldKey.address, alice.address, 20_000 * V.UNIT, await nonce(coldKey.address), { ctx: await fees() });
    if (tx.fee !== 0 || tx.pow === undefined) throw new Error("se esperaba comisión 0 con sello");
    await call(0, "tx.submit", { tx });
    await settle([coldKey.address]);
    const b = await call(0, "account.balances", { address: alice.address });
    if (b.VEL !== 20_000 * V.UNIT) throw new Error(JSON.stringify(b));
    return "20.000 VEL a alice";
  });

  const n1 = (await status(0)).address as string;
  await check("staking: delegar por RPC y verlo por nodo y por dirección", async () => {
    const ctx = await fees();
    const body = { type: "stake.delegate", chain: V.CHAIN_ID, from: alice.address, nonce: await nonce(alice.address), ts: Date.now(), node: n1, amount: 5_000 * V.UNIT };
    await call(0, "tx.submit", { tx: V.signTx(alice.secret, V.attachPow(body, ctx.powBits) as any) });
    await settle([alice.address]);
    const byNode = await call(1, "stake.delegations", { node: n1 });
    const byAddr = await call(2, "stake.delegations", { address: alice.address });
    if (byNode[0]?.amount !== 5_000 * V.UNIT || byAddr.delegations[0]?.node !== n1) throw new Error(JSON.stringify({ byNode, byAddr }));
    const node = await call(0, "node.get", { address: n1 });
    return `delegado ${node.delegated / V.UNIT} VEL en ${n1.slice(0, 7)}…`;
  });

  await check("pasarela: cerrada en un nodo sin pasarela, abierta con cadenas simuladas en otro", async () => {
    const closed = await call(1, "bridge.address", { chain: "tron", velAddress: alice.address }).then(() => null, (e: Error) => e.message);
    if (closed !== "puente aún no abierto") throw new Error(`nodo 2: ${closed}`);
    const addr = await call(0, "bridge.address", { chain: "tron", velAddress: alice.address });
    if (!/^T/.test(addr.address)) throw new Error(JSON.stringify(addr));
    await bridge.pollDeposits("tron");
    tronMock.mine(1);
    tronMock.deposit(addr.address, 75n * 1_000_000n);
    tronMock.mine(25);
    await bridge.pollDeposits("tron");
    await bridge.mintPending();
    await waitFor("vUSDT acuñado", async () => (await call(0, "account.balances", { address: alice.address })).vUSDT === 75 * V.UNIT, 30_000);
    // Canje de 30 vUSDT a TRON → la pasarela lo encola.
    const ctx = await fees();
    const body = { type: "bridge.redeem", chain: V.CHAIN_ID, from: alice.address, nonce: await nonce(alice.address), ts: Date.now(), dst: "tron", to: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t", amount: 30 * V.UNIT, fee: 0 };
    await call(0, "tx.submit", { tx: V.signTx(alice.secret, V.attachPow(body, ctx.powBits) as any) });
    await settle([alice.address]);
    await waitFor("canje visto por la pasarela", async () => { await Bun.sleep(2_500); await bridge.pollVelum(); return Object.values(bridge.store.data.withdrawals).some((w) => w.status === "queued"); }, 30_000, 100);
    tronMock.setBalance(addr.address, 75n * 1_000_000n);
    const r = await bridge.reserves();
    if (r.supply !== String(45 * V.UNIT) || !r.ok) throw new Error(JSON.stringify(r));
    return `75 depositados, 30 canjeados, reservas ok (${r.reserves} ≥ ${r.liabilities})`;
  });

  await check("foto de estado: el nodo 3 arranca desde una foto con la raíz comprobada", async () => {
    await stopNode(2);
    const file = join(ROOT, "foto.json");
    const exp = Bun.spawnSync(["bun", MAIN, "snapshot", "export", file], { env: { ...process.env, VELUM_NETWORK: "mainnet", VELUM_GENESIS_FILE: GEN_FILE, VELUM_HOME: join(ROOT, "n3") } });
    if (exp.exitCode !== 0) throw new Error(exp.stderr.toString());
    const fresh = join(ROOT, "n3b");
    const imp = Bun.spawnSync(["bun", MAIN, "snapshot", "import", file], { env: { ...process.env, VELUM_NETWORK: "mainnet", VELUM_GENESIS_FILE: GEN_FILE, VELUM_HOME: fresh } });
    if (imp.exitCode !== 0) throw new Error(imp.stderr.toString() || imp.stdout.toString());
    // Foto alterada: se rechaza.
    const bad = JSON.parse(await Bun.file(file).text());
    bad.state.balances[cold.velum.address].VEL += 1;
    writeFileSync(join(ROOT, "mala.json"), JSON.stringify(bad));
    const rej = Bun.spawnSync(["bun", MAIN, "snapshot", "import", join(ROOT, "mala.json")], { env: { ...process.env, VELUM_NETWORK: "mainnet", VELUM_GENESIS_FILE: GEN_FILE, VELUM_HOME: join(ROOT, "n3c") } });
    if (rej.exitCode === 0) throw new Error("aceptó una foto alterada");
    const port = PORTS[2]!;
    const fd = openSync(join(ROOT, "n3b.log"), "a");
    procs[2] = Bun.spawn(["bun", MAIN, "start", "--port", String(port), "--gateway", hub.url, "--peer", url(PORTS[1]!), "--no-auto-update"], {
      env: { ...process.env, VELUM_NETWORK: "mainnet", VELUM_GENESIS_FILE: GEN_FILE, VELUM_HOME: fresh, VELUM_MANIFEST_URL: "http://127.0.0.1:1/none" }, stdout: fd, stderr: fd,
    });
    await waitFor("panel 3", () => status(2), 15_000, 200);
    await rpcClient(2);
    const h = await waitFor("convergencia tras la foto", () => converged([0, 1, 2], 5), 60_000);
    return `altura común #${h}`;
  });
}

let code = 0;
try { await run(); } catch (e) { say(`error: ${(e as Error).message}`); code = 1; }
finally {
  for (const c of rpcs) c?.close();
  bridgeVelum.close();
  bridgeSrv.stop(true);
  for (let i = 0; i < 3; i++) await stopNode(i);
  hub.stop?.();
  if (!process.env.VELUM_E2E_KEEP) rmSync(ROOT, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length ? "FALLO" : "PASS"} ${results.length - failed.length}/${results.length}`);
for (const f of failed) console.log(`  ✗ ${f.name}: ${f.detail}`);
process.exit(code || (failed.length ? 1 : 0));
