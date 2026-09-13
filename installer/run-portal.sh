#!/usr/bin/env bash
# Portable start/restart for the portal, without systemd. Idempotent: stops any running
# instance, then starts a fresh detached one that survives closing the terminal.
#
#   bash installer/run-portal.sh          # start / restart
#   HMC_PORT=8088 bash installer/run-portal.sh
#
# Stop it with:  pkill -f 'python3 -u -m hermes_mc.server'
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
HOST="${HMC_HOST:-0.0.0.0}"
PORT="${HMC_PORT:-51770}"
LOG="${HMC_LOG:-$HOME/.hermes-mc/portal.log}"
mkdir -p "$(dirname "$LOG")"

pkill -f 'python3 -u -m hermes_mc.server' 2>/dev/null || true
sleep 1
cd "$REPO/backend"
HMC_HOST="$HOST" HMC_PORT="$PORT" setsid nohup python3 -u -m hermes_mc.server \
  >> "$LOG" 2>&1 < /dev/null &
sleep 2

if pgrep -f 'python3 -u -m hermes_mc.server' >/dev/null; then
  echo "portal running on http://$HOST:$PORT  (log: $LOG)"
  pgrep -af 'python3 -u -m hermes_mc.server'
else
  echo "WARN: portal did not start — check $LOG"; tail -n 20 "$LOG" 2>/dev/null || true; exit 1
fi
