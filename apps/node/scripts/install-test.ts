// Prueba del instalador de punta a punta, sin tocar el sistema real:
// HOME temporal, binario compilado para esta plataforma servido desde un servidor local con su manifiesto,
// etiqueta de servicio de pruebas, y al final «velum uninstall --purge» comprobando que no queda nada.
//   bun apps/node/scripts/install-test.ts      (solo macOS/Linux)
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CHAIN_ID, sha512Hex } from "@velum/core";
import { binaryName, compile } from "./release";
import { currentPlatform } from "../src/update";
import { VERSION } from "../src/version";

const here = resolve(import.meta.dir, "..");
const HOME = mkdtempSync(join(tmpdir(), "velum-install-"));
const SITE = mkdtempSync(join(tmpdir(), "velum-site-"));
const LABEL = "com.velum.node.installtest";
const PORT = 7451;
const results: [string, boolean, string?][] = [];
const say = (m: string) => console.log(`[instalador] ${m}`);

const plat = currentPlatform();
if (!plat || plat.startsWith("windows")) throw new Error("Esta prueba es para macOS/Linux");
say(`compilando el binario de ${plat}…`);
const bin = await compile(plat, join(SITE, "download"));
const bytes = new Uint8Array(readFileSync(bin));
copyFileSync(join(here, "install/install.sh"), join(SITE, "install.sh"));

const server = Bun.serve({
  port: 0,
  fetch(req) {
    const p = decodeURIComponent(new URL(req.url).pathname);
    const file = Bun.file(join(SITE, p.replace(/^\/+/, "")));
    return file.size ? new Response(file) : new Response("no", { status: 404 });
  },
});
const BASE = `http://localhost:${server.port}`;
// Manifiesto de prueba (el instalador solo comprueba SHA-512; la firma la comprueba el nodo al actualizarse).
writeFileSync(join(SITE, "download/manifest.json"), JSON.stringify({
  version: VERSION, chain: CHAIN_ID, minNodeVersion: VERSION,
  files: { [plat]: { url: `${BASE}/download/${binaryName(plat)}`, sha512: sha512Hex(bytes), size: bytes.length } }, ts: Date.now(), sig: "prueba",
}, null, 2));
say(`servidor local ${BASE} · HOME temporal ${HOME} · binario ${(bytes.length / 1024 / 1024).toFixed(1)} MB`);
writeFileSync(join(HOME, ".zshrc"), "# zshrc de prueba\n");

// VELUM_MANIFEST_URL: que «velum update» mire el manifiesto local (sin firmar) y nunca el de producción.
const env = { ...process.env, HOME, VELUM_DOWNLOAD_BASE: BASE, VELUM_MANIFEST_URL: `${BASE}/download/manifest.json`, VELUM_PORT: String(PORT), VELUM_SERVICE_LABEL: LABEL, VELUM_LOG: "info" };
delete (env as any).VELUM_HOME;
const velum = join(HOME, ".velum/bin/velum");

async function step(name: string, fn: () => Promise<string | void>) {
  try { const d = await fn(); results.push([name, true, d || undefined]); say(`OK   ${name}${d ? " — " + d : ""}`); }
  catch (e) { results.push([name, false, (e as Error).message]); say(`FALLO ${name} — ${(e as Error).message}`); }
}
const status = async () => { try { return await (await fetch(`http://localhost:${PORT}/status`)).json() as any; } catch { return null; } };
const launchdLoaded = async () => process.platform === "darwin" && (await $`launchctl print gui/${process.getuid!()}/${LABEL}`.nothrow().quiet()).exitCode === 0;

