"""Hermes kanban bridge — the real fleet task board.

Reads Hermes' shared task board (``~/.hermes/kanban.db``) live and read-only, and applies stage
changes through the ``hermes kanban`` CLI so every write goes through Hermes' own state machine
(claims, events, dispatch notifications) rather than a raw DB poke.

The board is an autonomous state machine: workers claim tasks to run them, a triage specifier
promotes and decomposes work, and terminal states are gated. So the portal reflects the board
faithfully and *attempts* manual transitions, surfacing Hermes' own accept/reject message.
"""
from __future__ import annotations

import os
import shutil
import sqlite3
import subprocess
from pathlib import Path
from typing import Optional


class KanbanError(RuntimeError):
    pass


# Hermes' canonical statuses (archived is hidden). Grouped into the board's visible stages.
STAGES: list[dict] = [
    {"key": "triage", "label": "Triage", "statuses": ["triage"]},
    {"key": "todo", "label": "To do", "statuses": ["todo", "scheduled", "ready"]},
    {"key": "running", "label": "Running", "statuses": ["running"]},
    {"key": "review", "label": "Review", "statuses": ["review"]},
    {"key": "blocked", "label": "Blocked", "statuses": ["blocked"]},
    {"key": "done", "label": "Done", "statuses": ["done"]},
]
_STATUS_TO_STAGE = {s: st["key"] for st in STAGES for s in st["statuses"]}
_OPEN_STATUSES = {"triage", "todo", "scheduled", "ready", "running", "review", "blocked"}


class KanbanSource:
    def __init__(self, db_path: Path, hermes_home: Optional[Path] = None):
        self.db = Path(db_path)
        self.home = Path(hermes_home) if hermes_home else None

    # -- reads (direct, read-only sqlite — cheap enough to poll) ----------
    def _rows(self) -> list[sqlite3.Row]:
        if not self.db.exists():
            return []
        try:
            conn = sqlite3.connect(f"file:{self.db}?mode=ro", uri=True, timeout=2.0)
            conn.row_factory = sqlite3.Row
            try:
                rows = conn.execute(
                    "SELECT id, title, assignee, status, priority, created_at, started_at, "
                    "completed_at, current_run_id, body, last_failure_error "
                    "FROM tasks WHERE status != 'archived' "
                    "ORDER BY priority DESC, created_at ASC"
                ).fetchall()
            finally:
                conn.close()
            return rows
        except sqlite3.Error:
            return []

    def tasks(self) -> list[dict]:
        out = []
        for r in self._rows():
            status = (r["status"] or "").strip()
            out.append({
                "id": r["id"],
                "title": r["title"] or "(untitled)",
                "assignee": (r["assignee"] or "").strip(),
                "status": status,
                "stage": _STATUS_TO_STAGE.get(status, "todo"),
                "priority": r["priority"] or 0,
                "created_at": r["created_at"],
                "started_at": r["started_at"],
                "completed_at": r["completed_at"],
                "running": bool(r["current_run_id"]) or status == "running",
                "error": r["last_failure_error"] or "",
            })
        return out

    def agent_states(self, tasks: Optional[list[dict]] = None) -> dict[str, str]:
        """Per-assignee state: EXECUTING (a task is running) > ASSIGNED (has an open task) > (idle)."""
        tasks = self.tasks() if tasks is None else tasks
        st: dict[str, str] = {}
        for t in tasks:
            a = (t.get("assignee") or "").strip().lower()
            if not a:
                continue
            if t.get("running"):
                st[a] = "EXECUTING"
            elif t.get("status") in _OPEN_STATUSES and st.get(a) != "EXECUTING":
                st[a] = "ASSIGNED"
        return st

    def stages(self) -> list[dict]:
        return [{"key": s["key"], "label": s["label"]} for s in STAGES]

    # -- writes (through the hermes CLI, so the state machine stays consistent) --
    def _hermes_bin(self) -> str:
        return shutil.which("hermes") or os.path.expanduser("~/.local/bin/hermes")

    def _run_cli(self, verb: str, task_id: str) -> str:
        env = dict(os.environ)
        env["PATH"] = os.path.expanduser("~/.local/bin") + os.pathsep + env.get("PATH", "")
        try:
            p = subprocess.run(
                [self._hermes_bin(), "kanban", verb, task_id],
                capture_output=True, text=True, timeout=30, env=env,
                cwd=str(self.home) if self.home else None)
        except FileNotFoundError:
            raise KanbanError("the hermes CLI is not available on this host")
        except subprocess.TimeoutExpired:
            raise KanbanError("hermes kanban timed out")
        out = (p.stdout or "").strip()
        err = (p.stderr or "").strip()
        if p.returncode != 0 or out.lower().startswith("cannot") or "error" in err.lower():
            raise KanbanError(out or err or f"hermes could not {verb} this task")
        return out or f"{verb} ok"

    def move(self, task_id: str, to_stage: str, from_stage: str = "") -> dict:
        """Attempt to move a task to a stage via the matching Hermes verb. Some transitions are
        worker-driven and Hermes will reject them — we surface its message verbatim."""
        task_id = (task_id or "").strip()
        if not task_id:
            raise KanbanError("task id required")
        to = (to_stage or "").strip().lower()
        frm = (from_stage or "").strip().lower()
        if to == frm:
            return {"ok": True, "message": "no change"}
        if to == "done":
            verb = "complete"
        elif to == "blocked":
            verb = "block"
        elif to == "review":
            verb = "request-review"
        elif to == "todo":
            if frm in ("blocked", "scheduled"):
                verb = "unblock"
            elif frm == "review":
                verb = "request-changes"
            else:
                raise KanbanError(
                    "Hermes promotes triage tasks itself once they're specified — "
                    "this move can't be forced by hand.")
        else:
            # running (workers claim tasks) and triage (Hermes decides) aren't hand-settable
            raise KanbanError(
                f"Hermes controls the '{to}' stage — it can't be set by hand. "
                "Workers claim tasks to run them; triage is decided by the specifier.")
        msg = self._run_cli(verb, task_id)
        return {"ok": True, "message": msg}
