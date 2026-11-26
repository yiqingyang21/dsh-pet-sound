#Requires -Version 5.1
<#
  启动 Edge 神经语音转发服务（桌宠首选语音，零显存）。
  已在运行则跳过。

  用法：
    powershell -ExecutionPolicy Bypass -File D:\ai\edge\edge-start.ps1
#>
$ErrorActionPreference = 'Stop'
$port = 9881
$dir = 'D:\ai\edge'
$py = 'D:\ai\venv\Scripts\python.exe'

function Test-Up {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/health" -UseBasicParsing -TimeoutSec 3
    return ($r.StatusCode -eq 200)
  } catch { return $false }
}

if (Test-Up) {
  Write-Host "服务已在运行：http://127.0.0.1:$port" -ForegroundColor Green
  exit 0
}

Write-Host "启动 Edge 语音服务（秒级就绪）…" -ForegroundColor Cyan
$p = Start-Process -FilePath $py `
  -ArgumentList @('-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', "$port", '--log-level', 'warning') `
  -WorkingDirectory $dir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') `
  -RedirectStandardError (Join-Path $dir 'server.err')

for ($i = 0; $i -lt 20; $i++) {
  Start-Sleep -Seconds 1
  if (Test-Up) {
    Write-Host "就绪（PID $($p.Id)）：http://127.0.0.1:$port/health" -ForegroundColor Green
    exit 0
  }
}
Write-Host "启动失败，看 D:\ai\edge\server.err" -ForegroundColor Red
exit 1
