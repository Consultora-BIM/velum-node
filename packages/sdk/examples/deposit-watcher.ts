// Ejemplo · exchange: acreditar depósitos de VEL y vUSDT por memo.
//   VELUM_RPC=ws://127.0.0.1:7420/ws?role=client HOT=vel… bun examples/deposit-watcher.ts
// Patrón: una dirección caliente; cada cliente pone su id en `memo`. Sin memo → a revisión manual, nunca se pierde.
import { DepositWatcher, VelumRpc, formatAmount } from "../src";

const rpc = new VelumRpc(process.env.VELUM_RPC ?? "ws://127.0.0.1:7420/ws?role=client");
const hot = process.env.HOT!;
if (!hot) throw new Error("Falta HOT (dirección caliente del exchange)");
let cursor = Number(process.env.FROM ?? 0); // en producción: léelo de tu base de datos

const watcher = new DepositWatcher(rpc, { addresses: [hot], confirmations: 30, from: cursor, tokens: ["VEL", "vUSDT"] });
for (;;) {
  for (const d of await watcher.poll()) {
    const user = d.memo?.match(/^[A-Za-z0-9_-]{1,64}$/) ? d.memo : null;
    // Idempotencia: la clave única es d.txId. Acredita en una transacción de tu base de datos junto con el cursor.
    console.log(user ? `acreditar ${formatAmount(d.token, d.amount)} a ${user} (tx ${d.txId})` : `sin memo: revisión manual (tx ${d.txId})`);
  }
  cursor = watcher.cursor;
  await Bun.sleep(5_000);
}
