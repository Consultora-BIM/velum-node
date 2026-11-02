// Reaplica la mainnet real con ESTE núcleo y comprueba cada raíz de estado. Sirve para validar un binario nuevo
// (p. ej. la v4) contra la historia viva antes de publicarlo.
//   VELUM_NETWORK=mainnet bun packages/core/scripts/replay-mainnet.ts [wss://…/hub]
import * as V from "../src";

const url = (process.argv[2] ?? V.GATEWAYS[2]) + "?role=client";
const ws = new WebSocket(url);
let seq = 0;
const waiting = new Map<string, (f: any) => void>();
ws.onmessage = (e) => { const f = JSON.parse(String(e.data)); if (f.t === "rpc_res") { waiting.get(f.id)?.(f); waiting.delete(f.id); } };
await new Promise<void>((ok, ko) => { ws.onopen = () => ok(); ws.onerror = () => ko(new Error(`No conecta con ${url}`)); });
const call = (method: string, params: object) => new Promise<any>((ok, ko) => {
  const id = `r${++seq}`;
  waiting.set(id, (f) => (f.error ? ko(new Error(f.error)) : ok(f.result)));
  ws.send(JSON.stringify({ t: "rpc", id, method, params }));
  setTimeout(() => ko(new Error(`${method}: sin respuesta`)), 30_000);
});

const head = await call("chain.head", {});
console.log(`Cabeza ${head.height} (${head.hash.slice(0, 12)}…). Tabla: ${V.upgrades().map((u) => `v${u.version}@${u.height}`).join(", ")}`);
let s = V.genesisState();
let from = 1;
while (from <= head.height) {
  const bs: V.Block[] = await call("chain.blocks", { from, to: Math.min(head.height, from + 199) });
  if (!bs.length) break;
  for (const b of bs) {
    const r = V.applyBlock(s, b);
    if ("error" in r) throw new Error(`Altura ${b.header.height}: ${r.error}`);
    s = r.state;
    if (V.stateRoot(s) !== b.header.stateRoot) throw new Error(`Altura ${b.header.height}: raíz distinta`);
    if (V.velLedgerGap(s) !== 0n) throw new Error(`Altura ${b.header.height}: no cuadra la contabilidad`);
  }
  from = bs[bs.length - 1]!.header.height + 1;
}
console.log(`OK: ${s.height} bloques reaplicados, raíces iguales, conservación exacta. Acuñado ${V.formatAmount("VEL", s.supply.minted)}.`);
ws.close();
process.exit(0);
