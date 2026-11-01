// Derivación BIP-32/44 de la cartera fría y formato de direcciones de TRON y EVM.
// En línea solo se usan las xpub (claves públicas): el puente nunca ve una clave privada de depósito.
// Las claves privadas solo se derivan sin conexión, en `scripts/firmar-retiros.ts` y `apps/node/scripts/cold-wallet.ts`.
import { HDKey } from "@scure/bip32";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, concatBytes } from "@noble/hashes/utils.js";
import { base58 } from "@scure/base";

/** Familias de dirección. Polygon y Ethereum comparten familia: misma dirección, mismo índice. */
export type Family = "tron" | "evm";
export type ChainId = "tron" | "polygon" | "ethereum";
export const CHAINS: readonly ChainId[] = ["tron", "polygon", "ethereum"];
export const familyOf = (c: ChainId): Family => (c === "tron" ? "tron" : "evm");

/** Rutas de cuenta (BIP-44). La xpub de cuenta es lo único que se publica. */
export const ACCOUNT_PATH: Record<Family, string> = { tron: "m/44'/195'/0'", evm: "m/44'/60'/0'" };
/** Rama 0 = depósitos (índice por cartera Velum). Rama 1, índice 0 = tesorería (barrido y pagos). */
export const DEPOSIT_BRANCH = 0;
export const TREASURY_BRANCH = 1;

// ---------- Direcciones ----------

/** Últimos 20 bytes de keccak256 de la clave pública sin comprimir (sin el 0x04). */
export function pubToAddr20(pub: Uint8Array): Uint8Array {
  const full = pub.length === 65 ? pub : secp256k1.Point.fromBytes(pub).toBytes(false);
  return keccak_256(full.slice(1)).slice(-20);
}

/** Dirección EVM con mayúsculas de control (EIP-55). */
export function evmAddress(addr20: Uint8Array): string {
  const hex = bytesToHex(addr20);
  const h = bytesToHex(keccak_256(new TextEncoder().encode(hex)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(h[i]!, 16) >= 8 ? hex[i]!.toUpperCase() : hex[i]!;
  return out;
}

const b58check = (payload: Uint8Array) => base58.encode(concatBytes(payload, sha256(sha256(payload)).slice(0, 4)));

/** Dirección TRON: base58check(0x41 ‖ 20 bytes). Empieza por «T». */
export function tronAddress(addr20: Uint8Array): string {
  return b58check(concatBytes(new Uint8Array([0x41]), addr20));
}

/** 20 bytes de una dirección TRON (comprueba prefijo y suma de control). */
export function tronToAddr20(addr: string): Uint8Array {
  const raw = base58.decode(addr);
  if (raw.length !== 25 || raw[0] !== 0x41) throw new Error("Dirección TRON no válida");
  const body = raw.slice(0, 21);
  const sum = sha256(sha256(body)).slice(0, 4);
  if (bytesToHex(sum) !== bytesToHex(raw.slice(21))) throw new Error("Dirección TRON con suma de control incorrecta");
  return body.slice(1);
}

/** 20 bytes de una dirección EVM. Si trae mayúsculas y minúsculas, exige EIP-55 correcto. */
export function evmToAddr20(addr: string): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(addr)) throw new Error("Dirección EVM no válida");
  const b = hexToBytes(addr.slice(2).toLowerCase());
  const mixed = addr.slice(2) !== addr.slice(2).toLowerCase() && addr.slice(2) !== addr.slice(2).toUpperCase();
  if (mixed && evmAddress(b) !== addr) throw new Error("Dirección EVM con mayúsculas de control incorrectas");
  return b;
}

export function addr20Of(chain: ChainId, addr: string): Uint8Array {
  return familyOf(chain) === "tron" ? tronToAddr20(addr) : evmToAddr20(addr);
}

export function formatAddr(chain: ChainId, addr20: Uint8Array): string {
  return familyOf(chain) === "tron" ? tronAddress(addr20) : evmAddress(addr20);
}

/** ¿Es una dirección de destino válida para esa cadena? */
export function isChainAddress(chain: ChainId, addr: string): boolean {
  try { addr20Of(chain, addr); return true; } catch { return false; }
}

/** Forma canónica para comparar (TRON tal cual; EVM en minúsculas). */
export const normAddr = (chain: ChainId, addr: string) => (familyOf(chain) === "tron" ? addr : addr.toLowerCase());

// ---------- Derivación desde xpub (en línea) ----------

const cache = new Map<string, HDKey>();
function account(xpub: string): HDKey {
  let k = cache.get(xpub);
  if (!k) { k = HDKey.fromExtendedKey(xpub); if (k.privateKey) throw new Error("Se esperaba una xpub, no una clave privada"); cache.set(xpub, k); }
  return k;
}

/** Dirección de la rama/índice bajo la xpub de cuenta. */
export function deriveAddress(family: Family, xpub: string, branch: number, index: number): string {
  const pub = account(xpub).deriveChild(branch).deriveChild(index).publicKey!;
  const a20 = pubToAddr20(pub);
  return family === "tron" ? tronAddress(a20) : evmAddress(a20);
}

export const depositAddress = (family: Family, xpub: string, index: number) => deriveAddress(family, xpub, DEPOSIT_BRANCH, index);
export const treasuryAddress = (family: Family, xpub: string) => deriveAddress(family, xpub, TREASURY_BRANCH, 0);

// ---------- Derivación desde semilla (solo sin conexión) ----------

/** xpub de cuenta de una familia a partir de la semilla BIP-39 (64 B). */
export function accountXpub(seed: Uint8Array, family: Family): string {
  const k = HDKey.fromMasterSeed(seed).derive(ACCOUNT_PATH[family]);
  const xpub = k.publicExtendedKey;
  k.wipePrivateData();
  return xpub;
}

/** Clave privada (32 B) de rama/índice. Solo para el firmante sin conexión. */
export function derivePrivateKey(seed: Uint8Array, family: Family, branch: number, index: number): Uint8Array {
  const k = HDKey.fromMasterSeed(seed).derive(`${ACCOUNT_PATH[family]}/${branch}/${index}`);
  const sk = k.privateKey!.slice();
  k.wipePrivateData();
  return sk;
}
