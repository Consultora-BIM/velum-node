// Lógica del puente USDT ⇄ vUSDT.
//
//  Depósito: cartera Velum pide dirección (bridge.address) → índice nuevo bajo la xpub → el usuario manda USDT →
//            tras N confirmaciones el puente firma `bridge.mint` (ref única por depósito: la cadena no acuña dos veces).
//  Retiro:   el usuario firma `bridge.redeem` en Velum (canjea vUSDT: sale de la circulación) → el puente lo encola → se exporta un archivo →
//            se firma SIN CONEXIÓN con la cartera fría → se emite → se confirma.
//  Reservas: USDT en direcciones del puente (depósitos + tesorería) frente a vUSDT en circulación + retiros pendientes.
//
// Con `enabled = false` no da direcciones ni acuña: «puente aún no abierto».
import { isAddress, type KeyPair } from "@velum/core";
import { bytesToHex } from "@noble/hashes/utils.js";
import type { BridgeConfig } from "./config";
import type { ChainClient } from "./chains";
import {
  CHAINS, addr20Of, depositAddress, familyOf, isChainAddress, treasuryAddress, type ChainId, type Family,
} from "./hd";
import { tronRef, type PayoutQueue, type QueueEntry, type SignedFile } from "./offline";
import type { Store, WithdrawalRec } from "./store";
import { VUSDT, makeMint, velTxId, type BridgeRedeemTx, type BridgeMintTx, type VelumPort } from "./velum";

export const CLOSED_MSG = "puente aún no abierto";

export class BridgeError extends Error {
  constructor(msg: string, readonly code = "error") { super(msg); }
}

export interface ColdPublic {
  velum: { address: string };
  tron: { xpub: string };
  evm: { xpub: string };
  fingerprint: string;
}

/** Pasa unidades de la cadena (dec decimales) a unidades de vUSDT (6). */
export function toVusdt(amount: bigint, dec: number): bigint {
  return dec <= 6 ? amount * 10n ** BigInt(6 - dec) : amount / 10n ** BigInt(dec - 6);
}
export function fromVusdt(amount: bigint, dec: number): bigint {
  return dec <= 6 ? amount / 10n ** BigInt(6 - dec) : amount * 10n ** BigInt(dec - 6);
}

const RESUBMIT_MS = 10 * 60_000;
const BLOCK_BATCH = 100;

export class Bridge {
  private log: (m: string) => void;

  constructor(
    readonly cfg: BridgeConfig,
    readonly cold: ColdPublic,
    private key: KeyPair,
    private velum: VelumPort,
    private chains: Partial<Record<ChainId, ChainClient>>,
    readonly store: Store,
    private now: () => number = Date.now,
    log?: (m: string) => void,
  ) {
    this.log = log ?? ((m) => console.log(`[puente] ${m}`));
  }

  get enabled() { return this.cfg.enabled; }
  get bridgeAddress() { return this.key.address; }

  private xpub(f: Family) { return f === "tron" ? this.cold.tron.xpub : this.cold.evm.xpub; }
  private chainOn(c: unknown): c is ChainId {
    return typeof c === "string" && (CHAINS as readonly string[]).includes(c) && !!this.cfg.chains[c as ChainId]?.enabled && !!this.chains[c as ChainId];
  }

