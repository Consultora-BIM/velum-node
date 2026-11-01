#!/usr/bin/env bun
// velum-node: arranca un nodo de la red Velum.
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CHAIN_ID, exportSnapshot, importSnapshot, isAddress, type StateSnapshot } from "@velum/core";
import { Store } from "./store";
import { activeGateways, dataDir, loadConfig, loadKeys, parseArgs } from "./config";
import { VelumNode } from "./node";
import { mountDesktop, openCommand, openOnFirstStart } from "../../desktop/server/node-hook";
import { VERSION } from "./version";
import { log, setLogTag } from "./log";
import {
  CHECK_EVERY_MS, HEALTHY_AFTER_MS, RESTART_EXIT_CODE, belowMinimum, checkAndApply, fetchManifest, isCompiled, manifestUrls,
  markHealthy, onStartPending,
} from "./update";

const HELP = `velum-node ${VERSION} — nodo de la red Velum (${CHAIN_ID})

Uso:
  velum-node [start] [opciones]

Opciones (se guardan en ~/.velum/config.json):
  --name NOMBRE        Nombre opcional y decorativo (por defecto ninguno: el nodo es su dirección; "" lo borra)
  --payout vel…        Cartera que cobra las recompensas (por defecto, la del nodo)
  --port N             Puerto local del panel y de las conexiones directas (7420)
  --gateway URL[,URL]  Puertas de entrada por orden (se repite o separa con comas); "none" = solo pares directos
  --peer ws://h:p/ws   Añade un par directo (se puede repetir)
  --endpoint ws://…    Dirección pública por la que otros nodos pueden llamarte (se publica en la cadena)
  --dns-seed NOMBRE    Semilla DNS (registro TXT con direcciones ws/wss) para encontrar vecinos
  --no-auto-update     No instalar actualizaciones firmadas automáticamente

Otras órdenes:
  init     prepara clave y configuración sin arrancar (lo usa el instalador)
  update   busca e instala ahora la última versión firmada
  status   estado del nodo en marcha (resumen legible)
  open     abre la app de escritorio (cartera, mensajes y nodo) en el navegador
  reset    borra la cadena y los trozos guardados (conserva clave y configuración); al arrancar se resincroniza
  snapshot export ARCHIVO   guarda una foto del estado (con su raíz) · con el nodo parado
  snapshot import ARCHIVO   arranca desde una foto: comprueba la raíz antes de aceptarla · con el nodo parado
  address  dirección del nodo · version

Entorno: VELUM_HOME, VELUM_PORT, VELUM_GATEWAY, VELUM_PEERS, VELUM_MANIFEST_URL, VELUM_AUTO_UPDATE=0, VELUM_LOG=debug`;

/** Borra la cadena y los trozos (todas las bases velum*.db), nunca node.key ni config.json. */
export function resetData(dir: string): string[] {
  const gone: string[] = [];
  if (!existsSync(dir)) return gone;
  for (const f of readdirSync(dir)) {
    if (/^velum.*\.db(-wal|-shm)?$/.test(f) || f === "update-pending.json") {
      rmSync(join(dir, f), { force: true });
      gone.push(f);
    }
  }
  return gone;
}

