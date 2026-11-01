#!/usr/bin/env bash
# Instalador del nodo Velum (macOS y Linux). Sin sudo y sin Bun: descarga el binario compilado de tu plataforma.
#   curl -fsSL https://velumprotocol.org/install.sh | bash
#   curl -fsSL https://velumprotocol.org/install.sh | bash -s -- --name mi-nodo --payout vel...
# Variables: VELUM_HOME (datos, ~/.velum), VELUM_PORT (7420), VELUM_DOWNLOAD_BASE (de dónde sale el manifiesto).
# Se puede repetir sin miedo: actualiza el binario y conserva clave y configuración.
set -euo pipefail

# Orígenes por orden (si uno está bloqueado se prueba el siguiente).
BASES="${VELUM_DOWNLOAD_BASE:-https://velumprotocol.org https://velum.consultorabim.com https://velum.consultora-bim.workers.dev}"
VHOME="${VELUM_HOME:-$HOME/.velum}"
LABEL="${VELUM_SERVICE_LABEL:-com.velum.node}"
UNIT_NAME="${VELUM_SERVICE_LABEL:-velum-node}"
OS="$(uname -s)"
ARCH="$(uname -m)"

say()  { printf '\033[1;33m▸\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n' "$*"; }
die()  { printf '\033[1;31m✗\033[0m %s\n' "$*" >&2; exit 1; }

case "$OS" in
  Darwin) P_OS=darwin ;;
  Linux) P_OS=linux ;;
  *) die "Sistema no compatible ($OS). En Windows usa: irm https://velumprotocol.org/install.ps1 | iex" ;;
esac
case "$ARCH" in
  arm64|aarch64) P_ARCH=arm64 ;;
  x86_64|amd64) P_ARCH=x64 ;;
  *) die "Procesador no compatible ($ARCH)." ;;
esac
PLAT="$P_OS-$P_ARCH"
[ "$PLAT" = "darwin-x64" ] && [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = "1" ] && PLAT="darwin-arm64"
command -v curl >/dev/null 2>&1 || die "Hace falta curl."

sha512_of() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 512 "$1" | cut -d' ' -f1
  else die "Hace falta sha512sum o shasum para comprobar la descarga."; fi
}

# ---------- 1. Binario (manifiesto → URL, SHA-512 y tamaño de esta plataforma) ----------
mkdir -p "$VHOME/bin" "$VHOME/logs"
say "Buscando la última versión para $PLAT…"
MANIFEST=""
for B in $BASES; do
  B="${B%/}"
  if MANIFEST="$(curl -fsSL --connect-timeout 10 "$B/download/manifest.json")" && [ -n "$MANIFEST" ]; then BASE="$B"; break; fi
  MANIFEST=""
done
[ -n "$MANIFEST" ] || die "No se pudo leer el manifiesto en: $BASES"
FLAT="$(printf '%s' "$MANIFEST" | tr -d '\n\r')"
BLOCK="$(printf '%s' "$FLAT" | sed -n "s/.*\"$PLAT\"[[:space:]]*:[[:space:]]*{\([^}]*\)}.*/\1/p")"
[ -n "$BLOCK" ] || die "La versión publicada no trae binario para $PLAT."
URL="$(printf '%s' "$BLOCK" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
SUM="$(printf '%s' "$BLOCK" | sed -n 's/.*"sha512"[[:space:]]*:[[:space:]]*"\([0-9a-f]*\)".*/\1/p')"
VERSION="$(printf '%s' "$FLAT" | sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p')"
[ -n "$URL" ] && [ -n "$SUM" ] || die "Manifiesto incompleto."
BIN="$VHOME/bin/velum-node"
TMP="$BIN.download"
say "Descargando velum-node $VERSION…"
curl -fL --progress-bar "$URL" -o "$TMP" || die "No se pudo descargar $URL"
[ "$(sha512_of "$TMP")" = "$SUM" ] || { rm -f "$TMP"; die "La descarga no coincide con su huella SHA-512: se descarta."; }
chmod 755 "$TMP"
[ "$OS" = Darwin ] && xattr -d com.apple.quarantine "$TMP" 2>/dev/null || true
"$TMP" version >/dev/null 2>&1 || { rm -f "$TMP"; die "El binario descargado no arranca en este equipo."; }
# Si ya había un nodo en marcha, se para antes de cambiar el binario.
[ -x "$VHOME/bin/velum" ] && "$VHOME/bin/velum" stop >/dev/null 2>&1 || true
mv -f "$TMP" "$BIN"
rm -f "$VHOME/velum-node.js" # restos de la versión con Bun
ok "velum-node $("$BIN" version) verificado (SHA-512)"

