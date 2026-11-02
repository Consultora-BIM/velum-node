// Protocolo v3 congelado (ver cabecera de cada archivo). Se usa solo desde ../era.ts.
export { type ChainState, genesisState, applyBlock, buildBlock, applyTx, stateRoot, velLedgerGap, cloneState, type BuildInput } from "./state";
export { type Tx, type Block, checkTx } from "./tx";
