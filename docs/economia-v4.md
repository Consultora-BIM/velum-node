# Velum — Economía v4: tope de 21.000 M VEL, mitades cada 4 años y créditos para empresas

> Se aplica encima de `protocolo-v3.md` §1 y §5 y de `mainnet.md` §2–3. Donde choquen, manda este documento.
> **Estado:** decisiones del propietario cerradas (1 de noviembre de 2026). El código se está cambiando en paralelo: si `packages/core` aún dice otra cosa (µVEL, 1.000 M VEL, mitad cada 2 años), es la versión anterior.
> Los números entre corchetes, como [3], remiten a las referencias del final (§11). Todo lo marcado **supuesto** es una hipótesis nuestra, no un dato.

---

## 1. Parámetros

| Parámetro | Valor | Nota |
|---|---|---|
| Unidad mínima | **1 velo** = 10⁻¹⁸ VEL | 18 decimales. Importes en `BigInt`; en la red, texto decimal (`"1000000000000000000"` = 1 VEL) |
| Tope absoluto | **21.000.000.000 VEL** | Como Bitcoin, ×1.000 [1][2] |
| Reserva de génesis | 100.000.000 VEL | Cartera fría (`mainnet.md` §2.1) |
| Descubrible por trabajo | **20.900.000.000 VEL** | Tope − génesis |
| Época | 1 h = 1.800 bloques de 2 s (nominal) | 8.766 épocas al año (365,25 días) |
| Mitad | cada **35.064 épocas** = 4 años | `R(e) = R0 >> floor(e / 35.064)` |
| Fin de la emisión | tras **33 mitades** (`k ≥ 33 → 0`) | ≈ 132 años, como Bitcoin [2] |
| `R0` | **298.026,465890942276979237 VEL/época** | = 298.026.465.890.942.276.979.237 velos |
| Quema | **ninguna**. VEL nunca se destruye | El canje de vUSDT → USDT se llama «canjear» |
| Pagos y mercado < 1.100 vUSDT | comisión 0 + sello PoW | ≈ 1.000 € a 0,92 €/$ |
| Pagos y mercado ≥ 1.100 vUSDT | **1 pb (0,01 %)** del VEL | 80 % bolsa de nodos · 20 % Reserva de la Red |
| Reserva de la Red | libera **0,1 %** de su saldo por época a la bolsa | Vida media ≈ 693 épocas ≈ 29 días |
| Crear token | 100 VEL → Reserva | Antispam |
| Créditos de mensajes | `credits.buy`: 22 µUSDT por crédito | ≈ 2,02 € por 100.000 mensajes; VEL 100 % a la bolsa |
| Cupo gratis | 20 mensajes / 10 min ≈ 2.880 al día | Igual que `investigacion.md` §5.7.1 |
| Reparto de la bolsa | 15 % productores de bloques · 85 % trabajo verificado | Igual que v3 |

---

## 2. Fórmulas exactas (enteros)

Todo en velos (`BigInt`). `>>` es desplazamiento a la derecha (división entre 2ᵏ con suelo). Nada de decimales en la máquina de estados.

```text
VELO          = 10^18                                   // velos por VEL
CAP           = 21_000_000_000 · VELO
GENESIS       = 100_000_000 · VELO
MINEABLE      = CAP − GENESIS                           // 20.900.000.000 VEL
HALVING       = 35_064                                  // épocas (4 × 8.766)
R0            = floor(MINEABLE / (2 · HALVING))         // 298.026.465.890.942.276.979.237 velos

k(e)          = floor(e / HALVING)
R(e)          = k(e) ≥ 33 ? 0 : R0 >> k(e)
emision(e)    = produjo_alguien ? min(R(e), CAP − supply.minted) : 0    // minted incluye GENESIS

valor(a)      = floor(a · P / VELO)                     // µUSDT; P = TWAP del oráculo en µUSDT por VEL
fee(a)        = (P ≠ null y valor(a) ≥ 1_100_000_000) ? max(1, floor(a · 1 / 10_000)) : 0
pool_fee      = floor(fee · 8_000 / 10_000)             // 80 % a la bolsa de la época
reserve_fee   = fee − pool_fee                          // 20 % a vel_reserve

creditos(a)   = floor(a · P / (VELO · 22))              // exige P ≠ null y a ≥ 1 · VELO

liberacion(e) = floor(saldo(vel_reserve) · 10 / 10_000) // 0,1 %
bolsa(e)      = Σ pool_fee(e) + Σ VEL de credits.buy(e) + liberacion(e) + emision(e)
productores   = produjo_alguien ? floor(bolsa · 1_500 / 10_000) : 0
trabajo(e)    = bolsa − productores                     // se liquida en E+4 ∝ créditos verificados
```

