#!/usr/bin/env bash
export PATH="/usr/bin:/bin"
PY=/home/basem/.hermes/hermes-agent/venv/bin/python
HB=/home/basem/.hermes/hermes-agent/hermes
K=$(sed -n 's/^API_SERVER_KEY=//p' /home/basem/.hermes/.env | tr -d '"' | head -1)
echo "=== restart gateway (pick up per-profile keys) ==="
"$PY" "$HB" gateway restart 2>&1 | tail -3
sleep 5
echo "=== /p/<profile>/v1/models probes ==="
for p in pt-orchestrator soc-analyst soc-hunter; do
  code=$(curl -s -m 12 -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $K" "http://127.0.0.1:8642/p/$p/v1/models")
  echo "  /p/$p/ -> $code"
done
