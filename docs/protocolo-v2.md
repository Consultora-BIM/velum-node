# Protocolo Velum v2 — especificación de trabajo

> Fuente de verdad para núcleo, nodo, web y app. Si algo no cuadra con el código, manda este documento (y se corrige aquí primero).
> Cadena: `velum-testnet-2` (v2 rompe compatibilidad con v1; se reinicia la red de pruebas).

## 0. Principios

1. **La red nunca ve contenido ni quién habla con quién.** Solo bytes opacos de tamaño fijo, buzones que rotan cada día y recibos que no dicen quién recibe.
2. **Resistente a ordenadores cuánticos conocidos**: todo cifrado de mensajes es híbrido X25519 + ML-KEM-768 (como Signal PQXDH y Apple PQ3). Firmas ed25519 hoy; ML-DSA queda en la hoja de ruta.
3. **Los nodos guardan fragmentos solo hasta la entrega.** Con el recibo válido se borran; si nadie los recoge, se destruyen a los 7 días.
4. **Los dispositivos guardan los chats** (local-first): SQLite cifrada con SQLCipher; la clave vive en el Keychain (iOS) / Keystore (Android).
5. **Sin dependencias de otras cadenas.** Consenso, moneda, tokens y mercado son propios.

## 1. Identidad, cartera y dispositivos

- **Frase de recuperación**: 24 palabras BIP-39 (`@scure/bip39`, lista en el idioma del dispositivo; por defecto inglés). Semilla = `mnemonicToSeed(frase)` (64 bytes).
- Derivación con HKDF-SHA512 sobre la semilla, `info` distinto por uso:
  - `velum/v2/identity` → clave ed25519 de **identidad** (firma perfiles y listas de dispositivos). Dirección de identidad: `vel` + base58(pub). Se comparte solo con contactos (QR / enlace), nunca va en claro a la red.
  - `velum/v2/wallet/0` → clave ed25519 de **cartera** (firma transacciones). Dirección de cartera: `vel` + base58(pub). Separada de la identidad para que nadie una chats y pagos.
  - `velum/v2/mailbox` → secreto de buzón base (32 B).
- **Clave de dispositivo** (aleatoria, una por dispositivo, nunca sale de él): ed25519 (firma) + X25519 (cifrado) + ML-KEM-768 (cifrado poscuántico). Se guarda en Keychain con `WHEN_UNLOCKED_THIS_DEVICE_ONLY` (no viaja en copias de iCloud).
- **Lista de dispositivos** (`DeviceList`): `{ identity, devices: [{ id, sign, x25519, kem, mailboxSeed, added, name }], ts, sig }` firmada por la identidad. Se envía a los contactos dentro de mensajes cifrados `profile`. Nunca se publica en la cadena.
- **Prellaves rotatorias**: cada dispositivo rota su par X25519+ML-KEM cada 24 h y publica la nueva en `profile`; conserva las viejas 7 días para descifrar rezagados y luego las borra (secreto hacia delante en ventana de 7 días). El triple ratchet completo queda en la hoja de ruta.

## 2. Sobre (mensajes)

- `seal` híbrido por dispositivo destinatario: `eph = X25519 efímera`, `(kemCt, kemSs) = ML-KEM-768.encapsulate(device.kem)`, `key = HKDF-SHA512(ikm = X25519(eph, device.x25519) ‖ kemSs, salt = eph.pub ‖ kemCt, info = "velum/v2/envelope", 32)`, cifrado XChaCha20-Poly1305.
- Formato: `[1 byte versión=2][32 eph][1088 kemCt][24 nonce][ct]`.
- Dentro del sobre va el `Payload` firmado por la **clave de dispositivo** del remitente + `identity` del remitente + firma de la identidad sobre el dispositivo (para que el receptor sepa que ese dispositivo es de esa persona). Remitente sellado: fuera no hay nada.
- **Grupos**: el contenido se cifra una vez con clave aleatoria; la clave se sella (híbrido) para cada dispositivo de cada miembro. Así ni nodos ni observadores saben que es un grupo: cada copia parece un mensaje 1 a 1.
- **Multidispositivo**: el remitente envía una copia a cada dispositivo del destinatario **y a sus propios otros dispositivos** (para que el historial esté igual en todos).
- Campo `rseed` (32 B aleatorios) dentro del payload: semilla de recibos (§4).