Comprobaciones:

- Con suelo entero, `Σ_{k=0..32} HALVING · (R0 >> k) = 20.899.999.997,567 VEL`. Quedan **2,43 VEL** sin descubrir nunca. El tope no se toca jamás.
- `R0 >> 32 = 0,0000694 VEL/época`. La regla `k ≥ 33 → 0` corta ahí; sin ella, `R0` (78 bits) seguiría dando migajas hasta la mitad 77.
- **Invariante** (como v3 §D): `Σ saldos VEL + bolsa + Σ workPots == supply.minted`. `supply.burned` es siempre 0.
- **Vida media de la Reserva:** `ln 2 / −ln(1 − 0,001) = 692,8 épocas = 28,9 días`. Un VEL que entra tarda de media **1.000 épocas (≈ 42 días)** en salir.

---

## 3. Calendario de emisión

Año = final del periodo. «% descubierto» sobre 20.900 M; «% del tope» incluye los 100 M de génesis.

| Periodo `k` | Años | VEL por época | VEL por día | % descubierto al final | % del tope al final |
|---|---|---|---|---|---|
| 0 | 0–4 | 298.026,47 | 7.152.635 | 50,00 % | 50,24 % |
| 1 | 4–8 | 149.013,23 | 3.576.318 | 75,00 % | 75,12 % |
| 2 | 8–12 | 74.506,62 | 1.788.159 | 87,50 % | 87,56 % |
| 3 | 12–16 | 37.253,31 | 894.079 | 93,75 % | 93,78 % |
| 4 | 16–20 | 18.626,65 | 447.040 | 96,87 % | 96,89 % |
| 5 | 20–24 | 9.313,33 | 223.520 | 98,44 % | 98,44 % |
| 6 | 24–28 | 4.656,66 | 111.760 | **99,22 %** | 99,22 % |
| 7 | 28–32 | 2.328,33 | 55.880 | 99,61 % | 99,61 % |
| 8 | 32–36 | 1.164,17 | 27.940 | 99,80 % | 99,81 % |
| … | … | … | … | … | … |
| 32 | 128–132 | 0,0000694 | 0,0017 | 99,99999999 % | 99,99999999 % |
| ≥ 33 | > 132 | 0 | 0 | — | — |

Lectura:

- **Año 1:** se descubren 2.612,5 M VEL (12,5 % del total). Al mes, ≈ 217,7 M VEL.
- **Tras 7 mitades (año 28):** ya está el 99,2 %. A partir de ahí la emisión **no sostiene** a nadie. Lo que pague a los nodos tendrá que salir del uso (§6).
- Es el mismo perfil que Bitcoin: 210.000 bloques por mitad (~4 años), 21 M de tope, último satoshi hacia 2140 [1][2].

---

## 4. De dónde sale el ingreso de un nodo

| Fuente | Quién paga | Va a | ¿Depende del precio de VEL en €? |
|---|---|---|---|
| Emisión `R(e)` | nadie (nuevo VEL) | bolsa | **Sí, del todo** |
| Comisión 1 pb (≥ 1.100 vUSDT) | quien paga o el taker del mercado | 80 % bolsa · 20 % Reserva | No: es el 0,01 % del valor |
| Créditos de mensajes | empresas y bots por encima del cupo | 100 % bolsa | No: precio fijo en USDT |
| Crear token | quien lo crea | 100 % Reserva | Sí (100 VEL fijos) |
| Liberación de la Reserva | la propia Reserva | bolsa | — (devuelve lo que entró) |

**La Reserva no crea dinero: lo retrasa.** En régimen estable, lo que libera cada época iguala lo que entra. Su saldo de equilibrio es `entrada por época / 0,001` = 1.000 épocas de entradas. Suaviza picos y huecos de ~1–2 meses, como la reserva de Nym [14] o el *baseline minting* de Filecoin [15]. **No es una hucha de años.**

