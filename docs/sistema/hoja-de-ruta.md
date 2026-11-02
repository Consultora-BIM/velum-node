# Hoja de ruta: lo que falta por implementar

> Estado a 2 de noviembre de 2026, leído del código de la rama de trabajo v4.
> Leyenda: **Hecho** (en el código y activo) · **Escrito** (en el código, sin activar) · **Parcial** · **Pendiente** (no existe).
> Ninguna fecha aquí es una promesa. Las activaciones se anuncian con al menos 14 días.

## 1. Resumen

| # | Pieza | Estado | Lo que falta, en una línea |
|---|---|---|---|
| 1 | Economía v4 en mainnet | Parcial | Altura fijada (28.800); reaplicar la mainnet real y subir `minNodeVersion` |
| 2 | Nodo 2.1.0 | Parcial | Código en 2.1.0; falta publicar el manifiesto firmado |
| 3 | App y web con importes v4 | Parcial | La cartera del móvil aún usa `number` |
| 4 | HTLC P2P (v5) | Escrito | Altura, nodo/SDK/app y contrato en la otra cadena |
| 5 | Estándar de pagos `velum:pay` | Parcial | NFC, «verificado» en la app, recibos |
| 6 | Cupo gratis y consumo de créditos | Parcial | Aplicado en puerta y nodos (fuera de consenso); falta contabilidad global y pase anónimo fuerte |
| 7 | Nodo del móvil en segundo plano | Parcial | Push cifrado; límites de iOS |
| 8 | Tiendas de apps | Parcial | Envío sin configurar; formato Android |
| 9 | Descentralización | Pendiente | Más productores, coste de alta, finalidad |
| 10 | Escala (10⁶ nodos) | Pendiente | Comités, SMT, malla, DHT |
| 11 | Privacidad avanzada | Pendiente | Firmas poscuánticas, trinquete, tráfico de cobertura |
| 12 | Pasarela USDT ⇄ vUSDT | Hecho, cerrada | Revisión legal y decisión del operador |
| 13 | Endurecimiento | Pendiente | Invariante en vivo, `rewards` en el hash, fotos contra la red |

## 2. Detalle

### 2.1 Activación de la economía v4

| Qué hay | Dónde |
|---|---|
| Reglas v4 (BigInt, 18 decimales, tope 21.000 M, mitad cada 4 años, sin quema, créditos) | `constants.ts`, `state.ts`, `tx.ts` |
| Migración pura en el bloque H (×10¹² en VEL, fuera `burned`, aparecen créditos) | `era.ts` |
| Núcleo v3 congelado para validar la historia | `packages/core/src/v3` |
| Tests: reglas antes y después de H, saldos conservados, raíces iguales al reaplicar, binario viejo se para | `packages/core/test/v4.test.ts` |
| Script de reaplicación de la mainnet real | `packages/core/scripts/replay-mainnet.ts` |

**Falta:**

1. **H fijada:** `MAINNET_V4_HEIGHT = 28_800` (época 16, hacia las 12:05 UTC del 2 de noviembre de 2026), primer cierre de época al menos 2 h después de publicar el nodo 2.1.0.
2. Reaplicar la mainnet real con el binario nuevo (`replay-mainnet.ts`) y comprobar raíces e invariante.
3. Subir `minNodeVersion` en el manifiesto firmado antes de H.
4. Aviso público de 14 días.
5. Revisar el commit de trabajo («no fusionar sin revisar») antes de fusionar.

### 2.2 Nodo 2.1.0

- `apps/node/src/version.ts` dice **2.1.0**. El manifiesto del repositorio aún dice 2.0.0.
- El script de publicación usa `--min 2.0.0` por defecto.
- El mecanismo de retención por `minNodeVersion` ya existe y funciona.
- **Falta:** subir la versión, compilar los 5 binarios, firmar el manifiesto y publicarlo.

### 2.3 App y escritorio con importes v4

- Guía de migración: `packages/core/V4_READY` (BigInt, texto decimal en la RPC, `formatAmount`, `parseAmount`).
- **Falta en el móvil:** `apps/mobile/src/lib/cartera.ts` sigue con `Saldos = Record<string, number>` y `Number(tx.amount)`. Solo cobros y cifras usan BigInt. El nodo ligero aún etiqueta ganancias en µVEL.
- Escritorio y pasarela: ya tocados para v4; revisar.

### 2.4 Intercambio P2P atómico (HTLC, protocolo v5)

| Hecho | Falta |
|---|---|
| `htlc.lock`, `htlc.claim`, `htlc.refund` en la cadena, sin comisión y con sello | Entrada `{ version: 5, height }` en `MAINNET_UPGRADES` y `TESTNET_UPGRADES` |
| Caducidad de 1 a 720 épocas; 100 candados por cartera | Uso en el nodo, el SDK y la app (hoy ninguno los usa) |
| Constructores en `wallet.ts`; tests con v5 forzada | Pantalla de oferta en el chat y estado del intercambio |
| Diseño en `docs/intercambio-p2p.md` | Guardar el secreto cifrado y vigilar las dos cadenas (cerrar solo) |
| | Contrato HTLC estándar (o auditado) en Polygon/TRON |

