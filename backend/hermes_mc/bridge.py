"""Hermes-host bridge — the remote-mode data source.

Runs **on the Hermes box**. Serves exactly what the local data layer produces (fleet, runs,
health, host metrics, cron, content) over HTTP behind a bearer token, so a portal on another VM
can consume it without any file or database access of its own. Host metrics come from this
machine's ``/proc``, which is the whole point: a remote portal must report the Hermes host's
resources, never the portal VM's.

Read-only. The bridge never writes to Hermes. stdlib only.

Run:  HMC_BRIDGE_KEY=<token> python3 -m hermes_mc.bridge
Env:  HERMES_HOME, HMC_AGENT_LOGS_DB, CONTENT_DIR, HMC_BRIDGE_PORT (default 51772),
      HMC_BRIDGE_HOST (default 0.0.0.0), HMC_BRIDGE_KEY (required)
"""
from __future__ import annotations

import json
import os
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse, parse_qs

from .local_source import LocalSource


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


class BridgeConfig:
    def __init__(self):
        self.hermes_home = Path(_env("HERMES_HOME") or str(Path.home() / ".hermes")).expanduser()
        self.project_dir = Path(_env("HMC_PROJECT_DIR") or str(Path.home() / ".hermes-mc")).expanduser()
        self.project_dir.mkdir(parents=True, exist_ok=True)
        logs = _env("HMC_AGENT_LOGS_DB")
        self.agent_logs_db = Path(logs).expanduser() if logs else None
        cdir = _env("CONTENT_DIR")
        self.content_dir = Path(cdir).expanduser() if cdir else (self.project_dir / "content")
        self.host = _env("HMC_BRIDGE_HOST") or "0.0.0.0"
        self.port = int(_env("HMC_BRIDGE_PORT") or "51772")
        self.key = _env("HMC_BRIDGE_KEY")


class BridgeHandler(BaseHTTPRequestHandler):
    cfg: BridgeConfig = None
    source: LocalSource = None
    server_version = "HermesMC-Bridge/0.1"

    def log_message(self, *a):
        return

    def _authed(self) -> bool:
        if not self.cfg.key:
            return False  # fail closed: no key configured means no access
        auth = self.headers.get("Authorization", "")
        return auth.startswith("Bearer ") and auth[7:].strip() == self.cfg.key

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        path = urlparse(self.path).path
        if path == "/health":
            return self._json({"ok": True, "service": "hermes-mc-bridge"})
        if not self._authed():
            return self._json({"error": "unauthorized"}, status=401)
        try:
            if path == "/state":
                return self._json(self.source.build_state())
            if path == "/schedule":
                return self._json({"jobs": self.source.cron_jobs()})
            if path == "/content":
                return self._json({"docs": self.source.content_docs(self.cfg.content_dir)})
            if path == "/content/read":
                rel = parse_qs(urlparse(self.path).query).get("path", [""])[0]
                return self._json(self.source.content_read(self.cfg.content_dir, rel))
        except ValueError as e:
            return self._json({"error": str(e)}, status=400)
        except Exception as e:  # noqa: BLE001
            return self._json({"error": str(e)}, status=500)
        self._json({"error": "not found"}, status=404)


def main():
    cfg = BridgeConfig()
    if not cfg.key:
        raise SystemExit("HMC_BRIDGE_KEY is required — refusing to start without a token")
    BridgeHandler.cfg = cfg
    BridgeHandler.source = LocalSource(cfg.hermes_home, cfg.project_dir, cfg.agent_logs_db)
    httpd = ThreadingHTTPServer((cfg.host, cfg.port), BridgeHandler)
    print(f"Hermes MC bridge — http://{cfg.host}:{cfg.port} — home={cfg.hermes_home}")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