# ---------- 2. Clave y configuración ----------
INIT_ARGS=("$@")
if [ -n "${VELUM_PORT:-}" ]; then INIT_ARGS+=(--port "$VELUM_PORT"); fi
INFO="$(VELUM_HOME="$VHOME" "$BIN" init ${INIT_ARGS[@]+"${INIT_ARGS[@]}"})" || die "No se pudo preparar la configuración."
ADDRESS="$(printf '%s' "$INFO" | sed -n 's/.*"address":"\([^"]*\)".*/\1/p')"
PORT="$(printf '%s' "$INFO" | sed -n 's/.*"port":\([0-9]*\).*/\1/p')"
ok "Identidad del nodo: $ADDRESS"

# ---------- 3. Orden «velum» ----------
WRAP="$VHOME/bin/velum"
cat > "$WRAP" <<WRAPPER
#!/usr/bin/env bash
# Orden «velum»: controla el nodo de este ordenador.
set -uo pipefail
VHOME="$VHOME"
BIN="\$VHOME/bin/velum-node"
LABEL="$LABEL"
UNIT_NAME="$UNIT_NAME"
OS="\$(uname -s)"
PLIST="\$HOME/Library/LaunchAgents/\$LABEL.plist"
UNIT="\$HOME/.config/systemd/user/\$UNIT_NAME.service"
PIDFILE="\$VHOME/node.pid"
export VELUM_HOME="\$VHOME"

port() { sed -n 's/.*"port":[[:space:]]*\([0-9]*\).*/\1/p' "\$VHOME/config.json" 2>/dev/null | head -1 | grep . || echo 7420; }
url() { echo "http://localhost:\$(port)"; }
has_systemd() { command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1 && [ -f "\$UNIT" ]; }

# Sin servicio: bucle que reinicia el nodo cuando sale con 75 (actualización instalada o vuelta atrás).
start_bg() {
  if [ -f "\$PIDFILE" ] && kill -0 "\$(cat "\$PIDFILE")" 2>/dev/null; then return 0; fi
  nohup bash -c 'while :; do "\$0" start; c=\$?; [ \$c -eq 75 ] || exit \$c; done' "\$BIN" >>"\$VHOME/logs/node.log" 2>&1 &
  echo \$! > "\$PIDFILE"
}

do_start() {
  if [ "\$OS" = Darwin ] && [ -f "\$PLIST" ]; then
    launchctl bootstrap "gui/\$(id -u)" "\$PLIST" 2>/dev/null || launchctl kickstart "gui/\$(id -u)/\$LABEL" 2>/dev/null || true
  elif has_systemd; then systemctl --user start "\$UNIT_NAME"
  else start_bg; fi
}

do_stop() {
  if [ "\$OS" = Darwin ] && [ -f "\$PLIST" ]; then launchctl bootout "gui/\$(id -u)/\$LABEL" 2>/dev/null || true
  elif has_systemd; then systemctl --user stop "\$UNIT_NAME" 2>/dev/null || true
  fi
  if [ -f "\$PIDFILE" ]; then
    P="\$(cat "\$PIDFILE")"; pkill -P "\$P" 2>/dev/null || true; kill "\$P" 2>/dev/null || true; rm -f "\$PIDFILE"
  fi
  for _ in \$(seq 1 20); do curl -fsS "\$(url)/status" >/dev/null 2>&1 || return 0; sleep 0.25; done
}

wait_up() {
  for _ in \$(seq 1 60); do curl -fsS "\$(url)/status" >/dev/null 2>&1 && return 0; sleep 0.25; done
  return 1
}

case "\${1:-help}" in
  start)
    shift || true
    if [ \$# -gt 0 ]; then "\$BIN" init "\$@" >/dev/null || exit 1; do_stop; fi
    do_start
    if wait_up; then echo "Nodo en marcha. Panel: \$(url)"; else echo "El nodo no responde todavía. Mira: velum logs"; exit 1; fi ;;
  stop) do_stop; echo "Nodo parado. Vuelve a arrancar con: velum start" ;;
  restart) do_stop; do_start; wait_up && echo "Nodo reiniciado. Panel: \$(url)" ;;
  status) "\$BIN" status ;;
  logs) tail -n 60 -f "\$VHOME/logs/node.log" ;;
  pause)  curl -fsS -X POST "\$(url)/pause"  >/dev/null && echo "Aportación en pausa (el nodo sigue encendido)." || { echo "El nodo no responde."; exit 1; } ;;
  resume) curl -fsS -X POST "\$(url)/resume" >/dev/null && echo "Aportación encendida." || { echo "El nodo no responde."; exit 1; } ;;
  open) "\$BIN" open || { (command -v open >/dev/null && open "\$(url)") || (command -v xdg-open >/dev/null && xdg-open "\$(url)") || echo "\$(url)"; } ;;
  address) "\$BIN" address ;;
  version) "\$BIN" version ;;
  update)
    # El propio nodo comprueba la firma del manifiesto (clave de publicación) y el SHA-512 del binario.
    OUT="\$("\$BIN" update)"; C=\$?; echo "\$OUT"
    [ \$C -eq 0 ] || exit \$C
    case "\$OUT" in Actualizado*) do_stop; do_start; wait_up && echo "Ahora en \$("\$BIN" version). Panel: \$(url)" ;; esac ;;
  reset)
    do_stop
    "\$BIN" reset
    do_start
    wait_up && echo "Nodo reiniciado desde cero: se está resincronizando con la red." ;;
  uninstall)
    do_stop
    if [ "\$OS" = Darwin ]; then rm -f "\$PLIST"; fi
    if command -v systemctl >/dev/null 2>&1 && [ -f "\$UNIT" ]; then
      systemctl --user disable "\$UNIT_NAME" >/dev/null 2>&1 || true
      rm -f "\$UNIT"; systemctl --user daemon-reload >/dev/null 2>&1 || true
    fi
    if command -v crontab >/dev/null 2>&1; then (crontab -l 2>/dev/null | grep -v '# velum-node' | crontab -) 2>/dev/null || true; fi
    for rc in "\$HOME/.zshrc" "\$HOME/.bashrc" "\$HOME/.bash_profile" "\$HOME/.profile"; do
      [ -f "\$rc" ] && grep -q '# velum-node' "\$rc" && { sed -i.velum-bak '/# velum-node\$/d' "\$rc"; rm -f "\$rc.velum-bak"; }
    done
    if [ "\${2:-}" = "--purge" ]; then
      rm -rf "\$VHOME"; echo "Nodo desinstalado y datos borrados (incluida su clave)."
    else
      rm -f "\$VHOME/bin/velum-node" "\$VHOME/bin/velum-node.prev" "\$VHOME/bin/velum" "\$PIDFILE"; rmdir "\$VHOME/bin" 2>/dev/null || true
      echo "Nodo desinstalado. Se conservan la clave y los datos en \$VHOME (bórralos con: rm -rf \$VHOME)."
    fi ;;
  *)
    cat <<'HELP'
