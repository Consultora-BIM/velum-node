// Publica una versión del nodo: binarios por plataforma + manifiesto firmado para la actualización OTA.
//   bun apps/node/scripts/release.ts [--version 2.0.1] [--min 2.0.0] [--only darwin-arm64,linux-x64] [--no-sign]
//
// 1. Compila `bun build --compile --minify` para cada plataforma → apps/node/dist/release/velum-node-<plataforma>[.exe]
//    (macOS: firma ad hoc con `codesign -s -`; no hay Developer ID).
// 2. Firma `manifest.json` = { version, chain, minNodeVersion, files: { <plataforma>: { url, sha512, size } }, ts, sig }
//    con la clave de publicación del Llavero (servicio «velum-release»). sig = ed25519 sobre el JSON canónico sin `sig`.
// 3. Copia el manifiesto (y los binarios que quepan en Cloudflare, ≤ 25 MiB) a apps/web/public/download/.
//    Los que no caben se suben a GitHub Releases (Consultora-BIM/velum-node, etiqueta v<versión>): la URL del
//    manifiesto ya apunta ahí. Variable VELUM_RELEASE_BASE para otra ubicación.
// No despliega nada ni crea repositorios.
import { $ } from "bun";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CHAIN_ID, sha512Hex, sign } from "@velum/core";
import { manifestBody, verifyManifest, RELEASE_PUBLIC_KEY, PLATFORMS, type Manifest, type Platform } from "../src/update";
import { publicOf, readReleaseSecret } from "./release-key";

const here = resolve(import.meta.dir, "..");
const outDir = join(here, "dist/release");
const webDl = resolve(here, "../web/public/download");
/** Límite de Cloudflare para un archivo estático. */
export const CF_ASSET_LIMIT = 25 * 1024 * 1024;

export const TARGETS: Record<Platform, string> = {
  "darwin-arm64": "bun-darwin-arm64",
  "darwin-x64": "bun-darwin-x64",
  "linux-x64": "bun-linux-x64",
  "linux-arm64": "bun-linux-arm64",
  "windows-x64": "bun-windows-x64",
};

export const binaryName = (p: Platform) => `velum-node-${p}${p.startsWith("windows") ? ".exe" : ""}`;
export const defaultBase = (version: string) => process.env.VELUM_RELEASE_BASE?.replace(/\/$/, "") ?? `https://github.com/Consultora-BIM/velum-node/releases/download/v${version}`;

/** Firma un manifiesto (sin `sig`) con una clave secreta hex. */
export function signManifest(m: Omit<Manifest, "sig">, secretHex: string): Manifest {
  return { ...m, sig: sign(secretHex, manifestBody(m)) };
}

/** Compila un binario. Devuelve su ruta. */
export async function compile(p: Platform, out = outDir): Promise<string> {
  mkdirSync(out, { recursive: true });
  const file = join(out, binaryName(p));
  if (existsSync(file)) rmSync(file);
  // La red va dentro del binario (no depende del entorno de quien lo ejecuta). Mainnet exige la génesis completa.
  const network = process.env.VELUM_NETWORK === "testnet" ? "testnet" : "mainnet";
  if (network === "mainnet") await $`bun ${join(here, "../../packages/core/scripts/genesis-mainnet.ts")} --check`;
  await $`bun build ${join(here, "src/main.ts")} --compile --minify --target=${TARGETS[p]} --define ${`__VELUM_NETWORK__="${network}"`} --outfile ${file}`.quiet();
  if (p.startsWith("darwin") && process.platform === "darwin") await $`codesign -s - --force ${file}`.quiet().nothrow();
  return file;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : undefined;
}

if (import.meta.main) {
  const versionFile = join(here, "src/version.ts");
  let version = (readFileSync(versionFile, "utf8").match(/VERSION = "([^"]+)"/) ?? [])[1]!;
  const wanted = arg("--version");
  if (wanted && wanted !== version) {
    if (!/^\d+\.\d+\.\d+$/.test(wanted)) throw new Error("--version debe ser X.Y.Z");
    writeFileSync(versionFile, readFileSync(versionFile, "utf8").replace(/VERSION = "[^"]+"/, `VERSION = "${wanted}"`));
    version = wanted;
  }
  const only = arg("--only")?.split(",") as Platform[] | undefined;
  const platforms = only?.length ? only : PLATFORMS;
  const noSign = process.argv.includes("--no-sign");
  const secret = noSign ? null : await readReleaseSecret();
  if (!noSign && !secret) throw new Error("No hay clave de publicación: ejecuta bun apps/node/scripts/release-key.ts");
  if (secret && publicOf(secret) !== RELEASE_PUBLIC_KEY) throw new Error("La clave del Llavero no es la incrustada en src/update.ts (RELEASE_PUBLIC_KEY)");

  const base = defaultBase(version);
  const files: Manifest["files"] = {};
  const sums: string[] = [];
  const rows: string[] = [];
  for (const p of platforms) {
    const t0 = Date.now();
    const file = await compile(p);
    const bytes = new Uint8Array(readFileSync(file));
    const sha = sha512Hex(bytes);
    const name = binaryName(p);
    files[p] = { url: `${base}/${name}`, sha512: sha, size: bytes.length };
    sums.push(`${sha}  ${name}`);
    const mb = (bytes.length / 1024 / 1024).toFixed(1);
    rows.push(`  ${name.padEnd(30)} ${mb.padStart(6)} MB  ${bytes.length > CF_ASSET_LIMIT ? "→ GitHub Releases (supera 25 MiB)" : "cabe en Cloudflare"}  (${((Date.now() - t0) / 1000).toFixed(0)} s)`);
  }
  const prev = existsSync(join(webDl, "manifest.json")) ? (JSON.parse(readFileSync(join(webDl, "manifest.json"), "utf8")) as Manifest) : null;
  const body: Omit<Manifest, "sig"> = {
    version, chain: CHAIN_ID, minNodeVersion: arg("--min") ?? prev?.minNodeVersion ?? "2.0.0",
    ...(prev?.minAppVersion ? { minAppVersion: prev.minAppVersion } : {}),
    files, ts: Date.now(),
  };
  writeFileSync(join(outDir, "SHA512SUMS"), sums.join("\n") + "\n");
  if (secret) {
    const m = signManifest(body, secret);
    if (!verifyManifest(m)) throw new Error("El manifiesto firmado no se verifica");
    writeFileSync(join(outDir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
    mkdirSync(webDl, { recursive: true });
    copyFileSync(join(outDir, "manifest.json"), join(webDl, "manifest.json"));
    // Sin .js sueltos en la web (protocolo-v3 §10).
    for (const f of ["velum-node.js"]) if (existsSync(join(webDl, f))) rmSync(join(webDl, f));
    for (const p of platforms) {
      const f = join(outDir, binaryName(p));
      if (statSync(f).size <= CF_ASSET_LIMIT) copyFileSync(f, join(webDl, binaryName(p)));
    }
  }
  console.log(`velum-node ${version} (${CHAIN_ID})\n${rows.join("\n")}`);
  console.log(secret ? `manifiesto firmado → ${join(outDir, "manifest.json")} y ${webDl}/manifest.json` : "sin firmar (--no-sign)");
  console.log(`binarios en ${outDir}. Súbelos a ${base}/ (GitHub Releases) antes de publicar el manifiesto.`);
}
