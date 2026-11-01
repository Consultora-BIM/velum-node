// Ejemplo · staking delegado: delegar VEL a un nodo y ver las delegaciones.
//   VELUM_RPC=… PHRASE_FILE=… NODE=vel… AMOUNT_VEL=100 bun examples/staking.ts
// La delegación suma al peso del nodo en el sorteo. El nodo cobra su comisión (0–20 %) y el resto se reparte
// cada época a prorrata. Retirar tarda 14 días. No hay rendimiento garantizado.
import { readFileSync } from "node:fs";
import { VelumRpc, buildDelegate, walletFromPhrase, CHAIN_ID, UNIT } from "../src";

const rpc = new VelumRpc(process.env.VELUM_RPC ?? "ws://127.0.0.1:7420/ws?role=client");
const me = walletFromPhrase(readFileSync(process.env.PHRASE_FILE!, "utf8").trim());
const node = process.env.NODE!;
const amount = Math.round(Number(process.env.AMOUNT_VEL ?? "100") * UNIT);

const { powBits } = await rpc.fees();
const tx = buildDelegate(me.secret, CHAIN_ID, me.address, await rpc.nextNonce(me.address), node, amount, powBits);
console.log("enviada", (await rpc.submit(tx)).id);
console.log("mis delegaciones", await rpc.delegations({ address: me.address }));
rpc.close();
