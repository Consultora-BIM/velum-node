// Identidad y configuración del nodo. Todo vive en ~/.velum (o VELUM_HOME).
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { GATEWAYS, NODE_PORT, generateKeyPair, keyPairFromSecret, isAddress, type KeyPair } from "@velum/core";

export interface NodeConfig {
  /** Opcional y decorativo. Vacío por defecto: el nodo se identifica por su dirección. */
  name: string;
  /** true solo si el operador puso el nombre a mano (--name). */
  nameExplicit?: boolean;
  /** Cartera que cobra las recompensas. */
  payout: string;
  /**
   * Puertas de entrada (ws/wss) por orden de preferencia, o ["none"] para ir solo con pares directos.
   * Si una falla se prueba la siguiente; si fallan todas, el nodo sigue con pares directos (cadena + PEX + DNS).
   */
  gateways: string[];
  port: number;
  /** Pares directos (ws://host:puerto/ws). */
  peers: string[];
  /** Dirección pública por la que otros nodos pueden llamarnos (opcional). Se publica en la cadena. */
  endpoint?: string;
  /** Semillas DNS (registros TXT con `ws(s)://…` separados por espacios o comas). */
  dnsSeeds: string[];
  paused: boolean;
  /** Actualización automática firmada (cada hora). */
  autoUpdate: boolean;
}

export const dataDir = () => process.env.VELUM_HOME || join(homedir(), ".velum");

export function loadKeys(dir: string): KeyPair {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "node.key");
  if (existsSync(file)) return keyPairFromSecret(readFileSync(file, "utf8").trim());
  const k = generateKeyPair();
  writeFileSync(file, k.secret + "\n", { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  return k;
}

export interface CliArgs {
  cmd: string;
  name?: string;
  payout?: string;
  port?: number;
  gateways: string[];
  peers: string[];
  endpoint?: string;
  dnsSeeds: string[];
  autoUpdate?: boolean;
  rest: string[];
}

export function parseArgs(argv: string[]): CliArgs {
  const out: CliArgs = { cmd: "start", peers: [], gateways: [], dnsSeeds: [], rest: [] };
  let cmdSet = false;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const val = () => {
      const eq = a.indexOf("=");
      if (eq > 0) return a.slice(eq + 1);
      const v = argv[++i];
      if (v === undefined) throw new Error(`Falta el valor de ${a}`);
      return v;
    };
    const key = a.split("=")[0];
    if (key === "--name") out.name = val();
    else if (key === "--payout") out.payout = val();
    else if (key === "--port") out.port = Number(val());
    else if (key === "--gateway") out.gateways.push(...val().split(",").map((s) => s.trim()).filter(Boolean));
    else if (key === "--peer") out.peers.push(val());
    else if (key === "--endpoint") out.endpoint = val();
    else if (key === "--dns-seed") out.dnsSeeds.push(val());
    else if (a === "--no-auto-update") out.autoUpdate = false;
    else if (a === "--auto-update") out.autoUpdate = true;
    else if (a === "-h" || a === "--help") out.cmd = "help";
    else if (!a.startsWith("-") && !cmdSet) { out.cmd = a; cmdSet = true; }
    else if (!a.startsWith("-")) out.rest.push(a);
    else throw new Error(`Opción desconocida: ${a}`);
  }
  return out;
}

const splitList = (v: string) => v.split(",").map((s) => s.trim()).filter(Boolean);

/** Lee config.json, aplica variables de entorno y opciones de la línea de órdenes, y guarda lo que venga de la CLI. */
export function loadConfig(dir: string, nodeAddress: string, args: CliArgs): NodeConfig {
  const file = join(dir, "config.json");
  let saved: Partial<NodeConfig> & { gateway?: string | string[] } = {};
  if (existsSync(file)) {
    try { saved = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error(`config.json no es JSON válido (${file})`); }
  }
  // v1 guardaba `gateway` (texto). v2 acepta texto o lista y lo guarda como `gateways`.
  const savedGw = saved.gateways ?? (typeof saved.gateway === "string" ? [saved.gateway] : Array.isArray(saved.gateway) ? saved.gateway : undefined);
  const cfg: NodeConfig = {
    // Un nodo es su dirección. Sin nombre por defecto: nada del ordenador, del usuario ni etiquetas inventadas.
    // Solo se conserva un nombre que el operador puso a mano (--name); los nombres por defecto antiguos se descartan.
    name: (saved.nameExplicit ? saved.name ?? "" : "").slice(0, 40),
    nameExplicit: saved.nameExplicit === true,
    payout: saved.payout || nodeAddress,
    gateways: savedGw?.length ? savedGw : [...GATEWAYS],
    port: saved.port || NODE_PORT,
    peers: Array.isArray(saved.peers) ? saved.peers : [],
    endpoint: saved.endpoint,
    dnsSeeds: Array.isArray(saved.dnsSeeds) ? saved.dnsSeeds : [],
    paused: saved.paused === true,
    autoUpdate: saved.autoUpdate !== false,
  };
  if (args.name !== undefined) { cfg.name = args.name.slice(0, 40); cfg.nameExplicit = cfg.name !== ""; }
  if (args.payout) cfg.payout = args.payout;
  if (args.port) cfg.port = args.port;
  if (args.gateways.length) cfg.gateways = args.gateways;
  if (args.endpoint) cfg.endpoint = args.endpoint;
  if (args.autoUpdate !== undefined) cfg.autoUpdate = args.autoUpdate;
  for (const p of args.peers) if (!cfg.peers.includes(p)) cfg.peers.push(p);
  for (const d of args.dnsSeeds) if (!cfg.dnsSeeds.includes(d)) cfg.dnsSeeds.push(d);
  if (!isAddress(cfg.payout)) throw new Error(`Cartera de cobro no válida: ${cfg.payout}`);
  if (!Number.isInteger(cfg.port) || cfg.port <= 0 || cfg.port > 65535) throw new Error(`Puerto no válido: ${cfg.port}`);
  saveConfig(dir, cfg);
  // El entorno manda en esta ejecución, pero no se guarda.
  const env = { ...cfg, peers: [...cfg.peers], gateways: [...cfg.gateways] };
  if (process.env.VELUM_GATEWAY) env.gateways = splitList(process.env.VELUM_GATEWAY);
  if (process.env.VELUM_PORT) env.port = Number(process.env.VELUM_PORT);
  if (process.env.VELUM_PEERS) for (const p of splitList(process.env.VELUM_PEERS)) if (!env.peers.includes(p)) env.peers.push(p);
  if (process.env.VELUM_AUTO_UPDATE === "0") env.autoUpdate = false;
  return env;
}

export function saveConfig(dir: string, cfg: NodeConfig) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg, null, 2) + "\n");
}

/** Guarda solo el campo `paused` sin pisar lo demás. */
export function savePaused(dir: string, paused: boolean) {
  const file = join(dir, "config.json");
  let saved: any = {};
  try { saved = JSON.parse(readFileSync(file, "utf8")); } catch {}
  saved.paused = paused;
  writeFileSync(file, JSON.stringify(saved, null, 2) + "\n");
}

/** Id corto y estable de un nodo: "vel" + 6 caracteres de su dirección. */
export const shortId = (address: string) => address.slice(0, 9);

export const gatewayEnabled = (g: string) => !!g && g !== "none" && g !== "off";
/** Puertas utilizables de la configuración. */
export const activeGateways = (cfg: NodeConfig) => cfg.gateways.filter(gatewayEnabled);
