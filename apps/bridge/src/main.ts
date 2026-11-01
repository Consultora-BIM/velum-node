#!/usr/bin/env bun
// Servicio del puente (en línea). Sin claves de depósito: solo xpub y la clave Velum que acuña vUSDT.
//
//   bun src/main.ts                       servicio: vigila depósitos y canjes, acuña, publica reservas
//   bun src/main.ts exportar [archivo]    cola de retiros de hoy para firmar SIN CONEXIÓN
//   bun src/main.ts barrer <cadena> [mín] cola de barrido (gas + USDT a la tesorería)
//   bun src/main.ts reservas              imprime la prueba de reservas
//   bun src/main.ts estado                imprime el estado
//
// HTTP (solo en local por defecto, el nodo lo reenvía):
//   POST /rpc { method: "bridge.address" | "bridge.status" | "bridge.reserves" | "bridge.lookup", params }
//   GET  /reserves   prueba de reservas (JSON público, para el explorador)
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { keyPairFromSecret } from "@velum/core";
import { loadConfig, type BridgeConfig } from "./config";
import { ChainClient } from "./chains";
import { Bridge, BridgeError, type ColdPublic } from "./bridge";
import { CHAINS, type ChainId } from "./hd";
import { Store } from "./store";
import { VelumWs } from "./velum";
import { queueHash, summarizeQueue } from "./offline";

export function loadColdPublic(path: string): ColdPublic {
  if (!existsSync(path)) throw new Error(`Falta ${path} (cartera fría). Lo genera el propietario con apps/node/scripts/cold-wallet.ts.`);
  const j = JSON.parse(readFileSync(path, "utf8"));
  if (!j?.tron?.xpub || !j?.evm?.xpub || !j?.velum?.address || !j?.fingerprint) throw new Error(`${path} no es un archivo de cartera fría válido`);
  return j;
}

export function loadBridgeKey(path: string) {
  if (!existsSync(path)) throw new Error(`Falta la clave del puente (${path}). Créala con: bun scripts/clave-puente.ts`);
  const hex = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`${path} no contiene una clave válida`);
  return keyPairFromSecret(hex);
}

export function buildBridge(cfg: BridgeConfig) {
  const cold = loadColdPublic(cfg.coldWalletFile);
  const key = loadBridgeKey(cfg.bridgeKeyFile);
  const velum = new VelumWs(cfg.velumUrl);
  const chains: Partial<Record<ChainId, ChainClient>> = {};
  for (const c of CHAINS) if (cfg.chains[c].enabled) chains[c] = new ChainClient(cfg.chains[c]);
  return { bridge: new Bridge(cfg, cold, key, velum, chains, new Store(cfg.dataDir)), velum };
}

/** Límite sencillo por IP para /rpc (ventana de 1 min). */
function rateLimiter(perMin: number) {
  const hits = new Map<string, number[]>();
  return (ip: string) => {
    const now = Date.now();
    const xs = (hits.get(ip) ?? []).filter((t) => t > now - 60_000);
    xs.push(now);
    hits.set(ip, xs);
    if (hits.size > 10_000) hits.clear();
    return xs.length <= perMin;
  };
}

export function serve(bridge: Bridge, cfg: BridgeConfig) {
  const allow = rateLimiter(60);
  let cachedReserves: { at: number; body: unknown } | null = null;
  const reserves = async () => {
    if (!cachedReserves || Date.now() - cachedReserves.at > 60_000) {
      const body = await bridge.reserves();
      cachedReserves = { at: Date.now(), body };
      writeFileSync(join(cfg.dataDir, "reservas.json"), JSON.stringify(body, null, 1));
    }
    return cachedReserves.body;
  };
  const cors = { "access-control-allow-origin": "*", "cache-control": "no-store" };
  return Bun.serve({
    port: cfg.port,
    hostname: cfg.host,
    async fetch(req, server) {
      const url = new URL(req.url);
      try {
        if (url.pathname === "/reserves" && req.method === "GET") return Response.json(await reserves(), { headers: cors });
        if (url.pathname === "/rpc" && req.method === "POST") {
          if (!allow(server.requestIP(req)?.address ?? "?")) return Response.json({ error: "Demasiadas peticiones" }, { status: 429, headers: cors });
          const { method, params } = (await req.json()) as { method: string; params: any };
          let result: unknown;
          switch (method) {
            case "bridge.address": result = bridge.address(params ?? {}); break;
            case "bridge.status": result = bridge.status(); break;
            case "bridge.reserves": result = await reserves(); break;
            case "bridge.lookup": result = bridge.lookup(params ?? {}); break;
            default: return Response.json({ error: "Método desconocido" }, { status: 404, headers: cors });
          }
          return Response.json({ result }, { headers: cors });
        }
        return new Response("No encontrado", { status: 404 });
      } catch (e) {
        const code = e instanceof BridgeError ? e.code : "error";
        return Response.json({ error: (e as Error).message, code }, { status: code === "closed" ? 503 : 400, headers: cors });
      }
    },
  });
}

async function main() {
  const cfg = loadConfig();
  const [cmd, ...args] = process.argv.slice(2);
  const { bridge, velum } = buildBridge(cfg);
  const out = (o: unknown) => console.log(JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  try {
    switch (cmd) {
      case undefined:
      case "servir": {
        const srv = serve(bridge, cfg);
        console.log(`[puente] ${cfg.enabled ? "ABIERTO" : "cerrado (" + "BRIDGE_ENABLED=false" + ")"} · http://${cfg.host}:${srv.port} · autoridad ${bridge.bridgeAddress}`);
        const loop = async () => { await bridge.tick(); setTimeout(loop, cfg.pollMs); };
        await loop();
        return;
      }
      case "exportar": {
        const q = await bridge.exportWithdrawals();
        const file = args[0] ?? join(cfg.dataDir, `retiros-${new Date().toISOString().slice(0, 10)}.json`);
        writeFileSync(file, JSON.stringify(q, null, 1));
        console.log(summarizeQueue(q));
        console.log(`\n${q.entries.length} retiros → ${file}\nHuella de la cola: ${queueHash(q).slice(0, 16)}\nLleva el archivo al equipo sin conexión y firma con scripts/firmar-retiros.ts.`);
        break;
      }
      case "barrer": {
        const chain = args[0] as ChainId;
        const q = await bridge.planSweep(chain, BigInt(args[1] ?? "1000000"));
        const file = join(cfg.dataDir, `barrido-${chain}-${new Date().toISOString().slice(0, 10)}.json`);
        writeFileSync(file, JSON.stringify(q, null, 1));
        console.log(summarizeQueue(q));
        console.log(`\n→ ${file}`);
        break;
      }
      case "reservas": out(await bridge.reserves()); break;
      case "estado": out(bridge.status()); break;
      default: console.error(`Orden desconocida: ${cmd}`); process.exitCode = 1;
    }
  } finally {
    if (cmd && cmd !== "servir") velum.close();
  }
}

if (import.meta.main) main().catch((e) => { console.error(`Error: ${(e as Error).message}`); process.exit(1); });
