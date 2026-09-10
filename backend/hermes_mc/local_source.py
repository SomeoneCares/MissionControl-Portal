"""Local data source — reads a Hermes host's own files and databases directly.

Used when the portal runs on the Hermes machine (mode ``local``). In mode ``remote`` the bridge
runs this exact module on the Hermes host and serves its output over HTTP; the portal never
changes how it consumes the result.

The governing rule: **the fleet is derived from what actually exists on disk**, never from a
hardcoded roster. Agents come from ``~/.hermes/profiles/*`` (plus an optional project registry);
run history, models and metrics come from real databases and ``/proc``. Where a source is empty,
the field is empty or zero — the front end renders an honest "nothing yet", it never invents.

Data sources (all read-only except where noted):

    ~/.hermes/profiles/<agent>/config.yaml   per-agent model, role, channel
    ~/.hermes/profiles/<agent>/SOUL.md        role/description fallback
    ~/.hermes/gateway_state.json              gateway + platform health
    ~/.hermes/agents/_shared/...              (Hermes writes agent-logs.db via a turn hook)
    <project>/agent-logs.db                   run history  (agent hooks write; we only read)
    ~/.hermes/state.db                        session token totals
    /proc/stat, /proc/meminfo, statvfs        host CPU / memory / disk

stdlib only.
"""
from __future__ import annotations

import os
import re
import sqlite3
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# ---------------------------------------------------------------------------
# small helpers
# ---------------------------------------------------------------------------

_PROFILE_NAME_RE = re.compile(r"[a-z0-9][a-z0-9_-]{0,63}")


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def _epoch_iso(v) -> str:
    """Hermes stores timestamps as epoch floats; normalise to ISO. Pass strings through."""
    if v is None:
        return ""
    if isinstance(v, str):
        return v
    try:
        return datetime.fromtimestamp(float(v), timezone.utc).isoformat()
    except (ValueError, OSError, OverflowError):
        return ""


def _ro_connect(path: Path) -> sqlite3.Connection:
    con = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=2.0)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA query_only=1")
    return con


def _initials(name: str, fallback: str) -> str:
    parts = [p for p in re.split(r"[-\s_]+", name) if p]
    ini = "".join(p[0] for p in parts[:2]) or fallback[:2]
    return ini.upper()[:3]


def _title(agent: str) -> str:
    return agent.replace("-", " ").replace("_", " ").title()


def _doc_title(path: Path) -> str:
    """First markdown heading, else a title made from the filename."""
    try:
        for line in path.read_text(encoding="utf-8", errors="replace").splitlines()[:20]:
            if line.lstrip().startswith("#"):
                return line.lstrip("# ").strip()[:100]
    except OSError:
        pass
    stem = re.sub(r"^\d{4}-\d{2}-\d{2}[_-]?", "", path.stem)
    return stem.replace("-", " ").replace("_", " ").strip().title() or "Untitled"


# ---------------------------------------------------------------------------
# the source
# ---------------------------------------------------------------------------

