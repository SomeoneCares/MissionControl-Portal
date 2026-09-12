"""Connection registry — many Hermes hosts under one portal.

Each connection is one connected Hermes host: a name, an accent colour, and how to reach it (local,
or a remote bridge + gateway). The portal's own startup config is the primary connection; more are
added from the Settings page and persisted to ``<project_dir>/connections.json``. One token never
reaches another connection — each carries its own credentials.

A ``DataProvider`` is built and cached per connection, so switching connections in the UI just
changes which provider serves the request.

(Historically these were called "fleets"; the on-disk file and API keep a back-compat alias so an
older ``fleets.json`` is migrated on first save.)
"""
from __future__ import annotations

import ipaddress
import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse

from . import config as config_mod


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or uuid.uuid4().hex[:8]


# link-local / cloud-metadata ranges — a connection URL must never target these (SSRF guard).
# Private LAN ranges are deliberately allowed: connecting to a LAN Hermes host is the whole point.
_BLOCKED_NETS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fe80::/10"))


def _check_connection_url(url: str, label: str) -> str:
    """Validate a user-supplied connection URL; return it normalised, or raise ValueError."""
    url = (url or "").strip().rstrip("/")
    if not url:
        return ""
    p = urlparse(url)
    if p.scheme not in ("http", "https") or not p.hostname:
        raise ValueError(f"{label} must be a full http(s):// URL")
    ip = None
    try:
        ip = ipaddress.ip_address(p.hostname)
    except ValueError:
        ip = None  # a hostname, not an IP literal — allowed
    if ip is not None and any(ip in net for net in _BLOCKED_NETS):
        raise ValueError(f"{label} points at a link-local/metadata address, which is not allowed")
    return url


@dataclass
class Connection:
    id: str
    name: str
    accent: str = ""
    mode: str = "remote"          # "local" | "remote"
    bridge_url: str = ""
    bridge_key: str = field(default="", repr=False)
    gateway_url: str = ""
    gateway_key: str = field(default="", repr=False)
    primary: bool = False         # the portal's own startup connection

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "accent": self.accent,
                "mode": self.mode, "primary": self.primary,
                "gateway": bool(self.gateway_url)}


class ConnectionRegistry:
    def __init__(self, cfg: config_mod.Config, provider_factory):
        """provider_factory(config_like) -> DataProvider. The primary connection uses the startup cfg."""
        self.cfg = cfg
        self._make = provider_factory
        self._store = cfg.project_dir / "connections.json"
        self._legacy_store = cfg.project_dir / "fleets.json"   # migrated on first save
        self._providers: dict[str, object] = {}
        self.connections: dict[str, Connection] = {}

        primary = Connection(
            id="primary", name=("This host" if cfg.is_local else "Hermes"), accent="",
            mode=cfg.mode, bridge_url=cfg.bridge_url, bridge_key=cfg.bridge_key,
            gateway_url=cfg.gateway_url, gateway_key=cfg.gateway_key, primary=True)
        self.connections[primary.id] = primary
        self._load()

    # -- persistence -------------------------------------------------------

    def _load(self):
        # Prefer the new file; fall back to a legacy fleets.json so upgrades keep their connections.
        path = self._store if self._store.exists() else self._legacy_store
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        items = data.get("connections")
        if items is None:
            items = data.get("fleets", [])   # legacy key
        for f in items:
            if not isinstance(f, dict) or f.get("id") == "primary":
                continue
            conn = Connection(
                id=str(f.get("id") or _slug(f.get("name", ""))),
                name=str(f.get("name") or "Connection"), accent=str(f.get("accent") or ""),
                mode=str(f.get("mode") or "remote"),
                bridge_url=str(f.get("bridge_url") or ""), bridge_key=str(f.get("bridge_key") or ""),
                gateway_url=str(f.get("gateway_url") or ""), gateway_key=str(f.get("gateway_key") or ""))
            self.connections[conn.id] = conn

    def _save(self):
        extra = [{
            "id": c.id, "name": c.name, "accent": c.accent, "mode": c.mode,
            "bridge_url": c.bridge_url, "bridge_key": c.bridge_key,
            "gateway_url": c.gateway_url, "gateway_key": c.gateway_key,
        } for c in self.connections.values() if not c.primary]
        try:
            self._store.write_text(json.dumps({"connections": extra}, indent=2), encoding="utf-8")
            self._store.chmod(0o600)  # holds bridge/gateway tokens — owner-only
        except OSError:
            pass

    # -- providers ---------------------------------------------------------

    def provider(self, conn_id: Optional[str]):
        cid = conn_id if conn_id in self.connections else "primary"
        if cid not in self._providers:
            self._providers[cid] = self._make(self._config_for(self.connections[cid]))
        return self._providers[cid]

    def _config_for(self, c: Connection) -> config_mod.Config:
        if c.primary:
            return self.cfg
        # a remote connection reuses the shared project dir for its own board, but sources data remotely
        return config_mod.Config(
            mode="remote", hermes_home=None, project_dir=self.cfg.project_dir / c.id,
            content_dir=None, gateway_url=c.gateway_url.rstrip("/"), gateway_key=c.gateway_key,
            bridge_url=c.bridge_url.rstrip("/"), bridge_key=c.bridge_key,
            host=self.cfg.host, port=self.cfg.port)

    # -- CRUD --------------------------------------------------------------

    def list(self) -> list[dict]:
        return [c.public() for c in self.connections.values()]

    def add(self, spec: dict) -> Connection:
        name = str(spec.get("name") or "Connection").strip()
        cid = _slug(name)
        while cid in self.connections:
            cid = f"{_slug(name)}-{uuid.uuid4().hex[:4]}"
        bridge_url = _check_connection_url(str(spec.get("bridge_url") or ""), "Bridge URL")
        gateway_url = _check_connection_url(str(spec.get("gateway_url") or ""), "Gateway URL")
        if not bridge_url and not gateway_url:
            raise ValueError("give a bridge URL, a gateway URL, or both")
        conn = Connection(
            id=cid, name=name, accent=str(spec.get("accent") or ""), mode="remote",
            bridge_url=bridge_url, bridge_key=str(spec.get("bridge_key") or ""),
            gateway_url=gateway_url, gateway_key=str(spec.get("gateway_key") or ""))
        self.connections[conn.id] = conn
        self._save()
        return conn

    def remove(self, conn_id: str) -> bool:
        c = self.connections.get(conn_id)
        if not c or c.primary:
            return False
        del self.connections[conn_id]
        self._providers.pop(conn_id, None)
        self._save()
        return True
