# Protocolo Velum v3 — cambios sobre v2

> Se aplica encima de `protocolo-v2.md`. Donde choquen, manda este documento. Cadena: `velum-testnet-3`.
> Objetivo: escala tipo WhatsApp (≈100.000 M mensajes/día), economía que no se agota en un año, sin quema de VEL, precio real en EUR/USD/USDT y resistencia a bloqueos.

## 1. Emisión: como Bitcoin, ligada al tiempo, no a la potencia

- La emisión por época **no depende de cuántos nodos haya**. Más ordenadores no minan más rápido: se reparten la misma bolsa. Es la «dificultad» que pide el sistema: cuantos más nodos y más tráfico, más trabajo cuesta cada VEL.
- Se mantiene el tope de 1.000 M VEL, 900 M por trabajo, mitad cada ~2 años, 99 % a los ~13 años (v2 §7).
- `dificultad(e) = créditos de trabajo verificados en la época / VEL emitidos` — se publica cada época; el explorador muestra su historia.
- Los bloques se emiten aunque no haya mensajes: producir y validar bloques cobra su parte (15 %).

## 2. Niveles por antigüedad continua (Sybil y centros de datos)

| Nivel | Multiplicador | Requisito |
|---|---|---|
| Nuevo | ×0,50 | al registrarse |
| Activo | ×0,65 | ≥ 1 mes en servicio continuo y ≥ 90 % de presencia |
| Veterano | ×0,85 | ≥ 3 meses continuos y ≥ 95 % |
| Pilar | ×1,00 | ≥ `M(t)` meses continuos y ≥ 98 % |

- `M(t) = min(12, 6 + floor(edadRedMeses / 4))`: 6 meses al nacer la red, sube 1 mes cada 4 meses de vida de la red, hasta 12. Determinista (se calcula con la época).
- **Servicio continuo**: racha de épocas con presencia; una ausencia de más de 48 h seguidas reinicia la racha. Mantenimientos cortos no.
- Los multiplicadores **reparten la misma bolsa**: nunca se paga más de lo que hay.
- Un centro de datos que levanta 1.000 nodos nuevos cobra ×0,5 en todos durante meses y debe mantenerlos encendidos: no acelera la emisión, solo compite por la misma bolsa.
- **Fianza opcional** (`node.bond`): VEL bloqueados que suben el peso en el sorteo hasta ×2 (`1 + min(fianza, 10.000 VEL)/10.000`). Desbloqueo con espera de 14 días. Si un nodo falla las comprobaciones (§4), pierde la recompensa de la época.

## 3. Rutas por sorteo + cercanía (tipo CDN)

- Para cada trozo, el sorteo público (v2 + `lottery.ts`) elige **3 candidatos** con peso = nivel × fianza. El cliente mide el ping y usa el de **menor latencia** de los 3. Solo cobra quien de verdad lo llevó, y siempre dentro de los 3 elegidos por sorteo.
- Así se prioriza lo cercano (usuarios en EE. UU. → nodos en EE. UU.) sin dejar que nadie elija quién cobra.
- Los nodos declaran región gruesa (continente) en `register`; el cliente puede filtrar candidatos por región antes de medir ping, sin efecto en el consenso.

## 4. Trabajo a escala: reclamaciones agregadas con muestreo

- Los recibos ya no entran uno a uno en los bloques (no escala a miles de millones).
- Cada nodo acumula sus recibos de la época en un **árbol de Merkle (SHA-512)** y publica `work.claim { epoch, count, root }`.
- La baliza de la época siguiente elige **16 hojas al azar** de cada reclamación; el nodo responde con `work.prove { epoch, leaves[], paths[] }` (recibos con su secreto y ruta de Merkle). Si no responde en 2 épocas o alguna hoja falla → reclamación nula.
- Tope de verosimilitud: lo reclamado no puede superar `esperado × 1,5`, donde `esperado` = peso del nodo en el sorteo × total reclamado por la red.
- En la cadena solo viajan ≈ 1 KB por nodo y época. Épocas de 1 min en testnet; **1 h en mainnet**.

## 5. Comisiones: sin quema y casi nulas