  // =====================================================================
  // bridge.address
  // =====================================================================
  address(params: { chain?: unknown; velAddress?: unknown }) {
    if (!this.enabled) throw new BridgeError(CLOSED_MSG, "closed");
    const { chain, velAddress } = params;
    if (!this.chainOn(chain)) throw new BridgeError("Cadena no disponible");
    if (typeof velAddress !== "string" || !isAddress(velAddress)) throw new BridgeError("Dirección Velum no válida");
    const fam = familyOf(chain);
    const d = this.store.data;
    let index = d.indexOf[velAddress]?.[fam];
    if (index === undefined) {
      const hourAgo = this.now() - 3_600_000;
      d.newAddrTimes = d.newAddrTimes.filter((t) => t > hourAgo);
      if (d.newAddrTimes.length >= this.cfg.limits.newAddressesPerHour) throw new BridgeError("Demasiadas direcciones nuevas; prueba en un rato", "rate");
      index = d.nextIndex[fam]++;
      (d.indexOf[velAddress] ??= {})[fam] = index;
      d.ownerOf[fam][String(index)] = velAddress;
      d.newAddrTimes.push(this.now());
      this.store.save();
    }
    const c = this.cfg.chains[chain];
    return {
      chain, velAddress, address: depositAddress(fam, this.xpub(fam), index), index,
      token: "USDT", contract: c.usdt, confirmations: c.confirmations, mints: VUSDT,
    };
  }

  // =====================================================================
  // Depósitos → bridge.mint
  // =====================================================================
  async pollDeposits(chain: ChainId): Promise<number> {
    if (!this.enabled || !this.chainOn(chain)) return 0;
    const cli = this.chains[chain]!;
    const c = this.cfg.chains[chain];
    const d = this.store.data;
    const fam = familyOf(chain);
    const head = await cli.head();
    const safe = head - c.confirmations;
    if (safe < 0) return 0;
    if (d.cursor[chain] === undefined) { d.cursor[chain] = safe; this.store.save(); return 0; }
    const owners = d.ownerOf[fam];
    const idxs = Object.keys(owners);
    if (!idxs.length) { d.cursor[chain] = safe; this.store.save(); return 0; }
    const byTo20 = new Map<string, number>();
    for (const i of idxs) byTo20.set(bytesToHex(addr20Of(chain, depositAddress(fam, this.xpub(fam), Number(i)))), Number(i));
    let found = 0;
    for (let from = d.cursor[chain]! + 1; from <= safe; from += c.logRange) {
      const to = Math.min(safe, from + c.logRange - 1);
      for (const dep of await cli.transfersTo([...byTo20.keys()], from, to)) {
        const id = `${chain}:${dep.txHash}:${dep.logIndex}`;
        if (d.deposits[id]) continue;
        const index = byTo20.get(dep.to20);
        if (index === undefined || dep.amount <= 0n) continue;
        const amount = toVusdt(dep.amount, c.decimals);
        if (amount <= 0n) continue;
        d.deposits[id] = {
          id, chain, txHash: dep.txHash, logIndex: dep.logIndex, block: dep.block,
          address: depositAddress(fam, this.xpub(fam), index), velAddress: owners[String(index)]!,
          amount: amount.toString(), status: "seen", seenAt: this.now(),
        };
        found++;
        this.log(`depósito ${id}: ${amount} µUSDT para ${owners[String(index)]}`);
      }
      d.cursor[chain] = to;
      this.store.save();
    }
    return found;
  }

  /** Contador de nonce: `peek()` da el siguiente; `use()` lo gasta solo si la tx entró en el mempool. */
  private async nextNonce() {
    const n = await this.velum.nonce(this.key.address);
    let next = n.nonce + n.pending;
    return { peek: () => next, use: () => { next++; } };
  }

