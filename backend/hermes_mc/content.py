"""Content library writes and export — create, save, delete, download, and Word export.

Local-mode only (writes touch the content directory on the Hermes host). Path-safe: every target
resolves inside the content directory and must be a ``.md`` file.
"""
from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path


class ContentError(RuntimeError):
    pass


# Types the library exposes for download/delete. Editing and Word export stay markdown-only.
_DOWNLOADABLE = {".md", ".txt", ".html", ".htm", ".csv", ".json", ".log", ".pdf", ".docx"}


class ContentStore:
    def __init__(self, content_dir: Path):
        self.root = Path(content_dir)

    def _within(self, rel_path: str) -> Path:
        """Resolve a path and guarantee it stays inside the content root (no extension check)."""
        target = (self.root / rel_path).resolve()
        root = self.root.resolve()
        if root not in target.parents and target != root:
            raise ContentError("path outside the content directory")
        return target

    def _safe(self, rel_path: str) -> Path:
        """Markdown-only resolve, for the edit/create/Word paths."""
        target = self._within(rel_path)
        if target.suffix.lower() != ".md":
            raise ContentError("only markdown documents are editable")
        return target

    def _safe_any(self, rel_path: str) -> Path:
        """Resolve any downloadable document type inside the content root."""
        target = self._within(rel_path)
        if target.suffix.lower() not in _DOWNLOADABLE:
            raise ContentError("unsupported document type")
        return target

    def save(self, rel_path: str, text: str) -> dict:
        target = self._safe(rel_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        tmp = target.with_name(target.name + ".tmp")
        tmp.write_text(text, encoding="utf-8")
        tmp.replace(target)
        return {"ok": True, "path": rel_path, "size": target.stat().st_size}

    def create(self, agent: str, title: str) -> dict:
        agent = re.sub(r"[^a-z0-9_-]+", "-", (agent or "").lower()).strip("-")
        title = (title or "Untitled").strip()
        slug = re.sub(r"[^a-z0-9]+", "-", title.lower()).strip("-")[:50] or "untitled"
        date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        name = f"{date}_{slug}.md"
        rel = f"{agent}/{name}" if agent else name
        target = (self.root / rel)
        if target.exists():
            raise ContentError("a document with that name already exists today")
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(f"# {title}\n\n", encoding="utf-8")
        return {"ok": True, "path": rel, "agent": agent, "filename": name}

    def delete(self, rel_path: str) -> dict:
        target = self._safe_any(rel_path)
        if not target.exists():
            raise ContentError("document not found")
        target.unlink()
        return {"ok": True, "path": rel_path}

    def raw(self, rel_path: str) -> tuple[bytes, str]:
        target = self._safe_any(rel_path)
        if not target.exists():
            raise ContentError("document not found")
        return target.read_bytes(), target.name

    def to_docx(self, rel_path: str) -> tuple[bytes, str]:
        """Convert the markdown document to a .docx. Requires python-docx on the host."""
        target = self._safe(rel_path)
        if not target.exists():
            raise ContentError("document not found")
        try:
            from docx import Document  # type: ignore
        except ImportError:
            raise ContentError("Word export needs python-docx installed on the Hermes host")
        doc = Document()
        for line in target.read_text(encoding="utf-8", errors="replace").splitlines():
            s = line.rstrip()
            if not s:
                continue
            if s.startswith("### "):
                doc.add_heading(s[4:], level=3)
            elif s.startswith("## "):
                doc.add_heading(s[3:], level=2)
            elif s.startswith("# "):
                doc.add_heading(s[2:], level=1)
            elif re.match(r"^\s*[-*]\s+", s):
                doc.add_paragraph(re.sub(r"^\s*[-*]\s+", "", s), style="List Bullet")
            else:
                doc.add_paragraph(s)
        import io
        buf = io.BytesIO()
        doc.save(buf)
        return buf.getvalue(), target.with_suffix(".docx").name
