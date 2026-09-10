import { useEffect, useRef, useState } from "react";
import type { State } from "../types";
import { buildSkyline, buildArmillary, type SceneController, type FleetAgent } from "../office/scene";

// Office — the fleet as a living city (Skyline) or a celestial mechanism (Armillary). Both are
// generated from the live fleet: N agents, no hand-placed layout, stable visuals per agent.

type View = "skyline" | "armillary";

export function Office({ state }: { state: State }) {
  const [view, setView] = useState<View>("skyline");
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const ctrlRef = useRef<SceneController | null>(null);

  const fleet: FleetAgent[] = state.fleet.map((a) => ({
    agent: a.agent, initials: a.initials, name: a.name,
    tasksToday: a.tasksToday, success: a.success, share: a.share, state: a.state,
  }));
  const fleetKey = fleet.map((a) => `${a.agent}:${a.tasksToday}:${a.state}`).join("|");

  useEffect(() => {
    if (!canvasRef.current) return;
    ctrlRef.current?.dispose();
    const build = view === "skyline" ? buildSkyline : buildArmillary;
    ctrlRef.current = build(canvasRef.current, fleet);
    return () => { ctrlRef.current?.dispose(); ctrlRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, fleetKey]);

  const lightsOn = state.fleet.filter((a) => a.state === "EXECUTING" || a.state === "TASK_IN_PROGRESS").length;

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
              ? "Every agent owns a tower; the orchestrator runs HQ at the centre. Taller means busier; lit windows mean live work."
              : "The orchestrator is the core; each specialist holds an orbit. Body size is workload share, orbit speed is runs today."}
          </p>
        </div>
        <div className="office-controls">
          <div className="view-toggle">
            <button className={`view-btn ${view === "skyline" ? "active" : ""}`} onClick={() => setView("skyline")}>Skyline</button>
            <button className={`view-btn ${view === "armillary" ? "active" : ""}`} onClick={() => setView("armillary")}>Armillary</button>
          </div>
          <div className="office-stats mono">
            <span>{state.fleet.length} buildings</span>
            <span>{lightsOn} lit</span>
          </div>
        </div>
      </section>

      <section className="office-stage card">
        <canvas ref={canvasRef} className="office-canvas" />
        <div className="office-hint mono">drifting view · generated from the live fleet</div>
      </section>
    </div>
  );
}
