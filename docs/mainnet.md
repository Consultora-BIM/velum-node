# Velum mainnet — plan de lanzamiento

> Cadena: `velum-mainnet-1`. Se construye con `VELUM_NETWORK=mainnet` (por defecto). La testnet sigue con `VELUM_NETWORK=testnet`.
> Este documento manda sobre `protocolo-v3.md` donde choquen. **No somos abogados**: la sección 10 resume fuentes públicas y debe validarla una asesoría antes de abrir nada que mueva dinero de terceros.

## 1. Resumen

- La mainnet nace **sin grifo** y **sin tokens de prueba**. Nadie recibe VEL gratis en el arranque.
- Los saldos de la testnet **no pasan** a la mainnet. No hay canje ni promesa de canje ([investigacion §8.2](investigacion.md)).
- El único activo envuelto es **vUSDT**: 1 vUSDT = 1 USDT guardado por la **pasarela USDT**. La pasarela nace **cerrada**.
- Vocabulario (protocolo-v3 §14): los nodos **descubren VEL abriendo puentes** (rutas que llevan mensajes). **Nunca se destruye VEL.** Para no confundir, el servicio USDT ⇄ vUSDT se llama aquí **pasarela** (en el código, `bridge`).
- Las actualizaciones **nunca reinician la cadena**: los saldos sobreviven a cualquier versión futura (§5).
- Los nodos son **anónimos**: se identifican por su dirección; no publican nombre, equipo ni IP (§8).

## 2. Génesis

| Concepto | Valor | Dónde |
|---|---|---|
| `CHAIN_ID` | `velum-mainnet-1` | `packages/core/src/network.ts` |
| Tope absoluto | 1.000.000.000 VEL | `MAX_SUPPLY` |
| Reserva de génesis | **100.000.000 VEL** (10 %) a la **cartera fría** | dirección leída de `cold-wallet.public.json` |
| Descubrimiento por trabajo | 900.000.000 VEL, mitad cada ~2 años | `R0`, `HALVING_EPOCHS` (reescalados a épocas de 1 h) |
| Época | **1 h** (1.800 bloques; ritmo nominal, el explorador muestra el medido) | `EPOCH_BLOCKS` |
| Grifo | **no existe** | — |
| Tokens de prueba (`tEUR`, `tUSD`, `tUSDT`) | **no existen** | — |
| Token envuelto | `vUSDT`, 6 decimales, emisor = clave de la pasarela | `bridge.public.json` |
| Par principal | `VEL/vUSDT` | oráculo y mercado |

**La compilación falla** si falta `cold-wallet.public.json` o `bridge.public.json`, o si su huella no cuadra. Así es imposible arrancar una mainnet con la reserva en una dirección equivocada.

### 2.1 Uso de la reserva de 100 M VEL (propuesta, sin decidir)

La cadena solo sabe que los 100 M están en la cartera fría. Su uso es una decisión del propietario. Propuesta derivada de [investigacion §5.8](investigacion.md), adaptada al 10 % de génesis:

| Bloque | VEL | Condición |
|---|---|---|
| Reserva de arranque de nodos | 30 M | Se entrega a quienes abren puentes con `pool.fund`, por épocas, nunca de golpe |
| Ecosistema, auditorías, becas | 25 M | Pagos con factura y en público |
| Tesorería del proyecto | 25 M | Liberación lineal en 4 años |
| Equipo | 15 M | 1 año de bloqueo + 3 lineales |
| Reserva estratégica | 5 M | **Solo con documento MiCA** si se ofrece a cambio de dinero (§10) |

Cualquier **venta** de VEL de esta reserva es una oferta al público y puede exigir white paper (§10). Regalar o pagar trabajo no es venta, pero ojo con pedir datos personales a cambio ([investigacion §8.1](investigacion.md), [89]).

## 3. Comisiones en mainnet

- Igual que v3: **nunca se destruye VEL**. Las comisiones se guardan: 80 % para quienes abren puentes de mensajes, 20 % en la Reserva de la Red.
- **Umbral de comisión en USDT dentro del consenso**: `FEE_FREE_USDT = 1.100 vUSDT` (≈ 1.000 € al cambio de referencia 0,92 €/$ que ya usa el oráculo). Por debajo, comisión 0 con sello PoW. Desde ahí, 1 pb del importe.
- El consenso **no usa euros**. El cambio a EUR solo se hace fuera de la cadena, en la app y la web, con una fuente pública de cambio. Si esa fuente falla, se muestra el importe en USDT. Nunca cambia lo que cobra la cadena.
- Oráculo: TWAP de la última hora del par `VEL/vUSDT`. Sin volumen suficiente (≥ 1.000 VEL en la hora) → «sin precio» → comisión 0.

