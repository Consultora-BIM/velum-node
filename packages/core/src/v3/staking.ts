// ⚠ CÓDIGO CONGELADO DEL PROTOCOLO v3 (velum-mainnet-1, alturas < H de la v4). NO EDITAR.
// Solo sirve para reaplicar la historia anterior a la actualización v4 byte a byte (mismas raíces de estado).
// Importes en µVEL (number). La conversión a v4 (BigInt, 18 decimales) está en ../era.ts.
// Staking delegado (docs/ecosistema.md §6). Todo entero y en orden de clave: determinista.
//  · `stake.delegate {node, amount}`: VEL a `vel_escrow`; suma al peso del nodo en el sorteo (mismo tope que la fianza).
//  · `stake.undelegate {node, amount}`: vuelve a la cuenta al cerrar la época `actual + 14 días`.
//  · `node.commission {bp}`: 0–2.000 pb; un cambio cada 7 días como mucho y ±500 pb por cambio.
//  · Reparto: lo que descubre el nodo en una época se divide en comisión + resto; el resto va a prorrata entre la fianza
//    propia del nodo y sus delegados. El sobrante del redondeo va al nodo. Σ entregado = lo descubierto (exacto).
import {
  BP, COMMISSION_COOLDOWN_EPOCHS, COMMISSION_DEFAULT_BP, COMMISSION_MAX_BP, COMMISSION_MAX_STEP_BP, BOND_UNBOND_EPOCHS,
  ESCROW_ADDRESS, MAX_DELEGATORS_PER_NODE, MAX_UNBONDING, MIN_DELEGATION, VEL,
} from "./constants";
import type { NodeCommissionTx, StakeDelegateTx, StakeUndelegateTx } from "./tx";
import { type ChainState, type NodeInfo, balanceOf, credit, curEpoch, debit, mulDiv } from "./state";

export interface Delegation { amount: number; earned: number; since: number }
export interface StakeUnbonding { node: string; amount: number; release: number }
export interface StakeState {
  /** del[nodo][delegado] */
  del: Record<string, Record<string, Delegation>>;
  /** Retiradas en espera por dirección. */
  unbonding: Record<string, StakeUnbonding[]>;
}

const sorted = (o: Record<string, unknown>) => Object.keys(o).sort();
const stake = (s: ChainState): StakeState => ((s as any).stake ??= { del: {}, unbonding: {} });
export const stakeOf = (s: ChainState): StakeState | undefined => (s as any).stake;

export const commissionOf = (n: Pick<NodeInfo, "commissionBp">) => n.commissionBp ?? COMMISSION_DEFAULT_BP;
export const delegatedTo = (n: Pick<NodeInfo, "delegated">) => n.delegated ?? 0;

export function applyDelegate(s: ChainState, tx: StakeDelegateTx): string | null {
  const n = s.nodes[tx.node];
  if (!n) return "Nodo desconocido";
  if (tx.amount < MIN_DELEGATION) return "Delegación mínima: 1 VEL";
  if (balanceOf(s, tx.from, VEL) < tx.amount) return "Saldo insuficiente";
  const cur = stakeOf(s)?.del[tx.node];
  if (cur && !cur[tx.from] && Object.keys(cur).length >= MAX_DELEGATORS_PER_NODE) return "Ese nodo ya tiene el máximo de delegados";
  // Comprobado todo: a partir de aquí se escribe.
  const byNode = (stake(s).del[tx.node] ??= {});
  debit(s, tx.from, VEL, tx.amount);
  credit(s, ESCROW_ADDRESS, VEL, tx.amount);
  const d = (byNode[tx.from] ??= { amount: 0, earned: 0, since: s.height });
  d.amount += tx.amount;
  n.delegated = delegatedTo(n) + tx.amount;
  return null;
}

