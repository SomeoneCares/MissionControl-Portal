"""Fleet registry — many Hermes hosts under one portal.

Each fleet is one connected Hermes host: a name, an accent colour, and how to reach it (local, or
a remote bridge + gateway). The portal's own startup config is the primary fleet; more are added
from the Settings page and persisted to ``<project_dir>/fleets.json``. One token never reaches
another fleet — each carries its own credentials.

A ``DataProvider`` is built and cached per fleet, so switching fleets in the UI just changes which
provider serves the request.
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


# link-local / cloud-metadata ranges — a fleet URL must never target these (SSRF guard). Private
# LAN ranges are deliberately allowed: connecting to a LAN Hermes host is the whole point.
_BLOCKED_NETS = (ipaddress.ip_network("169.254.0.0/16"), ipaddress.ip_network("fe80::/10"))


def _check_fleet_url(url: str, label: str) -> str:
    """Validate a user-supplied fleet URL; return it normalised, or raise ValueError."""
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
class Fleet:
    id: str
    name: str
    accent: str = ""
    mode: str = "remote"          # "local" | "remote"
    bridge_url: str = ""
    bridge_key: str = field(default="", repr=False)
    gateway_url: str = ""
    gateway_key: str = field(default="", repr=False)
    primary: bool = False         # the portal's own startup fleet

    def public(self) -> dict:
        return {"id": self.id, "name": self.name, "accent": self.accent,
                "mode": self.mode, "primary": self.primary,
                "gateway": bool(self.gateway_url)}


class FleetRegistry:
    def __init__(self, cfg: config_mod.Config, provider_factory):
        """provider_factory(config_like) -> DataProvider. The primary fleet uses the startup cfg."""
        self.cfg = cfg
        self._make = provider_factory
        self._store = cfg.project_dir / "fleets.json"
        self._providers: dict[str, object] = {}
        self.fleets: dict[str, Fleet] = {}

        primary = Fleet(
            id="primary", name=("This host" if cfg.is_local else "Hermes"), accent="",
            mode=cfg.mode, bridge_url=cfg.bridge_url, bridge_key=cfg.bridge_key,
            gateway_url=cfg.gateway_url, gateway_key=cfg.gateway_key, primary=True)
        self.fleets[primary.id] = primary
        self._load()

    # -- persistence -------------------------------------------------------

    def _load(self):
        try:
            data = json.loads(self._store.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return
        for f in data.get("fleets", []):
            if not isinstance(f, dict) or f.get("id") == "primary":
                continue
            fl = Fleet(
                id=str(f.get("id") or _slug(f.get("name", ""))),
                name=str(f.get("name") or "Fleet"), accent=str(f.get("accent") or ""),
                mode=str(f.get("mode") or "remote"),
                bridge_url=str(f.get("bridge_url") or ""), bridge_key=str(f.get("bridge_key") or ""),
                gateway_url=str(f.get("gateway_url") or ""), gateway_key=str(f.get("gateway_key") or ""))
            self.fleets[fl.id] = fl

    def _save(self):
        extra = [{
            "id": f.id, "name": f.name, "accent": f.accent, "mode": f.mode,
            "bridge_url": f.bridge_url, "bridge_key": f.bridge_key,
            "gateway_url": f.gateway_url, "gateway_key": f.gateway_key,
        } for f in self.fleets.values() if not f.primary]
        try:
            self._store.write_text(json.dumps({"fleets": extra}, indent=2), encoding="utf-8")
            self._store.chmod(0o600)  # holds bridge/gateway tokens — owner-only
        except OSError:
            pass

    # -- providers ---------------------------------------------------------

    def provider(self, fleet_id: Optional[str]):
        fid = fleet_id if fleet_id in self.fleets else "primary"
        if fid not in self._providers:
            self._providers[fid] = self._make(self._config_for(self.fleets[fid]))
        return self._providers[fid]

    def _config_for(self, f: Fleet) -> config_mod.Config:
        if f.primary:
            return self.cfg
        # a remote fleet reuses the shared project dir for its own board, but sources data remotely
        return config_mod.Config(
            mode="remote", hermes_home=None, project_dir=self.cfg.project_dir / f.id,
            content_dir=None, gateway_url=f.gateway_url.rstrip("/"), gateway_key=f.gateway_key,
            bridge_url=f.bridge_url.rstrip("/"), bridge_key=f.bridge_key,
            host=self.cfg.host, port=self.cfg.port)

    # -- CRUD --------------------------------------------------------------

    def list(self) -> list[dict]:
        return [f.public() for f in self.fleets.values()]

    def add(self, spec: dict) -> Fleet:
        name = str(spec.get("name") or "Fleet").strip()
        fid = _slug(name)
        while fid in self.fleets:
            fid = f"{_slug(name)}-{uuid.uuid4().hex[:4]}"
        bridge_url = _check_fleet_url(str(spec.get("bridge_url") or ""), "Bridge URL")
        gateway_url = _check_fleet_url(str(spec.get("gateway_url") or ""), "Gateway URL")
        if not bridge_url and not gateway_url:
            raise ValueError("give a bridge URL, a gateway URL, or both")
        fl = Fleet(
            id=fid, name=name, accent=str(spec.get("accent") or ""), mode="remote",
            bridge_url=bridge_url, bridge_key=str(spec.get("bridge_key") or ""),
            gateway_url=gateway_url, gateway_key=str(spec.get("gateway_key") or ""))
        self.fleets[fl.id] = fl
        self._save()
        return fl

    def remove(self, fleet_id: str) -> bool:
        f = self.fleets.get(fleet_id)
        if not f or f.primary:
            return False
        del self.fleets[fleet_id]
        self._providers.pop(fleet_id, None)
        self._save()
        return True
