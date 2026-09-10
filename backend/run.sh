#!/usr/bin/env bash
# Run the portal backend against the local Hermes, serving the built front end.
export PATH="/usr/bin:/bin"
set -a; . /home/basem/.hermes/.env 2>/dev/null; set +a
export HMC_PORT="${HMC_PORT:-51770}"
cd /home/basem/hermes-mission-control/backend
exec python3 -m hermes_mc.server
