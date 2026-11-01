// Rutas por sorteo público (docs/investigacion.md §5.4.2 y §5.6.4).
//
// Problema: con recibos anónimos, un nodo podría mandarse tráfico falso a sus propios buzones y cobrar.
// Solución: el nodo que cobra por cada trozo NO lo elige nadie. Sale de un sorteo público y determinista:
//
//   asignado(trozo, papel) = elección ponderada en la foto de nodos de la época
//                            con sha512(baliza ‖ "|" ‖ id del trozo ‖ "|" ‖ papel)
//
//  · baliza = hash del último bloque de la época anterior (nadie lo conoce antes de que exista).
//  · foto   = nodos (completos y ligeros) dados de alta antes del inicio de la época y con señal de vida reciente.
//  · papel  = "carrier" (quien acepta el trozo) o "courier" (quien lo entrega).
//
// Un recibo solo da crédito a los papeles cuyo nodo coincide con el sorteado. Si un atacante con una parte
// `s` del peso se inventa F trozos, a sus nodos les tocan s·F: su parte del premio sigue siendo `s`.
// Límite honesto: quien elige el id del trozo (el emisor) puede probar ids hasta caer en su nodo. Eso lo
// frenan el tope por (nodo, buzón) y época y, en la hoja de ruta, el cupo RLN por identidad.
import { sha512 } from "@noble/hashes/sha2.js";
import { utf8ToBytes } from "./bytes";
import type { NodeKind } from "./constants";

export type LotteryRole = "carrier" | "courier";

/** Nodo de la foto con su peso en el sorteo. */
export interface LotteryNode { node: string; w: number }

/** Foto de la época: con ella cualquiera (cliente, nodo, cadena) calcula el mismo sorteo. */
export interface EpochSnapshot {
  epoch: number;
  /** Hash del último bloque de la época anterior. */
  beacon: string;
  /** Ordenados por dirección. */
  nodes: LotteryNode[];
  /** Σ pesos. */
  total: number;
}

/** Peso en el sorteo: completo 2, ligero 1 (el móvil pesa la mitad, igual que su multiplicador de cobro). */
export const lotteryWeight = (kind: NodeKind | undefined) => (kind === "light" ? 1 : 2);

/** Entero de 64 bits a partir del hash (sin sesgo apreciable para pesos pequeños). Ronda 0 = sin sufijo. */
function draw(beacon: string, shardId: string, role: LotteryRole, round = 0): bigint {
  const h = sha512(utf8ToBytes(round === 0 ? `${beacon}|${shardId}|${role}` : `${beacon}|${shardId}|${role}|${round}`));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]!);
  return n;
}

/** Nodo al que le toca un papel para un trozo. Null si la foto está vacía. */
export function assignedNode(snap: EpochSnapshot | null | undefined, shardId: string, role: LotteryRole): string | null {
  if (!snap || !snap.total || !snap.nodes.length) return null;
  let x = Number(draw(snap.beacon, shardId, role) % BigInt(snap.total));
  for (const n of snap.nodes) {
    if (x < n.w) return n.node;
    x -= n.w;
  }
  return snap.nodes[snap.nodes.length - 1]!.node;
}

/** Nº de candidatos por trozo y papel en v3 (protocolo-v3 §3: el cliente usa el de menor latencia). */
export const LOTTERY_CANDIDATES = 3;

/**
 * Hasta `n` candidatos distintos por sorteo ponderado sin reemplazo. El primero es siempre `assignedNode`.
 * Ronda i ≥ 1: sha512(baliza|trozo|papel|i), sobre los nodos aún no elegidos.
 *
 * Cadena v3: cobra «quien lo llevó, si está entre los 3 candidatos» (hojas de `work.claim`, con tope de
 * verosimilitud esperado × 1,5 y muestreo; state.ts / claims.ts). El cliente (client.ts › pushShards/ack)
 * puede elegir el candidato de menor latencia en vez del 0.
 */
export function lotteryCandidates(snap: EpochSnapshot | null | undefined, shardId: string, role: LotteryRole, n = LOTTERY_CANDIDATES): string[] {
  if (!snap || !snap.total || !snap.nodes.length) return [];
  const first = assignedNode(snap, shardId, role)!;
  const out = [first];
  let pool = snap.nodes.filter((x) => x.node !== first);
  for (let round = 1; out.length < n && pool.length; round++) {
    const total = pool.reduce((a, x) => a + x.w, 0);
    let x = Number(draw(snap.beacon, shardId, role, round) % BigInt(total));
    let pick = pool[pool.length - 1]!;
    for (const c of pool) { if (x < c.w) { pick = c; break; } x -= c.w; }
    out.push(pick.node);
    pool = pool.filter((c) => c !== pick);
  }
  return out;
}

/** Ruta completa de un trozo: a quién se le entrega y quién cobra por repartirlo. */
export function lotteryRoute(snap: EpochSnapshot | null | undefined, shardId: string) {
  return { carrier: assignedNode(snap, shardId, "carrier"), courier: assignedNode(snap, shardId, "courier") };
}

/**
 * Construye una foto (ordena y suma). `w` (entero > 0) sustituye al peso por tipo: la cadena v3 pone
 * tipo × nivel × fianza (state.ts › nodeWeight). Los nodos con peso 0 no entran.
 */
export function makeSnapshot(epoch: number, beacon: string, nodes: { node: string; kind?: NodeKind; w?: number }[]): EpochSnapshot {
  const list = nodes.map((n) => ({ node: n.node, w: n.w ?? lotteryWeight(n.kind) })).filter((n) => n.w > 0).sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : 0));
  return { epoch, beacon, nodes: list, total: list.reduce((a, n) => a + n.w, 0) };
}
