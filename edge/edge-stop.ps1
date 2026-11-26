#Requires -Version 5.1
<#
  停止 Edge 语音服务。
  桌宠会自动降级到 CosyVoice（若在跑）/ 瑶瑶 / 电子音，不会哑。

  用法：
    powershell -ExecutionPolicy Bypass -File D:\ai\edge\edge-stop.ps1
#>
$port = 9881
$conns = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if (-not $conns) {
  Write-Host "服务未在运行" -ForegroundColor Yellow
  exit 0
}
foreach ($p in ($conns | Select-Object -ExpandProperty OwningProcess -Unique)) {
  try {
    Stop-Process -Id $p -Force -ErrorAction Stop
    Write-Host "已停止 PID $p" -ForegroundColor Green
  } catch {
    Write-Host "停止 PID $p 失败：$($_.Exception.Message)" -ForegroundColor Red
  }
}