class LocalSource:
    """Reads one Hermes host. Construct with the resolved :class:`config.Config`."""

    def __init__(self, hermes_home: Path, project_dir: Path,
                 agent_logs_db: Optional[Path] = None):
        self.home = Path(hermes_home)
        self.project_dir = Path(project_dir)
        self.agent_logs_db = agent_logs_db or (self.project_dir / "agent-logs.db")

    # -- fleet roster (from real profiles) ---------------------------------

    def profile_names(self) -> list[str]:
        """Agent profiles that exist as directories under ~/.hermes/profiles."""
        names: list[str] = []
        proot = self.home / "profiles"
        if proot.is_dir():
            for child in sorted(proot.iterdir()):
                if child.is_dir() and _PROFILE_NAME_RE.fullmatch(child.name):
                    names.append(child.name)
        return names

    def _agent_dir(self, agent: str) -> Path:
        """Where an agent's config/SOUL live: the root Hermes home for the root ``default``
        agent (Hermes' name for it — verified via `hermes kanban assignees` and state.db
        session.profile_name), the profile directory otherwise."""
        if agent in ("default", "orchestrator"):
            return self.home
        return self.home / "profiles" / agent

    def _has_identity(self, directory: Path) -> bool:
        return (directory / "config.yaml").exists() or (directory / "SOUL.md").exists()

    def fleet_agents(self) -> list[str]:
        """The real fleet, derived from every source that shows an agent actually exists:
        the root orchestrator, profile directories, and any agent that appears in the run log
        (ephemeral agents included). Ordered orchestrator-first, then profiles, then log-only."""
        ordered: list[str] = []
        seen: set[str] = set()

        def add(name: str) -> None:
            if name and name not in seen:
                ordered.append(name)
                seen.add(name)

        log_agents = self._log_agent_names()
        # the root "default" agent (Hermes' own name for it) — when it has an identity on disk
        # or shows any activity in sessions/logs
        if self._has_identity(self.home) or "default" in log_agents or "orchestrator" in log_agents:
            add("default")
        for p in self.profile_names():
            add(p)
        for a in log_agents:              # ephemeral / log-only agents with real activity
            add(a)
        return ordered

    def _log_agent_names(self) -> list[str]:
        """Distinct agent names that show real activity, busiest first — derived from the same
        history source build_state uses (legacy agent-logs.db, else Hermes 0.21 sessions +
        kanban task_runs)."""
        counts: dict[str, int] = {}
        for r in self._history_rows():
            a = str(r.get("agent_name") or "").strip().lower()
            if a:
                counts[a] = counts.get(a, 0) + 1
        return [a for a, _ in sorted(counts.items(), key=lambda kv: (-kv[1], kv[0]))]

    def _read_profile_model(self, agent: str) -> tuple[str, str]:
        """(model, provider) from an agent's config.yaml. Empty strings when unset."""
        cfg = self._agent_dir(agent) / "config.yaml"
        model = provider = ""
        try:
            text = cfg.read_text(encoding="utf-8")
        except OSError:
            return model, provider
        in_model = False
        for line in text.splitlines():
            if re.match(r"^model\s*:\s*$", line):
                in_model = True
                continue
            if in_model and line and not line.startswith((" ", "\t")):
                in_model = False
            if in_model:
                m = re.match(r"^\s*default\s*:\s*(.+?)\s*$", line)
                if m:
                    model = m.group(1).strip().strip("\"'") or model
                m = re.match(r"^\s*provider\s*:\s*(.+?)\s*$", line)
                if m:
                    provider = m.group(1).strip().strip("\"'") or provider
            # top-level "model: x" one-liner
            m = re.match(r"^model\s*:\s*(\S.+?)\s*$", line)
            if m and not model:
                model = m.group(1).strip().strip("\"'")
        return model, provider

    def _read_profile_role(self, agent: str) -> str:
        """A human role/description: config `description:`, else first SOUL.md heading."""
        cfg = self._agent_dir(agent) / "config.yaml"
        try:
            for line in cfg.read_text(encoding="utf-8").splitlines():
                m = re.match(r"^\s*description\s*:\s*(.+?)\s*$", line)
                if m:
                    return m.group(1).strip().strip("\"'")
        except OSError:
            pass
        # Only a real markdown heading makes a good role. Profiles whose SOUL.md opens with
        # prompt prose (no heading) fall back to the agent name rather than showing the prompt.
        soul = self._agent_dir(agent) / "SOUL.md"
        try:
            for line in soul.read_text(encoding="utf-8").splitlines():
                if line.lstrip().startswith("#"):
                    s = re.sub(r"^SOUL\s*[—:-]\s*", "", line.lstrip("# ").strip(), flags=re.I)
                    if s:
                        return s[:80]
                    break
                if line.strip():
                    break  # first content line is prose, not a heading → no usable role
        except OSError:
            pass
        return ""

    # -- run history (agent-logs.db) ---------------------------------------

    def _log_rows(self, limit: Optional[int] = None) -> list[dict]:
        """Run history as {agent_name, task_description, model_used, status, created_at} rows.

        Source order: a legacy ``agent-logs.db`` (older Hermes / the .177 server) if present;
        otherwise Hermes 0.21's real stores — interactive/API runs from ``state.db`` sessions
        (all attributed to the root ``default`` agent) plus delegated per-specialist executions
        from ``kanban.db`` task_runs. Verified against the live schemas + the /api/sessions API,
        which omits profile_name (hence the DB read for per-agent attribution)."""
        return self._history_rows(limit)

    def _history_rows(self, limit: Optional[int] = None) -> list[dict]:
        if self.agent_logs_db.exists():
            rows = self._legacy_log_rows()
        else:
            rows = self._session_rows() + self._taskrun_rows()
            rows.sort(key=lambda r: r.get("created_at") or "", reverse=True)
        return rows[:limit] if limit is not None else rows

    def _legacy_log_rows(self) -> list[dict]:
        try:
            with _ro_connect(self.agent_logs_db) as con:
                return [dict(r) for r in con.execute(
                    "SELECT agent_name, task_description, model_used, status, created_at "
                    "FROM agent_logs ORDER BY created_at DESC").fetchall()]
        except sqlite3.Error:
            return []

    def _session_rows(self) -> list[dict]:
        """Interactive / API / desktop runs from state.db sessions → run-like rows."""
        state_db = self.home / "state.db"
        if not state_db.exists():
            return []
        try:
            with _ro_connect(state_db) as con:
                cols = {r[1] for r in con.execute("PRAGMA table_info(sessions)")}
                if "profile_name" not in cols:
                    return []
                sel = con.execute(
                    "SELECT profile_name, model, source, message_count, ended_at, end_reason, "
                    "last_activity_description, title, started_at "
                    "FROM sessions WHERE COALESCE(archived,0)=0 ORDER BY started_at DESC").fetchall()
        except sqlite3.Error:
            return []
        out = []
        for r in sel:
            end = str(r["end_reason"] or "").strip().lower()
            status = ("failed" if end in ("error", "failed", "crashed")
                      else ("completed" if r["ended_at"] else "active"))
            src = str(r["source"] or "").strip()
            desc = str(r["last_activity_description"] or r["title"] or (f"{src} session" if src else "session")).strip()
            out.append({
                "agent_name": (str(r["profile_name"] or "default").strip().lower() or "default"),
                "task_description": desc[:200],
                "model_used": str(r["model"] or "").strip(),
                "status": status,
                "created_at": _epoch_iso(r["started_at"]),
            })
        return out

    def _taskrun_rows(self) -> list[dict]:
        """Delegated per-specialist executions from kanban.db task_runs → run-like rows."""
        kdb = self.home / "kanban.db"
        if not kdb.exists():
            return []
        try:
            with _ro_connect(kdb) as con:
                sel = con.execute(
                    "SELECT tr.profile, tr.status, tr.outcome, tr.summary, tr.started_at, t.title "
                    "FROM task_runs tr LEFT JOIN tasks t ON t.id = tr.task_id "
                    "ORDER BY tr.started_at DESC").fetchall()
        except sqlite3.Error:
            return []
        out = []
        for r in sel:
            agent = str(r["profile"] or "").strip().lower()
            if not agent:
                continue
            st = str(r["status"] or r["outcome"] or "").strip().lower()
            status = ("completed" if st in ("completed", "done", "success", "ok")
                      else ("failed" if ("fail" in st or "error" in st) else (st or "running")))
            out.append({
                "agent_name": agent,
                "task_description": str(r["summary"] or r["title"] or "").strip()[:200],
                "model_used": "",
                "status": status,
                "created_at": _epoch_iso(r["started_at"]),
            })
        return out

    def _model_usage_totals(self) -> tuple[list[dict], int, int]:
        """(model_usage rows, input_tokens, output_tokens) from state.db session_model_usage —
        Hermes 0.21's authoritative per-model usage. Empty tuple when the table is absent."""
        state_db = self.home / "state.db"
        if not state_db.exists():
            return [], 0, 0
        try:
            with _ro_connect(state_db) as con:
                tables = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
                if "session_model_usage" not in tables:
                    return [], 0, 0
                sel = con.execute(
                    "SELECT model, COUNT(DISTINCT session_id) sess, "
                    "COALESCE(SUM(input_tokens),0) itok, COALESCE(SUM(output_tokens),0) otok, "
                    "COALESCE(SUM(api_call_count),0) calls "
                    "FROM session_model_usage GROUP BY model").fetchall()
        except sqlite3.Error:
            return [], 0, 0
        total_calls = sum(int(r["calls"]) for r in sel) or 0
        tin = tout = 0
        usage = []
        for r in sel:
            tin += int(r["itok"]); tout += int(r["otok"])
            usage.append({"name": str(r["model"] or ""), "count": int(r["calls"]),
                          "pct": round(int(r["calls"]) / total_calls * 100) if total_calls else 0})
        usage.sort(key=lambda u: (-u["count"], u["name"]))
        return usage, tin, tout

    # -- gateway / platform health -----------------------------------------

    def health(self) -> dict:
        import json
        path = self.home / "gateway_state.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return {"gateway_state": "unknown", "platforms": {}}
        platforms = data.get("platforms", {})
        # normalise to {name: state-string}
        norm = {}
        for name, info in (platforms.items() if isinstance(platforms, dict) else []):
            if isinstance(info, dict):
                norm[name] = info.get("state", "unknown")
            else:
                norm[name] = str(info)
        return {
            "gateway_state": data.get("gateway_state", "unknown"),
            "active_agents": data.get("active_agents", 0),
            "platforms": norm,
            "version": data.get("code_version", ""),
            "updated_at": data.get("updated_at", ""),
        }

    # -- host resources -----------------------------------------------------

    def vps(self) -> dict:
        return {
            "cpu_pct": _cpu_percent(),
            "mem_pct": _mem_percent(),
            "disk_pct": _disk_percent(self.home),
        }

    # -- sessions / tokens --------------------------------------------------

    def sessions(self) -> dict:
        """Token totals across sessions. Uses Hermes 0.21's ``session_model_usage`` for input/
        output tokens and ``sessions`` for the message count."""
        state_db = self.home / "state.db"
        totals = {"input": 0, "output": 0, "messages": 0}
        if not state_db.exists():
            return {"totals": totals}
        _, tin, tout = self._model_usage_totals()
        totals["input"], totals["output"] = tin, tout
        try:
            with _ro_connect(state_db) as con:
                tables = {r[0] for r in con.execute(
                    "SELECT name FROM sqlite_master WHERE type='table'")}
                if "sessions" in tables:
                    cols = {r[1] for r in con.execute("PRAGMA table_info(sessions)")}
                    if "message_count" in cols:
                        row = con.execute(
                            "SELECT COALESCE(SUM(message_count),0) FROM sessions "
                            "WHERE COALESCE(archived,0)=0").fetchone()
                        totals["messages"] = int(row[0] or 0)
        except sqlite3.Error:
            pass
        return {"totals": totals}

    # -- scheduled jobs (Hermes cron) --------------------------------------

    def cron_jobs(self) -> list[dict]:
        """Scheduled jobs from ~/.hermes/cron/jobs.json, normalised for display."""
        import json
        path = self.home / "cron" / "jobs.json"
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        raw = data.get("jobs", data) if isinstance(data, dict) else data
        jobs = [j for j in raw if isinstance(j, dict)] if isinstance(raw, list) else []
        out = []
        for j in jobs:
            enabled = bool(j.get("enabled"))
            sched_raw = j.get("schedule") or j.get("cron") or ""
            if isinstance(sched_raw, dict):
                sched = sched_raw.get("display") or sched_raw.get("expr") or sched_raw.get("kind") or ""
            else:
                sched = sched_raw
            model = j.get("model") or (j.get("model_options") or {}).get("model") or ""
            out.append({
                "id": str(j.get("id") or ""),
                "name": str(j.get("name") or j.get("id") or "Untitled job"),
                "enabled": enabled,
                "state": str(j.get("state") or ("scheduled" if enabled else "paused")),
                "schedule": str(sched),
                "next_run_at": j.get("next_run_at"),
                "last_status": j.get("last_status"),
                "last_error": j.get("last_error") or j.get("last_delivery_error"),
                "deliver": j.get("deliver"),
                "model": str(model),
                "prompt": str(j.get("prompt") or ""),
            })
        out.sort(key=lambda j: (j["enabled"] is not True, j.get("next_run_at") or "9999", j["name"]))
        return out

    # -- content library (agent output) ------------------------------------

    def content_docs(self, content_dir: Path) -> list[dict]:
        """Every markdown document under the content directory, grouped by author agent."""
        root = Path(content_dir)
        if not root.is_dir():
            return []
        docs = []
        for md in root.rglob("*.md"):
            try:
                rel = md.relative_to(root)
            except ValueError:
                continue
            agent = rel.parts[0] if len(rel.parts) > 1 else ""
            try:
                st = md.stat()
                title = _doc_title(md)
            except OSError:
                continue
            docs.append({
                "agent": agent,
                "filename": md.name,
                "path": str(rel).replace("\\", "/"),
                "title": title,
                "modified_at": datetime.fromtimestamp(st.st_mtime, timezone.utc).isoformat(),
                "size": st.st_size,
            })
        docs.sort(key=lambda d: d["modified_at"], reverse=True)
        return docs

    def content_read(self, content_dir: Path, rel_path: str) -> dict:
        """Read one content document by its path relative to the content directory."""
        root = Path(content_dir).resolve()
        target = (root / rel_path).resolve()
        if root not in target.parents or target.suffix.lower() != ".md":
            raise ValueError("invalid content path")
        if not target.is_file():
            return {"path": rel_path, "exists": False, "content": ""}
        return {"path": rel_path, "exists": True,
                "content": target.read_text(encoding="utf-8", errors="replace")}

    # -- the assembled state payload ---------------------------------------

    def build_state(self) -> dict:
        rows = self._log_rows(None)
        total = len(rows)

        names = self.fleet_agents()
        # count runs / successes / models per agent from real logs
        counts = {a: 0 for a in names}
        completed = {a: 0 for a in names}
        latest: dict[str, dict] = {}
        model_counts: dict[str, int] = {}
        completed_total = failed_total = 0

        for r in rows:
            agent = str(r.get("agent_name") or "").strip().lower()
            status = str(r.get("status") or "").strip().lower()
            model = str(r.get("model_used") or "").strip()
            if agent in counts:
                counts[agent] += 1
                if status == "completed":
                    completed[agent] += 1
                latest.setdefault(agent, r)
            if status == "completed":
                completed_total += 1
            elif status == "failed":
                failed_total += 1
            if model:
                model_counts[model] = model_counts.get(model, 0) + 1

        fleet = []
        for i, agent in enumerate(names):
            n = counts.get(agent, 0)
            model, provider = self._read_profile_model(agent)
            role = self._read_profile_role(agent)
            fleet.append({
                "agent": agent,
                "code": f"A-{i:02d}",
                "initials": _initials(_title(agent), agent),
                "name": _title(agent),
                "role": role,
                "defaultModel": model,
                "provider": provider,
                "tasksToday": n,
                "success": round(completed.get(agent, 0) / n * 100, 1) if n else 100.0,
                "share": round(n / total * 100) if total else 0,
                "state": "IDLE",
                "task": (latest.get(agent, {}).get("task_description") or ""),
            })

        # Model ledger + token totals: prefer Hermes 0.21's authoritative session_model_usage
        # (real per-model API-call counts and tokens); fall back to counting from the rows.
        mu_rows, mu_in, mu_out = self._model_usage_totals()
        if mu_rows:
            model_usage = mu_rows
            model_names = [u["name"] for u in mu_rows]
        else:
            model_usage = [
                {"name": m, "count": c, "pct": round(c / total * 100) if total else 0}
                for m, c in sorted(model_counts.items(), key=lambda kv: (-kv[1], kv[0]))
            ]
            model_names = sorted(model_counts)
        recent = [{
            "agent": str(r.get("agent_name") or "").upper()[:4],
            "task": r.get("task_description") or "",
            "time": r.get("created_at") or "",
            "model": r.get("model_used") or "",
            "status": r.get("status") or "",
        } for r in rows[:25]]

        return {
            "fleet": fleet,
            "models": [{"id": m, "label": m} for m in model_names],
            "model_usage": model_usage,
            "routing": {
                "total": total,
                "models": len(model_usage),
                # premium/fast split needs a routing map; report honestly until wired.
                "premium_calls": total,
                "fast_calls": 0,
                "offload_pct": 0,
            },
            "agentlogs": recent,
            "agentlogs_stats": {"total": total, "completed": completed_total, "failed": failed_total},
            "health": self.health(),
            "vps": self.vps(),
            "sessions": self.sessions(),
            "working_agents": [],
            "generated_at": _now_iso(),
        }


