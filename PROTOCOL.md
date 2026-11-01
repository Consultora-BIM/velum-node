# Protocolo Velum — especificación pública

> Para quien quiera escribir un nodo, un cliente o una cartera compatible en otro lenguaje.
> La implementación de referencia es `packages/core` (TypeScript). Los detalles de diseño y su porqué están en
> `docs/protocolo-v2.md` y `docs/protocolo-v3.md`. Si este documento y el código no coinciden, mandan los
> **vectores de prueba** de `spec/vectors/*.json`: una implementación es compatible si los reproduce byte a byte.
>
> Regenerar vectores: `bun spec/generate.ts` (formato, claves, sobres, trozos, buzones, recibos, sorteo, reclamaciones,
> transacciones y bloques) y `bun packages/core/scripts/vectors.ts` (economía v3: comisiones, sello PoW, oráculo,
> niveles, liquidación, alias). Con `--check`, comprueban que el núcleo los sigue reproduciendo byte a byte.

## 1. Codificación y primitivas

| Elemento | Definición | Vector |
|---|---|---|
| JSON canónico | Objetos con claves ordenadas (orden de código UTF-16), sin espacios, sin claves `undefined`; arrays en orden; números como `JSON.stringify` | `canonical.json` |
| `hashHex(x)` | SHA-256 de los bytes UTF-8, en hex minúsculas | `canonical.json` |
| `hashObj(o)` | `hashHex(canonical(o))` | `canonical.json` |
| Raíz de Merkle | SHA-256 por pares de hojas hex concatenadas como texto; si el nivel es impar se duplica la última; lista vacía → 64 ceros | `merkle.json` |
| Firmas | ed25519 (RFC 8032). `signObj(o)` firma `canonical(o sin "sig")` y añade `sig` hex | `signatures.json` |
| Direcciones | `"vel" + base58(clave pública ed25519 de 32 B)` (alfabeto Bitcoin). Las cuentas especiales empiezan por `vel_` y no tienen clave | `keys.json` |
| Base64 | Estándar con relleno (`=`) | — |

## 2. Identidad y claves

- Frase de recuperación BIP-39 de 24 palabras → semilla de 64 B (`mnemonicToSeed`, sin contraseña).
- **Cartera** (firma transacciones): SLIP-10 ed25519 sobre la semilla, ruta `m/44'/7420'/cuenta'/0'/índice'` (todo endurecido;
  la app usa `0'/0'/0'`). Es lo que implementan Trezor y Ledger (moneda SLIP-44 7420, ver `docs/ecosistema.md`).
- **Identidad y buzones**: `HKDF-SHA512(ikm = semilla, salt = vacío, info, 32)` con `info` `velum/v2/identity` (firma perfiles
  y listas de dispositivos) y `velum/v2/mailbox` (secreto base de buzones). Identidad y cartera son claves distintas a propósito.
- Lo que se firma en una tx: bytes UTF-8 del JSON canónico sin `sig`; ed25519 puro (RFC 8032).
- Cada dispositivo tiene claves propias aleatorias: ed25519 (firma), X25519 + ML-KEM-768 (prellave que rota cada 24 h).
- `DeviceList = { v: 2, identity, devices[≤5], seq, ts, sig }` firmada por la identidad; gana el `seq` mayor.

## 3. Mensajes

- **Sobre** (`[1 ver=2][32 eph X25519][1088 kemCt][24 nonce][80 envoltorio][24 nonce2][cuerpo]`): clave =
  `HKDF-SHA512(X25519(eph, prellave) ‖ secretoML-KEM, salt = eph ‖ kemCt, "velum/v2/envelope", 32)`, cifrado
  XChaCha20-Poly1305. El envoltorio lleva la clave del cuerpo y `rseed` (semilla de recibos, distinta por copia).
  El cuerpo lleva el `Payload` firmado por la clave de dispositivo y el certificado del dispositivo. Vector de
  apertura: `envelope.json`.
- **Relleno**: el sobre mide exactamente un cubo: 2, 8, 32, 128, 512, 2048 u 8192 KB.
- **Trozos**: Reed-Solomon sistemático 3 de 5 (Cauchy sobre GF(256), polinomio 0x11d) por franjas. Trozo de 1, 3, 11
  o 24 KB según el cubo. `id = hex(sha512("msg|franja|idx"))[0..64]`. Vector: `shards.json`.
