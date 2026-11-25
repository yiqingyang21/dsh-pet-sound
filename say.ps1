#Requires -Version 5.1
<#
  让大肥鱼说一句话（走宿主的 /broadcast 投喂端点，宠物 1 秒内显示气泡并朗读）。
  用来快速验证声音系统，也可以当"给宠物递话"的小工具。

  用法：
    powershell -ExecutionPolicy Bypass -File say.ps1
    powershell -ExecutionPolicy Bypass -File say.ps1 -Text "主人，我饿了"
    powershell -ExecutionPolicy Bypass -File say.ps1 -Port 53246 -Duration 12000

  端口：DSH 网页界面的地址端口（默认 53246）。不确定就先打开 DSH 页面看地址栏。
#>
param(
  [string]$Text = '主人，声音系统装好啦，我现在能出声咯～',
  [string]$Pet = 'main',
  [int]$Duration = 8000,
  [int]$Port = 53246
)

$ErrorActionPreference = 'Stop'
$body = @{ text = $Text; duration = $Duration } | ConvertTo-Json -Compress
$uri = "http://127.0.0.1:$Port/dsh-pet-7340/broadcast?pet=$Pet&surface=desktop"

try {
  $r = Invoke-WebRequest -Uri $uri -Method POST -Body $body -ContentType 'application/json; charset=utf-8' -UseBasicParsing -TimeoutSec 8
  $obj = $r.Content | ConvertFrom-Json
  if ($obj.ok) {
    Write-Host "已投喂：$Text" -ForegroundColor Green
    Write-Host "（宠物应当立刻冒气泡并出声；没声音就看 ~/.dsh/dsh-pet/sound.jsonc 的 enabled / volume）" -ForegroundColor DarkGray
  } else {
    Write-Host ("宿主拒绝了：" + $obj.reason + " / " + $obj.message) -ForegroundColor Yellow
  }
} catch {
  Write-Host ("连不上宿主的 127.0.0.1:$Port —— 确认 DSH 在运行，并检查端口（参数 -Port）") -ForegroundColor Red
  Write-Host $_.Exception.Message -ForegroundColor DarkGray
}