## 3. Relleno y fragmentos

- El sobre se rellena a un **cubo fijo**: 2 KB, 8 KB, 32 KB, 128 KB, 512 KB, 2 MB, 8 MB (límite). Así el tamaño no delata si es texto, foto o audio.
- Se trocea en **k = 3 de n = 5** por franja (Reed-Solomon sobre GF(256), o equivalente propio): basta con 3 trozos cualesquiera de cada 5. Tamaño de trozo fijo por cubo: 2 KB→ trozos de 1 KB… (trozo = cubo/3 redondeado a 1 KB, máx. 24 KB; varias franjas si hace falta).
- `Shard`: `{ id, msg, mailbox, stripe, idx, k, n, bucket, data, rh, exp }`. `rh` = SHA-512 (hex) del secreto de recibo de ese trozo. No lleva tamaño real (va dentro, cifrado).
- `id = sha512(msg ‖ stripe ‖ idx)[0..32]`. `msg` aleatorio por envío (no es el id del payload).

## 4. Recibos anónimos — «Prueba de Entrega»

- Secreto por trozo: `s_i = HMAC-SHA512(rseed, shardId)[0..32]`. El remitente pone `rh_i = sha512(s_i)` en cada trozo.
- Solo quien abre el sobre conoce `rseed` → solo el destinatario puede producir `s_i`. Los nodos no pueden fabricar recibos.
- `Receipt v2`: `{ shard, mailbox, rh, secret, carrier, courier, ts }` — **sin firma y sin dirección del receptor**. Válido si `sha512(secret) == rh`.
- La cadena guarda la huella `sha512(secret)` (= `rh`) y cuenta créditos: 1 al `carrier` (nodo que aceptó el trozo) y 1 al `courier` (el que lo entregó); si son el mismo, 2.
- Antitrampas: tope por época y par `(nodo, buzón)`; un mismo `shard` cuenta una vez; recibos fuera de plazo (±15 min) no cuentan.
- El nodo borra el trozo en cuanto ve un recibo válido para él (se propaga por la red: todos lo borran).

## 5. Buzones que rotan

- `mailboxSeed` por dispositivo (derivado de `velum/v2/mailbox` + id de dispositivo). Buzón del día: `mailbox(d) = hex(HMAC-SHA512(mailboxSeed, "day:" + floor(ts/86400000)))[0..40]`.
- El receptor abre los buzones de hoy y de ayer. El emisor usa el del día en curso del destinatario.
- Abrir buzón no se firma con la identidad: se demuestra con `HMAC(mailboxSeed, "open:" + mailbox + ts)`; el nodo guarda `token = sha512(proof)` la primera vez que alguien deposita… → en v2 el nodo acepta abrir un buzón a quien presente `proof` cuyo `sha512` coincida con el `mbAuth` que el emisor incluyó en el trozo (`mbAuth = sha512(HMAC(mailboxSeed, "auth:" + mailbox))`). Así solo el dueño recoge, y el nodo no aprende quién es.

## 6. Vinculación de dispositivos (QR que rota)

1. El dispositivo **A** (ya activo) en *Ajustes › Vincular dispositivo* pide Face ID / código.
2. A crea una **sesión de vínculo** (X25519 + ML-KEM efímeras) y muestra un QR que **cambia cada 2 s**: `velum-link:v2:<sessionId>:<frameNonce>:<pubs…>:<mac>`; cada fotograma lleva un `frameNonce` nuevo con validez de 6 s. Una captura de pantalla caduca enseguida.
3. El dispositivo **B** lee un fotograma, genera sus claves de dispositivo y abre canal cifrado (híbrido) con A a través de la red (buzón efímero derivado de la sesión).
4. A y B muestran el mismo **código de 6 dígitos** (derivado del secreto compartido). El usuario confirma en A.
5. A envía a B, cifrado: la semilla (o las claves de identidad, cartera y buzón), contactos, grupos y el **historial de chats** (por lotes, comprimido). A añade B a su `DeviceList`, la firma y la reparte a los contactos.
6. Máximo de dispositivos: 5. Desde *Ajustes › Dispositivos* se ve la lista y se puede **expulsar** uno (nueva lista sin él + rotación del secreto de buzón).
7. Sin QR no hay vínculo: no existe exportación de sesión por texto. La frase de 24 palabras es solo para recuperación si se pierden todos los dispositivos (y avisa a los contactos con un aviso de «cambio de seguridad»).

