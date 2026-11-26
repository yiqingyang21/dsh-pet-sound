# Edge 神经语音（在线，零显存）

给桌宠当**首选**语音引擎：用微软 Edge 的在线神经语音（`edge-tts`），本地只跑一个 60MB 的转发服务。

## 为什么不用本地模型

上一篇 [`../cosyvoice/`](../cosyvoice/README.md) 用的是 CosyVoice2 零样本克隆。
它的效果取决于**参考音**——如果参考音本身是合成音（比如系统 TTS 的输出），
克隆结果会继承那层机械感，听起来仍然"电子"。

Edge 是**原生合成**，不是克隆，所以没有这一层损耗；代价是需要联网。

| 方案 | 显存 | 内存 | 单句延迟 | 离线 |
| --- | --- | --- | --- | --- |
| **Edge（本方案）** | **0** | 约 60 MB | 1.7~2.4 s | ❌ 需联网 |
| CosyVoice2-0.5B | 2.5 GB | 约 6 GB | 1.9~2.3 s | ✅ |
| Windows OneCore（Yaoyao） | 0 | 约 60 MB | 约 0.5 s | ✅ |
| Web Audio 电子音 | 0 | 0 | 即时 | ✅ |

实测：从 CosyVoice 切到 Edge 后，显存占用 4949 MiB → **1161 MiB**，可用内存 2.9 GB → **8.8 GB**。

## 可用音色（zh-CN）

```
zh-CN-XiaoyiNeural      女  年轻活泼（本项目默认，+25Hz 更幼）
zh-CN-XiaoxiaoNeural    女  最成熟的自然女声
zh-CN-YunxiNeural       男
zh-CN-YunjianNeural     男
zh-CN-YunxiaNeural      男
zh-CN-YunyangNeural     男
zh-CN-liaoning-XiaobeiNeural   女  东北口音
zh-CN-shaanxi-XiaoniNeural     女  中原官话
```

## 依赖

```powershell
pip install edge-tts fastapi uvicorn
```

外加 `ffmpeg`（把 mp3 转成 16kHz 单声道 wav 给 WebAudio 解码）。
本项目用 `D:\ai\ffmpeg\ffmpeg.exe`，可通过 `FFMPEG_PATH` 环境变量覆盖。

## 运行

```powershell
powershell -ExecutionPolicy Bypass -File edge-start.ps1   # 已在跑则跳过
powershell -ExecutionPolicy Bypass -File edge-stop.ps1    # 停止
```

服务监听 `127.0.0.1:9881`，已开 CORS（桌宠是 `file://` 页面，Origin 为 `null`）。

## 调音色 / 音调 / 语速

服务端读环境变量：

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `EDGE_VOICE` | `zh-CN-XiaoyiNeural` | 音色 |
| `EDGE_PITCH` | `+25Hz` | 音调偏移（越大越尖，`+0Hz` 为原声） |
| `EDGE_RATE` | `+3%` | 语速 |
| `EDGE_VOLUME` | `+0%` | 音量 |
| `FFMPEG_PATH` | `D:\ai\ffmpeg\ffmpeg.exe` | ffmpeg 路径 |

改完重启服务即可。实测音高：默认晓伊 F0 ≈ 312 Hz，`+25Hz` 后 ≈ 364 Hz。

## 开机自启

用**当前用户**启动项（不需要管理员权限）：

```powershell
# 注册
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" `
  -Name "DshPetEdgeTTS" -Value 'wscript.exe "D:\ai\edge\autostart.vbs"'

# 取消
powershell -ExecutionPolicy Bypass -File remove-autostart.ps1
```

`autostart.vbs` 用 `WScript.Shell` 以窗口样式 `0` 启动 PowerShell，**不会闪黑框**。

> 开机时序：如果宿主（DSH）比语音服务先就绪，桌宠启动时的探测会失败并降级。
> `sound.js` 里已加自动重试——失败后每 20 秒重试一次，最多 30 次（约 10 分钟），
> 服务一就绪就自动切回。

## 接口

```
GET  /health
     -> {"ok":true,"voice":"zh-CN-XiaoyiNeural","pitch":"+25Hz","rate":"+3%"}

POST /tts   {"text": "要念的话"}
     -> audio/wav（16kHz 单声道 PCM）
```

## 已知限制

- **需要联网**。断网时服务调用失败，桌宠自动降级到 CosyVoice（若在跑）/ 系统语音 / 电子音
- `edge-tts` 走的是微软 Edge 朗读接口的非官方调用，接口若变动可能失效（降级链会兜住）
- 单句延迟 1.7~2.4 秒，主要是网络往返；本地模型反而不会更快（CosyVoice 也要 1.9~2.3 秒）
