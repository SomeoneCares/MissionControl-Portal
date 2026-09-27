// Swappable speech engines for Voice Mode.
//
// The whole Voice Mode UI + chat wiring talks to this interface only, so the engine is a drop-in:
// "web-speech" works today (browser STT + TTS); "self-hosted" (whisper + Piper via the backend)
// and "native-ws" (Hermes' /v1/audio/converse realtime WebSocket, once it ships) slot in behind the
// same contract later — add a class, list it in ENGINES, flip the Settings toggle.

export type EngineId = "web-speech" | "self-hosted" | "native-ws";

export interface ListenHandlers {
  onPartial: (text: string) => void;   // interim transcript (may fire many times)
  onFinal: (text: string) => void;     // a completed utterance
  onError: (msg: string) => void;
  onEnd: () => void;                    // recognition stopped (silence, error, or stopListening)
}

export interface SpeakOptions {
  lang: string;
  voiceURI?: string;    // voice for non-Arabic (English) text
  arVoiceURI?: string;  // voice for Arabic text (self-hosted auto-routes by script)
  rate?: number;        // 1 = normal
  pitch?: number;
}
export interface VoiceInfo { id: string; label: string; lang: string; local: boolean; }

export interface VoiceEngine {
  id: EngineId;
  label: string;
  supportsStt(): boolean;
  supportsTts(): boolean;
  voices(): VoiceInfo[];                 // available TTS voices for the picker (may be empty)
  startListening(lang: string, continuous: boolean, h: ListenHandlers): void;
  stopListening(): void;
  speak(text: string, opts: SpeakOptions, onEnd?: () => void): void;
  cancelSpeak(): void;
  isSpeaking(): boolean;
}

// --- Browser Web Speech (SpeechRecognition + speechSynthesis) ------------------------------------
// SpeechRecognition isn't in the standard DOM lib types, so this file is deliberately loose there.
class WebSpeechEngine implements VoiceEngine {
  id: EngineId = "web-speech";
  label = "Browser (Web Speech)";
  private rec: any = null;

  private recCtor(): any {
    const w = window as any;
    return w.SpeechRecognition || w.webkitSpeechRecognition || null;
  }
  supportsStt() { return !!this.recCtor(); }
  supportsTts() { return typeof window !== "undefined" && "speechSynthesis" in window; }

  startListening(lang: string, continuous: boolean, h: ListenHandlers) {
    const Ctor = this.recCtor();
    if (!Ctor) { h.onError("This browser has no speech recognition — try Chrome or Edge."); h.onEnd(); return; }
    this.stopListening();
    const rec = new Ctor();
    this.rec = rec;
    rec.lang = lang || "en-US";
    rec.continuous = continuous;
    rec.interimResults = true;
    rec.onresult = (e: any) => {
      let interim = "", final = "";
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) final += r[0].transcript;
        else interim += r[0].transcript;
      }
      if (interim) h.onPartial(interim);
      if (final.trim()) h.onFinal(final.trim());
    };
    rec.onerror = (e: any) => {
      const err = String(e?.error || "speech error");
      if (err !== "no-speech" && err !== "aborted") h.onError(err);
    };
    rec.onend = () => { if (this.rec === rec) this.rec = null; h.onEnd(); };
    try { rec.start(); } catch (e) { h.onError(String(e)); h.onEnd(); }
  }

  stopListening() {
    const rec = this.rec;
    this.rec = null;
    if (rec) { try { rec.onend = null; rec.stop(); } catch { /* already stopped */ } }
  }

  voices(): VoiceInfo[] {
    if (!this.supportsTts()) return [];
    return window.speechSynthesis.getVoices().map((v) => ({
      id: v.voiceURI, label: `${v.name} (${v.lang})${v.localService ? "" : " · online"}`,
      lang: v.lang, local: v.localService,
    }));
  }
  speak(text: string, opts: SpeakOptions, onEnd?: () => void) {
    if (!this.supportsTts() || !text.trim()) { onEnd?.(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang || "en-US";
    if (opts.rate) u.rate = opts.rate;
    if (opts.pitch) u.pitch = opts.pitch;
    if (opts.voiceURI) {
      const v = window.speechSynthesis.getVoices().find((x) => x.voiceURI === opts.voiceURI);
      if (v) u.voice = v;
    }
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    window.speechSynthesis.speak(u);
  }
  cancelSpeak() { if (this.supportsTts()) window.speechSynthesis.cancel(); }
  isSpeaking() { return this.supportsTts() && window.speechSynthesis.speaking; }
}

// --- Self-hosted (whisper STT + Edge TTS via the portal backend) ---------------------------------
// STT is record-then-transcribe: capture mic with MediaRecorder, a simple RMS VAD ends the utterance
// on ~1s of silence, POST the audio to /api/voice/transcribe (whisper auto-detects the language).
// TTS POSTs text to /api/voice/speak and plays the mp3; the voice is auto-picked by script (Arabic
// → the ar-EG voice, else the English voice) so bilingual replies sound right.
let shStatus: { tts: boolean; stt: boolean; voices: VoiceInfo[] } = { tts: false, stt: false, voices: [] };
export async function refreshVoiceStatus(): Promise<void> {
  try {
    const r = await fetch("/api/voice/status", { credentials: "same-origin" });
    if (r.ok) { const d = await r.json(); shStatus = { tts: !!d.tts, stt: !!d.stt, voices: (d.voices || []) as VoiceInfo[] }; }
  } catch { /* leave unavailable */ }
}
const hasArabic = (s: string) => /[؀-ۿ]/.test(s);
function pickMime(): string {
  const cands = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
  for (const m of cands) if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported(m)) return m;
  return "";
}

