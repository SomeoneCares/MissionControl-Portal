#!/usr/bin/env bash
# Hermes Mission Control — portable installer.
#
# Boots the portal on any host: builds the front end, installs optional dependency sets,
# (optionally) wires the local Hermes gateway for Chat, and sets up a service so it starts
# on boot. No host-specific paths — everything resolves from this repo and the environment.
#
# Usage:
#   installer/install.sh [dep flags] [hermes flags] [service flags] [-h]
#
# Dependency sets (optional extras — every feature degrades gracefully without them):
#   --content-deps   PDF/Word attachment text + Word export + in-reader document preview
#   --voice-deps     Voice Mode self-hosted engine (faster-whisper STT + edge-tts neural TTS)
#   --all-deps       both of the above
#
# Hermes host wiring (only when a LOCAL Hermes home is present; each is opt-in and edits
# ~/.hermes — a plain run never touches your gateway):
#   --enable-chat    enable the gateway API server + key, propagate the key to every profile
#                    (so per-agent Chat multiplexing works), and restart the gateway
#   --update-hermes  run `hermes update` first, to bring the host to the latest Hermes
#
# Build / service:
#   --system         install a system-wide systemd unit (needs sudo) instead of a --user unit
#   --no-service     just build; don't install a service (use installer/run-portal.sh to run)
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
DO_BUILD=1 DO_SERVICE=1 SYSTEM=0 CONTENT_DEPS=0 VOICE_DEPS=0 ENABLE_CHAT=0 UPDATE_HERMES=0

for arg in "$@"; do
  case "$arg" in
    --content-deps)  CONTENT_DEPS=1 ;;
    --voice-deps)    VOICE_DEPS=1 ;;
    --all-deps)      CONTENT_DEPS=1; VOICE_DEPS=1 ;;
    --enable-chat)   ENABLE_CHAT=1 ;;
    --update-hermes) UPDATE_HERMES=1 ;;
    --system)        SYSTEM=1 ;;
    --no-service)    DO_SERVICE=0 ;;
    --no-build)      DO_BUILD=0 ;;
    -h|--help)       sed -n '2,30p' "$0"; exit 0 ;;
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

# ---- Hermes detection, optional update, version sanity ----------------------
say "Detecting Hermes"
HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
LOCAL_HERMES=0
if [ -f "$HERMES_HOME/gateway_state.json" ]; then
  LOCAL_HERMES=1
  ok "local Hermes home at $HERMES_HOME — portal will run in LOCAL mode (direct DB + gateway)"
else
  warn "no local Hermes home ($HERMES_HOME/gateway_state.json missing) — portal will run in REMOTE mode"
  warn "set HMC_GATEWAY_URL / HMC_BRIDGE_URL (+ keys), or add a connection in the UI later"
fi

if command -v hermes >/dev/null; then
  if [ "$UPDATE_HERMES" = 1 ]; then
    say "Updating Hermes (hermes update)"
    hermes update && ok "Hermes updated" || warn "hermes update failed — continuing with the installed version"
  fi
  HVER="$(hermes --version 2>/dev/null | head -1)"
  ok "hermes CLI: ${HVER:-present}"
  # the portal is developed against hermes-agent 0.21.x; flag anything else so drift is expected
  MINOR="$(printf '%s' "$HVER" | grep -oE '[0-9]+\.[0-9]+' | head -1)"
  case "$MINOR" in
    0.21) : ;;
    '')   warn "could not parse the Hermes version — watch Runs/Tasks/Chat for schema drift" ;;
    *)    warn "Hermes $MINOR differs from the tested 0.21.x — watch Runs/Tasks/Chat for drift (docs/DEPLOY.md)" ;;
  esac
else
  [ "$LOCAL_HERMES" = 1 ] && warn "hermes CLI not on PATH — model/file writes shell out to it; read-only features still work"
  [ "$UPDATE_HERMES" = 1 ] && warn "--update-hermes needs the hermes CLI on PATH; skipped"
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

