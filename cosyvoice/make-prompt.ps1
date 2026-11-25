$ErrorActionPreference = 'Stop'
# 用 OneCore 瑶瑶合成一段"参考音"给 CosyVoice2 做零样本音色迁移。
# 为什么不用官方 demo 的 prompt：那是真人录音的声线；用系统合成音做参考，来源干净。
$out = $env:PROMPT_WAV
$pitch = $env:PROMPT_PITCH
$rate = $env:PROMPT_RATE
if (-not $out) { $out = 'D:\ai\cosy\prompt_yaoyao.wav' }
if (-not $pitch) { $pitch = '30' }
if (-not $rate) { $rate = '100' }

Add-Type -AssemblyName System.Runtime.WindowsRuntime
[void][Windows.Media.SpeechSynthesis.SpeechSynthesizer, Windows.Media, ContentType = WindowsRuntime]
[void][Windows.Storage.Streams.DataReader, Windows.Storage, ContentType = WindowsRuntime]

$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
    $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  })[0]

$syn = New-Object Windows.Media.SpeechSynthesis.SpeechSynthesizer
$voices = [Windows.Media.SpeechSynthesis.SpeechSynthesizer]::AllVoices
$pick = $null
foreach ($v in $voices) { if ($v.DisplayName -like '*Yaoyao*') { $pick = $v; break } }
if (-not $pick) { foreach ($v in $voices) { if ($v.Language -like 'zh*') { $pick = $v; break } } }
if ($pick) { $syn.Voice = $pick }

$text = '你好呀，我是你的桌面宠物，今天也要开开心心的哦。'
$ssml = "<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'>" +
  "<prosody rate='$rate" + "%' pitch='+$pitch" + "Hz'>" + $text + '</prosody></speak>'

$op = $syn.SynthesizeSsmlToStreamAsync($ssml)
$t = $asTask.MakeGenericMethod([Windows.Media.SpeechSynthesis.SpeechSynthesisStream]).Invoke($null, @($op))
$t.Wait()
$stream = $t.Result
$reader = New-Object Windows.Storage.Streams.DataReader($stream.GetInputStreamAt(0))
$lt = $asTask.MakeGenericMethod([uint32]).Invoke($null, @($reader.LoadAsync([uint32]$stream.Size)))
$lt.Wait()
$bytes = New-Object 'byte[]' $stream.Size
$reader.ReadBytes($bytes)
[System.IO.File]::WriteAllBytes($out, $bytes)
Write-Output ('WAV ' + $out + ' ' + $bytes.Length + ' bytes  voice=' + $(if ($pick) { $pick.DisplayName } else { 'default' }))