  /** Acuña los depósitos confirmados (y reintenta los que no entraron). Respeta el tope diario. */
  async mintPending(): Promise<number> {
    if (!this.enabled) return 0;
    const d = this.store.data;
    const now = this.now();
    const todo = Object.values(d.deposits)
      .filter((x) => x.status === "seen" || x.status === "waiting_cap" || (x.status === "submitted" && now - (x.submittedAt ?? 0) > RESUBMIT_MS))
      .sort((a, b) => a.seenAt - b.seenAt);
    if (!todo.length) return 0;
    const chainId = await this.velum.chainId();
    const nonce = await this.nextNonce();
    let sent = 0;
    for (const dep of todo) {
      const day = this.store.day(now);
      const fresh = dep.status !== "submitted";
      if (fresh && BigInt(day.minted) + BigInt(dep.amount) > BigInt(this.cfg.limits.dailyMintCap)) {
        if (dep.status !== "waiting_cap") { dep.status = "waiting_cap"; this.log(`depósito ${dep.id} espera: tope diario de acuñación`); }
        continue;
      }
      const tx = makeMint(this.key, chainId, nonce.peek(), dep.velAddress, Number(dep.amount), dep.chain, dep.id, now);
      try {
        dep.mintTx = await this.velum.submit(tx);
        nonce.use();
      } catch (e) {
        this.log(`no entró la acuñación de ${dep.id}: ${(e as Error).message}`);
        continue;
      }
      if (fresh) day.minted = (BigInt(day.minted) + BigInt(dep.amount)).toString();
      dep.status = "submitted";
      dep.submittedAt = now;
      sent++;
    }
    this.store.save();
    return sent;
  }

  // =====================================================================
  // Cadena Velum: confirmar acuñaciones y recoger canjes
  // =====================================================================
  async pollVelum(): Promise<{ minted: number; redeems: number }> {
    const d = this.store.data;
    const head = await this.velum.head();
    const safe = head - this.cfg.velumConfirmations;
    let minted = 0, redeems = 0;
    for (let from = d.velumCursor + 1; from <= safe; from += BLOCK_BATCH) {
      const to = Math.min(safe, from + BLOCK_BATCH - 1);
      for (const b of await this.velum.blocks(from, to)) {
        for (const tx of b.txs) {
          if (tx?.type === "bridge.mint" && tx.from === this.key.address) {
            const m = tx as BridgeMintTx;
            if (m.ref.startsWith("refund:")) {
              const w = d.withdrawals[m.ref.slice(7)];
              if (w) { w.status = "refunded"; w.updatedAt = this.now(); }
            } else {
              const dep = d.deposits[m.ref];
              if (dep && dep.status !== "minted") { dep.status = "minted"; dep.mintTx = velTxId(m); dep.mintedHeight = b.height; minted++; }
            }
          } else if (tx?.type === "bridge.redeem") {
            if (this.onRedeem(tx as BridgeRedeemTx, b.height)) redeems++;
          }
        }
      }
      d.velumCursor = to;
      this.store.save();
    }
    return { minted, redeems };
  }

  private onRedeem(tx: BridgeRedeemTx, height: number): boolean {
    const d = this.store.data;
    const id = velTxId(tx);
    if (d.withdrawals[id]) return false;
    const L = this.cfg.limits;
    const rec: WithdrawalRec = {
      id, height, velAddress: tx.from, dst: tx.dst, to: tx.to, amount: String(tx.amount), payout: "0",
      status: "queued", updatedAt: this.now(),
    };
    // Lo que no se puede pagar se devuelve en vUSDT (nunca se pierde).
    const refund = (why: string) => { rec.status = "refund"; rec.reason = why; };
    if (!this.chainOn(tx.dst)) refund("cadena de destino no disponible");
    else if (!isChainAddress(tx.dst, tx.to)) refund("dirección de destino no válida");
    else if (tx.amount < L.minWithdrawal) refund("por debajo del mínimo de retiro");
    else if (tx.amount > L.maxWithdrawal) refund("por encima del máximo por retiro");
    else {
      const fee = BigInt(L.withdrawalFee[tx.dst] ?? 0);
      const payout = fromVusdt(BigInt(tx.amount) - fee, this.cfg.chains[tx.dst].decimals);
      if (payout <= 0n) refund("el importe no cubre la comisión de retiro");
      else rec.payout = payout.toString();
    }
    d.withdrawals[id] = rec;
    this.log(`retiro ${id}: ${tx.amount} µvUSDT → ${tx.dst}:${tx.to} (${rec.status}${rec.reason ? ": " + rec.reason : ""})`);
    return true;
  }

