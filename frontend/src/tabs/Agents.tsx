import { useEffect, useState } from "react";
import type { State, Agent } from "../types";

// Agents — one card per agent the server reports, any number. Detail drawer on click.
// Fleet capabilities (toolsets) come from the gateway; per-agent vitals from /api/state.

export function Agents({ state }: { state: State }) {
  const [selected, setSelected] = useState<Agent | null>(null);
  const [toolsets, setToolsets] = useState<string[] | null>(null);

  useEffect(() => {
    // Toolsets are a fleet-wide capability, read from the gateway via the backend.
    fetch("/api/toolsets")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => setToolsets((d.data ?? []).map((t: any) => t.name)))
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
        </div>
      </section>

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

function AgentDrawer({ agent, onClose }: { agent: Agent; onClose: () => void }) {
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
      </aside>
    </div>
  );
}
