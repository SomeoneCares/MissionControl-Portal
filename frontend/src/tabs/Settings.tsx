import { useEffect, useRef, useState } from "react";
import type { HealthInfo } from "../types";
import { api, setConnection, getConnection, type ConnectionInfo, type ContentDirInfo, type FleetGroup } from "../api/client";
import { settings, applySettings, ACCENT_PRESETS } from "../store/settings";
import { voiceEngineOptions, getVoiceEngine, refreshVoiceStatus, type EngineId, type VoiceInfo } from "../voice/engine";

// Settings — branding (name, accent, theme), connected Hermes hosts, and connection info.
// Name + accent are portal-owned and shared across devices (server-persisted); theme is per-viewer
// (localStorage). Connections are portal-owned and shared.

export function Settings({ health }: { health: HealthInfo | null }) {
  const [s, setS] = useState(settings.get());
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => settings.subscribe(() => setS(settings.get())), []);
  const reloadConnections = () => api.connections().then((d) => setConnections(d.connections)).catch(() => setConnections([]));
  useEffect(() => { reloadConnections(); }, []);

  // Name + accent are shared (portal-owned): mirror local edits to the server so every device
  // picks them up. Theme is per-device and never pushed. Debounced for typing / colour-dragging.
  const brandTimer = useRef<number | null>(null);
  const pushBranding = () => {
    const cur = settings.get();
    api.setBranding({ name: cur.portalName, accent: cur.accent }).catch(() => {});
  };
  const pushBrandingDebounced = () => {
    if (brandTimer.current) window.clearTimeout(brandTimer.current);
    brandTimer.current = window.setTimeout(pushBranding, 500);
  };

  return (
    <div className="settings">
      <section className="settings-head card">
        <div>
          <span className="eyebrow">Portal</span>
          <h1 className="display settings-title">Settings.</h1>
        </div>
      </section>

      {/* branding */}
      <section className="card settings-block">
        <span className="eyebrow block-title">Branding</span>
        <div className="set-field">
          <label>Portal name</label>
          <input className="add-input" placeholder="Hermes" value={s.portalName}
                 onChange={(e) => { settings.set({ portalName: e.target.value }); pushBrandingDebounced(); }} />
        </div>
        <div className="set-field">
          <label>Accent colour</label>
          <div className="accent-row">
            {ACCENT_PRESETS.map((p) => (
              <button key={p.name}
                      className={`accent-chip ${s.accent === p.value ? "active" : ""}`}
                      onClick={() => { settings.set({ accent: p.value }); pushBranding(); }}
                      title={p.name}>
                <span className="accent-swatch" style={{ background: p.value || "var(--ember)" }} />
                {p.name}
              </button>
            ))}
            <label className="accent-custom">
              custom
              <input type="color" value={/^#/.test(s.accent) ? s.accent : "#1db4d8"}
                     onChange={(e) => { settings.set({ accent: e.target.value }); pushBrandingDebounced(); }} />
            </label>
          </div>
        </div>
        <div className="set-field">
          <label>Theme</label>
          <div className="seg">
            {(["system", "light", "dark"] as const).map((t) => (
              <button key={t} className={`seg-btn ${s.theme === t ? "active" : ""}`} onClick={() => settings.set({ theme: t })}>{t}</button>
            ))}
          </div>
        </div>
      </section>

      {/* access / credentials */}
      <CredentialsBlock />

      {/* connections (Hermes hosts) */}
      <section className="card settings-block">
        <div className="block-head">
          <span className="eyebrow block-title">Connections</span>
          <button className="btn-primary" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add connection"}</button>
        </div>
        <p className="mono muted block-note">
          Connect other Hermes hosts. Give a connection a bridge (for the dashboard data) and/or a
          gateway (for chat) — a bridge-less connection is chat-only, a gateway-less one is read-only.
        </p>
        {adding && <AddConnection onDone={() => { setAdding(false); reloadConnections(); }} />}
        <ul className="conn-list">
          {connections.map((c) => (
            <li key={c.id} className={`conn-item ${c.id === getConnection() ? "current" : ""}`}>
              <span className="conn-swatch" style={{ background: c.accent || "var(--ember)" }} />
              <div className="conn-meta">
                <span className="conn-name">{c.name}{c.primary && <span className="conn-tag">primary</span>}</span>
                <span className="mono muted conn-sub">{c.mode}{c.gateway ? " · chat" : ""}</span>
              </div>
              <div className="conn-actions">
                <button className="content-tool" onClick={() => { setConnection(c.id); location.reload(); }}>View</button>
                {!c.primary && <button className="content-tool danger" onClick={async () => { await api.removeConnection(c.id); reloadConnections(); }}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* content library folder (portal default) */}
      <ContentDirBlock />

      {/* per-fleet content libraries */}
      <FleetContentBlock />

      {/* voice mode */}
      <VoiceBlock />

      {/* connection */}
      <section className="card settings-block">
        <span className="eyebrow block-title">Connection</span>
        <dl className="conn-fields">
          <div><dt>Mode</dt><dd className="mono">{health?.mode ?? "—"}</dd></div>
          <div><dt>Gateway</dt><dd className="mono">{health?.gateway ? `${health.gateway.ok ? "live" : "down"} · v${health.gateway.version || "—"} · ${health.gateway.latency_ms}ms` : "not configured"}</dd></div>
          <div><dt>Current connection</dt><dd className="mono">{getConnection()}</dd></div>
        </dl>
        <button className="content-tool" onClick={() => { settings.set({ portalName: "", accent: "", theme: "system" }); applySettings(); pushBranding(); }}>Reset branding</button>
      </section>
    </div>
  );
}

function CredentialsBlock() {
  const [status, setStatus] = useState<import("../api/client").AuthStatus | null>(null);
  const [username, setUsername] = useState("");
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const load = () => api.authStatus().then((d) => { setStatus(d); setUsername(d.username); }).catch(() => setStatus(null));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setMsg(null); setErr(null);
    if (!current) { setErr("Enter your current password."); return; }
    if (next.length < 4) { setErr("New password must be at least 4 characters."); return; }
    if (next !== confirm) { setErr("New passwords do not match."); return; }
    setBusy(true);
    try {
      await api.changePassword(username.trim(), current, next);
      setMsg("Credentials updated. Other sessions were signed out.");
      setCurrent(""); setNext(""); setConfirm("");
      load();
    } catch (e) {
      setErr(String(e).replace(/^Error:\s*/, "").replace(/ → HTTP \d+$/, "") || "Could not update credentials.");
    }
    setBusy(false);
  };

  if (!status || !status.required) return null;

  return (
    <section className="card settings-block">
      <span className="eyebrow block-title">Access</span>
      <p className="mono muted block-note">
        The username and password used to sign in to this portal over the LAN.
      </p>
      {status.is_default && (
        <p className="mono warn-text block-note">
          You are still using the default password. Set a new one below.
        </p>
      )}
      {!status.editable ? (
        <p className="mono muted">Credentials are set by the <code>HMC_PORTAL_USER</code> / <code>HMC_PORTAL_PASSWORD</code> environment variables and can't be changed here.</p>
      ) : (
        <>
          <div className="set-field">
            <label>Username</label>
            <input className="add-input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} />
          </div>
          <div className="set-field">
            <label>Current password</label>
            <input className="add-input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
          </div>
          <div className="set-grid">
            <div className="set-field">
              <label>New password</label>
              <input className="add-input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
            </div>
            <div className="set-field">
              <label>Confirm new password</label>
              <input className="add-input" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </div>
          </div>
          {err && <p className="pane-msg mono login-error">{err}</p>}
          {msg && <p className="pane-msg mono">{msg}</p>}
          <button className="btn-primary" onClick={save} disabled={busy}>{busy ? "Saving…" : "Update credentials"}</button>
        </>
      )}
    </section>
  );
}

function ContentDirBlock() {
  const [info, setInfo] = useState<ContentDirInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => api.contentDir().then((d) => { setInfo(d); setDraft(d.path ?? ""); }).catch(() => setInfo(null));
  useEffect(() => { load(); }, []);

  const save = async () => {
    setBusy(true); setMsg(null);
    try {
      const d = await api.setContentDir(draft.trim());
      setInfo(d); setDraft(d.path ?? "");
      setMsg(`Saved — content is now stored in ${d.path}${d.docs ? ` (${d.docs} document${d.docs === 1 ? "" : "s"})` : ""}.`);
    } catch (e) {
      setMsg(String(e).replace(/^Error:\s*/, ""));
    }
    setBusy(false);
  };

  const dirty = info?.path != null && draft.trim() !== info.path;

  return (
    <section className="card settings-block">
      <span className="eyebrow block-title">Content library</span>
      <p className="mono muted block-note">
        Where the portal writes agent documents. New docs, edits, and Word exports all live here.
      </p>
      {!info && <p className="mono muted">loading…</p>}
      {info && !info.editable && (
        <p className="mono muted">{info.reason || "The content folder is managed on the Hermes host and can't be changed here."}</p>
      )}
      {info && info.editable && (
        <>
          <div className="set-field">
            <label>Folder path</label>
            <input className="add-input mono" value={draft} spellCheck={false}
                   placeholder="/home/you/.hermes-mc/content"
                   onChange={(e) => setDraft(e.target.value)}
                   disabled={info.env_locked} />
          </div>
          <div className="dir-status mono">
            <span className={`status-dot ${info.exists ? "up" : "down"}`} />
            {info.exists
              ? <>folder exists{info.writable ? "" : " · not writable"}{typeof info.docs === "number" ? ` · ${info.docs} document${info.docs === 1 ? "" : "s"}` : ""}</>
              : <>folder will be created on save</>}
          </div>
          {info.env_locked && (
            <p className="mono muted block-note">Locked by the <code>CONTENT_DIR</code> environment variable — unset it on the host to change the folder here.</p>
          )}
          {msg && <p className="pane-msg mono">{msg}</p>}
          <div className="dir-actions">
            <button className="btn-primary" onClick={save} disabled={busy || info.env_locked || (!dirty && info.exists)}>
              {busy ? "Saving…" : dirty ? "Save folder" : "Saved"}
            </button>
            {info.default && draft.trim() !== info.default && !info.env_locked && (
              <button className="content-tool" onClick={() => setDraft(info.default!)}>Use default</button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

function VoiceBlock() {
  const [s, setS] = useState(settings.get());
  useEffect(() => settings.subscribe(() => setS(settings.get())), []);
  const opts = voiceEngineOptions();
  const engine = getVoiceEngine(s.voiceEngine);
  const selfHosted = s.voiceEngine === "self-hosted";
  const [voices, setVoices] = useState<VoiceInfo[]>(engine.voices());
  useEffect(() => {
    let alive = true;
    const refresh = () => { if (alive) setVoices(getVoiceEngine(settings.get().voiceEngine).voices()); };
    refreshVoiceStatus().then(() => { refresh(); if (alive) setS(settings.get()); });  // backend edge voices
    refresh();
    if (typeof window !== "undefined" && "speechSynthesis" in window) {
      window.speechSynthesis.addEventListener("voiceschanged", refresh);
      return () => { alive = false; window.speechSynthesis.removeEventListener("voiceschanged", refresh); };
    }
    return () => { alive = false; };
  }, [s.voiceEngine]);

  const en = voices.filter((v) => v.lang.toLowerCase().startsWith("en"));
  const ar = voices.filter((v) => v.lang.toLowerCase().startsWith("ar"));
  const speak = (text: string, voiceURI?: string, arVoiceURI?: string) =>
    engine.speak(text, { lang: s.voiceLang, voiceURI, arVoiceURI, rate: s.voiceRate });

  return (
    <section className="card settings-block">
      <span className="eyebrow block-title">Voice</span>
      <p className="mono muted block-note">
        Talk to the fleet from the Chat tab (mic → speech-to-text → your agents → spoken reply), per
        device. The <b>self-hosted</b> engine (whisper + Edge TTS) auto-detects English vs Egyptian
        Arabic and answers in the same language and voice.
      </p>
      <div className="set-grid">
        <div className="set-field">
          <label>Speech engine</label>
          <select className="model-select mono" value={s.voiceEngine}
                  onChange={(e) => settings.set({ voiceEngine: e.target.value as EngineId })}>
            {opts.map((o) => (
              <option key={o.id} value={o.id} disabled={!o.available}>
                {o.label}{o.note ? ` — ${o.note}` : ""}
              </option>
            ))}
          </select>
        </div>
        <div className="set-field">
          <label>Speaking rate · {s.voiceRate.toFixed(1)}×</label>
          <input type="range" min="0.6" max="1.6" step="0.1" value={s.voiceRate}
                 onChange={(e) => settings.set({ voiceRate: parseFloat(e.target.value) })} />
        </div>
      </div>

      {selfHosted ? (
        <div className="set-grid">
          <div className="set-field">
            <label>English voice</label>
            <select className="model-select mono" value={s.voiceNameEn}
                    onChange={(e) => settings.set({ voiceNameEn: e.target.value })}>
              {en.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {en.length > 0 && <button className="content-tool" onClick={() => speak("Hello — this is the English voice.", s.voiceNameEn)}>Test English</button>}
          </div>
          <div className="set-field">
            <label>Arabic (Egyptian) voice</label>
            <select className="model-select mono" value={s.voiceNameAr}
                    onChange={(e) => settings.set({ voiceNameAr: e.target.value })}>
              {ar.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {ar.length > 0 && <button className="content-tool" onClick={() => speak("أهلاً، دي النغمة المصري اللي هترد بيها.", undefined, s.voiceNameAr)}>Test Arabic</button>}
          </div>
        </div>
      ) : (
        voices.length > 0 && (
          <div className="set-field">
            <label>Voice</label>
            <select className="model-select mono" value={s.voiceName}
                    onChange={(e) => settings.set({ voiceName: e.target.value })}>
              <option value="">Browser default</option>
              {voices.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
            {engine.supportsTts() && <button className="content-tool" onClick={() => speak("Hi — this is how I'll read the fleet's replies.", s.voiceName || undefined)}>Test voice</button>}
          </div>
        )
      )}

      <label className="voice-check">
        <input type="checkbox" checked={s.voiceAutoSpeak}
               onChange={(e) => settings.set({ voiceAutoSpeak: e.target.checked })} />
        Speak assistant replies aloud
      </label>

      {selfHosted && !engine.supportsStt() && (
        <p className="mono warn-text block-note">
          The mic (speech-to-text) needs whisper on the host — install it, then restart the portal:
          <br /><code>pip install --user --break-system-packages faster-whisper edge-tts</code>
        </p>
      )}
      {!selfHosted && (
        <p className="mono muted block-note">
          Tip: a voice marked <code>online</code> (a Google voice in Chrome) sounds better than the
          local system voice. For natural English + Egyptian Arabic, switch to the self-hosted engine.
        </p>
      )}
    </section>
  );
}

function FleetContentBlock() {
  const [fleets, setFleets] = useState<FleetGroup[]>([]);
  const reload = () => api.fleets().then((d) => setFleets(d.fleets)).catch(() => setFleets([]));
  useEffect(() => { reload(); }, []);
  if (fleets.length === 0) return null;   // nothing to configure until fleets exist

  return (
    <section className="card settings-block">
      <span className="eyebrow block-title">Fleet content libraries</span>
      <p className="mono muted block-note">
        Point each fleet at its own content folder (e.g. <code>~/pentest-fleet/content</code>). The
        Content tab aggregates every fleet's library, grouped by fleet; documents outside these
        folders stay under the portal default above. Absolute path (or <code>~</code>).
      </p>
      <ul className="fleet-list">
        {fleets.map((f) => <FleetContentRow key={f.id} fleet={f} onSaved={reload} />)}
      </ul>
    </section>
  );
}

function FleetContentRow({ fleet, onSaved }: { fleet: FleetGroup; onSaved: () => void }) {
  const [path, setPath] = useState(fleet.content_dir ?? "");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const dirty = path.trim() !== (fleet.content_dir ?? "");

  const save = async () => {
    setBusy(true); setErr(null);
    try { await api.updateFleet(fleet.id, { content_dir: path.trim() }); onSaved(); }
    catch (e) { setErr(String(e).replace(/^Error:\s*/, "").replace(/ → HTTP \d+$/, "")); }
    setBusy(false);
  };

  return (
    <li className="fleet-item fleet-content-row">
      <span className="fleet-swatch" style={{ background: fleet.accent || "var(--ember)" }} />
      <span className="fleet-content-name">{fleet.name}</span>
      <input className="add-input mono fleet-content-input" value={path} spellCheck={false}
             placeholder="~/fleet/content"
             onChange={(e) => setPath(e.target.value)}
             onKeyDown={(e) => e.key === "Enter" && dirty && save()} />
      {path.trim() !== "" && (
        <span className={`status-dot ${fleet.content_ok ? "up" : "down"}`}
              title={fleet.content_ok ? "folder exists" : "folder not found"} />
      )}
      <button className="btn-primary" onClick={save} disabled={busy || !dirty}>{busy ? "…" : "Save"}</button>
      {err && <span className="att-note mono">{err}</span>}
    </li>
  );
}

function AddConnection({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", accent: "#1db4d8", bridge_url: "", bridge_key: "", gateway_url: "", gateway_key: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!f.name.trim()) { setMsg("Name is required."); return; }
    if (!f.bridge_url && !f.gateway_url) { setMsg("Give a bridge URL, a gateway URL, or both."); return; }
    setBusy(true); setMsg(null);
    try { await api.addConnection(f); onDone(); } catch (e) { setMsg(String(e)); setBusy(false); }
  };

  return (
    <div className="add-conn">
      <div className="set-field"><label>Name</label><input className="add-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Prod Hermes" /></div>
      <div className="set-grid">
        <div className="set-field"><label>Bridge URL</label><input className="add-input mono" value={f.bridge_url} onChange={(e) => set("bridge_url", e.target.value)} placeholder="http://host:51772" /></div>
        <div className="set-field"><label>Bridge token</label><input className="add-input mono" type="password" value={f.bridge_key} onChange={(e) => set("bridge_key", e.target.value)} /></div>
        <div className="set-field"><label>Gateway URL</label><input className="add-input mono" value={f.gateway_url} onChange={(e) => set("gateway_url", e.target.value)} placeholder="http://host:8642" /></div>
        <div className="set-field"><label>Gateway token</label><input className="add-input mono" type="password" value={f.gateway_key} onChange={(e) => set("gateway_key", e.target.value)} /></div>
      </div>
      <div className="set-field"><label>Accent</label><input type="color" value={f.accent} onChange={(e) => set("accent", e.target.value)} /></div>
      {msg && <p className="pane-msg mono">{msg}</p>}
      <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add connection"}</button>
    </div>
  );
}