velum: controla el nodo Velum de este ordenador
  velum start [--name X --payout vel…]   arranca (y guarda opciones)
  velum stop | restart                   para / reinicia
  velum status                           estado, bloque, ganancias
  velum pause | resume                   apaga o enciende la aportación sin parar el proceso
  velum logs                             registro en vivo
  velum open                             abre el panel local
  velum update                           instala ya la última versión firmada (también lo hace solo cada hora)
  velum reset                            borra la cadena y los trozos (conserva clave y configuración) y resincroniza
  velum address | version                dirección del nodo / versión
  velum uninstall [--purge]              desinstala (--purge borra también la clave)
HELP
    ;;
esac
WRAPPER
chmod +x "$WRAP"
ok "Orden «velum» instalada en $WRAP"

# PATH: una línea marcada en los ficheros de arranque del shell (se quita al desinstalar).
LINE="export PATH=\"$VHOME/bin:\$PATH\" # velum-node"
added=0
for rc in "$HOME/.zshrc" "$HOME/.bashrc" "$HOME/.bash_profile" "$HOME/.profile"; do
  if [ -f "$rc" ]; then
    grep -q '# velum-node' "$rc" || printf '\n%s\n' "$LINE" >> "$rc"
    added=1
  fi
done
if [ $added = 0 ]; then
  if [ "$OS" = Darwin ]; then printf '%s\n' "$LINE" >> "$HOME/.zshrc"; else printf '%s\n' "$LINE" >> "$HOME/.bashrc"; fi
