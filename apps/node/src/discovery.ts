// Descubrimiento de vecinos para resistir bloqueos (protocolo-v3 §9):
//  · `endpoint` que cada nodo publica en la cadena (alta `register`),
//  · semillas DNS: registros TXT con direcciones ws(s)://… (en varios dominios),
//  · y el intercambio de vecinos (PEX) entre enlaces directos, que vive en node.ts.
// Si caen todas las puertas de entrada, el nodo marca estas direcciones y se conecta directo, como Bitcoin.
import { resolveTxt } from "node:dns/promises";
import type { ChainState } from "@velum/core";

const WS_RE = /^wss?:\/\/[^\s,;"']+$/;

/** Direcciones públicas de nodos registrados en la cadena (menos la mía). */
export function chainEndpoints(s: ChainState, me: string, max = 64): string[] {
  const out: string[] = [];
  for (const n of Object.values(s.nodes)) {
    if (n.address === me || !n.endpoint || !WS_RE.test(n.endpoint)) continue;
    out.push(n.endpoint);
    if (out.length >= max) break;
  }
  return out;
}

/** Lee semillas DNS (TXT). Cada registro puede llevar varias direcciones separadas por espacios o comas. */
export async function dnsSeedEndpoints(seeds: string[], timeoutMs = 5_000): Promise<string[]> {
  const out = new Set<string>();
  await Promise.all(seeds.map(async (name) => {
    try {
      const recs = await Promise.race([resolveTxt(name), new Promise<string[][]>((_, rej) => setTimeout(() => rej(new Error("dns")), timeoutMs))]);
      for (const chunks of recs) for (const part of chunks.join("").split(/[\s,;]+/)) if (WS_RE.test(part)) out.add(part);
    } catch { /* semilla caída o bloqueada: se ignora */ }
  }));
  return [...out];
}
