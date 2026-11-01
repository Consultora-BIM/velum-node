// Reed–Solomon sistemático sobre GF(256) (polinomio 0x11d), implementación propia.
// Matriz de codificación [I ; C] con C de Cauchy: cualquier subconjunto de k filas es invertible,
// así que bastan k trozos cualesquiera de los n. Multiplicación con tablas log/antilog y una
// tabla de 256 bytes por coeficiente para que codificar 2 MB tarde milisegundos.

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255]!;
})();

export const gfMul = (a: number, b: number) => (a === 0 || b === 0 ? 0 : EXP[LOG[a]! + LOG[b]!]!);
export const gfInv = (a: number) => {
  if (a === 0) throw new Error("GF(256): inverso de 0");
  return EXP[255 - LOG[a]!]!;
};

/** Tabla de multiplicar por una constante (cacheada). */
const MUL = new Map<number, Uint8Array>();
function mulTable(c: number): Uint8Array {
  let t = MUL.get(c);
  if (!t) {
    t = new Uint8Array(256);
    for (let i = 0; i < 256; i++) t[i] = gfMul(c, i);
    MUL.set(c, t);
  }
  return t;
}

/** out ^= c · src */
function mulAdd(out: Uint8Array, src: Uint8Array, c: number) {
  if (c === 0) return;
  const len = out.length;
  if (c === 1) {
    for (let i = 0; i < len; i++) out[i]! ^= src[i]!;
    return;
  }
  const t = mulTable(c);
  for (let i = 0; i < len; i++) out[i]! ^= t[src[i]!]!;
}

/** Fila `r` (0..n-1) de la matriz de codificación k×n. */
function matrixRow(r: number, k: number): number[] {
  if (r < k) return Array.from({ length: k }, (_, j) => (j === r ? 1 : 0));
  // Cauchy: x_i = r, y_j = j  (x ∉ {y}); 1 / (x ⊕ y)
  return Array.from({ length: k }, (_, j) => gfInv(r ^ j));
}

/** Calcula los n-k trozos de paridad a partir de k trozos de datos del mismo tamaño. */
export function rsEncode(data: Uint8Array[], n: number): Uint8Array[] {
  const k = data.length;
  if (k < 1 || n <= k || n > 256) throw new Error("Reed–Solomon: parámetros no válidos");
  const size = data[0]!.length;
  if (data.some((d) => d.length !== size)) throw new Error("Reed–Solomon: trozos de distinto tamaño");
  const out: Uint8Array[] = [];
  for (let r = k; r < n; r++) {
    const row = matrixRow(r, k);
    const p = new Uint8Array(size);
    for (let j = 0; j < k; j++) mulAdd(p, data[j]!, row[j]!);
    out.push(p);
  }
  return out;
}

/** Invierte una matriz k×k en GF(256) (Gauss-Jordan). */
function invert(m: number[][]): number[][] {
  const k = m.length;
  const a = m.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < k; c++) {
    let p = c;
    while (p < k && a[p]![c] === 0) p++;
    if (p === k) throw new Error("Reed–Solomon: matriz singular");
    [a[c], a[p]] = [a[p]!, a[c]!];
    const inv = gfInv(a[c]![c]!);
    for (let j = 0; j < 2 * k; j++) a[c]![j] = gfMul(a[c]![j]!, inv);
    for (let r = 0; r < k; r++) {
      if (r === c || a[r]![c] === 0) continue;
      const f = a[r]![c]!;
      for (let j = 0; j < 2 * k; j++) a[r]![j]! ^= gfMul(f, a[c]![j]!);
    }
  }
  return a.map((row) => row.slice(k));
}

/**
 * Recupera los k trozos de datos a partir de cualesquiera k de los n (los que faltan, null).
 * Lanza si hay menos de k.
 */
export function rsDecode(shards: (Uint8Array | null | undefined)[], k: number): Uint8Array[] {
  const have: number[] = [];
  for (let i = 0; i < shards.length && have.length < k; i++) if (shards[i]) have.push(i);
  if (have.length < k) throw new Error("Reed–Solomon: faltan trozos");
  // Atajo: todos los de datos presentes.
  if (have.every((i, j) => i === j)) return have.map((i) => shards[i]!);
  const inv = invert(have.map((r) => matrixRow(r, k)));
  const size = shards[have[0]!]!.length;
  const out: Uint8Array[] = [];
  for (let d = 0; d < k; d++) {
    if (shards[d]) { out.push(shards[d]!); continue; }
    const v = new Uint8Array(size);
    for (let j = 0; j < k; j++) mulAdd(v, shards[have[j]!]!, inv[d]![j]!);
    out.push(v);
  }
  return out;
}
