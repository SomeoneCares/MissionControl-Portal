"""Configuration and mode detection for Hermes Mission Control.

The portal runs in one of two modes, decided once at startup:

* ``local``  — the portal runs on the Hermes host. It reads ``~/.hermes`` and the project
  databases directly, and talks to the gateway at ``127.0.0.1:8642``. This is the default
  when a Hermes home is found on disk.
* ``remote`` — the portal runs on a separate machine. File- and DB-backed data comes from a
  bridge service on the Hermes host; the gateway is reached at its LAN address. Selected when
  no local Hermes home exists, or forced via ``HMC_MODE=remote``.

Nothing here reaches out over the network — this module only resolves paths, URLs and the
gateway key, all from the environment and disk. Secrets are read but never logged.
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def _read_env_file(path: Path) -> dict[str, str]:
    """Parse a ``KEY=value`` file (Hermes' ``~/.hermes/.env``). Best effort, never raises."""
    out: dict[str, str] = {}
    try:
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            out[key.strip()] = val.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def default_hermes_home() -> Path:
    return Path(_env("HERMES_HOME") or str(Path.home() / ".hermes")).expanduser()


@dataclass
class Config:
    """Resolved runtime configuration. Build with :func:`load`."""

    mode: str                       # "local" | "remote"
    hermes_home: Optional[Path]     # None in remote mode
    project_dir: Path               # where the portal keeps its own DBs (board, etc.)
    content_dir: Optional[Path]     # agent content library root; None in remote mode
    gateway_url: str                # base URL of the Hermes gateway API (…:8642)
    gateway_key: str = field(repr=False)   # bearer token; never printed
    agent_logs_db: Optional[Path] = None   # run-history DB (Hermes agent hook writes it)
    bridge_url: str = ""            # remote mode: base URL of the Hermes-host bridge
    bridge_key: str = field(repr=False, default="")
    host: str = "0.0.0.0"           # portal bind address
    port: int = 51770               # portal bind port

    @property
    def is_local(self) -> bool:
        return self.mode == "local"

    @property
    def is_remote(self) -> bool:
        return self.mode == "remote"

    def public(self) -> dict:
        """Config safe to expose to the front end — no secrets, no absolute host paths."""
        return {
            "mode": self.mode,
            "gateway_configured": bool(self.gateway_url and self.gateway_key),
            "bridge_configured": bool(self.bridge_url) if self.is_remote else None,
        }


def load(env: Optional[dict] = None) -> Config:
    """Resolve configuration from the environment and disk.

    ``HMC_MODE`` forces a mode; otherwise the presence of a readable Hermes home decides.
    """
    getenv = (lambda k, d="": (env or os.environ).get(k, d).strip())

    project_dir = Path(getenv("HMC_PROJECT_DIR") or str(Path.home() / ".hermes-mc")).expanduser()
    project_dir.mkdir(parents=True, exist_ok=True)

    forced = getenv("HMC_MODE").lower()
    home = default_hermes_home()
    home_present = home.is_dir() and (home / "gateway_state.json").exists()

    if forced == "remote" or (forced != "local" and not home_present):
        mode = "remote"
    else:
        mode = "local"

    # Gateway key: explicit env wins, else Hermes' own ~/.hermes/.env (local mode only).
    gateway_key = getenv("API_SERVER_KEY")
    if not gateway_key and mode == "local":
        gateway_key = _read_env_file(home / ".env").get("API_SERVER_KEY", "")

    logs_db = getenv("HMC_AGENT_LOGS_DB")
    agent_logs_db = Path(logs_db).expanduser() if logs_db else None

    if mode == "local":
        gateway_url = getenv("HMC_GATEWAY_URL") or "http://127.0.0.1:8642"
        return Config(
            mode="local",
            hermes_home=home,
            project_dir=project_dir,
            content_dir=Path(getenv("CONTENT_DIR") or str(project_dir / "content")).expanduser(),
            gateway_url=gateway_url.rstrip("/"),
            gateway_key=gateway_key,
            agent_logs_db=agent_logs_db,
            host=getenv("HMC_HOST") or "0.0.0.0",
            port=int(getenv("HMC_PORT") or "51770"),
        )

    # remote
    return Config(
        mode="remote",
        hermes_home=None,
        project_dir=project_dir,
        content_dir=None,
        gateway_url=(getenv("HMC_GATEWAY_URL") or "").rstrip("/"),
        gateway_key=gateway_key,
        bridge_url=(getenv("HMC_BRIDGE_URL") or "").rstrip("/"),
        bridge_key=getenv("HMC_BRIDGE_KEY"),
        host=getenv("HMC_HOST") or "0.0.0.0",
        port=int(getenv("HMC_PORT") or "51770"),
    )