class SelfHostedEngine implements VoiceEngine {
  id: EngineId = "self-hosted";
  label = "Self-hosted (whisper + Edge TTS)";
  private stream: MediaStream | null = null;
  private recorder: MediaRecorder | null = null;
  private audio: HTMLAudioElement | null = null;
  private vadCtx: AudioContext | null = null;
  private vadRaf = 0;
  private continuous = false;
  private stopped = false;
  private h: ListenHandlers | null = null;

  supportsStt() { return shStatus.stt; }
  supportsTts() { return shStatus.tts; }
  voices() { return shStatus.voices; }

  async startListening(_lang: string, continuous: boolean, h: ListenHandlers) {
    this.continuous = continuous; this.h = h; this.stopped = false;
    if (!shStatus.stt) { h.onError("whisper isn't installed on the host — see Settings → Voice."); h.onEnd(); return; }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
    } catch { h.onError("microphone permission denied"); h.onEnd(); return; }
    this.recordUtterance();
  }

  private recordUtterance() {
    if (!this.stream || this.stopped) { this.h?.onEnd(); return; }
    const chunks: Blob[] = [];
    const mime = pickMime();
    const rec = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
    this.recorder = rec;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      this.stopVad();
      const blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
      if (blob.size > 1400 && !this.stopped) {
        try {
          const r = await fetch("/api/voice/transcribe", {
            method: "POST", credentials: "same-origin",
            headers: { "Content-Type": blob.type }, body: blob });
          if (r.ok) { const d = await r.json(); const text = (d.text || "").trim(); if (text) this.h?.onFinal(text); }
          else this.h?.onError("transcription failed");
        } catch { this.h?.onError("transcription failed"); }
      }
      if (this.continuous && !this.stopped) this.recordUtterance();
      else this.h?.onEnd();
    };
    rec.start();
    this.startVad(() => { try { if (rec.state === "recording") rec.stop(); } catch { /* already stopped */ } });
  }

  // RMS VAD: end the utterance after ~1.1s of silence following speech (hard cap 15s)
  private startVad(onSilence: () => void) {
    try {
      const Ctx: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
      const ctx = new Ctx();
      this.vadCtx = ctx;
      const src = ctx.createMediaStreamSource(this.stream!);
      const an = ctx.createAnalyser(); an.fftSize = 2048; src.connect(an);
      const bufSize = an.fftSize;
      const buf = new Uint8Array(bufSize);
      let spoke = false, silentSince = 0; const start = performance.now();
      const loop = () => {
        an.getByteTimeDomainData(buf);
        let sum = 0; for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        const rms = Math.sqrt(sum / buf.length);
        const now = performance.now();
        if (rms > 0.025) { spoke = true; silentSince = 0; }
        else if (spoke) { if (!silentSince) silentSince = now; else if (now - silentSince > 1100) { onSilence(); return; } }
        if (now - start > 15000) { onSilence(); return; }
        this.vadRaf = requestAnimationFrame(loop);
      };
      this.vadRaf = requestAnimationFrame(loop);
    } catch { /* no VAD → utterance ends only on stopListening */ }
  }
  private stopVad() {
    if (this.vadRaf) { cancelAnimationFrame(this.vadRaf); this.vadRaf = 0; }
    if (this.vadCtx) { try { this.vadCtx.close(); } catch { /* ignore */ } this.vadCtx = null; }
  }

  stopListening() {
    this.stopped = true; this.continuous = false;
    this.stopVad();
    try { if (this.recorder && this.recorder.state === "recording") this.recorder.stop(); } catch { /* ignore */ }
    this.recorder = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
  }

  speak(text: string, opts: SpeakOptions, onEnd?: () => void) {
    if (!shStatus.tts || !text.trim()) { onEnd?.(); return; }
    const voice = hasArabic(text) ? (opts.arVoiceURI || "ar-EG-SalmaNeural") : (opts.voiceURI || "en-US-AriaNeural");
    const pct = Math.round(((opts.rate ?? 1) - 1) * 100);
    const rate = (pct >= 0 ? "+" : "") + pct + "%";
    fetch("/api/voice/speak", {
      method: "POST", credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, voice, rate }),
    })
      .then((r) => (r.ok ? r.blob() : Promise.reject(new Error("tts failed"))))
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const a = new Audio(url); this.audio = a;
        a.onended = () => { URL.revokeObjectURL(url); if (this.audio === a) this.audio = null; onEnd?.(); };
        a.onerror = () => { URL.revokeObjectURL(url); if (this.audio === a) this.audio = null; onEnd?.(); };
        a.play().catch(() => onEnd?.());
      })
      .catch(() => onEnd?.());
  }
  cancelSpeak() { if (this.audio) { try { this.audio.pause(); } catch { /* ignore */ } this.audio = null; } }
  isSpeaking() { return !!this.audio && !this.audio.paused; }
}

