"""
CosyVoice2 本地 TTS 服务（给桌宠用）

为什么做成 HTTP 服务：桌宠渲染层不能直接跑 Python，但可以 fetch 本机端口。
模型常驻显存，避免每句话都重新加载（加载一次约 10 秒）。

启动：
    D:\ai\cosy\venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 9880

接口：
    GET  /health           -> {"ok": true, "model": "...", "vram_mb": 1234}
    POST /tts  {"text": "..."}  -> audio/wav
    POST /tts  {"text": "...", "instruct": "用甜美的少女语气说"}  -> audio/wav
"""
import io
import os
import sys
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "Matcha-TTS"))
sys.path.insert(0, os.path.join(HERE, "CosyVoice"))

import torch
import torchaudio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

MODEL_DIR = os.path.join(HERE, "models", "CosyVoice2-0.5B")
PROMPT_WAV = os.path.join(HERE, "prompt_yaoyao.wav")
# 参考音的文本必须和音频内容一致，零样本才能对上
PROMPT_TEXT = "你好呀，我是你的桌面宠物，今天也要开开心心的哦。"

app = FastAPI()

# 桌宠窗口是 file:// 页面（Origin 为 null），要跨源 fetch 本机服务就必须放行
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

_lock = threading.Lock()
_model = None
_load_lock = threading.Lock()


def get_model():
    """懒加载 + 只加载一次。fp16 省显存、略快。"""
    global _model
    if _model is not None:
        return _model
    with _load_lock:
        if _model is None:
            t0 = time.time()
            from cosyvoice.cli.cosyvoice import CosyVoice2

            _model = CosyVoice2(MODEL_DIR, load_jit=False, load_trt=False, fp16=True)
            print("[cosy] model loaded in %.1fs" % (time.time() - t0), flush=True)
    return _model


class TtsRequest(BaseModel):
    text: str
    instruct: str | None = None
    speed: float = 1.0


@app.on_event("startup")
def warmup():
    def _warm():
        try:
            t0 = time.time()
            m = get_model()
            with _lock:
                for _ in m.inference_zero_shot("你好。", PROMPT_TEXT, PROMPT_WAV, stream=False):
                    break
            print("[cosy] warmup done in %.1fs" % (time.time() - t0), flush=True)
        except Exception as e:
            print("[cosy] warmup failed: %r" % (e,), flush=True)

    threading.Thread(target=_warm, daemon=True).start()


@app.get("/health")
def health():
    vram = torch.cuda.memory_allocated() / 1048576 if torch.cuda.is_available() else 0
    return {
        "ok": True,
        "model": os.path.basename(MODEL_DIR),
        "loaded": _model is not None,
        "vram_mb": round(vram),
        "device": torch.cuda.get_device_name(0) if torch.cuda.is_available() else "cpu",
    }


@app.post("/tts")
def tts(req: TtsRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > 300:
        text = text[:300]

    t0 = time.time()
    m = get_model()
    try:
        with _lock:
            if req.instruct:
                gen = m.inference_instruct2(text, req.instruct, PROMPT_WAV, stream=False)
            else:
                gen = m.inference_zero_shot(text, PROMPT_TEXT, PROMPT_WAV, stream=False)
            wav = torch.cat([item["tts_speech"] for item in gen], dim=1)
    except Exception as e:
        raise HTTPException(status_code=500, detail="synthesis failed: %r" % (e,))

    buf = io.BytesIO()
    torchaudio.save(buf, wav, m.sample_rate, format="wav")
    audio = buf.getvalue()
    dur = wav.shape[1] / m.sample_rate
    print("[cosy] %.2fs audio in %.2fs (RTF %.2f) %r" % (dur, time.time() - t0, (time.time() - t0) / max(dur, 0.01), text[:20]), flush=True)
    return Response(content=audio, media_type="audio/wav")
