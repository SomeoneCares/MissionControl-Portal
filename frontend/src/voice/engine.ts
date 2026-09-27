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
  speak(text: string, opts: SpeakOptions, onEnd?: () => void): void;   // one-shot (Test / previews)
  // streaming TTS: enqueue sentences as they arrive; finishSpeak marks the end and fires onDrained
  // once the queue empties — so speaking can start after the first sentence, not the whole reply.
  enqueueSpeak(text: string, opts: SpeakOptions): void;
  finishSpeak(onDrained: () => void): void;
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
  enqueueSpeak(text: string, opts: SpeakOptions) {
    if (!this.supportsTts() || !text.trim()) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = opts.lang || "en-US";
    if (opts.rate) u.rate = opts.rate;
    if (opts.pitch) u.pitch = opts.pitch;
    if (opts.voiceURI) {
      const v = window.speechSynthesis.getVoices().find((x) => x.voiceURI === opts.voiceURI);
      if (v) u.voice = v;
    }
    window.speechSynthesis.speak(u);   // native queue: sentences play in order
  }
  finishSpeak(onDrained: () => void) {
    if (!this.supportsTts()) { onDrained(); return; }
    const ss = window.speechSynthesis;
    let tries = 0;
    const check = () => {
      if ((!ss.speaking && !ss.pending) || tries > 800) onDrained();
      else { tries++; setTimeout(check, 150); }
    };
    check();
  }
  cancelSpeak() { if (this.supportsTts()) window.speechSynthesis.cancel(); }
  isSpeaking() { return this.supportsTts() && (window.speechSynthesis.speaking || window.speechSynthesis.pending); }
}

// --- Self-hosted (whisper STT + Edge TTS via the portal backend) ---------------------------------
// STT is record-then-transcribe: capture mic with MediaRecorder, a simple RMS VAD ends the utterance
// on ~1s of silence, POST the audio to /api/voice/transcribe (whisper auto-detects the language).
// TTS POSTs text to /api/voice/speak and plays the mp3; the voice is auto-picked by script (Arabic
// → the ar-EG voice, else the English voice) so bilingual replies sound right.
export interface WhisperModelInfo { id: string; label: string; }
let shStatus: { tts: boolean; stt: boolean; voices: VoiceInfo[]; whisperModels: WhisperModelInfo[]; whisperDefault: string } =
  { tts: false, stt: false, voices: [], whisperModels: [], whisperDefault: "" };
let sttModel = "";   // chosen whisper model (empty → the backend default)
export function setSttModel(m: string) { sttModel = m || ""; }
export function whisperModels(): WhisperModelInfo[] { return shStatus.whisperModels; }
export async function refreshVoiceStatus(): Promise<void> {
  try {
    const r = await fetch("/api/voice/status", { credentials: "same-origin" });
    if (r.ok) {
      const d = await r.json();
      shStatus = { tts: !!d.tts, stt: !!d.stt, voices: (d.voices || []) as VoiceInfo[],
        whisperModels: (d.whisperModels || []) as WhisperModelInfo[], whisperDefault: d.whisperDefault || "" };
    }
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
  // streaming TTS queue
  private queue: { text: string; opts: SpeakOptions }[] = [];
  private nextAudio: Promise<HTMLAudioElement | null> | null = null;
  private playing = false;
  private finishing = false;
  private onDrained: (() => void) | null = null;
  private gen = 0;

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
          const url = "/api/voice/transcribe" + (sttModel ? "?model=" + encodeURIComponent(sttModel) : "");
          const r = await fetch(url, {
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
  private async synth(item: { text: string; opts: SpeakOptions }): Promise<HTMLAudioElement | null> {
    try {
      const voice = hasArabic(item.text) ? (item.opts.arVoiceURI || "ar-EG-SalmaNeural") : (item.opts.voiceURI || "en-US-AriaNeural");
      const pct = Math.round(((item.opts.rate ?? 1) - 1) * 100);
      const rate = (pct >= 0 ? "+" : "") + pct + "%";
      const r = await fetch("/api/voice/speak", {
        method: "POST", credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: item.text, voice, rate }) });
      if (!r.ok) return null;
      const blob = await r.blob();
      return new Audio(URL.createObjectURL(blob));
    } catch { return null; }
  }
  enqueueSpeak(text: string, opts: SpeakOptions) {
    if (!shStatus.tts || !text.trim()) return;
    this.queue.push({ text, opts });
    this.pump();
  }
  private async pump() {
    if (this.playing) return;
    this.playing = true;
    const myGen = this.gen;
    while (this.gen === myGen) {
      let audioP = this.nextAudio; this.nextAudio = null;
      if (!audioP) { const item = this.queue.shift(); if (!item) break; audioP = this.synth(item); }
      const following = this.queue.shift();               // prefetch next while this plays
      if (following) this.nextAudio = this.synth(following);
      const a = await audioP;
      if (this.gen !== myGen) { if (a) { try { URL.revokeObjectURL(a.src); } catch { /* */ } } break; }
      if (a) {
        this.audio = a;
        await new Promise<void>((res) => { a.onended = () => res(); a.onerror = () => res(); a.play().catch(() => res()); });
        try { URL.revokeObjectURL(a.src); } catch { /* */ }
        this.audio = null;
      }
    }
    if (this.gen === myGen) {
      this.playing = false;
      if (this.finishing && !this.queue.length && !this.nextAudio) this.drainSpeak();
    }
  }
  finishSpeak(onDrained: () => void) {
    this.finishing = true; this.onDrained = onDrained;
    if (!this.playing && !this.queue.length && !this.nextAudio) this.drainSpeak();
  }
  private drainSpeak() { this.finishing = false; const cb = this.onDrained; this.onDrained = null; cb?.(); }

  cancelSpeak() {
    this.gen++; this.queue = []; this.nextAudio = null; this.finishing = false; this.onDrained = null; this.playing = false;
    if (this.audio) { try { this.audio.pause(); URL.revokeObjectURL(this.audio.src); } catch { /* ignore */ } this.audio = null; }
  }
  isSpeaking() { return this.playing || (!!this.audio && !this.audio.paused); }
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
