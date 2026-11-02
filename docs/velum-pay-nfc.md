# Velum Pay por NFC: qué se puede hacer hoy y cómo seguir

> Estado a 2 de noviembre de 2026. Políticas de Apple y Google revisadas en sus webs oficiales (ver «Fuentes»).
> Relacionado: [`pagos.md`](pagos.md) (estándar `velum:pay`) y `packages/core/src/payreq.ts`.

## 1. Resumen en cinco líneas

1. **iPhone ↔ iPhone por NFC no es viable hoy** para Velum: un iPhone puede *leer* NFC, pero no puede *hacer de etiqueta* sin un permiso especial de Apple que no encaja con Velum.
2. **Android sí puede hacer de etiqueta** (HCE) y enseñar la URI firmada `velum:pay?…` a cualquier móvil que acerque el suyo, iPhone incluido.
3. **El QR dinámico firmado sigue siendo la base**: funciona en todos los móviles, sin permisos ni compilaciones nativas nuevas.
4. **NFC no cambia la seguridad**: lo que protege es la factura firmada, la comprobación del pagador y Face ID/Touch ID antes de firmar.
5. Plan: **ya** QR · **siguiente** lectura NFC en iOS y Android + emisión HCE en Android + pegatinas fijas · **más adelante** HCE en iPhone solo si Apple lo concede.

## 2. Punto de partida en el código

- `payreq.ts` ya genera y lee la URI firmada (`paymentURI`, `parsePaymentURI`, `verifyInvoice`).
- `ndefMessage(uri)` y `parseNdef(msg)` ya crean y leen un mensaje NDEF con **un solo registro URI** (TNF 1, tipo `U`).
- La URI firmada ronda los 250 caracteres: cabe de sobra en una etiqueta NFC o en una tarjeta emulada.
- `apps/mobile/package.json` **no** incluye `react-native-nfc-manager` ni ninguna librería HCE. Hoy **no hay NFC** en la app.
- La app ya tiene enlace universal `applinks:velumprotocol.org` y biometría (`expo-local-authentication`). Ambos sirven para NFC.
- Pantalla «Cobrar»: QR dinámico. Facturas prefirmadas que rotan cada ~2 min, válidas ~2,5 min. Un `ref` de un solo uso por cobro (~10 min).
- El pagador comprueba firma, caducidad, importe y que el `ref` no esté pagado (lista local + memo `pay:<ref>` en el historial del comercio). Firma con Face ID/Touch ID justo antes.

## 3. iPhone: qué permite Apple

### 3.1 Core NFC: solo leer (y escribir etiquetas)

- Cualquier app puede **leer etiquetas NDEF** con `NFCNDEFReaderSession` y tarjetas ISO 7816 / ISO 15693 / FeliCa / MIFARE con `NFCTagReaderSession`.
- Necesita la app **abierta**. iOS muestra su hoja «Listo para escanear» y la sesión caduca sola (unos 60 s).
- Necesita el permiso `com.apple.developer.nfc.readersession.formats` y el texto `NFCReaderUsageDescription` en `Info.plist`.
- **Lectura en segundo plano** (iPhone XS o posterior): el sistema lee la etiqueta sin abrir la app y avisa con una notificación.
  - **Solo con enlaces universales** (`https://…`). Apple no admite esquemas propios como `velum:` en segundo plano.
  - Si la app no está instalada, abre Safari.
  - No funciona con otra sesión NFC abierta, en modo avión, etc.
- **Consecuencia:** para que «acercar y pagar» funcione con la app cerrada, la etiqueta debe llevar `https://velumprotocol.org/pay?…`, no `velum:pay?…`. La app ya tiene ese dominio asociado.

### 3.2 HCE en iPhone (el iPhone hace de tarjeta)

Apple tiene dos vías. Ninguna está pensada para una app como Velum hoy.

| Vía | Dónde | Qué permite | Requisitos |
|---|---|---|---|
| **HCE en el EEE** (`CardSession`) | Solo Espacio Económico Europeo. iOS 17.4+ | Pagos en tienda, transporte, llaves, accesos, fidelización, entradas… y **«dispositivo a dispositivo»** | Empresa establecida en el EEE, permiso por Bundle ID, **licencias legales para ese servicio**, PCI DSS / EMVCo / RGPD, guías de Apple, revisión en App Store |
| **NFC & SE Platform** | Fuera del EEE: EE. UU., Reino Unido, Canadá, Japón, Australia, Brasil, Nueva Zelanda (iOS 18.1); Suiza (18.2); México, Singapur, Hong Kong, EAU, Arabia Saudí y otros (18.4); India, Vietnam, Qatar y otros (iOS 26) | Pagos en tienda, transporte, llaves, accesos, carnés, fidelización, entradas, DNI | **Contrato comercial con Apple y comisiones**, acuerdo de confidencialidad, auditoría del applet en un laboratorio, entidad financiera o PSP con licencia |

