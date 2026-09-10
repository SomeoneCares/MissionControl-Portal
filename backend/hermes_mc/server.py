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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

from . import config as config_mod
from .board import Board
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
        self._local = LocalSource(cfg.hermes_home, cfg.project_dir) if cfg.is_local else None
        self._cache: dict = {"at": 0.0, "data": None}

    def capabilities(self) -> dict:
        if not self.gateway:
            return {}
        try:
            return self.gateway.capabilities()
        except GatewayError:
            return {}

    def _build(self) -> dict:
        if self._local is not None:
            data = self._local.build_state()
        else:
            data = self._remote_state()
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
        import urllib.request
        req = urllib.request.Request(
            f"{self.cfg.bridge_url}/state",
            headers={"Authorization": f"Bearer {self.cfg.bridge_key}", "Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=10.0) as resp:
            return json.loads(resp.read().decode("utf-8"))

    def state(self, *, force: bool = False) -> dict:
        now = time.monotonic()
        if not force and self._cache["data"] is not None and now - self._cache["at"] < STATE_TTL:
            return self._cache["data"]
        data = self._build()
        self._cache = {"at": now, "data": data}
        return data


class Handler(BaseHTTPRequestHandler):
    provider: DataProvider = None   # set on the server instance
    dist_dir: Path = None

    server_version = "HermesMC/0.1"

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
        if path == "/api/health":
            h = self.provider.gateway.health() if self.provider.gateway else None
            return self._json({
                "ok": True,
                **self.provider.cfg.public(),
                "gateway": {"ok": h.ok, "latency_ms": h.latency_ms, "version": h.version} if h else None,
            })
        if path == "/api/capabilities":
            return self._json(self.provider.capabilities())
        if path == "/api/state":
            return self._json(self.provider.state())
        if path == "/api/board":
            return self._json({"tasks": self.provider.board.list()})
        if path == "/events":
            return self._sse()
        return self._static(path)

    def do_POST(self):
        path = urlparse(self.path).path
        body = self._read_body()
        try:
            if path == "/api/board":
                return self._json(self.provider.board.create(
                    body.get("title", ""), body.get("priority", "P2"),
                    body.get("status", "todo"), body.get("notes", "")))
            if path == "/api/board/update":
                return self._json(self.provider.board.update(body.get("id", ""), **body))
            if path == "/api/board/delete":
                return self._json({"deleted": self.provider.board.delete(body.get("id", ""))})
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        self._json({"error": "not found"}, status=404)

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
    provider = DataProvider(cfg)
    dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
    Handler.provider = provider
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