- **No se destruye VEL nunca.** Toda comisión va: **80 % a la bolsa de nodos** y **20 % a la Reserva de la Red** (`vel_reserve`, sin clave privada).
- **Pagos de menos de 1.000 €** (al precio de la propia red): **comisión 0**. A cambio, el envío lleva una **prueba de trabajo** pequeña (SHA-512 con ceros iniciales, ~50 ms en un móvil; sube sola si la cola de pagos se llena). Así no hay spam gratis.
- **Pagos de 1.000 € o más**: comisión del **0,01 %** (1 punto básico). Ej.: 5.000 € → 0,50 €.
- Mercado: misma regla sobre el importe negociado.
- Crear token: 100 VEL → Reserva (antispam).
- **Reserva de la Red**: cada época devuelve el 0,1 % de su saldo a la bolsa de nodos. Así estabiliza ingresos cuando baja la emisión. Nadie puede sacar de ella fuera de esta regla: no hay clave ni administrador.

## 6. Precio en EUR, USD y USDT, calculado por la propia red

- Pares en el mercado de la cadena: `VEL/tEUR`, `VEL/tUSD`, `VEL/tUSDT` (testnet; en mainnet, monedas estables reales puenteadas).
- **Oráculo propio**: precio = **media ponderada por tiempo (TWAP) de la última hora** de operaciones; si un par mueve menos de 1.000 VEL en la hora, se usa la mediana de los otros pares convertida; si no hay ninguno, «sin precio» (y no hay comisión).
- Se guarda en el estado cada época (`state.oracle`), lo leen la app, la web y la regla de 1.000 €.
- Mover el precio un momento no cambia la TWAP: manipularla exige mantener el precio falso durante una hora y pagar la diferencia a los demás.
- La app y la web muestran siempre: importe en VEL, su valor en EUR/USD/USDT, comisión exacta (normalmente 0) y **lo que recibe el destinatario**.

## 7. Identidad: alias, enlaces e invitaciones

- **Alias único** (`name.register { name, card }`): 3–24 caracteres `[a-z0-9_.]`, uno por cartera, se renueva cada año, cuesta una prueba de trabajo grande (~5 s) para frenar el acaparamiento. `card` = clave pública de identidad + prellave de primer contacto (X25519 + ML-KEM) + buzón de solicitudes. Público y seudónimo: no dice quién eres.
- **Enlace de contacto**: `https://<dominio>/@alias` y `https://<dominio>/c/<tarjeta>` (la tarjeta va en el enlace; funciona sin alias). Universal Links en iOS / App Links en Android.
- **Primer contacto**: mensaje `contact.request` sellado a la prellave de la tarjeta → el receptor acepta → se intercambian listas de dispositivos.
- **Escribir a alguien que aún no tiene la app**: el emisor crea una **invitación de un solo uso** con claves nuevas, cifra los mensajes pendientes para ella y los deja en un buzón derivado de la invitación durante **24 h**. Se manda el enlace por SMS, correo u otra app. Si la persona instala Velum y abre el enlace en 24 h, recibe los mensajes; si no, se destruyen.
- **Número de teléfono**: no se publica nunca (los hashes de teléfonos se pueden adivinar). Se puede invitar a un contacto de la agenda por enlace. El registro por teléfono verificado (SMS) queda como **decisión pendiente**: necesita un proveedor de SMS de pago y un punto central.

## 8. Vinculación inversa (escritorio y web)

- Además del modo v2 (el dispositivo activo muestra el QR), el dispositivo **nuevo** puede mostrar el QR que rota y el activo lo escanea (como WhatsApp Web). Lo usa la app de escritorio, que no suele tener cámara.

## 9. Resistencia a bloqueos

- Varias puertas de entrada en dominios distintos (lista `GATEWAYS`), con **ECH** activado en Cloudflare (oculta el nombre del sitio en la conexión).
- Los nodos publican su `endpoint` en la cadena; los clientes y nodos guardan la lista y se conectan **directamente entre ellos** si caen las puertas (como los nodos de Bitcoin).
- **Intercambio de vecinos** (PEX) entre nodos y semillas DNS (registros TXT con nodos en varios dominios).
- Hoja de ruta: transportes camuflados (WebTunnel/obfs-like sobre HTTPS), Tor/I2P y malla Bluetooth sin internet.
- Honestidad: ningún sistema es imposible de bloquear. Un país puede bloquear Cloudflare entero; la red sigue viva mientras haya nodos alcanzables entre sí.