## 7. Moneda VEL v2 — oferta limitada

- **Tope absoluto**: 1.000.000.000 VEL acuñables en toda la historia (`MAX_SUPPLY`). El contador `minted` nunca lo supera.
- **Génesis**: 100.000.000 VEL (10 %) a tesorería/ecosistema (en testnet, al grifo). El 90 % restante se gana trabajando.
- **Emisión por época** (30 bloques ≈ 1 min): `R(e) = floor(R0 / 2^floor(e / HALVING))`, con `HALVING = 1.051.200` épocas (≈ 2 años) y `R0 = floor(900 M VEL / (2 × HALVING)) = 428,082191 VEL` (428.082.191 µVEL) → la suma converge a 900 M (con el suelo entero se pierden ~12 VEL; 99 % minado a los 13,4 años; `R` llega a 0 en la mitad 29, ≈ 58 años). Recorte duro: la emisión de una época nunca pasa de `MAX_SUPPLY − minted`. Cuando `R` llega a 0, los nodos viven solo de comisiones.
- **Dificultad**: `dificultad(e) = créditos de entrega totales de la época / R(e)` — cuántas entregas cuesta ganar 1 VEL. Sube sola con el uso y con cada mitad. Se publica en cada cierre de época y la muestra el explorador.
- **Comisiones** (siempre en VEL): pago 0,001 VEL fijo; mercado 0,1 % del VEL negociado (mín. 0,001); crear token 100 VEL. Reparto de toda comisión: 50 % quema, 40 % bolsa de nodos, 10 % tesorería. Con la quema y el tope, la oferta en circulación baja con el uso.
- Mainnet (hoja de ruta): comisión anclada a 0,001 € mediante oráculo de precio del propio mercado.

## 8. Tokens propios en la red

- `token.create { symbol (3–8 A-Z0-9), name, decimals (0–9), maxSupply, initial, mintable }` — cuesta 100 VEL. El creador queda como emisor.
- `token.mint { symbol, to, amount }` (solo emisor, hasta `maxSupply`).
- `transfer` acepta `token?: string` (por defecto VEL). La comisión se paga siempre en VEL.
- `pool.fund { token, amount, epochs }`: un emisor reparte su token entre los nodos durante N épocas, proporcional a su trabajo. Así los nodos pueden ganar en otras monedas además de VEL.
- Génesis testnet: `tEUR` y `tUSD` (6 decimales, emitidos al grifo) para probar el mercado. Son de prueba y no representan dinero.

## 9. Mercado en la cadena (libro de órdenes)

- Pares `VEL/<token>` (p. ej. `VEL/tEUR`). `order.place { pair, side: "buy"|"sell", price (µtoken por VEL), amount (µVEL), ttl? }`: los fondos quedan bloqueados en la orden.
- Casación determinista dentro de la máquina de estados: precio-tiempo; ejecuta al precio del que ya estaba en el libro; restos quedan en el libro.
- `order.cancel { id }` devuelve lo bloqueado. Órdenes caducan por `ttl` (épocas).
- Comisión de mercado 0,1 % del VEL ejecutado, la paga quien llega (taker), en VEL, con el reparto 50/40/10.
- **Compra con euros o dólares (mainnet)**: la app abrirá un proveedor regulado (MiCA/CASP) que entrega una stablecoin a la cartera; desde ahí se compra VEL en el mercado. En testnet se usa `tEUR` del grifo. Velum no custodia dinero.

## 10. Nodos ligeros (móvil como mininodo)

