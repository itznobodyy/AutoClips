# AutoClips - arranque completo
# Ejecutar desde la carpeta del proyecto: .\start.ps1

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$ngrok = "C:\Users\Zeta\AppData\Local\Microsoft\WinGet\Links\ngrok.exe"

Write-Host "Arrancando AutoClips..." -ForegroundColor Cyan

# Matar procesos anteriores si quedaron colgados
Get-Process -Name node -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowTitle -eq "" } |
  Stop-Process -Force -ErrorAction SilentlyContinue

Stop-Process -Name ngrok -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 1

# Arrancar el servidor Node
$server = Start-Process -FilePath "node" `
  -ArgumentList "server.js" `
  -WorkingDirectory $root `
  -PassThru -WindowStyle Hidden
Write-Host "Servidor Node PID: $($server.Id)"

# Esperar a que el servidor responda
$ready = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 1
  try {
    $h = Invoke-RestMethod http://localhost:8080/healthz -ErrorAction Stop
    if ($h.ok) { $ready = $true; break }
  } catch {}
}

if (-not $ready) {
  Write-Host "ERROR: el servidor no arranco." -ForegroundColor Red
  exit 1
}
Write-Host "Servidor listo." -ForegroundColor Green

# Arrancar ngrok con dominio fijo
$tunnel = Start-Process -FilePath $ngrok `
  -ArgumentList "start autoclips" `
  -PassThru -WindowStyle Hidden
Write-Host "ngrok PID: $($tunnel.Id)"

Start-Sleep -Seconds 5

try {
  $t = Invoke-RestMethod http://127.0.0.1:4040/api/tunnels
  $url = $t.tunnels[0].public_url
  Write-Host ""
  Write-Host "AutoClips en linea:" -ForegroundColor Green
  Write-Host $url -ForegroundColor Yellow
  Write-Host ""
  Write-Host "Cierra esta ventana para detener el servicio." -ForegroundColor DarkGray
} catch {
  Write-Host "ngrok no respondio. Revisa el dashboard: https://dashboard.ngrok.com" -ForegroundColor Red
}

# Mantener vivo hasta que el usuario cierre
Wait-Process -Id $server.Id
