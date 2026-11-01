// Verificación de Apple App Attest (protocolo-v2 §11) en JS puro: CBOR + DER/ASN.1 mínimos escritos aquí,
// firmas con @noble/curves (P-256 / P-384). Determinista: la validez de los certificados se mira contra
// la HORA DEL BLOQUE (`now`), nunca contra el reloj del nodo. Así todos los nodos (y el indexador) coinciden.
//
// Pasos (documentación de Apple, «Validating apps that connect to your server»):
//  1. x5c = [credCert, intermediateCA]; cadena hasta la raíz «Apple App Attestation Root CA».
//  2. clientDataHash = lo que la app pasó a attestKey (en Velum: sha256(clave pública del dispositivo)).
//  3. nonce = sha256(authData ‖ clientDataHash) == extensión 1.2.840.113635.100.8.2 de credCert.
//  4. keyId == sha256(clave pública de credCert) == credentialId de authData.
//  5. rpIdHash == sha256(appId); contador 0; aaguid «appattest» (producción) o «appattestdevelop».
import { p256, p384 } from "@noble/curves/nist.js";
import { sha256, sha384 } from "@noble/hashes/sha2.js";
import { bytesToHex, hexToBytes, utf8ToBytes, concatBytes } from "./bytes";
import { base64 } from "@scure/base";
import { APP_ATTEST_APP_ID } from "./constants";

/** Raíz oficial (https://www.apple.com/certificateauthority/Apple_App_Attestation_Root_CA.pem). Caduca en 2045.
 *  SHA-256: 1CB9823BA28BA6AD2D33A006941DE2AE4F513EF1D4E831B9F7E0FA7B6242C932 */
export const APPLE_APP_ATTEST_ROOT_PEM = `-----BEGIN CERTIFICATE-----
MIICITCCAaegAwIBAgIQC/O+DvHN0uD7jG5yH2IXmDAKBggqhkjOPQQDAzBSMSYw
JAYDVQQDDB1BcHBsZSBBcHAgQXR0ZXN0YXRpb24gUm9vdCBDQTETMBEGA1UECgwK
QXBwbGUgSW5jLjETMBEGA1UECAwKQ2FsaWZvcm5pYTAeFw0yMDAzMTgxODMyNTNa
Fw00NTAzMTUwMDAwMDBaMFIxJjAkBgNVBAMMHUFwcGxlIEFwcCBBdHRlc3RhdGlv
biBSb290IENBMRMwEQYDVQQKDApBcHBsZSBJbmMuMRMwEQYDVQQIDApDYWxpZm9y
bmlhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAERTHhmLW07ATaFQIEVwTtT4dyctdh
NbJhFs/Ii2FdCgAHGbpphY3+d8qjuDngIN3WVhQUBHAoMeQ/cLiP1sOUtgjqK9au
Yen1mMEvRq9Sk3Jm5X8U62H+xTD3FE9TgS41o0IwQDAPBgNVHRMBAf8EBTADAQH/
MB0GA1UdDgQWBBSskRBTM72+aEH/pwyp5frq5eWKoTAOBgNVHQ8BAf8EBAMCAQYw
CgYIKoZIzj0EAwMDaAAwZQIwQgFGnByvsiVbpTKwSga0kP0e8EeDS4+sQmTvb7vn
53O5+FRXgeLhpJ06ysC5PrOyAjEAp5U4xDgEgllF7En3VcE3iexZZtKeYnpqtijV
oyFraWVIyd/dganmrduC1bmTBGwD
-----END CERTIFICATE-----`;

export const pemToDer = (pem: string) => decodeB64(pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, ""));

/** base64 estándar o URL-safe, con o sin relleno. */
export function decodeB64(s: string): Uint8Array {
  let t = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  while (t.length % 4) t += "=";
  return base64.decode(t);
}

// ---------- CBOR mínimo (lo que usa App Attest) ----------
export type Cbor = number | bigint | string | Uint8Array | Cbor[] | Map<Cbor, Cbor> | boolean | null | undefined;

