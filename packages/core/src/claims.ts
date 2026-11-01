// Reclamaciones de trabajo con muestreo (protocolo-v3 §4 y «Notas de implementación» C).
//
// Los recibos ya no entran uno a uno en los bloques. Cada nodo mete sus recibos de la época en un árbol
// de Merkle (SHA-512) y publica `work.claim { epoch, count, root }`. Una baliza posterior elige 16 hojas;
// el nodo las enseña con su camino (`work.prove`). Si una falla o no responde a tiempo, la reclamación es nula.
// Este archivo es puro (sin estado de cadena): lo usan la máquina de estados, el nodo y los vectores.
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, canonical, concatBytes, hexToBytes, utf8ToBytes } from "./bytes";
import { CLAIM_SAMPLES } from "./constants";
import type { ReceiptV2 } from "./proof";
import type { LotteryRole } from "./lottery";

/** Hoja: un recibo y el papel por el que el nodo cobra. */
export interface WorkLeaf {
  r: ReceiptV2;
  role: LotteryRole;
}

/** Hash de una hoja: sha512(JSON canónico), hex 128. */
export const leafHash = (leaf: WorkLeaf) => bytesToHex(sha512(utf8ToBytes(canonical(leaf))));

const H128 = /^[0-9a-f]{128}$/;
const pairHash = (a: string, b: string) => bytesToHex(sha512(concatBytes(hexToBytes(a), hexToBytes(b))));

/**
 * Árbol completo por niveles (nivel 0 = hojas). Las hojas van ORDENADAS por hash y sin repetir: así la prueba
 * puede exigir `hash(i) < hash(i+1)` y una hoja duplicada para inflar la cuenta se ve al muestrear.
 * Nivel impar: el último se empareja consigo mismo. Raíz = sha512("velum/v3/root|" + count + "|" + cima):
 * la cuenta va atada a la raíz.
 */
export interface WorkTree {
  levels: string[][];
  root: string;
  count: number;
  /** Hojas en el orden del árbol (ordenadas por hash). Vacío si se construyó con hashes sueltos. */
  leaves: WorkLeaf[];
}

export const rootOf = (top: string, count: number) => bytesToHex(sha512(utf8ToBytes(`velum/v3/root|${count}|${top}`)));

export function buildWorkTree(input: WorkLeaf[] | string[]): WorkTree {
  if (!input.length) throw new Error("Árbol sin hojas");
  const rows = (input as (WorkLeaf | string)[]).map((l) => (typeof l === "string" ? { h: l, l: null } : { h: leafHash(l), l }));
  rows.sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0));
  const uniq = rows.filter((r, i) => i === 0 || r.h !== rows[i - 1]!.h);
  let level = uniq.map((r) => r.h);
  const levels = [level];
  while (level.length > 1) {
    const next: string[] = [];
    for (let i = 0; i < level.length; i += 2) next.push(pairHash(level[i]!, level[i + 1] ?? level[i]!));
    level = next;
    levels.push(level);
  }
  return { levels, root: rootOf(level[0]!, uniq.length), count: uniq.length, leaves: uniq.flatMap((r) => (r.l ? [r.l] : [])) };
}

/** Profundidad del árbol de `count` hojas (= longitud de cada camino). */
export function treeDepth(count: number): number {
  let d = 0;
  for (let n = count; n > 1; n = Math.ceil(n / 2)) d++;
  return d;
}

/** Camino de la hoja `index`: hermanos de abajo arriba. */
export function workPath(tree: WorkTree, index: number): string[] {
  const out: string[] = [];
  let i = index;
  for (let l = 0; l < tree.levels.length - 1; l++) {
    const lv = tree.levels[l]!;
    out.push(lv[i ^ 1] ?? lv[i]!);
    i >>= 1;
  }
  return out;
}

/** Comprueba que `leafH` está en la posición `index` de un árbol de `count` hojas con raíz `root`. */
export function verifyWorkPath(leafH: string, index: number, count: number, path: unknown, root: string): boolean {
  if (!Array.isArray(path) || path.length !== treeDepth(count) || index < 0 || index >= count) return false;
  let h = leafH;
  let i = index;
  let n = count;
  for (const sib of path) {
    if (typeof sib !== "string" || !H128.test(sib)) return false;
    const isLastOdd = (i ^ 1) >= n; // sin hermano: se empareja consigo mismo
    if (isLastOdd && sib !== h) return false;
    h = i & 1 ? pairHash(sib, h) : pairHash(h, sib);
    i >>= 1;
    n = Math.ceil(n / 2);
  }
  return rootOf(h, count) === root;
}

/**
 * Posiciones que lleva una prueba: por cada muestra `i`, la hoja `i` y su vecina `i+1` (si existe), en ese orden.
 * La cadena exige `hash(i) < hash(i+1)`: con hojas ordenadas y sin repetir, un árbol con duplicados se delata.
 */
export const proofIndices = (samples: number[], count: number) => samples.flatMap((i) => (i + 1 < count ? [i, i + 1] : [i]));

/** Entero de 64 bits del hash (mod count). */
function draw(beacon: string, node: string, epoch: number, k: number): bigint {
  const h = sha512(utf8ToBytes(`velum/v3/sample|${beacon}|${node}|${epoch}|${k}`));
  let n = 0n;
  for (let i = 0; i < 8; i++) n = (n << 8n) | BigInt(h[i]!);
  return n;
}

/**
 * Índices que hay que probar: min(16, count) distintos, en orden de sorteo.
 * Determinista con la baliza de la foto E+3 (nadie la conoce al reclamar).
 */
export function claimSamples(beacon: string, node: string, epoch: number, count: number, n = CLAIM_SAMPLES): number[] {
  const want = Math.min(n, count);
  const out: number[] = [];
  const seen = new Set<number>();
  for (let k = 0; out.length < want; k++) {
    const x = Number(draw(beacon, node, epoch, k) % BigInt(count));
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}
