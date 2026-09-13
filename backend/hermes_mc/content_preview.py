"""Rendered document previews — page images for PDF/DOCX/PPTX/XLSX.

Faithful port of the original Mission Control preview pipeline: office files are converted to PDF
with headless LibreOffice, then every page is rasterised to a PNG with poppler's ``pdftoppm``. The
PNGs are cached under the project dir, keyed by the source file's path + mtime + size, so a preview
is rendered once and reused until the file changes.

Both tools are optional system packages — ``pdftoppm`` (poppler-utils) for the PDF step and
``soffice``/``libreoffice`` for the office→PDF step. When they're absent the caller degrades to a
plain download, so a host without them simply shows no inline preview.
"""
from __future__ import annotations

import hashlib
import shutil
import subprocess
from pathlib import Path

PREVIEW_EXTS = {".pdf", ".docx", ".pptx", ".xlsx"}
MAX_PAGES = 12


def previewable(name: str) -> bool:
    return Path(name).suffix.lower() in PREVIEW_EXTS


def _pdftoppm() -> str | None:
    return shutil.which("pdftoppm")


def _soffice() -> str | None:
    return shutil.which("soffice") or shutil.which("libreoffice")


def tools_status() -> dict:
    return {"pdftoppm": bool(_pdftoppm()), "soffice": bool(_soffice())}


def supported_for(name: str) -> tuple[bool, str]:
    """(can we render `name` here?, reason if not)."""
    if not previewable(name):
        return False, "not a previewable document type"
    if not _pdftoppm():
        return False, "poppler (pdftoppm) is not installed on the host"
    if Path(name).suffix.lower() != ".pdf" and not _soffice():
        return False, "LibreOffice (soffice) is not installed on the host"
    return True, ""


def _key(p: Path) -> str:
    st = p.stat()
    payload = f"{p.resolve()}|{st.st_mtime_ns}|{st.st_size}".encode("utf-8")
    return hashlib.sha256(payload).hexdigest()[:24]


def _cache_dir(cache_root: Path, src: Path) -> Path:
    d = (cache_root / _key(src)).resolve()
    if cache_root.resolve() not in (d, *d.parents):
        raise ValueError("invalid cache path")
    return d


def _run(cmd: list[str], timeout: int) -> None:
    proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, timeout=timeout)
    if proc.returncode != 0:
        detail = ((proc.stderr or proc.stdout) or "preview command failed").strip()[-400:]
        raise RuntimeError(detail or "preview command failed")


def _office_to_pdf(src: Path, out_dir: Path) -> Path:
    soffice = _soffice()
    if not soffice:
        raise RuntimeError("LibreOffice is not installed")
    # a private profile dir avoids clashing with an interactive LibreOffice session
    _run([soffice, "-env:UserInstallation=file://" + str(out_dir / ".lo"),
          "--headless", "--convert-to", "pdf", "--outdir", str(out_dir), str(src)], timeout=180)
    pdf = out_dir / (src.stem + ".pdf")
    if pdf.exists():
        return pdf
    matches = list(out_dir.glob("*.pdf"))
    if matches:
        return matches[0]
    raise RuntimeError("LibreOffice did not produce a PDF")


def _render_pages(pdf: Path, out_dir: Path, max_pages: int) -> list[Path]:
    ppm = _pdftoppm()
    if not ppm:
        raise RuntimeError("pdftoppm is not installed")
    _run([ppm, "-f", "1", "-l", str(max_pages), "-r", "120", "-png", str(pdf), str(out_dir / "page")], timeout=150)
    return _pages(out_dir)


def _pages(out_dir: Path) -> list[Path]:
    # pdftoppm names files page-1.png / page-01.png depending on the total page count — order by
    # the trailing integer, not lexically, so page-2 sorts before page-10.
    def num(p: Path) -> int:
        try:
            return int(p.stem.split("-")[-1])
        except ValueError:
            return 0
    return sorted(out_dir.glob("page-*.png"), key=num)


def build(src: Path, cache_root: Path, max_pages: int = MAX_PAGES) -> list[Path]:
    """Return the cached page PNGs for `src`, rendering (and caching) them on first request."""
    out_dir = _cache_dir(cache_root, src)
    out_dir.mkdir(parents=True, exist_ok=True)
    imgs = _pages(out_dir)
    if imgs:
        return imgs
    pdf = src if src.suffix.lower() == ".pdf" else _office_to_pdf(src, out_dir)
    imgs = _render_pages(pdf, out_dir, max_pages)
    if not imgs:
        raise RuntimeError("no preview images were generated")
    return imgs


def page_file(src: Path, cache_root: Path, page: int) -> Path | None:
    """The cached PNG for a 1-based page, rendering the set if it isn't there yet."""
    out_dir = _cache_dir(cache_root, src)
    for cand in (out_dir / f"page-{page:02d}.png", out_dir / f"page-{page}.png"):
        if cand.exists():
            return cand
    build(src, cache_root)
    for cand in (out_dir / f"page-{page:02d}.png", out_dir / f"page-{page}.png"):
        if cand.exists():
            return cand
    return None