- La vía del EEE es la **única que menciona «dispositivo a dispositivo»**. Pide tener los permisos regulatorios para prestar ese servicio en el EEE. Para Velum (cripto), eso apunta a licencia de proveedor de criptoactivos (MiCA) o similar. Hay que confirmarlo con Apple y con un asesor legal.
- La vía mundial **no** lista pagos entre personas ni pagos cripto, y exige licencia de pago o acuerdo con un PSP.
- ¿Puede un iPhone leer a otro iPhone que emula tarjeta? **Técnicamente sí**, si el emisor tiene el permiso HCE y el lector usa Core NFC con el AID declarado. Pero sin el permiso HCE en el emisor, no hay nada que leer.
- **Tap to Pay on iPhone** convierte el iPhone en datáfono para **tarjetas y monederos bancarios** a través de un PSP (Stripe, Adyen…). El PSP procesa el cobro. **No sirve** para una URI `velum:pay` propia.
- **NameDrop / AirDrop** (acercar dos iPhone) es solo de Apple. No hay API para terceros.

**Conclusión iOS:** el iPhone puede **pagar** leyendo NFC (pegatina o Android). Hoy no puede **cobrar** por NFC. Para cobrar, el iPhone sigue enseñando el QR.

## 4. Android: qué permite Google

- **HCE abierto a cualquier app** desde Android 4.4. No pide permiso a Google.
- Se implementa con un servicio `HostApduService`. El sistema le pasa los comandos del lector (APDU) y la app responde.
- Para que cualquier móvil lo lea como una etiqueta normal, se emula una **etiqueta NFC Forum Tipo 4**:
  1. El lector selecciona la aplicación NDEF (AID `D2760000850101`).
  2. Lee el fichero de capacidades (CC, `E103`).
  3. Lee el fichero NDEF: 2 bytes de longitud + `ndefMessage(uri)`.
- Categoría `other` en `apduservice.xml`. **No** usar `payment`: esa es para monederos bancarios y exige ser el monedero por defecto.
- Con la pantalla «Cobrar» abierta, llamar a `setPreferredService` para que gane Velum si otra app usa el mismo AID.
- `requireDeviceUnlock="true"`: solo emite con el móvil desbloqueado. Es lo correcto para cobrar.
- Lectura en Android: modo lector (`enableReaderMode`) o el despachador de intents NDEF. Un Android lee a otro Android en HCE sin problema.
- **iPhone leyendo un Android en HCE:** `NFCNDEFReaderSession` lo ve como una etiqueta NDEF corriente. Hay pruebas reales de la comunidad que funcionan. Varía según fabricante: hay que probar en varios modelos.
- **Android leyendo un iPhone:** no es posible, porque el iPhone no puede emular sin el permiso de Apple.

## 5. Arquitectura recomendada por fases

### Fase A · Ahora: QR dinámico firmado (ya hecho)

- Funciona en todos los móviles, sin permisos ni compilación nativa nueva.
- Mantener: rotación ~2 min, caducidad ~2,5 min, `ref` de un solo uso, verificación del pagador y biometría.

### Fase B · Siguiente: NFC sin pedir nada a Apple

**B1. Leer NFC en iOS y Android (pagador).**
- Botón «Acercar al NFC» en la pantalla de pagar, junto al lector de QR.
- Lee el primer registro URI → `parsePaymentURI` → misma pantalla de confirmación que el QR.
- Aceptar `velum:pay?…` y también `https://velumprotocol.org/pay?…` (misma consulta, otro prefijo).

**B2. Emitir por HCE en Android (comercio).**
- En «Cobrar», un Android emite la **misma factura firmada** que enseña el QR.
- Cuando el QR rota, el servicio HCE pasa a emitir la factura nueva. Una sola fuente de verdad.
- Solo emite mientras «Cobrar» está abierta y el móvil desbloqueado. Al salir, se apaga.
- Emitir la variante `https://velumprotocol.org/pay?…`: así un iPhone con la app cerrada también la abre (lectura en segundo plano).

**B3. Pegatinas NFC fijas en el mostrador.**
- Una etiqueta física **no puede cambiar**. Por eso **nunca** debe llevar importe, `ref` ni firma de un cobro concreto: se podría reutilizar.
- La pegatina lleva solo quién cobra: `https://velumprotocol.org/pay?to=<dirección>&c=<caja>`.
- La app del pagador necesita después la factura fresca. Opciones:

