# Velum a escala: de mil a mil millones de nodos

> Vocabulario (protocolo-v3 §14): los nodos descubren VEL abriendo puentes (rutas de mensajes). Tiempos de bloque «2 s» = ritmo nominal de cálculo, no una promesa.
>
> Objetivo: tráfico tipo WhatsApp (≈ 100.000 M mensajes/día) y hasta 10⁹ nodos (casi todos móviles ligeros).
> Este plan dice **qué aguanta el código de hoy, qué rompe primero y qué hay que cambiar** en cada orden de magnitud. Todo con números.

## 1. Hipótesis de carga

| Magnitud | Valor | Cálculo |
|---|---|---|
| Mensajes | 100.000 M/día | dato público de WhatsApp (orden de magnitud) |
| Copias por mensaje | ×2 | multidispositivo + grupos (cada copia parece un 1 a 1) |
| Sobres al día | 2 × 10¹¹ | 2,3 M/s de media; **pico ×3 ≈ 7 M/s** |
| Tamaño en red de un texto | 5 KB | cubo de 2 KB → 5 trozos de 1 KB (3 de 5) |
| Medios | 10 % de los sobres, cubo medio 128 KB → 213 KB en red | 128 KB × 5/3 |
| Datos de trozos al día | 2×10¹¹ × (0,9 × 5 KB + 0,1 × 213 KB) ≈ **5,2 PB/día** | entrada; la salida es igual |
| Ancho de banda total | 5,2 PB × 2 / 86.400 s ≈ **120 GB/s ≈ 1 Tbit/s** | media; pico ≈ 3 Tbit/s |
| Pagos | 1 por usuario y semana con 10⁹ usuarios | ≈ **1.650 tx/s** |
| Reclamaciones de trabajo | 1 por nodo y época (1 h) | 10⁹ nodos → 278.000/s **sin agregar** |

La mensajería **no toca la cadena** (v3 §4): la cadena solo ve pagos, altas, reclamaciones agregadas y pruebas. El reto de la cadena son las reclamaciones y el estado, no los mensajes.

## 2. Ancho de banda por nodo

Reparto uniforme del tráfico de trozos entre nodos que relevan (el sorteo elige por peso):

| Nodos que relevan | Tráfico medio por nodo | Pico (×3) | ¿Viable? |
|---|---|---|---|
| 10³ | 1 Tbit/s / 10³ = **1 Gbit/s** | 3 Gbit/s | No en casa. Solo CPD. Con 10³ nodos la red sirve ~1 % de esa carga. |
| 10⁶ | **1 Mbit/s** | 3 Mbit/s | Sí: fibra doméstica o VPS pequeño |
| 10⁹ | **1 kbit/s** | 3 kbit/s | Sí, incluso en móvil con Wi-Fi |

A esto se suma el **control** (no escala con los mensajes, escala con la red):

| Control | 10³ | 10⁶ | 10⁹ |
|---|---|---|---|
| Bloques (nodo completo), 1 MB / 2 s con binario | 0,5 MB/s | 0,5 MB/s | 0,5 MB/s |
| Cabeceras + firmas del comité (ligero) | 0,4 KB/2 s | 0,4 KB/2 s | 0,4 KB/2 s = **0,7 MB/h** |
| Gossip (D = 6 vecinos, cada mensaje llega ≈ 1,5 veces de media con IHAVE/IWANT) | ×1,5 | ×1,5 | ×1,5 |
| DHT (mantenimiento de tabla: 600 entradas, ping cada 15 min) | — | ≈ 0,1 KB/s | ≈ 0,1 KB/s |

Conclusión: un nodo completo necesita ~5–10 Mbit/s constantes; un ligero, menos de 1 MB/h de control más su parte de trozos.

## 3. Producción de bloques y finalidad: comités por sorteo

Hoy (`activeValidators` en `state.ts`) **todos** los nodos completos activos se turnan. Con 10⁶ eso no funciona: nadie junta 2/3 de un millón de firmas en cada bloque.

**Diseño**:

- Cada época (1 h), la baliza (`hash` del último bloque de la época anterior) elige un **comité de C = 512** nodos completos, con probabilidad ∝ `peso = nivel × fianza (+ delegación)`, sin reemplazo. Es el mismo sorteo ponderado de `lottery.ts`.
- Dentro de la época, el proponente del hueco `k` es el miembro `k mod C` de una permutación de la baliza.
- **Finalidad**: un bloque es final con firmas de **> 2/3 del peso del comité** (estilo Tendermint, [investigacion §3.4](investigacion.md), [57]). Se agrega con BLS (48 B por bloque) o se envía como mapa de bits + firmas ed25519 (512 × 64 B = 32 KB).
- Cambio de comité cada época: un atacante no sabe con 1 h de antelación a quién atacar.

**¿Por qué 512 aunque haya 10⁹ nodos?** La seguridad depende del tamaño del comité y de la fracción honesta, **no** del total. Con un adversario del 25 % del peso:

