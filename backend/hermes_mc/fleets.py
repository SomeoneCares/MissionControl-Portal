"""Fleet groups — portal-side grouping of a connection's profiles into named "fleets".

A **fleet** here is pure portal metadata: an id, a display name, an accent colour, and a list of
member profile names. It does NOT modify Hermes — profiles, SOULs, skills and memory are never
touched. Each connection has its own fleets, persisted to
``<connection project_dir>/fleet-groups.json`` (a distinct filename from the connection
registry's ``connections.json`` / legacy ``fleets.json`` so the two never collide on disk).

Rules (v1):
- **One profile belongs to at most one fleet.** Everything else is "Ungrouped".
- **Hybrid auto-seed:** the first time we see a connection with no ``fleets.json``, we suggest
  groups generically by the common name prefix before the first ``-`` (only where two or more
  profiles share it). No deployment-specific hardcoding — the operator then renames / recolours /
  reassigns freely.
- **Decommissioning a fleet** only removes the grouping; its members fall back to Ungrouped.
"""
from __future__ import annotations

import json
import re
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Optional


def _slug(name: str) -> str:
    s = re.sub(r"[^a-z0-9]+", "-", (name or "").lower()).strip("-")
    return s or uuid.uuid4().hex[:8]


_HEX_RE = re.compile(r"^#(?:[0-9a-fA-F]{6})$")


def _norm_accent(accent: str) -> str:
    accent = (accent or "").strip()
    if accent and not _HEX_RE.match(accent):
        raise ValueError("accent must be a #RRGGBB hex colour or empty")
    return accent


@dataclass
class Fleet:
    id: str
    name: str
    accent: str = ""
    members: list[str] = field(default_factory=list)
    content_dir: str = ""     # this fleet's own content-library folder ("" → uses the portal default)

    def public(self) -> dict:
        cd = self.content_dir
        return {"id": self.id, "name": self.name, "accent": self.accent, "members": list(self.members),
                "content_dir": cd,
                "content_ok": bool(cd) and Path(cd).expanduser().is_dir()}


class FleetGroups:
    def __init__(self, project_dir: Path):
        self.project_dir = Path(project_dir)
        self._store = self.project_dir / "fleet-groups.json"
        self.fleets: list[Fleet] = []
        self._loaded = False

    # -- persistence -------------------------------------------------------

    def _load(self):
        if self._loaded:
            return
        self._loaded = True
        try:
            data = json.loads(self._store.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            self.fleets = []
            self._seeded = False   # nothing on disk yet → eligible for auto-seed
            return
        self.fleets = []
        for f in data.get("fleets", []):
            if not isinstance(f, dict):
                continue
            self.fleets.append(Fleet(
                id=str(f.get("id") or _slug(f.get("name", ""))),
                name=str(f.get("name") or "Fleet"),
                accent=str(f.get("accent") or ""),
                members=[str(m) for m in (f.get("members") or [])],
                content_dir=str(f.get("content_dir") or "")))
        self._seeded = True        # a file exists (even if empty) → user intent, don't re-seed

    def _save(self):
        try:
            self.project_dir.mkdir(parents=True, exist_ok=True)
            stored = [{"id": f.id, "name": f.name, "accent": f.accent,
                       "members": list(f.members), "content_dir": f.content_dir}
                      for f in self.fleets]
            self._store.write_text(json.dumps({"fleets": stored}, indent=2), encoding="utf-8")
        except OSError:
            pass

    # -- auto-seed ---------------------------------------------------------

    @staticmethod
    def _seed_from(profiles: list[str]) -> list[Fleet]:
        by_prefix: dict[str, list[str]] = {}
        for p in profiles:
            if "-" in p:
                by_prefix.setdefault(p.split("-", 1)[0], []).append(p)
        fleets: list[Fleet] = []
        for prefix, members in by_prefix.items():
            if len(members) < 2:
                continue
            name = prefix.upper() if len(prefix) <= 3 else prefix.capitalize()
            fleets.append(Fleet(id=_slug(name), name=name, accent="", members=sorted(members)))
        return fleets

    # -- read --------------------------------------------------------------

    def view(self, profiles: list[str]) -> dict:
        """Return the grouping for the given live profile list, auto-seeding on first sight."""
        self._load()
        if not self._seeded and profiles:
            self.fleets = self._seed_from(profiles)
            self._seeded = True
            self._save()
        assigned = {m for f in self.fleets for m in f.members}
        ungrouped = [p for p in profiles if p not in assigned]
        live = set(profiles)
        return {
            # members annotated with whether the profile is currently live on the connection
            "fleets": [{**f.public(),
                        "live_members": [m for m in f.members if m in live]} for f in self.fleets],
            "ungrouped": ungrouped,
            "profiles": list(profiles),
        }

    # -- write -------------------------------------------------------------

    def _find(self, fleet_id: str) -> Optional[Fleet]:
        return next((f for f in self.fleets if f.id == fleet_id), None)

    def create(self, name: str, accent: str = "") -> dict:
        self._load()
        name = (name or "").strip()[:40]
        if not name:
            raise ValueError("fleet name is required")
        accent = _norm_accent(accent)
        fid = _slug(name)
        while self._find(fid):
            fid = f"{_slug(name)}-{uuid.uuid4().hex[:4]}"
        fleet = Fleet(id=fid, name=name, accent=accent, members=[])
        self.fleets.append(fleet)
        self._seeded = True
        self._save()
        return fleet.public()

    def update(self, fleet_id: str, name: Optional[str], accent: Optional[str],
               content_dir: Optional[str] = None) -> dict:
        self._load()
        fleet = self._find(fleet_id)
        if not fleet:
            raise ValueError("no such fleet")
        if name is not None:
            n = str(name).strip()[:40]
            if not n:
                raise ValueError("fleet name is required")
            fleet.name = n
        if accent is not None:
            fleet.accent = _norm_accent(accent)
        if content_dir is not None:
            cd = str(content_dir).strip()
            if cd and not cd.startswith(("/", "~")):
                raise ValueError("content folder must be an absolute path (or start with ~)")
            fleet.content_dir = cd
        self._save()
        return fleet.public()

    def roots(self) -> dict[str, Path]:
        """Map fleet id → its configured content folder (absolute, ~ expanded). Skips unset ones."""
        self._load()
        out: dict[str, Path] = {}
        for f in self.fleets:
            if f.content_dir:
                out[f.id] = Path(f.content_dir).expanduser()
        return out

    def assign(self, profile: str, fleet_id: str) -> dict:
        """Move a profile into a fleet (fleet_id="" → Ungrouped). One fleet per profile."""
        self._load()
        profile = (profile or "").strip()
        if not profile:
            return {"ok": False, "error": "profile is required"}
        for f in self.fleets:
            if profile in f.members:
                f.members.remove(profile)
        if fleet_id:
            target = self._find(fleet_id)
            if not target:
                return {"ok": False, "error": "no such fleet"}
            if profile not in target.members:
                target.members.append(profile)
        self._seeded = True
        self._save()
        return {"ok": True, "profile": profile, "fleet": fleet_id}

    def remove(self, fleet_id: str) -> bool:
        """Decommission a fleet: drop the grouping (members fall back to Ungrouped)."""
        self._load()
        before = len(self.fleets)
        self.fleets = [f for f in self.fleets if f.id != fleet_id]
        if len(self.fleets) == before:
            return False
        self._seeded = True
        self._save()
        return True