const ENGINES: Partial<Record<EngineId, VoiceEngine>> = {
  "web-speech": new WebSpeechEngine(),
  "self-hosted": new SelfHostedEngine(),
  // "native-ws": new NativeWsEngine(),   // Hermes /v1/audio/converse — when it ships
};

export function getVoiceEngine(id: EngineId): VoiceEngine {
  return ENGINES[id] ?? ENGINES["web-speech"]!;
}

// For the Settings picker: which engines exist and whether they're usable here yet.
export function voiceEngineOptions(): { id: EngineId; label: string; available: boolean; note?: string }[] {
  const web = ENGINES["web-speech"]!;
  const sh = ENGINES["self-hosted"]!;
  const shNote = sh.supportsStt() && sh.supportsTts() ? undefined
    : sh.supportsTts() ? "installed for the voice; add faster-whisper for the mic"
    : sh.supportsStt() ? "installed for the mic; add edge-tts for the voice"
    : "install faster-whisper + edge-tts on the host";
  return [
    { id: "web-speech", label: "Browser (Web Speech)", available: web.supportsStt() || web.supportsTts(),
      note: web.supportsStt() ? undefined : "no speech recognition in this browser (try Chrome/Edge)" },
    { id: "self-hosted", label: "Self-hosted (whisper + Edge TTS)", available: sh.supportsStt() || sh.supportsTts(), note: shNote },
    { id: "native-ws", label: "Hermes realtime (/v1/audio/converse)", available: false, note: "when your Hermes ships it" },
  ];
}
