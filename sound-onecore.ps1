# dsh-pet 声音系统 · OneCore 语音宿主（常驻进程）
#
# 为什么需要它：Chromium 的 speechSynthesis 在这套 Electron 里看不到任何语音；
# 而 SAPI5 只能看到 Huihui（偏"播报腔"）。更年轻的女声 Yaoyao 只存在于 OneCore 引擎里，
# 只能通过 WinRT 的 Windows.Media.SpeechSynthesis 调用。
#
# 协议（stdin/stdout，一行一条消息，均为纯 ASCII，避免编码问题）：
#   启动 → 打印 "RDY <voiceName>"
#   收 base64(UTF-8 文本) → 合成 → 播放 → 打印 "OK"
#   出错 → 打印 "ERR <message>"，继续循环
#   stdin 关闭 → 退出
#
# 为什么要常驻：WinRT 初始化 + 合成每次约 1~2 秒。常驻后只有第一句慢，
# 之后每句只付合成时间（几十到几百毫秒），宠物说话才跟得上气泡。
#
# 参数（环境变量）：
#   PET_VOICE     优先选的语音名（模糊匹配，默认 Yaoyao）
#   PET_RATE      语速百分比（SSML prosody rate，100 = 原速）
#   PET_PITCH     音调偏移（SSML prosody pitch，单位 Hz，正数更高更"甜"）
#   PET_VOLUME    音量 0~100

$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

$syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices

$want = $env:PET_VOICE
if (-not $want) { $want = 'Yaoyao' }
$pick = $null
foreach ($v in $voices) {
  if ($v.DisplayName -like "*$want*") { $pick = $v; break }
}
if (-not $pick) {
  foreach ($v in $voices) { if ($v.Language -like 'zh*') { $pick = $v; break } }
}
if ($pick) { $syn.Voice = $pick }

$ratePct = $env:PET_RATE
if (-not $ratePct) { $ratePct = '100' }
$pitchHz = $env:PET_PITCH
if (-not $pitchHz) { $pitchHz = '0' }
$vol = $env:PET_VOLUME
if (-not $vol) { $vol = '100' }

$voiceName = if ($pick) { $pick.DisplayName } else { 'default' }
[Console]::Out.WriteLine('RDY ' + $voiceName)
[Console]::Out.Flush()

while ($true) {
  $line = [Console]::In.ReadLine()
  if ($null -eq $line) { break }
  $line = $line.Trim()
  if ($line.Length -eq 0) { continue }

  try {
    $text = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line))
    $safe = [System.Security.SecurityElement]::Escape($text)
    $ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
      "<prosody rate='$ratePct%' pitch='+$pitchHz" + "Hz' volume='$vol'>" + $safe + '</prosody></speak>'

    $op = $syn.SynthesizeSsmlToStreamAsync($ssml)
    $t = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
    $t.Wait()
    $stream = $t.Result

    $reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
    $lt = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($reader.LoadAsync([uint32]$stream.Size)))
    $lt.Wait()
    $bytes = New-Object 'byte[]' $stream.Size
    $reader.ReadBytes($bytes)

    # SoundPlayer 走 winmm，不需要额外依赖；PlaySync 保证这一句念完再收下一句
    $ms = New-Object System.IO.MemoryStream(, $bytes)
    $player = New-Object System.Media.SoundPlayer($ms)
    $player.PlaySync()
    $player.Dispose()
    $ms.Dispose()

    [Console]::Out.WriteLine('OK')
    [Console]::Out.Flush()
  } catch {
    $msg = $_.Exception.Message
    if ($msg.Length -gt 200) { $msg = $msg.Substring(0, 200) }
    [Console]::Out.WriteLine('ERR ' + $msg)
    [Console]::Out.Flush()
  }
}
