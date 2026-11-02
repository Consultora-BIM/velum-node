export * from "./bytes";
export * from "./constants";
export * from "./keys";
export * from "./envelope";
export * from "./shards";
export * from "./tx";
export * from "./state";
export * from "./wire";
export * from "./client";

import { formatUnits } from "./amount";
/** Formatea velos (BigInt o texto decimal) como "12,345 VEL" (trunca a `decimals`). */
export function formatVel(velos: bigint | string, decimals = 3, locale = "es-ES"): string {
  return formatUnits(velos, { maxDecimals: decimals, locale, symbol: "VEL" });
}
export * from "./amount";
export * from "./era";
export * from "./proof";
export * from "./tokens";
export * from "./dex";
export * from "./attest";
export * from "./wallet";
export * from "./msgconst";
export * from "./seed";
export * from "./pq";
export * from "./devices";
export * from "./rs";
export * from "./mailbox";
export * from "./link";
export * from "./lottery";
export * from "./hubrouter";
export * from "./lightnode";
export * from "./pow";
export * from "./claims";
export * from "./oracle";
export * from "./names";
export * from "./workbook";
export * from "./network";
export * from "./genesis";
export * from "./upgrades";
export * from "./snapshot";
export * from "./slip10";
export * from "./bridge";
export * from "./staking";
export * from "./payreq";
export * from "./htlc";
export * from "./quota";
export * from "./phonepsi";
