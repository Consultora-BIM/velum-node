# Velum — Dossier de investigación y diseño del protocolo

> **Proyecto:** Velum, de Consultora BIM.
> **Qué es:** un mensajero anónimo y cifrado de extremo a extremo. Su transporte y sus incentivos viven en una red propia con moneda propia, **VEL**.
> **Fecha:** 1 de noviembre de 2026. **Estado:** documento de trabajo para el MVP en testnet.
> **Cómo leerlo:** el resumen ejecutivo basta para decidir. Las secciones 3 a 5 justifican cada decisión. Los números entre corchetes, como [12], remiten a la bibliografía del final (sección 11).

---

## Índice

1. [Resumen ejecutivo](#1-resumen-ejecutivo)
2. [Glosario mínimo](#2-glosario-mínimo)
3. [Estado del arte](#3-estado-del-arte)
4. [Tabla comparativa](#4-tabla-comparativa)
5. [El protocolo Velum](#5-el-protocolo-velum)
6. [Economía y simulación a 5 años](#6-economía-y-simulación-a-5-años)
7. [Recomendaciones para el MVP](#7-recomendaciones-para-el-mvp)
8. [Riesgos y regulación](#8-riesgos-y-regulación)
9. [Hoja de ruta: de testnet a mainnet](#9-hoja-de-ruta-de-testnet-a-mainnet)
10. [Preguntas abiertas](#10-preguntas-abiertas)
11. [Bibliografía](#11-bibliografía)

---

## 1. Resumen ejecutivo

**La idea es viable si separamos bien tres capas.** Los mensajes nunca tocan la cadena. La cadena solo guarda pagos, el registro de nodos y **pruebas resumidas** del trabajo de los nodos. Así la cadena aguanta millones de usuarios con muy poca carga.

**Lo que copiamos de los mejores:**

- Cifrado de **Signal**: acuerdo de claves PQXDH y Double Ratchet [1][2][4]. Grupos con **MLS**, el estándar del IETF [8][9]. Resistencia cuántica con **ML-KEM** [10].
- Rutas en **cebolla de 3 saltos** y **buzones replicados**, como **Session** [16][17].
- Paquetes con formato **Sphinx** y tráfico de cobertura opcional, como **Nym/Loopix** [19][20][21].
- Antispam sin identificar a nadie con **RLN**, como **Waku/Status** [27][28].
- Pruebas de trabajo resumidas en árboles de Merkle con **muestreo aleatorio**, como **Pocket Network** [39][40].
- Pruebas de entrega que no se pueden falsificar, como el **Proof of Relay de HOPR** [37].
- Créditos de uso que se compran **quemando** moneda, como los Data Credits de **Helium** [43][44].
- Comisión fija diminuta y quemada, como **XRP Ledger**, **Algorand** y **Solana** [73][76][77].

**Lo que aportamos nosotros:**

1. **Prueba de Trabajo Entregado (PTE)** — en inglés, *Proof of Delivered Work*. Cada fragmento entregado deja un recibo anónimo que solo el destinatario puede generar. El nodo agrupa recibos cada hora y publica una raíz de Merkle. La cadena comprueba 8 recibos al azar. Se paga por trabajo útil, no por cálculo inútil.
2. **Rutas neutrales.** La ruta de cada fragmento sale de un sorteo público, no la elige el nodo. Con esto, inventarse tráfico **no aumenta** la parte del premio de nadie (lo demostramos en la sección 5.6.4).
3. **Niveles Bronce, Plata, Oro y Diamante** con multiplicadores ×1,00, ×1,15, ×1,30 y ×1,50. Reparten el mismo bote; no crean moneda extra.
4. **Comisión fija anclada al euro** para mainnet: 0,001 € por transferencia, pagada en VEL al precio medio de 24 horas. Reparto: **50 % quema, 40 % nodos, 10 % tesorería**.
5. **Mensajes gratis** dentro de una cuota por identidad (unos 2.880 al día). Las empresas que envíen más compran **Créditos Velum**, que queman VEL.

**Números clave propuestos:**

| Parámetro | Valor |
|---|---|
| Bloque y finalidad | 2 s; finalidad en 1 bloque (consenso BFT tipo Tendermint) |
| Validadores | 4 (PoA, testnet) → 21 → 50 → 100 (PoS con penalizaciones) |
| Suministro inicial | 1.000 millones de VEL |
| Emisión | 5 % el año 1, baja un 15 % cada año, suelo permanente del 1 % |
| Reparto de la emisión | 85 % nodos de relevo, 15 % validadores |
| Comisión de pago | Testnet: 0,001 VEL fija. Mainnet: 0,001 € en VEL |
| Fragmentos | 5 por mensaje; bastan 3 para reconstruirlo (Reed-Solomon 3 de 5) |
| Época de trabajo | 1 hora; 8 recibos auditados al azar por compromiso |

**Qué dice la simulación** (sección 6). Un nodo doméstico cuesta unos **19,60 €/mes** (luz a 0,02 €/h más amortización). En el escenario base, el nodo medio cubre costes con VEL por encima de **0,0021 €** el año 3 y de **0,016 €** el año 5. Cuantos más nodos, más se reparte la emisión. Por eso **la comisión anclada al euro es clave**: en el escenario alto llega a ser el **43 %** del ingreso del nodo en el año 5 y deja la inflación neta en el **0,18 %**. Con comisión fija en VEL, esa parte es solo el **0,7 %**.

**Cambios que recomendamos al MVP** (detalle en la sección 7): **no firmar recibos con la clave de la cuenta**; no enviar el buzón del destinatario en claro; **separar la clave del monedero de la del chat**; que el explorador muestre **agregados con retraso**, nunca movimientos de fragmentos en vivo; rellenar los fragmentos a tamaños fijos; pasar la paridad 4 + 1 a **Reed-Solomon 3 de 5**; bajar el multiplicador Diamante de ×2,00 a ×1,50; y exigir firmas de 2/3 para tener **finalidad inmediata**. La comisión 0,001 VEL, el reparto 50/40/10 y los bloques de 2 s **se mantienen**.

**Riesgos principales:** filtración de metadatos por notificaciones push y por el explorador; dependencia del precio de VEL; y regulación (MiCA, antiblanqueo y el reglamento europeo contra el abuso infantil, conocido como *Chat Control*). La testnet no tiene riesgo regulatorio relevante si VEL de testnet no tiene valor ni se vende.

---

## 2. Glosario mínimo

| Término | Qué significa aquí |
|---|---|
| **E2E** (extremo a extremo) | Solo emisor y receptor pueden leer el mensaje. Los nodos ven datos cifrados. |
| **Metadatos** | Quién habla con quién, cuándo y cuánto. No es el contenido, pero revela mucho. |
| **Fragmento** (*shard*) | Trozo cifrado de un mensaje. Viaja por una ruta distinta a los demás. |
| **Ruta en cebolla** | El paquete va envuelto en varias capas de cifrado. Cada nodo quita una y solo sabe el anterior y el siguiente. |
| **Buzón** | Grupo de nodos que guarda mensajes para quien está desconectado. |
| **Recibo** | Prueba de que un fragmento llegó. Sirve para pagar al nodo. |
| **Época** | Periodo de una hora en el que se cuentan recibos y se reparten premios. |
| **Validador** | Nodo que ordena y firma bloques de la cadena. |
| **PoA / PoS** | *Proof of Authority*: validadores conocidos y aprobados. *Proof of Stake*: validadores que depositan moneda como fianza. |
| **Finalidad** | Momento en que un bloque ya no se puede deshacer. |
| **Quema** | Moneda que se destruye para siempre. Reduce el suministro. |
| **Emisión** | Moneda nueva que crea el protocolo para pagar a nodos y validadores. |
| **Oráculo** | Servicio que lleva a la cadena un dato de fuera, como el precio en euros. |
| **TWAP** | Precio medio en una ventana de tiempo. Es más difícil de manipular que el precio de un instante. |
| **RLN** | *Rate-Limiting Nullifier*. Permite limitar cuántos mensajes manda alguien sin saber quién es [28]. |
| **Sybil** | Ataque en el que una persona finge ser muchas [85]. |
| **Penalización** (*slashing*) | Pérdida de parte de la fianza por mal comportamiento. |
| **Árbol de Merkle** | Estructura que resume miles de datos en un solo código (raíz). Permite probar que un dato está dentro sin enseñar los demás. |

---

## 3. Estado del arte

### 3.1 Cifrado de extremo a extremo

**Signal es el estándar de facto.** Tiene tres piezas.

- **X3DH** (2016) acuerda una clave secreta entre dos personas aunque una esté desconectada. Da secreto hacia delante y negación plausible [1].
- **PQXDH** (2023, revisado en 2024) lo amplía contra ordenadores cuánticos. Combina X25519 con un mecanismo de encapsulado poscuántico. Protege frente a «guardar ahora y descifrar después» [2]. Un análisis formal publicado en USENIX Security 2024 encontró fallos en la especificación. No eran explotables en la app, y la especificación se corrigió [3].
- **Double Ratchet** deriva una clave nueva por cada mensaje. Así, robar una clave no abre los mensajes anteriores [4].

**En octubre de 2025 Signal añadió SPQR** (*Sparse Post-Quantum Ratchet*). Usa ML-KEM y se mezcla con el Double Ratchet en lo que llaman **Triple Ratchet** [5]. Trocea las claves grandes y usa códigos de borrado para no inflar el tráfico [6].

**Apple PQ3** (2024) usa criptografía poscuántica en el acuerdo inicial y también al renovar claves dentro de la conversación. Apple lo llama «nivel 3» y sitúa a PQXDH en el «nivel 2» [7]. Son afirmaciones del propio fabricante.

**ML-KEM** es el estándar FIPS 203 de NIST, publicado el 13 de agosto de 2024. Viene de CRYSTALS-Kyber y tiene tres tamaños: 512, 768 y 1024 [10].

**Grupos.**
- **WhatsApp** usa *Sender Keys*: cada emisor reparte una clave por los canales 1 a 1 y luego cifra cada mensaje una sola vez. Si alguien sale del grupo, todos cambian de clave [11]. Es eficiente, pero renovar claves cuesta más cuanto mayor es el grupo.
- **MLS** (RFC 9420, julio de 2023) es el estándar del IETF para grupos de 2 a miles de personas. Da secreto hacia delante y recuperación tras un robo de claves [8]. Su documento de arquitectura (RFC 9750, abril de 2025) define dos servicios: uno que **autentica** identidades y otro que **entrega** mensajes [9]. Ya lo usan Webex y XMTP, y lo probaban Wire, Matrix y Discord [8][15].

**Metadatos del emisor.** El *sealed sender* de Signal mete la identidad del emisor dentro del sobre cifrado. Signal sigue viendo la IP y la hora [12].

**Contraejemplos útiles.**
- **Telegram** no cifra de extremo a extremo por defecto. Solo los «chats secretos» 1 a 1, y hay que activarlos [13].
- **Session V1** no tiene secreto hacia delante: todo va con una clave fija. Lo quitó en 2021 por problemas de sincronización. Su **Protocolo V2**, anunciado en diciembre de 2025, añade claves rotativas por dispositivo y ML-KEM. Aún no está cerrado [14].

> **Qué copiamos.** PQXDH (híbrido X25519 + ML-KEM-768) para el primer contacto. Double Ratchet para 1 a 1. MLS para grupos grandes. El *sealed sender* como idea: el emisor nunca va en claro.
>
> **Qué mejoramos.** Session sacrificó el secreto hacia delante por ser descentralizado. Nosotros lo mantenemos: los buzones guardan los mensajes del Ratchet en orden y cada dispositivo tiene sus propias claves. Planificamos el Triple Ratchet (SPQR) desde el principio, no como parche.

### 3.2 Privacidad de metadatos y anonimato

**Hay un límite teórico.** El «trilema del anonimato» (IEEE S&P 2018) demuestra que solo se pueden tener dos de tres: anonimato fuerte, poco tráfico extra y poca latencia [35]. Un chat tipo WhatsApp necesita poca latencia. Por eso **el modo normal de Velum protege bien pero no es perfecto**, y ofrecemos un modo reforzado más lento.

**Tor** (2004) creó el circuito de tres saltos con cifrado por capas, secreto hacia delante y servicios ocultos [25]. Es rápido, pero no resiste a quien observa toda la red.

**Session** usa *onion requests*: 3 saltos aleatorios por los nodos de la red. Cada identidad tiene asignado un **enjambre** (*swarm*) de nodos que guarda sus mensajes. El enjambre sale de la clave pública del destinatario. Los mensajes caducan a los 14 días. Funciona sobre TCP y no sirve bien para llamadas [16][17]. Desde mayo de 2025 sus nodos se pagan con el token **SESH** en Arbitrum [18]. En abril de 2026 su fundación avisó de que podía cerrar sin un millón de dólares de financiación (dato de Wikipedia sin confirmar en fuente primaria) [98]. Es un aviso: **la sostenibilidad económica no es opcional**.

**Nym y Loopix.**
- **Loopix** (USENIX 2017) añade retrasos aleatorios y **tráfico de cobertura** (paquetes falsos indistinguibles). Resiste a un observador global. Un nodo procesa más de 300 mensajes/s y la latencia total es de segundos [19].
- **Sphinx** (2009) es el formato de paquete que oculta la longitud de la ruta y la posición de cada nodo. Permite **respuestas anónimas** [20].
- **Nym** construye sobre ambos. Paga a los nodos por rendimiento real medido con paquetes de prueba [21][22][23]. Sus credenciales **zk-nym** desvinculan el pago del uso [24].

**Waku/Status.** Protocolos P2P modulares para móviles y navegadores [26]. Usan **RLN**: cada mensaje lleva una prueba de conocimiento cero de que el emisor es miembro y no ha superado su cupo. Si lo supera, se le puede identificar y expulsar [27][28].

**SimpleX** no asigna identificadores a los usuarios. Usa colas de un solo sentido por cada contacto. Los servidores pueden ver la IP si no se usa Tor [29].

**Briar** funciona sin servidores: por Tor con internet y por Bluetooth o Wi-Fi sin él. No tiene versión para iOS [30].

**La investigación académica** logra garantías más fuertes, pero con costes altos:

| Sistema | Idea | Coste |
|---|---|---|
| Vuvuzela (2015) | Ruido con privacidad diferencial | 37 s de latencia; 12 KB/s por usuario [31] |
| Pung (2016) | Recuperación privada de información | Escala limitada [32] |
| Stadium (2017) | Cientos de proveedores verificables | Minutos de latencia [33] |
| Karaoke (2018) | Ruido «optimista» con filtros Bloom | 6,8 s para 2 millones de usuarios [34] |

**Difusión entre nodos.** **GossipSub v1.1** (libp2p) resiste ataques Sybil y de eclipse con puntuación de pares. Se probó con más de 5.000 nodos [36].

> **Qué copiamos.** Tres saltos de cebolla y buzones por enjambre (Session). Formato Sphinx con respuestas anónimas (Nym). RLN para el cupo de mensajes (Waku). Sondas de medición (Nym).
>
> **Qué mejoramos.** Session envía cada mensaje entero por una ruta. Nosotros lo **troceamos en 5 fragmentos por 5 rutas distintas**: ningún nodo ve el mensaje completo ni su tamaño real. Añadimos un **modo reforzado** con retrasos y tráfico de cobertura (Loopix) para quien lo necesite. Y pagamos el relevo con recibos verificables, algo que Session no hace por mensaje.

### 3.3 Redes de relevo y ancho de banda con incentivos (DePIN)

**DePIN** son redes de infraestructura física pagadas con tokens. Hay revisiones recientes que proponen arquitecturas por capas y señalan los retos: medir el trabajo real y evitar el fraude [54][55][56].

**El problema central es probar el trabajo.** TorCoin (2014) quiso pagar a los relés de Tor, pero nunca resolvió cómo verificar el ancho de banda real sin identificar a nadie [41]. Biryukov y Pustogarov propusieron micropagos con prueba de trabajo [42].

**Soluciones que funcionan hoy:**

- **HOPR — Proof of Relay.** Cada salto recibe media clave. Solo puede cobrar cuando el siguiente salto le devuelve la otra mitad, es decir, cuando entregó de verdad [37].
- **Pocket Network — Relay Mining.** El proveedor guarda cada servicio en un **árbol de Merkle con sumas**. Publica una raíz con el total de trabajo. Después prueba unas hojas elegidas al azar. Así la cadena no se llena de datos [39][40].
- **SendingNetwork** propone un *Proof of Relay* con compromisos KZG para mensajería [38].
- **Filecoin** distingue dos pruebas. La de replicación demuestra que se guardó una copia única. La de espacio-tiempo demuestra que se sigue guardando, con desafíos aleatorios [46].
- **Storj** cifra, trocea y reparte con códigos Reed-Solomon. Con 29 de 80 piezas reconstruye el archivo [48][49].

**Pagos por uso.**
- **Orchid** usa **nanopagos probabilísticos**: billetes de lotería con un valor esperado igual al pago real. Solo los premiados van a la cadena [52].
- **Mysterium** pasó de canales de pago a su protocolo **Hermes** para micropagos de VPN [51].
- **Lightning** abre canales de pago fuera de la cadena y solo liquida al final [53].
- **Theta** paga en TFUEL a los nodos que comparten ancho de banda de vídeo [50].

**Helium enseña dos lecciones.**
- **Quema y acuña (BME).** Los usuarios queman HNT para obtener *Data Credits* con precio fijo. El protocolo emite HNT con calendario propio [43][44][83].
- **El fraude es real.** Helium mantiene una **lista negra semanal** de *hotspots* que falsean su ubicación. No publica el método para no ayudar a los tramposos [45].

> **Qué copiamos.** Árbol de Merkle con sumas y muestreo aleatorio (Pocket). Recibos que solo puede producir quien recibe (HOPR). Códigos Reed-Solomon (Storj). Créditos que se compran quemando (Helium).
>
> **Qué mejoramos.** Velum no necesita micropagos por paquete. El premio se reparte por épocas, como Nym. Además, la ruta la decide un sorteo público y no el nodo. Así el fraude típico de DePIN (tráfico inventado) deja de dar beneficio (sección 5.6.4).

### 3.4 Consenso y rendimiento

**Velum necesita poco de la cadena.** Según la simulación, en el escenario alto llegamos a unas **19 transacciones por segundo** en el año 5 (sección 6). Cualquier BFT moderno lo soporta de sobra.

| Familia | Ejemplo | Datos clave |
|---|---|---|
| BFT clásico | Tendermint / CometBFT | Finalidad inmediata; en producción en Cosmos Hub desde 2019 [57] |
| BFT lineal | HotStuff | Cambio de líder barato; base de LibraBFT [58] |
| DAG | Narwhal + Tusk / Bullshark | 125.000–170.000 tx/s; 2–3 s de latencia [59][60] |
| DAG sin certificar | Mysticeti (Sui) | ~0,5 s; Sui bajó de 1,9 s a ~0,4 s de mediana [61]; v2 en 2025 [62] |
| Muestreo probabilístico | Avalanche (Snowball) | 3.400 tx/s; 1,35 s [63] |
| Autoridad | Clique (EIP-225) | Firmantes por turnos; típico de testnets [65] |
| Disponibilidad de datos | LazyLedger / Celestia | Verificar bloques por muestreo [64] |

**Tendermint** viene de PBFT y añade un mecanismo de terminación basado en el *gossip* [57]. Una variante de 2026, *Fast Tendermint*, decide en dos pasos con más margen de nodos honestos [67]. **Casper FFG** define cuándo se penaliza a un validador: si firma dos cosas en conflicto [66].

**Conclusión práctica.** Para ~2 s con pocos validadores, **un BFT tipo Tendermint/CometBFT basta**. Un DAG tipo Mysticeti es excesivo hasta tener cientos de miles de transacciones por segundo. Clique (PoA por turnos) vale para el MVP, pero **no da finalidad inmediata**: un bloque podría reorganizarse. Por eso recomendamos firmas de 2/3 de los validadores por bloque.

> **Qué copiamos.** El modelo de Tendermint: un bloque se da por final cuando lo firman más de 2/3 de los validadores. Las reglas de penalización de Casper.
>
> **Qué mejoramos.** Ponemos fuera de la cadena todo lo que crece con el uso. La cadena solo ve **una transacción por nodo y hora**, no una por mensaje. Es el mismo truco que Pocket [40].

### 3.5 Economía del token

**Comisiones dinámicas frente a fijas.**
- **EIP-1559** (Ethereum) quema una comisión base que sube y baja con la demanda. Roughgarden mostró que es más fácil de predecir, pero que no baja mucho las comisiones medias [69][70]. Un estudio empírico (CCS 2022) confirmó menos espera y efecto pequeño en el nivel de comisiones [71].
- La quema no garantiza escasez. Tras la actualización Dencun (marzo de 2024), las comisiones base cayeron y ETH volvió a ser inflacionario [72].
- **Solana** quema el 50 % de la comisión base de 5.000 lamports por firma [73]. Desde 2024 (SIMD-0096), las comisiones de prioridad van enteras al validador [74]. Su inflación empezó en el 8 %, baja un 15 % al año y tiene un suelo del 1,5 % [75].
- **Comisiones fijas y diminutas:** XRP Ledger cobra 10 *drops* (0,00001 XRP) y **los destruye** [76]. Algorand cobra 0,001 ALGO cuando no hay congestión [77]. Stellar cobra 100 *stroops* por operación y solo sube con congestión [78]. Sui fija un precio de referencia por época que votan los validadores [79].

**Pagar en moneda estable.** **Celo** deja pagar comisiones en monedas estables de una lista aprobada [80]. Las cuentas abstractas de Ethereum (ERC-4337) permiten que un tercero **patrocine** el gas [81]. **XMTP** cobrará cada mensaje en su red descentralizada con una cartera en USDC del desarrollador [15].

**Pagos a nodos.**
- **Nym:** premio por época = presupuesto × rendimiento × saturación de fianza × fracción de trabajo, con una prima por fianza propia. Épocas de 1 hora; 240 nodos activos. El rendimiento sale de sondas cada 15 minutos [23]. Penaliza repartir la fianza en muchos nodos para frenar ataques Sybil [22].
- **Filecoin:** parte de la emisión sigue un calendario fijo y parte solo se libera si la red alcanza una meta de capacidad (*baseline minting*) [47].
- **Helium:** suministro máximo de 223 millones de HNT con mitades cada dos años [44].

**Problemas conocidos.**
- **Sybil:** sin una autoridad central, siempre es posible fingir muchas identidades salvo que cada una cueste algo [85].
- **Antispam:** Hashcash pide un pequeño cálculo por mensaje [84]. RLN pone un cupo anónimo [28]. Las comisiones ponen precio.
- **Velocidad:** si nadie necesita guardar el token, su precio tiende a ser bajo [82].
- **Reputación:** EigenTrust calcula confianza global a partir de las experiencias locales. Resistió con hasta un 70 % de nodos maliciosos en simulación [86].
- **Oráculos:** el precio medio en el tiempo (TWAP) resiste picos, pero llega con retraso [87].

> **Qué copiamos.** Comisión fija y quemada (XRP, Algorand). Reparto quema/validador (Solana). Emisión decreciente con suelo (Solana). Créditos BME (Helium). Fórmula de premio con rendimiento medido (Nym).
>
> **Qué mejoramos.** Anclamos la comisión al **euro**, no al token: el usuario paga siempre lo mismo y el nodo gana más cuando la red crece. Ponderamos el premio por **trabajo entregado**, no por fianza. Así un nodo modesto con buen servicio gana como uno rico.

### 3.6 Regulación

Lo tratamos en la sección 8, junto con los riesgos.

---

## 4. Tabla comparativa

Leyenda: ✔ sí · ✘ no · ◐ parcial · n/d no documentado en las fuentes revisadas.

| | Signal | WhatsApp | Telegram | Session | SimpleX | Nym | Status (Waku) | **Velum** |
|---|---|---|---|---|---|---|---|---|
| E2E por defecto | ✔ [4] | ✔ [11] | ✘ [13] | ✔ [16] | ✔ [29] | n/a (transporte) | ✔ [26] | **✔** |
| Secreto hacia delante | ✔ [4] | ✔ [11] | ◐ solo secretos [13] | ✘ V1, ◐ V2 en diseño [14] | n/d | n/a | n/d | **✔ (v1)** |
| Resistencia cuántica | ✔ PQXDH + SPQR [2][5] | n/d | n/d | ◐ V2 en diseño [14] | n/d | n/d | n/d | **✔ (v1–v2)** |
| Grupos grandes | ✔ | ✔ Sender Keys [11] | ✔ sin E2E | ✔ | ✔ | n/a | ✔ | **✔ MLS** |
| Sin teléfono ni email | ✘ | ✘ | ✘ | ✔ | ✔ sin IDs [29] | ✔ | ✔ | **✔** |
| Servidor central | ✔ | ✔ | ✔ | ✘ nodos | ◐ servidores de relevo [29] | ✘ | ✘ | **✘** |
| Oculta la IP | ✘ [12] | ✘ | ✘ | ✔ 3 saltos [16] | ◐ con Tor [29] | ✔ mixnet [19] | ◐ | **✔ 3 saltos** |
| Resiste observador global | ✘ | ✘ | ✘ | ✘ | ✘ | ✔ cobertura [19] | ✘ | **◐ modo reforzado** |
| Antispam sin identidad | ✘ | ✘ | ✘ | n/d | n/d | ✔ zk-nym [24] | ✔ RLN [27] | **✔ RLN + cupo** |
| Nodos pagados por trabajo | ✘ | ✘ | ✘ | ◐ por fianza [18] | ✘ | ✔ [23] | n/d | **✔ recibos (PTE)** |
| Pagos dentro del chat | n/d | n/d | n/d | ✘ | ✘ | ✘ | n/d | **✔ comisión fija** |
| Explorador público | ✘ | ✘ | ✘ | ◐ cadena de SESH | ✘ | ✔ cadena Nyx | n/d | **✔ agregado** |

---

## 5. El protocolo Velum

### 5.1 Arquitectura en capas

```
┌──────────────────────────────────────────────────────────────┐
│ CAPA 1 · CLIENTE (móvil, escritorio, web)                    │
│ Semilla → identidad de chat + monedero (claves separadas)    │
│ Cifrado E2E: PQXDH + Double Ratchet · MLS para grupos        │
│ Trocea: Reed-Solomon 3 de 5 · Prueba RLN de cupo             │
└──────────────┬───────────────────────────────────────────────┘
               │ 5 fragmentos, 5 rutas de 3 saltos (Sphinx)
┌──────────────▼───────────────────────────────────────────────┐
│ CAPA 2 · RELEVO (nodos domésticos, encender y apagar)        │
│ Entrada → intermedio → buzón (enjambre de 5 nodos)           │
│ Recibos anónimos por salto · árbol de Merkle con sumas       │
└──────────────┬───────────────────────────────────────────────┘
               │ 1 compromiso por nodo y hora (raíz + total)
┌──────────────▼───────────────────────────────────────────────┐
│ CAPA 3 · LIBRO MAYOR (cadena BFT, bloques de 2 s)            │
│ Pagos · registro y fianzas de nodos · compromisos de trabajo │
│ Auditoría por muestreo · premios por época · penalizaciones  │
└──────────────┬───────────────────────────────────────────────┘
               │
┌──────────────▼───────────────────────────────────────────────┐
│ CAPA 4 · ACCESO                                              │
│ Bootnodes y semillas DNS · explorador público (agregado)     │
│ Oráculo de precio (solo mainnet) · push opcional sin datos   │
└──────────────────────────────────────────────────────────────┘
```

**Regla de oro:** nada de lo que crece con los mensajes toca la cadena. Ni contenido, ni rutas, ni identidades.

### 5.2 Identidad y claves

Una sola **semilla** de 24 palabras genera todas las claves. Pero cada uso tiene **su propia clave**:

| Clave | Algoritmo | Para qué | Derivación |
|---|---|---|---|
| Identidad de chat (IK) | Ed25519 | Firmar el perfil y las claves previas | `velum/chat/0` |
| Acuerdo (DH) | X25519 | Primer contacto y Ratchet | `velum/chat/dh/n` |
| Poscuántica | ML-KEM-768 | Primer contacto híbrido | `velum/chat/kem/n` |
| Monedero | Ed25519 | Firmar pagos | `velum/wallet/n` |
| Membresía RLN | Poseidon (circuito RLN) | Probar el cupo sin identificarse | `velum/rln/0` |
| Nodo (si opera uno) | Ed25519 | Firmar compromisos y bloques | `velum/node/n` |

- El **ID de Velum** es la clave pública de identidad codificada en base32, unos 52 caracteres. No hace falta teléfono ni email.
- La **dirección del monedero** es `vel1…` (bech32 del hash de la clave del monedero).
- **¿Por qué separarlas?** La idea original es «identidad = par de claves = monedero». Funciona, pero tiene un problema: los pagos son públicos en el explorador. Si la clave del chat es la misma que la del monedero, cualquiera que conozca tu ID ve todos tus pagos. Con claves separadas de la misma semilla, el usuario sigue teniendo **una sola copia de seguridad**, pero nadie puede unir chat y pagos. Para pagar a un contacto, la app intercambia la dirección del monedero **dentro del chat cifrado**.

### 5.3 Cifrado

| Versión | 1 a 1 | Grupos | Notas |
|---|---|---|---|
| **v0 (MVP)** | NaCl `box` (X25519 + XSalsa20-Poly1305) | Copia cifrada por miembro | Sin secreto hacia delante. Solo para testnet. |
| **v1** | PQXDH híbrido (X25519 + ML-KEM-768) + Double Ratchet [2][4][10] | Sender Keys ≤ 100 miembros [11]; MLS > 100 [8] | Secreto hacia delante y recuperación tras robo |
| **v2** | Triple Ratchet con SPQR [5] | MLS para todos [8][9] | Resistencia cuántica continua |

- **Claves previas** (*prekeys*): cada cliente publica un paquete de claves de un solo uso en su enjambre de buzón. Hace el papel del servidor de Signal.
- **MLS** pide que los cambios del grupo (*commits*) lleguen en orden. El enjambre de buzón del grupo actúa como **servicio de entrega** (RFC 9750) y numera esos cambios [9].
- **Varios dispositivos:** cada dispositivo tiene sus propias claves, como propone Session V2 [14].
- **Imágenes y notas de voz:** el archivo se cifra con una clave aleatoria (XChaCha20-Poly1305). Se trocea con Reed-Solomon y se guarda en el enjambre con caducidad. El mensaje solo lleva la clave y el hash. Límite inicial: 25 MB.

### 5.4 Capa de relevo

#### 5.4.1 De mensaje a fragmentos

1. El cliente cifra el mensaje (sección 5.3).
2. Lo **rellena** hasta un tamaño fijo: 1 KiB, 4 KiB, 16 KiB o 64 KiB. Así nadie deduce nada del tamaño.
3. Lo codifica con **Reed-Solomon (k = 3, n = 5)**: 5 fragmentos; bastan 3 cualesquiera para reconstruirlo.
4. Cada fragmento lleva una **etiqueta** `tag_j = H(nulificador_RLN ‖ j)`.
5. Cada fragmento viaja en un paquete **Sphinx** de tamaño fijo [20].

**¿Por qué 3 de 5?** Si cada ruta entrega con probabilidad 0,95:

- 4 de 4 (sin paridad): P = 0,95⁴ = **0,815**. Casi 1 de cada 5 mensajes necesita reenvío.
- 4 + 1 con paridad XOR (lo que hace hoy el MVP): P = 0,95⁵ + 5·0,95⁴·0,05 = **0,977**.
- 3 de 5 con Reed-Solomon: P = 0,95⁵ + 5·0,95⁴·0,05 + 10·0,95³·0,05² = **0,9988**.

Con los mismos 5 fragmentos, 3 de 5 ocupa 5/3 = 1,67 veces el mensaje, frente a 1,25 veces del 4 + 1. Para textos cortos merece la pena; para archivos grandes, el 4 + 1 del MVP es un buen equilibrio.

#### 5.4.2 Rutas neutrales

Cada fragmento recorre **3 saltos**: entrada → intermedio → buzón.

- **Entrada:** cada cliente fija un nodo de entrada «guardián» durante 30 días, como Tor [25]. Así reduce el riesgo de caer muchas veces en un nodo espía.
- **Intermedio:** se elige por sorteo. El nodo para el salto *i* del fragmento *j* es:

  `nodo_ij = Elegir(Registro_e, H(baliza_e ‖ tag_j ‖ i))`

  - `baliza_e` es el hash del primer bloque de la época (aleatoriedad pública).
  - `Elegir` toma un nodo del registro con probabilidad proporcional a su peso (nivel × rendimiento).
  - Cada nodo **comprueba** que le tocaba a él. Si no, descarta el paquete sin cobrarlo.
- **Buzón:** el enjambre de 5 nodos de cada destinatario sale de `H(clave_buzón ‖ baliza_día)`. Cambia cada día para que nadie pueda «fabricar» claves que caigan siempre en sus nodos.

La etiqueta depende del nulificador RLN. Ese nulificador es fijo por identidad, época y número de mensaje. Por eso **probar rutas distintas gasta cupo**: no se pueden fabricar etiquetas gratis.

#### 5.4.3 Buzones

- Guardan los fragmentos cifrados **14 días**, como Session [16].
- Replicados en un enjambre de 5 nodos.
- El destinatario los descarga también por una ruta de cebolla.
- Si el destinatario está conectado, el buzón le avisa al momento por su conexión abierta.

#### 5.4.4 Acuses de entregado y leído

Son **mensajes E2E normales**: se trocean y viajan igual que el resto. Ningún nodo distingue un acuse de un «hola».

#### 5.4.5 Notificaciones push (problema conocido)

iOS y Android exigen servidores de Apple y Google para despertar la app. Eso revela «a este teléfono le ha llegado algo». Propuesta:

- **Por defecto en Android:** sin push; conexión en segundo plano.
- **iOS y opcional en Android:** un servicio de push que solo recibe una señal vacía y aleatorizada. No sabe quién envía ni cuántos mensajes hay. Lo puede operar cualquiera.

#### 5.4.6 Modo reforzado (opcional)

Para periodistas o activistas:

- Retrasos aleatorios en cada salto (exponenciales, media de 0,5 s).
- Tráfico de cobertura constante: un paquete Sphinx cada 2 s aunque no haya nada que enviar [19].

Cuesta batería y datos, y suma segundos de latencia. Es el trilema en la práctica [35].

**Latencia esperada en modo normal:** 3 saltos × 40–80 ms de red más proceso ≈ **0,3–0,8 s** si el destinatario está conectado.

### 5.5 Capa de libro mayor

| Aspecto | Testnet (MVP) | Mainnet |
|---|---|---|
| Consenso | PoA, 4 validadores rotativos, bloque de 2 s | BFT tipo CometBFT con PoS |
| Finalidad | Recomendado: firmas de 2/3 por bloque | 1 bloque (~2 s) |
| Validadores | 4 (Consultora BIM y socios) | 21 → 50 → 100 por fianza |
| Penalizaciones | Avisos | 5 % de fianza por doble firma; 0,1 % por caída larga |

**Qué guarda la cadena:**

1. **Pagos:** origen, destino, cantidad, comisión. Las direcciones son seudónimas.
2. **Registro de nodos:** clave, fianza, nivel, rendimiento medido y versión.
3. **Compromisos de trabajo:** uno por nodo y época (sección 5.6).
4. **Membresías RLN:** la raíz del árbol de miembros, no quién es quién.
5. **Parámetros:** comisión vigente, precio del oráculo (mainnet), baliza.

**Qué no guarda nunca:** contenido, rutas, quién habla con quién, IP.

**Capacidad.** Un compromiso ocupa unos 200 bytes. Con 6.600 nodos son 160.000 al día, unos 32 MB. Los pagos del escenario alto (1,3 millones al día) suman unos 330 MB diarios. Es manejable con poda de bloques antiguos.

### 5.6 Prueba de Trabajo Entregado (PTE)

#### 5.6.1 El recibo anónimo

El fundador propone recibos firmados por el destinatario. **Problema:** una firma con la clave de identidad dice a cada nodo quién recibió el mensaje. Rompe el anonimato.

**Solución: el recibo es la revelación de un secreto que solo el destinatario conoce** (idea del Proof of Relay de HOPR [37]).

1. Para cada fragmento *j*, el emisor genera un secreto aleatorio `r_j`. Lo mete en la capa más interna, que solo el destinatario puede abrir.
2. A cada salto *i* le da un compromiso distinto: `c_ij = H(r_j ‖ i)`. Al ser distintos, dos nodos no pueden unir sus vistas.
3. Cuando el destinatario abre el fragmento, devuelve `r_j` por la **respuesta anónima** del paquete Sphinx (SURB) [20].
4. Cada salto comprueba `H(r_j ‖ i) = c_ij` y guarda el par como **recibo**.

Nadie puede inventar `r_j` sin el destinatario. El recibo **no dice quién es el destinatario**. Funciona como una firma de un solo uso.

#### 5.6.2 Unidades de trabajo

| Trabajo | Unidades |
|---|---|
| Fragmento entregado al siguiente salto, con recibo | 1,0 |
| Respuesta (SURB) devuelta | 0,25 |
| Fragmento guardado en buzón, por día | 0,2 |
| Paquete de sonda entregado | 1,0 (y además mide el rendimiento) |

Las unidades de buzón solo cuentan si el nodo responde a desafíos aleatorios de almacenamiento, como en Filecoin [46].

#### 5.6.3 Compromiso y auditoría por época

Al final de cada época (1 hora):

1. El nodo construye un **árbol de Merkle con sumas** con sus recibos. Cada hoja = (compromiso, secreto revelado, unidades) [39][40].
2. Publica en la cadena: `(nodo, época, raíz, total_unidades, nº_hojas)`.
3. Tras un margen de 5 minutos, la baliza del bloque elige **8 hojas al azar**.
4. El nodo tiene 10 minutos para enseñar esas 8 hojas con su camino de Merkle.
5. Si falla una sola: pierde el premio de la época y **el 1 % de su fianza**.

Con 8 muestras, un nodo que infle el 20 % de sus hojas es pillado con probabilidad 1 − 0,8⁸ = **83 %** en cada época. En un día (24 épocas), la probabilidad de no ser pillado nunca es 0,17²⁴ ≈ 0.

#### 5.6.4 Fórmula del premio

Para cada época *e*:

```
Bote_e     = Emisión_e × 0,85  +  Comisiones_e × 0,40

u_i        = unidades verificadas del nodo i
û_i        = min(u_i, μ × mediana(u) )            con μ = 4  (techo anti-acaparamiento)
P_i        = rendimiento medido por sondas, de 0 a 1
m_i        = multiplicador de nivel (1,00 · 1,15 · 1,30 · 1,50)

             P_i⁴ × m_i × û_i
Premio_i = ───────────────────────  × Bote_e
            Σ_j  P_j⁴ × m_j × û_j
```

- **P⁴** castiga mucho perder paquetes. Con P = 0,9, el factor es 0,66. Nym usa una potencia aún mayor para elegir nodos activos [23].
- **Los multiplicadores no crean moneda.** Solo cambian el reparto del mismo bote.
- **No se pondera por fianza.** La fianza solo sirve como garantía ante penalizaciones. Es una diferencia deliberada con Nym [22][23].
- **Fianza mínima:** 1.000 VEL en testnet. En mainnet, el equivalente a unos 50 € fijado por gobernanza.

**Propiedad de neutralidad (por qué inventar tráfico no rinde).** Sea *s* la parte del peso total que controla un atacante. Las rutas se sortean con ese mismo peso. Si genera *F* unidades de tráfico falso, a sus nodos les tocan *s·F*. Su parte del bote pasa de *s·W / W* a:

```
(s·W + s·F) / (W + F) = s
```

**No cambia.** Solo ganaría si pudiera desviar las rutas hacia sus nodos. Para eso tendría que probar etiquetas distintas, y cada intento gasta un mensaje de su cupo RLN (sección 5.4.2).

**Cota del sesgo residual.** El atacante podría enviar solo los mensajes cuya ruta toque sus nodos y descartar el resto. Con *s* = 5 % y un cupo de 2.880 mensajes/día, consigue como mucho unos 430 saltos propios por identidad y día. En el escenario base del año 3, cada unidad vale ≈ 0,0005 VEL (2,9 M VEL de bote mensual entre ~5.750 M de unidades). Son **≈ 0,2 VEL/día por identidad** (≈ 0,002 € a 0,01 €/VEL). Además choca con el techo μ por nodo y con el coste de registrar identidades (sección 5.7). El beneficio es despreciable.

#### 5.6.5 Niveles

Cada día se calcula una **puntuación S** entre 0 y 1:

```
S = 0,35·U + 0,30·E + 0,20·A + 0,15·H

U = disponibilidad en los últimos 30 días (0–1, medida por sondas)
E = min(1, log(1 + unidades_90d) / log(1 + E_ref))   E_ref = percentil 90 de la red
A = min(1, días_activo / 365)
H = max(0, 1 − 0,34 × penalizaciones_180d)
```

| Nivel | Requisitos | Multiplicador |
|---|---|---|
| **Bronce** | Nodo nuevo o S < 0,55 | ×1,00 |
| **Plata** | S ≥ 0,55 y ≥ 30 días | ×1,15 |
| **Oro** | S ≥ 0,72 y ≥ 90 días | ×1,30 |
| **Diamante** | S ≥ 0,85, ≥ 180 días, 0 penalizaciones en 180 días, fianza ≥ 5 × mínima | ×1,50 |

- **Histéresis:** para bajar de nivel, S debe estar 0,05 por debajo del umbral durante 7 días seguidos. Evita saltos por un mal día.
- **Encender y apagar a voluntad** está permitido. Apagar baja U y retrasa la subida de nivel, pero no penaliza.
- **«Historial de transacciones»:** el fundador lo propone como criterio. Recomendamos contar solo **transacciones de servicio** (compromisos aceptados y auditorías superadas). Contar pagos premiaría a quien tiene más dinero, y con una comisión de 0,001 VEL sería barato inflarlo con autotransferencias.

**Ejemplo** (escenario base, año 3, mismo trabajo, VEL a 0,01 €):

| Nivel | VEL/mes | €/mes |
|---|---|---|
| Bronce | 8.446 | 84,46 |
| Plata | 9.712 | 97,12 |
| Oro | 10.979 | 109,79 |
| Diamante | 12.668 | 126,68 |

#### 5.6.6 Otras defensas

| Riesgo | Defensa |
|---|---|
| Nodo que solo atiende su tráfico falso | Las sondas son indistinguibles del tráfico real. Si las pierde, P baja y su premio se hunde [23]. |
| Muchos nodos de una misma persona | Cada uno exige fianza, uptime y pasar sondas. Si da buen servicio, es un operador grande legítimo. Límite: máximo 2 nodos por /24 de IP en la misma ruta. |
| Recibos inventados | Imposible sin `r_j`. La auditoría por muestreo detecta árboles inflados. |
| Colusión emisor-destinatario-nodo | Cubierta por la neutralidad (5.6.4) y el cupo RLN. |
| Grupos que se dan trabajo entre sí | Análisis tipo EigenTrust sobre los compromisos [86]. Lista de vigilancia como la de Helium [45], aplicada por gobernanza. |
| Nodo que mide bien y luego falla | Sondas continuas cada 15 minutos, como Nym [23]. |

### 5.7 Comisiones, cupos y antispam

#### 5.7.1 Mensajes: gratis dentro de un cupo

- Cada identidad se registra **una vez** en el árbol RLN. El registro pide una pequeña prueba de trabajo (unos 30 s en un móvil, tipo Hashcash [84]). La tesorería paga esa transacción.
- **Cupo gratuito:** 20 mensajes cada 10 minutos (hasta 2.880 al día). Un usuario medio envía unos 30 al día.
- **Si alguien supera el cupo**, su prueba RLN revela su secreto de membresía. Los nodos la rechazan y la membresía se anula [27][28].
- **Más cupo:** depositando una fianza en VEL (cupo ×10 por cada 100 VEL), o con Créditos Velum.

#### 5.7.2 Créditos Velum (empresas y bots)

- Se compran **quemando VEL**, como los Data Credits de Helium [43][83].
- Precio fijo en euros: **2 € por cada 100.000 mensajes**.
- **No son transferibles.** Solo sirven para enviar.
- Los nodos no cobran de ellos directamente: siguen cobrando de la emisión y las comisiones. La quema es lo que reparte valor a todos los poseedores.

#### 5.7.3 Pagos: comisión fija

| Modo | Fórmula | Cuándo |
|---|---|---|
| **Fijo** | `F = 0,001 VEL` | Testnet (MVP) |
| **Anclado** | `F = clamp(0,001 € / P_twap24h, 0,0001 VEL, 1 VEL)` | Mainnet |

- `P_twap24h` es el precio medio de 24 h. Sale de la **mediana** de al menos 5 fuentes, incluido un TWAP de un mercado en cadena [87].
- La comisión **se fija por época**. El usuario la ve antes de enviar y no cambia en esa hora. Para él es fija.
- **No hay comisión de prioridad.** Si un bloque va lleno más del 90 % durante 10 bloques, entra un recargo temporal ×10 (como Stellar [78]). Con la carga prevista no debería ocurrir.
- **Límite por cuenta:** 10 pagos por minuto.

**Reparto: 50 % quema · 40 % nodos · 10 % tesorería.**

- **50 % quema:** reduce el suministro con el uso. Es lo que hace Solana con su comisión base [73] y XRP con toda la comisión [76]. Une el valor de VEL al uso real.
- **40 % nodos:** el ingreso de los nodos crece con la actividad, no solo con la emisión. En el escenario alto del año 5, con comisión anclada, es el **43 %** de lo que gana un nodo (sección 6).
- **10 % tesorería:** paga auditorías, servidores de arranque y el registro gratuito de identidades.

**¿Por qué anclar al euro?** Con 0,001 VEL fijos, si VEL vale 0,01 €, cada pago deja 0,00001 €. Es casi nada para los nodos. Si VEL sube a 10 €, el mismo pago cuesta 1 céntimo: el usuario lo nota. Anclar al euro resuelve las dos cosas: **el usuario paga siempre 0,1 céntimos** y la red recibe un ingreso real que crece con el uso. Es la misma lógica que los Data Credits de Helium [44] y que las comisiones en moneda estable de Celo [80].

#### 5.7.4 ¿Y emparejar con una moneda estable?

Se pidió estudiar una moneda estable para que minar sea siempre rentable. Conclusiones:

- **Sí:** fijar en euros las comisiones y los créditos (ya lo hacemos). Es lo que da estabilidad sin tocar la custodia de nadie.
- **Con cuidado:** aceptar en el chat pagos en una moneda estable autorizada por MiCA, como EURC o USDC [97]. Solo de forma no custodial y sin operar nosotros el cambio.
- **No:** prometer que «minar siempre es rentable» o garantizar un mínimo en euros. Eso parece una promesa de rendimiento y puede convertir VEL en un instrumento financiero (sección 8) [91]. Además sería insostenible si el precio cae.
- **Alternativa responsable:** una **reserva de arranque de nodos** (15 % del suministro inicial). Se libera más cuando los ingresos medios caen, como la reserva de Nym [22] o el *baseline minting* de Filecoin [47]. Sin garantías.

### 5.8 Emisión y suministro

| Concepto | Valor |
|---|---|
| Suministro inicial | 1.000.000.000 VEL |
| Emisión año 1 | 5 % anual sobre el suministro |
| Desinflación | −15 % relativo cada año (5 %, 4,25 %, 3,61 %, 3,07 %, 2,61 %…) |
| Suelo (emisión de cola) | 1 % anual, para siempre |
| Reparto de la emisión | 85 % relevo (PTE) · 15 % validadores |
| Tope máximo | **No hay tope fijo**; la quema compensa la emisión de cola |

**¿Por qué emisión de cola y no un tope?** Un tope deja a los nodos sin premio el día que se acaba la emisión. La red pasaría a depender solo de comisiones, y en un mensajero gratis serían pocas. Solana usa un suelo del 1,5 % [75]. Con nuestra quema, el suministro neto puede incluso bajar si el uso crece (ver escenario alto).

**Reparto inicial propuesto** (orientativo, a validar con asesoría legal):

| Bloque | % | Condiciones |
|---|---|---|
| Comunidad y testnet | 20 % | Gratis a quien opere nodos y pruebe la testnet. Sin venta. |
| Tesorería del protocolo | 25 % | Liberación lineal en 4 años; gobernanza |
| Reserva de arranque de nodos | 15 % | Contracíclica (5.7.4) |
| Equipo y fundadores | 15 % | 1 año de bloqueo + 3 años lineales |
| Ecosistema y becas | 15 % | Desarrolladores, auditorías externas |
| Reserva estratégica | 10 % | Solo con documento MiCA si se ofrece a cambio de dinero |

### 5.9 Explorador público

**Qué muestra:**
- Bloques, pagos (direcciones seudónimas y cantidades) y comisiones quemadas.
- Registro de nodos: nivel, rendimiento, unidades por época, premio.
- Compromisos de trabajo: raíz, total y resultado de la auditoría.
- Agregados de red: fragmentos por época, latencia media, nodos activos, mapa por país.

**Qué no muestra nunca:**
- Movimientos de fragmentos uno a uno ni en tiempo real. Con eso, un observador cruzaría horas y sabría quién habla con quién.
- IP de los clientes.
- Nada por debajo de una época (1 hora) ni con menos de 1.000 fragmentos agregados.

Si se quiere el efecto visual de «ver la red moverse», se puede **animar los agregados de la época anterior**. Parece en vivo, pero no filtra nada.

---

## 6. Economía y simulación a 5 años

**Script:** `docs/sim/economia.ts`. Se ejecuta con `bun docs/sim/economia.ts`. Escribe `docs/sim/resultados.json` con las series mensuales para el deck.

### 6.1 Hipótesis

| Hipótesis | Bajo | Base | Alto |
|---|---|---|---|
| Usuarios activos diarios, mes 1 | 2.000 | 5.000 | 10.000 |
| Techo de la curva (logística, k = 0,12/mes) | 250.000 | 3.000.000 | 15.000.000 |
| Pagos por usuario y día | 0,05 | 0,10 | 0,20 |
| Mensajes comerciales con créditos | 0 % | 1 % | 3 % |

**Comunes:** 30 mensajes por usuario y día; 5 fragmentos y 2 acuses por mensaje; 3 saltos; 1 nodo por cada 1.000 usuarios (mínimo 20); validadores 4 → 21 → 50 → 100; emisión 5 % con −15 % anual y suelo del 1 %; reparto de comisión 50/40/10; créditos a 2 € por 100.000 mensajes.

**Coste de un nodo doméstico:** luz 0,02 €/h × 730 h = 14,60 €/mes, más 5 €/mes de amortización (mini-PC de ~180 € en 36 meses) = **19,60 €/mes**.

**Precios de VEL supuestos:** 0,002 € (pesimista), 0,01 € (base) y 0,05 € (optimista). **No son previsiones.** El modelo anclado usa 0,01 € para convertir comisiones y créditos.

### 6.2 Resultados

Columnas: «Ingreso nodo/mes» es la media por nodo de relevo. «Equilibrio €/VEL» es el precio mínimo de VEL para cubrir 19,60 €/mes.

#### Escenario bajo · comisión fija 0,001 VEL

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 7326 | 20 | 1051,2 M | 0,000 M | 5,00 % | 185.371 | 370,74 | 1853,71 | 9268,55 | 0,000106 | 0,02 |
| 2 | 28.254 | 28 | 1096,7 M | 0,000 M | 4,25 % | 117.498 | 235,00 | 1174,98 | 5874,89 | 0,000167 | 0,03 |
| 3 | 87.429 | 87 | 1137,0 M | 0,001 M | 3,61 % | 33.342 | 66,68 | 333,42 | 1667,09 | 0,000588 | 0,10 |
| 4 | 173.544 | 174 | 1172,4 M | 0,002 M | 3,07 % | 14.618 | 29,24 | 146,18 | 730,92 | 0,001341 | 0,20 |
| 5 | 226.371 | 226 | 1203,4 M | 0,004 M | 2,61 % | 9823 | 19,65 | 98,23 | 491,17 | 0,001995 | 0,26 |

#### Escenario bajo · comisión anclada 0,001 € (a 0,01 €/VEL)

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 7326 | 20 | 1051,2 M | 0,004 M | 5,00 % | 185.393 | 370,79 | 1853,93 | 9269,63 | 0,000106 | 0,02 |
| 2 | 28.254 | 28 | 1096,7 M | 0,019 M | 4,25 % | 117.557 | 235,11 | 1175,57 | 5877,84 | 0,000167 | 0,03 |
| 3 | 87.429 | 87 | 1136,9 M | 0,070 M | 3,61 % | 33.400 | 66,80 | 334,00 | 1670,02 | 0,000587 | 0,10 |
| 4 | 173.544 | 174 | 1172,2 M | 0,193 M | 3,06 % | 14.676 | 29,35 | 146,76 | 733,81 | 0,001335 | 0,20 |
| 5 | 226.371 | 226 | 1203,0 M | 0,381 M | 2,59 % | 9881 | 19,76 | 98,81 | 494,03 | 0,001984 | 0,26 |

#### Escenario base · comisión fija 0,001 VEL

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 18.632 | 20 | 1051,2 M | 0,002 M | 5,00 % | 185.372 | 370,74 | 1853,72 | 9268,58 | 0,000106 | 0,03 |
| 2 | 77.097 | 77 | 1096,7 M | 0,013 M | 4,25 % | 42.727 | 85,45 | 427,27 | 2136,35 | 0,000459 | 0,13 |
| 3 | 300.530 | 301 | 1136,9 M | 0,054 M | 3,61 % | 9638 | 19,28 | 96,38 | 481,88 | 0,002034 | 0,52 |
| 4 | 959.028 | 959 | 1172,2 M | 0,199 M | 3,05 % | 2653 | 5,31 | 26,53 | 132,65 | 0,007388 | 1,64 |
| 5 | 1.994.386 | 1994 | 1202,8 M | 0,559 M | 2,57 % | 1114 | 2,23 | 11,14 | 55,70 | 0,017594 | 3,42 |

#### Escenario base · comisión anclada 0,001 € (a 0,01 €/VEL)

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 18.632 | 20 | 1051,1 M | 0,021 M | 5,00 % | 185.481 | 370,96 | 1854,81 | 9274,05 | 0,000106 | 0,03 |
| 2 | 77.097 | 77 | 1096,6 M | 0,111 M | 4,24 % | 42.844 | 85,69 | 428,44 | 2142,21 | 0,000457 | 0,13 |
| 3 | 300.530 | 301 | 1136,5 M | 0,469 M | 3,56 % | 9755 | 19,51 | 97,55 | 487,73 | 0,002009 | 0,52 |
| 4 | 959.028 | 959 | 1170,6 M | 1,717 M | 2,90 % | 2770 | 5,54 | 27,70 | 138,52 | 0,007075 | 1,64 |
| 5 | 1.994.386 | 1994 | 1198,4 M | 4,819 M | 2,27 % | 1231 | 2,46 | 12,31 | 61,54 | 0,015925 | 3,42 |

#### Escenario alto · comisión fija 0,001 VEL

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 37.366 | 37 | 1051,1 M | 0,015 M | 5,00 % | 100.202 | 200,40 | 1002,02 | 5010,09 | 0,000196 | 0,11 |
| 2 | 156.455 | 156 | 1096,6 M | 0,076 M | 4,24 % | 21.090 | 42,18 | 210,90 | 1054,52 | 0,000929 | 0,45 |
| 3 | 638.886 | 639 | 1136,7 M | 0,329 M | 3,57 % | 4541 | 9,08 | 45,41 | 227,03 | 0,004317 | 1,83 |
| 4 | 2.371.260 | 2371 | 1171,1 M | 1,308 M | 2,93 % | 1074 | 2,15 | 10,74 | 53,70 | 0,018248 | 6,81 |
| 5 | 6.631.833 | 6632 | 1198,9 M | 4,406 M | 2,23 % | 336 | 0,67 | 3,36 | 16,80 | 0,058330 | 19,04 |

#### Escenario alto · comisión anclada 0,001 € (a 0,01 €/VEL)

| Año | Usuarios | Nodos | Suministro VEL | Quemado acum. | Infl. neta | Ingreso nodo/mes (VEL) | € a 0,002 | € a 0,01 | € a 0,05 | Equilibrio €/VEL | TPS cadena |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 37.366 | 37 | 1051,1 M | 0,091 M | 4,98 % | 100.439 | 200,88 | 1004,39 | 5021,94 | 0,000195 | 0,11 |
| 2 | 156.455 | 156 | 1096,2 M | 0,471 M | 4,19 % | 21.325 | 42,65 | 213,25 | 1066,26 | 0,000919 | 0,45 |
| 3 | 638.886 | 639 | 1134,9 M | 2,042 M | 3,37 % | 4775 | 9,55 | 47,75 | 238,76 | 0,004104 | 1,83 |
| 4 | 2.371.260 | 2371 | 1164,1 M | 8,126 M | 2,19 % | 1309 | 2,62 | 13,09 | 65,47 | 0,014970 | 6,81 |
| 5 | 6.631.833 | 6632 | 1175,4 M | 27,362 M | 0,18 % | 571 | 1,14 | 5,71 | 28,55 | 0,034327 | 19,04 |

#### Comisiones frente a emisión · escenario alto, mes 60

| Modo | Pagos/mes | Comisión al nodo (VEL/mes) | % del ingreso del nodo | Quema mensual (VEL) | Emisión mensual (VEL) |
|---|---|---|---|---|---|
| Fija 0,001 VEL | 40.348.075 | 2,43 | 0,724 % | 383.307 | 2.602.757 |
| Anclada 0,001 € | 40.348.075 | 243,35 | 42,621 % | 2.380.536 | 2.556.195 |

(La quema mensual incluye los Créditos Velum.)

### 6.3 Lectura de los resultados

1. **Los primeros nodos ganan mucho; los últimos, poco.** La emisión es casi fija y se reparte entre cada vez más nodos. En el escenario base, el ingreso medio cae de 185.000 VEL/mes (año 1, 20 nodos) a 1.100–1.200 VEL/mes (año 5, ~2.000 nodos). Es normal en redes de este tipo y premia a quien llega pronto.
2. **El punto de equilibrio sube con el éxito.** Base, año 5: hace falta VEL ≥ **0,016 €** para cubrir 19,60 €/mes. Alto, año 5: **0,034 €** con comisión anclada y **0,058 €** con comisión fija. Si la red crece y el precio no acompaña, los nodos caros se apagan. **Eso es sano:** la red se ajusta sola hacia 1 nodo por cada 2.000–3.000 usuarios, y los que quedan vuelven a ser rentables.
3. **La comisión anclada al euro cambia el modelo.** En el escenario alto del año 5 aporta el **43 %** del ingreso del nodo, frente al **0,7 %** con 0,001 VEL fijos. Y lleva la inflación neta al **0,18 %**: la quema casi iguala la emisión.
4. **La cadena va sobrada.** El pico es de **19 transacciones por segundo** (escenario alto, año 5). Cualquier BFT con bloques de 2 s lo aguanta.
5. **Un nodo con poca luz es clave.** Un portátil o mini-PC a 0,02 €/h es viable. Un servidor a 0,10 €/h multiplicaría por 4 el precio de equilibrio.

### 6.4 Límites del modelo

- Los usuarios, nodos y precios son **supuestos**, no previsiones.
- No modela la reacción del precio a la quema ni a la venta de premios.
- Supone que todos los nodos hacen el mismo trabajo. En la realidad, Diamante gana ×1,30 sobre la media y Bronce ×0,87 (sección 5.6.5).
- No incluye la reserva de arranque de nodos (5.7.4), que suavizaría la caída de ingresos.

---

## 7. Recomendaciones para el MVP

Revisado contra el código de `packages/core/src/constants.ts`, `shards.ts` y `client.ts` (1 de noviembre de 2026). Parámetros actuales: comisión fija `FEE = 0,001 VEL` con reparto 50/40/10; bloques de 2 s; épocas de 30 bloques (≈ 1 min); emisión de 10 VEL por época con mitad anual; franjas de **4 datos + 1 paridad XOR**; trozos de hasta 24 KB; caducidad de 7 días; niveles ×1,00 / ×1,25 / ×1,50 / ×2,00; tope de 400 fragmentos por par (nodo, destinatario) y época; recibos firmados con la clave de la cuenta; pasarela pública única.

### 7.1 Qué mantener

| Parámetro | Veredicto | Motivo |
|---|---|---|
| Comisión fija 0,001 VEL | **Mantener en testnet** | Simple y suficiente sin precio real. |
| Reparto 50 / 40 / 10 | **Mantener** | Quema como Solana [73]; los nodos ganan con el uso; la tesorería se financia. |
| Bloques de 2 s | **Mantener** | La carga prevista es baja (≤ 19 tx/s en el escenario alto, sección 6). |
| Paridad por franjas | **Mantener la idea** | Ya tolera la pérdida de un fragmento (ver 7.2 para reforzarla). |
| 15 % del bote a quien produce bloques | **Mantener** | Coincide con el 15 % a validadores de la sección 5.8. |
| Caducidad de 7 días | **Aceptable** | Session usa 14 días [16]; cualquiera de los dos vale. |

### 7.2 Qué cambiar (por prioridad)

| # | Hoy en el MVP | Recomendación | Motivo | Prioridad |
|---|---|---|---|---|
| 1 | Recibo firmado con `keys.secret` (la clave de la cuenta) | MVP: firmar con una **clave efímera por mensaje**. v1: recibo por **revelación de secreto** (5.6.1). | La firma con la clave de cuenta dice a cada nodo quién recibe. Rompe el anonimato. | **Alta** |
| 2 | La misma clave es identidad de chat y monedero | **Misma semilla, claves separadas** (5.2). | Los pagos son públicos: con la misma clave se unen chat y pagos. | **Alta** |
| 3 | El campo `mailbox` viaja en claro en cada fragmento, y el tope `PAIR_CAP_PER_EPOCH` necesita saber el destinatario | v1: el buzón solo lo ve el último salto (capa interna de la cebolla) y rota cada día. Sustituir el tope por par por **rutas neutrales + cupo RLN** (5.4.2, 5.6.4). | Todos los nodos pueden agrupar los fragmentos de un mismo destinatario. | **Alta** (v1) |
| 4 | Explorador con cada movimiento de fragmentos (según el encargo) | **Solo agregados por época**, con retraso de 1 época (5.9). | Ver fragmentos en vivo permite cruzar tiempos y desanonimizar. | **Alta** |
| 5 | Tamaño del trozo = tamaño del mensaje ÷ 4 (mínimo 64 B) | **Rellenar** a tamaños fijos: 1/4/16/64 KiB. | El tamaño delata el tipo de mensaje (texto, foto, audio). | **Alta** |
| 6 | Paridad XOR 4 + 1 (tolera 1 pérdida por franja) | **Reed-Solomon 3 de 5** para mensajes cortos: mismos 5 fragmentos, tolera 2 pérdidas. | Con rutas al 95 %: 4 + 1 entrega el **97,7 %**; 3 de 5 el **99,9 %** (5.4.1). | Media |
| 7 | Niveles ×1,25 / ×1,50 / ×2,00 | **×1,15 / ×1,30 / ×1,50**, y confirmar que el multiplicador **reparte el mismo bote** (no crea moneda). | Con ×2,00 un Diamante cobra el doble que un Bronce por el mismo trabajo. Desanima a los nuevos y concentra la red. | Media |
| 8 | Épocas de 1 minuto | Testnet: vale para ver premios rápido. Mainnet: **1 hora**, con 1 compromiso por nodo y 8 muestras (5.6.3). | Con 6.600 nodos y épocas de 1 min serían ~110 tx/s solo de compromisos. | Media (mainnet) |
| 9 | PoA rotativo | Exigir **firmas de 2/3** de los validadores para dar el bloque por final. | Un PoA por turnos tipo Clique no da finalidad inmediata [65]; un pago podría deshacerse. | Media |
| 10 | Nodo elegido por el cliente (`pickNode`) | **Ruta por sorteo público** desde la baliza del bloque (5.4.2), y 3 saltos por fragmento. | Base de la neutralidad: inventar tráfico deja de rendir. 3 saltos es el estándar de Session y Tor [16][25]. | Media (v1) |
| 11 | NaCl box sin secreto hacia delante | **Aceptable en testnet**, avisándolo en la app. Plan v1: PQXDH + Double Ratchet. | Robar una clave hoy abre todo el historial. | Media (v1) |
| 12 | Sin cupo de mensajes por identidad | **Cupo simple** desde ya (sin RLN): p. ej. 20 mensajes cada 10 min. | Medir el uso real y probar el antispam antes de mainnet. | Baja |
| 13 | Pasarela única (`wss://velum.consultorabim.com/hub`) | Aceptable en testnet. Añadir **2–3 bootnodes** y semillas DNS antes de la testnet pública. | Hoy es un punto único de fallo y de observación. | Baja |
| 14 | Emisión de 10 VEL por época, mitad cada año | Aceptable en testnet. En mainnet, la curva de la sección 5.8 (5 % → −15 %/año → suelo del 1 %). | Una mitad anual deja a los nodos sin premio a largo plazo; el suelo da un presupuesto de seguridad permanente. | Baja (mainnet) |
| 15 | Comisión siempre en VEL | Añadir `modoComision: "fija" \| "anclada"` para mainnet (5.7.3). | El modo anclado aporta el 43 % del ingreso del nodo en el escenario alto (6.3). | Baja (mainnet) |

---

## 8. Riesgos y regulación

### 8.1 Marco legal (UE y España)

> No somos abogados. Esta sección resume fuentes públicas y **debe validarla una asesoría especializada** antes de mainnet.

**MiCA (Reglamento UE 2023/1114).**
- Quien ofrezca al público un criptoactivo que no sea moneda estable debe, en general, ser persona jurídica y publicar y notificar un **documento informativo** (*white paper*) [89].
- **Excepciones del artículo 4.3** [89]:
  - Criptoactivos **ofrecidos gratis**. Ojo: no cuenta como gratis si se piden datos personales a cambio.
  - Criptoactivos **creados automáticamente como premio por mantener el registro** (los premios de nodos y validadores).
  - **Tokens de utilidad** que dan acceso a un servicio que ya existe y funciona.
- **Atención:** las excepciones **no se aplican** si se pide la admisión a negociación en una plataforma (art. 4.4) [89].
- **Instrumento financiero:** ESMA publicó en diciembre de 2024 criterios para saber si un criptoactivo es en realidad un valor. Mira el fondo, no la forma [91]. Prometer rendimientos, dividendos o «rentabilidad garantizada» empuja hacia ahí.
- **Proveedores de servicios (CASP):** custodiar claves de terceros, operar un mercado o cambiar cripto por euros exige autorización. En España la da la **CNMV**. El periodo transitorio acabó el **1 de julio de 2026** [92]. ESMA mantiene el registro de documentos informativos y CASP autorizados [90].
- **Monedas estables:** las autorizadas en la UE son *e-money tokens*. Circle obtuvo licencia en Francia el 1 de julio de 2024 para USDC y EURC [97].

**Antiblanqueo.**
- **Reglamento de transferencias (UE 2023/1113), en vigor desde el 30 de diciembre de 2024:** los CASP deben comprobar que el cliente controla una dirección autoalojada si la transferencia supera 1.000 € [93].
- **AMLR (UE 2024/1624):** desde **julio de 2027**, los CASP no podrán ofrecer cuentas anónimas ni operar con *privacy coins*. No afecta a quien fabrica monederos no custodiales [94]. Un VEL con libro público no es una *privacy coin*, pero **el discurso de «moneda anónima» puede hacer que los exchanges no la acepten**.

**Mensajería cifrada.**
- **Reglamento contra el abuso sexual infantil (*Chat Control*):** el Consejo fijó su posición el 26 de noviembre de 2025. Quitó el escaneo obligatorio, pero mantiene el escaneo «voluntario» y obligaciones de mitigación de riesgos. Quedaban pendientes las negociaciones con el Parlamento [95]. **No hemos podido confirmar el resultado final.** Es el mayor riesgo regulatorio para cualquier mensajero E2E en la UE.

**Protección de datos.**
- Las directrices del EDPB 02/2025 piden **no guardar datos personales en cadena** si choca con el RGPD, cifrar y resumir con hash, y hacer una evaluación de impacto [96]. Las claves públicas y las direcciones pueden ser datos personales.

### 8.2 Qué hace falta para la testnet

| Medida | Por qué |
|---|---|
| VEL de testnet **sin valor**, gratis por grifo (*faucet*) | Encaja en «ofrecido gratis» y evita la venta al público [89] |
| **No prometer** que VEL de testnet se canjeará por VEL de mainnet | Una promesa así puede verse como oferta de un activo futuro |
| Prohibir en los términos su venta o intercambio | Evitar un mercado secundario |
| No pedir datos personales para recibir VEL | No rompe la excepción de gratuidad [89] |
| Nada personal en cadena; evaluación de impacto (DPIA) | Directrices EDPB [96] |
| Aviso claro: «cifrado experimental, sin secreto hacia delante» | Honestidad con los usuarios del MVP |
| Mensajes de marketing **sin rentabilidades** | Evita parecer instrumento financiero [91] |

### 8.3 Qué cambia para la mainnet

1. **Opinión legal** sobre la clasificación de VEL (utilidad frente a instrumento financiero) [91].
2. **Documento informativo MiCA** si hay venta, salida a un exchange o una oferta que no encaje en el art. 4.3 [89].
3. **No ser CASP:** monedero no custodial; no operar cambio cripto-euro; aliarse con un CASP autorizado para entrar y salir de euros [92].
4. **Oráculo** con varias fuentes y TWAP de 24 h para la comisión anclada [87].
5. **Auditorías externas** del cifrado, de los contratos de la cadena y de la PTE.
6. **Plan de respuesta a *Chat Control***: la arquitectura no permite escanear contenido. Hay que decidir a nivel de empresa qué hacer si llega una obligación.
7. **Fiscalidad** de los premios de los nodos en España: consulta con asesoría fiscal.

### 8.4 Riesgos (con honestidad)

| Riesgo | Nivel | Mitigación |
|---|---|---|
| El precio de VEL cae y los nodos se apagan | **Alto** | Comisión anclada, reserva de arranque, nodos de bajo consumo |
| Metadatos filtrados por push, explorador o tamaños | **Alto** | Push vacío, explorador agregado, relleno fijo (5.4, 5.9) |
| *Chat Control* obliga a escanear | **Alto** | Seguimiento legal; diseño técnico que no lo permite |
| Uso delictivo de un mensajero anónimo | **Alto** (reputación) | Sin moderación posible del contenido privado; denuncias en grupos públicos; política clara |
| Pérdida de la semilla = pérdida de chats y fondos | Medio | Copia de seguridad guiada; recuperación social opcional |
| Fraude de nodos (tráfico falso, recibos) | Medio | Neutralidad, auditoría por muestreo, sondas (5.6) |
| Pocos validadores al principio (centralización) | Medio | Calendario público de paso a PoS (sección 9) |
| Sostenibilidad del equipo | Medio | Tesorería del 10 % de comisiones; caso Session como aviso [98] |
| Ataque al oráculo de precio | Medio | Mediana de 5 fuentes, TWAP, límites mín./máx. |
| Batería y datos en móvil (modo reforzado) | Bajo | Modo opcional |
| Criptografía rota por ordenadores cuánticos | Bajo hoy | Híbrido con ML-KEM desde v1 [2][10] |

---

## 9. Hoja de ruta: de testnet a mainnet

Fechas orientativas. Cada fase pasa a la siguiente solo si cumple sus criterios.

| Fase | Cuándo | Qué incluye | Criterio para avanzar |
|---|---|---|---|
| **0 · MVP testnet interna** | Nov.–dic. 2026 | PoA de 4 validadores, NaCl box, comisión 0,001 VEL, explorador. Cambios urgentes de la sección 7 (3 de 5, recibos sin identidad, claves separadas, explorador agregado). | 30 días estables; > 99 % de entrega |
| **1 · Testnet pública** | T1 2027 | Sphinx de 3 saltos, rutas por sorteo, buzones de 5 nodos, compromisos por época con 8 muestras, cupo por identidad, grifo de VEL | 200 nodos externos; auditoría por muestreo sin falsos positivos |
| **2 · Testnet incentivada** | T2–T3 2027 | Niveles y multiplicadores, penalizaciones, sondas, RLN, PQXDH + Double Ratchet, grupos (Sender Keys y MLS), auditoría externa, opinión legal, DPIA | Auditoría sin fallos críticos; informe legal favorable |
| **3 · Mainnet beta** | T4 2027 – 2028 | BFT con PoS (21 validadores), comisión anclada con oráculo, Créditos Velum, documento MiCA si aplica, recompensas por fallos (*bug bounty*) | 6 meses sin incidentes graves |
| **4 · Mainnet plena** | 2028+ | 50 → 100 validadores, Triple Ratchet (SPQR), modo reforzado con tráfico de cobertura, gobernanza en cadena | — |

---

## 10. Preguntas abiertas

1. **Llamadas de voz y vídeo:** las rutas de cebolla añaden latencia. Session tampoco las resuelve aún [16]. ¿Llamadas directas con aviso de que revelan la IP, o por un único salto?
2. **Reglas del grupo MLS:** ¿quién ordena los cambios si el enjambre del grupo se divide?
3. **Oráculo en mainnet:** ¿fuentes propias o un proveedor externo?
4. **Gobernanza:** ¿quién vota los parámetros (multiplicadores, μ, comisión en euros)? ¿Validadores, operadores de nodos o ambos?
5. **Cupo gratuito:** ¿20 mensajes cada 10 minutos es suficiente para grupos muy activos?
6. **Importes privados:** ¿merece la pena ocultar las cantidades de los pagos, viendo la AMLR de 2027 [94]?

---

## 11. Bibliografía

Cada entrada incluye año y enlace. Las marcadas con *(secundaria)* son resúmenes de prensa o terceros; se citan cuando no localizamos la fuente primaria.

### Cifrado de extremo a extremo
1. Marlinspike, M.; Perrin, T. *The X3DH Key Agreement Protocol*. Signal, 2016. https://signal.org/docs/specifications/x3dh/
2. Kret, E.; Schmidt, R. *The PQXDH Key Agreement Protocol*, rev. 3. Signal, 2023 (act. 2024). https://signal.org/docs/specifications/pqxdh/
3. Bhargavan, K.; Jacomme, C.; Kiefer, F.; Schmidt, R. *Formal verification of the PQXDH Post-Quantum key agreement protocol*. USENIX Security, 2024. https://www.usenix.org/conference/usenixsecurity24/presentation/bhargavan
4. Perrin, T.; Marlinspike, M.; Schmidt, R. *The Double Ratchet Algorithm*. Signal, 2016 (rev. 2025). https://signal.org/docs/specifications/doubleratchet/
5. Signal. *Signal Protocol and Post-Quantum Ratchets (SPQR)*. 2025. https://signal.org/blog/spqr/
6. PQShield. *Diving into Signal's New Post-Quantum Protocol*. 2025. https://pqshield.com/?p=9081
7. MacRumors. *Apple Announces 'Groundbreaking' New Security Protocol for iMessage (PQ3)*. 2024 *(secundaria)*. https://www.macrumors.com/2024/02/21/apple-announces-imessage-security-upgrade/
8. Cryspen. *MLS – RFC 9420* (anuncio de la publicación del RFC 9420, julio de 2023). 2023. https://cryspen.com/post/mls-rfc-announcement/ · Charla 37C3: *RFC 9420 or how to scale end-to-end encryption with MLS*. 2023. https://app.media.ccc.de/v/37c3-12064-rfc_9420_or_how_to_scale_end-to-end_encryption_with_messaging_layer_security
9. Beurdouche, B. et al. *RFC 9750: The Messaging Layer Security (MLS) Architecture*. IETF, 2025. https://datatracker.ietf.org/doc/html/rfc9750
10. NIST. *FIPS 203: Module-Lattice-Based Key-Encapsulation Mechanism Standard (ML-KEM)*. 2024. https://nvlpubs.nist.gov/nistpubs/fips/nist.fips.203.pdf
11. WhatsApp. *WhatsApp Encryption Overview (Security Whitepaper)*. 2023. https://www.whatsapp.com/security/WhatsApp-Security-Whitepaper.pdf
12. Lund, J. *Technology preview: Sealed sender for Signal*. Signal, 2018. https://signal.org/blog/sealed-sender/
13. Miculan, M.; Vitacolonna, N. *Automated Symbolic Verification of Telegram's MTProto 2.0*. arXiv:2012.03141, 2020. https://arxiv.org/pdf/2012.03141v1
14. Session. *Session Protocol V2: PFS, Post-Quantum and the Future of Private Messaging*. 2025. https://getsession.org/session-protocol-v2
15. XMTP. *A Milestone & Metrics Driven Migration to Mainnet*. 2026. https://blog.xmtp.org/xmtps-decentralization-update-jan-2026/

### Privacidad de metadatos y anonimato
16. Session. *Onion requests and message routing*. 2024–2025. https://docs.getsession.org/session-network/session-protocol/onion-requests-and-message-routing
17. Oxen. *Session — Message routing*. Docs, s. f. (consultado 2026). https://docs.oxen.io/products-built-on-oxen/session/message-routing
18. Session. *The Session Token Launch Plan* y *FAQ*. 2025. https://token.getsession.org/launch-plan · https://token.getsession.org/faq
19. Piotrowska, A. M.; Hayes, J.; Elahi, T.; Meiser, S.; Danezis, G. *The Loopix Anonymity System*. USENIX Security, 2017. https://www.usenix.org/conference/usenixsecurity17/technical-sessions/presentation/piotrowska
20. Danezis, G.; Goldberg, I. *Sphinx: A Compact and Provably Secure Mix Format*. IEEE S&P, 2009. https://www.cs.uwaterloo.ca/~iang/pubs/Sphinx_Oakland09.pdf · Especificación Katzenpost: https://katzenpost.network/docs/specs/sphinx/
21. Diaz, C.; Halpin, H.; Kiayias, A. *The Nym Network* (whitepaper). 2021. https://www.intgovforum.org/sites/default/files/webform/igf_2022_workshop_proposal_form/229470/nym-whitepaper.pdf
22. Diaz, C.; Halpin, H.; Kiayias, A. *Reward Sharing for Mixnets* (Nym cryptoeconomics). 2021–2022. https://nym.com/nym-cryptoecon-paper.pdf
23. Nym. *Mixnet Rewards* (documentación de operadores). 2025. https://www.nym.com/docs/operators/tokenomics/mixnet-rewards
24. Nym. *zk-nym overview*. 2025. https://nym.com/docs/network/cryptography/zk-nym/zk-nym-overview · TechRadar, *NymVPN officially launches*, 2025 *(secundaria)*: https://techradar.com/vpn/vpn-services/nymvpn-officially-launches-and-claims-to-be-the-worlds-most-secure-vpn
25. Dingledine, R.; Mathewson, N.; Syverson, P. *Tor: The Second-Generation Onion Router*. USENIX Security, 2004. https://www.usenix.org/conference/13th-usenix-security-symposium/tor-second-generation-onion-router
26. Thorén, O.; Taheri-Boshrooyeh, S.; Cornelius, H. *Waku: A Family of Modular P2P Protocols For Secure & Censorship-Resistant Communication*. arXiv:2207.00038, ICDCSW 2022. https://arxiv.org/abs/2207.00038
27. Taheri-Boshrooyeh, S. et al. *WAKU-RLN-RELAY: Privacy-Preserving Peer-to-Peer Economic Spam Protection*. arXiv:2207.00117, 2022. https://arxiv.org/pdf/2207.00117.pdf
28. PSE (Ethereum Foundation). *Rate-Limiting Nullifier (RLN)*. 2023. https://pse.dev/blog/rate-limiting-nullifier-rln · Vac: https://vac.dev/rln
29. SimpleX. *SimpleX Messaging Protocol — overview (whitepaper)*. 2022–2024. https://github.com/simplex-chat/simplexmq/blob/stable/protocol/overview-tjr.md
30. Briar Project. *Secure messaging anywhere*. s. f. (consultado 2026). https://briarproject.org
31. van den Hooff, J.; Lazar, D.; Zaharia, M.; Zeldovich, N. *Vuvuzela: Scalable Private Messaging Resistant to Traffic Analysis*. SOSP, 2015. https://people.csail.mit.edu/matei/papers/2015/sosp_vuvuzela.pdf
32. Angel, S.; Setty, S. *Unobservable Communication over Fully Untrusted Infrastructure (Pung)*. OSDI, 2016. https://www.usenix.org/conference/osdi16/technical-sessions/presentation/angel
33. Tyagi, N.; Gilad, Y.; Leung, D.; Zaharia, M.; Zeldovich, N. *Stadium: A Distributed Metadata-Private Messaging System*. SOSP, 2017. https://eprint.iacr.org/2016/943
34. Lazar, D.; Gilad, Y.; Zeldovich, N. *Karaoke: Distributed Private Messaging Immune to Passive Traffic Analysis*. OSDI, 2018. https://www.usenix.org/conference/osdi18/presentation/lazar
35. Das, D.; Meiser, S.; Mohammadi, E.; Kate, A. *Anonymity Trilemma: Strong Anonymity, Low Bandwidth Overhead, Low Latency — Choose Two*. IEEE S&P, 2018. https://eprint.iacr.org/2017/954
36. Vyzovitis, D. et al. *GossipSub v1.1 Evaluation Report*. Protocol Labs, 2020. https://research.protocol.ai/publications/gossipsub-v1.1-evaluation-report/

### Redes de relevo con incentivos y DePIN
37. HOPR. *RFC-0005: Proof of Relay*. 2023–2024. https://rfc.hoprnet.org/RFC-0005-proof-of-relay/proof-of-relay
38. SendingNetwork. *Proof of Relay / Proof of Availability (KZG)*. arXiv:2401.09102, 2024. https://arxiv.org/html/2401.09102v1
39. Olshansky, D.; Rodríguez Colmeiro, R. *Relay Mining: Incentivizing Full Non-Validating Nodes Servicing All RPC Types*. arXiv:2305.10672, 2023. https://arxiv.org/pdf/2305.10672
40. Pocket Network. *Sessions, Claims & Proofs (Shannon)*. 2025. https://docs.pocket.network/protocol/sessions-claims-proofs/
41. Ghosh, M.; Richardson, M.; Ford, B.; Jansen, R. *A TorPath to TorCoin: Proof-of-Bandwidth Altcoins for Compensating Relays*. HotPETS, 2014. https://dedis.cs.yale.edu/dissent/papers/hotpets14-torpath-abs
42. Biryukov, A.; Pustogarov, I. *Proof-of-Work as Anonymous Micropayment: Rewarding a Tor Relay*. Financial Cryptography, 2015. https://rd.springer.com/chapter/10.1007/978-3-662-47854-7_27
43. Helium. *Solana Migration Overview* (HIP-70, migración del 18-04-2023). 2023. https://docs.helium.com/solana
44. Helium. *The Helium Network Token* y *HIP-20: HNT Max Supply*. 2020–2025. https://docs.helium.com/tokens/ · https://raw.githubusercontent.com/helium/HIP/main/0020-hnt-max-supply.md
45. Helium. *Denylist Evolution*. 2023. https://docs.helium.com/devblog/2023/08/07/denylist-evolution
46. Filecoin. *Proofs (PoRep y PoSt)*. Docs, 2024–2025. https://docs.filecoin.io/basics/the-blockchain/proofs
47. Filecoin. *Minting Model* (spec). https://spec.filecoin.io/systems/filecoin_token/minting_model/ · BlockScience, *Baseline Minting Incentives*, 2020: https://medium.com/block-science/baseline-minting-incentives-743b229b9b80
48. Storj Labs. *Storj: A Decentralized Cloud Storage Network Framework* v3.0 (2018) / v3.1 (2024). https://static.storj.io/storjv3.pdf
49. Storj Community. *Future changes to Reed Solomon numbers* (29/80). 2020. https://forum.storj.io/t/future-changes-to-reed-solomon-numbers/9921
50. Paradigm Research. *Theta: Blockchain-powered video streaming with microeconomy*. 2018 *(secundaria)*. https://medium.com/paradigm-research/theta-blockchain-powered-video-streaming-with-microeconomy-c865217ba81b
51. Mysterium Network. *Whitepaper* (2017) e *Introducing the Mysterium Payment System* (Hermes, 2019). https://c3.coinlore.com/pdf/mysterium-white-paper.pdf · https://medium.com/mysterium-network/introducing-the-mysterium-payment-system-7ebb87d1fa22
52. Orchid. *Introducing Nanopayments* y *Nanopayments* (PDF). 2019. https://blog.orchid.com/introducing-nanopayments/ · https://orchid.com/Nanopayments-3.pdf
53. Poon, J.; Dryja, T. *The Bitcoin Lightning Network: Scalable Off-Chain Instant Payments*. 2016. https://www.Lopp.net/pdf/lightning-network-paper.pdf
54. Lin, Z. et al. *Decentralized Physical Infrastructure Network (DePIN): Challenges and Opportunities*. arXiv:2406.02239, 2024 (IEEE Network 2025). https://arxiv.org/pdf/2406.02239
55. Ballandies, M. C. et al. *A Taxonomy for Blockchain-based Decentralized Physical Infrastructure Networks (DePIN)*. arXiv:2309.16707, 2023. https://arxiv.org/pdf/2309.16707
56. *A Survey of Decentralized Physical Infrastructure Network, Research Directions, and Open Challenges*. arXiv:2609.02125, 2026 (preprint). https://arxiv.org/pdf/2609.02125

### Consenso y rendimiento
57. Buchman, E.; Kwon, J.; Milosevic, Z. *The latest gossip on BFT consensus* (Tendermint). arXiv:1807.04938, 2018. https://arxiv.org/abs/1807.04938v2
58. Yin, M.; Malkhi, D.; Reiter, M. K.; Gueta, G. G.; Abraham, I. *HotStuff: BFT Consensus in the Lens of Blockchain*. PODC, 2019. https://arxiv.org/abs/1803.05069
59. Danezis, G.; Kokoris-Kogias, L.; Sonnino, A.; Spiegelman, A. *Narwhal and Tusk: A DAG-based Mempool and Efficient BFT Consensus*. EuroSys, 2022. https://arxiv.org/abs/2105.11827
60. Spiegelman, A.; Giridharan, N.; Sonnino, A.; Kokoris-Kogias, L. *Bullshark: DAG BFT Protocols Made Practical*. ACM CCS, 2022. https://arxiv.org/abs/2201.05677
61. Babel, K. et al. *Mysticeti: Reaching the Latency Limits with Uncertified DAGs*. NDSS, 2025. https://arxiv.org/abs/2310.14821v6
62. Sui. *Mysticeti v2: Faster and Lighter Sui Transaction Processing*. 2025. https://www.sui.io/blog/mysticeti-v2-sui-consensus
63. Team Rocket et al. *Scalable and Probabilistic Leaderless BFT Consensus through Metastability* (Avalanche). arXiv:1906.08936, 2019–2020. https://arxiv.org/abs/1906.08936
64. Al-Bassam, M. *LazyLedger: A Distributed Data Availability Ledger With Client-Side Smart Contracts*. arXiv:1905.09274, 2019. https://arxiv.org/pdf/1905.09274
65. Szilágyi, P. *EIP-225: Clique proof-of-authority consensus protocol*. 2017. https://eips.ethereum.org/EIPS/eip-225
66. Buterin, V.; Griffith, V. *Casper the Friendly Finality Gadget*. arXiv:1710.09437, 2017. https://arxiv.org/pdf/1710.09437
67. *Fast Tendermint: Speeding Up a Foundational Consensus Protocol*. arXiv:2608.13434, 2026 (preprint). https://arxiv.org/pdf/2608.13434
68. Nakamoto, S. *Bitcoin: A Peer-to-Peer Electronic Cash System* (anuncio en la lista Cryptography). 2008. https://www.metzdowd.com/pipermail/cryptography/2008-October/014810.html

### Economía del token
69. Roughgarden, T. *Transaction Fee Mechanism Design for the Ethereum Blockchain: An Economic Analysis of EIP-1559*. arXiv:2012.00854, 2020. https://alphaxiv.org/abs/2012.00854
70. Roughgarden, T. *Transaction Fee Mechanism Design*. ACM EC, 2021. https://export.arxiv.org/abs/2106.01340
71. Liu, Y. et al. *Empirical Analysis of EIP-1559: Transaction Fees, Waiting Time, and Consensus Security*. ACM CCS, 2022. https://arxiv.org/abs/2201.05574
72. Blockworks. *Ethereum hits longest inflationary period since Merge*. 2024–2025 *(secundaria)*. https://blockworks.co/news/ethereum-longest-inflationary-period-since-merge
73. Solana. *Transaction Fees* (comisión base de 5.000 lamports; 50 % quemado). Docs, 2025. https://solana.com/docs/core/fees.md
74. The Block. *Solana validators to receive full priority fees as SIMD-0096 proposal gains approval*. 2024 *(secundaria)*. https://www.theblock.co/post/296932/solana-validators-to-receive-full-priority-fees-as-simd-0096-proposal-gains-approval
75. Solana. *Inflation Schedule* (8 % inicial, −15 %/año, 1,5 % a largo plazo). Docs. https://solana.com/docs/economics/inflation/inflation-schedule · Helius, *SIMD-550*, 2026: https://helius.dev/blog/simd-550-solana-disinflation
76. XRP Ledger. *Transaction Cost* (10 drops, destruidos). Docs. https://xrpl.org/transaction-cost.html
77. Algorand. *Transaction Fees* (mínimo 0,001 ALGO). Docs. https://dev.algorand.co/concepts/transactions/fees/
78. Stellar. *Fees, Resource Limits and Metering* (100 stroops por operación; precios en congestión). Docs. https://developers.stellar.org/docs/learn/fundamentals/fees-resource-limits-metering
79. Sui. *Gas Pricing* (precio de referencia por época) y *Sui Tokenomics*. Docs/blog. https://docs.sui.io/learn/tokenomics/gas-pricing · https://blog.sui.io/sui-tokenomics/
80. Celo. *Fee currency / Fee Abstraction*. Docs. https://docs.celo.org/developer/fee-currency
81. OtterSec. *ERC-4337 paymasters: better UX, hidden risks*. Blog *(secundaria)*. https://osec.io/blog/paymasters-evm
82. Samani, K. *Understanding Token Velocity*. Multicoin Capital, 2017. https://multicoin.capital/zh/2017/12/08/understanding-token-velocity · CoinDesk, 2017: https://dev.coindesk.com/markets/2017/12/08/the-blockchain-token-velocity-problem
83. Solana Compass. *Breakpoint 2023: Burn-and-Mint Goldilocks Tokenomics for DePIN*. 2023 *(secundaria)*. https://about.solanacompass.com/learn/breakpoint-23/breakpoint-2023-burn-and-mint-goldilocks-tokenomics-for-depin
84. Back, A. *Hashcash — A Denial of Service Counter-Measure*. 2002. https://sites.cs.ucsb.edu/~rich/class/cs293b-cloud/papers/hascash2.pdf
85. Douceur, J. R. *The Sybil Attack*. IPTPS, LNCS 2429, 2002. https://www.doi.org/10.1007/3-540-45748-8_24
86. Kamvar, S. D.; Schlosser, M. T.; Garcia-Molina, H. *The EigenTrust Algorithm for Reputation Management in P2P Networks*. WWW, 2003. https://zoo.cs.yale.edu/classes/cs457/fall13/Eigentrust.pdf
87. Uniswap. *Oracles (TWAP)*. Docs v2. https://developers.uniswap.org/docs/protocols/v2/concepts/oracles
88. YourStory. *Non-profit text-app Signal says it will cost $50M a year to run*. 2023 *(secundaria)*. https://YourStory.com/2023/11/private-text-app-signal-meredith-whittaker-joshua-lund

### Regulación
89. ESMA. *MiCA — Article 4: Offers to the public of crypto-assets other than ART or EMT* (Interactive Single Rulebook; Reglamento UE 2023/1114). 2023. https://www.esma.europa.eu/publications-and-data/interactive-single-rulebook/mica/article-4-offers-public-crypto-assets-other
90. ESMA. *Markets in Crypto-Assets Regulation (MiCA)* y registro provisional. 2024–2026. https://www.esma.europa.eu/esmas-activities/digital-finance-and-innovation/markets-crypto-assets-regulation-mica
91. PwC Legal. *MiCAR: final guidelines on qualification of crypto-assets as financial instruments* (Guías CAFI de ESMA, dic. 2024). 2024 *(secundaria)*. https://legal.pwc.de/en/news/articles/micar-final-guidelines-on-qualification-of-crypto-assets-as-financial-instruments
92. Cuatrecasas. *MiCA: claves interpretativas de la CNMV*. 2025. https://www.cuatrecasas.com/es/latam/financiero/art/mica-cnmv-claves-interpretativas · DiarioBitcoin, *España publica criterios para la transición… antes de julio de 2026*: https://www.diariobitcoin.com/criptomonedas/espana-publica-criterios-para-la-transicion-de-exchanges-cripto-a-mica-antes-de-julio-2026/
93. 21 Analytics. *Regulatory Frameworks that Include Self-hosted Wallets* (Reglamento UE 2023/1113). 2024 *(secundaria)*. https://21analytics.ch/blog/regulatory-frameworks-self-hosted-wallets
94. Cointelegraph. *EU to ban anonymous crypto accounts and privacy tokens by 2027* (AMLR, Reglamento UE 2024/1624). 2025 *(secundaria)*. https://cointelegraph.com/news/eu-crypto-ban-anonymous-privacy-tokens-2027
95. eucrim. *CSA Regulation: Council Position Reached*. 2025. https://eucrim.eu/news/csa-regulation-council-position-reached/pdf/ · EU Perspectives, *Breyer warns chat control decision moves into 2026*: https://euperspectives.eu/2025/12/breyer-warns-chat-control-decision-moves-into-2026/
96. EDPB. *Guidelines 02/2025 on processing of personal data through blockchain technologies*. 2025. https://www.edpb.europa.eu/our-work-tools/documents/public-consultations/2025/guidelines-022025-processing-personal-data_en · Resumen Mondaq: https://www.mondaq.com/unitedstates/fin-tech/1642246/new-edpb-guidelines-processing-personal-data-on-blockchain
97. Circle. *Circle is First Global Stablecoin Issuer to Comply with MiCA*. 2024. https://www.circle.com/pressroom/circle-is-first-global-stablecoin-issuer-to-comply-with-mica-eus-landmark-crypto-law
98. Wikipedia. *Session (software)* (anuncio de la STF, abril de 2026). Consultado 2026 *(secundaria, sin confirmar)*. https://en.wikipedia.org/wiki/Session_(software)
99. Nym. *The Nym mainnet reward scheme is being activated*. Blog, 2022. https://nym.com/blog/the-nym-mainnet-reward-scheme-is-being-activated
