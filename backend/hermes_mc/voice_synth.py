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


# whisper models worth offering — small/medium are lighter but weak on dialect; large-v3-turbo is
# the sweet spot for Egyptian Arabic on CPU; large-v3 is most accurate but slow without a GPU.
WHISPER_MODELS = [
    {"id": "large-v3-turbo", "label": "large-v3-turbo — recommended (fast, strong Arabic)"},
    {"id": "large-v3",       "label": "large-v3 — most accurate (slow on CPU)"},
    {"id": "medium",         "label": "medium — lighter"},
    {"id": "small",          "label": "small — fastest (weak on Arabic)"},
]
DEFAULT_MODEL = os.environ.get("HMC_WHISPER_MODEL", "large-v3-turbo")


def status() -> dict:
    tts = tts_available()
    return {"tts": tts, "stt": stt_available(), "voices": VOICES if tts else [],
            "whisperModels": WHISPER_MODELS, "whisperDefault": DEFAULT_MODEL}


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


_MODELS: dict = {}  # name → cached WhisperModel


def _load(name: str):
    """Load (and cache) a faster-whisper model — GPU if available, else CPU int8."""
    if name in _MODELS:
        return _MODELS[name]
    from faster_whisper import WhisperModel
    dev = os.environ.get("HMC_WHISPER_DEVICE", "")
    if dev:
        m = WhisperModel(name, device=dev, compute_type=os.environ.get("HMC_WHISPER_COMPUTE", "default"))
    else:
        try:
            m = WhisperModel(name, device="cuda", compute_type="float16")
        except Exception:
            m = WhisperModel(name, device="cpu", compute_type="int8")
    _MODELS[name] = m
    return m


def transcribe(audio: bytes, suffix: str = ".webm", model: str = "", lang: str = "") -> dict:
    """audio bytes → {"text", "lang", "model"} via whisper.

    ``lang`` = "en"/"ar" forces that language (no detection — the reliable path); "" / "auto"
    auto-detects but **constrained to English vs Arabic** so a short English clip can't be mistaken
    for Persian/Urdu/etc. and rendered in the wrong script.
    """
    name = (model or DEFAULT_MODEL).strip() or DEFAULT_MODEL
    forced = lang if lang in ("en", "ar") else None
    tmp = tempfile.NamedTemporaryFile(suffix=suffix, delete=False)
    tmp.write(audio)
    tmp.close()
    try:
        try:
            m = _load(name)

            def run(force):
                segs, info = m.transcribe(tmp.name, language=force, vad_filter=True)
                return "".join(s.text for s in segs).strip(), info

            text, info = run(forced)
            if forced is None:
                probs = dict(getattr(info, "all_language_probs", None) or [])
                if probs:
                    chosen = "en" if probs.get("en", 0.0) >= probs.get("ar", 0.0) else "ar"
                    if chosen != (getattr(info, "language", "") or ""):
                        text, info = run(chosen)   # redo, constrained to EN/AR
            return {"text": text, "lang": getattr(info, "language", "") or "", "model": name}
        except ImportError:
            import whisper
            wm = whisper.load_model(name if name in ("tiny", "base", "small", "medium", "large") else "base")
            r = wm.transcribe(tmp.name, language=forced)
            return {"text": (r.get("text") or "").strip(), "lang": r.get("language") or "", "model": name}
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass
