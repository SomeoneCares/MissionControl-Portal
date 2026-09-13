# Hermes Mission Control

An operator console for [Hermes](https://github.com/NousResearch/hermes-agent) autonomous agent
fleets. One portal that runs beside a Hermes host or on a VM of its own, shows **only real data
pulled from the server**, and installs with a single command.

This is the converged build described in the
[convergence plan](https://claude.ai/code/artifact/c8c12106-0e18-4bbc-9075-968f164ae9fb): the
existing Python backend's direct access to Hermes, a rebuilt React front end, and the gateway API
for the live half.

---

## Quick start

```bash
git clone <this-repo> hermes-mission-control
cd hermes-mission-control
installer/install.sh --content-deps      # builds the UI, installs a service, prints the URL
```

Then open `http://<host-ip>:51770` and sign in with **admin / admin** (change it in Settings →
Access). Prefer to run it yourself? `installer/install.sh --no-service` then
`bash installer/run-portal.sh`. Full instructions, config, modes, and a first-run **smoke-test
checklist** are in **[docs/DEPLOY.md](docs/DEPLOY.md)**.

Requirements: Python 3.10+ and (to build the front end) Node 18+/npm. The backend is pure
standard library; the built front-end bundle is not committed, so a fresh clone builds it once.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Front end — React + Vite + TypeScript                       │
│  Static bundle served by the backend. Never reads a DB,      │
│  never holds a Hermes credential.                            │
└───────────────┬─────────────────────────────────────────────┘
                │ typed HTTP + SSE
┌───────────────▼─────────────────────────────────────────────┐
│  Backend — Python stdlib HTTP server                         │
│  Owns all data access. Builds the state payload.             │
│  Mode A (local):  reads ~/.hermes + project DBs directly     │
│  Mode B (remote): calls a bridge on the Hermes host          │
└───────────────┬─────────────────────────────────────────────┘
                │
        ┌───────┴────────────────────────┐
        │                                 │
┌───────▼─────────┐            ┌──────────▼──────────────┐
│ Hermes files    │            │ Gateway API :8642        │
│ ~/.hermes, DBs  │            │ chat, runs, models,      │
│ /proc metrics   │            │ skills, run control      │
└─────────────────┘            └──────────────────────────┘
```

The one rule everything else serves: **every figure on screen traces to a real source. Where a
source is empty, the UI says so. No fallback literals, no seeded demo agents, no invented
activity** — enforced by a build check, not by discipline.

---

## Locked decisions

| Decision | Choice |
| :-- | :-- |
| Path | **B — converge.** Keep the Python backend; rebuild the front end in React/Vite/TS. |
| Data rule | Zero mock/hardcoded data. Every value from a real source or an honest empty state. |
| Transport (live half) | Hermes gateway API on `:8642` (OpenAI-compatible, bearer `API_SERVER_KEY`). |
| Transport (file/DB half) | In-process in local mode; a token-authed bridge on the Hermes host in remote mode. |
| Modes | One codebase. Installer detects `~/.hermes` → local mode, else asks host + token → remote. |
| Office tab | **Skyline** (default) with a switch to **The Armillary**. Both generated from live fleet data, any N agents. |
| Voice / WebRTC | Deferred. Core Hermes has no WebRTC (verified); realtime lives in the `hermes-talk` plugin / RFC #101808. Revisit later. |
| Multi-fleet | One connected Hermes host per fleet; optional portal-side agent squads within a host. |
| Remote writes | Read-only in remote mode; full read/write in local mode (writes shell out to the `hermes` binary). |
| Exposure | LAN-only for now (no public TLS assumed). |

Open: none blocking. See the plan for the full feature list and build sequence.

---

## Verified environment (as of 2026-09-10)

Two real Hermes hosts used as the development and multi-fleet test bed:

- **`hermes` server** — `192.168.100.177`, Debian 13, hermes-agent 0.21.0. 7 messaging-bound agents
  (Orchestrator, Scout, Scribe, Reach, Dev, Pixel, Basem Digital Twin), 405 runs. Runs the existing
  `mission-control` portal on `:51763`.
- **WSL local** — `ubuntu-24.04`, hermes-agent 0.21.0. Gateway API live on `:8642`. 9 security/pentest
  agents (`pt-*`, `soc-*`) on a local `soc-oss` model. Pure-API host (no messaging platforms bound).

Gateway `/v1/capabilities` on the WSL host confirms live: `chat_completions` (+streaming),
`responses_api`, `run_submission`, `run_status`, `run_events_sse`, `run_stop`, `run_steer`,
`run_approval_response`, `tool_progress_events`, `skills_api`, `session_fork`, `cors`. Confirmed
**off**: `audio_api`, `realtime_voice`, `admin_config_rw`, `jobs_admin` (the last two are why remote
mode is read-only for model/cron changes).

---

## Layout

```
backend/          Python backend — data layer, state builder, gateway client, HTTP server
  hermes_mc/      the package
frontend/         React + Vite + TypeScript front end
installer/        install.sh (build + service), run-portal.sh (systemd-free run);
                  gw.sh / propagate-key.sh (host-side gateway helpers, environment-specific)
docs/             DEPLOY.md (install + smoke test), design notes, build log
reference/        read-only copies of prior art (original server.py) — not shipped
```

## Status

Feature-complete for LAN operation; see **[docs/DEPLOY.md](docs/DEPLOY.md)** to install and run the
first-run smoke test. Not yet validated on a second/fresh Hermes host — treat the first vanilla
deploy as a shakedown. See `docs/` for the build log.
