# Ecosistema abierto de Velum

> Cualquiera puede construir sobre Velum: exchanges, carteras, carteras físicas, custodios, staking, exploradores.
> Nosotros mantenemos el protocolo y una implementación de referencia. **Solo la app de mensajería es cerrada.**

Vocabulario (protocolo-v3 §14): los nodos **descubren VEL abriendo puentes** (rutas de mensajes). **Nunca se destruye VEL.** El servicio USDT ⇄ vUSDT es la **pasarela** (`bridge` en el código).

## 1. Qué es abierto

| Pieza | Licencia | Para qué |
|---|---|---|
| `packages/core` | Apache-2.0 | Protocolo: claves, tx, estado, consenso, mensajería |
| `apps/node` | Apache-2.0 | Nodo completo (`velum-node`) |
| `packages/sdk` (`@velum/sdk`) | Apache-2.0 | Integración: claves, direcciones, tx, firma, RPC, ejemplos |
| `PROTOCOL.md` + `spec/vectors` | Apache-2.0 | Implementar Velum en otro lenguaje, byte a byte |
| App de mensajería (iOS) | Cerrada | — |

No hace falta pedirnos permiso. Sí pedimos que no uséis la marca Velum de forma que parezca un producto nuestro.

## 2. Exchanges

### 2.1 Nodo propio

- Instala `velum-node` (binario único) y deja que sincronice. No dependas de la puerta pública.
- RPC local: `ws://127.0.0.1:7420/ws?role=client`. No la expongas a internet.
- Comprueba la cadena: `chain.block {height: 0}` → `header.chain == "velum-mainnet-1"`.

### 2.2 Unidades

- VEL: 6 decimales. Todo importe en la cadena es un **entero** en µVEL (1 VEL = 1.000.000).
- Tokens: sus propios decimales (`token.info`). vUSDT: 6.

### 2.3 Confirmaciones y finalidad

- Día 1 la cadena **no tiene finalidad BFT instantánea**: un bloque reciente podría reorganizarse.
- Recomendación: **30 bloques (≈ 1 min)** para importes normales; **1.800 bloques (1 época, ≈ 1 h)** para importes grandes.
- Cuando entren los comités con firmas de finalidad ([escalado.md §3](escalado.md)), bastará con el bloque final. Se anunciará con altura de activación.
- Reorganización: guarda el `hash` de cada bloque acreditado; si el nodo devuelve otro hash a esa altura, revierte y vuelve a leer.

### 2.4 Depósitos

Dos patrones:

| Patrón | Cómo | Ventaja |
|---|---|---|
| Dirección + memo | Una dirección caliente; cada cliente pone su id en `memo` (≤ 128 caracteres) | Una sola clave; como XRP o Stellar |
| Dirección por cliente | Cartera `m/44'/7420'/0'/0'/i'` por cliente | Sin memo; más claves que barrer |

`DepositWatcher` (SDK) recorre bloques con N confirmaciones y devuelve `{ txId, height, from, to, amount, token, memo }`. Ejemplo: `packages/sdk/examples/deposit-watcher.ts`. La clave única de un depósito es `txId`.

### 2.5 Retiros

- `buildTransfer` (SDK) con el contexto de `chain.fees`. Bajo el umbral (1.100 vUSDT de valor) la comisión es 0 y la tx lleva un **sello de trabajo** (~50 ms). Por encima, 1 pb.
- Nonce: `account.get → nonce + pending`. Una cuenta = una secuencia. Para mucho volumen, usa varias carteras calientes en paralelo.
- Ejemplo: `packages/sdk/examples/withdrawal-signer.ts`.

### 2.6 Caliente y fría

- La **caliente** guarda lo que se retira en un día. La **fría** (sin conexión) la rellena.
- Firmar sin conexión: construye la tx en línea (nonce, sello), llévala al equipo frío, firma con `signTxBody`, vuelve y envía con `tx.submit`. La firma no depende de la red.
- Tope recomendado en la caliente: el volumen de retiros de 24 h.

### 2.7 vUSDT

- Token envuelto: 1 vUSDT = 1 USDT en la pasarela (`docs/mainnet.md §6`). Prueba de reservas pública en `/api/bridge/reserves`.
- Para canjear vUSDT por USDT en TRON o Polygon: `bridge.redeem` (SDK: `buildBridgeRedeem`).

## 3. Apps de cartera

- Frase BIP-39 de 24 palabras. Cartera = SLIP-10 ed25519 en `m/44'/7420'/cuenta'/0'/índice'`. La app oficial usa `0'/0'/0'`.
- Las claves de **identidad y dispositivo** de la mensajería salen de la misma frase con HKDF y **no** son de cartera: no las necesitas.
- Pagos, tokens, mercado, alias, staking y pasarela USDT: todo con el SDK y la RPC.
- Muestra siempre: importe, comisión exacta (normalmente 0) y lo que recibe el destinatario.