async function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) { console.error((e as Error).message + "\n\n" + HELP); process.exit(2); }
  if (args.cmd === "help") return console.log(HELP);
  if (args.cmd === "version") return console.log(VERSION);
  const dir = dataDir();
  if (args.cmd === "reset") {
    const gone = resetData(dir);
    return console.log(gone.length ? `Datos de la cadena borrados (${gone.join(", ")}). La clave y la configuración se conservan.` : "No había datos de la cadena.");
  }
  if (args.cmd === "snapshot") return snapshotCmd(dir, args.rest[0], args.rest[1]);
  const keys = loadKeys(dir);
  if (args.cmd === "address") return console.log(keys.address);
  if (args.cmd === "init") {
    const cfg = loadConfig(dir, keys.address, args);
    return console.log(JSON.stringify({ address: keys.address, name: cfg.name, payout: cfg.payout, port: cfg.port }));
  }
  if (args.cmd === "status") {
    // Resumen legible del nodo en marcha (lo usa la orden «velum status»; no hace falta Bun).
    const cfg = loadConfig(dir, keys.address, args);
    try {
      const s: any = await (await fetch(`http://localhost:${cfg.port}/status`, { signal: AbortSignal.timeout(3_000) })).json();
      const vel = (m: number) => (m / 1e6).toLocaleString("es-ES", { maximumFractionDigits: 3 }) + " VEL";
      const estado = s.held ? `retenido (${s.held})` : s.paused ? "en pausa" : s.ready ? "aportando" : "poniéndose al día";
      console.log(`${s.name} (${s.address}) · v${s.version} · ${s.chain}
  estado: ${estado}
  bloque: #${s.height} · época ${s.epoch}
  vecinos: ${s.peers.length} · puerta: ${s.hubConnected ? s.gateway : "sin conexión"}
  nivel: ${s.tier ?? "sin alta aún"} · créditos: ${s.credits}
  VEL descubiertos: ${vel(s.earned)}
  puentes: ${s.shardsStored} trozos esperando entrega · ${s.counters.shardsRelayed} transportados
  panel: http://localhost:${cfg.port}`);
    } catch {
      console.log("El nodo está parado. Arráncalo con: velum start");
      process.exit(1);
    }
    return;
  }
  if (args.cmd === "update") {
    const cfg = loadConfig(dir, keys.address, args);
    const r = await checkAndApply({ dir, urls: manifestUrls(activeGateways(cfg)) });
    if (r.status === "installed") console.log(`Actualizado a ${r.version}. Reinicia el nodo (velum restart) para usarla.`);
    else if (r.status === "available") console.log(`Hay versión ${r.version}: ${r.reason}`);
    else if (r.status === "none") console.log(`Sin cambios: ${r.reason}`);
    else { console.error(`No se pudo actualizar: ${r.error}`); process.exit(1); }
    return;
  }
  if (args.cmd === "open") {
    // App de escritorio del nodo en marcha (con el token de su sesión); sin ella, el panel.
    const cfg = loadConfig(dir, keys.address, args);
    const r = await openCommand(dir, cfg.port);
    if (!r.ok && !r.url) { console.error(r.error); process.exit(1); }
    console.log(r.ok ? "App abierta en el navegador." : `Ábrela en el navegador: ${r.url}`);
    return;
  }
  if (args.cmd !== "start") { console.error(`Orden desconocida: ${args.cmd}\n\n${HELP}`); process.exit(2); }

  // Actualización recién instalada que no arranca: se vuelve a la anterior.
  if (onStartPending(dir)) process.exit(RESTART_EXIT_CODE);

  const cfg = loadConfig(dir, keys.address, args);
  if (process.env.VELUM_LOG_TAG) setLogTag(process.env.VELUM_LOG_TAG);
  const gws = activeGateways(cfg);
  log.info(`velum-node ${VERSION}${isCompiled() ? "" : " (desde código)"} · datos en ${dir} · ${gws.length ? "puertas " + gws.join(", ") : "sin puerta de entrada"}${cfg.peers.length ? " · pares: " + cfg.peers.join(", ") : ""}`);
  const node = new VelumNode(cfg, keys, dir);
  try {
    node.start();
  } catch (e) {
    const msg = (e as Error).message ?? String(e);
    if (/EADDRINUSE|in use/i.test(msg)) log.error(`el puerto ${cfg.port} está ocupado (¿ya hay un nodo en marcha?). Usa --port para otro.`);
    else log.error(msg);
    process.exit(1);
  }
  // App de escritorio: /app y /api en el mismo puerto, con token por sesión. Se abre sola el primer día.
  try {
    const desk = await mountDesktop({
      dir, port: cfg.port, version: VERSION, network: CHAIN_ID.includes("mainnet") ? "mainnet" : "testnet",
      status: () => node.status() as unknown as Record<string, unknown>,
      pause: () => node.pause(), resume: () => node.resume(),
      isAddress: (a) => isAddress(a),
      setPayout: (a) => { node.cfg.payout = a; saveField(dir, "payout", a); },
      setAutoUpdate: (on) => { cfg.autoUpdate = on; saveField(dir, "autoUpdate", on); },
      updateInfo: () => ({ auto: cfg.autoUpdate, current: VERSION, ...lastUpdate }),
      checkUpdate: async () => {
        const r = await checkAndApply({ dir, urls: manifestUrls(gws) });
        lastUpdate = { lastCheck: Date.now(), status: r.status, latest: "version" in r ? r.version ?? null : null };
        if (r.status === "installed") setTimeout(() => void shutdown("actualización", RESTART_EXIT_CODE), 1_500);
        return r as unknown as Record<string, unknown>;
      },
    });
    node.desktop = desk;
    if (desk.hasGui) log.info(`app de escritorio: «velum open» o ${desk.url.replace(/#.*/, "")}`);
    openOnFirstStart(desk, dir);
  } catch (e) { log.warn(`app de escritorio no disponible: ${(e as Error).message}`); }
  let stopping = false;
  const shutdown = async (sig: string, code = 0) => {
    if (stopping) return;
    stopping = true;
    log.info(`apagando (${sig})`);
    await node.stop();
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  setTimeout(() => markHealthy(dir), HEALTHY_AFTER_MS);

  // Actualizaciones firmadas: al rato de arrancar y cada hora. También comprueba la versión mínima de la red.
  const urls = manifestUrls(gws);
  const check = async () => {
    try {
      const m = await fetchManifest(urls);
      const tooOld = belowMinimum(m);
      if (tooOld) node.hold(`esta versión (${VERSION}) es anterior a la mínima de la red (${m!.minNodeVersion}): actualiza con «velum update»`);
      if (!cfg.autoUpdate && !tooOld) return;
      const r = await checkAndApply({ dir, urls });
      if (r.status === "installed") {
        log.info(`actualización ${r.version} instalada y verificada (firma + SHA-512): reinicio`);
        await shutdown("actualización", RESTART_EXIT_CODE);
      } else if (r.status === "available") log.info(`hay versión ${r.version}: ${r.reason}`);
      else if (r.status === "error") log.warn(`actualización fallida: ${r.error}`);
      else if (!tooOld) node.hold(null);
    } catch (e) { log.debug(`comprobación de versión: ${(e as Error).message}`); }
  };
  if (urls.length) {
    setTimeout(check, 20_000 + Math.random() * 20_000);
    setInterval(check, CHECK_EVERY_MS);
  }
}