export function decodeCbor(buf: Uint8Array): Cbor {
  let p = 0;
  const need = (n: number) => { if (p + n > buf.length) throw new Error("CBOR truncado"); };
  const readLen = (info: number): number => {
    if (info < 24) return info;
    const n = info === 24 ? 1 : info === 25 ? 2 : info === 26 ? 4 : info === 27 ? 8 : -1;
    if (n < 0) throw new Error("CBOR: longitud indefinida no soportada");
    need(n);
    let v = 0;
    for (let i = 0; i < n; i++) v = v * 256 + buf[p++]!;
    if (!Number.isSafeInteger(v)) throw new Error("CBOR: entero demasiado grande");
    return v;
  };
  const item = (depth: number): Cbor => {
    if (depth > 16) throw new Error("CBOR demasiado anidado");
    need(1);
    const b = buf[p++]!;
    const major = b >> 5, info = b & 31;
    switch (major) {
      case 0: return readLen(info);
      case 1: return -1 - readLen(info);
      case 2: { const n = readLen(info); need(n); const v = buf.slice(p, p + n); p += n; return v; }
      case 3: { const n = readLen(info); need(n); const v = new TextDecoder().decode(buf.subarray(p, p + n)); p += n; return v; }
      case 4: { const n = readLen(info); const a: Cbor[] = []; for (let i = 0; i < n; i++) a.push(item(depth + 1)); return a; }
      case 5: { const n = readLen(info); const m = new Map<Cbor, Cbor>(); for (let i = 0; i < n; i++) { const k = item(depth + 1); m.set(k, item(depth + 1)); } return m; }
      case 6: readLen(info); return item(depth + 1); // etiqueta: se ignora
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        if (info === 23) return undefined;
        throw new Error("CBOR: tipo simple no soportado");
    }
    throw new Error("CBOR no válido");
  };
  const v = item(0);
  if (p !== buf.length) throw new Error("CBOR con bytes de sobra");
  return v;
}

// ---------- DER / ASN.1 mínimo ----------
export interface Der {
  cls: number; // 0 universal, 1 aplicación, 2 contexto, 3 privada
  constructed: boolean;
  tag: number;
  /** Bytes completos (cabecera + contenido). */
  raw: Uint8Array;
  /** Contenido. */
  value: Uint8Array;
  children: Der[];
}

export function parseDer(buf: Uint8Array, depth = 0): Der {
  const { node, end } = parseAt(buf, 0, depth);
  if (end !== buf.length) throw new Error("DER con bytes de sobra");
  return node;
}

function parseAt(buf: Uint8Array, start: number, depth: number): { node: Der; end: number } {
  if (depth > 24) throw new Error("DER demasiado anidado");
  let p = start;
  const at = () => { if (p >= buf.length) throw new Error("DER truncado"); return buf[p++]!; };
  const b0 = at();
  const cls = b0 >> 6, constructed = (b0 & 0x20) !== 0;
  let tag = b0 & 0x1f;
  if (tag === 0x1f) { // número de etiqueta largo (p. ej. las extensiones de Apple bf 89 xx)
    tag = 0;
    let b: number;
    let n = 0;
    do { b = at(); tag = tag * 128 + (b & 0x7f); if (++n > 4) throw new Error("DER: etiqueta demasiado larga"); } while (b & 0x80);
  }
  let len = at();
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new Error("DER: longitud no soportada");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + at();
  }
  const vStart = p, vEnd = p + len;
  if (vEnd > buf.length) throw new Error("DER truncado");
  const value = buf.subarray(vStart, vEnd);
  const children: Der[] = [];
  if (constructed) {
    let q = vStart;
    while (q < vEnd) { const c = parseAt(buf, q, depth + 1); children.push(c.node); q = c.end; }
    if (q !== vEnd) throw new Error("DER: hijos no cuadran");
  }
  return { node: { cls, constructed, tag, raw: buf.subarray(start, vEnd), value, children }, end: vEnd };
}

export function oidToString(v: Uint8Array): string {
  if (v.length === 0) throw new Error("OID vacío");
  const parts: number[] = [];
  const first = v[0]!;
  parts.push(first < 80 ? Math.floor(first / 40) : 2, first < 80 ? first % 40 : first - 80);
  let acc = 0;
  for (let i = 1; i < v.length; i++) {
    acc = acc * 128 + (v[i]! & 0x7f);
    if (!(v[i]! & 0x80)) { parts.push(acc); acc = 0; }
  }
  return parts.join(".");
}

