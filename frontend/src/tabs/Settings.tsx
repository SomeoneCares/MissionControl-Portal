import { useEffect, useState } from "react";
import type { HealthInfo } from "../types";
import { api, setFleet, getFleet, type FleetInfo } from "../api/client";
import { settings, applySettings, ACCENT_PRESETS } from "../store/settings";

// Settings — branding (name, accent, theme), connected fleets, and connection info. Branding is
// per-viewer (localStorage). Fleets are portal-owned and shared.

export function Settings({ health }: { health: HealthInfo | null }) {
  const [s, setS] = useState(settings.get());
  const [fleets, setFleets] = useState<FleetInfo[]>([]);
  const [adding, setAdding] = useState(false);

  useEffect(() => settings.subscribe(() => setS(settings.get())), []);
  const reloadFleets = () => api.fleets().then((d) => setFleets(d.fleets)).catch(() => setFleets([]));
  useEffect(() => { reloadFleets(); }, []);

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
                 onChange={(e) => settings.set({ portalName: e.target.value })} />
        </div>
        <div className="set-field">
          <label>Accent colour</label>
          <div className="accent-row">
            {ACCENT_PRESETS.map((p) => (
              <button key={p.name}
                      className={`accent-chip ${s.accent === p.value ? "active" : ""}`}
                      onClick={() => settings.set({ accent: p.value })}
                      title={p.name}>
                <span className="accent-swatch" style={{ background: p.value || "var(--ember)" }} />
                {p.name}
              </button>
            ))}
            <label className="accent-custom">
              custom
              <input type="color" value={/^#/.test(s.accent) ? s.accent : "#1db4d8"}
                     onChange={(e) => settings.set({ accent: e.target.value })} />
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

      {/* fleets */}
      <section className="card settings-block">
        <div className="block-head">
          <span className="eyebrow block-title">Fleets</span>
          <button className="btn-primary" onClick={() => setAdding((v) => !v)}>{adding ? "Cancel" : "+ Add fleet"}</button>
        </div>
        <p className="mono muted block-note">
          Connect other Hermes hosts. Give a fleet a bridge (for the dashboard data) and/or a gateway
          (for chat) — a bridge-less fleet is chat-only, a gateway-less one is read-only.
        </p>
        {adding && <AddFleet onDone={() => { setAdding(false); reloadFleets(); }} />}
        <ul className="fleet-list">
          {fleets.map((f) => (
            <li key={f.id} className={`fleet-item ${f.id === getFleet() ? "current" : ""}`}>
              <span className="fleet-swatch" style={{ background: f.accent || "var(--ember)" }} />
              <div className="fleet-meta">
                <span className="fleet-name">{f.name}{f.primary && <span className="fleet-tag">primary</span>}</span>
                <span className="mono muted fleet-sub">{f.mode}{f.gateway ? " · chat" : ""}</span>
              </div>
              <div className="fleet-actions">
                <button className="content-tool" onClick={() => { setFleet(f.id); location.reload(); }}>View</button>
                {!f.primary && <button className="content-tool danger" onClick={async () => { await api.removeFleet(f.id); reloadFleets(); }}>Remove</button>}
              </div>
            </li>
          ))}
        </ul>
      </section>

      {/* connection */}
      <section className="card settings-block">
        <span className="eyebrow block-title">Connection</span>
        <dl className="conn-fields">
          <div><dt>Mode</dt><dd className="mono">{health?.mode ?? "—"}</dd></div>
          <div><dt>Gateway</dt><dd className="mono">{health?.gateway ? `${health.gateway.ok ? "live" : "down"} · v${health.gateway.version || "—"} · ${health.gateway.latency_ms}ms` : "not configured"}</dd></div>
          <div><dt>Current fleet</dt><dd className="mono">{getFleet()}</dd></div>
        </dl>
        <button className="content-tool" onClick={() => { settings.set({ portalName: "", accent: "", theme: "system" }); applySettings(); }}>Reset branding</button>
      </section>
    </div>
  );
}

function AddFleet({ onDone }: { onDone: () => void }) {
  const [f, setF] = useState({ name: "", accent: "#1db4d8", bridge_url: "", bridge_key: "", gateway_url: "", gateway_key: "" });
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const set = (k: string, v: string) => setF((p) => ({ ...p, [k]: v }));

  const submit = async () => {
    if (!f.name.trim()) { setMsg("Name is required."); return; }
    if (!f.bridge_url && !f.gateway_url) { setMsg("Give a bridge URL, a gateway URL, or both."); return; }
    setBusy(true); setMsg(null);
    try { await api.addFleet(f); onDone(); } catch (e) { setMsg(String(e)); setBusy(false); }
  };

  return (
    <div className="add-fleet">
      <div className="set-field"><label>Name</label><input className="add-input" value={f.name} onChange={(e) => set("name", e.target.value)} placeholder="e.g. Prod Hermes" /></div>
      <div className="set-grid">
        <div className="set-field"><label>Bridge URL</label><input className="add-input mono" value={f.bridge_url} onChange={(e) => set("bridge_url", e.target.value)} placeholder="http://host:51772" /></div>
        <div className="set-field"><label>Bridge token</label><input className="add-input mono" type="password" value={f.bridge_key} onChange={(e) => set("bridge_key", e.target.value)} /></div>
        <div className="set-field"><label>Gateway URL</label><input className="add-input mono" value={f.gateway_url} onChange={(e) => set("gateway_url", e.target.value)} placeholder="http://host:8642" /></div>
        <div className="set-field"><label>Gateway token</label><input className="add-input mono" type="password" value={f.gateway_key} onChange={(e) => set("gateway_key", e.target.value)} /></div>
      </div>
      <div className="set-field"><label>Accent</label><input type="color" value={f.accent} onChange={(e) => set("accent", e.target.value)} /></div>
      {msg && <p className="pane-msg mono">{msg}</p>}
      <button className="btn-primary" onClick={submit} disabled={busy}>{busy ? "Adding…" : "Add fleet"}</button>
    </div>
  );
}