Por eso, cuando acabe la emisión, a largo plazo la bolsa ≈ **100 % de las comisiones + 100 % de los créditos + las altas de tokens**.

---

## 5. Hoy: ingreso dominado por la emisión

### 5.1 Hipótesis

| Hipótesis | Valor | Fuente |
|---|---|---|
| Mensajes al día (escala WhatsApp) | 100.000 M | WhatsApp, 2020 [5]; `escalado.md` §1 |
| Usuarios | 10⁹ (WhatsApp declara > 3.000 M al mes [6]) | `escalado.md` §1 |
| Tráfico de trozos | ≈ 1 Tbit/s en total | `escalado.md` §1–2 |
| Reparto | uniforme entre nodos; nivel y fianza no cambian la media | supuesto |
| Precio de VEL | 0,0001 / 0,001 / 0,01 €/VEL | **supuestos**, no previsiones |

### 5.2 Ingreso medio por nodo (periodo 0, años 0–4)

`VEL/mes por nodo = R0 × 730,5 / N` (la media incluye el 15 % de productores).

| Nodos `N` | VEL/mes | € a 0,0001 | € a 0,001 | € a 0,01 |
|---|---|---|---|---|
| 10³ | 217.708 | 21,77 € | 217,71 € | 2.177,08 € |
| 10⁶ | 217,71 | 0,022 € | 0,22 € | 2,18 € |
| 10⁹ | 0,2177 | 0,00002 € | 0,0002 € | **0,002 €** |

Periodo 7 (años 28–32): todo **÷ 128**. Con 10⁶ nodos y VEL a 0,01 €, ≈ 0,017 €/mes.

### 5.3 Coste de un nodo

| `N` | Tipo de nodo | Tráfico medio (`escalado.md` §2) | Datos/mes | Coste/mes |
|---|---|---|---|---|
| 10³ | Servidor en CPD | 1 Gbit/s (pico 3) | ≈ 329 TB | **≈ 500 €** (supuesto: dedicado con 10 Gbit/s sin medir) |
| 10⁶ | Mini-PC en casa con fibra | 1 Mbit/s | ≈ 329 GB | **19,60 €** (luz 14,60 € + amortización 5 €; `investigacion.md` §6.1) |
| 10⁹ | Móvil con Wi-Fi | 1 kbit/s | ≈ 0,33 GB | **≈ 0,05 €** (supuesto: ~0,3 W extra × 730 h × 0,20 €/kWh; datos en tarifa plana) |

Ojo: con 10³ nodos la red no puede llevar tráfico de WhatsApp. Esa fila solo sirve para ver el arranque.

### 5.4 Precio de equilibrio (periodo 0)

`P* = coste mensual / VEL al mes por nodo`. Es el precio mínimo de VEL para no perder dinero.

| `N` | `P*` (€/VEL) | Valor total implícito (21.000 M × `P*`) |
|---|---|---|
| 10³ | 0,0023 | 48 M€ |
| 10⁶ | 0,090 | 1.890 M€ |
| 10⁹ | 0,23 | 4.830 M€ |

**Lectura honesta:**

- Con 10⁹ nodos, la emisión da **0,2 VEL al mes por móvil**. Solo cubre su luz si VEL vale ≥ 0,23 €. Es un valor total de casi 5.000 M€.
- Si el precio no acompaña, muchos nodos se apagan. **Eso es sano:** el número de nodos se ajusta solo hasta que los que quedan cubren costes (`investigacion.md` §6.3).
- En toda la fase de emisión, el ingreso en euros **depende del precio de VEL**. Nadie puede prometer rentabilidad (`investigacion.md` §5.7.4).

---

## 6. Después de la emisión: comisiones, Reserva y créditos

Aquí el ingreso en euros **no depende del precio de VEL**: la comisión es un 0,01 % del valor y el crédito vale 22 µUSDT. Depende del **uso**.

### 6.1 Hipótesis de uso (supuestos)

| Hipótesis | Bajo | Base | Alto |
|---|---|---|---|
| Pagos al día | 142,6 M (1.650 tx/s, `escalado.md` §1) | igual | igual |
| Pagos ≥ 1.000 € | 0,5 % | 2 % | 5 % |
| Importe medio de esos pagos | 2.000 € | 3.000 € | 5.000 € |
| Mensajes de empresas y bots **por encima del cupo** | 1 % | 5 % | 20 % |
| Altas de tokens | despreciable | despreciable | despreciable |