fi

# ---------- 4. Arranque automático (se reinicia solo al salir con 75 tras una actualización) ----------
"$WRAP" stop >/dev/null 2>&1 || true
if [ "$OS" = Darwin ]; then
  PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents"
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>$BIN</string><string>start</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>VELUM_HOME</key><string>$VHOME</string></dict>
  <key>WorkingDirectory</key><string>$VHOME</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$VHOME/logs/node.log</string>
  <key>StandardErrorPath</key><string>$VHOME/logs/node.log</string>
</dict>
</plist>
PLIST
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null || launchctl kickstart -k "gui/$(id -u)/$LABEL"
  ok "Arranque automático al iniciar sesión (LaunchAgent $LABEL)"
elif command -v systemctl >/dev/null 2>&1 && systemctl --user show-environment >/dev/null 2>&1; then
  UNIT="$HOME/.config/systemd/user/$UNIT_NAME.service"
  mkdir -p "$(dirname "$UNIT")"
  cat > "$UNIT" <<UNITFILE
[Unit]
Description=Nodo Velum
After=network-online.target

[Service]
Environment=VELUM_HOME=$VHOME
WorkingDirectory=$VHOME
ExecStart=$BIN start
Restart=on-failure
RestartSec=5
StandardOutput=append:$VHOME/logs/node.log
StandardError=append:$VHOME/logs/node.log

[Install]
WantedBy=default.target
UNITFILE
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT_NAME" >/dev/null 2>&1 || systemctl --user restart "$UNIT_NAME"
  loginctl enable-linger "$(id -un)" >/dev/null 2>&1 || true
  ok "Arranque automático con systemd (servicio de usuario $UNIT_NAME)"
else
  "$WRAP" start >/dev/null 2>&1 || true
  if command -v crontab >/dev/null 2>&1; then
    (crontab -l 2>/dev/null | grep -v '# velum-node'; echo "@reboot $WRAP start >/dev/null 2>&1 # velum-node") | crontab - 2>/dev/null || true
    ok "Arranque automático con cron (@reboot)"
  else
    say "Sin systemd ni cron: arranca el nodo a mano con «velum start» tras reiniciar."
  fi
fi

# ---------- 5. Listo ----------
for _ in $(seq 1 60); do curl -fsS "http://localhost:$PORT/status" >/dev/null 2>&1 && break; sleep 0.25; done
if curl -fsS "http://localhost:$PORT/status" >/dev/null 2>&1; then
  ok "Nodo en marcha"
else
  say "El nodo tarda en arrancar. Revisa: $VHOME/logs/node.log"
fi
echo
echo "  Panel del nodo:  http://localhost:$PORT"
echo "  Dirección:       $ADDRESS"
echo "  Órdenes:         velum status · velum pause · velum resume · velum update · velum reset · velum logs · velum uninstall"
echo "  (abre una terminal nueva para usar «velum», o ejecuta: $WRAP)"