- `register` acepta `kind: "full" | "light"`. Los ligeros **no producen bloques** (no entran en `activeValidators`), sí aceptan y entregan trozos y cobran por recibos con multiplicador ×0,5.
- El nodo ligero vive dentro de la app (`LightNode` de `@velum/core`, memoria + SQLite de la app), solo mientras la app está abierta o en segundo plano permitido. Se activa en *Ajustes › Actuar como nodo* (por defecto: solo con Wi-Fi y cargando).
- La puerta de entrada no le manda bloques completos, solo trozos y recibos (ahorro de datos).

## 11. Solo la app original — atestación de dispositivo

- iOS: **App Attest** (DeviceCheck). Al instalar, la app genera una clave en el Secure Enclave y obtiene de Apple un certificado que prueba: *esta es la app `D58V3B3XNT.com.consultorabim.velum` sin modificar, en un iPhone real*.
- Tx `device.attest { devicePub (hash), keyId, attestation (CBOR b64) }`: **todos los nodos la verifican igual** (cadena de certificados hasta la raíz de Apple App Attestation, `nonce = sha256(authData ‖ sha256(devicePub))`, `rpIdHash = sha256(appId)`, contador 0). Queda en la cadena como «dispositivo auténtico» (solo el hash de su clave, sin identidad).
- Para usar la red (abrir buzón, dejar trozos, cupo gratis, recompensas de mininodo) el cliente firma un reto con su clave de dispositivo atestada. Parámetro `ATTESTATION_MODE`: `off` | `soft` (testnet: se registra pero no bloquea; los simuladores no pueden atestar) | `strict` (mainnet: sin atestación, no hay servicio).
- Android (futuro): Play Integrity necesita verificación en servidores de Google; se estudiará cuando haya app Android.
- Importante: aunque alguien modifique la app, **no puede leer mensajes ajenos**: eso lo garantiza la criptografía, no la atestación. La atestación protege la red contra spam y robo de recompensas.

## 12. Notificaciones

- v2: notificaciones locales mientras la app vive. **Push cifrado de extremo a extremo** (APNs con Notification Service Extension que descifra en el móvil) necesita una clave APNs de Apple y un relé que solo ve bytes opacos: pendiente de clave.

## 13. Nodo y distribución

- Binarios únicos por plataforma con `bun build --compile` (macOS arm64/x64, Linux x64/arm64, Windows x64). No hace falta instalar Bun.
- **Actualización OTA firmada**: `https://velum.consultorabim.com/download/manifest.json` = `{ version, files: { "<plataforma>": { url, sha512 } }, ts, sig }` firmado con la **clave de publicación** ed25519 (la pública va incrustada en el binario). El nodo comprueba cada hora, verifica firma y SHA-512, cambia el binario y se reinicia. `velum reset` borra datos (no la clave) y resincroniza.
- Repos: **`velum-node` público** (núcleo + nodo + instaladores + releases), `velum-web` y `velum-app` privados; usan el núcleo como submódulo de `velum-node`.

## 14. Lo que NO prometemos (honestidad)

- Ningún sistema es «imposible de bloquear»: un país puede bloquear dominios e IPs. Mitigación: varias puertas de entrada, conexión directa entre nodos, lista de nodos en la propia cadena (`endpoint`), y en hoja de ruta transportes camuflados.
- Un observador global que vea todo el tráfico de internet puede intentar correlacionar tiempos. Mitigación en hoja de ruta: rutas de 3 saltos tipo Sphinx y tráfico de cobertura.
- La criptografía poscuántica protege frente a lo conocido hoy; se actualizará si cambian los estándares.

## Cambios de interfaz (cadena)

Implementado en `packages/core` (`constants.ts`, `tx.ts`, `state.ts`, `tokens.ts`, `dex.ts`, `attest.ts`, `wallet.ts`). Las firmas de `buildBlock`, `applyBlock` y `betterHead` no cambian. Lo que deben saber el nodo (`apps/node`) y el indexador (`apps/web/worker/hub.ts`):

