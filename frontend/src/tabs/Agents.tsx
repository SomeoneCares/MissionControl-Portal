import { useEffect, useState } from "react";
import type { State, Agent } from "../types";
import { api, type ModelOption, type AgentFile } from "../api/client";

// Agents — one card per agent the server reports, any number. Detail drawer on click.
// Fleet capabilities (toolsets) come from the gateway; per-agent vitals from /api/state.

export function Agents({ state }: { state: State }) {
  const [selected, setSelected] = useState<Agent | null>(null);
  const [toolsets, setToolsets] = useState<string[] | null>(null);
  const [creating, setCreating] = useState(false);

  useEffect(() => {
    // Toolsets are a fleet-wide capability, read from the gateway via the backend (fleet-aware).
    api.toolsets()
      .then((d) => setToolsets((d.data ?? []).map((t: { name: string }) => t.name)))
      .catch(() => setToolsets([]));
  }, []);

  const totalRuns = state.fleet.reduce((s, a) => s + a.tasksToday, 0);
  const avgSuccess =
    state.fleet.length > 0
      ? (state.fleet.reduce((s, a) => s + a.success, 0) / state.fleet.length).toFixed(1)
      : "—";

  return (
    <div className="agents">
      <section className="agents-head card">
        <div>
          <span className="eyebrow">Fleet</span>
          <h1 className="display agents-title">
            {state.fleet.length} {state.fleet.length === 1 ? "agent" : "agents"},
            <span className="ember"> one console.</span>
          </h1>
        </div>
        <div className="agents-head-stats">
          <div>
            <div className="display head-stat tabular">{totalRuns}</div>
            <span className="eyebrow">runs today</span>
          </div>
          <div>
            <div className="display head-stat tabular">{avgSuccess}%</div>
            <span className="eyebrow">avg success</span>
          </div>
          <button className="btn-primary new-agent-btn" onClick={() => setCreating(true)}>+ New agent</button>
        </div>
      </section>

      {creating && <CreateAgentModal onClose={() => setCreating(false)} />}

      {toolsets && toolsets.length > 0 && (
        <section className="card">
          <span className="eyebrow">Fleet capabilities · toolsets</span>
          <div className="toolset-row">
            {toolsets.map((t) => (
              <span key={t} className="pill">{t}</span>
            ))}
          </div>
        </section>
      )}

      <section className="agent-grid">
        {state.fleet.map((a) => (
          <button key={a.agent} className="agent-card card" onClick={() => setSelected(a)}>
            <div className="agent-card-top">
              <span className="ini big">{a.initials}</span>
              <span className={`state-chip ${a.state.toLowerCase()}`}>{a.state}</span>
            </div>
            <div className="agent-card-name">{a.name}</div>
            <div className="mono muted agent-card-role">{a.role || a.agent}</div>
            <div className="agent-card-foot">
              <span className="mono agent-card-model">{a.defaultModel || "model unset"}</span>
              <span className="mono tabular muted">{a.tasksToday} runs · {a.success}%</span>
            </div>
            <div className="share-track">
              <div className="share-fill" style={{ width: `${a.share}%` }} />
            </div>
          </button>
        ))}
      </section>

      {selected && <AgentDrawer agent={selected} onClose={() => setSelected(null)} />}
    </div>
  );
}

type DrawerTab = "profile" | "model" | "skills" | "files";

