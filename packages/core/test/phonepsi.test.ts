import { describe, expect, test } from "bun:test";
import * as V from "../src";

/** Puerta simulada: lo mismo que apps/web/worker/phone.ts (lookup2 + match) sobre un directorio en memoria. */
function gateway(keys: { kid: string; sk: Uint8Array }[]) {
  const rows: { kid: string; claim: string; tag: string; prefix: number; card: string }[] = [];
  const seen: unknown[] = [];
  return {
    seen,
    register(phone: string, card: string) {
      for (const k of keys) rows.push({ kid: k.kid, card, ...V.phoneServerTokens(k.sk, phone) });
    },
    lookup2(q: { b: string; p: number }[]): V.PhoneLookup2Response {
      seen.push(q);
      return {
        v: 1,
        keys: keys.map((k) => ({
          kid: k.kid,
          e: q.map((x) => V.phoneEvaluate(k.sk, x.b)),
          buckets: Object.fromEntries([...new Set(q.map((x) => x.p))].map((p) => [String(p), rows.filter((r) => r.kid === k.kid && r.prefix === p).map((r) => r.tag)])),
        })),
      };
    },
    match(claims: { k: string; c: string }[]) {
      seen.push(claims);
      return claims.flatMap((c) => rows.filter((r) => r.kid === c.k && r.claim === c.c).map((r) => ({ k: r.kid, c: r.claim, card: r.card })));
    },
  };
}

const seed = (n: number) => new Uint8Array(32).fill(n);

describe("búsqueda de teléfonos con OPRF (PSI ligero)", () => {
  test("encuentra solo los registrados y la puerta nunca ve un número", () => {
    const gw = gateway([{ kid: "1", sk: V.phoneOprfKey(seed(1), "1") }]);
    gw.register("+34600000001", "tarjeta-ana");
    gw.register("+34600000003", "tarjeta-beto");
    const agenda = ["+34600000001", "+34600000002", "+34600000003", "+447700900123"];
    const blinds = agenda.map(V.phoneBlind);
    const res = gw.lookup2(blinds.map((b) => ({ b: b.blinded, p: b.prefix })));
    const cands = V.phonePsiCandidates(blinds, res);
    expect(cands.map((c) => c.phone).sort()).toEqual(["+34600000001", "+34600000003"]);
    const cards = gw.match(cands.map((c) => ({ k: c.kid, c: c.claim })));
    expect(cards.map((c) => c.card).sort()).toEqual(["tarjeta-ana", "tarjeta-beto"]);
    // Nada de lo que recibió la puerta contiene un número ni sus dígitos.
    const wire = JSON.stringify(gw.seen);
    for (const p of agenda) {
      expect(wire).not.toContain(p);
      expect(wire).not.toContain(p.slice(1));
    }
  });

  test("el cegado cambia cada vez (no se puede seguir un número entre consultas)", () => {
    const a = V.phoneBlind("+34600000001"), b = V.phoneBlind("+34600000001");
    expect(a.blinded).not.toBe(b.blinded);
    expect(a.prefix).toBe(b.prefix);
    expect(a.prefix).toBeLessThan(2 ** V.PHONE_PSI_PREFIX_BITS);
  });

  test("las huellas dependen de la clave secreta: sin ella no se pueden calcular", () => {
    const t1 = V.phoneServerTokens(V.phoneOprfKey(seed(1), "1"), "+34600000001");
    const t2 = V.phoneServerTokens(V.phoneOprfKey(seed(2), "1"), "+34600000001");
    expect(t1.claim).not.toBe(t2.claim);
    expect(t1.prefix).toBe(t2.prefix);
  });

  test("rotación: con dos claves activas se encuentran los de las dos", () => {
    const oldK = { kid: "1", sk: V.phoneOprfKey(seed(1), "1") };
    const newK = { kid: "2", sk: V.phoneOprfKey(seed(9), "2") };
    const before = gateway([oldK]);
    before.register("+34600000001", "vieja");
    const both = gateway([newK, oldK]);
    both.register("+34600000002", "nueva");
    // El registrado con la clave vieja sigue en el directorio (copiamos su fila).
    both.register("+34600000001", "vieja");
    const blinds = ["+34600000001", "+34600000002"].map(V.phoneBlind);
    const cands = V.phonePsiCandidates(blinds, both.lookup2(blinds.map((b) => ({ b: b.blinded, p: b.prefix }))));
    expect(cands.length).toBe(2);
  });

  test("puntos no válidos se rechazan", () => {
    const sk = V.phoneOprfKey(seed(1), "1");
    expect(() => V.phoneEvaluate(sk, "zz")).toThrow();
    expect(() => V.phoneEvaluate(sk, "00".repeat(32))).toThrow();
  });
});
