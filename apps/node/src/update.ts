// Actualización OTA firmada del nodo (protocolo-v2 §13, v3 §10).
//
//  1. Se descarga `manifest.json` de la web (el origen https de las puertas de entrada).
//  2. Se comprueba la firma ed25519 con la clave de publicación incrustada aquí (la secreta vive en el
//     Llavero de quien publica, nunca en el repo).
//  3. Si hay versión nueva para esta plataforma: se baja el binario, se comprueban tamaño y SHA-512,
//     y se cambia de forma atómica. El anterior queda como `.prev` para volver atrás.
//  4. El nodo sale con el código 75; el servicio (launchd / systemd / bucle del lanzador de Windows) lo
//     reinicia. El binario nuevo marca la actualización como buena si aguanta 60 s; si se cae dos veces
//     seguidas antes, se restaura el anterior.
// En Windows un .exe en marcha no se puede sobrescribir, pero sí renombrar: exe → exe.prev, nuevo → exe.
import { chmodSync, existsSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { canonical, sha512Hex, verify, GATEWAYS, CHAIN_ID } from "@velum/core";
import { VERSION } from "./version";
import { log } from "./log";

/** Clave pública de publicación (dirección vel… de la clave ed25519). La genera scripts/release-key.ts. */
export const RELEASE_PUBLIC_KEY = "vel25ojv76UAH9ct4k9zBMSBCxMoj2cXthusC8KcLwpnYAT";

export const RESTART_EXIT_CODE = 75;
export const HEALTHY_AFTER_MS = 60_000;
export const CHECK_EVERY_MS = 3_600_000;

export type Platform = "darwin-arm64" | "darwin-x64" | "linux-x64" | "linux-arm64" | "windows-x64";
export const PLATFORMS: Platform[] = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64"];

export interface ManifestFile { url: string; sha512: string; size: number }
export interface Manifest {
  version: string;
  chain: string;
  /** Por debajo de esta versión el nodo debe actualizarse antes de seguir (v3 §10). */
  minNodeVersion?: string;
  minAppVersion?: string;
  files: Partial<Record<Platform, ManifestFile>>;
  ts: number;
  sig: string;
}

export function currentPlatform(): Platform | null {
  const os = process.platform === "win32" ? "windows" : process.platform;
  const key = `${os}-${process.arch}`;
  return (PLATFORMS as string[]).includes(key) ? (key as Platform) : null;
}

/** ¿Es un binario compilado (bun build --compile)? Solo así se puede cambiar a sí mismo. */
export function isCompiled() {
  const main = typeof Bun !== "undefined" ? Bun.main : "";
  return main.startsWith("/$bunfs") || /[\\/]~BUN[\\/]/.test(main) || main.startsWith("B:/~BUN");
}

/** Compara semver simple (1.2.10 > 1.2.9). */
export function cmpVersion(a: string, b: string): number {
  const pa = a.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0), pb = b.split(/[.-]/).map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Cuerpo firmado: el manifiesto sin `sig`, en JSON canónico. */
export const manifestBody = (m: Omit<Manifest, "sig"> & { sig?: string }) => {
  const { sig: _s, ...rest } = m;
  return canonical(rest);
};

export function verifyManifest(m: Manifest, pub = RELEASE_PUBLIC_KEY): boolean {
  if (!m || typeof m !== "object" || typeof m.version !== "string" || typeof m.sig !== "string" || !m.files || typeof m.files !== "object") return false;
  return verify(pub, manifestBody(m), m.sig);
}

/** Webs oficiales por orden (dominio público primero; respaldos si un operador bloquea alguno). */
export const DOWNLOAD_ORIGINS = ["https://velumprotocol.org", "https://velum.consultorabim.com", "https://velum.consultora-bim.workers.dev"];

/**
 * De dónde bajar el manifiesto: VELUM_MANIFEST_URL, o las webs oficiales y el origen http(s) de cada puerta
 * (wss://x/hub → https://x/download/manifest.json).
 */
export function manifestUrls(gateways: readonly string[] = GATEWAYS, origins: readonly string[] = DOWNLOAD_ORIGINS): string[] {
  if (process.env.VELUM_MANIFEST_URL) return process.env.VELUM_MANIFEST_URL.split(",").map((s) => s.trim()).filter(Boolean);
  const out: string[] = origins.map((o) => `${o}/download/manifest.json`);
  for (const g of gateways) {
    try {
      const u = new URL(g);
      if (u.protocol !== "wss:" && u.protocol !== "ws:") continue;
      out.push(`${u.protocol === "wss:" ? "https:" : "http:"}//${u.host}/download/manifest.json`);
    } catch { /* no es URL */ }
  }
  return [...new Set(out)];
}

export async function fetchManifest(urls: string[], pub = RELEASE_PUBLIC_KEY): Promise<Manifest | null> {
  for (const url of urls) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "cache-control": "no-cache" } });
      if (!r.ok) continue;
      const m = (await r.json()) as Manifest;
      if (!verifyManifest(m, pub)) { log.warn(`manifiesto de ${url} con firma no válida: se ignora`); continue; }
      return m;
    } catch (e) {
      log.debug(`manifiesto ${url}: ${(e as Error).message}`);
    }
  }
  return null;
}