El rango del 5–20 % de mensajes de empresa lo fija el propietario como escenario. **No tenemos un dato público** de qué parte del tráfico de WhatsApp es de empresas. Meta solo publica precios [7] e ingresos agregados de mensajería de empresa [6].

### 6.2 Ingreso de la red

| | Bajo | Base | Alto |
|---|---|---|---|
| Volumen ≥ 1.000 € al día | 1.430 M€ | 8.550 M€ | 35.640 M€ |
| Comisiones al día (1 pb) | 142.560 € | 855.360 € | 3.564.000 € |
| Créditos al día | 20.240 € | 101.200 € | 404.800 € |
| **Total al día** | **162.800 €** | **956.560 €** | **3.968.800 €** |
| **Total al mes** | **4,96 M€** | **29,12 M€** | **120,80 M€** |
| Saldo de equilibrio de la Reserva | ≈ 1,2 M€ | ≈ 7,1 M€ | ≈ 29,7 M€ |

Créditos: `mensajes × cuota × 22 µUSDT × 0,92 €/$`. Ej. base: 5.000 M × 0,000022 = 110.000 USDT ≈ 101.200 €/día.

### 6.3 Ingreso medio por nodo al mes (sin emisión)

| `N` | Bajo | Base | Alto | Coste del nodo (§5.3) |
|---|---|---|---|---|
| 10³ | 4.955 € | 29.115 € | 120.800 € | ≈ 500 € (pero no lleva la carga) |
| 10⁶ | 4,96 € | **29,12 €** | 120,80 € | 19,60 € |
| 10⁹ | 0,005 € | **0,029 €** | 0,12 € | ≈ 0,05 € |

**Número de nodos que se pagan solos** (`N* = ingreso mensual / coste del nodo`):

| | Bajo | Base | Alto |
|---|---|---|---|
| Nodos de casa (19,60 €) | 0,25 M | 1,49 M | 6,16 M |
| Móviles (0,05 €) | 99 M | 582 M | 2.416 M |

**Lectura honesta:**

- Con **10⁹ nodos**, en el escenario base cada móvil gana **≈ 3 céntimos al mes**. No cubre ni su luz. Solo el escenario alto (0,12 €) lo hace.
- Con **10⁶ nodos de casa**, el escenario base (29 €) sí cubre el coste (19,60 €). El bajo (5 €) no.
- La red se paga si el uso de pago grande es alto **o** si hay pocos nodos para el volumen. Un mensajero no necesita 10⁹ nodos: 10⁶ ya dan 1 Mbit/s por nodo (`escalado.md` §2). Como referencia, Signal estima su coste anual en unos 50 M$ [16]; el base da ≈ 350 M€ al año.
- Las comisiones pesan **8 veces más** que los créditos en el escenario base. Pero son las más fáciles de esquivar (§8).

### 6.4 Créditos frente a WhatsApp Business

| | Precio por mensaje |
|---|---|
| Velum, crédito | 22 µUSDT ≈ **0,00002 €** (2,02 € por 100.000) |
| Helium, Data Credit (referencia de diseño) | 0,00001 $ por 24 bytes [3] |
| WhatsApp Business, España, utilidad/autenticación | ≈ 0,0166 € (terceros, 2026) [8] |
| WhatsApp Business, España, marketing | ≈ 0,051–0,059 € (terceros, 2026) [8] |

El crédito de Velum es **≈ 820 veces** más barato que un mensaje de utilidad de Meta y **≈ 2.900 veces** más que uno de marketing. Meta cobra por plantilla y por país [7]; Velum cobra cualquier mensaje por encima del cupo. Hay mucho margen para subir el precio sin dejar de ser barato (§9).

A diferencia de `investigacion.md` §5.7.2, los VEL de los créditos **no se queman**: van enteros a la bolsa de la época. Helium sí quema HNT al crear Data Credits [3][4].

---

## 7. La transición: cuándo pesa más el uso que la emisión

Emisión en € al mes = `217,7 M VEL / 2ᵏ × precio`. Con el uso base (29,12 M€/mes):

