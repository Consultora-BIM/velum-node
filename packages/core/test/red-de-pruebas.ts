// Precarga de los tests: si nadie dice otra cosa, los tests corren en testnet (los de siempre: grifo, épocas de 1 min).
// Los de mainnet se lanzan con VELUM_NETWORK=mainnet (ver package.json › test:mainnet).
process.env.VELUM_NETWORK ??= "testnet";
