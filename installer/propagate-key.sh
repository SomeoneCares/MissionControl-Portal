#!/usr/bin/env bash
# Give every profile the gateway's API_SERVER_KEY so one portal key authenticates to all of
# them under multiplexing. Idempotent (only appends when missing) and reversible (remove the
# appended line). The key value is copied line-for-line from the root .env — never printed.
export PATH="/usr/bin:/bin"
set -euo pipefail
ROOT_ENV=/home/basem/.hermes/.env
KEYLINE=$(grep '^API_SERVER_KEY=' "$ROOT_ENV" | head -1)
if [ -z "$KEYLINE" ]; then echo "no API_SERVER_KEY in root .env"; exit 1; fi

changed=0
for d in /home/basem/.hermes/profiles/*/; do
  f="${d}.env"
  [ -f "$f" ] || touch "$f"
  if grep -q '^API_SERVER_KEY=' "$f"; then
    echo "  $(basename "$d"): already has a key"
  else
    printf '%s\n' "$KEYLINE" >> "$f"
    echo "  $(basename "$d"): key added"
    changed=$((changed+1))
  fi
done
echo "profiles updated: $changed"