## 4. Carteras físicas (Trezor, Ledger y otras)

### 4.1 Derivación

| Dato | Valor |
|---|---|
| Curva | ed25519 |
| Derivación | SLIP-10, todos los niveles endurecidos |
| Ruta | `m/44'/7420'/cuenta'/0'/índice'` |
| Moneda SLIP-44 | **7420** (pendiente de registrar, §7) |
| Dirección | `"vel"` + base58 (alfabeto Bitcoin) de la clave pública de 32 B |

Vector: frase `abandon ×23 art` → ver `packages/sdk/test/sdk.test.ts` y `spec/vectors`.

### 4.2 Qué se firma

- Bytes = **UTF-8 del JSON canónico** de la tx **sin** el campo `sig`.
- JSON canónico: claves ordenadas (orden de JavaScript `sort()`), sin espacios, sin campos `undefined`, números enteros seguros (≤ 2⁵³ − 1), cadenas como `JSON.stringify`.
- Firma: **ed25519 puro** (RFC 8032), sin prehash. 64 B en hex minúsculas en `sig`.
- El **sello `pow`** forma parte de lo firmado. Lo calcula el equipo anfitrión **antes** de mandar la tx al dispositivo.
- Tamaño máximo a firmar: 4 KB (las tx de usuario miden 250–600 B).

### 4.3 Qué debe mostrar el dispositivo

| `type` | Campos en pantalla |
|---|---|
| `transfer` | Destino (`to` completo), importe (`amount` con decimales y `token` o VEL), comisión (`fee`), `memo` si hay |
| `stake.delegate` / `stake.undelegate` | Nodo (`node`), importe; aviso «14 días de espera» al retirar |
| `bridge.redeem` | Cadena de destino (`dst`), dirección de destino (`to`), importe en vUSDT |
| `order.place` | Par, lado, precio, cantidad |
| `name.register` | Alias |
| Otros | Rechazar o mostrar «tx avanzada» con el JSON completo |

Siempre: `chain` (avisar si no es `velum-mainnet-1`) y la cuenta (ruta).

### 4.4 Propuesta de app Ledger (APDU)

| INS | Nombre | Datos | Respuesta |
|---|---|---|---|
| `0x02` | GET_PUBLIC_KEY | ruta (nº niveles + u32 BE cada uno), P1 = 1 para mostrar la dirección | clave pública 32 B |
| `0x04` | SIGN_TX | trozos de ≤ 255 B; P1 = 0 primero, 0x80 siguientes; el primero lleva la ruta | firma 64 B |

`CLA = 0xE0`. El dispositivo analiza el JSON canónico (rechaza si no lo es) antes de mostrarlo.

## 5. Custodios

- Guardar claves de terceros es un servicio regulado (CASP en la UE). Ver `docs/mainnet.md §10`.
- Segregación: una cartera (o cuenta SLIP-10) por cliente, o libro interno con conciliación diaria contra la cadena.
- Staking con custodia: el custodio delega desde la cuenta del cliente; las recompensas llegan a esa misma cuenta.

## 6. Staking delegado

- `stake.delegate { node, amount }`: los VEL quedan bloqueados en la cadena y suman al **peso del nodo en el sorteo** (mismas reglas de tope que la fianza propia).
- `stake.undelegate { node, amount }`: vuelven a la cuenta tras **14 días**.
- `node.commission { bp }`: el nodo fija su comisión, **0–2.000 pb (0–20 %)**. Como mucho un cambio cada 7 días y ±500 pb por cambio.
- Cada época, lo que el nodo descubre se divide: su comisión y el resto **a prorrata** entre su fianza propia y sus delegados. Enteros; el sobrante del redondeo va al nodo. Nunca se entrega más de lo descubierto.
- Consultas: `stake.delegations { node }` o `{ address }`; API web `/api/delegations/node/:addr` y `/api/delegations/address/:addr`.
- No hay rendimiento garantizado. Si el nodo no trabaja, no hay recompensa.
- Ejemplo: `packages/sdk/examples/staking.ts`.

## 7. Registro SLIP-44 (borrador del PR, NO enviado)

Comprobado el 2026-11-01 sobre `satoshilabs/slips@e2824d0`: el número **7420** y el símbolo **VEL** están libres.

Cambio en `slip-0044.md`, en la tabla, en orden numérico:

```
| 7420       | VEL     | Velum                             |
```

Texto del PR:

> **Add Velum (VEL) as coin type 7420**
>
> Velum is an open-source (Apache-2.0) network for end-to-end encrypted messaging with its own ledger and native coin VEL.
> Keys are ed25519 derived with SLIP-10 at `m/44'/7420'/account'/0'/index'` (all hardened).
> Website: https://velumprotocol.org · Source: https://github.com/Consultora-BIM/velum-node
> Signing spec for hardware wallets: docs/ecosistema.md §4.

Antes de enviarlo: repo `velum-node` público y web con la especificación.