- `Shard = { id, msg, mailbox, stripe, idx, k: 3, n: 5, bucket, data, rh, mbAuth, exp, ep? }`. Un nodo lo acepta
  si `id` cuadra, `bucket` es un cubo, `k/n = 3/5`, `data` mide lo que toca, `rh` = 128 hex, `mbAuth` = 64 hex y
  `exp` cae en los próximos 7 días (`shardProblem` en `shards.ts`).

## 4. Buzones que rotan

- Buzón del día: `hex(HMAC-SHA512(mailboxSeed, "day:" + floor(ts / 86 400 000)))[0..40]`.
- Cada dispositivo tiene un escalar secreto `s` (pública `mbPub = s·G`). El emisor pone en cada trozo
  `mbAuth = mbPub + t·G`, `t = sha512("velum/v2/mbauth|" ‖ mbPub ‖ buzón) mod L`.
- Abrir: firma ed25519 estándar con el escalar `s + t` del texto `velum/v2/open|<buzón>|<ts>` (±15 min). El nodo
  verifica con `mbAuth` como clave pública y solo entrega trozos con ese `mbAuth`. Vector: `mailbox.json`.

## 5. Recibos anónimos y sorteo de rutas

- Secreto del trozo: `HMAC-SHA512(rseed, shardId)[0..32]`; el trozo lleva `rh = sha512(secreto)`.
- `ReceiptV2 = { shard, mailbox, rh, secret, carrier, courier, ts, ep? }` sin firma: es válido si `sha512(secret) == rh`.
  Vector: `receipts.json`.
- **Sorteo público** (anti autoengaño): al abrir cada época la cadena guarda una foto de nodos (`epochNodes`):
  baliza = hash del último bloque de la época anterior; nodos dados de alta antes de la época y con señal de vida
  en los últimos 300 bloques; peso completo 2, ligero 1. Para cada trozo y papel (`carrier`, `courier`):
  `x = primeros 8 bytes (BE) de sha512(baliza + "|" + id + "|" + papel) mod Σpesos` → nodo por suma acumulada sobre
  los nodos ordenados por dirección. Candidatos extra (v3): ronda `i ≥ 1` con sufijo `"|" + i` sobre los no elegidos.
  Vector: `lottery.json`.
- **v3 — reclamaciones con muestreo**: los recibos no entran en los bloques. Cada nodo apunta como hoja `{ r, role }`
  cada recibo en el que figura y está entre los 3 candidatos del sorteo, publica `work.claim { epoch, count, root }`
  (árbol SHA-512) en la época siguiente y, con la baliza de la época E+3, prueba 16 hojas al azar (`work.prove`).
  Una hoja falsa anula la reclamación; un tope de verosimilitud (×1,5 de lo esperado por su peso) limita lo que se
  puede inventar. Vector: `claims.json`. Algoritmo del nodo: `packages/core/src/workbook.ts`.
- El cliente envía cada trozo al carrier sorteado y manda el recibo al courier sorteado (si están en línea).

## 6. Cadena

- Transacciones (`tx.ts`): `transfer` (VEL o token), `register` (`kind: full | light`), `token.create`,
  `token.mint`, `pool.fund`, `order.place`, `order.cancel`, `device.attest` (+ las de v3). Todas llevan
  `{ chain, from, nonce, ts, sig }` y las firma la cartera. `txId = hashObj(tx)[0..48]`. Vector: `transactions.json`.
- Bloques cada 2 s; turno por hueco ordenando validadores activos por `hashHex(prevHash|hueco|dirección)`; los
  suplentes esperan ¼ de bloque por puesto. Cabecera con raíces Merkle de transacciones, recibos y señales de vida y
  `stateRoot = hashObj(estado de consenso)`. `applyBlock` reconstruye el bloque y exige el mismo hash.
  Vector: `chain.json` (génesis + 3 bloques).
- Toda la economía usa enteros (µVEL = 10⁻⁶ VEL) y BigInt para productos; el estado se recorre con claves ordenadas.

## 7. Red

