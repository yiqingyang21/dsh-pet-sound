#Requires -Version 5.1
<#
  启动 CosyVoice2 本地 TTS 服务（供桌宠调用）。
  已在运行则直接跳过。

  用法：
    powershell -ExecutionPolicy Bypass -File D:\ai\cosy\start.ps1
#>
$ErrorActionPreference = 'Stop'
$port = 9880
$dir = 'D:\ai\cosy'
$py = Join-Path $dir 'venv\Scripts\python.exe'

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

Write-Host "启动 CosyVoice2 服务（首次加载模型约 15~20 秒）…" -ForegroundColor Cyan
$p = Start-Process -FilePath $py `
  -ArgumentList @('-m', 'uvicorn', 'server:app', '--host', '127.0.0.1', '--port', "$port", '--log-level', 'warning') `
  -WorkingDirectory $dir -PassThru -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dir 'server.log') `
  -RedirectStandardError (Join-Path $dir 'server.err')

for ($i = 0; $i -lt 60; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Up) {
    Write-Host "就绪（PID $($p.Id)）：http://127.0.0.1:$port/health" -ForegroundColor Green
    exit 0
  }
}
Write-Host "启动超时，看 D:\ai\cosy\server.err" -ForegroundColor Red
exit 1