| Opción | Cómo | A favor | En contra |
|---|---|---|---|
| **Pago libre** | La app abre «Pagar a X» y el cliente teclea el importe | Sin servidor. Funciona ya con `parsePaymentURI` («Falta el importe») | Errores al teclear. Sin `ref`: el comercio concilia peor |
| **Relevo de la factura** | El móvil del comercio publica la factura firmada vigente en un relevo (por caja). El pagador la pide tras leer la pegatina | Importe y `ref` exactos. La firma sigue protegiendo: el relevo no puede cambiarla | Hace falta un servicio en línea. Si se cae, se vuelve al QR |
| **Pegatina + QR** | La pegatina solo abre la cámara en la pantalla correcta | Simple | Ahorra poco |

- Recomendación: **relevo** para comercios con caja; **pago libre** como alternativa. El relevo solo guarda datos públicos ya firmados.

### Fase C · Más adelante: HCE en iPhone

- Solo si Apple concede el permiso y Velum cumple los requisitos legales (EEE: «dispositivo a dispositivo»; fuera: casi imposible sin PSP).
- Técnicamente sería lo mismo que en Android: emular la etiqueta Tipo 4 con `CardSession`. El AID iría en `com.apple.developer.nfc.hce.iso7816.select-identifier-prefixes`.
- Revisar cada año: Apple añade países y casos de uso con cada versión de iOS.

## 6. Seguridad

- **NFC solo transporta la URI.** No añade ni quita confianza. Lo que protege es lo mismo que en el QR:
  - Factura **firmada** por el comercio (Ed25519). Un cambio de importe o dirección rompe la firma.
  - El pagador **verifica** firma, caducidad, importe y `ref` antes de nada.
  - **Face ID/Touch ID** justo antes de firmar el pago.
- **Ataque de relevo** (alguien acerca un lector escondido y reenvía la señal lejos): solo consigue llevar la factura a otro sitio. El pagador sigue viendo comercio e importe y tiene que confirmar con biometría.
  - Mitigación: caducidad corta (~2,5 min) y `ref` de un solo uso.
- **Pegatina cambiada** por otra falsa: el pagador vería otro comercio. Enseñar siempre nombre y dirección verificados, como con el QR.
- **Lectura accidental**: NFC necesita ~4 cm. Aun así, nunca pagar sin la confirmación explícita.
- **Lo que nunca va en NFC**: claves, frase de recuperación ni nada secreto. Solo la factura pública firmada.

## 7. Comparativa

| Opción | Plataforma | ¿Funciona hoy? | ¿Compilación nativa nueva? | ¿Permiso de Apple/Google? | Experiencia |
|---|---|---|---|---|---|
| QR dinámico firmado | iOS + Android | **Sí** (ya está) | No | No | Buena. Hay que enfocar la cámara |
| Leer NFC (pagador) | iOS + Android | Sí, tras implementarlo | Sí (`react-native-nfc-manager`) | No (solo permiso estándar de Core NFC) | Muy buena. En iOS sale la hoja del sistema |
| Emitir HCE (comercio) | Solo Android | Sí, tras implementarlo | Sí (módulo propio o `react-native-hce`) | No | Muy buena. Acercar y listo |
| Pegatina fija + relevo | iOS + Android leen | Sí, tras implementarlo | Sí (lectura NFC) + servicio de relevo | No | Muy buena. Funciona con la app cerrada (enlace universal) |
| Pegatina fija + pago libre | iOS + Android leen | Sí, tras implementarlo | Sí (lectura NFC) | No | Correcta. El cliente teclea el importe |
| HCE en iPhone | Solo iOS | **No** | Sí | **Sí**: permiso, contrato y licencias | Ideal, pero no disponible |
| Tap to Pay on iPhone | Solo iOS | No aplica | — | Sí, vía PSP | Solo tarjetas bancarias |

## 8. Próximos pasos (lista de tareas)

**Dependencias**
- [ ] `bunx expo install react-native-nfc-manager` (lectura NFC en iOS y Android). No funciona en Expo Go: hace falta *development build*.
- [ ] Emisión HCE en Android: **módulo Expo propio** en `apps/mobile/modules/` (recomendado; la app ya usa módulos locales) o `react-native-hce` (pequeño y poco mantenido).

**Plugin de configuración (`app.json` / `app.config.js`)**
- [ ] `["react-native-nfc-manager", { "nfcPermission": "Velum usa NFC para leer cobros al acercar el móvil.", "includeNdefEntitlement": false }]`.
- [ ] Plugin propio en `apps/mobile/plugins/` para el servicio HCE de Android (manifiesto + `apduservice.xml`).