Mientras no haya altura, la cadena rechaza estas transacciones y la raíz no cambia.

### 2.5 Estándar de pagos `velum:pay`

| Hecho | Falta |
|---|---|
| Enlace `velum:pay?...`, factura firmada, memo `pay:<ref>`, reconocimiento del pago (`payreq.ts`) | La app no comprueba la firma de la factura («verificado») |
| Estados pendiente → incluido → firme (30 o 1.800 bloques) | **NFC**: no hay librería NFC en la app (ni etiqueta ni emulación en Android) |
| SDK: `createInvoice`, `parsePaymentURI`, `watchPayment` | La app usa sus propias funciones, no las del núcleo |
| TPV de ejemplo (`packages/sdk/examples/pos/`) | Guardar recibos (`ref`, tx, altura) en la app |
| App: leer QR `velum:pay` y modo comercio | `velum:pay` en el escritorio |

### 2.6 Cupo gratis y consumo de créditos

- **Hecho (rama sec/antispam-buzones):** la puerta y los nodos aplican el cupo de 20 mensajes / 10 min (`quota.ts`). Unidad: copia (`msg`), 10 copias por mensaje = 200 copias / 10 min por remitente.
- Remitente = seudónimo diario del **pase de envío** (clave derivada de la del dispositivo, cambia cada día) o, sin pase (app 2.1.0), la conexión. Topes extra por conexión (4 seudónimos) y por IP (holgado, por CGNAT).
- Créditos: lo comprado se lee del estado (solo lectura); lo gastado lo apunta **cada relé** en su libro (fuera de la cadena). Para usarlos, el pase añade la dirección firmada: el relé la ve (opcional, para bots).
- **Falta:** contabilidad global de créditos (recibos agregados, `docs/economia-v4.md` §9) y un pase anónimo resistente a Sybil (dispositivo atestado, RLN o tickets ciegos): hoy crear seudónimos es gratis y lo frenan los topes por conexión e IP. Los nodos ligeros (móvil) aún no aplican el cupo.
- Después: llevar el consumo a la cadena con recibos agregados (`docs/economia-v4.md` §9).

### 2.7 Nodo del móvil en segundo plano y bajo consumo

| Hecho | Falta |
|---|---|
| Caja aislada con límites; modo ahorro sin cargar | Push cifrado de extremo a extremo para despertar sin socket (necesita clave APNs y relé ciego). Hoy no hay push remoto |
| Android: servicio en primer plano con aviso fijo | Medir consumo real y ajustar límites |
| iOS: ventanas de fondo (≈25 s) del sistema | iOS no permite un servidor permanente: el nodo iOS aporta poco por diseño |
| Solo Wi-Fi y cargando por defecto; nunca bajo 30 % | Mostrar ganancias en velos (v4) |

### 2.8 Tiendas de apps

- Fichas listas para App Store y Google Play (5 idiomas, privacidad, cumplimiento de exportación).
- **Falta:**
  - `eas.json › submit.production` está vacío (sin cuentas ni pista).
  - Android se compila como `apk`; Google Play pide `aab`.
  - Capturas en francés y ruso.
  - Atestación en Android (Play Integrity). Hoy solo iOS.

### 2.9 Descentralización

Hoy produce bloques **un solo nodo**. El turno ya admite a cualquier nodo completo registrado y activo.

| Paso | Estado |
|---|---|
| Publicar 2.1.0 y abrir a operadores independientes | Pendiente |
| Coste de alta como productor (fianza mínima o PoW) contra nodos falsos | Pendiente: hoy el alta es gratis |
| Comités por época con finalidad (> 2/3) y comité de respaldo | Pendiente (diseño en `docs/escalado.md` §3) |
| Varias puertas independientes | Pendiente: hoy una sola puerta global |
| Multifirma para la clave de publicación y la billetera fría | Pendiente |
| Registro SLIP-44 (moneda 7420) | Borrador, no enviado |

### 2.10 Escala

Todo pendiente. Diseño en `docs/escalado.md`:

- Raíz de estado con árbol de Merkle disperso (hoy, hash del estado entero en cada bloque).
- Reclamaciones agregadas por células, con muestreo en dos niveles.
- Malla GossipSub entre nodos; DHT Kademlia para buzones.
- Formato binario (CBOR canónico) en red.
- Indexador separado de la puerta.

### 2.11 Privacidad y criptografía

| Pieza | Estado |
|---|---|
| Firmas poscuánticas (ML-DSA) | Pendiente. Hoy ed25519 |
| Doble trinquete (secreto hacia delante por mensaje) | Pendiente. Hoy prellaves de 24 h guardadas 7 días |
| Tráfico de cobertura y rutas de 3 saltos | Pendiente |
| Búsqueda de teléfonos con PSI o enclave | Hecho (PSI ligero con OPRF, `/api/phone/lookup2` + `/match`). `/lookup` en claro queda obsoleto hasta el 1-2-2027 (app 2.1.0) |
| Bloqueo que también frene en la red | Pendiente. Hoy solo local |
| Fallo si SQLCipher no está activo (en vez de aviso) | Hecho: pantalla de bloqueo, la app no arranca sin cifrado |

