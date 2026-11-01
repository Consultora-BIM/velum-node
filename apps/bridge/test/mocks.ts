// Cadenas simuladas para los tests: sin red, sin fondos reales.
import { bytesToHex } from "@noble/hashes/utils.js";
import { verify, canonical } from "@velum/core";
import { TRANSFER_TOPIC, type Fetch } from "../src/chains";
import { addr20Of, type ChainId } from "../src/hd";
import { VUSDT, velTxId, type VelumBlockLite, type VelumPort } from "../src/velum";

const hex = (n: number | bigint) => "0x" + BigInt(n).toString(16);
const pad = (h: string) => "0x" + h.replace(/^0x/, "").padStart(64, "0");

/** Cadena EVM/TRON mínima: bloques, registros de USDT, saldos y emisión de transacciones. */
export class MockChain {
  height = 1_000;
  logs: { block: number; to20: string; amount: bigint; txHash: string; logIndex: number }[] = [];
  balances = new Map<string, bigint>(); // to20 → USDT
  broadcasts: string[] = [];
  receipts = new Map<string, { ok: boolean; block: number }>();
  calls: string[] = [];

  constructor(readonly chain: ChainId, readonly token: string) {}

  deposit(to: string, amount: bigint) {
    const to20 = bytesToHex(addr20Of(this.chain, to));
    const txHash = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
    this.logs.push({ block: this.height, to20, amount, txHash, logIndex: 0 });
    this.balances.set(to20, (this.balances.get(to20) ?? 0n) + amount);
    return txHash;
  }

  setBalance(addr: string, amount: bigint) { this.balances.set(bytesToHex(addr20Of(this.chain, addr)), amount); }

  mine(n = 1) { this.height += n; }

  fetch: Fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (url.endsWith("/wallet/broadcasthex")) {
      this.broadcasts.push(body.transaction);
      const txid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
      this.receipts.set(txid, { ok: true, block: this.height + 1 });
      return Response.json({ result: true, txid });
    }
    const { method, params, id } = body;
    this.calls.push(method);
    const ok = (result: unknown) => Response.json({ jsonrpc: "2.0", id, result });
    const token20 = "0x" + bytesToHex(addr20Of(this.chain, this.token));
    switch (method) {
      case "eth_blockNumber": return ok(hex(this.height));
      case "eth_getLogs": {
        const f = params[0];
        if (String(f.address).toLowerCase() !== token20.toLowerCase() || f.topics[0] !== TRANSFER_TOPIC) return ok([]);
        const from = Number(BigInt(f.fromBlock)), to = Number(BigInt(f.toBlock));
        const wanted = new Set((f.topics[2] as string[]).map((t) => t.slice(-40).toLowerCase()));
        return ok(this.logs.filter((l) => l.block >= from && l.block <= to && wanted.has(l.to20)).map((l) => ({
          address: token20, topics: [TRANSFER_TOPIC, pad("00"), pad(l.to20)], data: pad(l.amount.toString(16)),
          blockNumber: hex(l.block), transactionHash: "0x" + l.txHash, logIndex: hex(l.logIndex), removed: false,
        })));
      }
      case "eth_call": {
        const holder = String(params[0].data).slice(-40).toLowerCase();
        return ok(pad((this.balances.get(holder) ?? 0n).toString(16)));
      }
      case "eth_getTransactionCount": return ok(hex(7));
      case "eth_gasPrice": return ok(hex(30_000_000_000n));
      case "eth_getBlockByNumber": return ok({ number: hex(this.height), hash: "0x" + "00".repeat(6) + "03e8" + "ab".repeat(24), timestamp: hex(1_800_000_000) });
      case "eth_getTransactionReceipt": {
        const r = this.receipts.get(String(params[0]).replace(/^0x/, ""));
        return ok(r ? { blockNumber: hex(r.block), status: r.ok ? "0x1" : "0x0" } : null);
      }
      case "eth_sendRawTransaction": {
        this.broadcasts.push(params[0]);
        const txid = bytesToHex(crypto.getRandomValues(new Uint8Array(32)));
        this.receipts.set(txid, { ok: true, block: this.height + 1 });
        return ok("0x" + txid);
      }
    }
    return Response.json({ jsonrpc: "2.0", id, error: { message: "método no simulado: " + method } });
  };
}

/** Cadena Velum simulada: aplica bridge.mint (solo la autoridad, ref única) y bridge.redeem. */
export class MockVelum implements VelumPort {
  blocksList: VelumBlockLite[] = [{ height: 0, hash: "g", txs: [] }];
  mempool: any[] = [];
  balances = new Map<string, number>();
  nonces = new Map<string, number>();
  refs = new Set<string>();
  supply = 0;
  rejected: string[] = [];

  constructor(readonly authority: string, readonly id = "velum-mainnet-1") {}

  async chainId() { return this.id; }
  async head() { return this.blocksList.length - 1; }
  async blocks(from: number, to: number) { return this.blocksList.filter((b) => b.height >= from && b.height <= to); }
  async nonce(a: string) { return { nonce: this.nonces.get(a) ?? 0, pending: this.mempool.filter((t) => t.from === a).length }; }
  async tokenSupply(s: string) { return s === VUSDT ? this.supply : 0; }

  async submit(tx: any): Promise<string> {
    const { sig, ...rest } = tx;
    if (!verify(tx.from, canonical(rest), sig)) throw new Error("Firma no válida");
    if (tx.type === "bridge.mint") {
      if (tx.from !== this.authority) throw new Error("Solo el puente acuña");
      if (this.refs.has(tx.ref) || this.mempool.some((t) => t.ref === tx.ref)) { this.rejected.push(tx.ref); throw new Error("Depósito ya acuñado"); }
    }
    const expected = (this.nonces.get(tx.from) ?? 0) + this.mempool.filter((t) => t.from === tx.from).length;
    if (tx.nonce !== expected) throw new Error(`Nonce ${tx.nonce} ≠ ${expected}`);
    this.mempool.push(tx);
    return velTxId(tx);
  }

  /** Mete el mempool en un bloque y aplica; añade `extra` bloques vacíos. */
  mine(extra = 0) {
    const txs = this.mempool.splice(0);
    for (const tx of txs) {
      this.nonces.set(tx.from, (this.nonces.get(tx.from) ?? 0) + 1);
      if (tx.type === "bridge.mint") { this.refs.add(tx.ref); this.balances.set(tx.to, (this.balances.get(tx.to) ?? 0) + tx.amount); this.supply += tx.amount; }
      if (tx.type === "bridge.redeem") { this.balances.set(tx.from, (this.balances.get(tx.from) ?? 0) - tx.amount); this.supply -= tx.amount; }
    }
    this.blocksList.push({ height: this.blocksList.length, hash: "b" + this.blocksList.length, txs });
    for (let i = 0; i < extra; i++) this.blocksList.push({ height: this.blocksList.length, hash: "b" + this.blocksList.length, txs: [] });
  }
}
