"""
Edge 神经语音本地转发服务（给桌宠用）

为什么用它：CosyVoice2 走的是"克隆参考音"，如果参考音本身是合成音（比如系统 TTS），
克隆结果会带上机械感；而且本地模型要占 2.5GB 显存 + 6GB 内存。
Edge 是在线神经语音，原生合成、不克隆，音色自然，**本地只跑这个转发进程（约 60MB，显存 0）**。

代价：需要联网。断网时桌宠会自动降级到瑶瑶/电子音，不会哑。

启动：
    D:\ai\edge\venv\Scripts\python.exe -m uvicorn server:app --host 127.0.0.1 --port 9881

接口：
    GET  /health -> {"ok":true,"voice":"...","pitch":"+25Hz","rate":"+3%"}
    POST /tts {"text": "..."} -> audio/wav（16kHz 单声道）
"""
import io
import os
import subprocess

import edge_tts
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import Response
from pydantic import BaseModel

VOICE = os.environ.get("EDGE_VOICE", "zh-CN-XiaoyiNeural")
PITCH = os.environ.get("EDGE_PITCH", "+25Hz")
RATE = os.environ.get("EDGE_RATE", "+3%")
VOLUME = os.environ.get("EDGE_VOLUME", "+0%")
FFMPEG = os.environ.get("FFMPEG_PATH", r"D:\ai\ffmpeg\ffmpeg.exe")

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


class TtsRequest(BaseModel):
    text: str


@app.get("/health")
def health():
    return {"ok": True, "voice": VOICE, "pitch": PITCH, "rate": RATE}


@app.post("/tts")
async def tts(req: TtsRequest):
    text = (req.text or "").strip()
    if not text:
        raise HTTPException(status_code=400, detail="text is empty")
    if len(text) > 500:
        text = text[:500]

    # 1) 找 Edge 要 mp3
    buf = io.BytesIO()
    try:
        comm = edge_tts.Communicate(text, VOICE, pitch=PITCH, rate=RATE, volume=VOLUME)
        async for chunk in comm.stream():
            if chunk.get("type") == "audio":
                buf.write(chunk["data"])
    except Exception as e:
        raise HTTPException(status_code=502, detail="edge tts failed: %r" % (e,))

    data = buf.getvalue()
    if not data:
        raise HTTPException(status_code=502, detail="edge tts returned no audio")

    # 2) mp3 -> wav 16k mono（桌宠用 WebAudio decodeAudioData 播）
    try:
        p = subprocess.run(
            [FFMPEG, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
             "-ar", "16000", "-ac", "1", "-f", "wav", "pipe:1"],
            input=data,
            capture_output=True,
            timeout=20,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail="ffmpeg failed: %r" % (e,))
    if p.returncode != 0 or not p.stdout:
        raise HTTPException(status_code=500, detail="ffmpeg decode failed: " + p.stderr.decode("utf-8", "ignore")[:200])

    return Response(content=p.stdout, media_type="audio/wav")