## 10. Versiones y actualizaciones

- Manifiesto firmado (ed25519, clave de publicación) con `minNodeVersion` y `minAppVersion`. Nodos y apps por debajo del mínimo se actualizan solos (OTA) antes de seguir.
- App: actualizaciones OTA del código JS firmadas (EAS Update con firma de código) y obligatorias; cambios nativos por TestFlight/App Store.
- Nodo: binario único por plataforma, actualización OTA firmada (v2 §13), **sin archivos `.js` sueltos**.

## 11. Implementaciones en otros lenguajes

- `PROTOCOL.md` público con todo lo necesario: JSON canónico, hashes, firmas, formato de trozos, máquina de estados, reglas de consenso.
- **Vectores de prueba** (`spec/vectors/*.json`): claves desde frase, sobres, trozos, recibos, transacciones, bloques y estados esperados. Toda implementación compatible debe reproducirlos byte a byte.

## 12. Condiciones de uso

- La app pide aceptar las condiciones antes de crear la identidad.
- Puntos clave: Velum no puede ver ni moderar contenido (cifrado de extremo a extremo por diseño); cada usuario responde de lo que envía; en testnet VEL y los tokens de prueba no tienen valor; Velum no custodia fondos ni es un servicio financiero; las actualizaciones de seguridad pueden instalarse automáticamente.

## Notas de implementación (cadena v3)

> Lo que hace `packages/core` en `velum-testnet-3`. Todo entero, sin reloj ni azar, recorridos en orden de clave. Si algo de aquí choca con §1–12, manda esto (es lo que replican nodos y explorador).

### A. Tiempos

- Época = 30 bloques (≈ 1 min). Los bloques `30e+1 … 30e+30` acumulan en la época `e`; el bloque `30(e+1)` aplica sus tx y **después** cierra la época `e` y toma la foto `e+1` (baliza = hash del bloque `30(e+1)−1`).
- Equivalencias testnet (`constants.ts`): `EPOCHS_PER_DAY = 1.440`, `MONTH_EPOCHS = 43.200` (30 días), `STREAK_GAP_EPOCHS = 2.880` (48 h), `BOND_UNBOND_EPOCHS = 20.160` (14 días), `NAME_TERM_EPOCHS = 525.600` (365 días). En mainnet (épocas de 1 h) se reescalan con la época.

### B. Niveles y fianza (§2)

- Cada nodo guarda `streakStart` (época en que empezó la racha) y `streakPresent` (épocas con señal de vida dentro de la racha). Cuenta como presencia la señal de vida firmada y producir un bloque.
- Al marcar presencia en la época `e`: si `e − lastPresentEpoch − 1 > STREAK_GAP_EPOCHS` la racha se reinicia (`streakStart = e`, `streakPresent = 0`); luego `streakPresent++`. Al evaluar, si desde la última presencia han pasado más de `STREAK_GAP_EPOCHS`, la racha vale 0 (nivel Nuevo).
- `racha = e − streakStart + 1`, `presencia% = streakPresent × 100 / racha`, `meses = floor(racha / MONTH_EPOCHS)`. Pilar exige `M(e) = min(12, 6 + floor(floor(e / MONTH_EPOCHS) / 4))` meses.
- Multiplicadores (pb): nuevo 5.000 · activo 6.500 · veterano 8.500 · pilar 10.000.
- `node.bond { amount }` / `node.unbond { amount }` (solo nodos dados de alta, sin comisión): la fianza vive en `vel_escrow`; al desbloquear pasa a `unbonding` y vuelve a la cartera del nodo al cerrar la época `actual + 20.160`. La fianza en espera no da peso.
- **Peso en el sorteo** (entero, va en la foto): `w = pesoTipo × floor(nivelPb × fianzaPb / 1.000.000)`, con `pesoTipo` 2 completo / 1 ligero y `fianzaPb = 10.000 + floor(min(fianza, 10.000 VEL) × 10.000 / 10.000 VEL)`. Ej.: completo nuevo sin fianza = 100; pilar con 10.000 VEL = 400.
- **Recompensa** = bolsa × créditos verificados / Σ créditos. El nivel y la fianza entran **una sola vez**, por el sorteo (más rutas) y por el tope de verosimilitud. Así «un centro de datos con 1.000 nodos nuevos cobra ×0,5» se cumple literalmente.

