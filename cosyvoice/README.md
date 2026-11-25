# 在 Windows 上把 CosyVoice2 跑起来（给桌宠当 TTS 后端）

记录一次真实安装：RTX 4060 8GB + Python 3.11 + **无 WSL、无 conda、无 MSVC** 的环境下，
把 CosyVoice2-0.5B 跑成常驻 HTTP 服务，并用系统合成音做参考音接进桌宠。

## 结果

| 指标 | 实测 |
| --- | --- |
| 模型 | `iic/CosyVoice2-0.5B`（约 5.3 GB） |
| 显存 | 约 2.5 GB（fp16） |
| 单句延迟 | 1.4~2.3 秒（RTF ≈ 0.8~0.9） |
| 输出音高 | F0 约 300 Hz（少女向） |
| 冷启动 | 加载模型 15~20 秒 |

## 目录

```
D:\ai\cosy\
├─ venv\                 独立虚拟环境
├─ CosyVoice\            源码（codeload 下的 tarball）
├─ Matcha-TTS\           子模块源码（只加进 PYTHONPATH，不编译）
├─ models\CosyVoice2-0.5B\
├─ prompt_yaoyao.wav     参考音（系统 TTS 合成）
├─ server.py             本文件同目录
├─ cosy-start.ps1 / cosy-stop.ps1
└─ constraints.txt       锁 numpy==1.26.4 / pyarrow==17.0.0
```

## 安装要点（按顺序）

### 1. Python 与 torch

独立 venv，torch 装 CUDA 版（`cu121`）。Windows 上 PyTorch 官方源的 CUDA 轮子很大（2.4GB），
国内建议用支持断点续传的多线程下载器，不要指望单连接。

### 2. 依赖：不要直接 `pip install -r requirements.txt`

官方 requirements 里有几类会卡住的：

| 依赖 | 问题 | 处理 |
| --- | --- | --- |
| `pynini`（旧版 WeTextProcessing） | **Windows 无 wheel**，要编译 OpenFst | 新版已改用纯 Python 的 `wetext`，直接用新版 |
| `deepspeed` / `tensorrt-*` / `onnxruntime-gpu` | 仅 Linux | 跳过，Windows 用 `onnxruntime` |
| `gradio` / `tensorboard` / `openai-whisper` | 体积大且非推理必需 | 按需；但 **`openai-whisper` 是必需的**（`cosyvoice/cli/frontend.py` 会 import） |
| `pyarrow` | 新版强制 `numpy>=2` | **锁 `pyarrow==17.0.0`** |

安装命令（关键是用 constraints 把 numpy 钉死）：

```powershell
pip install -r requirements-filtered.txt -i https://pypi.tuna.tsinghua.edu.cn/simple
pip install -c constraints.txt openai-whisper pyarrow==17.0.0
```

`constraints.txt`：

```
numpy==1.26.4
pyarrow==17.0.0
```

> 为什么必须锁 numpy 1.x：`onnxruntime==1.18` 和 `torchmetrics` 的二进制是按 numpy 1.x 编译的，
> 升到 2.x 会直接 `ImportError` / `_ARRAY_API not found`。而且 `matplotlib`、`seaborn`、`pyarrow`
> 安装时**会顺手把 numpy 顶上去**，所以每次装包都要带 `-c constraints.txt`，装完再验一次版本。

### 3. Matcha-TTS：编译会失败，但推理不需要

`third_party/Matcha-TTS` 是 git 子模块，tarball 里没有。单独下载后 `pip install -e .` 会报：

```
distutils.errors.DistutilsPlatformError: Microsoft Visual C++ 14.0 or greater is required
```

它的 Cython 扩展（`monotonic_align`）只在训练对齐时用。CosyVoice 推理只需要：

```
matcha.models.components.decoder
matcha.models.components.transformer
matcha.models.components.flow_matching
matcha.hifigan.models
matcha.utils.audio
```

这些都是纯 Python。所以**不编译**，直接把源码目录加进 `sys.path` / `PYTHONPATH` 即可：

```python
sys.path.insert(0, r"D:\ai\cosy\Matcha-TTS")
sys.path.insert(0, r"D:\ai\cosy\CosyVoice")
```

注意 `matcha.utils` 的 `__init__` 会连带 import `gdown`、`matplotlib`、`wget`、`pandas`，
这几个要装（都很小）。

### 4. 模型下载

ModelScope 的 Python API 比 CLI 可靠（`python -m modelscope` 在这个版本里没有 `__main__`）：

```python
from modelscope import snapshot_download
snapshot_download("iic/CosyVoice2-0.5B", local_dir=r"D:\ai\cosy\models\CosyVoice2-0.5B")
```

### 5. 参考音：0.5B 模型没有内置音色

`CosyVoice2-0.5B` 的 `spk2info` 是空的，`list_available_spks()` 返回 `[]`。
所以**必须**给 `prompt_wav + prompt_text` 做零样本迁移。

本项目用系统 TTS（Windows OneCore 的 Yaoyao，SSML 抬 +30Hz）合成了一段参考音：

```powershell
powershell -ExecutionPolicy Bypass -File make-prompt.ps1
```

这样音色来源是**合成音**，不涉及真人声线。

## 关于 instruct 模式

CosyVoice2 支持 `inference_instruct2(text, instruct_text, prompt_wav)`，用自然语言描述语气。
但实测**同一句话**：

| 模式 | 时长 |
| --- | --- |
| 零样本 | 3.0 秒 |
| instruct「甜美少女语气，语速稍快」 | 9.0 秒 |

语速被拖成约 1/3，而且音高反而下降。所以本项目默认**不用 instruct**，只走零样本。

## 已知小问题

`wetext` 会尝试从 ModelScope 拉前端模型（需要登录 token），拉不到时打印
`no frontend is available`。影响是数字/单位归一化失效（"2024年"可能读得不自然），
纯中文文本不受影响。要修的话设 `MODELSCOPE_API_TOKEN` 环境变量。

## 服务接口

```
GET  /health
     -> {"ok":true,"model":"CosyVoice2-0.5B","loaded":true,"vram_mb":2507,
         "device":"NVIDIA GeForce RTX 4060"}

POST /tts   {"text": "要念的话"}
     -> audio/wav
```

已开 CORS（桌宠是 `file://` 页面，Origin 为 `null`）。

## 一键启停

```powershell
powershell -ExecutionPolicy Bypass -File cosy-start.ps1   # 已在跑则跳过
powershell -ExecutionPolicy Bypass -File cosy-stop.ps1    # 释放 2.5GB 显存
```