- **Recibos**: `Receipt` ahora es `ReceiptV2` (proof.ts). `receiptId(r)` = primeros 48 hex de `r.rh`; `verifyReceipt(r)` comprueba formato + `sha512(secret) == rh` sin estado. `makeReceipt` v1 ya no existe (lanza). `s.seenReceipts` guarda `rh` y `"s:" + shard`.
- **Estado**: `accounts[addr] = { balance, nonce }` se mantiene (`balance` = saldo VEL, espejo). Nuevo `balances[addr][token]` (incluye VEL), `tokens`, `pools`, `devices`, `dex` (`orders`, `books`, `trades` anillo de 500, `pairs` con último precio y volumen por hora), `stats` (`difficulty` = entregas por VEL ×1000, `history` de 1.440 épocas) y `seq`. Los fondos de órdenes y bolsas viven en la cuenta `vel_escrow`.
- **Nodos**: `NodeInfo.kind` (`"full" | "light"`), `credits` (créditos acumulados) y `shardsDelivered` pasa a ser nº entero de recibos. Los ligeros no entran en `activeValidators` y `applyBlock` rechaza bloques suyos; cobran ×0,5.
- **Bloques**: `Block.tokenRewards?` (recompensas de `pool.fund`); `rewards[].shards` son créditos de la época. `receiptRoot` = Merkle de `hashObj(recibo)`.
- **Transacciones**: tipos nuevos `token.create`, `token.mint`, `pool.fund`, `order.place`, `order.cancel`, `device.attest`; `transfer.token?`; `register.kind?`. `applyTx(s, tx, mode?)` es atómica (comprueba todo antes de escribir), así que el mempool puede probarla sobre una copia sin miedo. Ojo en `pools.ts`: la comprobación de saldo `balance < amount + FEE` solo vale para pagos en VEL; usa `applyTx` sobre una copia o `balanceOf(s, addr, token)`.
- **Constantes**: `TIERS[].multBp` y `minUptimePct` son las de consenso (×1,00 / 1,15 / 1,30 / 1,50); `mult` y `minUptime` quedan solo para mostrar. `FEE_SPLIT_BP`, `PRODUCER_SHARE_BP`, `R0` (`EPOCH_EMISSION` = `R0`, obsoleto). `GATEWAYS` (dominio propio + workers.dev de respaldo).
- **Atestación**: `clientDataHash` = `device` de la tx = `sha256(clave pública del dispositivo)`. La validez de los certificados se mira contra la hora del bloque. En `soft` una atestación que falla queda registrada con `verified: false` y `reason`.
- **Mercado**: el taker paga 0,1 % (mín. 0,001 VEL) del VEL ejecutado: el vendedor lo tiene reservado al poner la orden; el comprador lo paga del VEL que recibe. Orden mínima 1 VEL, 50 abiertas por cuenta, caducidad por defecto 10.080 épocas (máx. 43.200), como mucho 100 contrapartes por orden entrante. Poner y cancelar órdenes no paga comisión fija.
- **Lecturas** (`wallet.ts`): `balancesOf`, `bookOf`, `tradesOf`, `ordersOf`, `tokenInfo`, `tokenList`, `supplyInfo` (circulante = acuñado − quemado), `difficulty`, `devicesOf`, `formatAmount`, `parseAmount`.

## Cambios de interfaz (núcleo)

Mitad de mensajería implementada en `packages/core` (`seed.ts`, `pq.ts`, `devices.ts`, `envelope.ts`, `rs.ts`, `shards.ts`, `mailbox.ts`, `link.ts`, `client.ts`, `msgconst.ts`, partes de mensajería de `wire.ts`). Ajustes respecto a §1–6 y lo que deben adoptar nodo, puerta, web y app:

