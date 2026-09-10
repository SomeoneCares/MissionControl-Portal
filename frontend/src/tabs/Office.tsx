import { useEffect, useRef, useState } from "react";
import type { State, Agent } from "../types";
import { buildArmillary, type SceneController, type FleetAgent } from "../office/scene";
import { buildSkyline } from "../office/skyline";
import { settings } from "../store/settings";

// Office — the fleet as a living city (Skyline) or a celestial mechanism (Armillary). Both are
// generated from the live fleet: N agents, no hand-placed layout, stable visuals per agent.

type View = "skyline" | "armillary";

export function Office({ state }: { state: State }) {
  const [view, setView] = useState<View>("skyline");
  const [selected, setSelected] = useState<string | null>(null);
  const [accent, setAccent] = useState(settings.get().accent);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<SceneController | null>(null);

  useEffect(() => settings.subscribe(() => setAccent(settings.get().accent)), []);

  const fleet: FleetAgent[] = state.fleet.map((a) => ({
    agent: a.agent, initials: a.initials, name: a.name, role: a.role,
    tasksToday: a.tasksToday, success: a.success, share: a.share, state: a.state,
  }));
  const fleetKey = fleet.map((a) => `${a.agent}:${a.tasksToday}:${a.state}`).join("|");

  useEffect(() => {
    if (!canvasRef.current) return;
    ctrlRef.current?.dispose();
    const build = view === "skyline" ? buildSkyline : buildArmillary;
    ctrlRef.current = build(canvasRef.current, fleet, { onSelect: (a) => setSelected(a) });
    return () => { ctrlRef.current?.dispose(); ctrlRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, fleetKey, accent]);

  const execN = state.fleet.filter((a) => ["EXECUTING", "PROCESSING_NOW", "TASK_IN_PROGRESS"].includes(a.state)).length;
  const assignedN = state.fleet.filter((a) => ["ASSIGNED", "TASK_ASSIGNED"].includes(a.state)).length;
  const dossier: Agent | undefined = selected ? state.fleet.find((a) => a.agent === selected) : undefined;

  return (
    <div className="office">
      <section className="office-head card">
        <div>
          <span className="eyebrow">The empire</span>
          <h1 className="display office-title">
            {view === "skyline" ? "A city built by " : "The fleet in "}
            <span className="ember">{view === "skyline" ? "agents." : "orbit."}</span>
          </h1>
          <p className="muted office-sub">
            {view === "skyline"
              ? "Every agent owns a tower; the orchestrator runs HQ at the centre. Green pulse = executing now, steady orange = task assigned, blue = idle."
              : "The orchestrator is the core; each specialist holds an orbit. Body size is workload share, orbit speed is runs today. Green = executing now, orange = task assigned, blue = idle."}
          </p>
        </div>
        <div className="office-controls">
          <div className="view-toggle">
            <button className={`view-btn ${view === "skyline" ? "active" : ""}`} onClick={() => setView("skyline")}>Skyline</button>
            <button className={`view-btn ${view === "armillary" ? "active" : ""}`} onClick={() => setView("armillary")}>Armillary</button>
          </div>
          <div className="office-stats mono">
            <span>{state.fleet.length} buildings</span>
            <span>{execN} executing</span>
            <span>{assignedN} assigned</span>
          </div>
        </div>
      </section>

      <section className="office-stage card">
        <canvas ref={canvasRef} className="office-canvas" />
        <div className="office-hint mono">drag · scroll · zoom · click a building</div>
        {dossier && (
          <div className="office-dossier">
            <button className="dossier-x" onClick={() => setSelected(null)} aria-label="Close">✕</button>
            <span className="ini big">{dossier.initials}</span>
            <div className="display dossier-name">{dossier.name}</div>
            <div className="mono muted dossier-role">{dossier.role || dossier.agent}</div>
            <dl className="dossier-fields">
              <div><dt>Model</dt><dd className="mono">{dossier.defaultModel || "—"}</dd></div>
              <div><dt>Runs today</dt><dd className="mono">{dossier.tasksToday}</dd></div>
              <div><dt>Success</dt><dd className="mono">{dossier.success}%</dd></div>
              <div><dt>Share</dt><dd className="mono">{dossier.share}%</dd></div>
              <div><dt>State</dt><dd className="mono">{dossier.state}</dd></div>
            </dl>
          </div>
        )}
      </section>
    </div>
  );
}