JSON sobre WebSocket. Roles: `node`, `client`, `watch`.

- **Puerta** (`wss://…/hub?role=…`): un nodo saluda con `{ t: "hello", node, name, version, height, ts, sig, kind? }`
  (`sig` = ed25519 de `hello|<node>|<ts>`, ±2 min). La puerta reenvía `gossip` (`block`, `tx`, `shard`, `receipt`,
  `presence`), enruta `rpc` de clientes a un nodo (completo si no se indica), `rpc_res`, `push` (trozos a clientes),
  `direct` (nodo a nodo) y avisa de `peer join/leave` y `client_left`.
- **Nodos ligeros** (`kind: "light"`): la puerta solo les manda trozos, recibos, `head` y `epoch`; atienden
  `shard.put`, `mailbox.open`, `receipt.submit`, `node.info`, `chain.head`, `chain.epoch`.
- **Pares directos** (`ws://host:7420/ws?role=node`): mismas tramas; intercambio de vecinos con `{ t: "peers", urls }`.
  Si caen las puertas, los nodos usan los `endpoint` publicados en la cadena y las semillas DNS (TXT).
- **RPC entre nodos**: `direct { kind: "rpc", id, method, params }` → `direct { kind: "rpc_res", id, result | error }`.
- Métodos RPC: `chain.head`, `chain.block`, `chain.blocks`, `chain.epoch`, `account.get`, `account.balances`,
  `account.orders`, `account.history`, `tx.submit`, `faucet`, `shard.put`, `mailbox.open`, `receipt.submit`,
  `token.info`, `token.list`, `market.book`, `market.trades`, `supply`, `difficulty`, `node.info`, `node.get`,
  `node.list`, `stats` (tipos en `wire.ts`).
- Antispam del nodo de referencia: 50 `shard.put`/s por conexión (ráfaga 200), 2.000 trozos por buzón, tope global
  con desalojo de los que antes caducan, llamadas de 1 MB como máximo.

## 8. Distribución del nodo

- Binarios por plataforma (`darwin-arm64`, `darwin-x64`, `linux-x64`, `linux-arm64`, `windows-x64`).
- Manifiesto `https://<web>/download/manifest.json` = `{ version, chain, minNodeVersion, minAppVersion?, files:
  { <plataforma>: { url, sha512, size } }, ts, sig }`, firmado (ed25519 sobre el JSON canónico sin `sig`) con la clave
  de publicación cuya dirección va incrustada en el nodo (`apps/node/src/update.ts`). El nodo comprueba firma y
  SHA-512 antes de cambiar su binario, y se niega a participar por debajo de `minNodeVersion`.

## Mainnet (`velum-mainnet-1`)

Detalle y plan: `docs/mainnet.md`. Diferencias de consenso con la testnet:

- Época de 1.800 bloques (≈ 1 h). `HALVING_EPOCHS = 17.520`, `R0 = 25.684,931506 VEL`. Constantes por época reescaladas.
- Génesis (`packages/core/genesis/mainnet.json`): 100 M VEL a la cartera fría; token `vUSDT` (6 decimales, suministro 0, emisor = autoridad de la pasarela). Sin grifo ni tokens de prueba.
- Cabecera con `pv` (versión de protocolo). Tabla `UPGRADES` (`upgrades.ts`): versión por altura y migraciones puras en el bloque de activación. Un bloque con `pv` desconocido se rechaza con «Actualización necesaria».
- Oráculo: solo `VEL/vUSDT`. Umbral de comisión `FEE_FREE_USDT = 1.100 vUSDT`. El euro no entra en consenso.
- Tx nuevas: `bridge.mint { to, amount, src, ref }` (solo la autoridad; `ref` única), `bridge.redeem { dst, to, amount, fee: 0 }` (sello; dirección TRON base58check o EVM con EIP-55), `stake.delegate|stake.undelegate { node, amount }` (sello; 14 días de espera), `node.commission { bp }` (0–2.000; un cambio cada 7 días, ±500).
- Staking: la delegación suma a la fianza en el peso del sorteo (tope `BOND_CAP`). Lo que descubre el nodo se divide: comisión + resto a prorrata entre fianza propia y delegados (suelo entero; sobrante al nodo).
- `register.name` es opcional.
