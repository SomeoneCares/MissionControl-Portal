import { useEffect, useRef, useState } from "react";
import type { KanbanTask, TaskStage } from "../types";
import { api } from "../api/client";

// Tasks — the fleet's live task board, read straight from Hermes' shared kanban (kanban.db).
// Tasks appear when agents create or delegate work, and move through stages on their own as the
// dispatcher claims, runs, reviews and completes them. Dragging a card asks Hermes to make the
// move via its own state machine; Hermes accepts the transitions its workflow allows and rejects
// the ones it drives itself (a card mid-run, a worker-only "running" stage), and we surface why.

export function Tasks() {
  const [tasks, setTasks] = useState<KanbanTask[]>([]);
  const [stages, setStages] = useState<TaskStage[]>([]);
  const [editable, setEditable] = useState(false);
  const [dragId, setDragId] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const dragFrom = useRef<string>("");

  const reload = () =>
    api.tasks()
      .then((d) => { setTasks(d.tasks); setStages(d.stages); setEditable(d.editable); setErr(null); })
      .catch((e) => setErr(String(e)));

  useEffect(() => {
    reload();
    const t = window.setInterval(reload, 4000); // auto-follow Hermes' own stage changes
    return () => window.clearInterval(t);
  }, []);

  const drop = async (toStage: string) => {
    const id = dragId, from = dragFrom.current;
    setDragId(null);
    if (!id || from === toStage) return;
    setMsg(null);
    try {
      const r = await api.moveTask(id, toStage, from);
      setMsg({ text: r.message || "moved", ok: true });
      reload();
    } catch (e) {
      setMsg({ text: String(e).replace(/^Error:\s*/, "").replace(/^\/api\/tasks\/move → /, ""), ok: false });
    }
  };

  const byStage = (k: string) => tasks.filter((t) => t.stage === k);

  return (
    <div className="tasks">
      <section className="tasks-head card">
        <div>
          <span className="eyebrow">Mission board</span>
          <h1 className="display tasks-title">Every mission, <span className="ember">in motion.</span></h1>
          <p className="muted tasks-sub">
            The fleet's live board, straight from Hermes. Tasks appear when an agent creates or
            delegates work and move through the stages on their own. Drag a card to request a manual
            move — Hermes makes the ones its workflow allows.
          </p>
        </div>
        <button className="content-tool" onClick={reload}>Refresh</button>
      </section>

      {err && <div className="banner danger">Can't load tasks — {err}</div>}
      {msg && <div className={`task-toast mono ${msg.ok ? "ok" : "bad"}`}>{msg.text}</div>}

      <section className="board board-wide" style={{ gridTemplateColumns: `repeat(${Math.max(1, stages.length)}, minmax(148px, 1fr))` }}>
        {stages.map((col) => {
          const items = byStage(col.key);
          return (
            <div
              key={col.key}
              className={`column ${dragId ? "droppable" : ""}`}
              onDragOver={(e) => e.preventDefault()}
              onDrop={() => drop(col.key)}
            >
              <div className="column-head">
                <span className="mono column-label">{col.label}</span>
                <span className="mono tabular muted">{items.length}</span>
              </div>
              <div className="column-body">
                {items.map((t) => (
                  <div
                    key={t.id}
                    className={`task-card ${dragId === t.id ? "dragging" : ""}`}
                    draggable={editable}
                    onDragStart={() => { setDragId(t.id); dragFrom.current = t.stage; }}
                    onDragEnd={() => setDragId(null)}
                  >
                    <div className="task-top">
                      <span className={`status-chip st-${t.stage}`}>{t.status}</span>
                      {t.running && <span className="run-dot" title="running now" />}
                    </div>
                    <div className="task-title">{t.title}</div>
                    <div className="task-assignee mono">▸ {t.assignee || "unassigned"}</div>
                    {t.error && <div className="task-err mono">{t.error}</div>}
                  </div>
                ))}
                {items.length === 0 && <div className="column-empty mono">—</div>}
              </div>
            </div>
          );
        })}
      </section>

      {tasks.length === 0 && !err && (
        <p className="muted tasks-empty mono">
          No tasks on the board yet. When an agent schedules or delegates work, it appears here and
          moves through the stages on its own.
        </p>
      )}
    </div>
  );
}