## 4. Qué está activo y qué no el día 1

| Pieza | Día 1 | Condición para activarla |
|---|---|---|
| Cadena, pagos VEL, comisiones, oráculo | Activo | — |
| Mensajería, buzones, recibos, reclamaciones de trabajo | Activo | — |
| Niveles, fianza, staking delegado | Activo | — |
| Alias (`name.*`) | Activo | — |
| Mercado `VEL/vUSDT` | Activo en cadena, **vacío** | Sin vUSDT no hay órdenes de compra |
| Crear tokens propios | Activo (100 VEL a la Reserva) | — |
| Pasarela USDT ⇄ vUSDT | **Cerrada** (`BRIDGE_ENABLED=false`) | Revisión legal + decisión del propietario (§10) |
| Compra con euros | **No existe** | Solo vía un CASP autorizado externo |
| Atestación de dispositivo | `strict` en iOS | Android: Play Integrity pendiente |

## 5. Política de actualizaciones (sin reinicios)

Los saldos **nunca** se pierden por una actualización. Reglas:

1. Cada versión de protocolo tiene una **altura de activación** en la tabla `UPGRADES` (`packages/core/src/upgrades.ts`). Hasta esa altura se aplican las reglas viejas; desde ella, las nuevas.
2. Si cambia el formato del estado, la versión trae una **migración pura**: `migrate(estado) → estado`, sin reloj ni azar. Se aplica **una vez**, en el bloque de activación, antes de sus transacciones. Todos los nodos llegan a la misma raíz de estado.
3. Los nodos **guardan sus datos** al actualizar el binario. La base se llama por cadena (`velum-velum-mainnet-1.db`), no por versión.
4. Un binario viejo que llega a una altura que no conoce **se para** (no bifurca) y pide actualizar.
5. Aviso público con al menos **14 días** de antelación. El manifiesto firmado sube `minNodeVersion` antes de la altura.
6. **Fotos de estado**: `velum-node snapshot export|import`. Llevan altura, hash y raíz de estado; al importar se recalcula la raíz y, si no cuadra, se rechaza.
7. El indexador de la web reaplica bloques a través de las versiones con la misma tabla.
8. Prueba obligatoria por versión: cadena en versión N → binario N+1 con migración en H → saldos idénticos y raíces iguales en todos los nodos (`packages/core/test/upgrades.test.ts`).

No hay botón de reinicio. Si algo sale muy mal, la salida es otra actualización con migración, nunca borrar la cadena.

## 6. Pasarela USDT ⇄ vUSDT

Código: `apps/bridge`. Variables: `BRIDGE_ENABLED`, `BRIDGE_COLD_WALLET`, `BRIDGE_KEY_FILE`, `BRIDGE_VELUM_URL`, `BRIDGE_<CADENA>_RPC`. El nodo reenvía `bridge.*` si tiene `VELUM_BRIDGE_URL`; la web publica `/api/bridge/reserves` con `BRIDGE_URL`. Mensaje mientras está cerrada: «puente aún no abierto» (texto fijado en el encargo; conviene cambiarlo a «pasarela aún no abierta» si se acepta este vocabulario). Tests con cadenas simuladas: `bun test` en esa carpeta.

| Paso | Qué pasa |
|---|---|
| Pedir dirección | La cartera llama `bridge.address { chain, velAddress }`. La pasarela asigna un índice y deriva la dirección desde la **xpub** (BIP-44). En línea no hay claves privadas de depósito. |
| Depositar | El usuario manda USDT (TRC-20 en TRON o Polygon PoS; Ethereum opcional). |
| Confirmar | TRON 20 bloques, Polygon 128, Ethereum 12. |
| Acuñar | La pasarela firma `bridge.mint { to, amount, src, ref }`. `ref = cadena:hash:índice` es única en el estado: **la cadena no acuña dos veces el mismo depósito**. |
| Canjear | El usuario firma `bridge.redeem { dst, to, amount }`: canjea vUSDT por USDT. Ese vUSDT sale de la circulación porque se paga fuera. VEL nunca se toca. |
| Encolar | Tras 30 bloques Velum, la pasarela encola el pago con topes diarios y por cartera. |
| Firmar | `bun src/main.ts exportar` → archivo → equipo **sin conexión** → `scripts/firmar-retiros.ts` (frase sin eco) → archivo firmado. |
| Emitir | `scripts/emitir-retiros.ts` en el equipo en línea. La pasarela confirma sola. |
| Devolver | Un retiro imposible (dirección mala, fuera de límites) se **devuelve en vUSDT** con `ref = refund:<id>`. Nada se pierde. |

