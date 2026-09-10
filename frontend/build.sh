#!/usr/bin/env bash
# Build the front end using Hermes' bundled Node toolchain.
set -e
export PATH="/home/basem/.hermes/node/bin:/usr/bin:/bin"
cd /home/basem/hermes-mission-control/frontend
echo "node $(node -v)  npm $(npm -v)"
echo "=== npm install ==="
npm install --no-audit --no-fund --loglevel=error
echo "=== build ==="
npm run build
echo "=== DONE — dist contents ==="
ls -la dist
