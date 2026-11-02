# Intercambio P2P atómico (VEL ⇄ USDT)

> Dos personas cambian VEL por USDT **sin intermediarios**: o se completan las dos partes o ninguna.
> Código: `packages/core/src/htlc.ts`, tx en `tx.ts`/`state.ts`, constructores en `wallet.ts`. Tests: `packages/core/test/htlc.test.ts`.
> Nadie custodia nada: cada parte firma con su propia cartera. La empresa no participa.

## 1. La primitiva en Velum: candado hash-tiempo (HTLC)

| Tx | Campos | Efecto |
|---|---|---|
| `htlc.lock` | `to`, `amount`, `token?`, `hash` (sha256, hex), `expiresEpoch` | Saca `amount` de `from` y lo guarda en `vel_htlc`. Id = `htlcIdOf(tx)` («h» + id de la tx). |
| `htlc.claim` | `id`, `preimage` (32 bytes, hex) | Antes de caducar: si `sha256(preimage) = hash`, el importe va a `to`. |
| `htlc.refund` | `id` | Desde la época `expiresEpoch`: el importe vuelve a `from`. |

- Las tres **no tienen comisión** y llevan **sello de trabajo** (antispam).
- `claim` y `refund` los puede mandar **cualquiera**: el dinero solo puede ir a `to` o volver a `from`. Así un vigilante puede cerrar por ti.
- Caducidad en **épocas** (1 h), entre la siguiente y **720** (30 días). Hasta 100 candados abiertos por cartera.
- Vale para VEL y para tokens de la cadena (p. ej. `vUSDT`).
- **Nada se crea ni se destruye**: lo bloqueado está en el saldo de `vel_htlc` y `velLedgerGap = 0` siempre.
- **Activación**: versión de protocolo 5 (`HTLC_PROTOCOL`). La altura la fija el responsable añadiendo `{ version: 5, height: H, … }` a `MAINNET_UPGRADES` y `TESTNET_UPGRADES` (`upgrades.ts`), con el aviso de 14 días de [mainnet §5](mainnet.md). Hasta entonces la cadena las rechaza y la raíz del estado no cambia.

## 2. Flujo (Ana tiene VEL, Beto tiene USDT)

1. **Acuerdo** en el chat: 1.000 VEL por 10 USDT en Polygon. Cada uno da su dirección de la otra cadena.
2. **Ana crea el secreto**: `newHtlcSecret()` → `preimage` (solo ella) y `hash` (lo comparte).
3. **Ana bloquea primero, con más plazo**: `htlc.lock` en Velum, `to = Beto`, caducidad **T1 = ahora + 24 h**. Le pasa el id.
4. **Beto comprueba** en la cadena (importe, `to`, `hash`, caducidad) y bloquea su parte con **menos plazo**: HTLC estándar de USDT en Polygon (o TRON), `to = Ana`, mismo `hash`, caducidad **T2 = ahora + 12 h** (T2 < T1).
5. **Ana cobra los USDT** revelando `preimage` en el contrato de Polygon.
6. **Beto lee `preimage`** de Polygon y cobra los VEL con `htlc.claim` en Velum (o lo hace un vigilante por él).
7. Si algo falla: cada uno recupera lo suyo con su `refund` al caducar.

## 3. Seguridad

- **Quien crea el secreto bloquea primero y con más plazo** (T1 > T2 + margen). Si no, podría cobrar en una cadena y dejar caducar la otra.
- Margen recomendado entre T2 y T1: **≥ 6 h**. Cubre reorganizaciones (TRON 20 bloques, Polygon 128) y la espera de inclusión.
- Comprueba **siempre** el candado de la otra parte en su cadena antes de bloquear el tuyo: importe, destino, `hash` y caducidad.
- El secreto son **32 bytes aleatorios**. Nunca se reutiliza.
- `sha256` es el mismo hash que usan los contratos HTLC de EVM y TRON: el mismo `preimage` abre los dos lados.
- Velum cuenta la caducidad en épocas (hora de bloque). Las otras cadenas, en segundos o bloques: la app convierte con margen.

## 4. Lo que necesita la app

- Pantalla de oferta en el chat (importe, cadena, plazo) y estado del intercambio.
- Guardar el `preimage` cifrado en el dispositivo hasta cerrar el intercambio.
- Vigilar las dos cadenas y **cerrar sola**: `claim` en cuanto aparezca el secreto; `refund` al caducar.
- Lado USDT: un contrato HTLC estándar ya desplegado en Polygon/TRON (o uno auditado), firmado desde la cartera de cada persona.
- Avisos claros: «Bloqueado hasta las 14:00», «Recuperable desde las 20:00».
