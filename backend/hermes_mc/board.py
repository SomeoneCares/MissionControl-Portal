"""Task board — the portal's own store, and the only database the portal writes.

Kept deliberately separate from every Hermes source: the board is the operator's personal
kanban, not agent data, so it is safe to write and it works identically in local and remote
mode. Lives at ``<project_dir>/board.db``.
"""
from __future__ import annotations

import sqlite3
import time
import uuid
from pathlib import Path

_VALID_STATUS = ("todo", "doing", "done")
_VALID_PRIORITY = ("P1", "P2", "P3")


class Board:
    def __init__(self, db_path: Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._init()

    def _con(self) -> sqlite3.Connection:
        con = sqlite3.connect(str(self.path), timeout=5.0)
        con.row_factory = sqlite3.Row
        return con

    def _init(self) -> None:
        with self._con() as con:
            con.execute("""
                CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'todo',
                    priority TEXT NOT NULL DEFAULT 'P2',
                    notes TEXT DEFAULT '',
                    created_at REAL NOT NULL,
                    updated_at REAL NOT NULL
                )
            """)

    def list(self) -> list[dict]:
        with self._con() as con:
            return [dict(r) for r in con.execute(
                "SELECT * FROM tasks ORDER BY updated_at DESC")]

    def create(self, title: str, priority: str = "P2", status: str = "todo",
               notes: str = "") -> dict:
        title = (title or "").strip()
        if not title:
            raise ValueError("title is required")
        priority = priority if priority in _VALID_PRIORITY else "P2"
        status = status if status in _VALID_STATUS else "todo"
        now = time.time()
        tid = uuid.uuid4().hex[:12]
        with self._con() as con:
            con.execute(
                "INSERT INTO tasks(id,title,status,priority,notes,created_at,updated_at) "
                "VALUES(?,?,?,?,?,?,?)",
                (tid, title, status, priority, notes, now, now))
        return self.get(tid)

    def update(self, task_id: str, **fields) -> dict:
        allowed = {}
        if "title" in fields and str(fields["title"]).strip():
            allowed["title"] = str(fields["title"]).strip()
        if fields.get("status") in _VALID_STATUS:
            allowed["status"] = fields["status"]
        if fields.get("priority") in _VALID_PRIORITY:
            allowed["priority"] = fields["priority"]
        if "notes" in fields:
            allowed["notes"] = str(fields["notes"])
        if not allowed:
            return self.get(task_id)
        allowed["updated_at"] = time.time()
        sets = ", ".join(f"{k}=?" for k in allowed)
        with self._con() as con:
            con.execute(f"UPDATE tasks SET {sets} WHERE id=?",
                        (*allowed.values(), task_id))
        return self.get(task_id)

    def delete(self, task_id: str) -> bool:
        with self._con() as con:
            cur = con.execute("DELETE FROM tasks WHERE id=?", (task_id,))
            return cur.rowcount > 0

    def get(self, task_id: str) -> dict:
        with self._con() as con:
            row = con.execute("SELECT * FROM tasks WHERE id=?", (task_id,)).fetchone()
            return dict(row) if row else {}