/**
 * Fotos de estado. Los datos de la cadena sobreviven a cualquier actualización del binario; la foto es una copia
 * más (antes de actualizar) y la forma rápida de arrancar un nodo nuevo. La raíz se comprueba siempre.
 */
function snapshotCmd(dir: string, sub: string | undefined, file: string | undefined) {
  if (!file || (sub !== "export" && sub !== "import")) {
    console.error("Uso: velum-node snapshot export|import ARCHIVO");
    process.exit(2);
  }
  mkdirSync(dir, { recursive: true });
  const store = new Store(dir);
  try {
    if (sub === "export") {
      const s = store.loadHead();
      if (!s) { console.error("No hay estado guardado de esta cadena."); process.exit(1); }
      const snap = exportSnapshot(s);
      writeFileSync(file, JSON.stringify(snap));
      console.log(`Foto de ${snap.chain} en la altura ${snap.height}\nhash ${snap.hash}\nraíz ${snap.stateRoot}\n→ ${file}`);
      return;
    }
    const snap = JSON.parse(readFileSync(file, "utf8")) as StateSnapshot;
    const state = importSnapshot(snap);
    const cur = store.loadHead();
    if (cur && cur.height >= state.height) { console.error(`Este nodo ya va por la altura ${cur.height}: no hace falta la foto (${state.height}).`); process.exit(1); }
    store.putSnapshot(state);
    store.setMeta("snapshotBase", state.hash);
    store.saveHead(state);
    console.log(`Foto aceptada: altura ${state.height}, raíz ${snap.stateRoot}.\nCompara el hash ${state.hash} con el del explorador antes de arrancar.`);
  } catch (e) {
    console.error(`Foto rechazada: ${(e as Error).message}`);
    process.exit(1);
  } finally {
    store.close?.();
  }
}

if (import.meta.main) main();

/** Guarda un campo de config.json sin pisar el resto (ni volcar lo que venga del entorno). */
function saveField(dir: string, key: string, value: unknown) {
  const file = join(dir, "config.json");
  let saved: Record<string, unknown> = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { /* nuevo */ }
  saved[key] = value;
  writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
}
let lastUpdate: { lastCheck: number | null; status: string; latest: string | null } = { lastCheck: null, status: "none", latest: null };
