#!/usr/bin/env bash
# Hermes Mission Control — portable installer.
#
# Boots the portal on any host: builds the front end, (optionally) installs the optional
# content dependencies, and sets up a service so it starts on boot. No host-specific paths —
# everything resolves from this repo's location and the environment.
#
# Usage:
#   installer/install.sh [--content-deps] [--system] [--no-service] [--no-build] [-h]
#
#   --content-deps   also pip-install the optional content extras (PDF/Word attachments & export)
#   --system         install a system-wide systemd unit (needs sudo) instead of a --user unit
#   --no-service     just build; don't install any service (use installer/run-portal.sh to run)
#   --no-build       skip the front-end build (only if frontend/dist already exists)
#   -h, --help       show this help
#
# Config (env, all optional):
#   HMC_HOST   bind address   (default 0.0.0.0 — LAN reachable)
#   HMC_PORT   port           (default 51770)
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HMC_HOST:-0.0.0.0}"
PORT="${HMC_PORT:-51770}"
DO_BUILD=1 DO_SERVICE=1 SYSTEM=0 CONTENT_DEPS=0

for arg in "$@"; do
  case "$arg" in
    --content-deps) CONTENT_DEPS=1 ;;
    --system)       SYSTEM=1 ;;
    --no-service)   DO_SERVICE=0 ;;
    --no-build)     DO_BUILD=0 ;;
    -h|--help)      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg (try -h)"; exit 2 ;;
  esac
done

say()  { printf '\n\033[1m== %s\033[0m\n' "$*"; }
ok()   { printf '  \033[32mok\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!!\033[0m %s\n' "$*"; }

# ---- prerequisites -----------------------------------------------------------
say "Checking prerequisites"
command -v python3 >/dev/null || { echo "python3 is required"; exit 1; }
ok "python3 $(python3 -V 2>&1 | awk '{print $2}')"

if [ "$DO_BUILD" = 1 ]; then
  command -v npm >/dev/null || { echo "npm/node is required to build the front end (or pass --no-build with a prebuilt frontend/dist)"; exit 1; }
  ok "node $(node -v 2>/dev/null || echo '?'), npm $(npm -v 2>/dev/null || echo '?')"
fi

# ---- Hermes detection (informational) ---------------------------------------
say "Detecting Hermes"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
if [ -f "$HERMES_HOME/gateway_state.json" ]; then
  ok "local Hermes home at $HERMES_HOME — portal will run in LOCAL mode (direct DB + gateway)"
  if command -v hermes >/dev/null; then
    ok "hermes CLI: $(hermes --version 2>/dev/null | head -1 || echo 'present')"
  else
    warn "hermes CLI not on PATH — model/file writes shell out to it; read-only features still work"
  fi
else
  warn "no local Hermes home ($HERMES_HOME/gateway_state.json missing) — portal will run in REMOTE mode"
  warn "set HMC_GATEWAY_URL / HMC_BRIDGE_URL (+ keys), or add a connection in the UI later"
fi

# ---- build front end ---------------------------------------------------------
if [ "$DO_BUILD" = 1 ]; then
  say "Building the front end"
  ( cd "$REPO/frontend" && { npm ci 2>/dev/null || npm install; } && npm run build )
  ok "built $REPO/frontend/dist"
else
  [ -d "$REPO/frontend/dist" ] || { echo "--no-build given but $REPO/frontend/dist is missing"; exit 1; }
  ok "using existing $REPO/frontend/dist"
fi

# ---- optional content dependencies ------------------------------------------
if [ "$CONTENT_DEPS" = 1 ]; then
  say "Installing optional content dependencies"
  # plain --user first; on PEP 668 "externally-managed" hosts (Debian/Ubuntu) retry with the
  # --break-system-packages escape hatch (these are pure-Python libs, low risk)
  if python3 -m pip install --user --upgrade pymupdf4llm pypdf python-docx 2>/dev/null \
     || python3 -m pip install --user --break-system-packages --upgrade pymupdf4llm pypdf python-docx; then
    ok "pymupdf4llm, pypdf, python-docx (PDF/Word attachments + Word export)"
  else
    warn "pip install failed — PDF-attachment text + Word export degrade; document preview still works"
  fi
  command -v pandoc >/dev/null && ok "pandoc present (doc/odt/rtf/html attachments)" \
    || warn "pandoc not found — install it (e.g. apt install pandoc) for non-PDF doc attachments"
  # document PREVIEW (rendered page images): poppler for PDFs, LibreOffice for office files
  command -v pdftoppm >/dev/null && ok "pdftoppm present (PDF preview)" \
    || warn "pdftoppm not found — 'apt install poppler-utils' to preview PDFs in the reader"
  { command -v soffice >/dev/null || command -v libreoffice >/dev/null; } && ok "LibreOffice present (DOCX/PPTX/XLSX preview)" \
    || warn "LibreOffice not found — 'apt install libreoffice' (large) to preview DOCX/PPTX/XLSX; without it those stay download-only"
fi

# ---- service ----------------------------------------------------------------
UNIT_NAME="hermes-mc"
if [ "$DO_SERVICE" = 1 ]; then
  UNIT_CONTENT="[Unit]
Description=Hermes Mission Control portal
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
WorkingDirectory=$REPO/backend
Environment=PYTHONPATH=$REPO/backend
Environment=HMC_HOST=$HOST
Environment=HMC_PORT=$PORT
ExecStart=/usr/bin/env python3 -u -m hermes_mc.server
Restart=on-failure
RestartSec=3
"
  if [ "$SYSTEM" = 1 ]; then
    say "Installing system-wide systemd unit (sudo)"
    printf '%s\n[Install]\nWantedBy=multi-user.target\n' "$UNIT_CONTENT" | sudo tee "/etc/systemd/system/${UNIT_NAME}.service" >/dev/null
    sudo sed -i "/^\[Service\]/a User=${SUDO_USER:-$USER}" "/etc/systemd/system/${UNIT_NAME}.service"
    sudo systemctl daemon-reload
    sudo systemctl enable --now "${UNIT_NAME}.service"
    ok "systemctl status ${UNIT_NAME}"
  elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    say "Installing systemd --user unit"
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n[Install]\nWantedBy=default.target\n' "$UNIT_CONTENT" > "$HOME/.config/systemd/user/${UNIT_NAME}.service"
    systemctl --user daemon-reload
    systemctl --user enable --now "${UNIT_NAME}.service"
    loginctl enable-linger "$USER" >/dev/null 2>&1 && ok "lingering enabled (survives logout)" || warn "could not enable linger — service stops on logout; run: sudo loginctl enable-linger $USER"
    ok "systemctl --user status ${UNIT_NAME}"
  else
    warn "systemd not available here — skipping the service"
    warn "run the portal with:  bash $REPO/installer/run-portal.sh"
    DO_SERVICE=0
  fi
fi

# ---- done -------------------------------------------------------------------
say "Done"
if [ "$DO_SERVICE" != 1 ]; then
  echo "  Start it any time:  bash $REPO/installer/run-portal.sh"
fi
echo "  Portal URL(s):"
IPS="$(hostname -I 2>/dev/null || echo '')"
if [ -n "$IPS" ]; then for ip in $IPS; do echo "    http://$ip:$PORT"; done; fi
echo "    http://127.0.0.1:$PORT   (this host)"
echo
echo "  First sign-in:  admin / admin  —  change it in Settings → Access."
echo "  See docs/DEPLOY.md for the smoke-test checklist and troubleshooting."