# ---- optional voice dependencies --------------------------------------------
if [ "$VOICE_DEPS" = 1 ]; then
  say "Installing optional voice dependencies"
  # same PEP 668 fallback as content deps
  if python3 -m pip install --user --upgrade faster-whisper edge-tts 2>/dev/null \
     || python3 -m pip install --user --break-system-packages --upgrade faster-whisper edge-tts; then
    ok "faster-whisper (self-hosted STT) + edge-tts (neural TTS: en-US + ar-EG Egyptian)"
    warn "first use downloads the whisper model (default large-v3-turbo); GPU used automatically if present, else CPU"
    warn "edge-tts needs outbound network; the browser mic needs a secure context (localhost or HTTPS)"
  else
    warn "pip install failed — Voice Mode self-hosted engine unavailable; the browser web-speech engine still works"
  fi
fi

# ---- wire the local Hermes gateway for Chat ---------------------------------
# Runs BEFORE the service so the portal reads the freshly-set gateway key at startup.
if [ "$ENABLE_CHAT" = 1 ]; then
  if [ "$LOCAL_HERMES" != 1 ]; then
    warn "--enable-chat skipped: no local Hermes home at $HERMES_HOME (remote mode wires Chat via Settings → Connections)"
  else
    say "Wiring the Hermes gateway for Chat"
    ROOT_ENV="$HERMES_HOME/.env"
    touch "$ROOT_ENV"
    # 1. enable the API server
    if grep -q '^API_SERVER_ENABLED=' "$ROOT_ENV"; then
      sed -i 's/^API_SERVER_ENABLED=.*/API_SERVER_ENABLED=true/' "$ROOT_ENV"
    else
      echo 'API_SERVER_ENABLED=true' >> "$ROOT_ENV"
    fi
    ok "API_SERVER_ENABLED=true"
    # 2. ensure a key exists (never printed)
    if grep -q '^API_SERVER_KEY=' "$ROOT_ENV"; then
      ok "API_SERVER_KEY already set"
    else
      echo "API_SERVER_KEY=$(python3 -c 'import secrets; print(secrets.token_hex(24))')" >> "$ROOT_ENV"
      ok "generated a new API_SERVER_KEY"
    fi
    # 3. propagate the key into every profile so per-agent multiplexing works
    if [ -f "$REPO/installer/propagate-key.sh" ]; then
      HERMES_HOME="$HERMES_HOME" bash "$REPO/installer/propagate-key.sh" \
        || warn "key propagation reported an issue — check ~/.hermes/profiles/*/.env"
    fi
    # 4. restart the gateway so it binds with the key
    if command -v hermes >/dev/null; then
      hermes gateway restart && ok "gateway restarted" \
        || warn "could not restart the gateway — run 'hermes gateway restart' manually"
    else
      warn "hermes CLI not on PATH — restart the gateway manually: hermes gateway restart"
    fi
    # 5. confirm it's listening (200/401 = up; 000 = not yet)
    GURL="${HMC_GATEWAY_URL:-http://127.0.0.1:8642}"
    code="$(curl -s -o /dev/null -w '%{http_code}' "$GURL/v1/models" 2>/dev/null || echo 000)"
    case "$code" in
      200|401) ok "gateway responding at $GURL ($code)" ;;
      000)     warn "gateway not reachable at $GURL yet — give it a moment, then reload the portal" ;;
      *)       warn "gateway returned $code at $GURL — check the 'hermes gateway' logs" ;;
    esac
  fi
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
    sudo systemctl enable "${UNIT_NAME}.service" >/dev/null 2>&1 || true
    sudo systemctl restart "${UNIT_NAME}.service"   # (re)start so new backend + gateway key load
    ok "systemctl status ${UNIT_NAME}"
  elif command -v systemctl >/dev/null && systemctl --user show-environment >/dev/null 2>&1; then
    say "Installing systemd --user unit"
    mkdir -p "$HOME/.config/systemd/user"
    printf '%s\n[Install]\nWantedBy=default.target\n' "$UNIT_CONTENT" > "$HOME/.config/systemd/user/${UNIT_NAME}.service"
    systemctl --user daemon-reload
    systemctl --user enable "${UNIT_NAME}.service" >/dev/null 2>&1 || true
    systemctl --user restart "${UNIT_NAME}.service"  # (re)start so new backend + gateway key load
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
[ "$ENABLE_CHAT" = 1 ] || echo "  Chat off? Re-run with --enable-chat (local Hermes), or see docs/DEPLOY.md → Enabling Chat."
echo "  See docs/DEPLOY.md for the smoke-test checklist and troubleshooting."
