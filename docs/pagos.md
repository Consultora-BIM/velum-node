# Pagos con VEL

> VEL sirve para pagar en el día a día: de móvil a móvil y en comercios con un móvil o un terminal (TPV).
> Código: `packages/core/src/payreq.ts` (estándar), `packages/sdk/src/payments.ts` (SDK) y `packages/sdk/examples/pos/` (TPV de ejemplo).
> No toca el consenso: un cobro se paga con un `transfer` normal.

## 1. Enlace de pago `velum:pay`

```
velum:pay?to=<dirección>&amount=<VEL>&ref=<id>&label=<concepto>&exp=<ms>&ts=<ms>&sig=<firma>
```

| Campo | Obligatorio | Qué es |
|---|---|---|
| `to` | sí | Dirección de quien cobra (`vel…`). |
| `amount` | sí | Importe en VEL con **punto** decimal (`12.5`). Hasta 18 decimales. |
| `ref` | no | Referencia del cobro (ticket, pedido). 1–64: letras, números, `_` y `-`. |
| `label` | no | Concepto para la pantalla del cliente (máx. 64). |
| `exp` | no | Caducidad (ms desde 1970). Pasada, la app no deja pagar. |
| `ts` | sí si va firmado | Hora de creación (ms). |
| `token`, `dec` | no | Cobro en otro token (p. ej. `vUSDT`, 6 decimales). Sin ellos, VEL. |
| `sig` | no | Firma de `to` sobre la factura (§2). Sin firma, la app lo marca «sin verificar». |
| `chain` | no | Solo si no es la red por defecto. |

- También vale `velum:<dirección>` a secas: la app pide el importe.
- Cabe en un **QR** (≈ 250 caracteres; nivel de corrección M) y en una **etiqueta NFC**.

## 2. Factura firmada

Objeto que firma quien cobra (ed25519, la misma clave de su cartera):

```json
{ "v": 1, "t": "velum-invoice", "chain": "velum-mainnet-1", "to": "vel…", "amount": "12500000000000000000",
  "ref": "T-0042", "label": "Café y tostada", "exp": 1793571311013, "ts": 1793570411013, "sig": "…" }
```

- Se firma el **JSON canónico** sin `sig` (claves ordenadas). El importe va en **velos** (texto decimal): no hay redondeos.
- Quien paga comprueba que la firma es de `to`. Si alguien cambia el QR (otro importe u otra dirección), la firma no cuadra y la app avisa.
- Funciones: `createInvoice`, `signInvoice`, `verifyInvoice`, `paymentURI`, `parsePaymentURI` (núcleo y SDK).

## 3. Cómo se paga y cómo se reconoce el pago

1. La app del cliente lee el QR o el NFC (`parsePaymentURI`) y enseña importe, concepto y si está verificado.
2. Paga con un `transfer` a `to` por el importe, con `memo = "pay:<ref>"` (`paymentMemo`).
3. Quien cobra reconoce el pago con `paysInvoice(tx, factura)`: destino, token, importe **igual o mayor** y la `ref` en el memo.
4. `watchPayment(cadena, factura, { onUpdate })` (SDK) vigila los bloques y avisa en cada cambio.

### Firmeza (cuándo dar el cobro por bueno)

| Estado | Cuándo | Tiempo típico |
|---|---|---|
| `pendiente` | Aún no está en un bloque | — |
| `incluido` | Ya está en un bloque: **el cobro está hecho** | ≈ 2 s (un bloque cada 2 s) |
| `firme` | Con 30 bloques encima (1.800 si el importe es ≥ 10.000 VEL) | ≈ 1 min (≈ 1 h) |

- `settlementOf(confirmaciones)` devuelve el estado y la espera estimada (`remainingMs`) con el ritmo de bloques de la cadena.
- Hoy no hay finalidad instantánea: un bloque muy reciente podría reorganizarse ([ecosistema §2.3](ecosistema.md)). `watchPayment` lo detecta: si el bloque del pago cambia, vuelve a buscar.
- En un mostrador basta «incluido» para importes pequeños. Para importes grandes, espera a «firme».

## 4. Modo comercio (TPV)

- Cualquier móvil con la app es un TPV: escribe el importe, enseña el QR y se pone verde al cobrar.
- Ejemplo sin app: `packages/sdk/examples/pos/` (servidor Bun + página).
  - `bun packages/sdk/examples/pos/server.ts --demo` → cadena simulada; el «cliente» paga a los 4 s.
  - Con la red real: `VELUM_POS_KEY=<clave hex> bun packages/sdk/examples/pos/server.ts`. Solo necesita la clave de la cartera que cobra para **firmar facturas**; no mueve fondos.
- Cada cobro lleva una `ref` única y caduca en 15 min.
- **NFC**: `ndefMessage(uri)` da el mensaje NDEF (registro URI) para escribir una etiqueta o emitir desde el móvil (HCE en Android). `parseNdef` lo lee.

## 5. Comisiones

- Pagos de menos de **1.100 vUSDT de valor** (≈ 1.000 €) con el oráculo: **comisión 0**, con un sello de trabajo pequeño que hace la app (décimas de segundo).
- Desde ahí, **1 punto básico** (0,01 %) del importe. Sin precio en el oráculo, comisión 0.
- La comisión nunca se destruye: va a quienes mantienen la red (los nodos).
- Quien cobra recibe el importe íntegro: la comisión la paga quien paga, aparte.

## 6. Lo que la app necesita

- **Pagar**: lector de QR y NFC → `parsePaymentURI` → pantalla de confirmación (importe, concepto, «verificado») → `makeTransfer` con el memo.
- **Cobrar**: teclado de importe → `createInvoice` firmada con la cartera → QR grande → `watchPayment` → verde al «incluido».
- **Recibos**: guardar `ref`, id de la tx y altura. El explorador enseña la tx con su memo.
