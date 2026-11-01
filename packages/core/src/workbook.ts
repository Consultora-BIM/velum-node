// Libro de trabajo del nodo (protocolo-v3 «Notas de implementación» C): lo usan el nodo completo y el ligero.
//
//  1. Cada recibo válido con foto conocida → una hoja { r, papel } por cada papel en que este nodo figura
//     y está entre los 3 candidatos del sorteo. Se apunta al lote de la época de cabeza (floor((altura−1)/30)).
//  2. Al entrar la cabeza en E+1: árbol de Merkle del lote E → `work.claim { epoch: E, count, root }`.
//  3. Al llegar la foto E+3: muestras de la baliza + su vecina (`proofIndices`) → `work.prove { epoch: E, leaves, paths }`.
//  4. Pasada E+5, se olvida el lote.
// Sin estado de cadena ni reloj: quien lo usa le pasa la altura y las fotos.
import { buildWorkTree, claimSamples, proofIndices, workPath, type WorkLeaf, type WorkTree } from "./claims";
import { lotteryCandidates, type EpochSnapshot, type LotteryRole } from "./lottery";
import { checkReceiptProof, type ReceiptV2 } from "./proof";
import { EPOCH_BLOCKS } from "./constants";

/** Épocas tras la reclamada en que llega la baliza de muestreo (E+3) y en que se liquida (E+4). */
export const WORK_SAMPLE_LAG = 3;
export const WORK_SETTLE_LAG = 4;
/** Un recibo solo sirve para lotes de su época de foto hasta 10 épocas después. */
export const WORK_LEAF_MAX_AGE = 10;

interface Batch {
  leaves: WorkLeaf[];
  keys: Set<string>;
  tree?: WorkTree;
}

export type WorkAction =
  | { kind: "claim"; epoch: number; count: number; root: string }
  | { kind: "prove"; epoch: number; leaves: WorkLeaf[]; paths: string[][] };

/** Época de trabajo de un bloque de altura h (los bloques 30e+1 … 30e+30 son de la época e). */
export const workEpochOf = (height: number) => Math.max(0, Math.floor((height - 1) / EPOCH_BLOCKS));

export class WorkBook {
  private batches = new Map<number, Batch>();
  /** Estado por época ya enviado: "claimed" → esperando muestra; "proved" → hecho. */
  private sent = new Map<number, { claimAt?: number; proveAt?: number }>();

  /** Por qué se descartaron recibos (diagnóstico para paneles y pruebas). */
  readonly skipped: Record<string, number> = {};
  private skip(why: string) { this.skipped[why] = (this.skipped[why] ?? 0) + 1; return 0; }

  constructor(readonly me: string) {}

  /** Hojas apuntadas por época (para paneles y pruebas). */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.batches].map(([e, b]) => [String(e), b.leaves.length]));
  }

  /**
   * Apunta un recibo. `snapFor(ep)` devuelve la foto de esa época (o null). Devuelve cuántas hojas añadió.
   * El recibo debe ser válido (secreto = huella); se ignoran los que no nombran a este nodo.
   */
  add(r: ReceiptV2, height: number, snapFor: (ep: number) => EpochSnapshot | null | undefined): number {
    if (!r || !checkReceiptProof(r)) return this.skip("prueba");
    if (r.ep === undefined) return this.skip("sin época");
    // En el bloque que abre una época la foto nueva ya existe pero la cabeza aún cuenta como la anterior:
    // un recibo con ep = E+1 va al lote E+1 (la cadena exige ep ≤ época reclamada).
    const head = workEpochOf(height);
    const E = r.ep === head + 1 ? head + 1 : head;
    if (r.ep > E || r.ep < E - WORK_LEAF_MAX_AGE) return this.skip("época fuera de rango");
    const snap = snapFor(r.ep);
    if (!snap) return this.skip("sin foto");
    let added = 0;
    for (const role of ["carrier", "courier"] as LotteryRole[]) {
      if (r[role] !== this.me) continue;
      if (!lotteryCandidates(snap, r.shard, role).includes(this.me)) { this.skip(`no candidato (${role})`); continue; }
      const key = `${r.rh}|${role}`;
      const b = this.batches.get(E) ?? this.batches.set(E, { leaves: [], keys: new Set() }).get(E)!;
      if (b.tree || b.keys.has(key) || this.seenEarlier(key, E)) continue;
      b.keys.add(key);
      b.leaves.push({ r, role });
      added++;
    }
    return added;
  }

  private seenEarlier(key: string, E: number) {
    for (const [e, b] of this.batches) if (e !== E && b.keys.has(key)) return true;
    return false;
  }

  /**
   * Qué toca enviar con la cabeza en `height`. `claimed(E)` dice si la cadena ya tiene la reclamación
   * (y su estado). Reenvía si pasaron `retryMs` sin que entrara.
   */
  due(
    height: number,
    snapFor: (ep: number) => EpochSnapshot | null | undefined,
    onChain: (E: number) => { status: string; count: number } | null,
    now = Date.now(),
    retryMs = 20_000,
  ): WorkAction[] {
    const cur = workEpochOf(height + 1); // época del próximo bloque
    const out: WorkAction[] = [];
    for (const [E, b] of [...this.batches].sort((x, y) => x[0] - y[0])) {
      if (cur > E + WORK_SETTLE_LAG + 1) { this.batches.delete(E); this.sent.delete(E); continue; }
      const st = this.sent.get(E) ?? {};
      const chain = onChain(E);
      if (cur === E + 1 && !chain && b.leaves.length) {
        b.tree ??= buildWorkTree(b.leaves);
        if (!st.claimAt || now - st.claimAt > retryMs) {
          out.push({ kind: "claim", epoch: E, count: b.tree.count, root: b.tree.root });
          this.sent.set(E, { ...st, claimAt: now });
        }
      } else if (chain?.status === "pending" && cur >= E + WORK_SAMPLE_LAG && cur <= E + WORK_SETTLE_LAG && b.tree && chain.count === b.tree.count) {
        const snap = snapFor(E + WORK_SAMPLE_LAG);
        if (!snap) continue;
        if (!st.proveAt || now - st.proveAt > retryMs) {
          // Muestras y su vecina (la cadena comprueba que el árbol está ordenado y sin repetidas).
          const idx = proofIndices(claimSamples(snap.beacon, this.me, E, b.tree.count), b.tree.count);
          const tree = b.tree;
          out.push({ kind: "prove", epoch: E, leaves: idx.map((i) => tree.leaves[i]!), paths: idx.map((i) => workPath(tree, i)) });
          this.sent.set(E, { ...st, proveAt: now });
        }
      }
    }
    return out;
  }
}
