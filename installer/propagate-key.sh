#!/usr/bin/env bash
# Give every Hermes profile the gateway's API_SERVER_KEY, so the portal's single key
# authenticates to ALL /p/<profile>/ multiplex endpoints. Without this, only the default
# profile is reachable under multiplexing and every other profile silently falls back to the
# default agent in Chat. Idempotent (re-runs just re-sync the key) and reversible (remove the
# API_SERVER_KEY line from each profile's .env). The key value is copied line-for-line — never
# printed. Portable: resolves the Hermes home from $HERMES_HOME or ~/.hermes.
set -euo pipefail

HERMES_HOME="${HERMES_HOME:-$HOME/.hermes}"
ROOT_ENV="$HERMES_HOME/.env"

[ -f "$ROOT_ENV" ] || { echo "no $ROOT_ENV — is this a Hermes host?"; exit 1; }
KEYLINE=$(grep '^API_SERVER_KEY=' "$ROOT_ENV" | head -1 || true)
[ -n "$KEYLINE" ] || { echo "no API_SERVER_KEY in $ROOT_ENV — set one and enable API_SERVER_ENABLED first"; exit 1; }

changed=0
for d in "$HERMES_HOME"/profiles/*/; do
  [ -d "$d" ] || continue
  f="${d}.env"
  [ -f "$f" ] || touch "$f"
  if grep -q '^API_SERVER_KEY=' "$f"; then
    grep -qxF "$KEYLINE" "$f" && { echo "  $(basename "$d"): already in sync"; continue; }
    sed -i "s#^API_SERVER_KEY=.*#${KEYLINE//#/\\#}#" "$f"    # re-sync to the root key
    echo "  $(basename "$d"): key re-synced"
    changed=$((changed+1))
  else
    printf '%s\n' "$KEYLINE" >> "$f"
    echo "  $(basename "$d"): key added"
    changed=$((changed+1))
  fi
done

echo "profiles updated: $changed"
echo "now restart the gateway to apply:  hermes gateway restart"
