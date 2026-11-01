# Instalador del nodo Velum para Windows. Sin permisos de administrador y sin Bun: descarga el binario compilado.
#   irm https://velumprotocol.org/install.ps1 | iex
# Variables: VELUM_HOME (datos, %USERPROFILE%\.velum), VELUM_PORT (7420), VELUM_DOWNLOAD_BASE, VELUM_NAME, VELUM_PAYOUT.
# Se puede repetir sin miedo: actualiza el binario y conserva clave y configuración.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

function Say($m) { Write-Host "> $m" -ForegroundColor Yellow }
function Ok($m) { Write-Host "OK $m" -ForegroundColor Green }
function Die($m) { Write-Host "ERROR $m" -ForegroundColor Red; throw $m }

# Orígenes por orden (si uno está bloqueado se prueba el siguiente).
$Bases = if ($env:VELUM_DOWNLOAD_BASE) { @($env:VELUM_DOWNLOAD_BASE.TrimEnd('/')) } else { @('https://velumprotocol.org', 'https://velum.consultorabim.com', 'https://velum.consultora-bim.workers.dev') }
$VHome = if ($env:VELUM_HOME) { $env:VELUM_HOME } else { Join-Path $env:USERPROFILE '.velum' }
$TaskName = if ($env:VELUM_SERVICE_LABEL) { $env:VELUM_SERVICE_LABEL } else { 'VelumNode' }
$Plat = 'windows-x64'
if ($env:PROCESSOR_ARCHITECTURE -ne 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ne 'AMD64') { Die "Procesador no compatible ($env:PROCESSOR_ARCHITECTURE). Solo Windows x64." }

# ---------- 1. Binario (manifiesto -> URL, SHA-512 y tamaño) ----------
$BinDir = Join-Path $VHome 'bin'
New-Item -ItemType Directory -Force -Path $BinDir, (Join-Path $VHome 'logs') | Out-Null
Say "Buscando la última versión para $Plat..."
$m = $null
foreach ($b in $Bases) { try { $m = Invoke-RestMethod -UseBasicParsing -TimeoutSec 15 -Uri "$b/download/manifest.json"; if ($m.files) { break } } catch { $m = $null } }
if (-not $m) { Die "No se pudo leer el manifiesto en: $($Bases -join ', ')" }
$f = $m.files.$Plat
if (-not $f) { Die "La versión publicada no trae binario para $Plat." }
$Exe = Join-Path $BinDir 'velum-node.exe'
$Tmp = "$Exe.download"
Say "Descargando velum-node $($m.version)..."
Invoke-WebRequest -UseBasicParsing -Uri $f.url -OutFile $Tmp
$sum = (Get-FileHash -Algorithm SHA512 $Tmp).Hash.ToLower()
if ($sum -ne $f.sha512) { Remove-Item -Force $Tmp; Die 'La descarga no coincide con su huella SHA-512: se descarta.' }
# Si ya había un nodo en marcha, se para (un .exe en marcha no se puede sobrescribir).
Get-Process velum-node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 500
Move-Item -Force $Tmp $Exe
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $VHome 'velum-node.js')
Ok "velum-node $(& $Exe version) verificado (SHA-512)"

# ---------- 2. Clave y configuración ----------
$env:VELUM_HOME = $VHome
$initArgs = @('init')
if ($env:VELUM_NAME) { $initArgs += @('--name', $env:VELUM_NAME) }
if ($env:VELUM_PAYOUT) { $initArgs += @('--payout', $env:VELUM_PAYOUT) }
if ($env:VELUM_PORT) { $initArgs += @('--port', $env:VELUM_PORT) }
$info = (& $Exe @initArgs) | ConvertFrom-Json
if (-not $info.address) { Die 'No se pudo preparar la configuración.' }
$Port = $info.port
Ok "Identidad del nodo: $($info.address)"

