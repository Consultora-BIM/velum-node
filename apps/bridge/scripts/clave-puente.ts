#!/usr/bin/env bun
// Crea la clave Velum del puente (ed25519, en línea). Es la ÚNICA que puede acuñar vUSDT.
// Escribe la semilla en un archivo con permisos 600 y la parte pública en `bridge.public.json` (va al génesis).
//
//   bun scripts/clave-puente.ts [carpeta]     (por defecto .velum-bridge)
//
// Si esta clave se pierde, se rota con una actualización de protocolo (docs/mainnet.md). Si se filtra, quien la tenga
// podría acuñar vUSDT sin respaldo: por eso el puente tiene tope diario de acuñación y la prueba de reservas lo delata.
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateKeyPair } from "@velum/core";

const dir = resolve(process.argv[2] ?? ".velum-bridge");
const keyFile = join(dir, "bridge.key");
const pubFile = join(dir, "bridge.public.json");
if (existsSync(keyFile)) {
  console.error(`${keyFile} ya existe. No la piso.`);
  process.exit(1);
}
mkdirSync(dir, { recursive: true, mode: 0o700 });
const k = generateKeyPair();
writeFileSync(keyFile, k.secret + "\n", { mode: 0o600 });
writeFileSync(pubFile, JSON.stringify({ v: 1, role: "bridge-authority", token: "vUSDT", address: k.address, publicKey: k.publicKey }, null, 2) + "\n");
console.log(`Clave del puente: ${keyFile} (600)\nPública: ${pubFile}\nAutoridad vUSDT: ${k.address}`);
