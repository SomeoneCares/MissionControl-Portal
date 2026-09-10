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
import os
import re
import shutil
import subprocess
import urllib.error
import urllib.request
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
        """Models that are **activated** on this host — usable right now with no further server
        configuration. That means: providers with credentials (``auth.json``), providers already
        fetched live (``provider_models_cache.json``), and local model servers such as Ollama.
        The full static catalog is included **only** for providers that are actually configured;
        models that would need an API key set up are omitted."""
        seen: dict[str, dict] = {}

        def add(provider: str, model: str, source: str):
            provider, model = provider.strip(), model.strip()
            if not model:
                return
            mid = f"{provider}::{model}" if provider else model
            if mid not in seen or seen[mid]["source"] != "live":
                seen[mid] = {
                    "id": mid, "model": model, "provider": provider,
                    "label": model.split("/")[-1], "source": source,
                }

        configured, local_endpoints = self._configured_providers()

        # 1. live provider cache — providers Hermes has successfully fetched from = activated
        try:
            raw = json.loads((self.home / "provider_models_cache.json").read_text(encoding="utf-8"))
            for prov, pdata in (raw.items() if isinstance(raw, dict) else []):
                for m in (pdata.get("models", []) if isinstance(pdata, dict) else []):
                    add(str(prov), str(m), "live")
        except (OSError, ValueError):
            pass

        # 2. local model servers (Ollama) named in the credential pool — always activated
        for hostport in local_endpoints:
            for m in self._local_models(hostport):
                add("custom", m, "local")

        # 3. static catalog — ONLY for providers that are actually configured
        if configured:
            try:
                raw = json.loads((self.home / "cache" / "model_catalog.json").read_text(encoding="utf-8"))
                provs = raw.get("providers", {}) if isinstance(raw, dict) else {}
                for prov, pdata in (provs.items() if isinstance(provs, dict) else []):
                    if prov not in configured:
                        continue
                    for m in (pdata.get("models", []) if isinstance(pdata, dict) else []):
                        mid = m.get("id") if isinstance(m, dict) else m
                        add(str(prov), str(mid or ""), "catalog")
            except (OSError, ValueError):
                pass

        return sorted(seen.values(), key=lambda o: (o["provider"], o["label"]))

    def _configured_providers(self) -> tuple[set[str], list[str]]:
        """(provider names with credentials, local model-server host:port list). Reads only names
        and endpoints from auth.json — never a credential value."""
        configured: set[str] = set()
        endpoints: list[str] = []
        try:
            d = json.loads((self.home / "auth.json").read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return configured, endpoints
        provs = d.get("providers")
        if isinstance(provs, dict):
            configured |= {str(k) for k in provs}
        pool = d.get("credential_pool")
        if isinstance(pool, dict):
            for name in pool:
                configured.add(str(name).split(":", 1)[0])
                m = re.search(r"(\d{1,3}(?:\.\d{1,3}){3}:\d+|localhost:\d+)", str(name))
                if m:
                    endpoints.append(m.group(1))
        return configured, endpoints

    @staticmethod
    def _local_models(hostport: str) -> list[str]:
        """Model tags served by a local Ollama-compatible server. Empty if unreachable."""
        try:
            req = urllib.request.Request(f"http://{hostport}/api/tags")
            with urllib.request.urlopen(req, timeout=3.0) as r:
                data = json.loads(r.read().decode("utf-8"))
            return [str(m.get("name")) for m in data.get("models", []) if m.get("name")]
        except (urllib.error.URLError, OSError, ValueError):
            return []

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

    # -- agent creation ----------------------------------------------------

    def create_agent(self, name: str, role: str = "", model: str = "", provider: str = "") -> dict:
        """Create a new agent profile via the ``hermes`` CLI, then write its SOUL and model.
        The new profile directory is picked up by the fleet automatically. Rolls back on failure."""
        name = (name or "").strip()
        if not name:
            raise AdminError("agent name is required")
        agent = re.sub(r"[^a-z0-9-]+", "-", name.lower()).strip("-")
        if not agent:
            raise AdminError("could not derive a profile id from that name")
        pdir = self.home / "profiles" / agent
        if pdir.exists() or agent == "orchestrator":
            raise AdminError(f"a profile named '{agent}' already exists")
        hermes_bin = shutil.which("hermes") or str(self.home / "hermes-agent" / "hermes")
        if not Path(hermes_bin).exists() and not shutil.which("hermes"):
            raise AdminError("hermes CLI not found on this host")
        desc = f"{name}{(' — ' + role) if role else ''}"
        try:
            proc = subprocess.run(
                [hermes_bin, "profile", "create", agent, "--no-alias", "--description", desc],
                env={**os.environ, "HERMES_HOME": str(self.home)},
                stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                text=True, timeout=120, check=False)
        except (OSError, subprocess.SubprocessError) as e:
            raise AdminError(f"could not run hermes profile create: {e}")
        if proc.returncode != 0:
            raise AdminError("hermes profile create failed: " + (proc.stderr or proc.stdout or "")[-400:])
        try:
            if role or name:
                soul = f"# {name}\n\n## Identity and purpose\nYou are {name}"
                soul += f", the {role}." if role else "."
                soul += "\n"
                (pdir / "SOUL.md").write_text(soul, encoding="utf-8")
            if model:
                self.set_model(agent, model, provider)
        except Exception as e:  # noqa: BLE001 — roll the profile back if post-setup fails
            shutil.rmtree(pdir, ignore_errors=True)
            raise AdminError(f"profile created but setup failed (rolled back): {e}")
        return {"ok": True, "agent": agent, "name": name}

    # -- per-agent skills & toolsets --------------------------------------

    def list_skills(self, agent: str) -> dict:
        """The agent's installed skills (from its skills/ dir) and which toolsets it has disabled."""
        d = self._agent_dir(agent)
        installed = []
        skills_root = d / "skills"
        if skills_root.is_dir():
            for sk in sorted(skills_root.rglob("SKILL.md"))[:200]:
                name, desc = sk.parent.name, ""
                try:
                    for line in sk.read_text(encoding="utf-8", errors="replace").splitlines()[:15]:
                        m = re.match(r"^name\s*:\s*(.+)$", line)
                        if m:
                            name = m.group(1).strip().strip("\"'")
                        m = re.match(r"^description\s*:\s*(.+)$", line)
                        if m:
                            desc = m.group(1).strip().strip("\"'")[:140]
                        if line.startswith("# ") and not desc:
                            desc = line[2:].strip()[:140]
                except OSError:
                    pass
                installed.append({"name": name, "description": desc})
        return {"installed": installed, "disabled_toolsets": self._disabled_toolsets(d)}

    def _disabled_toolsets(self, agent_dir: Path) -> list[str]:
        cfg = agent_dir / "config.yaml"
        try:
            lines = cfg.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
        # `disabled_toolsets:` may sit at the top level or nested under `agent:` (indented).
        # Match it at any indent, then collect the list items indented deeper than the key.
        out: list[str] = []
        key_indent: int | None = None
        for line in lines:
            m = re.match(r"^(\s*)disabled_toolsets\s*:(.*)$", line)
            if m and key_indent is None:
                key_indent = len(m.group(1))
                continue
            if key_indent is not None:
                item = re.match(r"^(\s*)-\s*(.+?)\s*$", line)
                if item and len(item.group(1)) > key_indent:
                    out.append(item.group(2).strip().strip("\"'"))
                elif line.strip() == "":
                    continue
                else:
                    break  # a line at or above the key's indent ends the block
        return out

    def set_toolset(self, agent: str, toolset: str, enabled: bool) -> dict:
        """Enable/disable a toolset for an agent by editing config.yaml's disabled_toolsets list."""
        toolset = (toolset or "").strip()
        if not toolset:
            raise AdminError("toolset required")
        cfg = self._agent_dir(agent) / "config.yaml"
        text = cfg.read_text(encoding="utf-8") if cfg.exists() else ""
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
        if cfg.exists():
            (cfg.with_name(f"config.yaml.bak-toolset-{stamp}")).write_text(text, encoding="utf-8")
        disabled = set(self._disabled_toolsets(cfg.parent))
        if enabled:
            disabled.discard(toolset)
        else:
            disabled.add(toolset)
        cfg.write_text(_rewrite_disabled_toolsets(text, sorted(disabled)), encoding="utf-8")
        return {"ok": True, "agent": agent, "toolset": toolset, "enabled": enabled}

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


def _rewrite_disabled_toolsets(text: str, disabled: list[str]) -> str:
    """Replace the ``disabled_toolsets:`` list with ``disabled``, preserving the key's
    location and indentation (it is nested under ``agent:`` in Hermes profiles)."""
    lines = text.splitlines()
    out: list[str] = []
    i, replaced = 0, False
    while i < len(lines):
        line = lines[i]
        m = re.match(r"^(\s*)disabled_toolsets\s*:", line)
        if m and not replaced:
            replaced = True
            key_indent = m.group(1)
            # keep the existing item indentation if there is one, else key + 2 spaces
            item_indent = key_indent + "  "
            j = i + 1
            while j < len(lines):
                im = re.match(r"^(\s*)-\s*", lines[j])
                if im:
                    item_indent = im.group(1)
                    break
                if lines[j].strip() == "":
                    j += 1
                    continue
                break
            if disabled:
                out.append(f"{key_indent}disabled_toolsets:")
                out.extend(f"{item_indent}- {t}" for t in disabled)
            else:
                out.append(f"{key_indent}disabled_toolsets: []")
            i += 1
            while i < len(lines):  # skip the old key's list items (and interleaved blanks)
                if re.match(r"^\s*-\s*", lines[i]) or lines[i].strip() == "":
                    i += 1
                else:
                    break
            continue
        out.append(line)
        i += 1
    if not replaced and disabled:
        out.append("disabled_toolsets:")
        out.extend(f"- {t}" for t in disabled)
    return "\n".join(out).rstrip() + "\n"


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