### C. Reclamaciones de trabajo (§4) — algoritmo del nodo

Reglas de cadena:

- `work.claim { epoch: E, count, root }`: firmada por el nodo; solo en bloques de la época `E+1`; una por nodo y época; `1 ≤ count ≤ 2³²`; `root` = 128 hex.
- Muestras: al cerrar `E+2` (foto `E+3`), baliza `B` = la de la foto `E+3` (hash del bloque `30(E+3)−1`, ≥ 29 bloques después de la última reclamación posible). Índice `k` (0…15): `x_k = u64(sha512("velum/v3/sample|" + B + "|" + nodo + "|" + E + "|" + k)) mod count`, saltando repetidos y probando `k` siguientes hasta tener `min(16, count)` distintos. `claimSamples(B, nodo, E, count)` en `claims.ts`.
- `work.prove { epoch: E, leaves[], paths[] }`: en bloques de `E+3` o `E+4`; posiciones = `proofIndices(samples, count)`: por cada muestra `i`, la hoja `i` y su vecina `i+1` (si existe). Exige `hash(i) < hash(i+1)`: las hojas van ordenadas por hash y sin repetir, así que duplicar hojas para inflar la cuenta se delata al muestrear. Una sola prueba por reclamación: si alguna hoja falla, la reclamación queda **nula** (la tx entra igual, para que conste). Sin prueba al cerrar `E+4` → nula.
- Hoja: `{ r: ReceiptV2, role: "carrier"|"courier" }`, hash `sha512(JSON canónico)` (hex 128). Válida si: `sha512(r.secret) == r.rh`; `r[role] == nodo`; `E − 10 ≤ r.ep ≤ E`; el nodo está entre `lotteryCandidates(foto r.ep, r.shard, role)` (3); y `r.rh|role` no se probó antes (memoria de recibos).
- Árbol: hojas ordenadas por hash (ascendente, sin repetir); SHA-512 binario sobre los bytes de los hashes; nivel impar → el último se empareja consigo mismo. `root = sha512("velum/v3/root|" + count + "|" + cima)` (la cuenta va atada a la raíz). Camino = hermanos de hoja a cima (hex); el bit `i` del índice dice si el hermano va a la izquierda (1) o a la derecha (0). Longitud exacta = profundidad del árbol de `count` hojas.
- Liquidación al cerrar `E+4`: crédito `c_i = min(count_i, tope_i)` de las reclamaciones probadas; `tope_i = floor(1,5 × w_i × Σ_{j≠i} count_j / (W − w_i))`, con `w` de la foto `E` y `W` = suma de pesos de las reclamaciones **probadas** (sin tope si nadie más probó). Es «esperado × 1,5» medido contra el resto de la red, así que inflar la propia reclamación no sube el tope. La bolsa de trabajo de `E` se reparte ∝ `c_i`; si Σc = 0 vuelve a la bolsa de la época siguiente.

Algoritmo del nodo (nodo completo y ligero):

1. Por cada recibo válido que reciba (`receipt.submit` o gossip) con foto `r.ep` conocida, y por cada papel `role ∈ {carrier, courier}`: si `r[role] == yo` y `yo ∈ lotteryCandidates(foto r.ep, r.shard, role)`, añade la hoja `{ r, role }` al lote de la época **de cabeza actual** (`floor((altura−1)/30)`), sin repetir `rh|role`. No metas hojas con `r.ep < E − 10` (no se podrían probar).
2. Cuando la cabeza entra en `E+1` (altura `> 30(E+1)`), cierra el lote `E`: `tree = buildWorkTree(hojas)` (`claims.ts`; ordena y quita repetidas: usa `tree.leaves[i]`, no tu lista original), envía `makeWorkClaim(...)` con `{ epoch: E, count: tree.count, root: tree.root }`. Guarda el árbol hasta liquidar (`E+5`).
3. Cuando la cabeza llega a la foto `E+3` (altura `> 30(E+3)`), calcula `idx = proofIndices(claimSamples(foto(E+3).beacon, yo, E, count), count)` (o `samplesFor(estado, claim)`) y envía `makeWorkProve(...)` con `leaves = idx.map(i ⇒ tree.leaves[i])`, `paths = idx.map(i ⇒ workPath(tree, i))`. Reintenta en `E+4` si no entró.
4. Al pasar `E+5`, borra el lote. Los recibos ya no viajan en los bloques (`Block.receipts` siempre vacío; el gossip de recibos sigue sirviendo para borrar trozos).
5. El cliente puede elegir el candidato de menor latencia de los 3: todos pueden cobrar (pendiente en `client.ts › pushShards/ack`).

