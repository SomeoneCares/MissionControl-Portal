"""HTTP server for Hermes Mission Control.

stdlib ``http.server`` — no framework, no dependency to install. Serves:

    GET  /api/health          liveness + resolved mode (no secrets)
    GET  /api/state           the full state payload (real data)
    GET  /api/capabilities    the gateway feature manifest (drives per-host UI)
    GET  /events              Server-Sent Events stream of state (live updates)
    GET  /api/board           the task board
    POST /api/board           create a task           {title, priority?, status?}
    POST /api/board/update     update a task           {id, ...}
    POST /api/board/delete     delete a task           {id}
    GET  /  and static assets  the built front end (frontend/dist)

The server owns a :class:`DataProvider` that abstracts local vs remote sourcing, so the request
handlers never care which mode they run in.
"""
from __future__ import annotations

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs, quote

from . import config as config_mod
from .agent_admin import AgentAdmin, AdminError
from .board import Board
from .content import ContentStore, ContentError
from .kanban import KanbanSource, KanbanError
from .fleets import FleetRegistry
from .gateway import GatewayClient, GatewayError
from .local_source import LocalSource

STATE_TTL = 3.0          # seconds; state is volatile but not free to build
SSE_INTERVAL = 4.0       # seconds between pushes on /events


class DataProvider:
    """Abstracts where state comes from. Local mode reads on-box; remote calls the bridge."""

    def __init__(self, cfg: config_mod.Config):
        self.cfg = cfg
        self.board = Board(cfg.project_dir / "board.db")
        self.gateway = GatewayClient(cfg.gateway_url, cfg.gateway_key) if cfg.gateway_url else None
        self._local = (
            LocalSource(cfg.hermes_home, cfg.project_dir, cfg.agent_logs_db)
            if cfg.is_local else None
        )
        # admin (model + file editing) is local-mode only; the gateway API is read-only for config
        self.admin = AgentAdmin(cfg.hermes_home) if cfg.is_local else None
        self.content_store = ContentStore(cfg.content_dir) if (cfg.is_local and cfg.content_dir) else None
        self.kanban = KanbanSource(cfg.kanban_db, cfg.hermes_home) if (cfg.is_local and cfg.kanban_db) else None
        self._cache: dict = {"at": 0.0, "data": None}
        self._chat_routes: dict | None = None   # cached per-agent route resolution
        self._working: set[str] = set()          # agents with an in-flight run right now

    def capabilities(self) -> dict:
        if not self.gateway:
            return {}
        try:
            return self.gateway.capabilities()
        except GatewayError:
            return {}

    def toolsets(self) -> list[dict]:
        if not self.gateway:
            return []
        try:
            return self.gateway.toolsets()
        except GatewayError:
            return []

    def cron_jobs(self) -> list[dict]:
        if self._local:
            return self._local.cron_jobs()
        return self._remote_list("/schedule", "jobs")

    def content_docs(self) -> list[dict]:
        if self._local and self.cfg.content_dir:
            return self._local.content_docs(self.cfg.content_dir)
        return self._remote_list("/content", "docs")

    def content_read(self, rel_path: str) -> dict:
        if self._local and self.cfg.content_dir:
            return self._local.content_read(self.cfg.content_dir, rel_path)
        data = self._bridge_get(f"/content/read?path={quote(rel_path)}")
        return data if isinstance(data, dict) else {"path": rel_path, "exists": False, "content": ""}

    def content_dir_info(self) -> dict:
        """Describe the content library folder for the Settings panel."""
        default = str((self.cfg.project_dir / "content").expanduser())
        p = self.cfg.content_dir
        editable = bool(self.cfg.is_local)
        if not p:
            return {"path": None, "editable": False, "default": default,
                    "reason": "Content lives on the Hermes host in remote mode."}
        p = Path(p)
        exists = p.is_dir()
        try:
            docs = sum(1 for _ in p.rglob("*.md")) if exists else 0
        except OSError:
            docs = 0
        return {
            "path": str(p), "exists": exists,
            "writable": exists and os.access(p, os.W_OK),
            "docs": docs, "default": default, "editable": editable,
            "env_locked": bool(os.environ.get("CONTENT_DIR", "").strip()),
        }

    def set_content_dir(self, raw: str) -> dict:
        """Point the content library at a new folder, creating it if needed, and persist it."""
        if not self.cfg.is_local:
            raise ContentError("the content folder is set on the Hermes host in remote mode")
        if os.environ.get("CONTENT_DIR", "").strip():
            raise ContentError("CONTENT_DIR is set in the environment; unset it to change the folder here")
        raw = (raw or "").strip()
        if not raw:
            raise ContentError("provide a folder path")
        path = Path(raw).expanduser()
        if not path.is_absolute():
            raise ContentError("use an absolute path")
        try:
            path.mkdir(parents=True, exist_ok=True)
        except OSError as e:
            raise ContentError(f"cannot create that folder: {e}")
        if not os.access(path, os.W_OK):
            raise ContentError("that folder is not writable by the portal")
        config_mod.write_portal_settings(self.cfg.project_dir, {"content_dir": str(path)})
        self.cfg.content_dir = path
        self.content_store = ContentStore(path)
        return self.content_dir_info()

    def fleet_tasks(self) -> dict:
        if self.kanban is not None:
            tasks = self.kanban.tasks()
            return {"tasks": tasks, "stages": self.kanban.stages(), "editable": True}
        # remote: read whatever the bridge folded into state
        data = self._build()
        return {"tasks": data.get("fleet_tasks", []),
                "stages": data.get("task_stages", []), "editable": False}

    def move_task(self, task_id: str, to_stage: str, from_stage: str = "") -> dict:
        if self.kanban is None:
            raise KanbanError("task control is available in local mode only")
        return self.kanban.move(task_id, to_stage, from_stage)

    def _bridge_get(self, path: str):
        import urllib.request
        try:
            req = urllib.request.Request(
                f"{self.cfg.bridge_url}{path}",
                headers={"Authorization": f"Bearer {self.cfg.bridge_key}", "Accept": "application/json"})
            with urllib.request.urlopen(req, timeout=10.0) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception:  # noqa: BLE001
            return None

    def _remote_list(self, path: str, key: str) -> list:
        data = self._bridge_get(path)
        return data.get(key, []) if isinstance(data, dict) else []

    def stop_run(self, run_id: str, agent: str | None) -> dict:
        if not self.gateway or not run_id:
            return {"ok": False}
        try:
            return self.gateway.run_stop(run_id, profile=self.chat_route(agent))
        except GatewayError as e:
            return {"ok": False, "error": str(e)}

    def steer_run(self, run_id: str, text: str, agent: str | None) -> dict:
        if not self.gateway or not run_id:
            return {"ok": False}
        try:
            return self.gateway.run_steer(run_id, text, profile=self.chat_route(agent))
        except GatewayError as e:
            return {"ok": False, "error": str(e)}

    def skills(self) -> list[dict]:
        if not self.gateway:
            return []
        try:
            return self.gateway.skills()
        except GatewayError:
            return []

    def _ensure_chat_routes(self) -> dict:
        """Resolve, once, how to reach each agent: 'prefix' (served at /p/<agent>/ under
        multiplexing) or 'home' (the gateway's default profile, reached at bare /v1/). Any
        'prefix' hit means multiplexing is on."""
        if self._chat_routes is not None:
            return self._chat_routes
        routes: dict[str, str] = {}
        multiplex = False
        if self.gateway:
            for a in (x["agent"] for x in self.state().get("fleet", [])):
                if self.gateway.profile_reachable(a):
                    routes[a] = "prefix"
                    multiplex = True
                else:
                    routes[a] = "home"   # not served under /p/ → the default profile (bare /v1/)
        self._chat_routes = {"multiplex": multiplex, "routes": routes}
        return self._chat_routes

    def mark_working(self, agent: str, working: bool) -> None:
        if working:
            self._working.add(agent)
        else:
            self._working.discard(agent)
        self._cache = {"at": 0.0, "data": None}   # force fresh state so live status shows at once

    def chat_route(self, agent: str | None) -> str | None:
        """The profile arg for the gateway client: the agent name when it is served under a
        prefix, otherwise None (bare /v1/ — the default profile)."""
        if not agent:
            return None
        routes = self._ensure_chat_routes()["routes"]
        return agent if routes.get(agent) == "prefix" else None

    def chat_agents(self) -> dict:
        """Which agents can be chatted with. Multiplexing on → every fleet profile is
        addressable; off → only the gateway's single default profile."""
        if not self.gateway:
            return {"gateway": False, "multiplex": False, "agents": []}
        info = self._ensure_chat_routes()
        return {
            "gateway": True,
            "multiplex": info["multiplex"],
            "agents": [a["agent"] for a in self.state().get("fleet", [])],
        }

    def _build(self) -> dict:
        if self._local is not None:
            data = self._local.build_state()
        else:
            data = self._remote_state()
        # fleet tasks + per-agent state from Hermes' real kanban board (local mode)
        agent_state: dict[str, str] = {}
        if self.kanban is not None:
            try:
                tasks = self.kanban.tasks()
                data["fleet_tasks"] = tasks
                data["task_stages"] = self.kanban.stages()
                agent_state = self.kanban.agent_states(tasks)
            except Exception:
                data.setdefault("fleet_tasks", [])
        else:
            # remote mode: tasks/stages come through the bridge /state if present
            data.setdefault("fleet_tasks", data.get("fleet_tasks", []))
            for t in data.get("fleet_tasks", []):
                a = (t.get("assignee") or "").strip().lower()
                if not a:
                    continue
                if t.get("running") or t.get("status") == "running":
                    agent_state[a] = "EXECUTING"
                elif agent_state.get(a) != "EXECUTING":
                    agent_state[a] = "ASSIGNED"
        # apply the three states: ASSIGNED / EXECUTING from the board, then the portal's own
        # in-flight chat runs also count as EXECUTING (live for the Office etc.)
        for a in data.get("fleet", []):
            code = a.get("agent")
            s = agent_state.get((code or "").lower())
            if s:
                a["state"] = s
        if self._working:
            data["working_agents"] = sorted(set(data.get("working_agents", [])) | self._working)
            for a in data.get("fleet", []):
                if a.get("agent") in self._working:
                    a["state"] = "EXECUTING"
        # board is always portal-owned
        tasks = self.board.list()
        data["board"] = [{
            "id": t["id"], "title": t["title"],
            "status": t["status"], "priority": t["priority"],
        } for t in tasks]
        # fold gateway health into the payload when reachable
        if self.gateway:
            h = self.gateway.health()
            data.setdefault("health", {})["gateway_reachable"] = h.ok
            data["health"]["gateway_latency_ms"] = h.latency_ms
        return data

    def _remote_state(self) -> dict:
        """Remote mode: fetch the assembled state from the bridge on the Hermes host."""
        data = self._bridge_get("/state")
        if not isinstance(data, dict):
            return {"fleet": [], "health": {"gateway_state": "bridge unreachable", "platforms": {}},
                    "vps": {"cpu_pct": 0, "mem_pct": 0, "disk_pct": 0}, "agentlogs": [],
                    "agentlogs_stats": {"total": 0, "completed": 0, "failed": 0},
                    "routing": {"total": 0, "models": 0, "premium_calls": 0, "fast_calls": 0, "offload_pct": 0},
                    "models": [], "model_usage": [], "sessions": {"totals": {"input": 0, "output": 0, "messages": 0}},
                    "working_agents": [], "generated_at": ""}
        return data

    def state(self, *, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and self._cache["data"] is not None and now - self._cache["at"] < STATE_TTL:
            return self._cache["data"]
        data = self._build()
        self._cache = {"at": now, "data": data}
        return data


class Handler(BaseHTTPRequestHandler):
    provider: DataProvider = None   # per-request, resolved from the selected fleet
    registry: FleetRegistry = None
    dist_dir: Path = None

    server_version = "HermesMC/0.1"

    def _fleet_id(self) -> str:
        q = parse_qs(urlparse(self.path).query).get("fleet", [""])[0]
        return q or self.headers.get("X-Fleet") or "primary"

    # -- helpers ----------------------------------------------------------

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return {}

    def log_message(self, fmt, *args):  # quieter default logging
        return

    # -- routing ----------------------------------------------------------

    def do_GET(self):
        path = urlparse(self.path).path
        if self.registry is not None:
            self.provider = self.registry.provider(self._fleet_id())
        if path == "/api/fleets":
            return self._json({"fleets": self.registry.list(), "current": self._fleet_id()})
        if path == "/api/health":
            h = self.provider.gateway.health() if self.provider.gateway else None
            return self._json({
                "ok": True,
                **self.provider.cfg.public(),
                "gateway": {"ok": h.ok, "latency_ms": h.latency_ms, "version": h.version} if h else None,
            })
        if path == "/api/capabilities":
            return self._json(self.provider.capabilities())
        if path == "/api/toolsets":
            return self._json({"data": self.provider.toolsets()})
        if path == "/api/skills":
            return self._json({"data": self.provider.skills()})
        if path == "/api/chat/agents":
            return self._json(self.provider.chat_agents())
        if path == "/api/schedule":
            return self._json({"jobs": self.provider.cron_jobs()})
        if path == "/api/tasks":
            return self._json(self.provider.fleet_tasks())
        if path == "/api/content":
            return self._json({"docs": self.provider.content_docs()})
        if path == "/api/content/dir":
            return self._json(self.provider.content_dir_info())
        if path == "/api/content/read":
            rel = parse_qs(urlparse(self.path).query).get("path", [""])[0]
            try:
                return self._json(self.provider.content_read(rel))
            except ValueError as e:
                return self._json({"error": str(e)}, status=400)
        if path in ("/api/content/download", "/api/content/word"):
            cs = self.provider.content_store
            if not cs:
                return self._json({"error": "content editing is local-mode only"}, status=403)
            rel = parse_qs(urlparse(self.path).query).get("path", [""])[0]
            try:
                if path == "/api/content/word":
                    data, fname = cs.to_docx(rel)
                    ctype = "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                else:
                    data, fname = cs.raw(rel)
                    ctype = "text/markdown; charset=utf-8"
            except ContentError as e:
                return self._json({"error": str(e)}, status=400)
            self.send_response(200)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Disposition", f'attachment; filename="{fname}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if path == "/api/models":
            if not self.provider.admin:
                return self._json({"models": [], "editable": False})
            return self._json({"models": self.provider.admin.list_models(), "editable": True})
        if path == "/api/agents/files":
            return self._admin_read(lambda a: {"files": self.provider.admin.list_files(a)})
        if path == "/api/agents/file":
            qs = parse_qs(urlparse(self.path).query)
            name = (qs.get("name") or [""])[0]
            return self._admin_read(lambda a: self.provider.admin.read_file(a, name))
        if path == "/api/agents/skills":
            return self._admin_read(lambda a: self.provider.admin.list_skills(a))
        if path == "/api/state":
            force = (parse_qs(urlparse(self.path).query).get("force") or [""])[0] in ("1", "true", "yes")
            return self._json(self.provider.state(force=force))
        if path == "/api/board":
            return self._json({"tasks": self.provider.board.list()})
        if path == "/events":
            return self._sse()
        return self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        if self.registry is not None:
            self.provider = self.registry.provider(self._fleet_id())
        if path == "/api/fleets":
            return self._json(self.registry.add(body).public())
        if path == "/api/fleets/remove":
            return self._json({"removed": self.registry.remove(body.get("id", ""))})
        try:
            if path == "/api/board":
                return self._json(self.provider.board.create(
                    body.get("title", ""), body.get("priority", "P2"),
                    body.get("status", "todo"), body.get("notes", "")))
            if path == "/api/board/update":
                return self._json(self.provider.board.update(body.get("id", ""), **body))
            if path == "/api/board/delete":
                return self._json({"deleted": self.provider.board.delete(body.get("id", ""))})
            if path == "/api/chat":
                return self._chat_stream(body)
            if path == "/api/runs/stop":
                return self._json(self.provider.stop_run(body.get("run", ""), body.get("agent")))
            if path == "/api/runs/steer":
                return self._json(self.provider.steer_run(
                    body.get("run", ""), body.get("text", ""), body.get("agent")))
            if path == "/api/runs/approval":
                gw = self.provider.gateway
                if not gw:
                    return self._json({"ok": False}, status=503)
                try:
                    prof = self.provider.chat_route(body.get("agent"))
                    res = gw._request("POST", gw._p(prof, f"/v1/runs/{body.get('run','')}/approval"),
                                      body={"choice": body.get("choice", ""),
                                            "request_id": body.get("request_id")})
                    return self._json(res or {"ok": True})
                except GatewayError as e:
                    return self._json({"ok": False, "error": str(e)}, status=400)
            if path == "/api/agents/model":
                return self._admin_write(lambda: self.provider.admin.set_model(
                    body.get("agent", ""), body.get("model", ""), body.get("provider", "")))
            if path == "/api/agents/file":
                return self._admin_write(lambda: self.provider.admin.save_file(
                    body.get("agent", ""), body.get("name", ""), body.get("content", "")))
            if path == "/api/agents/create":
                return self._admin_write(lambda: self.provider.admin.create_agent(
                    body.get("name", ""), body.get("role", ""), body.get("model", ""), body.get("provider", "")))
            if path == "/api/agents/toolset":
                return self._admin_write(lambda: self.provider.admin.set_toolset(
                    body.get("agent", ""), body.get("toolset", ""), bool(body.get("enabled"))))
            if path == "/api/tasks/move":
                try:
                    return self._json(self.provider.move_task(
                        body.get("id", ""), body.get("to", ""), body.get("from", "")))
                except KanbanError as e:
                    return self._json({"error": str(e)}, status=400)
            if path == "/api/content/dir":
                try:
                    return self._json(self.provider.set_content_dir(body.get("path", "")))
                except ContentError as e:
                    return self._json({"error": str(e)}, status=400)
            if path in ("/api/content/save", "/api/content/create", "/api/content/delete"):
                cs = self.provider.content_store
                if not cs:
                    return self._json({"error": "content editing is local-mode only"}, status=403)
                try:
                    if path == "/api/content/save":
                        return self._json(cs.save(body.get("path", ""), body.get("content", "")))
                    if path == "/api/content/create":
                        return self._json(cs.create(body.get("agent", ""), body.get("title", "")))
                    return self._json(cs.delete(body.get("path", "")))
                except ContentError as e:
                    return self._json({"error": str(e)}, status=400)
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        self._json({"error": "not found"}, status=404)

    # -- admin helpers ----------------------------------------------------

    def _admin_read(self, fn):
        if not self.provider.admin:
            return self._json({"error": "editing is available in local mode only"}, status=403)
        agent = parse_qs(urlparse(self.path).query).get("agent", [""])[0]
        try:
            return self._json(fn(agent))
        except AdminError as e:
            return self._json({"error": str(e)}, status=400)

    def _admin_write(self, fn):
        if not self.provider.admin:
            return self._json({"error": "editing is available in local mode only"}, status=403)
        try:
            return self._json(fn())
        except AdminError as e:
            return self._json({"error": str(e)}, status=400)

    def _chat_stream(self, body: dict):
        """Run a real agent turn via the runs API and relay reasoning, tool activity and the
        answer to the browser as typed SSE frames. Falls back nowhere — runs is the path that
        carries the agent's thinking."""
        gw = self.provider.gateway
        if not gw:
            return self._json({"error": "gateway not available on this host"}, status=503)
        messages = body.get("messages") or []
        if not isinstance(messages, list) or not messages:
            return self._json({"error": "messages required"}, status=400)
        profile = self.provider.chat_route(body.get("agent") or None)
        history = messages[:-1]   # prior turns thread the conversation
        want_reasoning = body.get("reasoning", True)

        # attachments: text files are inlined into the prompt (works with any model); images are
        # sent as vision content (works where the model supports it).
        base_text = messages[-1].get("content", "") or ""
        atts = body.get("attachments") or []
        text_atts = [a for a in atts if a.get("kind") == "text" and a.get("text")]
        img_atts = [a for a in atts if a.get("kind") == "image" and a.get("dataUrl")]
        if text_atts:
            base_text += "\n\n" + "\n\n".join(
                f"[Attached file: {a.get('name', 'file')}]\n{a['text']}" for a in text_atts)
        # The runs API needs a non-empty user message. An attachment-only turn (e.g. a pasted
        # image with no caption) would otherwise send a blank text part and be rejected with
        # "No user message found in input" — supply a neutral prompt in that case.
        if not base_text.strip():
            if img_atts:
                base_text = "Please take a look at the attached image."
            elif atts:
                base_text = "Please review the attached file."
        if img_atts:
            # multimodal turn: the runs API reads `input` as messages, so wrap the text +
            # image parts in a user message (raw content parts alone read as "no user message").
            parts = [{"type": "text", "text": base_text}] + [
                {"type": "image_url", "image_url": {"url": a["dataUrl"]}} for a in img_atts]
            user_input = [{"role": "user", "content": parts}]
        else:
            user_input = base_text

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        def send(obj):
            self.wfile.write(b"data: " + json.dumps(obj).encode("utf-8") + b"\n\n")
            self.wfile.flush()

        working_agent = body.get("agent") or None
        if working_agent:
            self.provider.mark_working(working_agent, True)
        try:
            model_options = {"reasoning": {"enabled": True, "effort": "low"}} if want_reasoning else None
            run_id = gw.submit_run(user_input, profile=profile,
                                   conversation_history=history or None,
                                   model_options=model_options)
            if not run_id:
                send({"error": "could not start run"}); return
            send({"run": run_id})
            for ev in gw.run_events(run_id, profile=profile):
                t = ev.get("type") or ev.get("event") or ev.get("name") or ""
                if t == "reasoning.available":
                    send({"reasoning": ev.get("text", "")})
                elif t == "message.delta":
                    d = ev.get("delta", "")
                    if d:
                        send({"delta": d})
                elif t == "tool.started":
                    send({"tool": {"phase": "started", "name": ev.get("tool") or ev.get("name") or "",
                                   "preview": ev.get("preview", "")}})
                elif t == "tool.completed":
                    send({"tool": {"phase": "completed", "name": ev.get("tool") or ev.get("name") or "",
                                   "preview": ev.get("preview", ""),
                                   "duration": ev.get("duration"), "error": bool(ev.get("error"))}})
                elif t in ("subagent.start", "subagent.started"):
                    send({"subagent": {"phase": "start",
                                       "name": ev.get("role") or ev.get("name") or ev.get("assignee") or ev.get("profile") or "worker",
                                       "goal": ev.get("goal") or ev.get("preview") or ev.get("task") or "",
                                       "id": ev.get("delegation_id") or ev.get("child_session_id") or ev.get("id") or ""}})
                elif t in ("subagent.complete", "subagent.completed"):
                    usage = ev.get("usage") or {}
                    send({"subagent": {"phase": "complete",
                                       "name": ev.get("role") or ev.get("name") or ev.get("assignee") or ev.get("profile") or "worker",
                                       "status": ev.get("status") or ("failed" if ev.get("error") else "completed"),
                                       "duration": ev.get("duration"),
                                       "tokens": ev.get("tokens") or usage.get("total_tokens"),
                                       "id": ev.get("delegation_id") or ev.get("child_session_id") or ev.get("id") or ""}})
                elif t == "approval.request":
                    send({"approval": {"choices": ev.get("choices", []), "text": ev.get("preview", "")}})
                elif t.startswith("run."):
                    if any(s in t for s in ("completed", "failed", "interrupted", "stopping")):
                        send({"done": True, "status": t, "usage": ev.get("usage")})
                        break
        except (BrokenPipeError, ConnectionResetError):
            return
        except Exception as e:   # surface any failure to the client instead of a dead stream
            import traceback
            traceback.print_exc()
            try:
                send({"error": str(e)})
            except Exception:
                pass
        finally:
            if working_agent:
                self.provider.mark_working(working_agent, False)

    # -- SSE --------------------------------------------------------------

    def _sse(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Connection", "keep-alive")
        self.end_headers()
        try:
            while True:
                data = json.dumps(self.provider.state()).encode("utf-8")
                self.wfile.write(b"event: state\ndata: " + data + b"\n\n")
                self.wfile.flush()
                time.sleep(SSE_INTERVAL)
        except (BrokenPipeError, ConnectionResetError):
            return

    # -- static frontend --------------------------------------------------

    def _static(self, path: str):
        if not self.dist_dir or not self.dist_dir.is_dir():
            return self._json({
                "error": "front end not built",
                "hint": "run: cd frontend && npm install && npm run build",
            }, status=503)
        rel = path.lstrip("/") or "index.html"
        target = (self.dist_dir / rel).resolve()
        if self.dist_dir not in target.parents and target != self.dist_dir / "index.html":
            if not str(target).startswith(str(self.dist_dir.resolve())):
                target = self.dist_dir / "index.html"   # SPA fallback
        if not target.is_file():
            target = self.dist_dir / "index.html"        # SPA fallback
        if not target.is_file():
            return self._json({"error": "not found"}, status=404)
        ctype = _content_type(target.suffix)
        data = target.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def _content_type(suffix: str) -> str:
    return {
        ".html": "text/html; charset=utf-8", ".js": "text/javascript",
        ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml",
        ".png": "image/png", ".jpg": "image/jpeg", ".woff2": "font/woff2",
    }.get(suffix.lower(), "application/octet-stream")


def make_server(cfg: config_mod.Config) -> ThreadingHTTPServer:
    registry = FleetRegistry(cfg, lambda c: DataProvider(c))
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    Handler.registry = registry
    Handler.provider = registry.provider("primary")
    Handler.dist_dir = dist
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), Handler)
    return httpd


def main():
    cfg = config_mod.load()
    httpd = make_server(cfg)
    print(f"Hermes Mission Control — mode={cfg.mode} — http://{cfg.host}:{cfg.port}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
