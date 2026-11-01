export * from "./bytes";
export * from "./constants";
export * from "./keys";
export * from "./envelope";
export * from "./shards";
export * from "./tx";
export * from "./state";
export * from "./wire";
export * from "./client";

/** Formatea µVEL como "12,345 VEL". */
export function formatVel(micro: number, decimals = 3): string {
  return (micro / 1_000_000).toLocaleString("es-ES", { minimumFractionDigits: 0, maximumFractionDigits: decimals }) + " VEL";
}
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