### D. Reparto por época

Al cerrar la época `X`: `bolsa = comisiones(X) + 0,1 % de vel_reserve + R(X)` (R solo si algún nodo produjo bloques). 15 % a quien produjo bloques (∝ bloques), el resto queda en `workPots[X]` hasta liquidar `X` al cerrar `X+4`. Dificultad publicada = créditos verificados / R, ×1000, al liquidar.

Invariante: `Σ saldos VEL (incluye vel_escrow y vel_reserve) + epoch.pool + Σ workPots == supply.minted` (`velLedgerGap = 0`). `supply.burned` queda siempre a 0.

### E. Comisiones y prueba de trabajo (§5)

- `fee` es un campo libre (≥ 0) de `transfer`, `token.mint`, `pool.fund`. Mínimo exigido: `transfer` → si su valor en EUR (oráculo) ≥ 1.000 € (`1.000.000.000` µEUR), `max(1, floor(VEL equivalentes × 1 / 10.000))`; si no, 0. Sin precio → 0. `token.create` → exactamente 100 VEL, todo a `vel_reserve`. Cualquier comisión cobrada se reparte 80 % bolsa / 20 % reserva.
- Mercado: el taker paga 1 pb del VEL ejecutado en su tx si ese VEL vale ≥ 1.000 € (si no, 0).
- **Sello PoW** (`pow.ts`): `body = sha512(JSON canónico de la tx sin sig ni pow)`; `h = sha512(body ‖ u64be(pow))`; bits = ceros iniciales de `h`. Obligatorio si `fee = 0` en `transfer`/`token.mint`/`pool.fund`, y siempre en `order.place`, `order.cancel`, `name.*`. Exigido: `min(pow.bits, pow.prev)` (alias: +4 bits, ≈ 1 M hashes).
- Dificultad: `16 ≤ bits ≤ 26`. Al cerrar época: si las tx con sello de la época > 3.000 → +1; si < 750 → −1 (sin bajar de 16).

### F. Oráculo (§6)

- Pares `VEL/tEUR`, `VEL/tUSD`, `VEL/tUSDT` (tUSDT nuevo en génesis). En cada bloque, antes de las tx, cada par con último precio suma ese precio (tope 10¹² µ/VEL) al acumulado de la época; las operaciones suman volumen VEL. Se guardan 60 épocas.
- `TWAP = Σ precios / Σ bloques con precio` de la ventana; válido si el volumen de la ventana ≥ 1.000 VEL. Una operación cambia el precio solo desde el bloque siguiente: una operación suelta pesa 1/1.800.
- Reserva cruzada: si un par no vale, se usa la mediana de los otros convertidos (USD↔USDT 1:1; EUR↔USD con el último cambio implícito visto, semilla 0,92 €/$). Sin ninguno: `null` (sin comisión).
- `state.oracle = { epoch, eur, usd, usdt, src, fx, … }` (µunidad por VEL).

### G. Alias (§7)

- `name.register { name, card }`, `name.renew { name }`, `name.release { name }`. `[a-z0-9_.]{3,24}`, uno por cartera, 1 año (renovar suma 1 año, máx. 2 por delante), libres al caducar. `card` = tarjeta de contacto firmada por la identidad (`names.ts`). Ojo: el alias une públicamente cartera e identidad; usa una cartera aparte si no quieres eso.

## 13. Teléfono verificado (Twilio Verify) — directorio privado opcional

Decisión del 01/11: el descubrimiento de contactos por número usa **Twilio Verify** (SMS con código). Es opcional: sin teléfono, Velum funciona igual (alias, enlaces, invitaciones).

