import { useEffect, useState } from "react";
import type { State, HealthInfo } from "./types";
import { api, subscribeState } from "./api/client";
import { Overview } from "./tabs/Overview";
import "./styles/app.css";

const TABS = ["Overview", "Agents", "Chat", "Runs", "Tasks", "Office", "Content", "Schedule"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.health().then(setHealth).catch((e) => setError(String(e)));
    api.state().then(setState).catch((e) => setError(String(e)));
    return subscribeState(setState);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="dot" />
          <span className="display brand-name">Hermes</span>
          <span className="mono brand-sub">Mission Control</span>
        </div>
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`tab ${t === tab ? "active" : ""}`}
              onClick={() => setTab(t)}
            >
              {t}
            </button>
          ))}
        </nav>
        <div className="topbar-right">
          {health && (
            <span className={`pill ${health.gateway?.ok ? "ok" : "danger"}`}>
              {health.mode} · gateway {health.gateway?.ok ? "live" : "down"}
            </span>
          )}
        </div>
      </header>

      <main className="content">
        {error && <div className="banner danger">Cannot reach the portal backend — {error}</div>}
        {!state && !error && <div className="loading mono">loading live state…</div>}
        {state && tab === "Overview" && <Overview state={state} health={health} />}
        {state && tab !== "Overview" && (
          <div className="placeholder">
            <span className="eyebrow">{tab}</span>
            <p className="mono">This tab is next in the build. Live data is already flowing.</p>
          </div>
        )}
      </main>
    </div>
  );
}