  /** Devuelve en vUSDT lo canjeado que no se puede pagar (ref `refund:<id>`: la cadena no lo duplica). */
  async processRefunds(): Promise<number> {
    const now = this.now();
    const todo = Object.values(this.store.data.withdrawals).filter((w) => w.status === "refund" && now - (w.refundAt ?? 0) > RESUBMIT_MS);
    if (!todo.length) return 0;
    const chainId = await this.velum.chainId();
    const nonce = await this.nextNonce();
    let n = 0;
    for (const w of todo) {
      try {
        await this.velum.submit(makeMint(this.key, chainId, nonce.peek(), w.velAddress, Number(w.amount), w.dst, `refund:${w.id}`, now));
        nonce.use();
        w.refundAt = now;
        n++;
      } catch (e) { this.log(`devolución ${w.id}: ${(e as Error).message}`); }
    }
    this.store.save();
    return n;
  }

  // =====================================================================
  // Exportar la cola para la firma sin conexión
  // =====================================================================
  private async prepare(chain: ChainId, base: Omit<QueueEntry, "evm" | "tron">, nonceOf: Map<string, number>): Promise<QueueEntry> {
    const cli = this.chains[chain]!;
    const c = this.cfg.chains[chain];
    if (chain === "tron") {
      const b = await cli.latestBlock();
      const ts = this.now();
      return { ...base, tron: { ...tronRef(b.number, b.hash), timestamp: ts, expiration: ts + 20 * 3_600_000, feeLimit: c.feeLimit ?? 30_000_000 } };
    }
    let nonce = nonceOf.get(base.fromAddress);
    if (nonce === undefined) nonce = await cli.nonce(base.fromAddress);
    nonceOf.set(base.fromAddress, nonce + 1);
    const gp = await cli.gasPrice();
    const tip = gp / 10n > 0n ? gp / 10n : 1n;
    return {
      ...base,
      evm: { chainId: c.chainId!, nonce, maxFeePerGas: (gp * 2n + tip).toString(), maxPriorityFeePerGas: tip.toString(), gasLimit: base.asset === "usdt" ? (c.gasLimit ?? 100_000) : 21_000 },
    };
  }

  private queueHeader(): Omit<PayoutQueue, "entries"> {
    return { v: 1, created: new Date(this.now()).toISOString(), coldFingerprint: this.cold.fingerprint, xpubs: { tron: this.cold.tron.xpub, evm: this.cold.evm.xpub } };
  }

  /** Elige los retiros de hoy (topes diarios y por cartera) y prepara la cola. Los que no caben quedan «held». */
  async exportWithdrawals(): Promise<PayoutQueue> {
    const d = this.store.data;
    const L = this.cfg.limits;
    const today = new Date(this.now()).toISOString().slice(0, 10);
    const day = this.store.day(this.now());
    const nonceOf = new Map<string, number>();
    const entries: QueueEntry[] = [];
    const list = Object.values(d.withdrawals).filter((w) => w.status === "queued" || w.status === "held").sort((a, b) => a.height - b.height);
    for (const w of list) {
      if (BigInt(day.queued) + BigInt(w.amount) > BigInt(L.dailyWithdrawalCap)) { w.status = "held"; w.reason = "tope diario"; continue; }
      if ((day.byAddr[w.velAddress] ?? 0) >= L.withdrawalsPerAddressPerDay) { w.status = "held"; w.reason = "límite diario por cartera"; continue; }
      const fam = familyOf(w.dst);
      const base = {
        id: w.id, kind: "payout" as const, chain: w.dst, from: { branch: 1, index: 0 }, fromAddress: treasuryAddress(fam, this.xpub(fam)),
        to: w.to, amount: w.payout, asset: "usdt" as const, token: this.cfg.chains[w.dst].usdt,
      };
      entries.push(await this.prepare(w.dst, base, nonceOf));
      day.queued = (BigInt(day.queued) + BigInt(w.amount)).toString();
      day.byAddr[w.velAddress] = (day.byAddr[w.velAddress] ?? 0) + 1;
      w.status = "exported"; w.day = today; w.reason = undefined; w.updatedAt = this.now();
    }
    this.store.save();
    return { ...this.queueHeader(), entries };
  }