Límites de partida (los fija el propietario): retiro 10–10.000 USDT, 50.000 USDT/día, 5 retiros por cartera y día, 100.000 USDT/día de acuñación. Comisión de retiro: **0** hasta que el propietario decida otra cosa.

**Prueba de reservas** (`GET /reserves`, explorador › Reservas): USDT en direcciones de depósito + tesorería **frente a** vUSDT en circulación + retiros pendientes + depósitos sin acuñar. `ok = reservas ≥ deudas`. Si la clave del puente se filtra y alguien acuña de más, la prueba lo delata en la siguiente consulta.

Riesgos y defensas de la pasarela:

| Riesgo | Defensa |
|---|---|
| Robo del servidor de la pasarela | Solo tiene la clave de acuñar. Tope diario de acuñación. Las reservas delatan el descuadre. Rotación de clave por actualización (§5). |
| Cola de retiros manipulada | El firmante revisa cada línea, aplica **sus** topes (`--max`, `--tope`) y comprueba que el origen sale de la xpub. Hay que escribir `FIRMAR`. |
| Robo de la frase fría | Papel en dos sitios. Nunca en un ordenador conectado ni en un móvil. Próximo paso: multifirma (Safe en Polygon, permisos multifirma en TRON). |
| Reorganización de una cadena de origen | Confirmaciones por cadena (arriba). |
| Gas | Los barridos (`bun src/main.ts barrer <cadena>`) mandan primero gas desde la tesorería y luego el USDT a la tesorería. |

## 7. Cartera fría: procedimiento

Script: `apps/node/scripts/cold-wallet.ts`. **Lo ejecuta el propietario en su terminal.** Nunca un agente, un CI ni una sesión grabada.

1. Ordenador sin red (Wi-Fi apagado, cable fuera). Terminal a pantalla completa. Nadie mirando.
2. `bun apps/node/scripts/cold-wallet.ts --out <carpeta>`.
3. Aparecen 24 palabras **solo en la terminal**. No van a disco, a stdout ni a ningún log. Cópialas a mano en papel.
4. Pulsa Intro: se borra la pantalla y el historial. El script pide dos palabras al azar (sin eco) para comprobar la copia.
5. Se escribe `cold-wallet.public.json`: dirección Velum (SLIP-10, `m/44'/7420'/0'/0'/0'`), xpub TRON (`m/44'/195'/0'`), xpub EVM (`m/44'/60'/0'`), tesorerías y huella. **Solo datos públicos.**
6. Dos copias en papel, en dos sitios distintos. Comprobar cada copia con `--verificar`.
7. El archivo público se copia al repositorio de despliegue y al servidor de la pasarela.
8. **Nunca** se escribe esta frase en la app de Velum de un móvil. La misma frase abre la cartera Velum de la reserva.

## 8. Nodos anónimos

- Un nodo es su **dirección**. Las pantallas muestran `4 primeros…4 últimos` y un identicono que sale de la dirección.
- `name` es opcional y solo decorativo. Por defecto va vacío. Nunca sale del hostname, del usuario ni del sistema.
- `version` muestra solo la versión de protocolo.
- Detrás de la puerta (`hub`), un nodo no publica `endpoint` salvo que su operador lo configure. La puerta nunca enseña IPs.

## 9. Pasos de lanzamiento (en orden)