export interface UpdateOptions {
  /** Ruta del binario a sustituir (por defecto, el ejecutable en marcha). */
  exe?: string;
  platform?: Platform | null;
  current?: string;
  pub?: string;
  urls?: string[];
  /** Carpeta de datos (para la marca de actualización pendiente). */
  dir: string;
  /** Instalar aunque no sea un binario compilado (pruebas). */
  force?: boolean;
}

export type UpdateResult =
  | { status: "none"; reason: string }
  | { status: "available"; version: string; reason: string }
  | { status: "installed"; version: string; exe: string }
  | { status: "error"; error: string };

const pendingFile = (dir: string) => join(dir, "update-pending.json");

/** Descarga, verifica y cambia el binario. No reinicia: devuelve "installed" y quien llama sale con 75. */
export async function checkAndApply(o: UpdateOptions): Promise<UpdateResult> {
  const current = o.current ?? VERSION;
  const platform = o.platform === undefined ? currentPlatform() : o.platform;
  const m = await fetchManifest(o.urls ?? manifestUrls(), o.pub);
  if (!m) return { status: "none", reason: "sin manifiesto válido" };
  if (cmpVersion(m.version, current) <= 0) return { status: "none", reason: `al día (${current})` };
  const f = platform ? m.files[platform] : undefined;
  if (!f) return { status: "none", reason: `la versión ${m.version} no trae binario para ${platform ?? "esta plataforma"}` };
  if (!o.force && !isCompiled()) return { status: "available", version: m.version, reason: "este nodo corre con Bun desde código: reinstala con el instalador para tener el binario" };
  const exe = o.exe ?? process.execPath;
  try {
    const r = await fetch(f.url, { signal: AbortSignal.timeout(10 * 60_000) });
    if (!r.ok) return { status: "error", error: `descarga ${r.status}` };
    const bytes = new Uint8Array(await r.arrayBuffer());
    if (bytes.length !== f.size) return { status: "error", error: `tamaño ${bytes.length}, esperado ${f.size}` };
    if (sha512Hex(bytes) !== f.sha512) return { status: "error", error: "SHA-512 no coincide" };
    const tmp = exe + ".new";
    writeFileSync(tmp, bytes);
    if (process.platform !== "win32") chmodSync(tmp, 0o755);
    const prev = exe + ".prev";
    if (existsSync(prev)) rmSync(prev, { force: true });
    // Cambio atómico (Windows: renombrar el .exe en marcha sí se puede).
    if (existsSync(exe)) renameSync(exe, prev);
    renameSync(tmp, exe);
    writeFileSync(pendingFile(o.dir), JSON.stringify({ from: current, to: m.version, exe, prev, at: Date.now(), starts: 0 }));
    return { status: "installed", version: m.version, exe };
  } catch (e) {
    return { status: "error", error: (e as Error).message };
  }
}

/**
 * Al arrancar: si hay una actualización pendiente, cuenta el arranque. Si es el tercero sin llegar a 60 s
 * sano, vuelve al binario anterior y pide reinicio. Devuelve true si hay que salir para reiniciar.
 */
export function onStartPending(dir: string): boolean {
  const file = pendingFile(dir);
  if (!existsSync(file)) return false;
  let p: { from: string; to: string; exe: string; prev: string; starts: number };
  try { p = JSON.parse(readFileSync(file, "utf8")); } catch { rmSync(file, { force: true }); return false; }
  p.starts++;
  if (p.starts > 2 && existsSync(p.prev)) {
    log.error(`la versión ${p.to} no arranca bien: vuelvo a la ${p.from}`);
    try {
      const bad = p.exe + ".bad";
      if (existsSync(bad)) rmSync(bad, { force: true });
      renameSync(p.exe, bad);
      renameSync(p.prev, p.exe);
    } catch (e) { log.error(`no pude volver atrás: ${(e as Error).message}`); }
    rmSync(file, { force: true });
    return true;
  }
  writeFileSync(file, JSON.stringify(p));
  return false;
}

/** Tras HEALTHY_AFTER_MS en marcha: la actualización es buena; se borra la marca (el .prev se queda una versión). */
export function markHealthy(dir: string) {
  const file = pendingFile(dir);
  if (!existsSync(file)) return;
  try {
    const p = JSON.parse(readFileSync(file, "utf8"));
    log.info(`actualización a ${p.to} confirmada`);
  } catch {}
  rmSync(file, { force: true });
}

/** ¿Esta versión está por debajo del mínimo que pide la red? */
export const belowMinimum = (m: Manifest | null, current = VERSION) => !!m?.minNodeVersion && cmpVersion(current, m.minNodeVersion) < 0;

export const RELEASE_CHAIN = CHAIN_ID;
