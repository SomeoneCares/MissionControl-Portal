import { useEffect, useState } from "react";
import { api, type TaskDetail } from "./api/client";

// Click-through detail for a kanban task: its brief (body), run history, the worker's own
// comments (where blocks/progress show up), and any error — the "what is going on" view.
// Refreshes while open so a running task updates live.

function fmt(ts: number | null): string {
  if (!ts) return "—";
  // Hermes stores epoch seconds (sometimes as float); treat >1e12 as ms.
  const ms = ts > 1e12 ? ts : ts * 1000;
  try { return new Date(ms).toLocaleString(); } catch { return "—"; }
}

export function TaskDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const [d, setD] = useState<TaskDetail | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    if (!id) { setD(null); setMissing(false); return; }
    let live = true;
    const load = () =>
      api.taskDetail(id)
        .then((x) => { if (!live) return; if (x && x.id) { setD(x); setMissing(false); } else setMissing(true); })
        .catch(() => { if (live) setMissing(true); });
    load();
    const t = window.setInterval(load, 3000);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => { live = false; window.clearInterval(t); window.removeEventListener("keydown", onKey); };
  }, [id, onClose]);

  if (!id) return null;

  return (
    <div className="drawer-scrim" onClick={onClose}>
      <div className="drawer task-drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <span className={`status-chip st-${d?.stage || "todo"}`}>{d?.status || "…"}</span>
          {d?.running && <span className="run-dot" title="running now" />}
          <button className="drawer-x" onClick={onClose} aria-label="Close">✕</button>
        </div>

        {missing && !d && <p className="empty-block mono">Task not found (it may have been archived).</p>}
        {!d && !missing && <p className="mono muted pane-loading">loading…</p>}

        {d && (
          <>
            <h2 className="display drawer-title">{d.title}</h2>
            <div className="td-meta mono">
              <span>▸ {d.assignee || "unassigned"}</span>
              <span className="muted">·</span>
              <span className="muted">{d.id}</span>
            </div>

            <dl className="td-times mono">
              <div><dt>created</dt><dd>{fmt(d.created_at)}</dd></div>
              <div><dt>started</dt><dd>{fmt(d.started_at)}</dd></div>
              <div><dt>finished</dt><dd>{fmt(d.completed_at)}</dd></div>
            </dl>

            {d.error && <div className="td-error mono">⚠ {d.error}</div>}

            {d.runs.length > 0 && (
              <section className="td-section">
                <span className="eyebrow">Runs</span>
                {d.runs.map((r, i) => (
                  <div key={i} className="td-run">
                    <span className="mono td-run-head">{r.profile || "worker"} · {r.status}</span>
                    {r.summary && <div className="td-run-sum">{r.summary}</div>}
                    {r.error && <div className="td-run-err mono">{r.error}</div>}
                  </div>
                ))}
              </section>
            )}

            {d.comments.length > 0 && (
              <section className="td-section">
                <span className="eyebrow">Activity · {d.comments.length} comment{d.comments.length === 1 ? "" : "s"}</span>
                <ul className="td-comments">
                  {d.comments.map((c, i) => (
                    <li key={i}>
                      <div className="td-comment-head mono">
                        <span className="td-comment-author">{c.author || "worker"}</span>
                        <span className="muted">{fmt(c.at)}</span>
                      </div>
                      <div className="td-comment-body">{c.body}</div>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {d.body && (
              <section className="td-section">
                <span className="eyebrow">Brief</span>
                <pre className="td-body mono">{d.body}</pre>
              </section>
            )}

            {d.result && (
              <section className="td-section">
                <span className="eyebrow">Result</span>
                <pre className="td-body mono">{d.result}</pre>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