  /**
   * Barrido: gas (nativo) de la tesorería a cada dirección de depósito con saldo ≥ `min`, y su USDT a la tesorería.
   * El emisor manda primero el gas, espera a que entre y después los barridos.
   */
  async planSweep(chain: ChainId, min: bigint): Promise<PayoutQueue> {
    if (!this.chainOn(chain)) throw new BridgeError("Cadena no disponible");
    const cli = this.chains[chain]!;
    const c = this.cfg.chains[chain];
    const fam = familyOf(chain);
    const treasury = treasuryAddress(fam, this.xpub(fam));
    const nonceOf = new Map<string, number>();
    const gas: QueueEntry[] = [], sweeps: QueueEntry[] = [];
    for (const i of Object.keys(this.store.data.ownerOf[fam]).map(Number).sort((a, b) => a - b)) {
      const addr = depositAddress(fam, this.xpub(fam), i);
      const bal = await cli.usdtBalance(addr);
      if (bal < min || bal === 0n) continue;
      const sweep = await this.prepare(chain, { id: `sweep:${chain}:${i}`, kind: "sweep", chain, from: { branch: 0, index: i }, fromAddress: addr, to: treasury, amount: bal.toString(), asset: "usdt", token: c.usdt }, nonceOf);
      const fuel = chain === "tron" ? BigInt(c.feeLimit ?? 30_000_000) : BigInt(sweep.evm!.gasLimit) * BigInt(sweep.evm!.maxFeePerGas);
      gas.push(await this.prepare(chain, { id: `gas:${chain}:${i}`, kind: "gas", chain, from: { branch: 1, index: 0 }, fromAddress: treasury, to: addr, amount: fuel.toString(), asset: "native" }, nonceOf));
      sweeps.push(sweep);
    }
    return { ...this.queueHeader(), entries: [...gas, ...sweeps] };
  }

  /** Tras emitir: apunta el hash de cada retiro. */
  markSent(signed: SignedFile, sent: Record<string, string>) {
    for (const e of signed.entries) {
      if (e.kind !== "payout" || !sent[e.id]) continue;
      const w = this.store.data.withdrawals[e.id];
      if (w && w.status === "exported") { w.status = "sent"; w.txid = sent[e.id]; w.updatedAt = this.now(); }
    }
    this.store.save();
  }

  /** Mira si los pagos emitidos ya están en un bloque. Si uno falló en cadena, vuelve a la cola. */
  async confirmPayouts(): Promise<number> {
    let n = 0;
    for (const w of Object.values(this.store.data.withdrawals)) {
      if (w.status !== "sent" || !w.txid || !this.chains[w.dst]) continue;
      const r = await this.chains[w.dst]!.receipt(w.txid);
      if (!r) continue;
      if (r.ok) { w.status = "paid"; n++; } else { w.status = "queued"; w.reason = "falló en cadena; se reintenta"; w.txid = undefined; }
      w.updatedAt = this.now();
    }
    this.store.save();
    return n;
  }