| C | Media adversaria | P(≥ 1/3 → puede parar la época) | P(≥ 2/3 → puede falsificar) |
|---|---|---|---|
| 128 | 32 | ≈ 1,4 × 10⁻² | ≈ 10⁻²⁸ |
| 512 | 128 | ≈ 5 × 10⁻⁶ (≈ 4 % al año con 8.760 épocas) | < 10⁻¹⁰⁰ |
| 1.024 | 256 | ≈ 3 × 10⁻¹⁰ | < 10⁻²⁰⁰ |

(Aproximación normal de la binomial.) Si un comité se bloquea, tras 30 huecos sin bloque entra el comité de **respaldo** de la misma baliza (sorteo con otra sal). Nunca hay dos cadenas finales.

## 4. Reclamaciones de trabajo: agregación jerárquica

Hoy cada nodo manda `work.claim` (≈ 0,3 KB) y `work.prove` (16 hojas + caminos ≈ 25 KB). Por época:

| Nodos | Reclamaciones/h | Bytes/h en cadena (claim + prove) | Bloques de 1 MB necesarios por hora (hay 1.800) |
|---|---|---|---|
| 10³ | 10³ | 25 MB | 25 → **bien** |
| 10⁶ | 10⁶ | 25 GB | 25.000 → **imposible** |
| 10⁹ | 10⁹ | 25 TB | — |

**Diseño (nodo → agregador de región → cadena)**:

1. Los nodos de cada **célula** (≈ 10⁴ nodos: misma región gruesa + prefijo de dirección) mandan su `(count, root)` firmado al **agregador** de la célula, elegido por sorteo cada época (con 2 suplentes).
2. El agregador construye un árbol de Merkle de reclamaciones y publica en cadena **una** `work.aggregate { epoch, cell, n, total, root }` (≈ 0,3 KB).
3. La baliza muestrea **16 reclamaciones** de cada agregado y, dentro de cada una, **16 hojas** (dos niveles de muestreo). Las pruebas las publica el agregador (≈ 16 × 25 KB = 400 KB por célula y hora).
4. Si una muestra falla, el agregado se anula y la célula reintenta con el suplente; los nodos honestos pueden publicar su reclamación **directamente** con comisión (vía de escape contra un agregador que censura).
5. El reparto en cadena es por célula; dentro de la célula, el agregador publica la lista `(nodo, crédito)` como datos disponibles (blob con raíz en el bloque) y cada nodo cobra con una prueba de Merkle (`work.collect`), o en lote automático.

Coste con agregación:

| Nodos | Células | Bytes/h en cadena |
|---|---|---|
| 10⁶ | 100 | 100 × 400 KB = 40 MB |
| 10⁹ | 10⁵ | 10⁵ × 400 KB = 40 GB → **demasiado**: a 10⁹ se muestrean **64 células** por época en vez de todas (las no muestreadas cobran a cuenta y se auditan con retraso) → 26 MB/h |

## 5. Buzones y descubrimiento: DHT

Hoy la puerta (`apps/web/worker/hub.ts`, un Durable Object) enruta todo. Es una estrella: aguanta 10³ nodos, no 10⁶.

**Diseño**:

- **Kademlia** con `id de nodo = sha256(dirección)` (no se puede elegir sitio sin rehacer la dirección y perder antigüedad: frena el eclipse, estilo S/Kademlia).
- Un buzón `m` vive en los **5 nodos** más cercanos a `sha256(m)` (los 5 trozos ya van a 5 nodos sorteados: se alinea).
- Saltos de búsqueda: `log₂(N) / b` con `b = 5` bits por salto → 10⁶: **4 saltos**; 10⁹: **6 saltos**. Tabla de 20 × 30 = **600 entradas** como mucho.
- La puerta queda como **arranque** y como relé para quien no puede abrir puertos. Lista de puertas + semillas DNS + `endpoint` en cadena (v3 §9).

## 6. Estado: raíz incremental, fotos y poda

Hoy `stateRoot` hace `hashObj` de **todo** el estado en cada bloque. Cuesta O(tamaño del estado):

| Cuentas | Estado (≈ 150 B por cuenta + nodos) | Coste de `stateRoot` por bloque |
|---|---|---|
| 10³ | 0,2 MB | ~1 ms |
| 10⁶ | 200 MB | ~1 s → **no cabe en 2 s** |
| 10⁹ | 200 GB | imposible |

**Diseño**:

- **Árbol de Merkle disperso** (SMT, SHA-256, 256 niveles) por cuenta y por tabla. Actualizar una hoja: 256 hashes ≈ 50 µs. Raíz en O(cambios), no O(estado).
- `epochNodes` deja de guardar la lista entera de nodos: guarda la **raíz de un árbol de pesos acumulados** y el total. El sorteo se resuelve con una prueba de Merkle del intervalo elegido.
- **Fotos** cada 24 épocas: `snapshot export` (ya en el plan de §5 de `mainnet.md`) con raíz comprobada. Un nodo nuevo baja la foto + los bloques posteriores.
- **Poda**: los nodos completos guardan 30 días de bloques; los archivos (explorador, auditores) guardan todo.

