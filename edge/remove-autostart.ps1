#Requires -Version 5.1
<#
  取消 Edge 语音服务的开机自启（不会删除服务本身）。

  用法：
    powershell -ExecutionPolicy Bypass -File D:\ai\edge\remove-autostart.ps1
#>
$runKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
$name = "DshPetEdgeTTS"
$cur = (Get-ItemProperty -Path $runKey -Name $name -ErrorAction SilentlyContinue)
if (-not $cur) {
  Write-Host "未注册自启，无需处理" -ForegroundColor Yellow
  exit 0
}
Remove-ItemProperty -Path $runKey -Name $name -Force
Write-Host "已取消自启（服务本身保留，可手动 edge-start.ps1 启动）" -ForegroundColor Green