| Precio de VEL | Emisión periodo 0 (€/mes) | Periodo en que el uso base ya supera a la emisión |
|---|---|---|
| 0,001 € | 0,22 M€ | desde el principio |
| 0,01 € | 2,18 M€ | desde el principio |
| 0,1 € | 21,8 M€ | desde el principio |
| 1 € | 218 M€ | periodo 3 (años 12–16) |
| 10 € | 2.177 M€ | periodo 7 (años 28–32) |

Conclusión: **a escala WhatsApp, el uso manda antes que la emisión** salvo que VEL valga mucho. La emisión es sobre todo el motor del **arranque**, cuando hay pocos usuarios y pocas comisiones.

---

## 8. Riesgos

| Riesgo | Qué pasa | Gravedad |
|---|---|---|
| **Partir pagos bajo el umbral** | Un pago de 5.000 € en 5 de 1.000 € ahorra 0,50 €. El sello PoW cuesta ~50 ms por pago. Partir sale casi gratis | **Alta**: la comisión es casi voluntaria para quien sabe hacerlo |
| **Muchas identidades bajo el cupo** | 1 M mensajes/día caben en 348 identidades gratis. El registro cuesta ~30 s de PoW cada una (≈ 3 h de móvil) [9][10] | **Alta**: los créditos se pueden esquivar con Sybil [11] |
| **Créditos contados fuera de la cadena** | En v4 los gastan y cuentan puertas y nodos. No hay liquidación en cadena | Media: se puede contar de más o de menos sin que la cadena lo vea |
| **Oráculo** | Sin precio → `credits.buy` se rechaza y la comisión es 0. TWAP de 1 h [12] | Media |
| **Oráculo poco líquido** | El mínimo de volumen es 1.000 VEL por hora. A 0,0001 €/VEL son **0,10 €**: barato de mover | **Alta mientras VEL valga poco** |
| **Inflar el precio para comprar créditos** | Si alguien sube la TWAP, recibe más créditos por VEL. Tiene que sostenerlo 1 h y pagar la diferencia | Media |
| **Velocidad del token** | Si nadie necesita guardar VEL, su precio tiende a bajar [13] | Media: afecta solo a la fase de emisión |
| **Demasiados nodos** | El ingreso se reparte entre todos. A 10⁹ cada uno gana céntimos | Baja: se corrige sola (se apagan) |
| **Promesa de rentabilidad** | Decir «minar compensa» puede convertir VEL en instrumento financiero | Legal (`investigacion.md` §8) |

---

## 9. Palancas del protocolo

Todas entran como versión con altura de activación (`mainnet.md` §5). Ninguna reinicia la cadena.

| Palanca | Ahora | Efecto | Coste |
|---|---|---|---|
| Precio del crédito | 22 µUSDT | ×10 (220 µUSDT ≈ 0,0002 €) multiplica ×10 lo que dan los créditos y sigue siendo 80 veces más barato que Meta | Puede echar a empresas pequeñas |
| Cupo gratis | 2.880/día | Bajarlo hace pagar a más bots | Molesta a usuarios intensos |
| Coste de alta de identidad | ~30 s de PoW | Una fianza pequeña o más PoW encarece el Sybil del §8 | Fricción al registrarse |
| Umbral agregado por cuenta | por pago | Sumar los pagos de una cuenta en la época frena el troceo simple | No frena varias cuentas |
| PoW creciente por cuenta | fijo | Más bits cuantos más pagos gratis hace una cuenta | Más batería |
| `RESERVE_RELEASE_BP` | 10 (0,1 %) | 1 (0,01 %) → vida media ≈ 289 días: guarda más para años malos | Los nodos cobran más tarde |
| Mínimo de volumen del oráculo | 1.000 VEL | Medirlo en USDT (p. ej. 1.000 vUSDT/h) | Más épocas «sin precio» al principio |
| Créditos en cadena | fuera | Recibos de consumo agregados como las reclamaciones (`escalado.md` §4) | Trabajo futuro |
| Reparto productores/trabajo | 15/85 | Ajustarlo si producir bloques cuesta más que relevar | — |

**Lo que no es palanca:** la emisión. El tope de 21.000 M y las 33 mitades son decisión cerrada. No hay emisión de cola (a diferencia de Solana; `investigacion.md` §5.8).

---

## 10. Qué tiene que cumplirse para que los nodos ganen dinero

