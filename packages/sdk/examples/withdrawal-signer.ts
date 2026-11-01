// Ejemplo · exchange: firmar y enviar retiros desde la cartera caliente.
//   VELUM_RPC=… HOT_PHRASE_FILE=/ruta/segura bun examples/withdrawal-signer.ts retiros.json
// retiros.json = [{ "id": "w1", "to": "vel…", "amount": 1500000, "token": "VEL", "memo": "ref-123" }]
// Patrón caliente/frío: la caliente guarda solo lo de un día de retiros; la fría (sin conexión) la rellena.
import { readFileSync } from "node:fs";
import { VelumRpc, buildTransfer, isAddress, walletFromPhrase, CHAIN_ID } from "../src";

const rpc = new VelumRpc(process.env.VELUM_RPC ?? "ws://127.0.0.1:7420/ws?role=client");
const hot = walletFromPhrase(readFileSync(process.env.HOT_PHRASE_FILE!, "utf8").trim());
const list = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as { id: string; to: string; amount: number; token?: string; memo?: string }[];

const ctx = await rpc.fees();
let nonce = await rpc.nextNonce(hot.address);
for (const w of list) {
  if (!isAddress(w.to) || !(w.amount > 0)) { console.error(`${w.id}: datos no válidos, se salta`); continue; }
  const tx = buildTransfer({ secret: hot.secret, from: hot.address, to: w.to, amount: w.amount, token: w.token === "VEL" ? undefined : w.token, memo: w.memo, nonce, chain: CHAIN_ID, ctx });
  try {
    const { id } = await rpc.submit(tx);
    nonce++;
    console.log(`${w.id} → ${id}`); // guarda id: confirma cuando tenga 30 bloques encima
  } catch (e) {
    console.error(`${w.id}: ${(e as Error).message}`);
  }
}
rpc.close();
