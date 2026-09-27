"""Self-hosted voice: whisper STT (auto language detection) + Edge TTS (neural voices).

Both are optional and lazy-imported, so a host without them just reports unavailable and the portal
stays on the browser Web Speech engine. STT uses faster-whisper (light, CPU, no PyTorch) if present,
else openai-whisper. TTS uses Microsoft Edge neural voices via ``edge-tts`` (free, no key) — which is
what gives natural English (en-US) and Egyptian-Arabic (ar-EG) voices.

Install on the host:  pip install --user faster-whisper edge-tts
"""
from __future__ import annotations

import asyncio
import os
import tempfile
from pathlib import Path


def tts_available() -> bool:
    try:
        import edge_tts  # noqa: F401
        return True
    except Exception:
        return False


def stt_available() -> bool:
    try:
        import faster_whisper  # noqa: F401
        return True
    except Exception:
        try:
            import whisper  # noqa: F401
            return True
        except Exception:
            return False


# Curated Edge neural voices — English (US) + Arabic (Egypt). The engine auto-picks by the text's
# script, so a bilingual reply is spoken in the right voice.
VOICES = [
    {"id": "en-US-AriaNeural",   "label": "Aria — English (US), female",       "lang": "en-US"},
    {"id": "en-US-GuyNeural",    "label": "Guy — English (US), male",          "lang": "en-US"},
    {"id": "en-US-JennyNeural",  "label": "Jenny — English (US), female",      "lang": "en-US"},
    {"id": "en-US-ChristopherNeural", "label": "Christopher — English (US), male", "lang": "en-US"},
    {"id": "ar-EG-SalmaNeural",  "label": "Salma — Arabic (Egypt), female",    "lang": "ar-EG"},
    {"id": "ar-EG-ShakirNeural", "label": "Shakir — Arabic (Egypt), male",     "lang": "ar-EG"},
]


def status() -> dict:
    tts = tts_available()
    return {"tts": tts, "stt": stt_available(), "voices": VOICES if tts else []}


def synthesize(text: str, voice: str, rate: str = "+0%") -> bytes:
    """text → mp3 bytes via Edge TTS. Raises if edge-tts isn't installed."""
    import edge_tts
    text = (text or "").strip()
    if not text:
        return b""
    voice = voice or "en-US-AriaNeural"

    async def run() -> bytes:
        tmp = tempfile.NamedTemporaryFile(suffix=".mp3", delete=False)
        tmp.close()
        try:
            await edge_tts.Communicate(text, voice, rate=rate).save(tmp.name)
            return Path(tmp.name).read_bytes()
        finally:
            try:
                os.unlink(tmp.name)
            except OSError:
                pass

    return asyncio.run(run())


_MODEL = None  # cached whisper model


def transcribe(audio: bytes, suffix: str = ".webm") -> dict:
    """audio bytes → {"text", "lang"} via whisper (language auto-detected)."""
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(audio)
    tmp.close()
    try:
        try:
            from faster_whisper import WhisperModel
            global _MODEL
            if _MODEL is None:
                size = os.environ.get("HMC_WHISPER_MODEL", "base")
                _MODEL = WhisperModel(size, device="cpu", compute_type="int8")
            segments, info = _MODEL.transcribe(tmp.name, language=None, vad_filter=True)
            text = "".join(seg.text for seg in segments).strip()
            return {"text": text, "lang": getattr(info, "language", "") or ""}
        except ImportError:
            import whisper
            model = whisper.load_model(os.environ.get("HMC_WHISPER_MODEL", "base"))
            r = model.transcribe(tmp.name)
            return {"text": (r.get("text") or "").strip(), "lang": r.get("language") or ""}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
