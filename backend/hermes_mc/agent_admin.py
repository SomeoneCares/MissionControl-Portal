"""Agent administration — model assignment and profile file editing.

These are **write** operations and only work in local mode (the gateway API is read-only for
config: ``admin_config_rw: false``). Every write is backed up first, sensitive files are never
readable or writable, and content is scanned for secrets before saving.

Editable per agent: ``SOUL.md`` (persona), ``AGENTS.md`` (operating instructions),
``MEMORY.md`` / ``USER.md`` (memory), ``config.yaml`` (model, tools, settings). The orchestrator's
files live at the Hermes root; every other agent's under ``profiles/<agent>/``.
"""
from __future__ import annotations

import json
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Optional

# Files an operator may view and edit. Everything else (secrets, databases, locks) is refused.
EDITABLE_FILES = ("SOUL.md", "AGENTS.md", "MEMORY.md", "USER.md", "config.yaml")
BLOCKED_NAMES = {".env", "auth.json", "auth.lock", "state.db"}

# crude secret detectors — refuse to save content that looks like it carries a live credential
_SECRET_RE = re.compile(r"(sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{12,}|ghp_[A-Za-z0-9]{20,}|"
                        r"xox[baprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----)")


class AdminError(RuntimeError):
    pass


class AgentAdmin:
    def __init__(self, hermes_home: Path):
        self.home = Path(hermes_home)

    # -- directory resolution (orchestrator = root) ------------------------

    def _agent_dir(self, agent: str) -> Path:
        d = self.home if agent == "orchestrator" else self.home / "profiles" / agent
        if not d.is_dir():
            raise AdminError(f"unknown agent: {agent}")
        return d

    def _safe_target(self, agent: str, name: str) -> Path:
        base = (name or "").strip()
        if base not in EDITABLE_FILES or base in BLOCKED_NAMES or "/" in base or "\\" in base:
            raise AdminError(f"file not editable: {name}")
        return self._agent_dir(agent) / base

    # -- models ------------------------------------------------------------

    def list_models(self) -> list[dict]:
        """Available models on this host, from the live provider cache and the model catalog."""
        seen: dict[str, dict] = {}

        def add(provider: str, model: str, source: str):
            provider, model = provider.strip(), model.strip()
            if not model:
                return
            mid = f"{provider}::{model}" if provider else model
            seen.setdefault(mid, {
                "id": mid, "model": model, "provider": provider,
                "label": model.split("/")[-1], "source": source,
            })

        cache = self.home / "provider_models_cache.json"
        if cache.exists():
            try:
                raw = json.loads(cache.read_text(encoding="utf-8"))
                for prov, pdata in (raw.items() if isinstance(raw, dict) else []):
                    for m in (pdata.get("models", []) if isinstance(pdata, dict) else []):
                        add(str(prov), str(m), "live")
            except (OSError, ValueError):
                pass

        catalog = self.home / "cache" / "model_catalog.json"
        if catalog.exists():
            try:
                raw = json.loads(catalog.read_text(encoding="utf-8"))
                provs = raw.get("providers", {}) if isinstance(raw, dict) else {}
                for prov, pdata in (provs.items() if isinstance(provs, dict) else []):
                    for m in (pdata.get("models", []) if isinstance(pdata, dict) else []):
                        mid = m.get("id") if isinstance(m, dict) else m
                        add(str(prov), str(mid or ""), "catalog")
            except (OSError, ValueError):
                pass

        return sorted(seen.values(), key=lambda o: (o["provider"], o["label"]))

    # -- files -------------------------------------------------------------

    def list_files(self, agent: str) -> list[dict]:
        d = self._agent_dir(agent)
        out = []
        for name in EDITABLE_FILES:
            p = d / name
            out.append({
                "name": name,
                "exists": p.exists(),
                "size": p.stat().st_size if p.exists() else 0,
            })
        return out

    def read_file(self, agent: str, name: str) -> dict:
        p = self._safe_target(agent, name)
        if not p.exists():
            return {"name": name, "exists": False, "content": ""}
        text = p.read_text(encoding="utf-8", errors="replace")
        return {"name": name, "exists": True, "content": _redact(text),
                "redacted": text != _redact(text)}

    def save_file(self, agent: str, name: str, content: str) -> dict:
        p = self._safe_target(agent, name)
        if "[REDACTED]" in content:
            raise AdminError("content still contains [REDACTED] — reload and edit the real file")
        if _SECRET_RE.search(content):
            raise AdminError("refusing to save: content looks like it contains a secret")
        backup = None
        if p.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = p.with_name(f"{p.name}.bak-{stamp}")
            shutil.copy2(p, backup)
        p.parent.mkdir(parents=True, exist_ok=True)
        tmp = p.with_name(p.name + ".tmp")
        tmp.write_text(content, encoding="utf-8")
        tmp.replace(p)
        return {"ok": True, "name": name, "size": p.stat().st_size,
                "backup": backup.name if backup else None}

    # -- model assignment (edits config.yaml, backed up) -------------------

    def set_model(self, agent: str, model: str, provider: str = "") -> dict:
        model = (model or "").strip()
        if not model:
            raise AdminError("model required")
        # accept "provider::model" ids from list_models
        if "::" in model and not provider:
            provider, model = model.split("::", 1)
        cfg = self._agent_dir(agent) / "config.yaml"
        old = cfg.read_text(encoding="utf-8") if cfg.exists() else "model:\n"
        backup = None
        if cfg.exists():
            stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            backup = cfg.with_name(f"config.yaml.bak-model-{stamp}")
            backup.write_text(old, encoding="utf-8")
        cfg.write_text(_rewrite_model(old, model, provider), encoding="utf-8")
        return {"ok": True, "agent": agent, "model": model, "provider": provider,
                "backup": backup.name if backup else None}


# ---------------------------------------------------------------------------
# helpers
# ---------------------------------------------------------------------------

def _redact(text: str) -> str:
    return _SECRET_RE.sub("[REDACTED]", text)


def _rewrite_model(text: str, model: str, provider: str) -> str:
    """Set the ``model.default`` (and ``provider``) in a profile config.yaml, preserving the
    rest. Handles both a ``model:`` block and no model section at all."""
    lines = text.splitlines()
    out: list[str] = []
    in_model = False
    saw_default = saw_provider = saw_model = False

    def flush_missing():
        if not saw_default:
            out.append(f"  default: {model}")
        if provider and not saw_provider:
            out.append(f"  provider: {provider}")

    for line in lines:
        if re.match(r"^model\s*:\s*$", line):
            saw_model, in_model = True, True
            out.append(line)
            continue
        if in_model and line and not line.startswith((" ", "\t")):
            flush_missing()
            in_model = False
        if in_model:
            if re.match(r"^\s*default\s*:", line):
                out.append(f"  default: {model}"); saw_default = True; continue
            if re.match(r"^\s*provider\s*:", line) and provider:
                out.append(f"  provider: {provider}"); saw_provider = True; continue
        out.append(line)

    if in_model:
        flush_missing()
    if not saw_model:
        head = ["model:", f"  default: {model}"] + ([f"  provider: {provider}"] if provider else [])
        out = head + out
    return "\n".join(out).rstrip() + "\n"