1. **Durante la emisión (años 0–28):** VEL tiene que valer al menos `P*` (§5.4) para el tipo de nodo. Si no, se apagan nodos hasta que los que quedan cuadren.
2. **Después:** el uso de pago tiene que existir. En el escenario base, **1,5 M de nodos de casa** o **580 M de móviles** se pagan solos. Más nodos que eso pierden dinero en media.
3. **Las comisiones tienen que cobrarse de verdad.** Si casi todo el mundo trocea los pagos grandes, el ingreso cae al de los créditos (≈ 3,1 M€/mes en base). Eso solo paga a ≈ 155.000 nodos de casa.
4. **Los créditos tienen que ser difíciles de esquivar.** Hoy no lo son (§8). Es lo primero a reforzar.
5. **El oráculo tiene que ser líquido.** Sin precio fiable no hay comisión ni créditos.

---

## 11. Referencias

Las que ya están en `investigacion.md` §11 llevan su número allí entre paréntesis. *(secundaria)* = prensa o terceros.

1. Nakamoto, S. *Bitcoin: A Peer-to-Peer Electronic Cash System*. 2008. https://bitcoin.org/bitcoin.pdf (inv. [68])
2. Bitcoin Wiki. *Controlled supply* (mitad cada 210.000 bloques, 21 M, fin hacia 2140). https://en.bitcoin.it/wiki/Controlled_supply
3. Helium. *Data Credit* (1 DC = 0,00001 $, 24 bytes; se crean quemando HNT). Docs. https://docs.helium.com/tokens/data-credit (inv. [43][44])
4. Helium. *HIP-20: HNT Max Supply*. 2020. https://raw.githubusercontent.com/helium/HIP/main/0020-hnt-max-supply.md (inv. [44])
5. Neowin. *WhatsApp is now exchanging close to 100 billion messages each day*. Octubre 2020 *(secundaria; dato de la presentación de resultados de Facebook)*. https://www.neowin.net/news/whatsapp-is-now-exchanging-close-to-100-billion-messages-each-day
6. Newsquawk. *Meta CEO says WhatsApp now has more than 3bln monthly active users*. 30-04-2025 *(secundaria; resultados del T1 2025 de Meta)*. https://newsquawk.com/headlines/meta-meta-ceo-says-whatsapp-now-has-more-than-3bln-monthly-active-users-including-over-100mln-in-the-us-30-04-2025
7. Meta. *Pricing on the WhatsApp Business Platform*. Docs, consultado 2026. https://developers.facebook.com/docs/whatsapp/pricing
8. GuruSup. *WhatsApp Business API Pricing: Costs and Rates in Spain [2026]* *(secundaria; las cifras varían unos céntimos entre fuentes; comprobar en [7])*. https://gurusup.com/blog/whatsapp-api-pricing
9. Back, A. *Hashcash — A Denial of Service Counter-Measure*. 2002. https://sites.cs.ucsb.edu/~rich/class/cs293b-cloud/papers/hascash2.pdf (inv. [84])
10. PSE. *Rate-Limiting Nullifier (RLN)*. 2023. https://pse.dev/blog/rate-limiting-nullifier-rln (inv. [28])
11. Douceur, J. R. *The Sybil Attack*. IPTPS, 2002. https://www.doi.org/10.1007/3-540-45748-8_24 (inv. [85])
12. Uniswap. *Oracles (TWAP)*. Docs v2. https://developers.uniswap.org/docs/protocols/v2/concepts/oracles (inv. [87])
13. Samani, K. *Understanding Token Velocity*. Multicoin Capital, 2017. https://multicoin.capital/zh/2017/12/08/understanding-token-velocity (inv. [82])
14. Diaz, C.; Halpin, H.; Kiayias, A. *Reward Sharing for Mixnets* (Nym). 2021–2022. https://nym.com/nym-cryptoecon-paper.pdf (inv. [22])
15. Filecoin. *Minting Model* (*baseline minting*). https://spec.filecoin.io/systems/filecoin_token/minting_model/ (inv. [47])
16. YourStory. *Signal says it will cost $50M a year to run*. 2023 *(secundaria)*. https://YourStory.com/2023/11/private-text-app-signal-meredith-whittaker-joshua-lund (inv. [88])

**Cálculos:** todos salen de `bun -e` con `BigInt` para el calendario (`R0`, sumas, restos) y con coma flotante para los escenarios en euros. Se pueden rehacer con las fórmulas del §2.