**Por qué no va en la cadena:** los números de teléfono se pueden adivinar (unos 10.000 millones posibles). Publicar su hash permitiría reconstruir quién es quién. Por eso el directorio vive fuera de la cadena, en la puerta de entrada, protegido así:

1. **Alta**: la app pide `POST /api/phone/start { phone }` (E.164). El Worker llama a Twilio Verify y envía el SMS. Luego `POST /api/phone/check { phone, code, card, devicePub, sig }`; si Twilio confirma, el Worker guarda `HMAC-SHA256(PEPPER, phone) → card` (la tarjeta de contacto de v3 §7). `PEPPER` es un secreto del Worker: con la base filtrada no se pueden probar números sin él. Nunca se guarda el número en claro.
2. **Búsqueda**: `POST /api/phone/lookup { hashes[] }` con los `HMAC` calculados… — no: la app no conoce `PEPPER`. La app envía los números normalizados de su agenda **por TLS** en lotes; el Worker los convierte, responde solo con las coincidencias (tarjetas) y **no guarda** la consulta. Límite: 500 números por día y dispositivo, 50 por petición, solo apps con atestación (App Attest) en modo estricto; en modo suave, límite por IP más bajo.
3. **Baja**: `POST /api/phone/remove` firmado con la clave de identidad de la tarjeta.
4. **Rotación**: el usuario puede cambiar de número (nuevo SMS) y el anterior se borra.
5. **Lo que ve Velum**: en el alta, el número (para enviar el SMS, lo ve también Twilio). En las búsquedas, los números consultados durante la petición, sin guardarlos. Hoja de ruta: búsqueda con intersección privada de conjuntos (PSI) o en enclave seguro para que ni la puerta los vea.
6. **Secretos del Worker**: `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_VERIFY_SERVICE_SID`, `PHONE_PEPPER` (32 bytes aleatorios). Almacén: Durable Object propio `PhoneDirectory` (SQLite), separado del Hub.
7. **Coste**: Twilio cobra por verificación (≈0,05 € según país). Solo en el alta y en cambios de número.

### 13.1 API para la app (implementado en `apps/web/worker/phone.ts`)

Todas las rutas son `POST` con JSON (máx. 16 KB) y responden JSON con `Cache-Control: no-store`. La app nativa no manda `Origin`; en el navegador solo se aceptan `velumprotocol.org`, `velum.consultorabim.com` y local (otro origen → `403 origen_no_permitido`).

**Firmas.** `check`, `lookup` y `remove` llevan el cuerpo entero firmado: `sig = sign(clave, canonical(cuerpo sin sig))`, es decir, `signObj(secret, cuerpo)` de `@velum/core`. Cualquier campo añadido después de firmar invalida la firma. `ts` en milisegundos, con margen de ±5 min. `devicePub` es una dirección Velum (`isAddress`) de una clave del dispositivo.

**Teléfonos.** E.164 (`+34612345678`). También se aceptan espacios, guiones, puntos, paréntesis y `00`; sin `+`, hace falta `cc` (código de país sin `+`, p. ej. `"34"`), y se quita el 0 troncal (salvo Italia, San Marino y Vaticano).

```jsonc
// POST /api/phone/start            → envía el SMS (Twilio Verify)
{ "phone": "+34612345678", "cc": "34"?, "devicePub": "<dirección>"?, "locale": "es"? }
// 200
{ "ok": true, "status": "pending" }

// POST /api/phone/check            → firmado por card.identity
{ "t": "phone.check", "phone": "+34612345678", "cc": "34"?, "code": "123456",
  "card": "<encodeCard(tarjeta)>", "devicePub": "<dirección>", "ts": 1761990000000, "sig": "<hex>" }
// 200 (replaced = había otro número de esta identidad y se ha borrado)
{ "ok": true, "verified": true, "replaced": false }

// POST /api/phone/lookup           → firmado por devicePub; máx. 50 números por petición
{ "t": "phone.lookup", "phones": ["+34612345678", "612 34 56 78", …], "cc": "34"?,
  "devicePub": "<dirección>", "ts": 1761990000000, "sig": "<hex>" }
// 200 — solo coincidencias; los números desconocidos o no válidos no aparecen
{ "matches": [{ "phone": "+34612345678", "card": "<encodeCard(tarjeta)>" }] }

// POST /api/phone/remove           → firmado por identity
{ "t": "phone.remove", "identity": "<dirección>", "ts": 1761990000000, "sig": "<hex>" }
// 200
{ "ok": true, "removed": true }
```