export function applyUndelegate(s: ChainState, tx: StakeUndelegateTx): string | null {
  const st = stakeOf(s);
  const d = st?.del[tx.node]?.[tx.from];
  if (!st || !d) return "No tienes delegación en ese nodo";
  if (d.amount < tx.amount) return "Delegación insuficiente";
  if ((st.unbonding[tx.from]?.length ?? 0) >= MAX_UNBONDING) return "Demasiadas retiradas en espera";
  const list = (st.unbonding[tx.from] ??= []);
  d.amount -= tx.amount;
  if (d.amount === 0) {
    delete st.del[tx.node]![tx.from];
    if (!Object.keys(st.del[tx.node]!).length) delete st.del[tx.node];
  }
  const n = s.nodes[tx.node]!;
  n.delegated = delegatedTo(n) - tx.amount;
  if (n.delegated === 0) delete n.delegated;
  list.push({ node: tx.node, amount: tx.amount, release: curEpoch(s) + BOND_UNBOND_EPOCHS });
  return null;
}

export function applyCommission(s: ChainState, tx: NodeCommissionTx): string | null {
  const n = s.nodes[tx.from];
  if (!n) return "Solo un nodo dado de alta fija comisión";
  if (tx.bp > COMMISSION_MAX_BP) return "Comisión máxima: 20 %";
  const cur = curEpoch(s);
  if (n.commissionEpoch !== undefined && cur - n.commissionEpoch < COMMISSION_COOLDOWN_EPOCHS) return "Solo un cambio de comisión cada 7 días";
  if (Math.abs(tx.bp - commissionOf(n)) > COMMISSION_MAX_STEP_BP) return "Cada cambio de comisión, como mucho ±5 puntos";
  n.commissionBp = tx.bp;
  n.commissionEpoch = cur;
  return null;
}

/**
 * Entrega `amount` µVEL descubiertos por el nodo `n`: comisión + resto a prorrata (fianza propia y delegados).
 * Devuelve lo que fue a los delegados. Σ créditos = amount exacto.
 */
export function payNode(s: ChainState, n: NodeInfo, amount: number): number {
  const delegated = delegatedTo(n);
  const dels = stakeOf(s)?.del[n.address];
  if (amount <= 0 || delegated <= 0 || !dels) { credit(s, n.payout, VEL, amount); return 0; }
  const rest = amount - mulDiv(amount, commissionOf(n), BP);
  const forDels = mulDiv(rest, delegated, n.bond + delegated);
  let paid = 0;
  for (const a of sorted(dels)) {
    const d = dels[a]!;
    const x = mulDiv(forDels, d.amount, delegated);
    if (x <= 0) continue;
    credit(s, a, VEL, x);
    d.earned += x;
    paid += x;
  }
  credit(s, n.payout, VEL, amount - paid);
  return paid;
}

/** Al cerrar la época `X`: devuelve las retiradas cumplidas. */
export function releaseUndelegations(s: ChainState, X: number) {
  const st = stakeOf(s);
  if (!st) return;
  for (const a of sorted(st.unbonding)) {
    const list = st.unbonding[a]!;
    const due = list.filter((u) => u.release <= X).reduce((t, u) => t + u.amount, 0);
    if (!due) continue;
    const left = list.filter((u) => u.release > X);
    if (left.length) st.unbonding[a] = left; else delete st.unbonding[a];
    debit(s, ESCROW_ADDRESS, VEL, due);
    credit(s, a, VEL, due);
  }
}

/** Lecturas para RPC y explorador. */
export function delegationsOfNode(s: ChainState, node: string) {
  const dels = stakeOf(s)?.del[node] ?? {};
  return sorted(dels).map((a) => ({ address: a, node, ...dels[a]! }));
}
export function delegationsOfAddress(s: ChainState, address: string) {
  const st = stakeOf(s);
  const out: { address: string; node: string; amount: number; earned: number; since: number }[] = [];
  if (!st) return { delegations: out, unbonding: [] as StakeUnbonding[] };
  for (const node of sorted(st.del)) { const d = st.del[node]![address]; if (d) out.push({ address, node, ...d }); }
  return { delegations: out, unbonding: st.unbonding[address] ?? [] };
}
