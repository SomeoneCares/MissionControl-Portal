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

### Run-history source (resolved)
- `agent-logs.db` (`agent_logs(id, agent_name, task_description, model_used, status, created_at)`)
  is written by a **Hermes-side agent turn hook** under `~/.hermes/agents/_shared/`, cleaned by a
  cron calling `cleanup-logs.sh`. It is genuine server data — Hermes writes it, the portal reads
  it. On a fresh host it does not exist yet → run history is empty (honest zeros).
- The old portal had a hardcoded `CORE_META`/`CORE_AGENT_ORDER` (orchestrator/scout/scribe/reach/
  dev). **Dropped entirely** — the new fleet derives from `~/.hermes/profiles/*`.

## 2026-09-10 — running backend (local mode)

- **`local_source.py`** verified live: 9 real profiles, real models (`soc-oss:latest`), roles from
  SOUL.md, real gateway health, real `/proc` metrics; empty run history → zeros, not fabrication.
- **`board.py`** — portal-owned SQLite kanban, the only writable DB. Works in both modes.
- **`server.py`** — stdlib `http.server`; `/api/health`, `/api/state`, `/api/capabilities`,
  `/events` (SSE), `/api/board` CRUD, static SPA serving. `DataProvider` abstracts local vs
  remote sourcing.
- **Proven end to end**: server started against WSL Hermes → `/api/health` (mode local, gateway
  ok, v0.21.0), `/api/state` (9 agents, real health), board create/list round-trip.
- Git initialised; foundation committed.

## Next
- Define `docs/state-contract.md` — the typed payload shape, shared front/back.
- P3: front-end foundation — Vite + React + TS, design tokens (ink/cream/ember), routing,
  the typed API client, then the Overview and Agents tabs against live `/api/state`.
