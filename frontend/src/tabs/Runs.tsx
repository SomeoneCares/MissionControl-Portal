import { useState } from "react";
import type { State } from "../types";

// Runs — the fleet's execution history from the agent run log. Filter to failures to see what
// went wrong. Live run telemetry (reasoning + tool trace) is surfaced inside Chat during a turn;
// this tab is the durable record.

type Filter = "all" | "completed" | "failed";

export function Runs({ state }: { state: State }) {
  const [filter, setFilter] = useState<Filter>("all");
  const { agentlogs, agentlogs_stats } = state;

  const rows = agentlogs.filter((l) =>
    filter === "all" ? true : filter === "failed" ? l.status === "failed" : l.status === "completed",
  );

  return (
    <div className="runs">
      <section className="runs-head card">
        <div>
          <span className="eyebrow">Execution log</span>
          <h1 className="display runs-title">Every run, <span className="ember">on the record.</span></h1>
        </div>
        <div className="runs-stats">
          <Stat n={agentlogs_stats.total} label="total" />
          <Stat n={agentlogs_stats.completed} label="completed" tone="ok" />
          <Stat n={agentlogs_stats.failed} label="failed" tone={agentlogs_stats.failed > 0 ? "danger" : undefined} />
        </div>
      </section>

      <div className="runs-filter">
        {(["all", "completed", "failed"] as Filter[]).map((f) => (
          <button key={f} className={`filter-btn ${f === filter ? "active" : ""}`} onClick={() => setFilter(f)}>
            {f}{f === "failed" && agentlogs_stats.failed > 0 ? ` · ${agentlogs_stats.failed}` : ""}
          </button>
        ))}
      </div>

      <section className="card runs-table-card">
        {rows.length === 0 ? (
          <p className="empty-block mono">
            {agentlogs.length === 0 ? "No runs recorded yet on this host." : `No ${filter} runs.`}
          </p>
        ) : (
          <table className="runs-table">
            <thead>
              <tr><th>Agent</th><th>Task</th><th>Model</th><th>Status</th><th>When</th></tr>
            </thead>
            <tbody>
              {rows.map((l, i) => (
                <tr key={i} className={l.status === "failed" ? "row-failed" : ""}>
                  <td className="mono run-agent">{l.agent}</td>
                  <td className="run-task">{l.task || "—"}</td>
                  <td className="mono run-model">{l.model || "—"}</td>
                  <td>
                    <span className={`run-status ${l.status}`}>{l.status || "—"}</span>
                  </td>
                  <td className="mono run-time">{l.time || "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function Stat({ n, label, tone }: { n: number; label: string; tone?: "ok" | "danger" }) {
  return (
    <div className="runs-stat">
      <div className={`display runs-stat-num tabular ${tone ?? ""}`}>{n}</div>
      <span className="eyebrow">{label}</span>
    </div>
  );
}