# ---------------------------------------------------------------------------
# /proc + statvfs metrics (module-level, cache CPU sample between calls)
# ---------------------------------------------------------------------------

_cpu_last = {"idle": 0, "total": 0}


def _cpu_percent() -> float:
    try:
        parts = Path("/proc/stat").read_text().splitlines()[0].split()[1:]
        vals = [int(x) for x in parts]
        idle = vals[3] + (vals[4] if len(vals) > 4 else 0)
        total = sum(vals)
        di = idle - _cpu_last["idle"]
        dt = total - _cpu_last["total"]
        _cpu_last["idle"], _cpu_last["total"] = idle, total
        if dt <= 0:
            return 0.0
        return round((1 - di / dt) * 100, 1)
    except (OSError, ValueError, IndexError):
        return 0.0


def _mem_percent() -> float:
    try:
        info = {}
        for line in Path("/proc/meminfo").read_text().splitlines():
            k, _, v = line.partition(":")
            info[k.strip()] = int(v.strip().split()[0])
        total = info.get("MemTotal", 0)
        avail = info.get("MemAvailable", 0)
        if total <= 0:
            return 0.0
        return round((1 - avail / total) * 100, 1)
    except (OSError, ValueError):
        return 0.0


def _disk_percent(path: Path) -> float:
    try:
        st = os.statvfs(str(path))
        total = st.f_blocks * st.f_frsize
        free = st.f_bavail * st.f_frsize
        if total <= 0:
            return 0.0
        return round((1 - free / total) * 100, 1)
    except OSError:
        return 0.0
