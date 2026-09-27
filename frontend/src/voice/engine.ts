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

export interface VoiceEngine {
  id: EngineId;
  label: string;
  supportsStt(): boolean;
  supportsTts(): boolean;
  startListening(lang: string, continuous: boolean, h: ListenHandlers): void;
  stopListening(): void;
  speak(text: string, lang: string, onEnd?: () => void): void;
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

  speak(text: string, lang: string, onEnd?: () => void) {
    if (!this.supportsTts() || !text.trim()) { onEnd?.(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = lang || "en-US";
    u.onend = () => onEnd?.();
    u.onerror = () => onEnd?.();
    window.speechSynthesis.speak(u);
  }
  cancelSpeak() { if (this.supportsTts()) window.speechSynthesis.cancel(); }
  isSpeaking() { return this.supportsTts() && window.speechSynthesis.speaking; }
}

const ENGINES: Partial<Record<EngineId, VoiceEngine>> = {
  "web-speech": new WebSpeechEngine(),
  // "self-hosted": new SelfHostedEngine(),   // whisper + Piper via /api/voice/* — later
  // "native-ws":  new NativeWsEngine(),      // Hermes /v1/audio/converse — when it ships
};

export function getVoiceEngine(id: EngineId): VoiceEngine {
  return ENGINES[id] ?? ENGINES["web-speech"]!;
}

// For the Settings picker: which engines exist and whether they're usable here yet.
export function voiceEngineOptions(): { id: EngineId; label: string; available: boolean; note?: string }[] {
  const web = ENGINES["web-speech"]!;
  return [
    { id: "web-speech", label: "Browser (Web Speech)", available: web.supportsStt() || web.supportsTts(),
      note: web.supportsStt() ? undefined : "no speech recognition in this browser (try Chrome/Edge)" },
    { id: "self-hosted", label: "Self-hosted (whisper + Piper)", available: false, note: "coming soon" },
    { id: "native-ws", label: "Hermes realtime (/v1/audio/converse)", available: false, note: "when your Hermes ships it" },
  ];
}
