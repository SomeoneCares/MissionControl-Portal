import { useEffect, useState } from "react";
import type { State, HealthInfo } from "./types";
import { api, subscribeState, setConnection, getConnection, type ConnectionInfo } from "./api/client";
import { settings, applySettings } from "./store/settings";
import { Overview } from "./tabs/Overview";
import { Agents } from "./tabs/Agents";
import { Chat } from "./tabs/Chat";
import { Runs } from "./tabs/Runs";
import { Tasks } from "./tabs/Tasks";
import { Content } from "./tabs/Content";
import { Schedule } from "./tabs/Schedule";
import { Office } from "./tabs/Office";
import { Settings } from "./tabs/Settings";
import { Login } from "./Login";
import "./styles/app.css";

const TABS = ["Overview", "Agents", "Chat", "Runs", "Tasks", "Office", "Content", "Schedule", "Settings"] as const;
type Tab = (typeof TABS)[number];

export function App() {
  const [state, setState] = useState<State | null>(null);
  const [health, setHealth] = useState<HealthInfo | null>(null);
  const [tab, setTab] = useState<Tab>("Overview");
  const [error, setError] = useState<string | null>(null);
  const [connections, setConnections] = useState<ConnectionInfo[]>([]);
  const [brand, setBrand] = useState(settings.get().portalName);
  // null = still checking; true = show app; false = show login gate.
  const [authed, setAuthed] = useState<boolean | null>(null);
  // mobile hamburger menu (no effect at desktop widths — the CSS only collapses
  // the tab bar below the mobile breakpoint).
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    applySettings();
    const un = settings.subscribe(() => setBrand(settings.get().portalName));
    api.authStatus()
      .then((s) => setAuthed(!s.required || s.authed))
      .catch(() => setAuthed(true)); // status endpoint is open; if it fails, let the app try
    return () => { un(); };
  }, []);

  // Load live data only once past the auth gate, so we never fire a wall of 401s at the login screen.
  useEffect(() => {
    if (authed !== true) return;
    api.health().then(setHealth).catch((e) => setError(String(e)));
    api.state().then(setState).catch((e) => setError(String(e)));
    api.connections().then((d) => setConnections(d.connections)).catch(() => setConnections([]));
    // Shared branding (name + accent) is portal-owned, so every device shows the same identity.
    // If the server has none yet but this browser does (pre-shared-branding local settings), seed
    // the server from it — a one-time migration from whichever device had the branding. Theme stays
    // per-device and is never touched here.
    api.branding().then((b) => {
      if (b.name || b.accent) settings.set({ portalName: b.name, accent: b.accent });
      else {
        const s = settings.get();
        if (s.portalName || s.accent) api.setBranding({ name: s.portalName, accent: s.accent }).catch(() => {});
      }
    }).catch(() => { /* offline / older backend: keep local branding */ });
    const stop = subscribeState(setState);
    return () => { stop(); };
  }, [authed]);

  if (authed === null) return <div className="loading mono">loading…</div>;
  if (authed === false) return <Login onAuthed={() => setAuthed(true)} />;

  return (
    <div className="app">
      <header className={`topbar ${menuOpen ? "menu-open" : ""}`}>
        <div className="brand">
          <span className="dot" />
          <span className="display brand-name">{brand || "Hermes"}</span>
          <span className="mono brand-sub">Mission Control</span>
        </div>
        <button
          className="hamburger"
          aria-label={menuOpen ? "Close menu" : "Open menu"}
          aria-expanded={menuOpen}
          onClick={() => setMenuOpen((v) => !v)}
        >
          <span /><span /><span />
        </button>
        {connections.length > 1 && (
          <select className="conn-select mono" value={getConnection()}
                  onChange={(e) => { setConnection(e.target.value); location.reload(); }}>
            {connections.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
        )}
        <nav className="tabs">
          {TABS.map((t) => (
            <button
              key={t}
              className={`tab ${t === tab ? "active" : ""}`}
              onClick={() => { setTab(t); setMenuOpen(false); }}
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
          <button className="signout mono" title="Sign out"
                  onClick={() => { api.logout().finally(() => setAuthed(false)); }}>
            Sign out
          </button>
        </div>
      </header>

      <main className="content">
        {error && <div className="banner danger">Cannot reach the portal backend — {error}</div>}
        {!state && !error && <div className="loading mono">loading live state…</div>}
        {state && tab === "Overview" && <Overview state={state} health={health} />}
        {state && tab === "Agents" && <Agents state={state} />}
        {state && tab === "Chat" && <Chat state={state} health={health} />}
        {state && tab === "Runs" && <Runs state={state} />}
        {tab === "Tasks" && <Tasks />}
        {tab === "Content" && <Content />}
        {tab === "Schedule" && <Schedule />}
        {state && tab === "Office" && <Office state={state} />}
        {tab === "Settings" && <Settings health={health} />}
      </main>
    </div>
  );
}