- **Derivación (§1)**: `HKDF-SHA512(ikm = semilla BIP-39, salt = vacío, info, 32)`. `keysFromPhrase(frase)` → `{ identity, wallet, mailboxBase }`. Listas BIP-39: en/es/fr/zh (simplificado); ruso usa la inglesa. `validatePhrase` acepta cualquier lista.
- **DeviceList (§1)**: `{ v: 2, identity, devices: DeviceEntry[], seq, ts, sig }`. `seq` creciente: gana la mayor (una restauración con frase empieza en `seq = ahora`). `DeviceEntry = { id, name, sign, x25519, kem (base64), pk (id de prellave), mailboxSeed, mbPub, added }`. Máx. 5. El certificado de dispositivo va aparte: `DeviceCert = { identity, device, sign, ts, sig }` firmado por la identidad.
- **Sobre (§2)**: un solo formato para 1 a 1, grupos y copias a mis otros dispositivos (fuera no se distinguen): `[1 ver=2][32 eph][1088 kemCt][24 nonce][80 envoltorio][24 nonce2][cuerpo]`. El envoltorio (AEAD con la clave híbrida, AAD = cabecera) lleva `clave del cuerpo ‖ rseed`; el cuerpo (cifrado una vez) lleva `relleno([compresión][JSON { p, cert }])`, deflate si reduce. Así **cada copia tiene su `rseed`** (un destinatario de un grupo no puede fabricar recibos de los trozos de otro): `rseed` va dentro del sobre, no en el `Payload` firmado. `Payload` v2 añade `dev` (dispositivo emisor) y `to` (identidad destino o id de grupo, para sincronizar mis otros dispositivos); lo firma la clave de dispositivo.
- **Prellaves**: el receptor prueba la actual y las retiradas en los últimos 7 días (no hay id de prellave en claro).
- **Relleno y trozos (§3)**: el relleno va dentro del cifrado (longitud real cifrada; a ceros). El sobre mide exactamente un cubo. `Shard = { id, msg, mailbox, stripe, idx, k: 3, n: 5, bucket, data, rh, mbAuth, exp }` (desaparecen `total`, `parity`, `size`). `idx` 0–2 datos, 3–4 paridad (RS sistemático, Cauchy sobre GF(256), polinomio 0x11d). `shardId(msg, stripe, idx) = hex(sha512("msg|stripe|idx")[0..32])` (64 hex). Trozo: 1 KB (2 KB), 3 KB (8 KB), 11 KB (32 KB), 24 KB (resto).
- **Buzones (§5) — cambio de seguridad**: como `mailboxSeed` viaja a los contactos, con el esquema HMAC del borrador cualquier contacto podía abrir mi buzón. Ahora: `mailbox(d)` como en §5; cada dispositivo tiene además un escalar secreto `s` (pública `mbPub = s·G`, en la DeviceList). El emisor pone en cada trozo `mbAuth = mbPub + t·G`, `t = sha512("velum/v2/mbauth|" ‖ mbPub ‖ mailbox) mod L` (distinta cada día, no enlazable sin `mbPub`). Para abrir, el dueño firma con `s + t` una **firma ed25519 estándar** de `velum/v2/open|<mailbox>|<ts>`. Los secretos del buzón salen de `HKDF(mailboxBase, salt = sal aleatoria del dispositivo, "velum/v2/mailbox/<id>")`; expulsar = cambiar la sal.
- **RPC (`wire.ts`)**: `mailbox.open { mailboxes: MailboxOpen[] }` con `MailboxOpen = { mailbox, auth, ts, sig }`; el nodo comprueba `verifyOpenProof(m)` (= `ed25519.verify(sig, openChallenge(mailbox, ts), auth)` y ±15 min) y devuelve/empuja los trozos con `mailbox == m.mailbox && mbAuth == m.auth`. `receipt.submit { receipts: ReceiptV2[] }`; gossip `receipt` también es `ReceiptV2`. `shard.put` recibe `Shard` v2: el nodo debe validar `id == shardId(msg, stripe, idx)`, `bucket ∈ BUCKETS`, `k = 3`, `n = 5`, tamaño de `data` = `shardSizeFor(bucket)`, `rh` 128 hex y `mbAuth` 64 hex. `mailboxChallenge` queda solo como compatibilidad (obsoleto).
- **Recibos (§4)**: el cliente manda al `courier` un `ReceiptV2` por trozo en cuanto abre el sobre (y por los rezagados del mismo mensaje). Descarta trozos cuya `rh` no cuadra con su secreto.
- **Vinculación (§6)**: QR `velum-link:v2:<sid 32 hex>:<nonce 16 hex>:<ts base36>:<X25519 de A base64url>:<mac 32 hex>`; ML-KEM no cabe en un QR que rota: B manda su X25519 + ML-KEM en el `hello` (autenticado con HMAC de una clave sacada del `mac` del fotograma) y A encapsula. Claves de sesión = `HKDF-SHA512(X25519 ‖ ML-KEM, salt = sid ‖ kemCt ‖ apub ‖ bx, "velum/v2/link")`; código de 6 dígitos de esos mismos bytes. Validez del fotograma: 6 s + 20 s de margen de red (A solo acepta fotogramas que mostró). Tras confirmar, A envía secretos (identidad, cartera, buzón, frase opcional, lista) y lotes JSON comprimidos con deflate de 256 KB; **B se añade a la lista, la firma y se la devuelve a A**, que la reparte. Buzones efímeros fijos `linkMailbox(sid, "h"|"g")`.
- **Expulsión**: `removeDevice` firma la lista sin él y rota la sal del buzón propio; los otros dispositivos rotan la suya al recibir una lista propia con menos dispositivos. Límite honesto: un dispositivo expulsado que conoció la frase podría recalcular identidad y cartera; solo pierde los buzones.
- **Cliente**: `new VelumClient({ account?, contacts?, url?: string | string[] (por defecto GATEWAYS), socket? })`. Si una puerta no llega a dar `welcome`, pasa a la siguiente; si funcionaba, reintenta la misma. Eventos: `status`, `message` (`IncomingMessage { payload, device, outgoing, unknown, shards, nodes }`), `incoming`, `progress`, `nodes`, `contact`, `account` (guardar claves), `link`. `VelumAccount` (no `Account`, que es de la cadena).

