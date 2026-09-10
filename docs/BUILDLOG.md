# Build log

Newest first. Each entry: what was built, and what proves it works.

## 2026-09-10 — P0/P1 foundation

- **Project scaffolded** in `~/hermes-mission-control` on the WSL Hermes host (local-mode dev target).
- **`backend/hermes_mc/config.py`** — mode detection (local vs remote), path/URL/key resolution.
  Reads `API_SERVER_KEY` from `~/.hermes/.env` in local mode. No network, secrets never logged.
- **`backend/hermes_mc/gateway.py`** — stdlib-only client for the `:8642` gateway API. Health,
  capabilities, models, skills, toolsets, chat (+streaming), run status/events/stop/steer.
- **Proven live** against WSL hermes-agent 0.21.0 (`smoke_gateway.py`):
  - health ok, 18 ms, version 0.21.0
  - capabilities: 20 features on, 5 off (`audio_api`, `realtime_voice`, `admin_config_rw`,
    `jobs_admin` confirmed off — matches the capability-driven UI plan)
  - 875 skills, toolsets `[web, browser, terminal, file, code_execution, vision]`

### Learned
- `/v1/models` returns only `hermes-agent` — the gateway abstracts the backing model. **Per-agent
  real models (e.g. `soc-oss:latest`) must come from profiles/config, not the gateway.** The fleet
  roster is a file/bridge concern; the gateway supplies live run/chat/skills data.

## Next
- `backend/hermes_mc/local_source.py` — read profiles, gateway_state.json, cron, model-routing,
  and the project DBs into the typed state payload (reuse logic from `reference/server.py.orig`).
- Define the state schema (`docs/state-contract.md`) as the shared front/back contract.
