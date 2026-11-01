# Velum Node

Red de mensajería cifrada de extremo a extremo y anónima, con su propia cadena y su moneda **VEL**. Este repositorio contiene todo lo necesario para correr un nodo, construir carteras, exchanges o pasarelas, e implementar el protocolo en cualquier lenguaje.

- **Web, explorador y documentación:** https://velumprotocol.org
- **Descargas firmadas (macOS, Windows, Linux):** https://velumprotocol.org/descargar · [Releases](https://github.com/Consultora-BIM/velum-node/releases)
- **Instalar en un comando:** `curl -fsSL https://velumprotocol.org/install.sh | bash` · Windows: `irm https://velumprotocol.org/install.ps1 | iex`

| Carpeta | Qué es |
|---|---|
| `packages/core` | Protocolo: claves (BIP-39 + SLIP-10), cifrado híbrido X25519 + ML-KEM-768, fragmentos Reed–Solomon, máquina de estados, consenso |
| `packages/sdk` | `@velum/sdk` para carteras, exchanges, custodios y pasarelas de pago |
| `apps/node` | Nodo en Bun: ejecutable único, actualizaciones firmadas, conexión directa entre nodos |
| `apps/bridge` | Pasarela USDT ↔ vUSDT (custodia en frío, prueba de reservas) |
| `spec/` + `PROTOCOL.md` | Especificación y vectores de prueba: cualquier implementación compatible debe reproducirlos byte a byte |
| `docs/` | Diseño, economía, escalado, mainnet y ecosistema |

Red principal: `velum-mainnet-1`. Licencia Apache-2.0. La app de mensajería Velum (iOS, Android, escritorio) no forma parte de este repositorio.

```bash
bun install
bun run test
bun apps/node/src/main.ts start
```