1. Revisión legal (§10) y decisión sobre el uso de la reserva (§2.1).
2. El propietario genera la cartera fría (§7) → `cold-wallet.public.json`.
3. El responsable genera la clave de la pasarela: `bun apps/bridge/scripts/clave-puente.ts` → `bridge.public.json`.
4. Copiar los dos `.public.json` a la raíz del repo de despliegue.
5. `bun packages/core/scripts/genesis-mainnet.ts --time <hora en punto UTC>` → escribe `packages/core/genesis/mainnet.json` (falla si falta algo).
6. Pruebas: `bun run test` (testnet), `bun run test:mainnet`, `bun run e2e:mainnet` y `bun test` en `apps/bridge` y `packages/sdk`.
7. Compilar binarios (`bun apps/node/scripts/release.ts`): la red va **dentro** del binario (`--define __VELUM_NETWORK__`) y la compilación se para si la génesis no está completa.
8. Arrancar los validadores iniciales y la puerta. Comprobar `velLedgerGap = 0` y la reserva en el explorador.
9. Arrancar la pasarela con `BRIDGE_ENABLED=false`. Comprobar `/reserves` y `/api/bridge/reserves`.
10. Tras la revisión legal: `BRIDGE_ENABLED=true`. Primer retiro de prueba con importe pequeño.

### 9.1 Red por defecto y compilaciones

- El núcleo es **mainnet por defecto**. La testnet se elige con `VELUM_NETWORK=testnet` (en marcha) o `--define __VELUM_NETWORK__='"testnet"'` (compilación).
- **Ojo antes del próximo despliegue de la web o de la app:** si se compilan sin ese `define`, saldrán en mainnet y, mientras `genesis/mainnet.json` esté vacía, la puerta no arrancará. Hasta el lanzamiento: Worker (`wrangler`), Vite y Metro con `__VELUM_NETWORK__="testnet"`.
- Los tests y el e2e de siempre corren en testnet (precarga `packages/core/test/red-de-pruebas.ts`); los de mainnet, con `test:mainnet` y `e2e:mainnet`.

## 10. Notas legales (UE y España)

> Resumen de fuentes públicas. Debe validarlo una asesoría especializada. Las referencias `[n]` son de la bibliografía de [investigacion.md](investigacion.md).

**Oferta de VEL al público (MiCA, Reglamento UE 2023/1114, Título II).**

- Quien ofrezca al público un criptoactivo que no sea una moneda estable debe, en general, ser persona jurídica, **redactar un white paper**, **notificarlo** a la autoridad competente (en España, la **CNMV**) y publicarlo [89][92].
- **Exenciones de la oferta** (art. 4.2) [89]: oferta a **menos de 150 personas** físicas o jurídicas **por Estado miembro**; oferta que en **12 meses** no supere **1 M€**; oferta dirigida **solo a inversores cualificados**.
- **Excepciones del art. 4.3** [89]: criptoactivos **gratis**, los creados **como premio por mantener el registro** (las recompensas de nodos) y los **tokens de utilidad** de un servicio que ya funciona.
- Las excepciones **no se aplican** si se pide la admisión a negociación en una plataforma [89].
- No prometer rentabilidad: puede convertir VEL en instrumento financiero (guías CAFI de ESMA) [91].

**La pasarela es un servicio sobre criptoactivos de terceros.**

- Guardar USDT de usuarios y entregar vUSDT a cambio se parece a **custodia** y a **cambio de criptoactivos por otros criptoactivos**. Ambos son servicios de **CASP** y exigen **autorización** (en España, de la CNMV; el periodo transitorio acabó el 1 de julio de 2026) [90][92].
- Hay que valorar si `vUSDT` encaja como e-money token o token referenciado a activos. Además, hay que comprobar si **USDT** figura como EMT autorizada en el registro de ESMA [90][97]; si no figura, un CASP de la UE puede no poder ofrecerlo.
- Por eso la pasarela nace **cerrada** y solo se abre con informe legal favorable, o a través de un CASP autorizado que lo opere.

**Antiblanqueo.**

- Reglamento de transferencias (UE 2023/1113): un CASP debe comprobar que el cliente controla una dirección autoalojada si la transferencia supera 1.000 € [93]. La pasarela, como CASP, necesitaría identificar a sus usuarios (KYC).
- AMLR (UE 2024/1624), desde julio de 2027: los CASP no podrán ofrecer cuentas anónimas ni *privacy coins* [94]. VEL tiene libro público; evitar el discurso de «moneda anónima».

**Otros.**

- RGPD: nada personal en la cadena; evaluación de impacto [96].
- Fiscalidad de las recompensas de nodos: consulta a asesoría fiscal ([investigacion §8.3](investigacion.md)).
- *Chat Control*: seguimiento legal; el diseño no permite escanear contenido [95].