# ---------- 3. Lanzador (bucle: si el nodo sale con 75 tras una actualización, vuelve a arrancar) ----------
$Log = Join-Path $VHome 'logs\node.log'
$Loop = Join-Path $BinDir 'velum-loop.cmd'
@"
@echo off
set VELUM_HOME=$VHome
:loop
"$Exe" start >> "$Log" 2>&1
if %ERRORLEVEL%==75 goto loop
"@ | Set-Content -Encoding ASCII $Loop
$Vbs = Join-Path $BinDir 'velum-hidden.vbs'
# Arranca el lanzador sin ventana.
@"
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """"$Loop""""", 0, False
"@ | Set-Content -Encoding ASCII $Vbs

# ---------- 4. Orden «velum» ----------
$Ps = Join-Path $BinDir 'velum.ps1'
@"
# Orden «velum»: controla el nodo de este ordenador.
param([string]`$Cmd = 'help', [Parameter(ValueFromRemainingArguments = `$true)][string[]]`$Rest)
`$VHome = '$VHome'; `$Task = '$TaskName'; `$Vbs = '$Vbs'
`$env:VELUM_HOME = `$VHome
`$Exe = Join-Path `$VHome 'bin\velum-node.exe'
function Port { try { (Get-Content (Join-Path `$VHome 'config.json') -Raw | ConvertFrom-Json).port } catch { 7420 } }
function Url { "http://localhost:`$(Port)" }
function Loops { Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" | Where-Object { `$_.CommandLine -like "*velum-loop.cmd*" } }
function Stop-Node {
  Loops | ForEach-Object { Stop-Process -Id `$_.ProcessId -Force -ErrorAction SilentlyContinue }
  Get-Process velum-node -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
}
function Start-Node { if (-not (Get-Process velum-node -ErrorAction SilentlyContinue)) { Start-Process wscript.exe -ArgumentList ('"' + `$Vbs + '"') -WindowStyle Hidden } }
function Wait-Up { for (`$i = 0; `$i -lt 60; `$i++) { try { Invoke-RestMethod "`$(Url)/status" | Out-Null; return `$true } catch { Start-Sleep -Milliseconds 250 } }; `$false }
switch (`$Cmd) {
  'start' {
    if (`$Rest) { & `$Exe init @Rest | Out-Null; Stop-Node }
    Start-Node; if (Wait-Up) { "Nodo en marcha. Panel: `$(Url)" } else { 'El nodo no responde todavía. Mira: velum logs' } }
  'stop' { Stop-Node; 'Nodo parado. Vuelve a arrancar con: velum start' }
  'restart' { Stop-Node; Start-Sleep 1; Start-Node; if (Wait-Up) { "Nodo reiniciado. Panel: `$(Url)" } }
  'status' { & `$Exe status }
  'logs' { Get-Content (Join-Path `$VHome 'logs\node.log') -Tail 60 -Wait }
  'pause' { Invoke-RestMethod -Method Post "`$(Url)/pause" | Out-Null; 'Aportación en pausa (el nodo sigue encendido).' }
  'resume' { Invoke-RestMethod -Method Post "`$(Url)/resume" | Out-Null; 'Aportación encendida.' }
  'open' { & `$Exe open; if (`$LASTEXITCODE -ne 0) { Start-Process (Url) } }
  'address' { & `$Exe address }
  'version' { & `$Exe version }
  'update' {
    # El nodo comprueba la firma del manifiesto y el SHA-512; en Windows cambia el .exe renombrándolo (exe -> .prev).
    `$out = & `$Exe update; `$out
    if (`$out -like 'Actualizado*') { Stop-Node; Start-Sleep 1; Start-Node; if (Wait-Up) { "Ahora en `$(& `$Exe version). Panel: `$(Url)" } } }
  'reset' { Stop-Node; Start-Sleep 1; & `$Exe reset; Start-Node; if (Wait-Up) { 'Nodo reiniciado desde cero: se está resincronizando con la red.' } }
  'uninstall' {
    Stop-Node
    Unregister-ScheduledTask -TaskName `$Task -Confirm:`$false -ErrorAction SilentlyContinue
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path ([Environment]::GetFolderPath('Startup')) 'Velum.lnk')
    `$bin = Join-Path `$VHome 'bin'
    `$p = [Environment]::GetEnvironmentVariable('Path', 'User')
    if (`$p) { [Environment]::SetEnvironmentVariable('Path', ((`$p -split ';') | Where-Object { `$_ -and `$_ -ne `$bin }) -join ';', 'User') }
    Start-Sleep -Milliseconds 500
    if (`$Rest -contains '--purge') { Set-Location `$env:USERPROFILE; Remove-Item -Recurse -Force `$VHome; 'Nodo desinstalado y datos borrados (incluida su clave).' }
    else { Remove-Item -Recurse -Force -ErrorAction SilentlyContinue `$bin; "Nodo desinstalado. Se conservan la clave y los datos en `$VHome." } }
  default {
    'velum: controla el nodo Velum de este ordenador'
    '  velum start [--name X --payout vel...]   arranca (y guarda opciones)'
    '  velum stop | restart | status | logs | open | address | version'
    '  velum pause | resume                     apaga o enciende la aportación sin parar el proceso'
    '  velum update                             instala ya la última versión firmada (también lo hace solo cada hora)'
    '  velum reset                              borra la cadena y los trozos (conserva clave y configuración)'
    '  velum uninstall [--purge]                desinstala (--purge borra también la clave)' }
}
"@ | Set-Content -Encoding UTF8 $Ps

$Cmd = Join-Path $BinDir 'velum.cmd'
"@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$Ps`" %*" | Set-Content -Encoding ASCII $Cmd
Ok "Orden «velum» instalada en $Cmd"

$userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
if (-not $userPath -or -not (($userPath -split ';') -contains $BinDir)) {
  [Environment]::SetEnvironmentVariable('Path', ((@($userPath, $BinDir) | Where-Object { $_ }) -join ';'), 'User')
}
$env:Path = "$env:Path;$BinDir"

# ---------- 5. Arranque automático (tarea al iniciar sesión; si no hay permiso, acceso directo en Inicio) ----------
& $Ps stop | Out-Null
try {
  $action = New-ScheduledTaskAction -Execute 'wscript.exe' -Argument "`"$Vbs`""
  $trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero)
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Description 'Nodo Velum' -Force | Out-Null
  Ok "Arranque automático al iniciar sesión (tarea programada $TaskName)"
} catch {
  # En algunos equipos (p. ej. PUESTO-16) registrar tareas falla sin ser administrador: acceso directo en Inicio.
  $lnk = Join-Path ([Environment]::GetFolderPath('Startup')) 'Velum.lnk'
  $ws = New-Object -ComObject WScript.Shell
  $sc = $ws.CreateShortcut($lnk); $sc.TargetPath = 'wscript.exe'; $sc.Arguments = "`"$Vbs`""; $sc.WindowStyle = 7; $sc.Save()
  Ok 'Arranque automático con un acceso directo en Inicio'
}
& $Ps start | Out-Null

# ---------- 6. Listo ----------
$up = $false
for ($i = 0; $i -lt 60; $i++) { try { Invoke-RestMethod "http://localhost:$Port/status" | Out-Null; $up = $true; break } catch { Start-Sleep -Milliseconds 250 } }
if ($up) { Ok 'Nodo en marcha' } else { Say "El nodo tarda en arrancar. Revisa: $Log" }
Write-Host ''
Write-Host "  Panel del nodo:  http://localhost:$Port"
Write-Host "  Dirección:       $($info.address)"
Write-Host '  Órdenes:         velum status · velum pause · velum resume · velum update · velum reset · velum logs · velum uninstall'
Write-Host '  (abre una terminal nueva para usar «velum»)'