try {
  await step("instala (curl | bash) el binario verificado y arranca el nodo (sin Bun)", async () => {
    const script = await (await fetch(`${BASE}/install.sh`)).text();
    if (script.includes("bun.sh") || script.includes("download/velum-node.js")) throw new Error("el instalador aún depende de Bun o del .js");
    const r = await $`bash -s -- --gateway none --no-auto-update --name prueba-instalador < ${new Response(script)}`.env(env).nothrow();
    if (r.exitCode !== 0) throw new Error(`salida ${r.exitCode}: ${r.stderr}`);
    if (!r.stdout.toString().includes(`http://localhost:${PORT}`)) throw new Error("no muestra la URL del panel");
    for (let i = 0; i < 40 && !(await status()); i++) await Bun.sleep(250);
    const s = await status();
    if (!s || s.name !== "prueba-instalador" || s.version !== VERSION) throw new Error("el nodo no responde");
    return `panel en :${PORT}, nodo ${s.address.slice(0, 10)}… v${s.version}`;
  });

  await step("un binario con huella SHA-512 distinta se rechaza", async () => {
    const m = JSON.parse(readFileSync(join(SITE, "download/manifest.json"), "utf8"));
    const good = m.files[plat!].sha512;
    m.files[plat!].sha512 = "0".repeat(128);
    writeFileSync(join(SITE, "download/manifest.json"), JSON.stringify(m));
    const script = await (await fetch(`${BASE}/install.sh`)).text();
    const r = await $`bash -s < ${new Response(script)}`.env(env).nothrow().quiet();
    m.files[plat!].sha512 = good;
    writeFileSync(join(SITE, "download/manifest.json"), JSON.stringify(m, null, 2));
    if (r.exitCode === 0) throw new Error("aceptó un binario manipulado");
    if (!(await status())) throw new Error("tumbó el nodo que ya estaba en marcha");
  });

  await step("arranque automático registrado", async () => {
    if (process.platform === "darwin") {
      const plist = readFileSync(join(HOME, `Library/LaunchAgents/${LABEL}.plist`), "utf8");
      if (!plist.includes(".velum/bin/velum-node")) throw new Error("el plist no apunta al binario");
      if (!(await launchdLoaded())) throw new Error("LaunchAgent no cargado");
      return `LaunchAgent ${LABEL} → binario compilado`;
    }
    return "systemd/cron (Linux)";
  });

  await step("clave con permisos 600 y línea de PATH en .zshrc", async () => {
    const mode = (await $`stat -f %Lp ${join(HOME, ".velum/node.key")}`.nothrow().quiet()).stdout.toString().trim()
      || (await $`stat -c %a ${join(HOME, ".velum/node.key")}`.nothrow().quiet()).stdout.toString().trim();
    if (mode !== "600") throw new Error(`permisos ${mode}`);
    if (!readFileSync(join(HOME, ".zshrc"), "utf8").includes("# velum-node")) throw new Error("sin línea de PATH");
  });

  await step("velum status / pause / resume / version", async () => {
    const st = await $`${velum} status`.env(env).text();
    if (!st.includes("prueba-instalador")) throw new Error(st);
    await $`${velum} pause`.env(env).quiet();
    if (!(await status())?.paused) throw new Error("no se pausó");
    await $`${velum} resume`.env(env).quiet();
    if ((await status())?.paused) throw new Error("no se reanudó");
    if ((await $`${velum} version`.env(env).text()).trim() !== VERSION) throw new Error("versión");
  });

  await step("el nodo produce bloques", async () => {
    const h0 = (await status())?.height ?? 0;
    for (let i = 0; i < 30; i++) { await Bun.sleep(500); const s = await status(); if (s && s.height >= h0 + 2) return `altura #${s.height}`; }
    throw new Error("no avanza");
  });

  await step("velum update (sin puertas: no hay manifiesto firmado que aplicar) no rompe nada", async () => {
    const out = await $`${velum} update`.env(env).nothrow().text();
    if (!/Sin cambios|Hay versión|Actualizado/.test(out)) throw new Error(out);
    if (!(await status())) throw new Error("el nodo se paró");
    return out.trim();
  });

  await step("velum reset: borra la cadena, conserva clave y configuración, y vuelve a arrancar", async () => {
    const key0 = readFileSync(join(HOME, ".velum/node.key"), "utf8");
    const h0 = (await status())?.height ?? 0;
    await $`${velum} reset`.env(env).quiet();
    for (let i = 0; i < 40 && !(await status()); i++) await Bun.sleep(250);
    const s = await status();
    if (!s) throw new Error("no volvió a arrancar");
    if (readFileSync(join(HOME, ".velum/node.key"), "utf8") !== key0) throw new Error("cambió la clave");
    if (s.name !== "prueba-instalador") throw new Error("perdió la configuración");
    if (s.height > h0) throw new Error(`no empezó de cero (altura ${s.height} > ${h0})`);
    return `de #${h0} a #${s.height}`;
  });

  await step("velum stop / start (y reinstalar es idempotente)", async () => {
    await $`${velum} stop`.env(env).quiet();
    if (await status()) throw new Error("sigue respondiendo tras stop");
    await $`${velum} start`.env(env).quiet();
    if (!(await status())) throw new Error("no arranca");
    const script = await (await fetch(`${BASE}/install.sh`)).text();
    const r = await $`bash -s < ${new Response(script)}`.env(env).nothrow().quiet();
    if (r.exitCode !== 0) throw new Error("la segunda instalación falló: " + r.stderr);
    for (let i = 0; i < 40 && !(await status()); i++) await Bun.sleep(250);
    const s = await status();
    if (!s || s.name !== "prueba-instalador") throw new Error("perdió la configuración");
    if ((readFileSync(join(HOME, ".zshrc"), "utf8").match(/# velum-node/g) ?? []).length !== 1) throw new Error("PATH duplicado");
  });

  await step("velum uninstall --purge lo deja todo limpio", async () => {
    await $`${velum} uninstall --purge`.env(env).quiet();
    await Bun.sleep(500);
    if (await status()) throw new Error("el nodo sigue en marcha");
    if (await launchdLoaded()) throw new Error("el LaunchAgent sigue cargado");
    if (existsSync(join(HOME, ".velum"))) throw new Error("quedan datos");
    if (existsSync(join(HOME, `Library/LaunchAgents/${LABEL}.plist`))) throw new Error("queda el plist");
    if (readFileSync(join(HOME, ".zshrc"), "utf8").includes("velum")) throw new Error("queda la línea de PATH");
  });
} finally {
  // Red de seguridad: que no quede nada cargado aunque algo falle.
  if (process.platform === "darwin") await $`launchctl bootout gui/${process.getuid!()}/${LABEL}`.nothrow().quiet();
  await $`pkill -f ${join(HOME, ".velum/bin/velum-node")}`.nothrow().quiet();
  server.stop(true);
  const ok = results.every((r) => r[1]);
  console.log(`\n${results.map(([n, o, d]) => `${o ? "PASS" : "FAIL"}  ${n}${d ? " — " + d : ""}`).join("\n")}\n${ok ? "PASS" : "FAIL"} instalador`);
  rmSync(HOME, { recursive: true, force: true });
  rmSync(SITE, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
