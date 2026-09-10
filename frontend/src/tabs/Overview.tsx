import type { State, HealthInfo } from "../types";

// Overview — the live snapshot. Every value here comes from /api/state; where a source is
// empty the panel says so rather than inventing. No fallback literals anywhere in this file.

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <span className="mono empty-note">{children}</span>;
}

export function Overview({ state, health }: { state: State; health: HealthInfo | null }) {
  const { fleet, routing, agentlogs_stats, agentlogs, vps, sessions } = state;
  const openMissions = state.board.filter((t) => t.status !== "done").length;
  const doneMissions = state.board.filter((t) => t.status === "done").length;
  const topAgent = [...fleet].sort((a, b) => b.share - a.share)[0];
  const tokens = sessions.totals.input + sessions.totals.output;
  const platforms = Object.entries(state.health?.platforms ?? {});

  return (
    <div className="overview">
      {/* hero */}
      <section className="hero card">
        <div className="hero-body">
          <div className="eyebrow hero-eyebrow">
            <span className="dot" /> Live · Orchestration layer
          </div>
          <h1 className="display hero-title">
            {fleet.length} agents.<br />
            <span className="ember">one console.</span>
          </h1>
          <p className="hero-lede">
            {topAgent && topAgent.share > 0
              ? `${topAgent.name} is carrying ${topAgent.share}% of the workload across ${routing.total} logged runs.`
              : `Fleet is idle — ${fleet.length} agents ready, no runs logged yet on this host.`}
          </p>
        </div>
        <div className="hero-side">
          <span className={`pill ${state.health?.gateway_state === "running" ? "ok" : "danger"}`}>
            gateway {state.health?.gateway_state ?? "unknown"}
          </span>
          {platforms.map(([name, st]) => (
            <span key={name} className={`pill ${st === "connected" ? "ok" : "warn"}`}>{name}</span>
          ))}
        </div>
      </section>

      {/* health strip */}
      <section className="card health-strip">
        <div>
          <span className="eyebrow">Gateway</span>
          <div className="strip-val">
            <span className={`status-dot ${state.health?.gateway_state === "running" ? "up" : "down"}`} />
            {state.health?.gateway_state ?? "unknown"}
            {state.health?.version && <span className="muted"> · v{state.health.version}</span>}
          </div>
        </div>
        <div>
          <span className="eyebrow">Platforms</span>
          <div className="strip-val platforms">
            {platforms.length === 0 ? (
              <EmptyNote>none bound</EmptyNote>
            ) : (
              platforms.map(([name, st]) => (
                <span key={name} className={`pill ${st === "connected" ? "ok" : "warn"}`}>{name}</span>
              ))
            )}
          </div>
        </div>
        <div>
          <span className="eyebrow">Mode</span>
          <div className="strip-val">{health?.mode ?? "—"}</div>
        </div>
      </section>

      {/* big-number row */}
      <section className="grid-4">
        <div className="card stat">
          <span className="eyebrow">Agents</span>
          <div className="display stat-num tabular">{fleet.length}</div>
          <span className="mono muted">in the fleet</span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Runs logged</span>
          <div className="display stat-num tabular">{routing.total}</div>
          {agentlogs_stats.failed > 0 ? (
            <span className="mono danger-text">{agentlogs_stats.failed} failed</span>
          ) : (
            <span className="mono muted">{agentlogs_stats.completed} completed</span>
          )}
        </div>
        <div className="card stat">
          <span className="eyebrow">Open missions</span>
          <div className="display stat-num tabular">{openMissions}</div>
          <span className="mono muted">{doneMissions} resolved</span>
        </div>
        <div className="card stat">
          <span className="eyebrow">Focus</span>
          {topAgent && topAgent.share > 0 ? (
            <>
              <div className="display stat-num tabular">{topAgent.share}%</div>
              <span className="mono muted">{topAgent.name}</span>
            </>
          ) : (
            <>
              <div className="display stat-num tabular muted">—</div>
              <EmptyNote>no runs yet</EmptyNote>
            </>
          )}
        </div>
      </section>

      <section className="grid-2">
        {/* routing */}
        <div className="card">
          <span className="eyebrow">Routing</span>
          {routing.total === 0 ? (
            <p className="empty-block mono">No runs logged yet. Routing appears once agents start taking turns.</p>
          ) : (
            <>
              <div className="routing-row">
                <span>{routing.premium_calls} complex</span>
                <span>{routing.fast_calls} simple</span>
                <span>{routing.models} models</span>
              </div>
              <div className="offload-bar">
                <div className="offload-fill" style={{ width: `${routing.offload_pct}%` }} />
              </div>
              <span className="mono muted">{routing.offload_pct}% offloaded to fast models</span>
              {routing.offload_pct === 0 && routing.total > 0 && (
                <p className="mono warn-text note">
                  Every run went to the premium model — complexity routing is not offloading.
                </p>
              )}
            </>
          )}
        </div>

        {/* host resources */}
        <div className="card">
          <span className="eyebrow">Host resources</span>
          <div className="meters">
            <Meter label="CPU" pct={vps.cpu_pct} />
            <Meter label="Memory" pct={vps.mem_pct} />
            <Meter label="Disk" pct={vps.disk_pct} />
          </div>
          <span className="mono muted">
            tokens this session: {tokens > 0 ? tokens.toLocaleString() : "—"}
          </span>
        </div>
      </section>

      <section className="grid-2">
        {/* fleet list */}
        <div className="card">
          <span className="eyebrow">Fleet · {fleet.length} agents</span>
          <ul className="agent-list">
            {fleet.map((a) => (
              <li key={a.agent}>
                <span className="ini">{a.initials}</span>
                <div className="agent-meta">
                  <span className="agent-name">{a.name}</span>
                  <span className="mono muted agent-role">{a.role || a.agent}</span>
                </div>
                <span className="mono agent-model">{a.defaultModel || <EmptyNote>model unset</EmptyNote>}</span>
                <span className="mono tabular agent-runs">{a.tasksToday} runs</span>
              </li>
            ))}
          </ul>
        </div>

        {/* live activity */}
        <div className="card">
          <span className="eyebrow">Recent activity</span>
          {agentlogs.length === 0 ? (
            <p className="empty-block mono">No agent runs recorded yet on this host.</p>
          ) : (
            <ul className="log-list">
              {agentlogs.slice(0, 8).map((l, i) => (
                <li key={i}>
                  <span className={`log-dot ${l.status === "completed" ? "ok" : l.status === "failed" ? "bad" : ""}`} />
                  <span className="mono log-agent">{l.agent}</span>
                  <span className="log-task">{l.task || "(no description)"}</span>
                  <span className="mono muted log-model">{l.model}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

function Meter({ label, pct }: { label: string; pct: number }) {
  const level = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "ok";
  return (
    <div className="meter">
      <div className="meter-head">
        <span className="mono">{label}</span>
        <span className="mono tabular">{pct}%</span>
      </div>
      <div className="meter-track">
        <div className={`meter-fill ${level}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
    </div>
  );
}
