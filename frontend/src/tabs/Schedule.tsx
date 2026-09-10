import { useEffect, useState } from "react";
import { api, type CronJob } from "../api/client";

// Schedule — the fleet's scheduled jobs, read from Hermes' cron. Read-only view; a job whose
// last run errored is surfaced without opening it.

export function Schedule() {
  const [jobs, setJobs] = useState<CronJob[] | null>(null);

  useEffect(() => { api.schedule().then((d) => setJobs(d.jobs)).catch(() => setJobs([])); }, []);

  const active = (jobs ?? []).filter((j) => j.enabled).length;

  return (
    <div className="schedule">
      <section className="sched-head card">
        <div>
          <span className="eyebrow">Automation</span>
          <h1 className="display sched-title">Jobs that <span className="ember">run themselves.</span></h1>
        </div>
        <div className="runs-stats">
          <div className="runs-stat"><div className="display runs-stat-num tabular">{jobs?.length ?? 0}</div><span className="eyebrow">jobs</span></div>
          <div className="runs-stat"><div className="display runs-stat-num tabular ok">{active}</div><span className="eyebrow">active</span></div>
        </div>
      </section>

      {jobs === null ? (
        <p className="mono muted pane-loading">loading…</p>
      ) : jobs.length === 0 ? (
        <div className="card"><p className="empty-block mono">No scheduled jobs on this host.</p></div>
      ) : (
        <div className="sched-list">
          {jobs.map((j) => (
            <div key={j.id} className={`card sched-item ${j.last_status === "error" || j.last_error ? "has-error" : ""}`}>
              <div className="sched-item-head">
                <div>
                  <span className={`sched-dot ${j.enabled ? "on" : "off"}`} />
                  <span className="sched-name">{j.name}</span>
                </div>
                <span className="mono sched-cron">{j.schedule || "—"}</span>
              </div>
              <div className="sched-meta mono">
                <span>next: {j.next_run_at ? new Date(j.next_run_at).toLocaleString() : "—"}</span>
                <span>deliver: {j.deliver || "—"}</span>
                <span>model: {j.model || "—"}</span>
                <span className={`sched-last ${j.last_error ? "err" : ""}`}>
                  last: {j.last_error ? "error" : (j.last_status || "—")}
                </span>
              </div>
              {j.last_error && <p className="sched-error mono">{j.last_error}</p>}
              {j.prompt && <p className="sched-prompt">{j.prompt}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