  // =====================================================================
  // Prueba de reservas y estado
  // =====================================================================
  async reserves() {
    const d = this.store.data;
    const supply = BigInt(await this.velum.tokenSupply(VUSDT));
    const chains: Record<string, { addresses: number; held: string; treasury: string; deposits: string }> = {};
    let held = 0n;
    for (const chain of CHAINS) {
      if (!this.chainOn(chain)) continue;
      const cli = this.chains[chain]!;
      const fam = familyOf(chain);
      const dec = this.cfg.chains[chain].decimals;
      const treasury = toVusdt(await cli.usdtBalance(treasuryAddress(fam, this.xpub(fam))), dec);
      let deps = 0n;
      const idx = Object.keys(d.ownerOf[fam]);
      for (const i of idx) deps += toVusdt(await cli.usdtBalance(depositAddress(fam, this.xpub(fam), Number(i))), dec);
      chains[chain] = { addresses: idx.length + 1, held: (treasury + deps).toString(), treasury: treasury.toString(), deposits: deps.toString() };
      held += treasury + deps;
    }
    // Ya canjeado en Velum pero aún sin pagar (o por devolver): sigue siendo deuda del puente.
    let pending = 0n;
    for (const w of Object.values(d.withdrawals))
      if (["queued", "held", "exported", "sent", "refund"].includes(w.status)) pending += BigInt(w.amount);
    // Depositado y confirmado pero aún sin acuñar: está en reservas y aún no en el suministro.
    let unminted = 0n;
    for (const x of Object.values(d.deposits)) if (x.status !== "minted") unminted += BigInt(x.amount);
    const liabilities = supply + pending + unminted;
    return {
      ts: this.now(), token: VUSDT, decimals: 6, enabled: this.enabled,
      supply: supply.toString(), pendingWithdrawals: pending.toString(), unmintedDeposits: unminted.toString(),
      liabilities: liabilities.toString(), reserves: held.toString(), chains,
      ratioBp: liabilities === 0n ? null : Number((held * 10_000n) / liabilities),
      ok: held >= liabilities,
      coldFingerprint: this.cold.fingerprint,
    };
  }

  status() {
    const d = this.store.data;
    const count = (xs: { status: string }[]) => xs.reduce<Record<string, number>>((m, x) => ((m[x.status] = (m[x.status] ?? 0) + 1), m), {});
    return {
      enabled: this.enabled, message: this.enabled ? "puente abierto" : CLOSED_MSG,
      token: VUSDT, authority: this.key.address,
      chains: CHAINS.filter((c) => this.chainOn(c)).map((c) => ({
        chain: c, confirmations: this.cfg.chains[c].confirmations, contract: this.cfg.chains[c].usdt, cursor: d.cursor[c] ?? null,
        withdrawalFee: this.cfg.limits.withdrawalFee[c] ?? 0,
      })),
      limits: {
        minWithdrawal: this.cfg.limits.minWithdrawal, maxWithdrawal: this.cfg.limits.maxWithdrawal,
        dailyWithdrawalCap: this.cfg.limits.dailyWithdrawalCap, dailyMintCap: this.cfg.limits.dailyMintCap,
      },
      deposits: count(Object.values(d.deposits)), withdrawals: count(Object.values(d.withdrawals)),
      velumCursor: d.velumCursor,
    };
  }

  /** Estado de un retiro o depósito concreto (por id) o los de una cartera. */
  lookup(params: { id?: unknown; velAddress?: unknown }) {
    const d = this.store.data;
    if (typeof params.id === "string") return d.withdrawals[params.id] ?? d.deposits[params.id] ?? null;
    if (typeof params.velAddress === "string") {
      const a = params.velAddress;
      return {
        deposits: Object.values(d.deposits).filter((x) => x.velAddress === a).slice(-50),
        withdrawals: Object.values(d.withdrawals).filter((x) => x.velAddress === a).slice(-50),
      };
    }
    throw new BridgeError("Falta id o velAddress");
  }

  /** Una vuelta del bucle principal. */
  async tick() {
    for (const c of CHAINS) {
      try { await this.pollDeposits(c); } catch (e) { this.log(`${c}: ${(e as Error).message}`); }
    }
    try { await this.mintPending(); } catch (e) { this.log(`acuñar: ${(e as Error).message}`); }
    try { await this.pollVelum(); } catch (e) { this.log(`velum: ${(e as Error).message}`); }
    try { await this.processRefunds(); } catch (e) { this.log(`devoluciones: ${(e as Error).message}`); }
    try { await this.confirmPayouts(); } catch (e) { this.log(`pagos: ${(e as Error).message}`); }
  }
}