### 2.12 Pasarela USDT ⇄ vUSDT

- Hecha y probada (12 tests), **cerrada** (`BRIDGE_ENABLED=false`).
- Abrirla exige revisión legal y decisión del operador (`docs/mainnet.md` §10).
- Mejora: topes de acuñación también en la cadena, no solo en el servicio.

### 2.13 Endurecimiento

| Pieza | Por qué |
|---|---|
| Evaluar `velLedgerGap` en la puerta y publicarlo | Hoy solo en tests y reaplicación |
| Meter `rewards` en el hash o recalcularlas en la puerta | Hoy el explorador guarda la lista tal cual llega |
| Comparar `snapshot import` con una cabecera de la red | Hoy solo con la raíz del propio archivo |
| Límite de profundidad de reorganización | Hoy no hay |
| Atestación en modo estricto en la puerta y el nodo | En consenso es «suave» |

### 2.14 Escritorio

- Pendiente: staking en la cartera, pruebas en Windows y Linux (llavero), notas de voz, lista de chats virtualizada.

## 3. Documentos que hay que actualizar

| Documento | Qué está desfasado |
|---|---|
| `docs/mainnet.md` §2 | Tope 1.000 M y mitad cada 2 años (es la v3; la v4 cambia ambos) |
| `docs/protocolo-v3.md` §14 | Tope 900 M descubribles (v3) |
| `docs/protocolo-v3.md` §C | Dice que elegir el candidato de menor latencia está pendiente; ya está hecho |
| `docs/protocolo-v2.md` §5 | Describe la apertura de buzón con HMAC; el código usa firma con escalar ajustado |
| `docs/protocolo-v2.md` §13 | URL de manifiesto antigua; hoy hay varios orígenes |
| `MAINNET_READY` | Dice que `genesis/mainnet.json` está vacía; ya está rellena |
| `packages/core/src/constants.ts:208` | Comentario de trozos «4 + 1»; el código usa 3 de 5 |
| `packages/core/src/oracle.ts:5` | Ventana de «60 épocas»; en mainnet es 1 época de 1 h |
| `apps/mobile/src/lib/respaldo-formato.ts:1` | Remite a `docs/formato-velum.md`, que no existe |

## Referencias

- v4: `packages/core/src/upgrades.ts:17-41`; `packages/core/src/era.ts:1-193`; `packages/core/V4_READY`; `packages/core/test/v4.test.ts:62-232`; `packages/core/scripts/replay-mainnet.ts`.
- Versión del nodo: `apps/node/src/version.ts:2`; `apps/node/src/update.ts:198`; `apps/node/src/main.ts:168-170`; `apps/node/scripts/release.ts:92`; `apps/web/public/download/manifest.json`.
- Móvil v4: `apps/mobile/src/lib/cartera.ts:17`, `:32`, `:194`; `apps/mobile/src/lib/nodo-ligero.ts:37`.
- HTLC: `packages/core/src/htlc.ts:1-45`; `packages/core/src/state.ts:600-658`; `packages/core/src/tx.ts:199-210`; `packages/core/src/wallet.ts:147-165`; `packages/core/test/htlc.test.ts:26`, `:109`; `docs/intercambio-p2p.md`.
- Pagos: `packages/core/src/payreq.ts:83-232`; `packages/sdk/src/payments.ts:13-55`; `apps/mobile/src/app/escanear.tsx:39-44`; `apps/mobile/src/app/(app)/cobro.tsx:26`; `docs/pagos.md`.
- Cupo y créditos: `packages/core/src/constants.ts:243-250`; `packages/core/src/state.ts:203-204`, `:661-675`.
- Nodo móvil: `apps/mobile/src/lib/nodo-ligero.ts:1-35`; `apps/mobile/src/lib/nodo/caja.ts:29-45`; `apps/mobile/plugins/sin-push.js:1-8`; `apps/mobile/app.json:102-104`.
- Tiendas: `apps/mobile/eas.json`; `apps/mobile/app.json:5`; `apps/mobile/store/`.
- Descentralización y escala: `packages/core/src/state.ts:326-336`, `:459-482`, `:1152-1155`; `apps/web/worker/hub.ts:1`, `:54`; `docs/escalado.md` §3–§10; `docs/ecosistema.md:84`, `:135`.
- Privacidad: `packages/core/src/keys.ts:65`; `packages/core/src/devices.ts:117-126`; `apps/web/worker/phone.ts:351-359`; `apps/mobile/src/lib/almacen.ts:84-85`; `docs/protocolo-v2.md` §0, §14.
- Pasarela: `apps/bridge/src/config.ts:2`, `:98-125`; `docs/mainnet.md` §6, §10.
- Endurecimiento: `packages/core/src/state.ts:1161-1166`; `packages/core/src/tx.ts:491`; `apps/web/worker/hub.ts:626-650`; `apps/node/src/main.ts:207`; `packages/core/src/constants.ts:202-204`.
- Escritorio: `apps/desktop/READY`; `apps/desktop/src/screens/Wallet.tsx:4`.
