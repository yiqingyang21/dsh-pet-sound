#Requires -Version 5.1
<#
  停止 CosyVoice2 服务（释放约 2.5GB 显存）。
  打游戏前可以跑这个；桌宠会自动降级回瑶瑶/电子音，不会哑。

  用法：
    powershell -ExecutionPolicy Bypass -File D:\ai\cosy\stop.ps1
#>
$port = 9880
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "服务未在运行" -ForegroundColor Yellow
  exit 0
}
$pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
foreach ($p in $pids) {
  try {
    Stop-Process -Id $p -Force -ErrorAction Stop
    Write-Host "已停止 PID $p" -ForegroundColor Green
  } catch {
    Write-Host "停止 PID $p 失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}
