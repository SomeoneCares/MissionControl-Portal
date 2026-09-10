import type { State, HealthInfo } from "../types";
import { CpuIcon, RamIcon, DiskIcon, GatewayIcon, SendIcon, LinkIcon } from "../components/Icons";

// Overview — the live snapshot. Every value comes from /api/state; empty sources say so plainly.

function EmptyNote({ children }: { children: React.ReactNode }) {
  return <span className="mono empty-note">{children}</span>;
}

function cpuLabel(v: number) { return v >= 85 ? "high load" : v >= 60 ? "elevated" : "normal load"; }
function memLabel(v: number) { return v >= 90 ? "memory critical" : v >= 70 ? "memory tight" : "memory healthy"; }
function diskLabel(v: number) { return v >= 92 ? "space critical" : v >= 80 ? "space low" : "enough space"; }
function tone(v: number, warn: number, danger: number) { return v >= danger ? "danger" : v >= warn ? "warn" : "ok"; }

export function Overview({ state, health }: { state: State; health: HealthInfo | null }) {
  const { fleet, routing, agentlogs_stats, agentlogs, vps, sessions, model_usage } = state;
  const openMissions = state.board.filter((t) => t.status !== "done").length;
  const doneMissions = state.board.filter((t) => t.status === "done").length;
  const topAgent = [...fleet].sort((a, b) => b.share - a.share)[0];
  const tokens = sessions.totals.input + sessions.totals.output;
  const platforms = Object.entries(state.health?.platforms ?? {});
  const gatewayUp = (state.health?.gateway_state ?? "") === "running";

  return (
    <div className="overview">
      {/* hero */}
      <section className="hero card">
        <div className="hero-body">
          <div className="eyebrow hero-eyebrow"><span className="dot" /> Live · Orchestration layer</div>
          <h1 className="display hero-title">
            One orchestrator.<br /><span className="ember">one specialist fleet.</span>
          </h1>
          <p className="hero-lede">
            {topAgent && topAgent.share > 0
              ? `Hermes is coordinating the live specialist fleet — ${topAgent.name} carries ${topAgent.share}% of ${routing.total} logged runs.`
              : `${fleet.length} agents ready. No runs logged yet on this host.`}
          </p>
        </div>
        <span className="pill hero-pill">{health?.mode === "remote" ? "remote systems" : "live systems"}</span>
      </section>

      {/* live orchestration health — big tiles + platform status */}
      <section className="card health-card">
        <div className="health-card-head">
          <div>
            <span className="display health-title">Overview</span>
            <div className="eyebrow">Live orchestration health</div>
          </div>
          <span className={`pill ${gatewayUp ? "ok" : "warn"}`}>
            <span className="live-dot" /> {gatewayUp ? "realtime" : "degraded"}
          </span>
        </div>
        <div className="health-tiles">
          <HealthTile icon={<CpuIcon />} label="CPU" value={vps.cpu_pct} sub={cpuLabel(vps.cpu_pct)} tone={tone(vps.cpu_pct, 60, 85)} accent="a" />
          <HealthTile icon={<RamIcon />} label="RAM" value={vps.mem_pct} sub={memLabel(vps.mem_pct)} tone={tone(vps.mem_pct, 70, 90)} accent="b" />
          <HealthTile icon={<DiskIcon />} label="DISK" value={vps.disk_pct} sub={diskLabel(vps.disk_pct)} tone={tone(vps.disk_pct, 80, 92)} accent="c" />
        </div>
        <div className="status-rows">
          <StatusRow icon={<GatewayIcon />} name="Gateway" sub="Listening for inbound events"
                     state={gatewayUp ? "connected" : "down"} ok={gatewayUp} />
          {platforms.length === 0 ? (
            <div className="status-row"><span className="mono empty-note">no platforms bound</span></div>
          ) : (
            platforms.slice(0, 3).map(([name, st]) => (
              <StatusRow key={name} icon={name.includes("telegram") ? <SendIcon /> : <LinkIcon />}
                         name={prettyPlatform(name)} sub={platformSub(name)}
                         state={st === "connected" ? "online" : st} ok={st === "connected"} />
            ))
          )}
        </div>
      </section>

      {/* big-number row */}
      <section className="grid-4">
        <StatTile label="Agents" value={fleet.length} sub="in the fleet" />
        <StatTile label="Runs logged" value={routing.total}
                  sub={agentlogs_stats.failed > 0 ? `${agentlogs_stats.failed} failed` : `${agentlogs_stats.completed} completed`}
                  danger={agentlogs_stats.failed > 0} />
        <StatTile label="Open missions" value={openMissions} sub={`${doneMissions} resolved`} />
        {topAgent && topAgent.share > 0
          ? <StatTile label="Focus" value={`${topAgent.share}%`} sub={topAgent.name} />
          : <div className="card stat"><span className="eyebrow">Focus</span><div className="display stat-num tabular muted">—</div><EmptyNote>no runs yet</EmptyNote></div>}
      </section>

      {/* inference ledger + throughput */}
      <section className="grid-2">
        <div className="card ledger">
          <div className="eyebrow ledger-eyebrow"><LinkIcon size={13} /> Inference ledger · model routing</div>
          {routing.total === 0 ? (
            <p className="empty-block mono">No inference logged yet. The ledger fills as agents take turns.</p>
          ) : (
            <>
              <ul className="ledger-list">
                {model_usage.map((m) => (
                  <li key={m.name}>
                    <span className="mono ledger-model">{m.name}</span>
                    <div className="ledger-bar"><div className="ledger-fill" style={{ width: `${m.pct}%` }} /></div>
                    <span className="mono tabular ledger-count">{m.count} · {m.pct}%</span>
                  </li>
                ))}
              </ul>
              <div className="ledger-foot">
                <div><span className="mono muted">complex</span><span className="mono tabular">{routing.premium_calls}</span></div>
                <div><span className="mono muted">simple</span><span className="mono tabular">{routing.fast_calls}</span></div>
                <div><span className="mono muted">offload</span><span className="mono tabular">{routing.offload_pct}%</span></div>
                <div><span className="mono muted">tokens</span><span className="mono tabular">{tokens > 0 ? compact(tokens) : "—"}</span></div>
              </div>
              {routing.offload_pct === 0 && routing.total > 0 && (
                <p className="mono warn-text note">Every run went to the premium model — complexity routing is not offloading.</p>
              )}
            </>
          )}
        </div>

        <div className="card throughput">
          <span className="eyebrow">Throughput across the specialist fleet</span>
          {routing.total === 0 ? (
            <p className="empty-block mono">No throughput yet.</p>
          ) : (
            <ul className="tp-list">
              {[...fleet].sort((a, b) => b.tasksToday - a.tasksToday).map((a) => {
                const max = Math.max(1, ...fleet.map((x) => x.tasksToday));
                return (
                  <li key={a.agent}>
                    <span className="mono tp-name">{a.initials}</span>
                    <div className="tp-bar"><div className="tp-fill" style={{ width: `${(a.tasksToday / max) * 100}%` }} /></div>
                    <span className="mono tabular tp-count">{a.tasksToday}</span>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </section>

      {/* fleet + activity */}
      <section className="grid-2">
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

function HealthTile({ icon, label, value, sub, tone, accent }:
  { icon: React.ReactNode; label: string; value: number; sub: string; tone: string; accent: string }) {
  return (
    <div className="health-tile">
      <div className="health-tile-top">
        <span className={`tile-icon acc-${accent}`}>{icon}</span>
        <span className="eyebrow">{label}</span>
      </div>
      <div className="display tile-num tabular">{value}%</div>
      <span className={`mono tile-sub ${tone}`}>{sub}</span>
    </div>
  );
}

function StatusRow({ icon, name, sub, state, ok }:
  { icon: React.ReactNode; name: string; sub: string; state: string; ok: boolean }) {
  return (
    <div className="status-row">
      <span className="status-icon">{icon}</span>
      <div className="status-meta">
        <span className="status-name">{name}</span>
        <span className="mono muted status-sub">{sub}</span>
      </div>
      <span className={`status-state ${ok ? "ok" : "warn"}`}><span className="live-dot" /> {state}</span>
    </div>
  );
}

function StatTile({ label, value, sub, danger }: { label: string; value: React.ReactNode; sub: string; danger?: boolean }) {
  return (
    <div className="card stat">
      <span className="eyebrow">{label}</span>
      <div className="display stat-num tabular">{value}</div>
      <span className={`mono ${danger ? "danger-text" : "muted"}`}>{sub}</span>
    </div>
  );
}

function prettyPlatform(name: string): string {
  if (name.includes("telegram")) return "Telegram";
  if (name.includes("discord")) return "Discord";
  if (name.includes("homeassistant")) return "Home Assistant";
  if (name === "api_server") return "API server";
  return name;
}
function platformSub(name: string): string {
  if (name.includes("telegram")) return "Bot bridge active";
  if (name.includes("discord")) return "Bot bridge active";
  if (name.includes("homeassistant")) return "Home automation link";
  if (name === "api_server") return "OpenAI-compatible gateway";
  return "Connected";
}
function compact(n: number): string { return n >= 1000 ? (n / 1000).toFixed(1) + "k" : String(n); }