## Cambios de interfaz (nodo, puerta y sorteo)

Implementado en `packages/core/src/{lottery,lightnode,hubrouter}.ts`, `apps/node` y `apps/web/worker`. Detalle público en `PROTOCOL.md`.

- **Sorteo público de rutas (anti autoengaño)**: `state.epochNodes` guarda la foto de nodos de cada época (baliza = hash del último bloque de la época anterior; completos y ligeros dados de alta antes, con señal de vida en 300 bloques; peso 2/1; se guardan 16 épocas). `assignedNode(foto, trozo, "carrier"|"courier")`. Los trozos y recibos llevan `ep` (época de la foto). La cadena paga cada papel **siempre al sorteado** (si el recibo lo nombra o si está presente): inventarse tráfico deja tu parte igual (prueba en `test/lottery.test.ts`). Límite honesto: el emisor puede probar ids de trozo hasta caer en su nodo; lo frenan el tope por (nodo, buzón) y, en v3, el muestreo y el tope de verosimilitud. `lotteryCandidates` da 3 candidatos (v3 §3); hoy cobra el 0.
- **Cliente**: `refreshEpoch()` pide `chain.epoch`; cada trozo va al carrier sorteado si está en línea (si no, a cualquiera); el recibo se manda al courier sorteado si está en línea (si no, al que lo entregó, y ese papel no cobra nadie).
- **Nodo ligero** (`LightNode`): `new LightNode({ keys, name, payout?, url?, socket?, store?, maxShards? })`, `start()`, `stop()`, `stats()`, `on(fn)`. Saludo con `kind: "light"`, alta `register { kind: "light" }` por RPC directa a un completo, señal de vida cada 5 s, almacén enchufable (`LightStore`; `MemoryLightStore` por defecto).
- **Nodo**: base por cadena (`velum-<CHAIN_ID>.db`), mempool que prueba cada tx con `applyTx` sobre un estado de prueba, cupos antispam, varias puertas con relevo, descubrimiento (cadena + PEX + DNS) si caen todas, RPC nuevas (`chain.epoch`, `token.*`, `market.*`, `account.balances/orders`, `supply`, `difficulty`, `node.get`), reenvío de RPC a otro nodo (`rpc` con `node` a un nodo directo), grifo con 100 tEUR, OTA firmada (`update.ts`), `velum-node update|reset|status`.
- **Puerta/indexador**: ligeros sin bloques (solo trozos, recibos, `head`, `epoch`); tráfico para la web agregado por segundo y nodo (`t: "traffic"`, sin ids ni buzones; `flow` queda obsoleto); recibos del explorador sin buzón ni secreto; REST `/api/supply`, `/api/tokens`, `/api/token/:symbol`, `/api/market/:pair`, `/api/address/:addr` con `balances` y `orders`; `/api/stats` con `supplyInfo`, `difficultyInfo` y `markets`.
