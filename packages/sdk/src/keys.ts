// Claves y direcciones de cartera para integradores.
// La cartera sale de la frase BIP-39 con SLIP-10 ed25519 en `m/44'/7420'/cuenta'/0'/índice'`.
// Dirección = "vel" + base58(clave pública ed25519 de 32 bytes). Sin suma de control propia: la valida la longitud.
import { mnemonicToSeedSync } from "@scure/bip39";
import { isAddress, keyPairFromSecret, normalizePhrase, validatePhrase, walletFromSeed, type KeyPair } from "@velum/core";

export { isAddress, keyPairFromSecret, type KeyPair };

/** Semilla BIP-39 (64 B). Lanza si la frase no es válida (24 palabras en/es/fr/zh). */
export function seedOf(phrase: string, passphrase = ""): Uint8Array {
  if (!validatePhrase(phrase)) throw new Error("Frase de recuperación no válida");
  return mnemonicToSeedSync(normalizePhrase(phrase), passphrase);
}

/** Cartera desde la semilla (SLIP-10). */
export function walletFromSeedSlip10(seed: Uint8Array, account = 0, index = 0): KeyPair {
  return walletFromSeed(seed, index, account);
}

/** Cartera desde la frase. Igual que la app y que una cartera física con la misma frase. */
export function walletFromPhrase(phrase: string, account = 0, index = 0, passphrase = ""): KeyPair {
  const seed = seedOf(phrase, passphrase);
  try { return walletFromSeedSlip10(seed, account, index); } finally { seed.fill(0); }
}

/** Id corto de una dirección para pantallas: 4 primeros + 4 últimos caracteres tras «vel». */
export function shortId(address: string): string {
  const body = address.startsWith("vel") ? address.slice(3) : address;
  return body.length <= 8 ? body : `${body.slice(0, 4)}…${body.slice(-4)}`;
}
