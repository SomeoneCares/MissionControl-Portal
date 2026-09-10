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

import hashlib
import json
import os
import secrets
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _env(name: str, default: str = "") -> str:
    return os.environ.get(name, default).strip()


def portal_settings_file(project_dir: Path) -> Path:
    """Where the portal persists user-set overrides (content dir, …)."""
    return Path(project_dir) / "portal-settings.json"


def read_portal_settings(project_dir: Path) -> dict:
    try:
        data = json.loads(portal_settings_file(project_dir).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def write_portal_settings(project_dir: Path, patch: dict) -> dict:
    current = read_portal_settings(project_dir)
    current.update({k: v for k, v in patch.items() if v is not None})
    portal_settings_file(project_dir).write_text(
        json.dumps(current, indent=2), encoding="utf-8")
    return current


# The portal signs in with a username + password. Credentials live in portal-settings.json as a
# username and a salted PBKDF2 hash (never plaintext). A fresh install seeds a known default so
# the user can sign in immediately, then change both in Settings.
DEFAULT_USERNAME = "admin"
DEFAULT_PASSWORD = "admin"
_PBKDF2_ITERS = 200_000


def hash_password(password: str, salt: Optional[bytes] = None) -> str:
    """Salted PBKDF2-SHA256 hash, encoded as ``pbkdf2$<iters>$<salt hex>$<hash hex>``."""
    salt = salt or secrets.token_bytes(16)
    dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"), salt, _PBKDF2_ITERS)
    return f"pbkdf2${_PBKDF2_ITERS}${salt.hex()}${dk.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time check of a password against a stored ``pbkdf2$…`` hash."""
    try:
        algo, iters, salthex, want = stored.split("$")
        if algo != "pbkdf2":
            return False
        dk = hashlib.pbkdf2_hmac("sha256", (password or "").encode("utf-8"),
                                 bytes.fromhex(salthex), int(iters))
        return secrets.compare_digest(dk.hex(), want)
    except (ValueError, AttributeError):
        return False


@dataclass
class PortalAuth:
    username: str
    pw_hash: str = field(repr=False, default="")
    is_default: bool = False   # still on the seeded default password → prompt the user to change it
    from_env: bool = False     # set via HMC_PORTAL_USER/PASSWORD → not editable in the UI


def resolve_portal_auth(project_dir: Path) -> PortalAuth:
    """Resolve the portal's sign-in credentials.

    ``HMC_PORTAL_USER`` + ``HMC_PORTAL_PASSWORD`` (both set) override everything and are not
    editable in the UI. Otherwise credentials come from portal-settings.json; a fresh install is
    seeded with the documented default (``admin`` / ``admin``) and flagged so the UI can warn.
    """
    env_user = os.environ.get("HMC_PORTAL_USER", "").strip()
    env_pw = os.environ.get("HMC_PORTAL_PASSWORD", "").strip()
    if env_user and env_pw:
        return PortalAuth(username=env_user, pw_hash=hash_password(env_pw), from_env=True)

    settings = read_portal_settings(project_dir)
    user = str(settings.get("auth_user") or "").strip()
    pw_hash = str(settings.get("auth_pw") or "").strip()
    if not user or not pw_hash:
        user = user or DEFAULT_USERNAME
        pw_hash = hash_password(DEFAULT_PASSWORD)
        write_portal_settings(project_dir, {"auth_user": user, "auth_pw": pw_hash, "auth_default_pw": True})
        try:
            portal_settings_file(project_dir).chmod(0o600)  # credentials file: owner-only
        except OSError:
            pass
        return PortalAuth(username=user, pw_hash=pw_hash, is_default=True)
    return PortalAuth(username=user, pw_hash=pw_hash, is_default=bool(settings.get("auth_default_pw")))


def set_portal_credentials(project_dir: Path, username: str, new_password: str) -> PortalAuth:
    """Persist a new username/password and return the fresh :class:`PortalAuth`."""
    username = (username or "").strip() or DEFAULT_USERNAME
    pw_hash = hash_password(new_password)
    write_portal_settings(project_dir, {"auth_user": username, "auth_pw": pw_hash, "auth_default_pw": False})
    try:
        portal_settings_file(project_dir).chmod(0o600)
    except OSError:
        pass
    return PortalAuth(username=username, pw_hash=pw_hash, is_default=False)


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
    kanban_db: Optional[Path] = None       # Hermes' shared task board (read live, write via CLI)
    bridge_url: str = ""            # remote mode: base URL of the Hermes-host bridge
    bridge_key: str = field(repr=False, default="")
    host: str = "0.0.0.0"           # portal bind address
    port: int = 51770               # portal bind port
    auth: Optional["PortalAuth"] = field(repr=False, default=None)  # sign-in credentials

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

    # Content library root: explicit env wins; else a folder the user set in Settings
    # (persisted in the project dir); else the default under the project dir.
    persisted = read_portal_settings(project_dir)
    content_override = getenv("CONTENT_DIR") or str(persisted.get("content_dir") or "")
    content_dir = Path(content_override or str(project_dir / "content")).expanduser()

    if mode == "local":
        gateway_url = getenv("HMC_GATEWAY_URL") or "http://127.0.0.1:8642"
        return Config(
            mode="local",
            hermes_home=home,
            project_dir=project_dir,
            content_dir=content_dir,
            gateway_url=gateway_url.rstrip("/"),
            gateway_key=gateway_key,
            agent_logs_db=agent_logs_db,
            kanban_db=(Path(getenv("HMC_KANBAN_DB")).expanduser() if getenv("HMC_KANBAN_DB")
                       else (home / "kanban.db")),
            host=getenv("HMC_HOST") or "0.0.0.0",
            port=int(getenv("HMC_PORT") or "51770"),
            auth=resolve_portal_auth(project_dir),
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
        auth=resolve_portal_auth(project_dir),
    )