## 7. Clientes ligeros

- Siguen **cabeceras** y la firma del comité (≈ 0,4 KB por bloque; 0,7 MB/h).
- El comité de la época siguiente va firmado por el actual (cadena de comités). Un cliente que estuvo apagado un mes baja 720 transiciones de comité (≈ 25 MB) o una foto firmada.
- Saldo, nonce, alias o vUSDT: **prueba de Merkle** contra la raíz de estado de una cabecera final (≈ 256 × 32 B = 8 KB; con compresión de ramas vacías ≈ 1 KB).

## 8. Gossip

- **GossipSub v1.1** [36]: grado `D = 6` (mín. 4, máx. 12), mensajes completos solo en la malla, avisos IHAVE al resto.
- Bloques y tx: solo entre nodos completos (10⁴–10⁵ en el escenario 10⁹).
- Trozos: **no** se difunden: van punto a punto al nodo sorteado (como hoy).
- Puntuación de vecinos: quien manda basura o duplica pierde puntos y se desconecta.
- Topes por vecino: 2 MB/s y 500 mensajes/s.

## 9. Cómo falla y qué hacemos

| Fallo | Síntoma | Defensa |
|---|---|---|
| Comité con > 1/3 del peso caído o malicioso | No hay bloques finales | Comité de respaldo tras 30 huecos; la época siguiente sortea otro |
| Agregador censura a nodos | Nodos sin cobrar | Vía directa con comisión; agregador sin recompensa esa época |
| Agregador miente | Muestreo falla | Agregado nulo; suplente; pierde la fianza que tenga |
| Eclipse en la DHT | Un buzón no aparece | Id = hash de la dirección; 5 réplicas; consultas en paralelo por 3 caminos |
| Caída de todas las puertas | Clientes sin arranque | `endpoint` en cadena, semillas DNS, PEX |
| Partición de red | La parte pequeña no finaliza | Por diseño: mejor parar que bifurcar |
| Crecimiento del estado | Disco y RAM | SMT + poda + alquiler de alias (ya caducan al año) |
| Spam de tx | Mempool lleno | Sello PoW adaptativo (16–26 bits) + comisión desde 1.000 € |
| Sybil | Muchos nodos baratos | Nivel por antigüedad, fianza y delegación: no acelera el descubrimiento de VEL; todos compiten por lo mismo |
| Correlación de tiempos | Metadatos | Rutas de 3 saltos y tráfico de cobertura (hoja de ruta v2 §14) |

## 10. Qué cambiar en el código en cada orden de magnitud

### 10³ nodos (hoy, mainnet día 1)

Funciona con el diseño actual. Ajustes ya en marcha:

- Épocas de 1 h (`EPOCH_BLOCKS = 1.800`) con todas las constantes por época reescaladas (`network.ts`).
- Nodos anónimos, sin nombre por defecto.
- Vigilar `stateRoot` (< 50 ms) y el tamaño de `epochNodes` en el explorador.

### 10⁶ nodos

| Pieza | Archivo | Cambio |
|---|---|---|
| Producción de bloques | `state.ts › activeValidators`, `node.ts` | Comité de 512 por época + firmas de finalidad |
| Raíz de estado | `state.ts › stateRoot` | SMT incremental; dejar de serializar el estado entero |
| Foto del sorteo | `lottery.ts`, `state.ts › epochNodes` | Árbol de pesos acumulados con raíz en el estado |
| Reclamaciones | `claims.ts`, `tx.ts`, `state.ts` | `work.aggregate` + muestreo en dos niveles |
| Red | `apps/web/worker/hub.ts`, `node.ts` | De estrella a malla GossipSub; la puerta solo arranca |
| Buzones | `node.ts`, `lightnode.ts`, `client.ts` | DHT Kademlia; buzón en los 5 más cercanos |
| Formato | `wire.ts`, `tx.ts` | Binario (CBOR canónico) en red; el JSON canónico se queda para firmar |
| Explorador | `hub.ts` | Indexador separado de la puerta; agregados por época |

### 10⁹ nodos

| Pieza | Cambio |
|---|---|
| Reclamaciones | Muestreo de 64 células por época; cobro con prueba (`work.collect`) |
| Pagos (1.650 tx/s) | Bloques binarios de 1 MB/2 s bastan; si no, ejecución en 4–16 fragmentos de estado por prefijo de dirección |
| Disponibilidad de datos | Listas de crédito por célula como blobs con muestreo de disponibilidad (estilo LazyLedger [64]) |
| Clientes ligeros | Solo cabeceras + pruebas; fotos firmadas por el comité |
| Atestación | App Attest / Play Integrity como requisito para cobrar como ligero (frena granjas de emuladores) |

Regla: cada cambio entra como **versión de protocolo con altura de activación** (ver `mainnet.md §5`). Nunca se reinicia la cadena para escalar.