function parseTime(d: Der): number {
  const s = new TextDecoder().decode(d.value);
  let m: RegExpMatchArray | null;
  if (d.tag === 0x17 && (m = s.match(/^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    const yy = +m[1]!;
    return Date.UTC(yy < 50 ? 2000 + yy : 1900 + yy, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  }
  if (d.tag === 0x18 && (m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/))) {
    return Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  }
  throw new Error("Fecha de certificado no válida");
}

const OID = {
  ecPublicKey: "1.2.840.10045.2.1",
  p256: "1.2.840.10045.3.1.7",
  p384: "1.3.132.0.34",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  appleNonce: "1.2.840.113635.100.8.2",
} as const;

export interface Cert {
  tbs: Uint8Array;
  sigAlg: string;
  signature: Uint8Array; // DER
  issuer: Uint8Array;
  subject: Uint8Array;
  notBefore: number;
  notAfter: number;
  curve: string;
  publicKey: Uint8Array; // punto sin comprimir
  extensions: Map<string, Uint8Array>;
}

export function parseCert(der: Uint8Array): Cert {
  const c = parseDer(der);
  if (c.tag !== 0x10 || c.children.length !== 3) throw new Error("Certificado mal formado");
  const [tbsN, algN, sigN] = c.children as [Der, Der, Der];
  const t = tbsN.children;
  let i = 0;
  if (t[0]?.cls === 2 && t[0].tag === 0) i++; // [0] versión
  const serial = t[i++], sigAlgIn = t[i++], issuer = t[i++], validity = t[i++], subject = t[i++], spki = t[i++];
  if (!serial || !sigAlgIn || !issuer || !validity || !subject || !spki) throw new Error("TBS incompleto");
  const sigAlg = oidToString(algN.children[0]!.value);
  if (oidToString(sigAlgIn.children[0]!.value) !== sigAlg) throw new Error("Algoritmo de firma incoherente");
  if (sigN.tag !== 0x03 || sigN.value[0] !== 0) throw new Error("Firma mal formada");
  const keyAlg = spki.children[0]!;
  if (oidToString(keyAlg.children[0]!.value) !== OID.ecPublicKey) throw new Error("Clave no EC");
  const curve = oidToString(keyAlg.children[1]!.value);
  const bits = spki.children[1]!;
  if (bits.tag !== 0x03 || bits.value[0] !== 0) throw new Error("Clave mal formada");
  const extensions = new Map<string, Uint8Array>();
  for (; i < t.length; i++) {
    const n = t[i]!;
    if (n.cls === 2 && n.tag === 3) {
      for (const ext of n.children[0]?.children ?? []) {
        const id = oidToString(ext.children[0]!.value);
        const val = ext.children[ext.children.length - 1]!;
        if (val.tag !== 0x04) throw new Error("Extensión mal formada");
        extensions.set(id, val.value);
      }
    }
  }
  return {
    tbs: tbsN.raw, sigAlg, signature: sigN.value.subarray(1), issuer: issuer.raw, subject: subject.raw,
    notBefore: parseTime(validity.children[0]!), notAfter: parseTime(validity.children[1]!),
    curve, publicKey: bits.value.subarray(1), extensions,
  };
}

const eq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/** ¿`child` está firmado por la clave de `issuer`? */
export function certSignedBy(child: Cert, issuer: Cert): boolean {
  if (!eq(child.issuer, issuer.subject)) return false;
  const hash = child.sigAlg === OID.ecdsaSha256 ? sha256 : child.sigAlg === OID.ecdsaSha384 ? sha384 : null;
  const curve = issuer.curve === OID.p256 ? p256 : issuer.curve === OID.p384 ? p384 : null;
  if (!hash || !curve) return false;
  try {
    return curve.verify(child.signature, hash(child.tbs), issuer.publicKey, { prehash: false, format: "der", lowS: false });
  } catch {
    return false;
  }
}

export type AttestResult =
  | { ok: true; env: "production" | "development"; publicKey: string; keyId: string; counter: number }
  | { ok: false; error: string };

export interface AttestInput {
  /** Objeto de atestación CBOR (base64/base64url o bytes). */
  attestation: string | Uint8Array;
  /** keyId que devolvió generateKey (base64). */
  keyId: string;
  /** clientDataHash en hex (32 bytes). */
  clientDataHashHex: string;
  /** Hora de referencia (ms): la del bloque. */
  now: number;
  /** Por defecto D58V3B3XNT.com.consultorabim.velum. */
  appId?: string;
  /** Raíz alternativa en DER (solo tests). */
  rootDer?: Uint8Array;
}

let rootCache: Cert | null = null;
const appleRoot = () => (rootCache ??= parseCert(pemToDer(APPLE_APP_ATTEST_ROOT_PEM)));

const AAGUID_PROD = concatBytes(utf8ToBytes("appattest"), new Uint8Array(7));
const AAGUID_DEV = utf8ToBytes("appattestdevelop");

/** Verifica una atestación App Attest. Nunca lanza: devuelve `{ ok:false, error }`. */
export function verifyAppAttest(input: AttestInput): AttestResult {
  try {
    const raw = typeof input.attestation === "string" ? decodeB64(input.attestation) : input.attestation;
    if (raw.length > 12_000) return { ok: false, error: "Atestación demasiado grande" };
    const obj = decodeCbor(raw);
    if (!(obj instanceof Map)) return { ok: false, error: "No es un mapa CBOR" };
    if (obj.get("fmt") !== "apple-appattest") return { ok: false, error: "Formato no es apple-appattest" };
    const stmt = obj.get("attStmt"), authData = obj.get("authData");
    if (!(stmt instanceof Map) || !(authData instanceof Uint8Array)) return { ok: false, error: "Faltan attStmt/authData" };
    const x5c = stmt.get("x5c");
    if (!Array.isArray(x5c) || x5c.length !== 2 || !x5c.every((c) => c instanceof Uint8Array)) return { ok: false, error: "x5c debe tener 2 certificados" };
    const leaf = parseCert(x5c[0] as Uint8Array);
    const inter = parseCert(x5c[1] as Uint8Array);
    const root = input.rootDer ? parseCert(input.rootDer) : appleRoot();

    // 1. Cadena y validez a la hora del bloque.
    for (const [c, name] of [[leaf, "credCert"], [inter, "intermedio"], [root, "raíz"]] as const) {
      if (input.now < c.notBefore || input.now > c.notAfter) return { ok: false, error: `Certificado ${name} fuera de validez` };
    }
    if (!certSignedBy(inter, root)) return { ok: false, error: "El intermedio no lo firma la raíz de Apple" };
    if (!certSignedBy(leaf, inter)) return { ok: false, error: "credCert no lo firma el intermedio" };

    // 2-3. nonce.
    const cdh = hexToBytes(input.clientDataHashHex);
    if (cdh.length !== 32) return { ok: false, error: "clientDataHash no válido" };
    const nonce = sha256(concatBytes(authData, cdh));
    const ext = leaf.extensions.get(OID.appleNonce);
    if (!ext) return { ok: false, error: "Falta la extensión nonce" };
    const extNode = parseDer(ext);
    const inner = extNode.children[0]?.children[0];
    if (!inner || inner.tag !== 0x04 || !eq(inner.value, nonce)) return { ok: false, error: "El nonce no coincide" };

    // 4. Clave y keyId.
    if (leaf.curve !== OID.p256 || leaf.publicKey.length !== 65) return { ok: false, error: "Clave de credCert no es P-256" };
    const keyId = decodeB64(input.keyId);
    if (!eq(sha256(leaf.publicKey), keyId)) return { ok: false, error: "keyId no corresponde a la clave" };

    // 5. authData.
    if (authData.length < 55) return { ok: false, error: "authData corto" };
    const rpIdHash = authData.subarray(0, 32);
    if (!eq(rpIdHash, sha256(utf8ToBytes(input.appId ?? APP_ATTEST_APP_ID)))) return { ok: false, error: "rpIdHash no es el de la app" };
    const counter = ((authData[33]! << 24) >>> 0) + (authData[34]! << 16) + (authData[35]! << 8) + authData[36]!;
    if (counter !== 0) return { ok: false, error: "El contador debe ser 0" };
    const aaguid = authData.subarray(37, 53);
    const env = eq(aaguid, AAGUID_PROD) ? "production" : eq(aaguid, AAGUID_DEV) ? "development" : null;
    if (!env) return { ok: false, error: "aaguid no válido" };
    const credLen = (authData[53]! << 8) + authData[54]!;
    if (authData.length < 55 + credLen) return { ok: false, error: "authData truncado" };
    if (!eq(authData.subarray(55, 55 + credLen), keyId)) return { ok: false, error: "credentialId no coincide con keyId" };
    return { ok: true, env, publicKey: bytesToHex(leaf.publicKey), keyId: bytesToHex(keyId), counter };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Atestación no válida" };
  }
}