**iOS**
- [ ] Entitlement `com.apple.developer.nfc.readersession.formats` = `["TAG"]` (las versiones recientes de Xcode rechazan el valor `NDEF`; el plugin lo gestiona).
- [ ] `Info.plist`: `NFCReaderUsageDescription` con el texto de arriba (localizado en es, en, fr, ru, zh-Hans).
- [ ] Activar «NFC Tag Reading» en el App ID del portal de Apple (equipo `D58V3B3XNT`) y regenerar perfiles en EAS.
- [ ] Ruta `/pay` en `apple-app-site-association` de `velumprotocol.org` para la lectura en segundo plano.

**Android**
- [ ] Manifiesto: `<uses-permission android:name="android.permission.NFC"/>`, `<uses-feature android:name="android.hardware.nfc" android:required="false"/>` y `<uses-feature android:name="android.hardware.nfc.hce" android:required="false"/>` (opcionales: la app debe instalarse en móviles sin NFC).
- [ ] Servicio:
  ```xml
  <service android:name=".VelumPayHceService" android:exported="true"
           android:permission="android.permission.BIND_NFC_SERVICE">
    <intent-filter><action android:name="android.nfc.cardemulation.action.HOST_APDU_SERVICE"/></intent-filter>
    <meta-data android:name="android.nfc.cardemulation.host_apdu_service" android:resource="@xml/apduservice"/>
  </service>
  ```
- [ ] `res/xml/apduservice.xml`:
  ```xml
  <host-apdu-service xmlns:android="http://schemas.android.com/apk/res/android"
      android:description="@string/velum_pay_hce" android:requireDeviceUnlock="true">
    <aid-group android:description="@string/velum_pay_hce" android:category="other">
      <aid-filter android:name="D2760000850101"/>
    </aid-group>
  </host-apdu-service>
  ```
- [ ] `intentFilters` para `https://velumprotocol.org/pay` (enlace verificado) y `assetlinks.json` actualizado.

**App**
- [ ] Aceptar el prefijo `https://velumprotocol.org/pay?` en `parsePaymentURI` (con test en `packages/core`).
- [ ] Pantalla de pagar: botón «Acercar al NFC». Pantalla «Cobrar» (Android): indicador «NFC activo».
- [ ] Servicio HCE: responder SELECT AID, SELECT CC/NDEF y READ BINARY con `ndefMessage(uri)`; refrescar al rotar la factura.
- [ ] Relevo de la factura para pegatinas (decidir dónde vive) y flujo de «pago libre».
- [ ] Probar en dispositivos reales: iPhone ↔ Android, Android ↔ Android, pegatina NTAG215/216 en ambos. Varios fabricantes Android.

**Esfuerzo estimado**

| Bloque | Días |
|---|---|
| Lectura NFC iOS + Android (plugin, permisos, UI, tests) | 2–3 |
| Emisión HCE Android (módulo Expo + plugin + UI) | 3–4 |
| Enlace universal `/pay` + ajustes en `payreq.ts` | 1 |
| Pegatinas + relevo de factura | 2–3 |
| Pruebas en dispositivos reales y pulido | 2 |
| **Total** | **≈ 10–13 días** |

## Fuentes

- Apple · HCE en apps del EEE (requisitos, «dispositivo a dispositivo», iOS 17.4+, entitlements): https://developer.apple.com/support/hce-transactions-in-apps
- Apple · NFC & SE Platform (países, versiones de iOS, casos de uso, contrato y comisiones): https://developer.apple.com/support/nfc-se-platform/
- Apple · Tap to Pay on iPhone: https://developer.apple.com/tap-to-pay/
- Apple · Lectura de etiquetas en segundo plano (solo enlaces universales, iPhone XS+): https://developer.apple.com/documentation/corenfc/adding-support-for-background-tag-reading
- Apple · `CardSession`: https://developer.apple.com/documentation/corenfc/cardsession
- Apple · Entitlement de Core NFC: https://developer.apple.com/documentation/bundleresources/entitlements/com.apple.developer.nfc.readersession.formats
- Android · Host-based card emulation (HostApduService, AID, categorías, bloqueo de pantalla): https://developer.android.com/develop/connectivity/nfc/hce
- react-native-nfc-manager (plugin de Expo, sin Expo Go): https://github.com/revtel/react-native-nfc-manager
- react-native-hce (emulación Tipo 4 en Android): https://github.com/appidea/react-native-hce
- Prueba de la comunidad iPhone leyendo Android HCE Tipo 4: https://github.com/deokgyuhan/flutter_nfc_hce_reader y https://hex.pm/packages/mob_nfc
- Contexto de la apertura de NFC de Apple (2024): https://www.oliverwyman.com/our-expertise/insights/2025/feb/how-apple-pay-third-party-access-could-alter-mobile-payments-europe.html
