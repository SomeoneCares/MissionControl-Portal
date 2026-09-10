import { useEffect, useState } from "react";
import type { BoardTask } from "../types";
import { api } from "../api/client";

// Tasks — the operator's personal kanban, backed by the portal's own board.db.
// Fully interactive and identical in local and remote mode: this store is portal-owned.

const COLUMNS: { key: BoardTask["status"]; label: string }[] = [
  { key: "todo", label: "To do" },
  { key: "doing", label: "In progress" },
  { key: "done", label: "Done" },
];

const PRIORITIES: BoardTask["priority"][] = ["P1", "P2", "P3"];

export function Tasks() {
  const [tasks, setTasks] = useState<BoardTask[]>([]);
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState<BoardTask["priority"]>("P2");
  const [dragId, setDragId] = useState<string | null>(null);

  const reload = () => api.board.list().then((d) => setTasks(d.tasks));
  useEffect(() => void reload(), []);

  const create = async () => {
    if (!title.trim()) return;
    await api.board.create({ title: title.trim(), priority });
    setTitle("");
    setAdding(false);
    reload();
  };

  const move = async (id: string, status: BoardTask["status"]) => {
    setTasks((ts) => ts.map((t) => (t.id === id ? { ...t, status } : t))); // optimistic
    await api.board.update(id, { status });
    reload();
  };

  const remove = async (id: string) => {
    setTasks((ts) => ts.filter((t) => t.id !== id));
    await api.board.remove(id);
  };

  const counts = {
    todo: tasks.filter((t) => t.status === "todo").length,
    doing: tasks.filter((t) => t.status === "doing").length,
    done: tasks.filter((t) => t.status === "done").length,
  };

  return (
    <div className="tasks">
      <section className="tasks-head card">
        <div>
          <span className="eyebrow">Mission board</span>
          <h1 className="display tasks-title">Every mission, <span className="ember">in motion.</span></h1>
          <p className="muted tasks-sub">
            Your personal task board. Drag a card between columns, or use the arrows. Stored on the
            portal, not on Hermes.
          </p>
        </div>
        <button className="btn-primary" onClick={() => setAdding((v) => !v)}>
          {adding ? "Cancel" : "+ New mission"}
        </button>
      </section>

      {adding && (
        <section className="card add-row">
          <input
            className="add-input"
            placeholder="Mission title…"
            value={title}
            autoFocus
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && create()}
          />
          <select value={priority} onChange={(e) => setPriority(e.target.value as BoardTask["priority"])}>
            {PRIORITIES.map((p) => (
              <option key={p} value={p}>{p}</option>
            ))}
          </select>
          <button className="btn-primary" onClick={create}>Create</button>
        </section>
      )}

      <section className="board">
        {COLUMNS.map((col) => (
          <div
            key={col.key}
            className={`column ${dragId ? "droppable" : ""}`}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => dragId && move(dragId, col.key)}
          >
            <div className="column-head">
              <span className="mono column-label">{col.label}</span>
              <span className="mono tabular muted">{counts[col.key]}</span>
            </div>
            <div className="column-body">
              {tasks
                .filter((t) => t.status === col.key)
                .map((t) => (
                  <div
                    key={t.id}
                    className={`task-card ${dragId === t.id ? "dragging" : ""}`}
                    draggable
                    onDragStart={() => setDragId(t.id)}
                    onDragEnd={() => setDragId(null)}
                  >
                    <div className="task-top">
                      <span className={`prio prio-${t.priority}`}>{t.priority}</span>
                      <button className="task-del" onClick={() => remove(t.id)} aria-label="Delete">✕</button>
                    </div>
                    <div className="task-title">{t.title}</div>
                    <div className="task-move">
                      {col.key !== "todo" && (
                        <button onClick={() => move(t.id, prevCol(col.key))} aria-label="Move left">←</button>
                      )}
                      {col.key !== "done" && (
                        <button onClick={() => move(t.id, nextCol(col.key))} aria-label="Move right">→</button>
                      )}
                    </div>
                  </div>
                ))}
              {counts[col.key] === 0 && <div className="column-empty mono">nothing here</div>}
            </div>
          </div>
        ))}
      </section>
    </div>
  );
}

function nextCol(s: BoardTask["status"]): BoardTask["status"] {
  return s === "todo" ? "doing" : "done";
}
function prevCol(s: BoardTask["status"]): BoardTask["status"] {
  return s === "done" ? "doing" : "todo";
}