function CreateAgentModal({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [role, setRole] = useState("");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<ModelOption[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.models().then((d) => setModels(d.models)).catch(() => setModels([])); }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const create = async () => {
    if (!name.trim()) { setMsg("Name is required."); return; }
    setBusy(true); setMsg(null);
    try {
      const r = await api.createAgent({ name: name.trim(), role: role.trim(), model });
      setMsg(`Created ${r.agent}. It joins the fleet on the next state refresh; set its persona in Files.`);
      setTimeout(onClose, 1400);
    } catch (e) {
      setMsg(String(e));
      setBusy(false);
    }
  };

  const byProvider: Record<string, ModelOption[]> = {};
  models.forEach((m) => { (byProvider[m.provider || "other"] ??= []).push(m); });

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span className="display modal-title">New agent</span>
          <button className="drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <label className="pane-label">Name</label>
        <input className="add-input" value={name} autoFocus placeholder="e.g. Analyst" onChange={(e) => setName(e.target.value)} />
        <label className="pane-label">Role</label>
        <input className="add-input" value={role} placeholder="e.g. log triage and investigation" onChange={(e) => setRole(e.target.value)} />
        <label className="pane-label">Model</label>
        <select className="model-select mono" value={model} onChange={(e) => setModel(e.target.value)}>
          <option value="">default</option>
          {Object.entries(byProvider).map(([prov, list]) => (
            <optgroup key={prov} label={prov}>
              {list.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
          ))}
        </select>
        <p className="mono muted create-note">Creates a real Hermes profile via the CLI. Persona and memory are edited after, in the agent's Files.</p>
        {msg && <p className="pane-msg mono">{msg}</p>}
        <div className="modal-actions">
          <button className="btn-primary" onClick={create} disabled={busy || !name.trim()}>{busy ? "Creating…" : "Create agent"}</button>
        </div>
      </div>
    </div>
  );
}

function AgentDrawer({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [tab, setTab] = useState<DrawerTab>("profile");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <aside className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className="ini big">{agent.initials}</span>
          <div>
            <div className="display drawer-name">{agent.name}</div>
            <div className="mono muted">{agent.role || agent.agent}</div>
          </div>
          <button className="drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div className="drawer-tabs">
          {(["profile", "model", "skills", "files"] as DrawerTab[]).map((t) => (
            <button key={t} className={`drawer-tab ${t === tab ? "active" : ""}`} onClick={() => setTab(t)}>
              {t}
            </button>
          ))}
        </div>

        {tab === "profile" && <ProfilePane agent={agent} />}
        {tab === "model" && <ModelPane agent={agent} />}
        {tab === "skills" && <SkillsPane agent={agent} />}
        {tab === "files" && <FilesPane agent={agent} />}
      </aside>
    </div>
  );
}

function ProfilePane({ agent }: { agent: Agent }) {
  return (
    <>
      <div className="drawer-stats">
        <div className="card mini">
          <span className="eyebrow">Runs today</span>
          <div className="display mini-num tabular">{agent.tasksToday}</div>
        </div>
        <div className="card mini">
          <span className="eyebrow">Success</span>
          <div className="display mini-num tabular ember">{agent.success}%</div>
        </div>
      </div>
      <dl className="drawer-fields">
        <div><dt>Profile</dt><dd className="mono">{agent.agent}</dd></div>
        <div><dt>Model</dt><dd className="mono">{agent.defaultModel || "—"}</dd></div>
        <div><dt>Provider</dt><dd className="mono">{agent.provider || "—"}</dd></div>
        <div><dt>Workload share</dt><dd className="mono">{agent.share}%</dd></div>
        <div><dt>State</dt><dd className="mono">{agent.state}</dd></div>
      </dl>
      {agent.task && (
        <div className="drawer-task">
          <span className="eyebrow">Last task</span>
          <p>{agent.task}</p>
        </div>
      )}
    </>
  );
}

function ModelPane({ agent }: { agent: Agent }) {
  const [models, setModels] = useState<ModelOption[] | null>(null);
  const [choice, setChoice] = useState("");
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [current, setCurrent] = useState(agent.defaultModel);

  useEffect(() => {
    api.models().then((d) => {
      setModels(d.editable ? d.models : []);
      if (!d.editable) setMsg("Model editing is available in local mode only.");
    }).catch(() => setModels([]));
  }, []);

  const save = async () => {
    if (!choice) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api.setModel(agent.agent, choice);
      setCurrent(r.model);
      setMsg(`Model set to ${r.model}${r.backup ? " (previous config backed up)" : ""}. Takes effect on the agent's next turn.`);
    } catch (e) {
      setMsg(String(e));
    }
    setSaving(false);
  };

  const byProvider: Record<string, ModelOption[]> = {};
  (models ?? []).forEach((m) => { (byProvider[m.provider || "other"] ??= []).push(m); });

  return (
    <div className="pane">
      <div className="pane-row">
        <span className="eyebrow">Current model</span>
        <span className="mono current-model">{current || "unset"}</span>
      </div>
      {models === null ? (
        <p className="mono muted pane-loading">loading models…</p>
      ) : models.length === 0 ? (
        <p className="mono muted">{msg || "No models available."}</p>
      ) : (
        <>
          <label className="pane-label">Change to</label>
          <select className="model-select mono" value={choice} onChange={(e) => setChoice(e.target.value)}>
            <option value="">select a model…</option>
            {Object.entries(byProvider).map(([prov, list]) => (
              <optgroup key={prov} label={prov}>
                {list.map((m) => (
                  <option key={m.id} value={m.id}>{m.label} {m.source === "live" ? "· live" : ""}</option>
                ))}
              </optgroup>
            ))}
          </select>
          <button className="btn-primary pane-save" onClick={save} disabled={!choice || saving}>
            {saving ? "Setting…" : "Set model"}
          </button>
          <p className="mono muted pane-count">{models.length} models enabled on this host</p>
        </>
      )}
      {msg && <p className="pane-msg mono">{msg}</p>}
    </div>
  );
}