La tarjeta (`card`) puede ir como texto (`encodeCard`) o como objeto `ContactCard`; se guarda y se devuelve siempre como texto (léela con `decodeCard`).

**Errores** — siempre `{ "error": "<código>", …extra }`:

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `json_no_valido`, `tipo_no_valido`, `telefono_no_valido`, `codigo_no_valido`, `dispositivo_no_valido`, `identidad_no_valida`, `tarjeta_no_valida`, `sin_numeros` | Datos mal formados |
| 400 | `hora_desfasada` | `ts` fuera de ±5 min |
| 400 | `codigo_incorrecto` | Twilio no aprueba el código |
| 400 | `demasiados_numeros` (`max: 50`) | Más de 50 números en un `lookup` |
| 401 | `firma_no_valida` | La firma no es de quien debe |
| 403 | `origen_no_permitido` | Navegador desde otro origen |
| 410 | `codigo_caducado` | La verificación ya no existe en Twilio (pide otro SMS) |
| 413 | `peticion_demasiado_grande` | Cuerpo de más de 16 KB |
| 429 | `demasiadas_peticiones` / `demasiados_intentos` / `limite_diario` (`retryAfter` en s, y cabecera `Retry-After`) | Límites |
| 502 | `proveedor_no_disponible` | Twilio falla |
| 503 | `verificacion_no_configurada` | Falta algún secreto de Twilio o `PHONE_PEPPER` |

**Límites** (en el DO, con claves HMAC; ni las IP se guardan en claro):

| Ruta | Límite |
|---|---|
| `start` | 10/h por IP · 3 cada 10 min y 10/día por número · 5/h por `devicePub` (si viene) |
| `check` | 30/h por IP · 10/h por número (y los 5 intentos de Twilio) |
| `lookup` | 50 por petición · 500 números/día por `devicePub` (`limite_diario`) · por IP 2.000/día si el dispositivo tiene número verificado, 300/día si no (modo suave) |
| `remove` | 30/h por IP |

En `lookup` cuenta cada número enviado, válido o no. Una identidad tiene un solo número: un `check` nuevo borra el anterior; si el número era de otra identidad, gana quien acaba de verificarlo. App Attest (modo estricto) queda pendiente.

**Pruebas.** `bunx wrangler dev --var PHONE_TWILIO_MOCK:1 --var PHONE_PEPPER:<hex>` y `bun scripts/phone-smoke.ts http://127.0.0.1:8787`. El simulador acepta solo el código `000000` y solo responde a peticiones de la propia máquina (`CF-Connecting-IP` de bucle local): en Cloudflare nunca se activa. Secretos de producción: `bash scripts/set-phone-secrets.sh` (no lo lanza nadie más que quien despliega).

## 14. Lenguaje y modelo: los nodos descubren VEL abriendo puentes

- **La red no «reparte» VEL.** Los nodos **descubren** VEL, como en Bitcoin se descubren bloques. Lo que se descubre en cada época es la emisión de esa época (tope 900 M, mitades cada ~2 años).
- Un **puente** es una ruta que un nodo abre y mantiene viva entre emisores y buzones: acepta trozos (carrier) y los entrega (courier). Los mensajes viajan por puentes.
- **Descubrir VEL** = demostrar trabajo útil por esos puentes (reclamaciones con muestreo, §4) y producir/validar bloques. La dificultad (§1) dice cuántas entregas por puentes cuesta descubrir 1 VEL; sube sola con más nodos y con cada mitad.
- Hay bloques y descubrimiento aunque no haya mensajes: producir y validar bloques también descubre su parte.
- **Nunca se destruye VEL**: ninguna regla, comisión ni operación lo quema. Las comisiones (casi siempre 0) se guardan: 80 % para quienes abren puentes y 20 % en la Reserva de la Red (sin clave).
- Textos de web, app, docs y deck: usar «descubrir», «puentes», «Reserva de la Red»; nunca «quema», «se destruye», «se reparte una bolsa». Nunca prometer un ritmo fijo de bloques («cada 2 segundos»): mostrar el ritmo medido.
