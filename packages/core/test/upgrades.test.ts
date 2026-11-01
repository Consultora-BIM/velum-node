// Actualizaciones sin reiniciar: cadena en versión N → binario N+1 con migración en H → saldos idénticos,
// raíces iguales en todos los nodos (el que actualizó en marcha y el que reaplica desde génesis). Fotos con raíz.
import { afterEach, describe, expect, test } from "bun:test";
import * as V from "../src";
import { useTestGenesis } from "./genesis-de-prueba";

useTestGenesis();

const prop = V.keyPairFromText("proponente-upgrade");
const T1 = V.upgrades();
const base = T1[T1.length - 1]!.version;
const H = 25;
const T2: V.Upgrade[] = [
  ...T1,
  {
    version: base + 1, height: H, name: "prueba: contador de migración",
    // Migración pura: añade un campo a supply sin tocar ningún saldo.
    migrate: (s) => { (s.supply as any).migrations = ((s.supply as any).migrations ?? 0) + 1; },
  },
];

afterEach(() => V.setUpgrades(T1));

function nextBlock(s: V.ChainState): { block: V.Block; state: V.ChainState } {
  const ts = V.genesisTime() + (s.height + 1) * V.BLOCK_MS;
  const { block, state } = V.buildBlock(s, { proposer: prop.address, ts, txs: [], presence: [] });
  return { block: { ...block, sig: V.sign(prop.secret, block.hash) } as V.Block, state };
}

const balances = (s: V.ChainState) => JSON.stringify(s.balances);

describe("actualizaciones de protocolo sin reinicio", () => {
  test("N → N+1 con migración en H: saldos idénticos y raíces iguales en todos los nodos", () => {
    // Nodo A: corre la versión N hasta H−1.
    let a = V.genesisState();
    const blocks: V.Block[] = [];
    while (a.height < H - 1) { const r = nextBlock(a); blocks.push(r.block); a = r.state; }
    const before = balances(a);

    // A actualiza el binario (tabla nueva) SIN borrar sus datos y sigue.
    V.setUpgrades(T2);
    while (a.height < H + 5) { const r = nextBlock(a); blocks.push(r.block); a = r.state; }
    expect(balances(a)).toBe(before);
    expect((a.supply as any).migrations).toBe(1);
    expect(V.velLedgerGap(a)).toBe(0);
    expect(V.protocolAt(H - 1)).toBe(base);
    expect(V.protocolAt(H)).toBe(base + 1);

    // Nodo B: binario N+1 desde cero; reaplica todo y llega a las mismas raíces en cada altura.
    let b = V.genesisState();
    for (const blk of blocks) {
      const r = V.applyBlock(b, blk);
      if ("error" in r) throw new Error(`altura ${blk.header.height}: ${r.error}`);
      b = r.state;
      expect(V.stateRoot(b)).toBe(blk.header.stateRoot);
    }
    expect(b.hash).toBe(a.hash);

    // Nodo C: binario viejo (N). Sigue hasta H−1 y rechaza el bloque H: se para, no bifurca en silencio.
    V.setUpgrades(T1);
    let c = V.genesisState();
    for (const blk of blocks.slice(0, H - 1)) { const r = V.applyBlock(c, blk); if ("error" in r) throw new Error(r.error); c = r.state; }
    const r = V.applyBlock(c, blocks[H - 1]!);
    expect("error" in r).toBe(true);
    if (V.IS_MAINNET && "error" in r) expect(r.error).toContain(V.UPGRADE_NEEDED);
  });

  test("migraciones solo en su altura y tabla ordenada", () => {
    expect(() => V.setUpgrades([{ version: 2, height: 10, name: "a" }, { version: 3, height: 10, name: "b" }])).toThrow();
    expect(() => V.setUpgrades([{ version: 2, height: 10, name: "a" }, { version: 2, height: 20, name: "b" }])).toThrow();
  });

  test("foto de estado: exportar, importar y rechazar si se altera", () => {
    let s = V.genesisState();
    while (s.height < 12) s = nextBlock(s).state;
    const snap = V.exportSnapshot(s);
    const back = V.importSnapshot(JSON.parse(JSON.stringify(snap)), { height: s.height, stateRoot: V.stateRoot(s), hash: s.hash });
    expect(V.stateRoot(back)).toBe(V.stateRoot(s));
    // Sigue la cadena desde la foto igual que desde el estado original.
    expect(nextBlock(back).block.hash).toBe(nextBlock(s).block.hash);
    const bad = JSON.parse(JSON.stringify(snap)) as V.StateSnapshot;
    const addr = Object.keys(bad.state.balances)[0]!;
    bad.state.balances[addr]!.VEL! += 1;
    expect(() => V.importSnapshot(bad)).toThrow("raíz");
    expect(() => V.importSnapshot(snap, { height: s.height, stateRoot: "00" })).toThrow();
  });
});
