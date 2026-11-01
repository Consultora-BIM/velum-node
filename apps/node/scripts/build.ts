// Prepara la web para descargar el nodo: copia los instaladores a apps/web/public (y /download) y quita
// restos del nodo en .js (v3: solo binarios compilados). Los binarios y el manifiesto firmado los genera
// scripts/release.ts. Opcional: --compile compila el binario de esta plataforma en apps/node/dist/.
//   bun apps/node/scripts/build.ts [--compile]
import { copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";

const here = resolve(import.meta.dir, "..");
const pub = resolve(here, "../web/public");
const dl = join(pub, "download");

mkdirSync(dl, { recursive: true });
for (const f of ["install.sh", "install.ps1"]) {
  copyFileSync(join(here, "install", f), join(dl, f));
  copyFileSync(join(here, "install", f), join(pub, f));
}
if (existsSync(join(dl, "velum-node.js"))) rmSync(join(dl, "velum-node.js"));
console.log(`instaladores copiados a ${pub}/ y ${dl}/ (sin velum-node.js)`);
if (process.argv.includes("--compile")) {
  const { compile } = await import("./release");
  const { currentPlatform } = await import("../src/update");
  const p = currentPlatform();
  if (!p) throw new Error("Plataforma no compatible");
  console.log(`binario: ${await compile(p, join(here, "dist"))}`);
}