function SkillsPane({ agent }: { agent: Agent }) {
  const [installed, setInstalled] = useState<{ name: string; description: string }[] | null>(null);
  const [disabled, setDisabled] = useState<string[]>([]);
  const [toolsets, setToolsets] = useState<string[]>([]);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () => api.agentSkills(agent.agent).then((d) => { setInstalled(d.installed); setDisabled(d.disabled_toolsets); }).catch(() => setInstalled([]));
  useEffect(() => {
    load();
    api.toolsets().then((d) => setToolsets((d.data ?? []).map((t: { name: string }) => t.name))).catch(() => setToolsets([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.agent]);

  const toggle = async (t: string, enabled: boolean) => {
    setDisabled((d) => enabled ? d.filter((x) => x !== t) : [...d, t]); // optimistic
    try { await api.setToolset(agent.agent, t, enabled); setMsg(`${t} ${enabled ? "enabled" : "disabled"} — takes effect next turn.`); }
    catch (e) { setMsg(String(e)); load(); }
  };

  return (
    <div className="pane">
      <span className="eyebrow">Toolsets</span>
      {toolsets.length === 0 ? (
        <p className="mono muted pane-loading">no toolsets reported by the gateway</p>
      ) : (
        <ul className="toolset-list">
          {toolsets.map((t) => {
            const on = !disabled.includes(t);
            return (
              <li key={t} className="toolset-item">
                <span className="mono toolset-name">{t}</span>
                <button className={`toggle ${on ? "on" : "off"}`} onClick={() => toggle(t, !on)} aria-label={on ? "disable" : "enable"}>
                  <span className="toggle-knob" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <span className="eyebrow skills-installed-title">Installed skills</span>
      {installed === null ? (
        <p className="mono muted pane-loading">loading…</p>
      ) : installed.length === 0 ? (
        <p className="empty-block mono">No skills installed for this agent.</p>
      ) : (
        <ul className="skill-list">
          {installed.map((sk, i) => (
            <li key={i}>
              <span className="skill-name">{sk.name}</span>
              {sk.description && <span className="mono muted skill-desc">{sk.description}</span>}
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="pane-msg mono">{msg}</p>}
    </div>
  );
}

function FilesPane({ agent }: { agent: Agent }) {
  const [files, setFiles] = useState<AgentFile[] | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [content, setContent] = useState("");
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => { api.agentFiles(agent.agent).then((d) => setFiles(d.files)).catch(() => setFiles([])); }, [agent.agent]);

  const openFile = async (name: string) => {
    setOpen(name); setMsg(null); setDirty(false); setContent("");
    try {
      const d = await api.agentFile(agent.agent, name);
      setContent(d.content);
      if (d.redacted) setMsg("Secrets in this file are shown as [REDACTED] and cannot be saved.");
    } catch (e) { setMsg(String(e)); }
  };

  const save = async () => {
    if (!open) return;
    setSaving(true); setMsg(null);
    try {
      const r = await api.saveFile(agent.agent, open, content);
      setDirty(false);
      setMsg(`Saved ${open}${r.backup ? " (previous version backed up)" : ""}.`);
      api.agentFiles(agent.agent).then((d) => setFiles(d.files));
    } catch (e) { setMsg(String(e)); }
    setSaving(false);
  };

  if (open) {
    return (
      <div className="pane">
        <div className="file-editor-head">
          <button className="file-back mono" onClick={() => setOpen(null)}>← files</button>
          <span className="mono file-open-name">{open}</span>
          <button className="btn-primary file-save" onClick={save} disabled={!dirty || saving}>
            {saving ? "Saving…" : "Save"}
          </button>
        </div>
        <textarea
          className="file-editor mono"
          value={content}
          onChange={(e) => { setContent(e.target.value); setDirty(true); }}
          spellCheck={false}
        />
        {msg && <p className="pane-msg mono">{msg}</p>}
      </div>
    );
  }

  return (
    <div className="pane">
      <span className="eyebrow">Editable files</span>
      {files === null ? (
        <p className="mono muted pane-loading">loading…</p>
      ) : (
        <ul className="file-list">
          {files.map((f) => (
            <li key={f.name}>
              <button className="file-item" onClick={() => openFile(f.name)}>
                <span className="mono file-name">{f.name}</span>
                <span className="mono muted file-size">
                  {f.exists ? `${f.size} B` : "new"}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {msg && <p className="pane-msg mono">{msg}</p>}
      <p className="mono muted files-note">
        SOUL is the persona · AGENTS the operating rules · MEMORY/USER the memory · config the model & tools.
      </p>
    </div>
  );
}
