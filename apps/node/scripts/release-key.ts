// Crea (una sola vez) la clave de publicación ed25519 de los binarios del nodo.
//   bun apps/node/scripts/release-key.ts           crea la clave si no existe y muestra la pública
//   bun apps/node/scripts/release-key.ts --show    solo muestra la pública
// El SECRETO se guarda en el Llavero de macOS (servicio «velum-release», cuenta «release») y nunca en el repo.
// La PÚBLICA (como dirección vel…) va incrustada en apps/node/src/update.ts (RELEASE_PUBLIC_KEY).
import { $ } from "bun";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { bytesToHex, keyPairFromSecret, randomBytes } from "@velum/core";

export const KEYCHAIN_SERVICE = "velum-release";
export const KEYCHAIN_ACCOUNT = "release";

export async function readReleaseSecret(): Promise<string | null> {
  if (process.env.VELUM_RELEASE_SECRET) return process.env.VELUM_RELEASE_SECRET.trim();
  if (process.platform !== "darwin") return null;
  const r = await $`security find-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -w`.nothrow().quiet();
  return r.exitCode === 0 ? r.stdout.toString().trim() : null;
}

/** Clave pública en forma de dirección Velum (vel + base58 de la pública ed25519). */
export const publicOf = (secretHex: string) => keyPairFromSecret(secretHex).address;

if (import.meta.main) {
  let secret = await readReleaseSecret();
  if (!secret && !process.argv.includes("--show")) {
    if (process.platform !== "darwin") throw new Error("Esta herramienta guarda la clave en el Llavero de macOS");
    secret = bytesToHex(randomBytes(32));
    const r = await $`security add-generic-password -s ${KEYCHAIN_SERVICE} -a ${KEYCHAIN_ACCOUNT} -l ${"Velum · clave de publicación del nodo"} -w ${secret}`.nothrow().quiet();
    if (r.exitCode !== 0) throw new Error("No se pudo guardar la clave en el Llavero: " + r.stderr.toString());
    console.log(`clave nueva guardada en el Llavero (servicio «${KEYCHAIN_SERVICE}», cuenta «${KEYCHAIN_ACCOUNT}»)`);
  }
  if (!secret) throw new Error("No hay clave de publicación en el Llavero");
  const pub = publicOf(secret);
  console.log(`clave pública: ${pub}`);
  // Si update.ts tiene otra pública, se actualiza (así release.ts y el nodo siempre cuadran).
  const file = resolve(import.meta.dir, "../src/update.ts");
  const src = readFileSync(file, "utf8");
  const next = src.replace(/export const RELEASE_PUBLIC_KEY = "[^"]*";/, `export const RELEASE_PUBLIC_KEY = "${pub}";`);
  if (next !== src) { writeFileSync(file, next); console.log("apps/node/src/update.ts actualizado con la clave pública"); }
}
