// Frase de recuperación (24 palabras BIP-39) y derivación de claves (docs/protocolo-v2.md §1).
// Una sola copia de seguridad; cada uso tiene su propia clave para que nadie una chats y pagos.
import { generateMnemonic, mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist as english } from "@scure/bip39/wordlists/english.js";
import { wordlist as spanish } from "@scure/bip39/wordlists/spanish.js";
import { wordlist as french } from "@scure/bip39/wordlists/french.js";
import { wordlist as chinese } from "@scure/bip39/wordlists/simplified-chinese.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha512 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes } from "./bytes";
import { keyPairFromSecret, type KeyPair } from "./keys";
import { INFO } from "./msgconst";
import { slip10Derive, walletPath } from "./slip10";

/** Idiomas de la app. El ruso no tiene lista BIP-39 oficial: usa la inglesa. */
export type PhraseLang = "en" | "es" | "fr" | "zh" | "ru";

const LISTS: Record<Exclude<PhraseLang, "ru">, string[]> = { en: english, es: spanish, fr: french, zh: chinese };

export function wordlistFor(lang: PhraseLang = "en"): string[] {
  return lang === "ru" ? english : LISTS[lang] ?? english;
}

/** Limpia espacios y mayúsculas. NFKD lo aplica la librería al validar y al derivar. */
export function normalizePhrase(phrase: string): string {
  return phrase.normalize("NFKD").trim().toLowerCase().split(/[\s　]+/).filter(Boolean).join(" ");
}

/** Nueva frase de 24 palabras (256 bits de entropía). */
export function generatePhrase(lang: PhraseLang = "en"): string {
  return generateMnemonic(wordlistFor(lang), 256);
}

/**
 * Comprueba una frase. Devuelve el idioma de su lista o null si no es válida.
 * Prueba primero el idioma indicado y después el resto (el usuario puede haber cambiado de idioma).
 */
export function validatePhrase(phrase: string, lang?: PhraseLang): PhraseLang | null {
  const norm = normalizePhrase(phrase);
  if (norm.split(" ").length !== 24) return null;
  const order: PhraseLang[] = lang ? [lang, "en", "es", "fr", "zh"] : ["en", "es", "fr", "zh"];
  for (const l of order) {
    try {
      if (validateMnemonic(norm, wordlistFor(l))) return l === "ru" ? "en" : l;
    } catch {
      /* otra lista */
    }
  }
  return null;
}

/** Semilla de 64 bytes (PBKDF2 de BIP-39). Lanza si la frase no es válida. */
export function seedFromPhrase(phrase: string, passphrase = ""): Uint8Array {
  const norm = normalizePhrase(phrase);
  if (!validatePhrase(norm)) throw new Error("Frase de recuperación no válida");
  return mnemonicToSeedSync(norm, passphrase);
}

const derive = (seed: Uint8Array, info: string, len = 32) => hkdf(sha512, seed, undefined, utf8ToBytes(info), len);

export interface AccountKeys {
  /** Identidad: firma perfiles y listas de dispositivos. Solo la conocen los contactos. */
  identity: KeyPair;
  /** Cartera: firma transacciones. Separada de la identidad. */
  wallet: KeyPair;
  /** Secreto de buzón base (hex, 32 B). */
  mailboxBase: string;
}

export function identityFromSeed(seed: Uint8Array): KeyPair {
  return keyPairFromSecret(bytesToHex(derive(seed, INFO.identity)));
}

/**
 * Cartera: SLIP-10 ed25519 en `m/44'/7420'/0'/0'/<índice>'` (todo endurecido), como Trezor y Ledger.
 * Así una cartera física puede firmar para Velum sin criptografía propia (docs/ecosistema.md §4).
 * La identidad y los buzones siguen con HKDF: no son de cartera.
 */
export function walletFromSeed(seed: Uint8Array, index = 0, account = 0): KeyPair {
  const node = slip10Derive(seed, walletPath(account, index));
  const kp = keyPairFromSecret(bytesToHex(node.key));
  node.key.fill(0);
  node.chainCode.fill(0);
  return kp;
}

/** @deprecated Cartera v2 (HKDF `velum/v2/wallet/i`). Solo para recuperar saldos de la testnet antigua. */
export function legacyWalletFromSeed(seed: Uint8Array, index = 0): KeyPair {
  return keyPairFromSecret(bytesToHex(derive(seed, INFO.wallet(index))));
}

export function mailboxBaseFromSeed(seed: Uint8Array): string {
  return bytesToHex(derive(seed, INFO.mailbox));
}

export function keysFromSeed(seed: Uint8Array | string): AccountKeys {
  const s = typeof seed === "string" ? hexToBytes(seed) : seed;
  return { identity: identityFromSeed(s), wallet: walletFromSeed(s, 0), mailboxBase: mailboxBaseFromSeed(s) };
}

export function keysFromPhrase(phrase: string, passphrase = ""): AccountKeys {
  return keysFromSeed(seedFromPhrase(phrase, passphrase));
}
